package main

import (
	"context"
	"encoding/json"
	"fmt"
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

var (
	rdb *redis.Client

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
)

func init() {
	prometheus.MustRegister(httpRequestsTotal)
	prometheus.MustRegister(httpRequestDuration)
}

// AddItemRequest represents the JSON body for adding an item to the cart.
type AddItemRequest struct {
	UserID    string `json:"userId"`
	ProductID string `json:"productId"`
	Quantity  int    `json:"quantity"`
}

// CartItem represents a single item in the cart.
type CartItem struct {
	ProductID string `json:"productId"`
	Quantity  int    `json:"quantity"`
}

// Response is a generic JSON response envelope.
type Response struct {
	Status  string      `json:"status"`
	Message string      `json:"message,omitempty"`
	Data    interface{} `json:"data,omitempty"`
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

func handleAddItem(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, Response{Status: "error", Message: "method not allowed"})
		return
	}

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

	if err := rdb.HIncrBy(ctx, key, req.ProductID, int64(req.Quantity)).Err(); err != nil {
		log.Printf("ERROR: redis HIncrBy failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, Response{Status: "error", Message: "failed to update cart"})
		return
	}

	writeJSON(w, http.StatusOK, Response{Status: "ok", Message: "item added to cart"})
}

func handleGetCart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, Response{Status: "error", Message: "method not allowed"})
		return
	}

	userID := strings.TrimPrefix(r.URL.Path, "/api/cart/")
	if userID == "" {
		writeJSON(w, http.StatusBadRequest, Response{Status: "error", Message: "userId is required"})
		return
	}

	ctx := r.Context()
	key := fmt.Sprintf("cart:%s", userID)

	items, err := rdb.HGetAll(ctx, key).Result()
	if err != nil {
		log.Printf("ERROR: redis HGetAll failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, Response{Status: "error", Message: "failed to retrieve cart"})
		return
	}

	cartItems := make([]CartItem, 0, len(items))
	for productID, qtyStr := range items {
		qty, _ := strconv.Atoi(qtyStr)
		cartItems = append(cartItems, CartItem{ProductID: productID, Quantity: qty})
	}

	writeJSON(w, http.StatusOK, Response{Status: "ok", Data: cartItems})
}

func handleDeleteCart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		writeJSON(w, http.StatusMethodNotAllowed, Response{Status: "error", Message: "method not allowed"})
		return
	}

	userID := strings.TrimPrefix(r.URL.Path, "/api/cart/")
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

// cartRouter dispatches /api/cart routes based on method and path.
func cartRouter(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path

	switch {
	case path == "/api/cart" && r.Method == http.MethodPost:
		handleAddItem(w, r)
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
		port = "8080"
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
