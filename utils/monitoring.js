// utils/monitoring.js - FIXED VERSION
const winston = require("winston");
const os = require("os");

// Conditionally import Sentry only if DSN is provided
let Sentry = null;
if (
  process.env.SENTRY_DSN &&
  process.env.SENTRY_DSN !==
    "https://your-sentry-dsn.ingest.sentry.io/project-id"
) {
  Sentry = require("@sentry/node");

  // Initialize Sentry only with valid DSN
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0.2,
    maxBreadcrumbs: 50,
    debug: process.env.NODE_ENV === "development",
  });
}

// Set up Winston logger with multiple transports
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: {
    service: "email-verification-api",
    host: os.hostname(),
  },
  transports: [
    // Console logs
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),

    // File logs for errors
    new winston.transports.File({
      filename: "logs/error.log",
      level: "error",
      maxsize: 10485760, // 10MB
      maxFiles: 10,
    }),

    // File logs for everything
    new winston.transports.File({
      filename: "logs/combined.log",
      maxsize: 20971520, // 20MB
      maxFiles: 20,
    }),
  ],
});

// Conditionally import and add Slack transport
let SlackTransport;
if (process.env.NODE_ENV === "production" && process.env.SLACK_WEBHOOK_URL) {
  try {
    SlackTransport = require("winston-slack-webhook-transport");
    logger.add(
      new SlackTransport({
        webhookUrl: process.env.SLACK_WEBHOOK_URL,
        channel: "#api-alerts",
        username: "Email-API-Monitor",
        level: "error",
        formatter: (info) => ({
          text: `*${info.level.toUpperCase()}*: ${info.message}`,
          attachments: [
            {
              color: info.level === "error" ? "danger" : "warning",
              fields: [
                { title: "Service", value: info.service, short: true },
                {
                  title: "Environment",
                  value: process.env.NODE_ENV,
                  short: true,
                },
                { title: "Host", value: info.host, short: true },
                {
                  title: "Timestamp",
                  value: new Date().toISOString(),
                  short: true,
                },
                { title: "Details", value: JSON.stringify(info.details || {}) },
              ],
            },
          ],
        }),
      })
    );
  } catch (err) {
    console.warn("Could not initialize Slack transport", err.message);
  }
}

// Initialize metrics conditionally
let promClient,
  register,
  httpRequestsTotal,
  apiLatency,
  verificationResults,
  activeApiUsers;
let metricsMiddleware = null;

if (process.env.ENABLE_METRICS === "true") {
  try {
    promClient = require("prom-client");

    // Use singleton registry to avoid duplicate metrics
    register = promClient.register;

    // Clear any existing metrics to avoid conflicts
    register.clear();

    // Now collect default metrics
    promClient.collectDefaultMetrics({ register });

    // Custom metrics
    httpRequestsTotal = new promClient.Counter({
      name: "http_requests_total",
      help: "Total number of HTTP requests",
      labelNames: ["method", "endpoint", "status"],
    });

    apiLatency = new promClient.Histogram({
      name: "api_request_duration_seconds",
      help: "API request latency in seconds",
      labelNames: ["method", "endpoint"],
      buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10],
    });

    verificationResults = new promClient.Counter({
      name: "email_verification_results",
      help: "Results of email verifications",
      labelNames: ["result", "domain_type"],
    });

    activeApiUsers = new promClient.Gauge({
      name: "active_api_users",
      help: "Number of users who have made API calls in the last 24 hours",
    });

    // Try to import promster for metrics middleware
    try {
      const { createMiddleware } = require("@promster/express");
      metricsMiddleware = createMiddleware({ app: "email-verification-api" });
    } catch (err) {
      logger.warn("Could not initialize promster middleware", {
        error: err.message,
      });
      metricsMiddleware = (req, res, next) => next();
    }
  } catch (err) {
    logger.warn("Could not initialize prometheus metrics", {
      error: err.message,
    });
  }
} else {
  // Create dummy metrics that do nothing to avoid errors when they're called
  httpRequestsTotal = { inc: () => {} };
  apiLatency = { observe: () => {} };
  verificationResults = { inc: () => {} };
  activeApiUsers = { set: () => {} };
  metricsMiddleware = (req, res, next) => next();
}

// Health check status
let systemHealthy = true;
const healthStatus = {
  database: true,
  redis: true,
  smtp: true,
  dns: true,
};

// Express middleware for request tracking
const requestLogger = (req, res, next) => {
  const startTime = Date.now();

  // Add response finished listener
  res.on("finish", () => {
    const duration = Date.now() - startTime;
    const path = req.route ? req.route.path : req.path;

    // Increment request counter if metrics are enabled
    if (httpRequestsTotal) {
      httpRequestsTotal.inc({
        method: req.method,
        endpoint: path,
        status: res.statusCode,
      });
    }

    // Record latency
    if (apiLatency) {
      apiLatency.observe(
        {
          method: req.method,
          endpoint: path,
        },
        duration / 1000
      );
    }

    // Log requests (only non-health check to avoid noise)
    if (!path.includes("/health") && !path.includes("/metrics")) {
      logger.info(`${req.method} ${path} ${res.statusCode} - ${duration}ms`, {
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        duration,
        ip: req.ip,
        user: req.user ? req.user.id : "anonymous",
      });
    }

    // Log errors
    if (res.statusCode >= 400) {
      const logLevel = res.statusCode >= 500 ? "error" : "warn";
      logger[logLevel](
        `Request error: ${req.method} ${path} ${res.statusCode}`,
        {
          method: req.method,
          url: req.originalUrl,
          status: res.statusCode,
          duration,
          ip: req.ip,
          user: req.user ? req.user.id : "anonymous",
          body: res.statusCode >= 500 ? JSON.stringify(req.body) : undefined,
          query: res.statusCode >= 500 ? JSON.stringify(req.query) : undefined,
        }
      );
    }
  });

  next();
};

// Error handler middleware
const errorHandler = (err, req, res, next) => {
  // Capture error in Sentry if available
  if (Sentry) {
    Sentry.captureException(err);
  }

  // Log error
  logger.error("Unhandled exception", {
    error: err.message,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
    body: req.body,
    user: req.user ? req.user.id : "anonymous",
  });

  // Send error response
  res.status(500).json({
    success: false,
    message: "An unexpected error occurred",
    errorId: Sentry ? res.sentry : undefined,
  });
};

// Update verification result metrics
function trackVerificationResult(result, email) {
  if (!verificationResults) return;

  const domain = email.split("@")[1];
  const domainType = determineDomainType(domain);

  verificationResults.inc({
    result: result.isValid ? "valid" : "invalid",
    domain_type: domainType,
  });
}

// Helper to determine domain type
function determineDomainType(domain) {
  const freeDomains = [
    "gmail.com",
    "yahoo.com",
    "hotmail.com",
    "outlook.com",
    "aol.com",
  ];
  if (freeDomains.includes(domain)) {
    return "free";
  } else if (domain.endsWith(".edu")) {
    return "education";
  } else if (domain.endsWith(".gov")) {
    return "government";
  } else {
    return "business";
  }
}

// Update system health
function updateHealthStatus(component, isHealthy, details = {}) {
  if (healthStatus[component] !== undefined) {
    healthStatus[component] = isHealthy;

    // Update overall system health
    systemHealthy = Object.values(healthStatus).every((status) => status);

    // Log health change if it's negative
    if (!isHealthy) {
      logger.warn(`Health check failed for ${component}`, { details });

      // Alert on critical component failure in production
      if (
        process.env.NODE_ENV === "production" &&
        (component === "database" || component === "redis") &&
        Sentry
      ) {
        Sentry.captureMessage(
          `Critical component failure: ${component}`,
          "error"
        );
      }
    } else if (!systemHealthy && isHealthy) {
      logger.info(`Component ${component} returned to healthy state`);
    }
  }
}

// Initialize metrics server for Prometheus
function startMetricsServer(port = 9090) {
  if (
    process.env.ENABLE_METRICS === "true" &&
    process.env.NODE_ENV === "production"
  ) {
    try {
      const { createServer } = require("@promster/server");
      const server = createServer({ port });

      server.on("listening", () => {
        logger.info(`Metrics server listening on port ${port}`);
      });
    } catch (err) {
      logger.error("Failed to start metrics server", { error: err.message });
    }
  }
}

// Create empty middleware functions for when Sentry is not available
const sentryMiddleware = Sentry
  ? Sentry.Handlers.requestHandler()
  : (req, res, next) => next();

const sentryErrorHandler = Sentry
  ? Sentry.Handlers.errorHandler()
  : (err, req, res, next) => next(err);

// Export all monitoring tools with safe defaults
module.exports = {
  Sentry,
  logger,
  promClient,
  register,
  metrics: {
    httpRequestsTotal,
    apiLatency,
    verificationResults,
    activeApiUsers,
  },
  middleware: {
    sentry: sentryMiddleware,
    sentryError: sentryErrorHandler,
    prometheusMetrics: metricsMiddleware,
    datadog: (req, res, next) => next(), // Dummy middleware if datadog not enabled
    requestLogger,
  },
  errorHandler,
  trackVerificationResult,
  updateHealthStatus,
  getHealth: () => ({
    healthy: systemHealthy,
    components: healthStatus,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
  }),
  startMetricsServer,
};
