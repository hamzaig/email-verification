// utils/emailService.js
const nodemailer = require("nodemailer");
const { logger } = require("./monitoring");

// Create reusable transporter object using SMTP transport
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/**
 * Send verification email
 * @param {string} email - Recipient email
 * @param {string} token - Verification token
 */
async function sendVerificationEmail(email, token) {
  try {
    const verificationUrl = `${process.env.APP_URL}/api/verification/verify?token=${token}`;

    const mailOptions = {
      from: process.env.SMTP_FROM,
      to: email,
      subject: "Verify Your Email Address",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Email Verification</h2>
          <p>Thank you for registering! Please verify your email address by clicking the link below:</p>
          <p><a href="${verificationUrl}" style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Verify Email</a></p>
          <p>Or copy and paste this link into your browser:</p>
          <p>${verificationUrl}</p>
          <p>This link will expire in 24 hours.</p>
          <p>If you did not create an account, please ignore this email.</p>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);
    logger.info("Verification email sent", { email });
  } catch (error) {
    logger.error("Error sending verification email", { error: error.message });
    throw error;
  }
}

/**
 * Send a verification completed email notification
 * @param {string} email - Recipient email address
 * @param {string} batchId - Batch ID
 * @param {number} processedCount - Number of emails processed
 * @returns {Promise<boolean>} - Whether email was sent successfully
 */
async function sendVerificationCompletedEmail(email, batchId, processedCount) {
  try {
    if (!transporter) {
      logger.error("Email transporter not initialized");
      return false;
    }

    const appName = process.env.APP_NAME || "Email Verification API";
    const appUrl = process.env.APP_URL || "http://localhost:3000";

    const info = await transporter.sendMail({
      from: `"${appName}" <${process.env.EMAIL_FROM || "noreply@example.com"}>`,
      to: email,
      subject: `Your Email Verification Batch #${batchId.substring(
        0,
        8
      )} is Complete`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2c3e50;">Email Verification Complete</h2>
          <p style="color: #34495e;">Your bulk email verification job has been completed.</p>
          <div style="background-color: #f8f9fa; border-left: 4px solid #4caf50; padding: 15px; margin: 20px 0;">
            <p><strong>Batch ID:</strong> ${batchId}</p>
            <p><strong>Processed Emails:</strong> ${processedCount}</p>
            <p><strong>Completion Date:</strong> ${new Date().toLocaleString()}</p>
          </div>
          <p>You can view the full results by clicking the button below:</p>
          <a href="${appUrl}/dashboard/batches/${batchId}" style="display: inline-block; background-color: #4caf50; color: white; text-decoration: none; padding: 10px 20px; border-radius: 4px; margin: 15px 0;">View Results</a>
          <p>You can also download the results in CSV or JSON format from your dashboard.</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 25px 0;">
          <p style="color: #7f8c8d; font-size: 12px;">This is an automated message from ${appName}. Please do not reply to this email.</p>
        </div>
      `,
      text: `
        Email Verification Complete
        
        Your bulk email verification job has been completed.
        
        Batch ID: ${batchId}
        Processed Emails: ${processedCount}
        Completion Date: ${new Date().toLocaleString()}
        
        You can view the full results at:
        ${appUrl}/dashboard/batches/${batchId}
        
        You can also download the results in CSV or JSON format from your dashboard.
        
        This is an automated message from ${appName}. Please do not reply to this email.
      `,
    });

    logger.info("Verification completion email sent", {
      messageId: info.messageId,
      recipient: email,
      batchId,
    });

    return true;
  } catch (error) {
    logger.error("Failed to send verification completion email", {
      error: error.message,
      recipient: email,
      batchId,
    });
    return false;
  }
}

/**
 * Send a welcome email to new user
 * @param {string} email - Recipient email address
 * @param {string} name - User's name
 * @returns {Promise<boolean>} - Whether email was sent successfully
 */
async function sendWelcomeEmail(email, name) {
  try {
    if (!transporter) {
      logger.error("Email transporter not initialized");
      return false;
    }

    const appName = process.env.APP_NAME || "Email Verification API";
    const appUrl = process.env.APP_URL || "http://localhost:3000";

    const info = await transporter.sendMail({
      from: `"${appName}" <${process.env.EMAIL_FROM || "noreply@example.com"}>`,
      to: email,
      subject: `Welcome to ${appName}!`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2c3e50;">Welcome to ${appName}!</h2>
          <p style="color: #34495e;">Hi ${name},</p>
          <p style="color: #34495e;">Thank you for signing up! We're excited to have you on board.</p>
          <p>Here's what you can do next:</p>
          <ul>
            <li>Explore our <a href="${appUrl}/dashboard">dashboard</a> to get started</li>
            <li>Check out our <a href="${appUrl}/documentation">API documentation</a></li>
            <li>Learn how to <a href="${appUrl}/documentation/integration">integrate with your application</a></li>
            <li>View your <a href="${appUrl}/dashboard/usage">usage statistics</a></li>
          </ul>
          <p>If you have any questions, please don't hesitate to reach out to our support team.</p>
          <a href="${appUrl}/dashboard" style="display: inline-block; background-color: #3498db; color: white; text-decoration: none; padding: 10px 20px; border-radius: 4px; margin: 15px 0;">Go to Dashboard</a>
          <hr style="border: none; border-top: 1px solid #eee; margin: 25px 0;">
          <p style="color: #7f8c8d; font-size: 12px;">This is an automated message from ${appName}. Please do not reply to this email.</p>
        </div>
      `,
      text: `
        Welcome to ${appName}!
        
        Hi ${name},
        
        Thank you for signing up! We're excited to have you on board.
        
        Here's what you can do next:
        - Explore our dashboard: ${appUrl}/dashboard
        - Check out our API documentation: ${appUrl}/documentation
        - Learn how to integrate with your application: ${appUrl}/documentation/integration
        - View your usage statistics: ${appUrl}/dashboard/usage
        
        If you have any questions, please don't hesitate to reach out to our support team.
        
        Go to Dashboard: ${appUrl}/dashboard
        
        This is an automated message from ${appName}. Please do not reply to this email.
      `,
    });

    logger.info("Welcome email sent", {
      messageId: info.messageId,
      recipient: email,
    });

    return true;
  } catch (error) {
    logger.error("Failed to send welcome email", {
      error: error.message,
      recipient: email,
    });
    return false;
  }
}

/**
 * Send a password reset email
 * @param {string} email - Recipient email address
 * @param {string} resetToken - Password reset token
 * @returns {Promise<boolean>} - Whether email was sent successfully
 */
async function sendPasswordResetEmail(email, resetToken) {
  try {
    if (!transporter) {
      logger.error("Email transporter not initialized");
      return false;
    }

    const appName = process.env.APP_NAME || "Email Verification API";
    const appUrl = process.env.APP_URL || "http://localhost:3000";
    const resetUrl = `${appUrl}/reset-password/${resetToken}`;

    const info = await transporter.sendMail({
      from: `"${appName}" <${process.env.EMAIL_FROM || "noreply@example.com"}>`,
      to: email,
      subject: `Reset Your ${appName} Password`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2c3e50;">Password Reset Request</h2>
          <p style="color: #34495e;">We received a request to reset your password. If you didn't make this request, you can ignore this email.</p>
          <p style="color: #34495e;">To reset your password, click the button below:</p>
          <a href="${resetUrl}" style="display: inline-block; background-color: #3498db; color: white; text-decoration: none; padding: 10px 20px; border-radius: 4px; margin: 15px 0;">Reset Password</a>
          <p style="color: #34495e;">Or copy and paste this URL into your browser:</p>
          <p style="color: #34495e; word-break: break-all;"><a href="${resetUrl}">${resetUrl}</a></p>
          <p style="color: #34495e;">This link will expire in 1 hour.</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 25px 0;">
          <p style="color: #7f8c8d; font-size: 12px;">This is an automated message from ${appName}. Please do not reply to this email.</p>
        </div>
      `,
      text: `
        Password Reset Request
        
        We received a request to reset your password. If you didn't make this request, you can ignore this email.
        
        To reset your password, visit this link:
        ${resetUrl}
        
        This link will expire in 1 hour.
        
        This is an automated message from ${appName}. Please do not reply to this email.
      `,
    });

    logger.info("Password reset email sent", {
      messageId: info.messageId,
      recipient: email,
    });

    return true;
  } catch (error) {
    logger.error("Failed to send password reset email", {
      error: error.message,
      recipient: email,
    });
    return false;
  }
}

/**
 * Send an upgrade notification email
 * @param {string} email - Recipient email address
 * @param {string} name - User's name
 * @param {string} oldPlan - Previous plan
 * @param {string} newPlan - New plan
 * @returns {Promise<boolean>} - Whether email was sent successfully
 */
async function sendPlanUpgradeEmail(email, name, oldPlan, newPlan) {
  try {
    if (!transporter) {
      logger.error("Email transporter not initialized");
      return false;
    }

    const appName = process.env.APP_NAME || "Email Verification API";
    const appUrl = process.env.APP_URL || "http://localhost:3000";

    // Format plan names for display
    const formatPlanName = (plan) => {
      return plan.charAt(0).toUpperCase() + plan.slice(1);
    };

    const info = await transporter.sendMail({
      from: `"${appName}" <${process.env.EMAIL_FROM || "noreply@example.com"}>`,
      to: email,
      subject: `Your ${appName} Plan Has Been Upgraded`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2c3e50;">Plan Upgrade Confirmation</h2>
          <p style="color: #34495e;">Hi ${name},</p>
          <p style="color: #34495e;">Your subscription has been successfully upgraded from <strong>${formatPlanName(
            oldPlan
          )}</strong> to <strong>${formatPlanName(newPlan)}</strong>.</p>
          <div style="background-color: #f8f9fa; border-left: 4px solid #3498db; padding: 15px; margin: 20px 0;">
            <p><strong>New Plan:</strong> ${formatPlanName(newPlan)}</p>
            <p><strong>Effective Date:</strong> ${new Date().toLocaleDateString()}</p>
          </div>
          <p>You can view your subscription details and billing information in your account settings:</p>
          <a href="${appUrl}/dashboard/settings/billing" style="display: inline-block; background-color: #3498db; color: white; text-decoration: none; padding: 10px 20px; border-radius: 4px; margin: 15px 0;">View Subscription</a>
          <p>Thank you for your continued support!</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 25px 0;">
          <p style="color: #7f8c8d; font-size: 12px;">This is an automated message from ${appName}. Please do not reply to this email.</p>
        </div>
      `,
      text: `
        Plan Upgrade Confirmation
        
        Hi ${name},
        
        Your subscription has been successfully upgraded from ${formatPlanName(
          oldPlan
        )} to ${formatPlanName(newPlan)}.
        
        New Plan: ${formatPlanName(newPlan)}
        Effective Date: ${new Date().toLocaleDateString()}
        
        You can view your subscription details and billing information in your account settings:
        ${appUrl}/dashboard/settings/billing
        
        Thank you for your continued support!
        
        This is an automated message from ${appName}. Please do not reply to this email.
      `,
    });

    logger.info("Plan upgrade email sent", {
      messageId: info.messageId,
      recipient: email,
      oldPlan,
      newPlan,
    });

    return true;
  } catch (error) {
    logger.error("Failed to send plan upgrade email", {
      error: error.message,
      recipient: email,
    });
    return false;
  }
}

/**
 * Send a usage limit warning email
 * @param {string} email - Recipient email address
 * @param {string} name - User's name
 * @param {string} plan - Current plan
 * @param {number} used - Used credits
 * @param {number} limit - Total limit
 * @returns {Promise<boolean>} - Whether email was sent successfully
 */
async function sendUsageLimitWarningEmail(email, name, plan, used, limit) {
  try {
    if (!transporter) {
      logger.error("Email transporter not initialized");
      return false;
    }

    const appName = process.env.APP_NAME || "Email Verification API";
    const appUrl = process.env.APP_URL || "http://localhost:3000";

    // Calculate percentage used
    const percentUsed = Math.min(Math.round((used / limit) * 100), 100);

    const info = await transporter.sendMail({
      from: `"${appName}" <${process.env.EMAIL_FROM || "noreply@example.com"}>`,
      to: email,
      subject: `${appName} - Usage Limit Warning`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2c3e50;">Usage Limit Warning</h2>
          <p style="color: #34495e;">Hi ${name},</p>
          <p style="color: #34495e;">Your account has reached ${percentUsed}% of your monthly usage limit.</p>
          <div style="background-color: #f8f9fa; border-left: 4px solid #e74c3c; padding: 15px; margin: 20px 0;">
            <p><strong>Current Plan:</strong> ${
              plan.charAt(0).toUpperCase() + plan.slice(1)
            }</p>
            <p><strong>Used Credits:</strong> ${used.toLocaleString()} of ${limit.toLocaleString()}</p>
            <p><strong>Remaining:</strong> ${(
              limit - used
            ).toLocaleString()}</p>
          </div>
          <p>If you need more credits, consider upgrading your plan:</p>
          <a href="${appUrl}/dashboard/settings/billing" style="display: inline-block; background-color: #e74c3c; color: white; text-decoration: none; padding: 10px 20px; border-radius: 4px; margin: 15px 0;">Upgrade Plan</a>
          <p>You can also view your detailed usage statistics in your dashboard:</p>
          <a href="${appUrl}/dashboard/usage" style="display: inline-block; background-color: #3498db; color: white; text-decoration: none; padding: 10px 20px; border-radius: 4px; margin: 15px 0;">View Usage</a>
          <hr style="border: none; border-top: 1px solid #eee; margin: 25px 0;">
          <p style="color: #7f8c8d; font-size: 12px;">This is an automated message from ${appName}. Please do not reply to this email.</p>
        </div>
      `,
      text: `
        Usage Limit Warning
        
        Hi ${name},
        
        Your account has reached ${percentUsed}% of your monthly usage limit.
        
        Current Plan: ${plan.charAt(0).toUpperCase() + plan.slice(1)}
        Used Credits: ${used.toLocaleString()} of ${limit.toLocaleString()}
        Remaining: ${(limit - used).toLocaleString()}
        
        If you need more credits, consider upgrading your plan:
        ${appUrl}/dashboard/settings/billing
        
        You can also view your detailed usage statistics in your dashboard:
        ${appUrl}/dashboard/usage
        
        This is an automated message from ${appName}. Please do not reply to this email.
      `,
    });

    logger.info("Usage limit warning email sent", {
      messageId: info.messageId,
      recipient: email,
      percentUsed,
    });

    return true;
  } catch (error) {
    logger.error("Failed to send usage limit warning email", {
      error: error.message,
      recipient: email,
    });
    return false;
  }
}

// Export email functions
module.exports = {
  sendVerificationEmail,
  sendVerificationCompletedEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendPlanUpgradeEmail,
  sendUsageLimitWarningEmail,
};
