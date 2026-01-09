// utils/ipRotation.js
const axios = require("axios");
const { createClient } = require("redis");
const { logger } = require("./monitoring");

// Initialize Redis client with Redis v4+ syntax
const redisClient = createClient({
  url: `redis://${
    process.env.REDIS_PASSWORD ? `:${process.env.REDIS_PASSWORD}@` : ""
  }${process.env.REDIS_HOST || "localhost"}:${process.env.REDIS_PORT || 6379}/${
    process.env.REDIS_DB || "0"
  }`,
  socket: {
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        logger.error("Redis IP rotation connection retries exhausted");
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
    logger.info("Redis connection for IP rotation established");
  } catch (err) {
    logger.error("Redis connection error for IP rotation", {
      error: err.message,
    });
  }
})();

// IP Pool Configuration
// In production, this would be managed by a proxy service or cloud provider
const ipPool = process.env.IP_POOL
  ? process.env.IP_POOL.split(",")
  : ["default"];

// Rate limits per domain to avoid being blocked
// These should be adjusted based on observed limits from major email providers
const domainRateLimits = {
  "gmail.com": { maxPerMinute: 20, maxPerHour: 250 },
  "yahoo.com": { maxPerMinute: 10, maxPerHour: 150 },
  "hotmail.com": { maxPerMinute: 15, maxPerHour: 200 },
  "outlook.com": { maxPerMinute: 15, maxPerHour: 200 },
  "aol.com": { maxPerMinute: 10, maxPerHour: 150 },
  default: { maxPerMinute: 30, maxPerHour: 300 },
};

/**
 * Get the next available IP for SMTP connections
 * @param {string} domain - Email domain being verified
 * @returns {string} IP address to use
 */
async function getNextIp(domain) {
  try {
    // Get domain limit configuration
    const domainKey = domain.toLowerCase();
    const limitConfig =
      domainRateLimits[domainKey] || domainRateLimits["default"];

    // Check if we're hitting rate limits for this domain
    const minuteKey = `smtp:${domainKey}:minute`;
    const hourKey = `smtp:${domainKey}:hour`;

    // Get current counters
    const minuteCount = (await redisClient.get(minuteKey)) || 0;
    const hourCount = (await redisClient.get(hourKey)) || 0;

    if (parseInt(minuteCount) >= limitConfig.maxPerMinute) {
      console.warn(`Rate limit reached for ${domain} (per minute)`);
      throw new Error(`RATE_LIMIT_MINUTE:${domain}`);
    }

    if (parseInt(hourCount) >= limitConfig.maxPerHour) {
      console.warn(`Rate limit reached for ${domain} (per hour)`);
      throw new Error(`RATE_LIMIT_HOUR:${domain}`);
    }

    // Increment counters
    await redisClient.incr(minuteKey);
    await redisClient.incr(hourKey);

    // Set expiration if not already set
    await redisClient.expire(minuteKey, 60); // 1 minute
    await redisClient.expire(hourKey, 3600); // 1 hour

    // Get optimal IP based on current usage
    // In a real implementation, we'd track usage per IP
    // For simplicity, we'll use round-robin here
    const currentIndex = (await redisClient.get("smtp:ip_index")) || 0;
    const nextIndex = (parseInt(currentIndex) + 1) % ipPool.length;
    await redisClient.set("smtp:ip_index", nextIndex);

    return ipPool[parseInt(currentIndex)];
  } catch (error) {
    if (error.message.startsWith("RATE_LIMIT")) {
      throw error; // Re-throw rate limit errors for proper handling
    }
    console.error("Error in IP rotation:", error);
    return ipPool[0]; // Default to first IP in case of error
  }
}

/**
 * Check if we should delay SMTP verification for a domain
 * @param {string} domain - Email domain to check
 * @returns {number} Milliseconds to delay or 0 if no delay needed
 */
async function getSmtpDelay(domain) {
  try {
    const domainKey = domain.toLowerCase();
    const limitConfig =
      domainRateLimits[domainKey] || domainRateLimits["default"];

    // Get current minute count
    const minuteKey = `smtp:${domainKey}:minute`;
    const minuteCount = (await redisClient.get(minuteKey)) || 0;

    // Calculate a progressive delay based on how close we are to limit
    const usageRatio = parseInt(minuteCount) / limitConfig.maxPerMinute;

    if (usageRatio > 0.8) {
      // We're approaching the limit, add a delay
      return Math.floor((usageRatio - 0.8) * 10 * 1000); // Up to 2000ms delay
    }

    return 0; // No delay needed
  } catch (error) {
    console.error("Error calculating SMTP delay:", error);
    return 100; // Default small delay on error
  }
}

/**
 * Mark a domain as blocked (e.g., if we get too many connection errors)
 * @param {string} domain - Domain to mark as blocked
 * @param {number} duration - Seconds to block for
 */
async function markDomainAsBlocked(domain, duration = 300) {
  try {
    const key = `smtp:blocked:${domain.toLowerCase()}`;
    await redisClient.set(key, "blocked");
    await redisClient.expire(key, duration);
    console.warn(`Domain ${domain} marked as blocked for ${duration} seconds`);
  } catch (error) {
    console.error("Error marking domain as blocked:", error);
  }
}

/**
 * Check if a domain is currently blocked
 * @param {string} domain - Domain to check
 * @returns {boolean} True if domain is blocked
 */
async function isDomainBlocked(domain) {
  try {
    if (!redisClient.isReady) {
      logger.warn("Redis client not ready, assuming domain is not blocked");
      return false;
    }

    const key = `smtp:blocked:${domain.toLowerCase()}`;
    const value = await redisClient.get(key);
    return value === "blocked";
  } catch (error) {
    logger.error("Error checking if domain is blocked:", {
      error: error.message,
      domain,
    });
    return false;
  }
}

/**
 * Report a successful verification for monitoring
 * @param {string} domain - Domain that was verified
 */
async function reportSuccessfulVerification(domain) {
  try {
    const key = `smtp:success:${domain.toLowerCase()}:${Math.floor(
      Date.now() / 3600000
    )}`; // Hourly key
    await redisClient.incr(key);
    await redisClient.expire(key, 86400); // Keep for 24 hours
  } catch (error) {
    console.error("Error reporting successful verification:", error);
  }
}

/**
 * Report a failed verification for monitoring
 * @param {string} domain - Domain that failed
 * @param {string} reason - Failure reason
 */
async function reportFailedVerification(domain, reason) {
  try {
    const key = `smtp:fail:${domain.toLowerCase()}:${reason}:${Math.floor(
      Date.now() / 3600000
    )}`; // Hourly key
    await redisClient.incr(key);
    await redisClient.expire(key, 86400); // Keep for 24 hours
  } catch (error) {
    console.error("Error reporting failed verification:", error);
  }
}

module.exports = {
  getNextIp,
  getSmtpDelay,
  markDomainAsBlocked,
  isDomainBlocked,
  reportSuccessfulVerification,
  reportFailedVerification,
};
