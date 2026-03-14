#!/usr/bin/env bash
# Verify all services are running across clusters
source "$(dirname "$0")/lib/common.sh"

CLUSTER="${1:-all}"
TARGETS=()

if [[ "$CLUSTER" == "all" ]]; then
  TARGETS=("${CLUSTERS[@]}")
else
  TARGETS=("$CLUSTER")
fi

OVERALL_STATUS=0

for cluster in "${TARGETS[@]}"; do
  echo ""
  log_step "═══ Verifying ${cluster} cluster ═══"

  # Check pods
  log_info "Pod status:"
  kubectl_cmd "$cluster" get pods -n ecommerce -o wide 2>/dev/null || {
    log_error "Cannot connect to ${cluster} cluster"
    OVERALL_STATUS=1
    continue
  }

  # Check services
  log_info "Services:"
  kubectl_cmd "$cluster" get svc -n ecommerce 2>/dev/null

  # Check endpoints health
  MASTER_IP=$(tart ip "${cluster}-master" 2>/dev/null || echo "")
  if [[ -n "$MASTER_IP" ]]; then
    log_info "Testing endpoints via ${MASTER_IP}:30080..."
    for endpoint in "/healthz" "/api/products" "/api/orders/health"; do
      HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "http://${MASTER_IP}:30080${endpoint}" 2>/dev/null || echo "000")
      if [[ "$HTTP_CODE" =~ ^2 ]]; then
        echo -e "  ${GREEN}✓${NC} ${endpoint} → ${HTTP_CODE}"
      else
        echo -e "  ${RED}✗${NC} ${endpoint} → ${HTTP_CODE}"
        OVERALL_STATUS=1
      fi
    done
  fi

  # HPA status (prod only)
  if [[ "$cluster" == "prod" ]]; then
    log_info "HPA status:"
    kubectl_cmd "$cluster" get hpa -n ecommerce 2>/dev/null || true
  fi
done

echo ""
if [[ $OVERALL_STATUS -eq 0 ]]; then
  log_step "All verifications passed!"
else
  log_warn "Some verifications failed. Check details above."
fi

exit $OVERALL_STATUS
