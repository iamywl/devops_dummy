#!/usr/bin/env bash
# Deploy to a specific cluster using Kustomize
source "$(dirname "$0")/lib/common.sh"

CLUSTER="${1:-dev}"

if [[ ! " ${CLUSTERS[*]} " =~ " ${CLUSTER} " ]]; then
  log_error "Invalid cluster: $CLUSTER (valid: ${CLUSTERS[*]})"
  exit 1
fi

log_step "Deploying to ${CLUSTER} cluster..."

# Apply Kustomize overlay
OVERLAY_DIR="${PROJECT_ROOT}/manifests/overlays/${CLUSTER}"
if [[ ! -d "$OVERLAY_DIR" ]]; then
  log_error "Overlay not found: $OVERLAY_DIR"
  exit 1
fi

log_info "Applying Kustomize overlay: ${CLUSTER}"
kubectl_cmd "$CLUSTER" apply -k "$OVERLAY_DIR"

# Apply Istio configs for dev
if [[ "$CLUSTER" == "dev" ]]; then
  log_info "Applying Istio configs..."
  kubectl_cmd "$CLUSTER" apply -f "${PROJECT_ROOT}/manifests/istio/" -n ecommerce 2>/dev/null || \
    log_warn "Istio CRDs not available, skipping"
fi

# Apply monitoring if platform cluster is accessible
log_info "Applying ServiceMonitors..."
kubectl_cmd "$CLUSTER" apply -f "${PROJECT_ROOT}/monitoring/service-monitors/" 2>/dev/null || \
  log_warn "ServiceMonitor CRDs not available, skipping"

# Wait for pods
wait_for_pods "$CLUSTER"

log_step "Deployment to ${CLUSTER} complete!"
