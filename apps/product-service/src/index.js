require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const Redis = require("ioredis");
const promClient = require("prom-client");
const createProductsRouter = require("./routes/products");
const Product = require("./models/Product");

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
// Seed data
// ---------------------------------------------------------------------------
const SAMPLE_PRODUCTS = [
  { name: "MacBook Pro M4", description: "Apple laptop with M4 chip, 16GB RAM, 512GB SSD", price: 1999, category: "computers", stock: 75, imageUrl: "", ratings: { average: 4.8, count: 342 } },
  { name: "iPhone 16 Pro", description: "Latest iPhone with A18 Pro chip and titanium design", price: 1199, category: "electronics", stock: 150, imageUrl: "", ratings: { average: 4.7, count: 891 } },
  { name: "Sony WH-1000XM5", description: "Premium noise-cancelling wireless headphones", price: 349, category: "audio", stock: 200, imageUrl: "", ratings: { average: 4.6, count: 1253 } },
  { name: "Samsung Galaxy S24", description: "Samsung flagship smartphone with Galaxy AI features", price: 899, category: "electronics", stock: 120, imageUrl: "", ratings: { average: 4.5, count: 567 } },
  { name: "iPad Air", description: "Lightweight tablet with M2 chip and 10.9-inch display", price: 599, category: "tablets", stock: 100, imageUrl: "", ratings: { average: 4.7, count: 430 } },
  { name: "AirPods Pro", description: "Active noise cancellation earbuds with adaptive audio", price: 249, category: "accessories", stock: 180, imageUrl: "", ratings: { average: 4.5, count: 2104 } },
  { name: "Dell XPS 15", description: "15-inch ultrabook with InfinityEdge display", price: 1499, category: "computers", stock: 60, imageUrl: "", ratings: { average: 4.4, count: 289 } },
  { name: "Nike Air Max", description: "Classic running shoes with visible Air cushioning", price: 159, category: "shoes", stock: 200, imageUrl: "", ratings: { average: 4.3, count: 1870 } },
  { name: "Lego Star Wars", description: "Millennium Falcon building set with 1351 pieces", price: 169, category: "toys", stock: 90, imageUrl: "", ratings: { average: 4.9, count: 743 } },
  { name: "Dyson V15", description: "Cordless vacuum cleaner with laser dust detection", price: 749, category: "home", stock: 50, imageUrl: "", ratings: { average: 4.6, count: 512 } },
];

async function seedProducts() {
  const count = await Product.countDocuments();
  if (count > 0) return;

  await Product.insertMany(SAMPLE_PRODUCTS);
  console.log(`Seeded ${SAMPLE_PRODUCTS.length} sample products`);
}

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

  await seedProducts();

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
