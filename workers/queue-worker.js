// workers/queue-worker.js
require("dotenv").config();
const {
  verificationQueue,
  bulkVerificationQueue,
  cleanQueues,
} = require("../config/queue");
const { logger } = require("../utils/monitoring");
const mongoose = require("mongoose");
const User = require("../models/User");
const BatchJob = require("../models/BatchJob");
const { sendVerificationCompletedEmail } = require("../utils/emailService");

// Connect to MongoDB
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    logger.info("MongoDB Connected in worker process");
    startWorkers();
  })
  .catch((err) => {
    logger.error("MongoDB connection error:", err);
    process.exit(1);
  });

// Process multiple jobs concurrently
function startWorkers() {
  logger.info("Starting queue workers...");

  // Set concurrency for verification queue
  const verificationConcurrency =
    parseInt(process.env.VERIFICATION_CONCURRENCY) || 20;
  verificationQueue.process(verificationConcurrency, handleVerificationJob);

  // Set concurrency for bulk verification queue
  const bulkConcurrency =
    parseInt(process.env.BULK_VERIFICATION_CONCURRENCY) || 5;
  bulkVerificationQueue.process(bulkConcurrency, handleBulkVerificationJob);

  // Set up queue event listeners
  setupQueueEvents(verificationQueue, "Verification");
  setupQueueEvents(bulkVerificationQueue, "Bulk Verification");

  // Run cleanup periodically
  setInterval(async () => {
    await cleanQueues();
    logger.info("Queue cleanup performed");
  }, 24 * 60 * 60 * 1000); // Once per day

  logger.info(
    `Workers started with ${verificationConcurrency} verification and ${bulkConcurrency} bulk verification concurrency`
  );
}

// Handle single verification job
async function handleVerificationJob(job, done) {
  try {
    logger.info(`Processing verification job ${job.id}`, {
      email: job.data.email,
      userId: job.data.userId,
    });

    // Perform verification logic here
    // This would call the enhanced email verifier

    done(null, { success: true, result: {} });
  } catch (error) {
    logger.error(`Error processing verification job ${job.id}`, {
      error: error.message,
      stack: error.stack,
      email: job.data.email,
    });
    done(error);
  }
}

// Handle bulk verification job
async function handleBulkVerificationJob(job, done) {
  try {
    const { emails, userId, batchId } = job.data;

    logger.info(`Processing bulk verification job ${job.id}`, {
      batchId,
      userId,
      emailCount: emails.length,
    });

    // Update batch job status
    await BatchJob.findOneAndUpdate(
      { batchId },
      {
        status: "processing",
        startedAt: new Date(),
      }
    );

    // Process each email and update progress
    // This would be a loop calling the enhanced verifier

    // Update completed job
    await BatchJob.findOneAndUpdate(
      { batchId },
      {
        status: "completed",
        processedEmails: emails.length,
        validEmails: Math.floor(emails.length * 0.8), // Mock valid count
        invalidEmails: Math.ceil(emails.length * 0.2), // Mock invalid count
        completedAt: new Date(),
      }
    );

    // Send notification email if required
    const user = await User.findById(userId);
    if (user && job.data.notifyUser) {
      await sendVerificationCompletedEmail(user.email, batchId, emails.length);
    }

    done(null, { success: true, processed: emails.length });
  } catch (error) {
    logger.error(`Error processing bulk verification job ${job.id}`, {
      error: error.message,
      stack: error.stack,
      batchId: job.data.batchId,
    });

    // Update batch job status to failed
    try {
      await BatchJob.findOneAndUpdate(
        { batchId: job.data.batchId },
        {
          status: "failed",
          error: error.message,
        }
      );
    } catch (updateError) {
      logger.error("Error updating batch job status", {
        error: updateError.message,
      });
    }

    done(error);
  }
}

// Set up event listeners for queues
function setupQueueEvents(queue, queueName) {
  queue.on("completed", (job, result) => {
    logger.info(`${queueName} job ${job.id} completed`, {
      result: result,
      jobData: job.data,
    });
  });

  queue.on("failed", (job, error) => {
    logger.error(`${queueName} job ${job.id} failed`, {
      error: error.message,
      jobData: job.data,
    });
  });

  queue.on("stalled", (job) => {
    logger.warn(`${queueName} job ${job.id} stalled`, {
      jobData: job.data,
    });
  });

  queue.on("error", (error) => {
    logger.error(`${queueName} queue error`, {
      error: error.message,
    });
  });
}

// Handle graceful shutdown
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

async function gracefulShutdown() {
  logger.info("Worker shutting down...");
  await Promise.all([verificationQueue.close(), bulkVerificationQueue.close()]);
  mongoose.disconnect();
  logger.info("Worker shutdown complete");
  process.exit(0);
}
