// API Endpoints for k6 load testing
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:30080';

export const ENDPOINTS = {
  // Product Service (Node.js/Express → MongoDB)
  PRODUCTS_LIST:    `${BASE_URL}/api/products`,
  PRODUCT_BY_ID:    (id) => `${BASE_URL}/api/products/${id}`,

  // Order Service (Spring Boot/Tomcat → PostgreSQL)
  ORDERS_CREATE:    `${BASE_URL}/api/orders`,
  ORDERS_LIST:      `${BASE_URL}/api/orders`,
  ORDER_BY_ID:      (id) => `${BASE_URL}/api/orders/${id}`,

  // Cart Service (Go → Redis)
  CART_ADD:          `${BASE_URL}/api/cart`,
  CART_GET:          (userId) => `${BASE_URL}/api/cart/${userId}`,
  CART_DELETE:        (userId) => `${BASE_URL}/api/cart/${userId}`,

  // User Service (Python/FastAPI → PostgreSQL)
  USERS_REGISTER:   `${BASE_URL}/api/users/register`,
  USERS_LIST:       `${BASE_URL}/api/users`,
  USER_BY_ID:       (id) => `${BASE_URL}/api/users/${id}`,

  // Review Service (Rust/Actix-web → MongoDB)
  REVIEWS_CREATE:   `${BASE_URL}/api/reviews`,
  REVIEWS_BY_PRODUCT: (productId) => `${BASE_URL}/api/reviews/${productId}`,

  // Health
  HEALTH:           `${BASE_URL}/healthz`,
};
