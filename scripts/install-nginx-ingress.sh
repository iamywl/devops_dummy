#!/usr/bin/env bash
# Install Nginx Ingress Controller
source "$(dirname "$0")/lib/common.sh"

CLUSTER="${1:-dev}"

log_step "Installing Nginx Ingress Controller in ${CLUSTER}..."

helm_cmd "$CLUSTER" repo add ingress-nginx https://kubernetes.github.io/ingress-nginx 2>/dev/null || true
helm_cmd "$CLUSTER" repo update

helm_cmd "$CLUSTER" upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --set controller.service.type=NodePort \
  --set controller.service.nodePorts.http=30080 \
  --set controller.service.nodePorts.https=30443 \
  --wait

log_step "Nginx Ingress Controller installed in ${CLUSTER}"
