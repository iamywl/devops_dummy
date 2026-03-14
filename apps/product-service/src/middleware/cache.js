/**
 * Redis caching middleware.
 *
 * @param {import("ioredis").Redis} redis  – ioredis client instance
 * @param {number}                  ttl    – cache TTL in seconds (default 60)
 * @returns {Function} Express middleware
 */
function cacheMiddleware(redis, ttl = 60) {
  return async (req, res, next) => {
    // Only cache GET requests
    if (req.method !== "GET") return next();

    const key = `cache:${req.originalUrl}`;

    try {
      const cached = await redis.get(key);
      if (cached) {
        return res.json(JSON.parse(cached));
      }
    } catch (err) {
      // If Redis is down, skip cache and continue to DB
      console.error("Cache read error:", err.message);
      return next();
    }

    // Intercept res.json to store the response in cache
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      // Store in cache asynchronously – don't block the response
      redis.set(key, JSON.stringify(body), "EX", ttl).catch((err) => {
        console.error("Cache write error:", err.message);
      });
      return originalJson(body);
    };

    next();
  };
}

/**
 * Invalidate cache entries that match a given prefix.
 *
 * @param {import("ioredis").Redis} redis
 * @param {string}                  prefix – e.g. "cache:/api/products"
 */
async function invalidateCache(redis, prefix) {
  try {
    const stream = redis.scanStream({ match: `${prefix}*`, count: 100 });
    const pipeline = redis.pipeline();
    for await (const keys of stream) {
      keys.forEach((key) => pipeline.del(key));
    }
    await pipeline.exec();
  } catch (err) {
    console.error("Cache invalidation error:", err.message);
  }
}

module.exports = { cacheMiddleware, invalidateCache };
