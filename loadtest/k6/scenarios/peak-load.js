// Peak Load: 500 VUs, 15 min - simulates MAU 10M peak hour (~300 RPS)
// MAU 10M / 30 days = 333K DAU, peak hour = 278 RPS, burst = 500 RPS
import http from 'k6/http';
import { sleep } from 'k6';
import { ENDPOINTS } from '../lib/endpoints.js';
import { checkResponse, randomUserId, randomProductId, SLA_THRESHOLDS } from '../lib/helpers.js';

export const options = {
  stages: [
    { duration: '2m', target: 100 },
    { duration: '3m', target: 300 },
    { duration: '5m', target: 500 },
    { duration: '3m', target: 500 },
    { duration: '2m', target: 0 },
  ],
  thresholds: {
    ...SLA_THRESHOLDS,
    http_req_duration: ['p(95)<800', 'p(99)<2000'],
  },
};

export default function () {
  const userId = randomUserId();
  const productId = randomProductId();
  const rand = Math.random();

  if (rand < 0.5) {
    // 50% product browsing
    const res = http.get(ENDPOINTS.PRODUCTS_LIST);
    checkResponse(res, 'GET products');
  } else if (rand < 0.7) {
    // 20% product detail
    const res = http.get(ENDPOINTS.PRODUCT_BY_ID(productId));
    checkResponse(res, 'GET product detail');
  } else if (rand < 0.85) {
    // 15% cart
    const cartPayload = JSON.stringify({
      userId, productId,
      quantity: Math.floor(Math.random() * 3) + 1,
    });
    http.post(ENDPOINTS.CART_ADD, cartPayload, {
      headers: { 'Content-Type': 'application/json' },
    });
  } else {
    // 15% order (write, triggers async processing)
    const orderPayload = JSON.stringify({
      userId, productId,
      quantity: 1,
      totalPrice: (Math.random() * 200 + 5).toFixed(2),
    });
    const res = http.post(ENDPOINTS.ORDERS_CREATE, orderPayload, {
      headers: { 'Content-Type': 'application/json' },
    });
    checkResponse(res, 'POST order');
  }

  sleep(Math.random() * 0.5 + 0.1);
}
