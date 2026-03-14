#!/usr/bin/env bash
# Deploy to all clusters
source "$(dirname "$0")/lib/common.sh"

log_step "Deploying to all clusters..."

for cluster in "${CLUSTERS[@]}"; do
  log_step "═══ Deploying to ${cluster} ═══"
  bash "${PROJECT_ROOT}/scripts/deploy.sh" "$cluster" || {
    log_error "Deployment failed for ${cluster}"
    exit 1
  }
  echo ""
done

log_step "All deployments complete!"
