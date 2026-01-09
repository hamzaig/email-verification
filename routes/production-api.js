// routes/production-api.js
const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const { enhancedAuth } = require("../middleware/security");
const {
  cacheMiddleware,
  getCachedVerificationResult,
  getCachedUserUsage,
  cacheUserUsage,
} = require("../utils/cache");
const enhancedEmailVerifier = require("../utils/enhancedEmailVerifier");
const { verificationQueue, bulkVerificationQueue } = require("../config/queue");
const Usage = require("../models/Usage");
const User = require("../models/User");
const VerificationLog = require("../models/VerificationLog");
const BatchJob = require("../models/BatchJob");
const { logger, trackVerificationResult } = require("../utils/monitoring");

/**
 * @route   POST /api/v1/verify
 * @desc    Verify an email address
 * @access  Private
 */
router.post("/verify", enhancedAuth, async (req, res) => {
  try {
    const startTime = Date.now();
    const { email, skipCache, advanced } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    // Track request
    logger.info("Email verification request", {
      userId: req.user.id,
      email: email,
      skipCache: !!skipCache,
      advanced: !!advanced,
    });

    // Check user's usage limits
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Get usage for current month (from cache if available)
    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();

    let usage = await getCachedUserUsage(req.user.id);
    if (!usage) {
      usage = await Usage.findOne({
        user: req.user.id,
        month: currentMonth,
        year: currentYear,
      });
    }

    // Get user's limit based on role
    let limit = 0;
    if (user.role === "free") {
      limit = 100;
    } else if (user.role === "startup") {
      limit = 5000;
    } else if (user.role === "business") {
      limit = 25000;
    } else if (user.role === "enterprise") {
      limit = Infinity; // Typically custom for enterprise
    }

    // Check if user has reached their monthly limit
    if (usage && usage.count >= limit && user.role !== "enterprise") {
      return res.status(403).json({
        success: false,
        message:
          "You have reached your monthly verification limit. Please upgrade your plan.",
      });
    }

    // Check cache first unless skipCache is explicitly set
    if (!skipCache) {
      const cachedResult = await getCachedVerificationResult(email);
      if (cachedResult) {
        // Track for metrics
        trackVerificationResult(cachedResult, email);

        // Still increment usage
        incrementUsage(req.user.id, currentMonth, currentYear);

        // Return cached result
        return res.json({
          success: true,
          data: cachedResult,
          fromCache: true,
          processingTime: Date.now() - startTime,
        });
      }
    }

    // Determine verification options based on user's plan
    const verificationOptions = {
      checkMx: true,
      checkDisposable: true,
      checkSyntax: true,
      checkDomainTypos: true,
      checkRoleAccount: user.role !== "free",
      checkCatchAll: user.role === "business" || user.role === "enterprise",
      checkSmtp: true,
      checkSpamTrap: user.role === "business" || user.role === "enterprise",
      cacheResults: true,
      logVerification: true,
      useAlternativeDns: user.role === "enterprise",
    };

    // For advanced verification, add to queue
    if (advanced || user.role === "enterprise") {
      // Generate tracking ID
      const trackingId = uuidv4();

      // Add job to queue
      const job = await verificationQueue.add({
        email,
        userId: req.user.id,
        logVerification: true,
        trackingId,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      });

      // Increment usage count
      incrementUsage(req.user.id, currentMonth, currentYear);

      // Return tracking info
      return res.json({
        success: true,
        message: "Verification job added to queue",
        data: {
          trackingId,
          jobId: job.id,
          email,
        },
      });
    }

    // For immediate verification (non-advanced)
    try {
      // Perform verification
      const result = await enhancedEmailVerifier.verify(
        email,
        verificationOptions
      );

      // Track result for metrics
      trackVerificationResult(result, email);

      // Increment usage count
      incrementUsage(req.user.id, currentMonth, currentYear);

      // Log verification
      await VerificationLog.create({
        user: req.user.id,
        email: email,
        result: result,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      });

      res.json({
        success: true,
        data: result,
        processingTime: Date.now() - startTime,
      });
    } catch (error) {
      logger.error("Verification error", {
        error: error.message,
        email,
        userId: req.user.id,
      });
      res.status(500).json({
        success: false,
        message: "Server error during verification",
        error: error.message,
      });
    }
  } catch (error) {
    logger.error("Verification endpoint error", {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

/**
 * Increment user's usage count
 * @param {string} userId - User ID
 * @param {number} month - Current month
 * @param {number} year - Current year
 */
async function incrementUsage(userId, month, year) {
  try {
    // Find or create usage record
    let usage = await Usage.findOne({
      user: userId,
      month,
      year,
    });

    if (usage) {
      usage.count += 1;
      await usage.save();
    } else {
      usage = await Usage.create({
        user: userId,
        month,
        year,
        count: 1,
      });
    }

    // Update cache
    await cacheUserUsage(userId, usage);
  } catch (error) {
    logger.error("Error incrementing usage", {
      error: error.message,
      userId,
      month,
      year,
    });
  }
}

/**
 * @route   GET /api/v1/verification/:trackingId
 * @desc    Get result of a queued verification
 * @access  Private
 */
router.get(
  "/verification/:trackingId",
  enhancedAuth,
  cacheMiddleware(60),
  async (req, res) => {
    try {
      const { trackingId } = req.params;

      // Find verification log with this tracking ID
      const verificationLog = await VerificationLog.findOne({
        trackingId,
        user: req.user.id,
      });

      if (!verificationLog) {
        return res.status(404).json({
          success: false,
          message: "Verification not found or still processing",
        });
      }

      res.json({
        success: true,
        data: verificationLog.result,
        timestamp: verificationLog.createdAt,
      });
    } catch (error) {
      logger.error("Error retrieving verification", {
        error: error.message,
        trackingId: req.params.trackingId,
      });
      res.status(500).json({
        success: false,
        message: "Server error retrieving verification result",
      });
    }
  }
);

/**
 * @route   POST /api/v1/enrich
 * @desc    Verify and enrich an email address
 * @access  Private (Business & Enterprise tiers only)
 */
router.post("/enrich", enhancedAuth, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    // Check user's tier/role
    const user = await User.findById(req.user.id);

    // Only business and enterprise tiers have access to enrichment
    if (user.role !== "business" && user.role !== "enterprise") {
      return res.status(403).json({
        success: false,
        message:
          "Email enrichment is only available on Business and Enterprise plans",
      });
    }

    // Track usage (similar to verify endpoint)
    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();
    incrementUsage(req.user.id, currentMonth, currentYear);

    // Determine enrichment options
    const enrichmentOptions = {
      checkCatchAll: true,
      checkSpamTrap: true,
      cacheResults: true,
      useAlternativeDns: user.role === "enterprise",
    };

    // Perform enrichment
    const result = await enhancedEmailVerifier.enrich(email, enrichmentOptions);

    // Log enrichment
    await VerificationLog.create({
      user: req.user.id,
      email: email,
      result: result,
      type: "enrichment",
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error("Email enrichment error", {
      error: error.message,
      email: req.body.email,
    });
    res.status(500).json({
      success: false,
      message: "Server error during enrichment",
    });
  }
});

/**
 * @route   POST /api/v1/bulk-verify
 * @desc    Verify multiple emails at once
 * @access  Private (Business & Enterprise tiers only)
 */
router.post("/bulk-verify", enhancedAuth, async (req, res) => {
  try {
    const { emails, callbackUrl, notifyEmail } = req.body;

    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Valid emails array is required",
      });
    }

    // Check user's tier/role
    const user = await User.findById(req.user.id);

    // Only business and enterprise tiers have access to bulk verification
    if (user.role !== "business" && user.role !== "enterprise") {
      return res.status(403).json({
        success: false,
        message:
          "Bulk verification is only available on Business and Enterprise plans",
      });
    }

    // Check bulk limits
    if (user.role === "business" && emails.length > 1000) {
      return res.status(400).json({
        success: false,
        message: "Business tier is limited to 1000 emails per bulk request",
      });
    } else if (user.role === "enterprise" && emails.length > 10000) {
      return res.status(400).json({
        success: false,
        message: "Enterprise tier is limited to 10,000 emails per bulk request",
      });
    }

    // Track usage
    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();

    let usage = await Usage.findOne({
      user: req.user.id,
      month: currentMonth,
      year: currentYear,
    });

    // Check if this would exceed user's limit
    const remainingCredits =
      user.role === "enterprise"
        ? Infinity
        : (user.role === "business" ? 25000 : 5000) - (usage ? usage.count : 0);

    if (emails.length > remainingCredits) {
      return res.status(403).json({
        success: false,
        message: `You have only ${remainingCredits} verification credits left this month, but this batch requires ${emails.length}`,
      });
    }

    // Generate batch ID
    const batchId = uuidv4();

    // Create batch job record
    const batchJob = new BatchJob({
      batchId,
      user: req.user.id,
      totalEmails: emails.length,
      processedEmails: 0,
      validEmails: 0,
      invalidEmails: 0,
      status: "queued",
      callbackUrl,
      notifyEmail: notifyEmail || user.email,
    });

    await batchJob.save();

    // Add to bulk verification queue
    const job = await bulkVerificationQueue.add(
      {
        emails,
        userId: req.user.id,
        batchId,
        notifyUser: true,
        ipAddress: req.ip,
      },
      {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
        removeOnComplete: false,
      }
    );

    // Update usage count
    if (usage) {
      usage.count += emails.length;
      await usage.save();
    } else {
      await Usage.create({
        user: req.user.id,
        month: currentMonth,
        year: currentYear,
        count: emails.length,
      });
    }

    res.json({
      success: true,
      message: "Bulk verification job added to queue",
      data: {
        batchId,
        jobId: job.id,
        totalEmails: emails.length,
        status: "queued",
        estimatedCompletionTime: new Date(Date.now() + emails.length * 200), // Rough estimate
      },
    });
  } catch (error) {
    logger.error("Bulk verification error", { error: error.message });
    res.status(500).json({
      success: false,
      message: "Server error during bulk verification",
    });
  }
});

/**
 * @route   GET /api/v1/bulk-verify/:batchId
 * @desc    Get status of a bulk verification job
 * @access  Private
 */
router.get("/bulk-verify/:batchId", enhancedAuth, async (req, res) => {
  try {
    const { batchId } = req.params;

    // Find batch job
    const batchJob = await BatchJob.findOne({
      batchId,
      user: req.user.id,
    });

    if (!batchJob) {
      return res.status(404).json({
        success: false,
        message: "Batch job not found",
      });
    }

    // Return status
    res.json({
      success: true,
      data: {
        batchId: batchJob.batchId,
        status: batchJob.status,
        totalEmails: batchJob.totalEmails,
        processedEmails: batchJob.processedEmails,
        validEmails: batchJob.validEmails,
        invalidEmails: batchJob.invalidEmails,
        progress: Math.round(
          (batchJob.processedEmails / batchJob.totalEmails) * 100
        ),
        createdAt: batchJob.createdAt,
        completedAt: batchJob.completedAt,
        downloadUrl:
          batchJob.status === "completed"
            ? `/api/v1/bulk-verify/${batchId}/download`
            : null,
      },
    });
  } catch (error) {
    logger.error("Error retrieving batch status", {
      error: error.message,
      batchId: req.params.batchId,
    });
    res.status(500).json({
      success: false,
      message: "Server error retrieving batch status",
    });
  }
});

/**
 * @route   GET /api/v1/bulk-verify/:batchId/download
 * @desc    Download results of a bulk verification job
 * @access  Private
 */
router.get("/bulk-verify/:batchId/download", enhancedAuth, async (req, res) => {
  try {
    const { batchId } = req.params;
    const { format = "json" } = req.query;

    // Find batch job
    const batchJob = await BatchJob.findOne({
      batchId,
      user: req.user.id,
    });

    if (!batchJob) {
      return res.status(404).json({
        success: false,
        message: "Batch job not found",
      });
    }

    if (batchJob.status !== "completed") {
      return res.status(400).json({
        success: false,
        message: "Batch job is not completed yet",
      });
    }

    // Get verification logs for this batch
    const verificationLogs = await VerificationLog.find({
      batchId,
      user: req.user.id,
    }).sort("createdAt");

    if (format.toLowerCase() === "csv") {
      // Generate CSV
      const csvHeader =
        "Email,Valid,Format Valid,MX Records,Disposable,SMTP Check,Role Account,Catch All,Spam Trap,Suggestion\n";
      const csvRows = verificationLogs.map((log) => {
        const result = log.result;
        return `"${result.email}",${result.isValid},${result.formatValid},${
          result.hasMx
        },${result.isDisposable},${result.smtpCheck},${
          result.isRoleAccount || false
        },${result.isCatchAll || false},${result.isSpamTrap || false},"${
          result.suggestion || ""
        }"`;
      });

      const csv = csvHeader + csvRows.join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="email-verification-${batchId}.csv"`
      );
      return res.send(csv);
    } else {
      // Return JSON
      const results = verificationLogs.map((log) => log.result);

      res.json({
        success: true,
        data: {
          batchId,
          totalEmails: batchJob.totalEmails,
          validEmails: batchJob.validEmails,
          invalidEmails: batchJob.invalidEmails,
          completedAt: batchJob.completedAt,
          results,
        },
      });
    }
  } catch (error) {
    logger.error("Error downloading batch results", {
      error: error.message,
      batchId: req.params.batchId,
    });
    res.status(500).json({
      success: false,
      message: "Server error downloading batch results",
    });
  }
});

/**
 * @route   GET /api/v1/usage
 * @desc    Get user's current usage stats
 * @access  Private
 */
router.get("/usage", enhancedAuth, cacheMiddleware(300), async (req, res) => {
  try {
    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();

    // Get cached usage if available
    let usage = await getCachedUserUsage(req.user.id);

    // If not in cache, get from database
    if (!usage) {
      usage = await Usage.findOne({
        user: req.user.id,
        month: currentMonth,
        year: currentYear,
      });
    }

    const user = await User.findById(req.user.id);

    // Determine limit based on user role
    let limit = 0;
    if (user.role === "free") {
      limit = 100;
    } else if (user.role === "startup") {
      limit = 5000;
    } else if (user.role === "business") {
      limit = 25000;
    } else if (user.role === "enterprise") {
      limit = Infinity; // Typically custom for enterprise
    }

    // Get usage history
    const usageHistory = await Usage.find({
      user: req.user.id,
    })
      .sort("-year -month")
      .limit(6);

    // Format history data
    const history = usageHistory.map((entry) => ({
      month: entry.month,
      year: entry.year,
      count: entry.count,
      period: `${entry.year}-${String(entry.month + 1).padStart(2, "0")}`,
    }));

    res.json({
      success: true,
      data: {
        used: usage ? usage.count : 0,
        limit,
        remaining:
          limit === Infinity ? "Unlimited" : limit - (usage ? usage.count : 0),
        plan: user.role,
        history,
      },
    });
  } catch (error) {
    logger.error("Usage retrieval error", { error: error.message });
    res.status(500).json({
      success: false,
      message: "Server error while retrieving usage",
    });
  }
});

/**
 * @route   GET /api/v1/health
 * @desc    Health check endpoint
 * @access  Public
 */
router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    version: process.env.API_VERSION || "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
