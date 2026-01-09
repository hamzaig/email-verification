// config/queue.js
const Bull = require("bull");
const enhancedEmailVerifier = require("../utils/enhancedEmailVerifier");
const VerificationLog = require("../models/VerificationLog");
const User = require("../models/User");
const { sendVerificationCompletedEmail } = require("../utils/emailService");
const { logger } = require("../utils/monitoring");

// Redis connection configuration
const redisConfig = {
  redis: {
    port: process.env.REDIS_PORT || 6379,
    host: process.env.REDIS_HOST || "localhost",
    password: process.env.REDIS_PASSWORD || undefined,
    db: process.env.REDIS_DB || 0,
    tls: process.env.REDIS_TLS_URL
      ? {
          rejectUnauthorized: false,
          requestCert: true,
        }
      : undefined,
  },
  prefix: process.env.QUEUE_PREFIX || "email-api",
};

// Create queues
const verificationQueue = new Bull("email-verification", redisConfig);
verificationQueue.setMaxListeners(50);

const bulkVerificationQueue = new Bull("bulk-email-verification", redisConfig);
bulkVerificationQueue.setMaxListeners(50);

// Process individual email verification
verificationQueue.process(async (job) => {
  const { email, userId, logVerification, trackingId } = job.data;

  try {
    // Update progress
    job.progress(25);

    logger.info(`Processing verification job for ${email}`, {
      jobId: job.id,
      userId,
      trackingId,
    });

    // Perform verification
    const result = await enhancedEmailVerifier.verify(email, {
      checkCache: false, // Skip cache since we're already in a queue
      checkMx: true,
      checkDisposable: true,
      checkSyntax: true,
      checkDomainTypos: true,
      checkRoleAccount: true,
      checkCatchAll: true,
      checkSmtp: true,
      checkSpamTrap: true,
      cacheResults: true,
    });

    job.progress(75);

    // Log verification if needed
    if (logVerification) {
      await VerificationLog.create({
        user: userId,
        email: email,
        result: result,
        trackingId: trackingId,
        ipAddress: job.data.ipAddress,
        userAgent: job.data.userAgent,
      });
    }

    job.progress(100);

    logger.info(`Completed verification job for ${email}`, {
      jobId: job.id,
      valid: result.isValid,
    });

    return result;
  } catch (error) {
    logger.error(`Verification queue error for ${email}:`, {
      error: error.message,
      stack: error.stack,
      jobId: job.id,
    });
    throw error;
  }
});

// Process bulk email verification
bulkVerificationQueue.process(async (job) => {
  const { emails, userId, batchId, notifyUser, ipAddress } = job.data;
  const batchSize = emails.length;
  const results = [];
  let processed = 0;
  let validCount = 0;
  let invalidCount = 0;

  try {
    logger.info(`Starting bulk verification batch ${batchId}`, {
      jobId: job.id,
      userId,
      emailCount: batchSize,
    });

    // Update batch job status in database
    const BatchJob = require("../models/BatchJob");
    await BatchJob.findOneAndUpdate(
      { batchId },
      {
        status: "processing",
        startedAt: new Date(),
      }
    );

    for (const email of emails) {
      // Verify each email
      try {
        const result = await enhancedEmailVerifier.verify(email, {
          checkMx: true,
          checkDisposable: true,
          checkSyntax: true,
          checkDomainTypos: true,
          checkRoleAccount: true,
          checkCatchAll: true,
          checkSmtp: true,
          checkSpamTrap: true,
          cacheResults: true,
        });

        results.push(result);

        // Count valid/invalid
        if (result.isValid) {
          validCount++;
        } else {
          invalidCount++;
        }

        // Update progress
        processed++;
        job.progress(Math.floor((processed / batchSize) * 100));

        // Log verification
        await VerificationLog.create({
          user: userId,
          email: email,
          result: result,
          batchId: batchId,
          ipAddress: ipAddress,
        });

        // Update batch job in database periodically (every 50 emails)
        if (processed % 50 === 0) {
          await BatchJob.findOneAndUpdate(
            { batchId },
            {
              processedEmails: processed,
              validEmails: validCount,
              invalidEmails: invalidCount,
            }
          );
        }

        // Add a small delay to prevent rate limiting
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch (error) {
        logger.error(`Error verifying email ${email} in batch ${batchId}`, {
          error: error.message,
        });

        // Still count as processed but as invalid
        processed++;
        invalidCount++;

        // Create failure log
        await VerificationLog.create({
          user: userId,
          email: email,
          result: {
            email,
            isValid: false,
            errors: [error.message],
            timestamp: new Date(),
          },
          batchId: batchId,
          ipAddress: ipAddress,
        });
      }
    }

    // Update completed job status
    await BatchJob.findOneAndUpdate(
      { batchId },
      {
        status: "completed",
        processedEmails: processed,
        validEmails: validCount,
        invalidEmails: invalidCount,
        completedAt: new Date(),
      }
    );

    // Notify user if requested
    if (notifyUser) {
      const user = await User.findById(userId);
      if (user && user.email) {
        await sendVerificationCompletedEmail(user.email, batchId, processed);
      }
    }

    logger.info(`Completed bulk verification batch ${batchId}`, {
      jobId: job.id,
      processed,
      valid: validCount,
      invalid: invalidCount,
    });

    return {
      batchId,
      total: batchSize,
      processed,
      valid: validCount,
      invalid: invalidCount,
    };
  } catch (error) {
    logger.error(`Bulk verification queue error for batch ${batchId}`, {
      error: error.message,
      stack: error.stack,
      jobId: job.id,
    });

    // Update batch job as failed
    const BatchJob = require("../models/BatchJob");
    await BatchJob.findOneAndUpdate(
      { batchId },
      {
        status: "failed",
        error: error.message,
        processedEmails: processed,
        validEmails: validCount,
        invalidEmails: invalidCount,
      }
    );

    throw error;
  }
});

// Event listeners for monitoring
function setupQueueMonitoring() {
  const queues = [verificationQueue, bulkVerificationQueue];

  queues.forEach((queue) => {
    queue.on("error", (error) => {
      logger.error(`Queue ${queue.name} error:`, {
        error: error.message,
        stack: error.stack,
      });
    });

    queue.on("failed", (job, error) => {
      logger.error(`Job ${job.id} in ${queue.name} failed:`, {
        error: error.message,
        stack: error.stack,
        job: job.id,
        data: job.data,
      });
    });

    queue.on("stalled", (job) => {
      logger.warn(`Job ${job.id} in ${queue.name} stalled`, {
        job: job.id,
        data: job.data,
      });
    });

    queue.on("completed", (job, result) => {
      logger.debug(`Job ${job.id} in ${queue.name} completed`, {
        job: job.id,
        data: job.data
          ? {
              email: job.data.email,
              batchId: job.data.batchId,
            }
          : {},
      });
    });
  });
}

setupQueueMonitoring();

module.exports = {
  verificationQueue,
  bulkVerificationQueue,
  getQueueStats: async () => {
    const [verificationCounts, bulkCounts] = await Promise.all([
      verificationQueue.getJobCounts(),
      bulkVerificationQueue.getJobCounts(),
    ]);

    return {
      verification: verificationCounts,
      bulkVerification: bulkCounts,
    };
  },
  cleanQueues: async () => {
    await Promise.all([
      verificationQueue.clean(7 * 24 * 60 * 60 * 1000, "completed"), // Remove completed jobs older than 7 days
      verificationQueue.clean(7 * 24 * 60 * 60 * 1000, "failed"), // Remove failed jobs older than 7 days
      bulkVerificationQueue.clean(7 * 24 * 60 * 60 * 1000, "completed"),
      bulkVerificationQueue.clean(7 * 24 * 60 * 60 * 1000, "failed"),
    ]);
  },
};
