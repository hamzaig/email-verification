// server.js - Fixed production server entry point
require("dotenv").config();
const express = require("express");
const https = require("https");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");
const {
  logger,
  middleware: monitoringMiddleware,
  errorHandler,
} = require("./utils/monitoring");
const db = require("./config/db");

// Import routes
const authRoutes = require("./routes/auth");
const apiRoutes = require("./routes/api");
const billingRoutes = require("./routes/billing");
const verificationRoutes = require("./routes/verification");

// Create Express app
const app = express();

// Apply basic security middleware
app.use(helmet());
app.use(cors());

// Apply monitoring middleware
app.use(monitoringMiddleware.sentry);
app.use(monitoringMiddleware.prometheusMetrics);
app.use(monitoringMiddleware.requestLogger);

// Use morgan for HTTP request logging in development
if (process.env.NODE_ENV !== "production") {
  app.use(morgan("dev"));
} else {
  // Use compressed access logs in production
  app.use(
    morgan("combined", {
      stream: {
        write: (message) => {
          logger.http(message.trim());
        },
      },
    })
  );
}

// Enable response compression
app.use(compression());

// Parse JSON bodies (limited to 10MB)
app.use(express.json({ limit: "10mb" }));

// Parse URL-encoded bodies
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Special body parser config for Stripe webhooks
if (process.env.STRIPE_WEBHOOK_SECRET) {
  app.use("/api/webhooks/stripe", express.raw({ type: "application/json" }));
}

// Connect to database
db.connect().catch((err) => {
  logger.error("Database connection error", { error: err.message });
});

// Status check for load balancers
app.get("/status", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: Date.now() });
});

// Define API routes
app.use("/api/auth", authRoutes);
app.use("/api/v1", apiRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/verification", verificationRoutes);

// Error handlers
app.use(monitoringMiddleware.sentryError);
app.use(errorHandler);

// Serve static assets in production
if (process.env.NODE_ENV === "production") {
  // Set static folder
  app.use(express.static("client/build"));

  app.get("*", (req, res) => {
    res.sendFile(path.resolve(__dirname, "client", "build", "index.html"));
  });
}

// Start server (HTTP or HTTPS)
const PORT = process.env.PORT || 3000;

// Start HTTP server
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || "development"}`);
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", {
    error: error.message,
    stack: error.stack,
  });
  // Give the logger time to flush
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Promise Rejection", {
    reason: reason instanceof Error ? reason.message : reason,
    stack: reason instanceof Error ? reason.stack : "No stack trace",
  });
});

// Graceful shutdown
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

function gracefulShutdown() {
  logger.info("Received shutdown signal, closing connections...");

  // Close database connection
  db.disconnect &&
    db.disconnect().catch((err) => {
      logger.error("Error during MongoDB disconnection", {
        error: err.message,
      });
    });

  logger.info("Shutdown complete");

  // Give everything a chance to finish
  setTimeout(() => {
    process.exit(0);
  }, 1000);
}

module.exports = app; // Export for testing
