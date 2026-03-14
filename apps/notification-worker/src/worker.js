require("dotenv").config();
const amqplib = require("amqplib");
const http = require("http");
const crypto = require("crypto");
const Redis = require("ioredis");
const { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } = require("prom-client");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://guest:guest@rabbitmq:5672";
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const EXCHANGE_NAME = process.env.EXCHANGE_NAME || "order.exchange";
const METRICS_PORT = parseInt(process.env.METRICS_PORT, 10) || 3001;
const PREFETCH = parseInt(process.env.PREFETCH, 10) || 10;

const QUEUES = ["order.created", "order.shipped", "order.cancelled"];
const MAX_NOTIFICATIONS_PER_USER = 100;

const MAX_RETRY_DELAY_MS = 30_000;
const INITIAL_RETRY_DELAY_MS = 1_000;

// ---------------------------------------------------------------------------
// Redis client
// ---------------------------------------------------------------------------
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 500, 5000);
    return delay;
  },
});

redis.on("connect", () => console.log("[REDIS] Connected"));
redis.on("error", (err) => console.error("[REDIS] Error:", err.message));

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

const notificationSentTotal = new Counter({
  name: "notification_sent_total",
  help: "Total notifications sent by type and channel",
  labelNames: ["type", "channel"],
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

const notificationQueueDepth = new Gauge({
  name: "notification_queue_depth",
  help: "Current depth of notification queues",
  labelNames: ["queue"],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Notification channel simulation
// ---------------------------------------------------------------------------
function simulateEmailNotification(order, notificationType) {
  const delay = Math.random() * 50 + 10;
  return new Promise((resolve) => {
    setTimeout(() => {
      console.log(
        `[EMAIL] ${notificationType} notification sent for order ${order.orderId || order.id || "unknown"} ` +
        `to ${order.email || order.customerEmail || "customer@example.com"}`
      );
      resolve();
    }, delay);
  });
}

function simulateSmsNotification(order, notificationType) {
  const delay = Math.random() * 30 + 5;
  return new Promise((resolve) => {
    setTimeout(() => {
      console.log(
        `[SMS]   ${notificationType} notification sent for order ${order.orderId || order.id || "unknown"} ` +
        `to ${order.phone || order.customerPhone || "+1-555-0100"}`
      );
      resolve();
    }, delay);
  });
}

function simulatePushNotification(order, notificationType) {
  const delay = Math.random() * 20 + 5;
  return new Promise((resolve) => {
    setTimeout(() => {
      console.log(
        `[PUSH]  ${notificationType} notification sent for order ${order.orderId || order.id || "unknown"} ` +
        `to user ${order.userId || order.customerId || "unknown"}`
      );
      resolve();
    }, delay);
  });
}

// ---------------------------------------------------------------------------
// Notification messages by event type
// ---------------------------------------------------------------------------
function buildNotificationMessage(queue, order) {
  const orderId = order.orderId || order.id || "unknown";
  switch (queue) {
    case "order.created":
      return `Your order ${orderId} has been confirmed. Thank you for your purchase!`;
    case "order.shipped":
      return `Your order ${orderId} has been shipped and is on its way.`;
    case "order.cancelled":
      return `Your order ${orderId} has been cancelled. If this was a mistake, please contact support.`;
    default:
      return `Update for order ${orderId}.`;
  }
}

function queueToType(queue) {
  switch (queue) {
    case "order.created": return "order_created";
    case "order.shipped": return "order_shipped";
    case "order.cancelled": return "order_cancelled";
    default: return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Notification history in Redis
// ---------------------------------------------------------------------------
async function storeNotification(userId, notification) {
  const key = `notifications:${userId}`;
  await redis.lpush(key, JSON.stringify(notification));
  await redis.ltrim(key, 0, MAX_NOTIFICATIONS_PER_USER - 1);
}

async function getNotificationHistory(userId) {
  const key = `notifications:${userId}`;
  const items = await redis.lrange(key, 0, -1);
  return items.map((item) => JSON.parse(item));
}

async function getUnreadCount(userId) {
  const key = `notifications:${userId}`;
  const items = await redis.lrange(key, 0, -1);
  let count = 0;
  for (const item of items) {
    const notification = JSON.parse(item);
    if (notification.status === "unread") {
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Process a message from a specific queue
// ---------------------------------------------------------------------------
async function processMessage(queue, order) {
  const userId = order.userId || order.customerId || "anonymous";
  const orderId = order.orderId || order.id || "unknown";
  const notificationType = queueToType(queue);
  const message = buildNotificationMessage(queue, order);

  const channels = getChannelsForQueue(queue);
  const sendPromises = channels.map((ch) => {
    switch (ch) {
      case "email": return simulateEmailNotification(order, notificationType);
      case "sms":   return simulateSmsNotification(order, notificationType);
      case "push":  return simulatePushNotification(order, notificationType);
    }
  });
  await Promise.all(sendPromises);

  for (const ch of channels) {
    notificationSentTotal.inc({ type: notificationType, channel: ch });

    const record = {
      id: crypto.randomUUID(),
      type: notificationType,
      orderId,
      message,
      channel: ch,
      sentAt: new Date().toISOString(),
      status: "unread",
    };
    await storeNotification(userId, record);
  }
}

function getChannelsForQueue(queue) {
  switch (queue) {
    case "order.created":
      return ["email", "sms", "push"];
    case "order.shipped":
      return ["email", "sms", "push"];
    case "order.cancelled":
      return ["email", "push"];
    default:
      return ["email"];
  }
}

// ---------------------------------------------------------------------------
// Queue depth polling
// ---------------------------------------------------------------------------
async function pollQueueDepths() {
  if (!channel) return;
  for (const queue of QUEUES) {
    try {
      const info = await channel.checkQueue(queue);
      notificationQueueDepth.set({ queue }, info.messageCount);
    } catch (_) {
      // queue might not exist yet
    }
  }
}

// ---------------------------------------------------------------------------
// RabbitMQ consumer with exponential back-off reconnect
// ---------------------------------------------------------------------------
let connection = null;
let channel = null;
let depthInterval = null;

async function connectAndConsume() {
  let retryDelay = INITIAL_RETRY_DELAY_MS;

  while (true) {
    try {
      console.log(`[WORKER] Connecting to RabbitMQ at ${RABBITMQ_URL} ...`);
      connection = await amqplib.connect(RABBITMQ_URL);
      channel = await connection.createChannel();

      await channel.assertExchange(EXCHANGE_NAME, "topic", { durable: true });

      for (const queue of QUEUES) {
        await channel.assertQueue(queue, { durable: true });
        await channel.bindQueue(queue, EXCHANGE_NAME, queue);
        console.log(`[WORKER] Queue "${queue}" asserted and bound to "${EXCHANGE_NAME}"`);
      }

      channel.prefetch(PREFETCH);
      connectionStatus.set(1);
      retryDelay = INITIAL_RETRY_DELAY_MS;
      console.log(`[WORKER] Connected. Consuming from queues: ${QUEUES.join(", ")}`);

      connection.on("error", (err) => {
        console.error("[WORKER] RabbitMQ connection error:", err.message);
        connectionStatus.set(0);
      });
      connection.on("close", () => {
        console.warn("[WORKER] RabbitMQ connection closed. Reconnecting ...");
        connectionStatus.set(0);
        if (depthInterval) clearInterval(depthInterval);
        setTimeout(connectAndConsume, retryDelay);
      });

      for (const queue of QUEUES) {
        channel.consume(queue, async (msg) => {
          if (!msg) return;

          const end = processingDuration.startTimer();
          try {
            const order = JSON.parse(msg.content.toString());
            console.log(`[WORKER] [${queue}] Received:`, JSON.stringify(order));

            await processMessage(queue, order);

            channel.ack(msg);
            messagesConsumed.inc({ status: "success" });
          } catch (err) {
            console.error(`[WORKER] [${queue}] Failed to process message:`, err.message);
            channel.nack(msg, false, true);
            messagesConsumed.inc({ status: "error" });
          } finally {
            end();
          }
        });
      }

      depthInterval = setInterval(pollQueueDepths, 15_000);
      pollQueueDepths();

      break;
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
// HTTP server for /metrics, /health, and /api/notifications
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (req.url === "/metrics") {
    res.setHeader("Content-Type", register.contentType);
    res.end(await register.metrics());
    return;
  }

  if (req.url === "/health") {
    const healthy = channel !== null;
    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: healthy ? "ok" : "unhealthy" }));
    return;
  }

  const unreadMatch = req.url.match(/^\/api\/notifications\/([^/]+)\/unread$/);
  if (unreadMatch && req.method === "GET") {
    const userId = decodeURIComponent(unreadMatch[1]);
    try {
      const count = await getUnreadCount(userId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ userId, unreadCount: count }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  const historyMatch = req.url.match(/^\/api\/notifications\/([^/]+)$/);
  if (historyMatch && req.method === "GET") {
    const userId = decodeURIComponent(historyMatch[1]);
    try {
      const notifications = await getNotificationHistory(userId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ userId, notifications }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
async function shutdown(signal) {
  console.log(`[WORKER] Received ${signal}. Shutting down gracefully ...`);
  if (depthInterval) clearInterval(depthInterval);
  try {
    if (channel) await channel.close();
    if (connection) await connection.close();
  } catch (_) {
    // ignore errors during shutdown
  }
  try {
    await redis.quit();
  } catch (_) {
    // ignore
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
