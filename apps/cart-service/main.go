package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/go-redis/redis/v8"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const cartTTL = 24 * time.Hour

var (
	rdb             *redis.Client
	orderServiceURL string

	httpRequestsTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "http_requests_total",
			Help: "Total number of HTTP requests",
		},
		[]string{"method", "endpoint", "status"},
	)

	httpRequestDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "http_request_duration_seconds",
			Help:    "Duration of HTTP requests in seconds",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"method", "endpoint"},
	)

	checkoutsTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "cart_checkouts_total",
			Help: "Total number of checkout operations",
		},
		[]string{"status"},
	)
)

func init() {
	prometheus.MustRegister(httpRequestsTotal)
	prometheus.MustRegister(httpRequestDuration)
	prometheus.MustRegister(checkoutsTotal)
}

type AddItemRequest struct {
	UserID    string `json:"userId"`
	ProductID string `json:"productId"`
	Quantity  int    `json:"quantity"`
}

type UpdateItemRequest struct {
	UserID    string `json:"userId"`
	ProductID string `json:"productId"`
	Quantity  int    `json:"quantity"`
}

type CartItem struct {
	ProductID string `json:"productId"`
	Quantity  int    `json:"quantity"`
	AddedAt   string `json:"addedAt"`
}

type Response struct {
	Status  string      `json:"status"`
	Message string      `json:"message,omitempty"`
	Data    interface{} `json:"data,omitempty"`
}

type CheckoutRequest struct {
	UserID string     `json:"userId"`
	Items  []CartItem `json:"items"`
}

type ItemCount struct {
	Count int `json:"count"`
}

func writeJSON(w http.ResponseWriter, statusCode int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(v)
}

func instrumentHandler(endpoint string, handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, statusCode: http.StatusOK}
		handler(rec, r)
		duration := time.Since(start).Seconds()

		httpRequestDuration.WithLabelValues(r.Method, endpoint).Observe(duration)
		httpRequestsTotal.WithLabelValues(r.Method, endpoint, strconv.Itoa(rec.statusCode)).Inc()
	}
}

type statusRecorder struct {
	http.ResponseWriter
	statusCode int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.statusCode = code
	r.ResponseWriter.WriteHeader(code)
}

func cartItemToJSON(item CartItem) string {
	data, _ := json.Marshal(item)
	return string(data)
}

func parseCartItem(field string, raw string) (CartItem, error) {
	var item CartItem
	if err := json.Unmarshal([]byte(raw), &item); err != nil {
		qty, convErr := strconv.Atoi(raw)
		if convErr != nil {
			return CartItem{}, fmt.Errorf("unable to parse cart item: %v", err)
		}
		item = CartItem{
			ProductID: field,
			Quantity:  qty,
			AddedAt:   time.Now().UTC().Format(time.RFC3339),
		}
	}
	return item, nil
}

func setCartItem(ctx context.Context, key string, item CartItem) error {
	if err := rdb.HSet(ctx, key, item.ProductID, cartItemToJSON(item)).Err(); err != nil {
		return err
	}
	return rdb.Expire(ctx, key, cartTTL).Err()
}

func handleAddItem(w http.ResponseWriter, r *http.Request) {
	var req AddItemRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, Response{Status: "error", Message: "invalid request body"})
		return
	}

	if req.UserID == "" || req.ProductID == "" || req.Quantity <= 0 {
		writeJSON(w, http.StatusBadRequest, Response{Status: "error", Message: "userId, productId, and a positive quantity are required"})
		return
	}

	ctx := r.Context()
	key := fmt.Sprintf("cart:%s", req.UserID)

	existing, err := rdb.HGet(ctx, key, req.ProductID).Result()
	var item CartItem
	if err == redis.Nil || existing == "" {
		item = CartItem{
			ProductID: req.ProductID,
			Quantity:  req.Quantity,
			AddedAt:   time.Now().UTC().Format(time.RFC3339),
		}
	} else if err != nil {
		log.Printf("ERROR: redis HGet failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, Response{Status: "error", Message: "failed to update cart"})
		return
	} else {
		item, _ = parseCartItem(req.ProductID, existing)
		item.Quantity += req.Quantity
	}

	if err := setCartItem(ctx, key, item); err != nil {
		log.Printf("ERROR: redis HSet failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, Response{Status: "error", Message: "failed to update cart"})
		return
	}

	writeJSON(w, http.StatusOK, Response{Status: "ok", Message: "item added to cart"})
}

func handleUpdateItem(w http.ResponseWriter, r *http.Request) {
	var req UpdateItemRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, Response{Status: "error", Message: "invalid request body"})
		return
	}

	if req.UserID == "" || req.ProductID == "" {
		writeJSON(w, http.StatusBadRequest, Response{Status: "error", Message: "userId and productId are required"})
		return
	}

	if req.Quantity < 0 {
		writeJSON(w, http.StatusBadRequest, Response{Status: "error", Message: "quantity must be zero or positive"})
		return
	}

	ctx := r.Context()
	key := fmt.Sprintf("cart:%s", req.UserID)

	if req.Quantity == 0 {
		if err := rdb.HDel(ctx, key, req.ProductID).Err(); err != nil {
			log.Printf("ERROR: redis HDel failed: %v", err)
			writeJSON(w, http.StatusInternalServerError, Response{Status: "error", Message: "failed to remove item"})
			return
		}
		rdb.Expire(ctx, key, cartTTL)
		writeJSON(w, http.StatusOK, Response{Status: "ok", Message: "item removed from cart"})
		return
	}

	existing, err := rdb.HGet(ctx, key, req.ProductID).Result()
	var item CartItem
	if err == redis.Nil || existing == "" {
		item = CartItem{
			ProductID: req.ProductID,
			Quantity:  req.Quantity,
			AddedAt:   time.Now().UTC().Format(time.RFC3339),
		}
	} else if err != nil {
		log.Printf("ERROR: redis HGet failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, Response{Status: "error", Message: "failed to update cart"})
		return
	} else {
		item, _ = parseCartItem(req.ProductID, existing)
		item.Quantity = req.Quantity
	}

	if err := setCartItem(ctx, key, item); err != nil {
		log.Printf("ERROR: redis HSet failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, Response{Status: "error", Message: "failed to update cart"})
		return
	}

	writeJSON(w, http.StatusOK, Response{Status: "ok", Message: "item updated"})
}

func getCartItems(ctx context.Context, key string) ([]CartItem, error) {
	items, err := rdb.HGetAll(ctx, key).Result()
	if err != nil {
		return nil, err
	}

	cartItems := make([]CartItem, 0, len(items))
	for field, raw := range items {
		item, parseErr := parseCartItem(field, raw)
		if parseErr != nil {
			log.Printf("WARN: skipping unparseable cart item %s: %v", field, parseErr)
			continue
		}
		cartItems = append(cartItems, item)
	}
	return cartItems, nil
}

func handleGetCart(w http.ResponseWriter, r *http.Request) {
	userID := extractUserID(r.URL.Path, "/api/cart/")
	if userID == "" {
		writeJSON(w, http.StatusBadRequest, Response{Status: "error", Message: "userId is required"})
		return
	}

	ctx := r.Context()
	key := fmt.Sprintf("cart:%s", userID)

	cartItems, err := getCartItems(ctx, key)
	if err != nil {
		log.Printf("ERROR: redis HGetAll failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, Response{Status: "error", Message: "failed to retrieve cart"})
		return
	}

	writeJSON(w, http.StatusOK, Response{Status: "ok", Data: cartItems})
}

func handleDeleteCart(w http.ResponseWriter, r *http.Request) {
	userID := extractUserID(r.URL.Path, "/api/cart/")
	if userID == "" {
		writeJSON(w, http.StatusBadRequest, Response{Status: "error", Message: "userId is required"})
		return
	}

	ctx := r.Context()
	key := fmt.Sprintf("cart:%s", userID)

	if err := rdb.Del(ctx, key).Err(); err != nil {
		log.Printf("ERROR: redis Del failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, Response{Status: "error", Message: "failed to clear cart"})
		return
	}

	writeJSON(w, http.StatusOK, Response{Status: "ok", Message: "cart cleared"})
}

func handleDeleteItem(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	prefix := "/api/cart/"
	rest := strings.TrimPrefix(path, prefix)

	parts := strings.Split(rest, "/items/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		writeJSON(w, http.StatusBadRequest, Response{Status: "error", Message: "userId and productId are required"})
		return
	}

	userID := parts[0]
	productID := parts[1]
	ctx := r.Context()
	key := fmt.Sprintf("cart:%s", userID)

	if err := rdb.HDel(ctx, key, productID).Err(); err != nil {
		log.Printf("ERROR: redis HDel failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, Response{Status: "error", Message: "failed to remove item"})
		return
	}

	rdb.Expire(ctx, key, cartTTL)
	writeJSON(w, http.StatusOK, Response{Status: "ok", Message: "item removed from cart"})
}

func handleCheckout(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	prefix := "/api/cart/"
	suffix := "/checkout"
	trimmed := strings.TrimPrefix(path, prefix)
	userID := strings.TrimSuffix(trimmed, suffix)

	if userID == "" || userID == trimmed {
		writeJSON(w, http.StatusBadRequest, Response{Status: "error", Message: "userId is required"})
		return
	}

	ctx := r.Context()
	key := fmt.Sprintf("cart:%s", userID)

	cartItems, err := getCartItems(ctx, key)
	if err != nil {
		log.Printf("ERROR: redis HGetAll failed: %v", err)
		checkoutsTotal.WithLabelValues("error").Inc()
		writeJSON(w, http.StatusInternalServerError, Response{Status: "error", Message: "failed to retrieve cart"})
		return
	}

	if len(cartItems) == 0 {
		checkoutsTotal.WithLabelValues("error").Inc()
		writeJSON(w, http.StatusBadRequest, Response{Status: "error", Message: "cart is empty"})
		return
	}

	orderReq := CheckoutRequest{
		UserID: userID,
		Items:  cartItems,
	}

	body, err := json.Marshal(orderReq)
	if err != nil {
		log.Printf("ERROR: failed to marshal order request: %v", err)
		checkoutsTotal.WithLabelValues("error").Inc()
		writeJSON(w, http.StatusInternalServerError, Response{Status: "error", Message: "failed to create order"})
		return
	}

	httpClient := &http.Client{Timeout: 10 * time.Second}
	resp, err := httpClient.Post(orderServiceURL, "application/json", bytes.NewReader(body))
	if err != nil {
		log.Printf("ERROR: order-service request failed: %v", err)
		checkoutsTotal.WithLabelValues("error").Inc()
		writeJSON(w, http.StatusBadGateway, Response{Status: "error", Message: "failed to reach order service"})
		return
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Printf("ERROR: failed to read order-service response: %v", err)
		checkoutsTotal.WithLabelValues("error").Inc()
		writeJSON(w, http.StatusBadGateway, Response{Status: "error", Message: "failed to read order service response"})
		return
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("ERROR: order-service returned status %d: %s", resp.StatusCode, string(respBody))
		checkoutsTotal.WithLabelValues("error").Inc()
		writeJSON(w, resp.StatusCode, Response{Status: "error", Message: "order service returned an error"})
		return
	}

	if err := rdb.Del(ctx, key).Err(); err != nil {
		log.Printf("WARN: failed to clear cart after checkout: %v", err)
	}

	checkoutsTotal.WithLabelValues("success").Inc()

	var orderResponse interface{}
	if err := json.Unmarshal(respBody, &orderResponse); err != nil {
		orderResponse = string(respBody)
	}

	writeJSON(w, http.StatusOK, Response{Status: "ok", Message: "checkout successful", Data: orderResponse})
}

func handleGetItemCount(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	prefix := "/api/cart/"
	suffix := "/count"
	trimmed := strings.TrimPrefix(path, prefix)
	userID := strings.TrimSuffix(trimmed, suffix)

	if userID == "" || userID == trimmed {
		writeJSON(w, http.StatusBadRequest, Response{Status: "error", Message: "userId is required"})
		return
	}

	ctx := r.Context()
	key := fmt.Sprintf("cart:%s", userID)

	count, err := rdb.HLen(ctx, key).Result()
	if err != nil {
		log.Printf("ERROR: redis HLen failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, Response{Status: "error", Message: "failed to count items"})
		return
	}

	writeJSON(w, http.StatusOK, Response{Status: "ok", Data: ItemCount{Count: int(count)}})
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	status := "healthy"
	statusCode := http.StatusOK

	if err := rdb.Ping(ctx).Err(); err != nil {
		status = "unhealthy"
		statusCode = http.StatusServiceUnavailable
		log.Printf("WARN: redis ping failed: %v", err)
	}

	writeJSON(w, statusCode, Response{Status: status})
}

func extractUserID(path, prefix string) string {
	rest := strings.TrimPrefix(path, prefix)
	if idx := strings.Index(rest, "/"); idx != -1 {
		return rest[:idx]
	}
	return rest
}

func cartRouter(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path

	switch {
	case path == "/api/cart" && r.Method == http.MethodPost:
		handleAddItem(w, r)

	case path == "/api/cart/items" && r.Method == http.MethodPut:
		handleUpdateItem(w, r)

	case strings.HasSuffix(path, "/checkout") && strings.HasPrefix(path, "/api/cart/") && r.Method == http.MethodPost:
		handleCheckout(w, r)

	case strings.HasSuffix(path, "/count") && strings.HasPrefix(path, "/api/cart/") && r.Method == http.MethodGet:
		handleGetItemCount(w, r)

	case strings.Contains(path, "/items/") && strings.HasPrefix(path, "/api/cart/") && r.Method == http.MethodDelete:
		handleDeleteItem(w, r)

	case strings.HasPrefix(path, "/api/cart/") && r.Method == http.MethodGet:
		handleGetCart(w, r)

	case strings.HasPrefix(path, "/api/cart/") && r.Method == http.MethodDelete:
		handleDeleteCart(w, r)

	default:
		writeJSON(w, http.StatusNotFound, Response{Status: "error", Message: "not found"})
	}
}

func main() {
	redisHost := os.Getenv("REDIS_HOST")
	if redisHost == "" {
		redisHost = "redis"
	}

	redisPort := os.Getenv("REDIS_PORT")
	if redisPort == "" {
		redisPort = "6379"
	}

	orderServiceURL = os.Getenv("ORDER_SERVICE_URL")
	if orderServiceURL == "" {
		orderServiceURL = "http://order-service:8080/api/orders"
	}

	rdb = redis.NewClient(&redis.Options{
		Addr:         fmt.Sprintf("%s:%s", redisHost, redisPort),
		Password:     os.Getenv("REDIS_PASSWORD"),
		DB:           0,
		DialTimeout:  5 * time.Second,
		ReadTimeout:  3 * time.Second,
		WriteTimeout: 3 * time.Second,
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8081"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/cart", instrumentHandler("/api/cart", cartRouter))
	mux.HandleFunc("/api/cart/", instrumentHandler("/api/cart/{userId}", cartRouter))
	mux.HandleFunc("/health", instrumentHandler("/health", handleHealth))
	mux.Handle("/metrics", promhttp.Handler())

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		log.Printf("cart-service starting on :%s", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("FATAL: server failed: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("shutting down cart-service...")

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Fatalf("FATAL: server forced to shutdown: %v", err)
	}

	if err := rdb.Close(); err != nil {
		log.Printf("WARN: redis close error: %v", err)
	}

	log.Println("cart-service stopped")
}
