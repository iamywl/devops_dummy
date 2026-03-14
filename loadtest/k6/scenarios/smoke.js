// Smoke Test: 10 VUs, 1 minute - validates all endpoints work
import http from 'k6/http';
import { sleep } from 'k6';
import { ENDPOINTS } from '../lib/endpoints.js';
import { checkResponse, SLA_THRESHOLDS } from '../lib/helpers.js';

export const options = {
  vus: 10,
  duration: '1m',
  thresholds: SLA_THRESHOLDS,
};

export default function () {
  // GET products (read-heavy, cached)
  let res = http.get(ENDPOINTS.PRODUCTS_LIST);
  checkResponse(res, 'GET products');
  sleep(1);

  // POST order
  const orderPayload = JSON.stringify({
    userId: `user-${__VU}`,
    productId: `prod-1`,
    quantity: 1,
    totalPrice: 29.99,
  });
  res = http.post(ENDPOINTS.ORDERS_CREATE, orderPayload, {
    headers: { 'Content-Type': 'application/json' },
  });
  checkResponse(res, 'POST order');
  sleep(1);

  // GET cart
  res = http.get(ENDPOINTS.CART_GET(`user-${__VU}`));
  checkResponse(res, 'GET cart');
  sleep(1);

  // POST cart item
  const cartPayload = JSON.stringify({
    userId: `user-${__VU}`,
    productId: 'prod-1',
    quantity: 2,
  });
  res = http.post(ENDPOINTS.CART_ADD, cartPayload, {
    headers: { 'Content-Type': 'application/json' },
  });
  checkResponse(res, 'POST cart');
  sleep(1);

  // Health check
  res = http.get(ENDPOINTS.HEALTH);
  checkResponse(res, 'health');
  sleep(0.5);
}
