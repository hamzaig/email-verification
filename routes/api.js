const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const emailVerifier = require("../utils/emailVerifier");
const Usage = require("../models/Usage");
const User = require("../models/User");
const advancedVerifier = require("../utils/advancedEmailVerifier");

/**
 * @route   POST /api/verify
 * @desc    Verify an email address
 * @access  Private
 */
router.post("/verify", auth, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    // Check user's usage limits
    const user = await User.findById(req.user.id);

    // For the free tier (role: 'free')
    if (user.role === "free") {
      const currentMonth = new Date().getMonth();
      const currentYear = new Date().getFullYear();

      // Get usage for current month
      const usage = await Usage.findOne({
        user: req.user.id,
        month: currentMonth,
        year: currentYear,
      });

      // Check if user has reached their monthly limit (100 for free tier)
      if (usage && usage.count >= 100) {
        return res.status(403).json({
          success: false,
          message:
            "You have reached your monthly verification limit. Please upgrade your plan.",
        });
      }

      // Create or update usage record
      if (usage) {
        usage.count += 1;
        await usage.save();
      } else {
        await Usage.create({
          user: req.user.id,
          month: currentMonth,
          year: currentYear,
          count: 1,
        });
      }
    }

    // For paid tiers, we would check against their respective limits
    // This is simplified for this example

    // Perform verification
    const result = await emailVerifier.verify(email);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Email verification error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during verification",
    });
  }
});

/**
 * @route   POST /api/enrich
 * @desc    Verify and enrich an email address
 * @access  Private (Business & Enterprise tiers only)
 */
router.post("/enrich", auth, async (req, res) => {
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

    // Track usage similar to verify endpoint
    // Not implemented here for brevity

    // Perform enrichment
    const result = await emailVerifier.enrich(email);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Email enrichment error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during enrichment",
    });
  }
});

/**
 * @route   POST /api/bulk-verify
 * @desc    Verify multiple emails at once
 * @access  Private (Business & Enterprise tiers only)
 */
router.post("/bulk-verify", auth, async (req, res) => {
  try {
    const { emails } = req.body;

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
    }

    // Enterprise would have higher limits or no limits

    // Track usage (simplified)
    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();

    let usage = await Usage.findOne({
      user: req.user.id,
      month: currentMonth,
      year: currentYear,
    });

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

    // Process emails (in production, you'd want to handle this asynchronously for large batches)
    const results = [];
    for (const email of emails) {
      const result = await emailVerifier.verify(email);
      results.push(result);
    }

    res.json({
      success: true,
      data: results,
    });
  } catch (error) {
    console.error("Bulk verification error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during bulk verification",
    });
  }
});

/**
 * @route   GET /api/usage
 * @desc    Get user's current usage stats
 * @access  Private
 */
router.get("/usage", auth, async (req, res) => {
  try {
    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();

    const usage = await Usage.findOne({
      user: req.user.id,
      month: currentMonth,
      year: currentYear,
    });

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

    res.json({
      success: true,
      data: {
        used: usage ? usage.count : 0,
        limit,
        remaining: limit - (usage ? usage.count : 0),
        plan: user.role,
      },
    });
  } catch (error) {
    console.error("Usage retrieval error:", error);
    res.status(500).json({
      success: false,
      message: "Server error while retrieving usage",
    });
  }
});

/**
 * @swagger
 * /api/v1/verify/advanced:
 *   post:
 *     summary: Advanced email verification
 *     description: Perform comprehensive email verification with multiple checks
 *     tags: [Email]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 description: Email address to verify
 *               options:
 *                 type: object
 *                 description: Verification options
 *     responses:
 *       200:
 *         description: Email verification result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *       400:
 *         description: Invalid request
 *       500:
 *         description: Server error
 */
router.post("/verify/advanced", async (req, res) => {
  try {
    const { email, options = {} } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: "Email is required",
      });
    }

    const result = await advancedVerifier.verify(email, {
      checkSmtp: true,
      checkSpf: true,
      checkDkim: true,
      checkDmarc: true,
      checkMailbox: true,
      ...options,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Advanced verification error:", error);
    res.status(500).json({
      success: false,
      error: "Verification failed",
      details: error.message,
    });
  }
});

module.exports = router;
