require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const Redis = require("ioredis");
const promClient = require("prom-client");
const createProductsRouter = require("./routes/products");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3001;
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/products";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const httpRequestCount = new promClient.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status"],
  registers: [register],
});

const httpRequestDuration = new promClient.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Redis client
// ---------------------------------------------------------------------------
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    if (times > 5) return null; // stop retrying
    return Math.min(times * 200, 2000);
  },
  lazyConnect: true,
});

redis.on("error", (err) => console.error("Redis error:", err.message));
redis.on("connect", () => console.log("Connected to Redis"));

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

app.use(cors());
app.use(express.json());

// Metrics middleware – track every request
app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on("finish", () => {
    const route = req.route?.path || req.path;
    const labels = { method: req.method, route, status: res.statusCode };
    httpRequestCount.inc(labels);
    end(labels);
  });
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get("/health", async (_req, res) => {
  const mongoOk = mongoose.connection.readyState === 1;
  const redisOk = redis.status === "ready";

  const status = mongoOk && redisOk ? "healthy" : "degraded";
  const code = mongoOk ? 200 : 503;

  res.status(code).json({
    status,
    uptime: process.uptime(),
    mongo: mongoOk ? "connected" : "disconnected",
    redis: redisOk ? "connected" : "disconnected",
  });
});

app.get("/metrics", async (_req, res) => {
  try {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
});

app.use("/api/products", createProductsRouter(redis));

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function start() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("Connected to MongoDB");
  } catch (err) {
    console.error("MongoDB connection failed:", err.message);
    process.exit(1);
  }

  try {
    await redis.connect();
  } catch (err) {
    console.warn("Redis connection failed – running without cache:", err.message);
  }

  app.listen(PORT, () => {
    console.log(`product-service listening on port ${PORT}`);
  });
}

// Graceful shutdown
async function shutdown(signal) {
  console.log(`\n${signal} received – shutting down`);
  await mongoose.disconnect().catch(() => {});
  redis.disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start();
