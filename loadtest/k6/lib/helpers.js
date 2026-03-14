import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// Custom metrics
export const errorRate = new Rate('errors');
export const orderLatency = new Trend('order_latency', true);
export const productLatency = new Trend('product_latency', true);
export const cartLatency = new Trend('cart_latency', true);

// SLA thresholds for MAU 10M service
export const SLA_THRESHOLDS = {
  http_req_duration: ['p(95)<500', 'p(99)<1000'],
  http_req_failed: ['rate<0.01'],
  errors: ['rate<0.01'],
};

export function checkResponse(res, name) {
  const result = check(res, {
    [`${name} status 2xx`]: (r) => r.status >= 200 && r.status < 300,
    [`${name} response time < 1s`]: (r) => r.timings.duration < 1000,
  });
  errorRate.add(!result);
  return result;
}

export function randomUserId() {
  return `user-${Math.floor(Math.random() * 10000)}`;
}

export function randomProductId() {
  return `prod-${Math.floor(Math.random() * 100)}`;
}
