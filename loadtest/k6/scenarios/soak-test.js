// Soak Test: 200 VUs, 2 hours - detects memory leaks, connection pool exhaustion
import http from 'k6/http';
import { sleep } from 'k6';
import { ENDPOINTS } from '../lib/endpoints.js';
import { checkResponse, randomUserId, randomProductId, SLA_THRESHOLDS } from '../lib/helpers.js';

export const options = {
  stages: [
    { duration: '5m', target: 200 },
    { duration: '110m', target: 200 },
    { duration: '5m', target: 0 },
  ],
  thresholds: SLA_THRESHOLDS,
};

export default function () {
  const userId = randomUserId();
  const rand = Math.random();

  if (rand < 0.5) {
    const res = http.get(ENDPOINTS.PRODUCTS_LIST);
    checkResponse(res, 'GET products');
  } else if (rand < 0.7) {
    const res = http.get(ENDPOINTS.CART_GET(userId));
    checkResponse(res, 'GET cart');
  } else if (rand < 0.85) {
    const cartPayload = JSON.stringify({
      userId, productId: randomProductId(),
      quantity: 1,
    });
    const res = http.post(ENDPOINTS.CART_ADD, cartPayload, {
      headers: { 'Content-Type': 'application/json' },
    });
    checkResponse(res, 'POST cart');
  } else {
    const orderPayload = JSON.stringify({
      userId, productId: randomProductId(),
      quantity: 1,
      totalPrice: 35.00,
    });
    const res = http.post(ENDPOINTS.ORDERS_CREATE, orderPayload, {
      headers: { 'Content-Type': 'application/json' },
    });
    checkResponse(res, 'POST order');
  }

  sleep(Math.random() * 1 + 0.5);
}
