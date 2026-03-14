#!/usr/bin/env bash
# Build all application Docker images for ARM64
source "$(dirname "$0")/lib/common.sh"

log_step "Building all Docker images (ARM64)..."

APPS_DIR="${PROJECT_ROOT}/apps"
IMAGES=("order-service" "product-service" "cart-service" "user-service" "review-service" "notification-worker" "frontend")

for app in "${IMAGES[@]}"; do
  log_info "Building ${app}..."
  docker build --platform linux/arm64 \
    -t "${app}:latest" \
    "${APPS_DIR}/${app}" || {
    log_error "Failed to build ${app}"
    exit 1
  }
  log_info "${app}:latest built successfully"
done

echo ""
log_step "All images built:"
for app in "${IMAGES[@]}"; do
  echo "  - ${app}:latest"
done
