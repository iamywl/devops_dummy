// Stress Test: Ramp to 2000 VUs - finds breaking point, triggers HPA scaling
import http from 'k6/http';
import { sleep } from 'k6';
import { ENDPOINTS } from '../lib/endpoints.js';
import { checkResponse, randomUserId, randomProductId } from '../lib/helpers.js';

export const options = {
  stages: [
    { duration: '2m', target: 100 },
    { duration: '3m', target: 500 },
    { duration: '3m', target: 1000 },
    { duration: '5m', target: 2000 },
    { duration: '3m', target: 2000 },
    { duration: '4m', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.10'],
  },
};

export default function () {
  const userId = randomUserId();
  const rand = Math.random();

  if (rand < 0.4) {
    http.get(ENDPOINTS.PRODUCTS_LIST);
  } else if (rand < 0.6) {
    http.get(ENDPOINTS.CART_GET(userId));
  } else if (rand < 0.8) {
    const cartPayload = JSON.stringify({
      userId, productId: randomProductId(),
      quantity: 1,
    });
    http.post(ENDPOINTS.CART_ADD, cartPayload, {
      headers: { 'Content-Type': 'application/json' },
    });
  } else {
    const orderPayload = JSON.stringify({
      userId, productId: randomProductId(),
      quantity: 1,
      totalPrice: 50.00,
    });
    http.post(ENDPOINTS.ORDERS_CREATE, orderPayload, {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  sleep(Math.random() * 0.3);
}
