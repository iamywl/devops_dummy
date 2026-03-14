require("dotenv").config();
const amqplib = require("amqplib");
const http = require("http");
const { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } = require("prom-client");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://guest:guest@rabbitmq:5672";
const QUEUE_NAME = process.env.QUEUE_NAME || "order.created";
const METRICS_PORT = parseInt(process.env.METRICS_PORT, 10) || 3001;
const PREFETCH = parseInt(process.env.PREFETCH, 10) || 10;

const MAX_RETRY_DELAY_MS = 30_000;
const INITIAL_RETRY_DELAY_MS = 1_000;

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------
const register = new Registry();
collectDefaultMetrics({ register });

const messagesConsumed = new Counter({
  name: "notification_messages_consumed_total",
  help: "Total messages consumed from RabbitMQ",
  labelNames: ["status"],
  registers: [register],
});

const processingDuration = new Histogram({
  name: "notification_processing_duration_seconds",
  help: "Time spent processing a single notification",
  buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [register],
});

const connectionStatus = new Gauge({
  name: "notification_rabbitmq_connected",
  help: "Whether the worker is connected to RabbitMQ (1=yes, 0=no)",
  registers: [register],
});

// ---------------------------------------------------------------------------
// Notification simulation
// ---------------------------------------------------------------------------
function simulateEmailNotification(order) {
  const delay = Math.random() * 50 + 10; // 10-60 ms
  return new Promise((resolve) => {
    setTimeout(() => {
      console.log(
        `[EMAIL] Notification sent for order ${order.orderId || order.id || "unknown"} ` +
        `to ${order.email || order.customerEmail || "customer@example.com"}`
      );
      resolve();
    }, delay);
  });
}

function simulateSmsNotification(order) {
  const delay = Math.random() * 30 + 5;
  return new Promise((resolve) => {
    setTimeout(() => {
      console.log(
        `[SMS]   Notification sent for order ${order.orderId || order.id || "unknown"} ` +
        `to ${order.phone || order.customerPhone || "+1-555-0100"}`
      );
      resolve();
    }, delay);
  });
}

// ---------------------------------------------------------------------------
// RabbitMQ consumer with exponential back-off reconnect
// ---------------------------------------------------------------------------
let connection = null;
let channel = null;

async function connectAndConsume() {
  let retryDelay = INITIAL_RETRY_DELAY_MS;

  while (true) {
    try {
      console.log(`[WORKER] Connecting to RabbitMQ at ${RABBITMQ_URL} ...`);
      connection = await amqplib.connect(RABBITMQ_URL);
      channel = await connection.createChannel();
      await channel.assertQueue(QUEUE_NAME, { durable: true });
      channel.prefetch(PREFETCH);
      connectionStatus.set(1);
      retryDelay = INITIAL_RETRY_DELAY_MS; // reset on success
      console.log(`[WORKER] Connected. Waiting for messages on queue "${QUEUE_NAME}" ...`);

      // Handle connection / channel errors for reconnect
      connection.on("error", (err) => {
        console.error("[WORKER] RabbitMQ connection error:", err.message);
        connectionStatus.set(0);
      });
      connection.on("close", () => {
        console.warn("[WORKER] RabbitMQ connection closed. Reconnecting ...");
        connectionStatus.set(0);
        setTimeout(connectAndConsume, retryDelay);
      });

      // Consume messages
      channel.consume(QUEUE_NAME, async (msg) => {
        if (!msg) return;

        const end = processingDuration.startTimer();
        try {
          const order = JSON.parse(msg.content.toString());
          console.log(`[WORKER] Received order event:`, JSON.stringify(order));

          await Promise.all([
            simulateEmailNotification(order),
            simulateSmsNotification(order),
          ]);

          channel.ack(msg);
          messagesConsumed.inc({ status: "success" });
        } catch (err) {
          console.error("[WORKER] Failed to process message:", err.message);
          // Negative-ack and requeue
          channel.nack(msg, false, true);
          messagesConsumed.inc({ status: "error" });
        } finally {
          end();
        }
      });

      break; // exit retry loop once consuming
    } catch (err) {
      connectionStatus.set(0);
      console.error(
        `[WORKER] Connection failed: ${err.message}. Retrying in ${retryDelay}ms ...`
      );
      await sleep(retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// HTTP server for /metrics and /health
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (req.url === "/metrics") {
    res.setHeader("Content-Type", register.contentType);
    res.end(await register.metrics());
  } else if (req.url === "/health") {
    const healthy = connectionStatus.hashMap
      ? true
      : channel !== null;
    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: healthy ? "ok" : "unhealthy" }));
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
async function shutdown(signal) {
  console.log(`[WORKER] Received ${signal}. Shutting down gracefully ...`);
  try {
    if (channel) await channel.close();
    if (connection) await connection.close();
  } catch (_) {
    // ignore errors during shutdown
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(METRICS_PORT, () => {
  console.log(`[WORKER] Metrics & health server listening on :${METRICS_PORT}`);
  connectAndConsume();
});
