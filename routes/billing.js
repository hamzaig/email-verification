// routes/billing.js - Subscription and payment routes

const express = require("express");
const router = express.Router();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const auth = require("../middleware/auth");
const User = require("../models/User");

/**
 * @route   POST /billing/create-subscription
 * @desc    Create a new subscription
 * @access  Private
 */
router.post("/create-subscription", auth, async (req, res) => {
  try {
    const { plan, paymentMethodId } = req.body;

    if (!plan || !paymentMethodId) {
      return res.status(400).json({
        success: false,
        message: "Plan and payment method are required",
      });
    }

    const user = await User.findById(req.user.id);

    // Get price ID based on plan
    let priceId;
    switch (plan) {
      case "startup":
        priceId = process.env.STRIPE_STARTUP_PRICE_ID;
        break;
      case "business":
        priceId = process.env.STRIPE_BUSINESS_PRICE_ID;
        break;
      case "enterprise":
        priceId = process.env.STRIPE_ENTERPRISE_PRICE_ID;
        break;
      default:
        return res.status(400).json({
          success: false,
          message: "Invalid plan selected",
        });
    }

    // Create or retrieve customer
    let customer;
    if (user.customerId) {
      customer = await stripe.customers.retrieve(user.customerId);
    } else {
      customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        payment_method: paymentMethodId,
        invoice_settings: {
          default_payment_method: paymentMethodId,
        },
      });

      // Save customer ID to user
      user.customerId = customer.id;
      await user.save();
    }

    // If user already has a subscription, cancel it
    if (user.subscriptionId) {
      await stripe.subscriptions.del(user.subscriptionId);
    }

    // Create the subscription
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      expand: ["latest_invoice.payment_intent"],
      payment_behavior: "default_incomplete",
      payment_settings: {
        payment_method_types: ["card"],
        save_default_payment_method: "on_subscription",
      },
    });

    // Update user with subscription info and role
    user.subscriptionId = subscription.id;
    user.role = plan;
    await user.save();

    res.json({
      success: true,
      subscription: {
        id: subscription.id,
        status: subscription.status,
        current_period_end: new Date(subscription.current_period_end * 1000),
        client_secret: subscription.latest_invoice.payment_intent.client_secret,
      },
    });
  } catch (error) {
    console.error("Subscription creation error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during subscription creation",
    });
  }
});

/**
 * @route   GET /billing/subscription
 * @desc    Get current subscription details
 * @access  Private
 */
router.get("/subscription", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user.subscriptionId) {
      return res.json({
        success: true,
        subscription: null,
        plan: user.role,
      });
    }

    const subscription = await stripe.subscriptions.retrieve(
      user.subscriptionId
    );

    res.json({
      success: true,
      subscription: {
        id: subscription.id,
        status: subscription.status,
        current_period_end: new Date(subscription.current_period_end * 1000),
        plan: user.role,
      },
    });
  } catch (error) {
    console.error("Subscription retrieval error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during subscription retrieval",
    });
  }
});

/**
 * @route   POST /billing/cancel-subscription
 * @desc    Cancel current subscription
 * @access  Private
 */
router.post("/cancel-subscription", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user.subscriptionId) {
      return res.status(400).json({
        success: false,
        message: "No active subscription found",
      });
    }

    // Cancel at period end
    const subscription = await stripe.subscriptions.update(
      user.subscriptionId,
      {
        cancel_at_period_end: true,
      }
    );

    res.json({
      success: true,
      subscription: {
        id: subscription.id,
        status: subscription.status,
        current_period_end: new Date(subscription.current_period_end * 1000),
        cancel_at_period_end: subscription.cancel_at_period_end,
      },
    });
  } catch (error) {
    console.error("Subscription cancellation error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during subscription cancellation",
    });
  }
});

/**
 * @route   POST /billing/webhook
 * @desc    Handle Stripe webhook events
 * @access  Public
 */
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object;

        // Find user with this subscription
        const user = await User.findOne({ subscriptionId: subscription.id });

        if (user) {
          // If subscription is canceled or unpaid, revert to free tier
          if (
            subscription.status === "canceled" ||
            subscription.status === "unpaid" ||
            event.type === "customer.subscription.deleted"
          ) {
            user.role = "free";
            await user.save();
            console.log(`User ${user.email} reverted to free tier`);
          }
        }
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object;

        // Find user with this subscription
        const user = await User.findOne({ customerId: invoice.customer });

        if (user) {
          console.log(`Payment failed for user ${user.email}`);
          // You could send an email to the user here
        }
        break;
      }
      // Add other webhook events as needed
    }

    res.json({ received: true });
  }
);

module.exports = router;
