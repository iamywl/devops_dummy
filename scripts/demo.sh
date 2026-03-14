#!/usr/bin/env bash
# Full demo: build → deploy → verify → loadtest
source "$(dirname "$0")/lib/common.sh"

CLUSTER="${1:-dev}"

log_step "╔══════════════════════════════════════════════╗"
log_step "║  DevOps E-Commerce Platform - Full Demo      ║"
log_step "║  Target: MAU 10M Architecture                ║"
log_step "╚══════════════════════════════════════════════╝"
echo ""

# Step 1: Build images
log_step "Step 1/4: Building Docker images..."
bash "${PROJECT_ROOT}/scripts/build-images.sh"
echo ""

# Step 2: Deploy
log_step "Step 2/4: Deploying to ${CLUSTER}..."
bash "${PROJECT_ROOT}/scripts/deploy.sh" "$CLUSTER"
echo ""

# Step 3: Verify
log_step "Step 3/4: Verifying deployment..."
bash "${PROJECT_ROOT}/scripts/verify.sh" "$CLUSTER"
echo ""

# Step 4: Smoke test
log_step "Step 4/4: Running smoke test..."
bash "${PROJECT_ROOT}/scripts/run-loadtest.sh" smoke "$CLUSTER"
echo ""

log_step "╔══════════════════════════════════════════════╗"
log_step "║  Demo Complete!                               ║"
log_step "╚══════════════════════════════════════════════╝"

MASTER_IP=$(tart ip "${CLUSTER}-master" 2>/dev/null || echo "localhost")
echo ""
log_info "Access the platform:"
echo "  Frontend:    http://${MASTER_IP}:30080"
echo "  RabbitMQ UI: http://${MASTER_IP}:31672"
echo ""
log_info "Next steps:"
echo "  Run peak-load test:   ./scripts/run-loadtest.sh peak-load ${CLUSTER}"
echo "  Run stress test:      ./scripts/run-loadtest.sh stress-test ${CLUSTER}"
echo "  Deploy to prod:       ./scripts/deploy.sh prod"
