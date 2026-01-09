// middleware/security.js
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const slowDown = require("express-slow-down");
const cors = require("cors");
const mongoSanitize = require("express-mongo-sanitize");
const xss = require("xss-clean");
const hpp = require("hpp");
const crypto = require("crypto");
const { promisify } = require("util");
const { createClient } = require("redis");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { logger } = require("../utils/monitoring");

// Initialize Redis client for rate limiting and token blacklisting
const redisClient = createClient({
  url: `redis://${
    process.env.REDIS_PASSWORD ? `:${process.env.REDIS_PASSWORD}@` : ""
  }${process.env.REDIS_HOST || "localhost"}:${process.env.REDIS_PORT || 6379}/${
    process.env.REDIS_DB || "0"
  }`,
  socket: {
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        logger.error("Redis security connection retries exhausted");
        return new Error("Redis connection retries exhausted");
      }
      return Math.min(retries * 100, 3000);
    },
  },
});

// Connect to Redis
(async () => {
  try {
    await redisClient.connect();
    logger.info("Redis connection for security established");
  } catch (err) {
    logger.error("Redis security connection error", {
      error: err.message,
    });
  }
})();

// Handle Redis errors
redisClient.on("error", (err) => {
  logger.error("Redis security client error", { error: err.message });
});

// Configure Helmet with strict CSP
const helmetConfig = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
      fontSrc: ["'self'", "fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "api.stripe.com"],
      frameSrc: ["'self'", "js.stripe.com"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: { policy: "require-corp" },
  crossOriginOpenerPolicy: { policy: "same-origin" },
  crossOriginResourcePolicy: { policy: "same-origin" },
  originAgentCluster: true,
});

// Rate limiting configuration
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests, please try again later.",
  },
  keyGenerator: (req) => {
    // Use API key or IP address as the key
    return req.headers["x-api-key"] || req.ip;
  },
});

// More strict rate limiting for authentication routes
const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 requests per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many authentication attempts, please try again later.",
  },
});

// Speed limiter to slow down repeated requests
const speedLimiter = slowDown({
  windowMs: 15 * 60 * 1000, // 15 minutes
  delayAfter: 50, // Allow 50 requests per 15 minutes without delay
  delayMs: (hits) => hits * 100, // Add 100ms of delay for each request after threshold
  keyGenerator: (req) => {
    return req.headers["x-api-key"] || req.ip;
  },
});

// CORS configuration
const corsOptions = {
  origin: (origin, callback) => {
    // In production, restrict to allowed origins
    const allowedOrigins = process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(",")
      : ["http://localhost:3000"];

    // Allow requests with no origin (like mobile apps, curl, postman)
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-auth-token",
    "x-api-key",
  ],
  exposedHeaders: [
    "Content-Range",
    "X-Rate-Limit-Limit",
    "X-Rate-Limit-Remaining",
  ],
  credentials: true,
  maxAge: 86400, // 24 hours
};

// Security middleware chain
const securityMiddleware = [
  helmetConfig,
  cors(corsOptions),
  mongoSanitize(), // Prevent MongoDB operator injection
  xss(), // Sanitize user input
  hpp(), // Prevent HTTP parameter pollution
];

// Additional authentication middleware with advanced security
const enhancedAuth = async (req, res, next) => {
  try {
    // Get token from header or query param
    const token = req.header("x-auth-token");
    const apiKey = req.header("x-api-key") || req.query.apiKey;

    // Check if no token or API key
    if (!token && !apiKey) {
      return res.status(401).json({
        success: false,
        message: "No authentication token or API key, authorization denied",
      });
    }

    if (token) {
      // Check if token is blacklisted
      const isBlacklisted = await redisClient.get(`blacklist:${token}`);
      if (isBlacklisted) {
        return res.status(401).json({
          success: false,
          message: "Token has been revoked",
        });
      }

      // Verify JWT token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Get user from database with fresh data
      const user = await User.findById(decoded.user.id).select("-password");
      if (!user) {
        return res.status(401).json({
          success: false,
          message: "User not found",
        });
      }

      // Check if user is active
      if (!user.active) {
        return res.status(401).json({
          success: false,
          message: "Account is inactive or suspended",
        });
      }

      // Add user to request
      req.user = {
        id: user.id,
        role: user.role,
      };

      // Log access for auditing
      logger.debug("JWT Authentication", {
        userId: user.id,
        endpoint: req.originalUrl,
        method: req.method,
        ip: req.ip,
      });

      next();
    } else if (apiKey) {
      // Verify API key
      // API keys should be hashed in the database for security
      const user = await User.findOne({ apiKey });

      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Invalid API key",
        });
      }

      // Check if user is active
      if (!user.active) {
        return res.status(401).json({
          success: false,
          message: "Account is inactive or suspended",
        });
      }

      // Check rate limits for the API key
      // This would typically be handled by the rate limiter middleware
      // but we can add additional plan-based limits here

      // Add user to request
      req.user = {
        id: user.id,
        role: user.role,
      };

      // Log API key access for auditing
      logger.debug("API Key Authentication", {
        userId: user.id,
        endpoint: req.originalUrl,
        method: req.method,
        ip: req.ip,
      });

      next();
    }
  } catch (error) {
    console.error("Auth error:", error);

    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({
        success: false,
        message: "Invalid token",
      });
    }

    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Token expired",
      });
    }

    res.status(401).json({
      success: false,
      message: "Authentication failed",
    });
  }
};

/**
 * Blacklist a token when user logs out
 * @param {string} token - JWT token to blacklist
 */
async function blacklistToken(token) {
  try {
    // Decode token to get expiration time
    const decoded = jwt.decode(token);
    if (!decoded || !decoded.exp) {
      return;
    }

    // Calculate remaining time until expiration
    const expiresIn = decoded.exp - Math.floor(Date.now() / 1000);
    if (expiresIn <= 0) {
      return; // Token already expired
    }

    // Add token to blacklist in Redis
    await redisClient.set(`blacklist:${token}`, "true");
    await redisClient.expire(`blacklist:${token}`, expiresIn);

    logger.debug("Token blacklisted", {
      userId: decoded.user ? decoded.user.id : "unknown",
      expiresIn,
    });
  } catch (error) {
    console.error("Error blacklisting token:", error);
    logger.error("Failed to blacklist token", { error: error.message });
  }
}

/**
 * Generate a secure API key
 * @returns {string} Secure API key
 */
function generateSecureApiKey() {
  const prefix = "ev_";
  const keyLength = 32;
  const key = crypto.randomBytes(keyLength).toString("hex");
  return `${prefix}${key}`;
}

/**
 * Hash an API key for secure storage
 * @param {string} apiKey - Raw API key
 * @returns {string} Hashed API key
 */
function hashApiKey(apiKey) {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

// Export security utilities
module.exports = {
  securityMiddleware,
  apiLimiter,
  authLimiter,
  speedLimiter,
  enhancedAuth,
  blacklistToken,
  generateSecureApiKey,
  hashApiKey,
};
