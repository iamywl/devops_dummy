// Average Load: 200 VUs, 10 min - simulates typical day (~200 RPS)
import http from 'k6/http';
import { sleep } from 'k6';
import { ENDPOINTS } from '../lib/endpoints.js';
import { checkResponse, randomUserId, randomProductId, productLatency, orderLatency, cartLatency, SLA_THRESHOLDS } from '../lib/helpers.js';

export const options = {
  stages: [
    { duration: '2m', target: 50 },
    { duration: '5m', target: 200 },
    { duration: '2m', target: 200 },
    { duration: '1m', target: 0 },
  ],
  thresholds: SLA_THRESHOLDS,
};

export default function () {
  const userId = randomUserId();
  const productId = randomProductId();

  // 60% read products (most common action)
  if (Math.random() < 0.6) {
    const res = http.get(ENDPOINTS.PRODUCTS_LIST);
    checkResponse(res, 'GET products');
    productLatency.add(res.timings.duration);
    sleep(0.5);
    return;
  }

  // 20% cart operations
  if (Math.random() < 0.5) {
    const cartPayload = JSON.stringify({
      userId: userId,
      productId: productId,
      quantity: Math.floor(Math.random() * 5) + 1,
    });
    const res = http.post(ENDPOINTS.CART_ADD, cartPayload, {
      headers: { 'Content-Type': 'application/json' },
    });
    checkResponse(res, 'POST cart');
    cartLatency.add(res.timings.duration);
    sleep(0.3);
    return;
  }

  // 20% create order (write path, triggers RabbitMQ)
  const orderPayload = JSON.stringify({
    userId: userId,
    productId: productId,
    quantity: 1,
    totalPrice: (Math.random() * 100 + 10).toFixed(2),
  });
  const res = http.post(ENDPOINTS.ORDERS_CREATE, orderPayload, {
    headers: { 'Content-Type': 'application/json' },
  });
  checkResponse(res, 'POST order');
  orderLatency.add(res.timings.duration);
  sleep(0.5);
}
