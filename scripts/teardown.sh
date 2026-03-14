#!/usr/bin/env bash
# 환경 정리 스크립트
# 사용법: ./scripts/teardown.sh [dev|staging|prod|all]
source "$(dirname "$0")/lib/common.sh"

CLUSTER="${1:-dev}"
STOP_VM="${STOP_VM:-false}"

if [[ "$CLUSTER" == "all" ]]; then
  TARGET_CLUSTERS=("dev" "staging" "prod")
else
  if [[ ! " ${CLUSTERS[*]} " =~ " ${CLUSTER} " ]]; then
    log_error "Invalid cluster: $CLUSTER (valid: dev, staging, prod, all)"
    exit 1
  fi
  TARGET_CLUSTERS=("$CLUSTER")
fi

log_step "환경 정리 시작: ${TARGET_CLUSTERS[*]}"
echo ""

for cluster in "${TARGET_CLUSTERS[@]}"; do
  log_info "${cluster} 클러스터 정리..."

  # ecommerce 네임스페이스 삭제
  kubectl_cmd "$cluster" delete namespace ecommerce --timeout=60s 2>/dev/null || \
    log_warn "  ecommerce 네임스페이스가 없거나 삭제 실패"

  # VM 중지 (선택)
  if [[ "$STOP_VM" == "true" ]]; then
    log_info "  VM 중지 중..."
    tart stop "${cluster}-master" 2>/dev/null || true
    case "$cluster" in
      dev)     tart stop dev-worker1 2>/dev/null || true ;;
      staging) tart stop staging-worker1 2>/dev/null || true ;;
      prod)    tart stop prod-worker1 prod-worker2 2>/dev/null || true ;;
    esac
  fi

  log_info "${cluster} 정리 완료"
  echo ""
done

# Docker 이미지 정리 (선택)
if [[ "${CLEAN_IMAGES:-false}" == "true" ]]; then
  log_info "Docker 이미지 정리..."
  for img in order-service product-service cart-service user-service review-service notification-worker frontend; do
    docker rmi "${img}:latest" 2>/dev/null || true
  done
  docker image prune -f 2>/dev/null || true
fi

log_step "환경 정리 완료!"
echo ""
echo "VM 중지까지 하려면: STOP_VM=true ./scripts/teardown.sh $CLUSTER"
echo "이미지까지 삭제하려면: CLEAN_IMAGES=true ./scripts/teardown.sh $CLUSTER"
