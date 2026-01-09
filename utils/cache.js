// utils/cache.js
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
        logger.error("Redis cache connection retries exhausted");
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
    logger.info("Redis cache connection established");
  } catch (err) {
    logger.error("Redis cache connection error", {
      error: err.message,
    });
  }
})();

// Handle Redis errors
redisClient.on("error", (err) => {
  logger.error("Redis client error", { error: err.message });
});

// Handle Redis ready state
redisClient.on("ready", () => {
  logger.info("Redis client ready");
});

// Handle Redis reconnecting state
redisClient.on("reconnecting", () => {
  logger.info("Redis client reconnecting");
});

// Handle Redis end state
redisClient.on("end", () => {
  logger.info("Redis client connection ended");
});

/**
 * Cache middleware for API responses
 * @param {number} duration - Cache duration in seconds
 */
const cacheMiddleware = (duration) => {
  return async (req, res, next) => {
    if (!redisClient.isReady) {
      logger.warn("Redis client not ready, skipping cache");
      return next();
    }

    try {
      const key = `cache:${req.originalUrl || req.url}`;
      const cachedResponse = await redisClient.get(key);

      if (cachedResponse) {
        return res.json(JSON.parse(cachedResponse));
      }

      // Store the original send function
      const originalSend = res.json;

      // Override res.json method
      res.json = function (body) {
        // Restore original send
        res.json = originalSend;

        // Cache the response
        redisClient.setEx(key, duration, JSON.stringify(body));

        // Send the response
        return originalSend.call(this, body);
      };

      next();
    } catch (err) {
      logger.error("Cache middleware error", { error: err.message });
      next();
    }
  };
};

/**
 * Cache verification result
 * @param {string} email - Email address
 * @param {object} result - Verification result
 * @param {number} duration - Cache duration in seconds
 */
async function cacheVerificationResult(email, result, duration = 86400) {
  if (!redisClient.isReady) {
    logger.warn("Redis client not ready, skipping cache");
    return;
  }

  try {
    const key = `verify:${email.toLowerCase()}`;
    await redisClient.setEx(key, duration, JSON.stringify(result));
  } catch (err) {
    logger.error("Cache set error", { error: err.message });
  }
}

/**
 * Get cached verification result
 * @param {string} email - Email address
 * @returns {object|null} Cached result or null
 */
async function getCachedVerificationResult(email) {
  if (!redisClient.isReady) {
    logger.warn("Redis client not ready, skipping cache");
    return null;
  }

  try {
    const key = `verify:${email.toLowerCase()}`;
    const cached = await redisClient.get(key);
    return cached ? JSON.parse(cached) : null;
  } catch (err) {
    logger.error("Cache get error", { error: err.message });
    return null;
  }
}

/**
 * Cache MX records for a domain
 * @param {string} domain - Domain to cache MX records for
 * @param {Array} records - MX records to cache
 * @param {number} duration - Cache duration in seconds
 */
async function cacheMxRecords(domain, records, duration = 86400) {
  if (!redisClient.isReady) {
    logger.warn("Redis client not ready, skipping cache");
    return;
  }

  try {
    const key = `mx:${domain.toLowerCase()}`;
    await redisClient.setEx(key, duration, JSON.stringify(records));
  } catch (err) {
    logger.error("Cache set error", { error: err.message });
  }
}

/**
 * Get cached MX records for a domain
 * @param {string} domain - Domain to get MX records for
 * @returns {Array|null} MX records or null
 */
async function getCachedMxRecords(domain) {
  if (!redisClient.isReady) {
    logger.warn("Redis client not ready, skipping cache");
    return null;
  }

  try {
    const key = `mx:${domain.toLowerCase()}`;
    const cached = await redisClient.get(key);
    return cached ? JSON.parse(cached) : null;
  } catch (err) {
    logger.error("Cache get error", { error: err.message });
    return null;
  }
}

/**
 * Check if Redis is connected
 * @returns {boolean} Connection status
 */
function isConnected() {
  return redisClient.isReady;
}

/**
 * Get cached user usage
 * @param {string} userId - User ID
 * @returns {object|null} Cached usage or null
 */
async function getCachedUserUsage(userId) {
  if (!redisClient.isReady) {
    logger.warn("Redis client not ready, skipping cache");
    return null;
  }

  try {
    const key = `usage:${userId}`;
    const cached = await redisClient.get(key);
    return cached ? JSON.parse(cached) : null;
  } catch (err) {
    logger.error("Cache get error", { error: err.message });
    return null;
  }
}

/**
 * Cache user usage
 * @param {string} userId - User ID
 * @param {object} usage - Usage data
 * @param {number} duration - Cache duration in seconds
 */
async function cacheUserUsage(userId, usage, duration = 3600) {
  if (!redisClient.isReady) {
    logger.warn("Redis client not ready, skipping cache");
    return;
  }

  try {
    const key = `usage:${userId}`;
    await redisClient.setEx(key, duration, JSON.stringify(usage));
  } catch (err) {
    logger.error("Cache set error", { error: err.message });
  }
}

module.exports = {
  cacheMiddleware,
  getCachedMxRecords,
  cacheMxRecords,
  getCachedVerificationResult,
  cacheVerificationResult,
  getCachedUserUsage,
  cacheUserUsage,
  isConnected,
};
