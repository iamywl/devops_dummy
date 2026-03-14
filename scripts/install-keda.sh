#!/usr/bin/env bash
# Install KEDA operator in prod cluster
source "$(dirname "$0")/lib/common.sh"

CLUSTER="${1:-prod}"

log_step "Installing KEDA in ${CLUSTER} cluster..."

helm_cmd "$CLUSTER" repo add kedacore https://kedacore.github.io/charts 2>/dev/null || true
helm_cmd "$CLUSTER" repo update

helm_cmd "$CLUSTER" upgrade --install keda kedacore/keda \
  --namespace keda-system \
  --create-namespace \
  --wait

log_step "KEDA installed in ${CLUSTER}"
kubectl_cmd "$CLUSTER" get pods -n keda-system
