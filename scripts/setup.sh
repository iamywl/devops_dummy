#!/usr/bin/env bash
# 원클릭 전체 환경 구축 스크립트
# 사용법: ./scripts/setup.sh [dev|staging|prod|all]
#
# 이 스크립트는 다음을 자동으로 수행합니다:
#   1. Tart VM 기동 확인
#   2. Docker 이미지 빌드 (ARM64)
#   3. 이미지를 K8s 워커 노드에 로드
#   4. Nginx Ingress Controller 설치
#   5. Kustomize로 앱 배포
#   6. 서비스 검증
#   7. 접속 정보 출력
source "$(dirname "$0")/lib/common.sh"

CLUSTER="${1:-dev}"
SKIP_BUILD="${SKIP_BUILD:-false}"
SKIP_LOAD="${SKIP_LOAD:-false}"

# ─── 클러스터별 워커 노드 매핑 ───
declare -A WORKERS
WORKERS[dev]="dev-worker1"
WORKERS[staging]="staging-worker1 staging-worker2"
WORKERS[prod]="prod-worker1 prod-worker2 prod-worker3 prod-worker4"

IMAGES=("order-service" "product-service" "cart-service" "user-service" "review-service" "notification-worker" "frontend")

# ───────────────────────────────────────────────────────────
# Step 0: 유효성 검사
# ───────────────────────────────────────────────────────────
if [[ "$CLUSTER" == "all" ]]; then
  TARGET_CLUSTERS=("dev" "staging" "prod")
else
  if [[ ! " ${CLUSTERS[*]} " =~ " ${CLUSTER} " ]]; then
    log_error "Invalid cluster: $CLUSTER (valid: dev, staging, prod, all)"
    exit 1
  fi
  TARGET_CLUSTERS=("$CLUSTER")
fi

log_step "═══════════════════════════════════════════════════"
log_step "  DevOps E-Commerce Platform - 환경 구축 시작"
log_step "  대상 클러스터: ${TARGET_CLUSTERS[*]}"
log_step "═══════════════════════════════════════════════════"
echo ""

# ───────────────────────────────────────────────────────────
# Step 1: Tart VM 상태 확인
# ───────────────────────────────────────────────────────────
log_step "[1/7] Tart VM 상태 확인..."

check_vm() {
  local vm_name="$1"
  local status
  status=$(tart list 2>/dev/null | grep "$vm_name" | awk '{print $NF}')
  if [[ "$status" == "running" ]]; then
    log_info "  ✓ $vm_name: running (IP: $(tart ip "$vm_name" 2>/dev/null))"
    return 0
  elif [[ -n "$status" ]]; then
    log_warn "  ↻ $vm_name: $status → 기동 중..."
    tart start "$vm_name" &
    return 0
  else
    log_error "  ✗ $vm_name: VM이 존재하지 않습니다"
    return 1
  fi
}

for cluster in "${TARGET_CLUSTERS[@]}"; do
  master="${cluster}-master"
  check_vm "$master" || exit 1
  for worker in ${WORKERS[$cluster]}; do
    check_vm "$worker" || exit 1
  done
done

# VM 기동 대기
sleep 5
for cluster in "${TARGET_CLUSTERS[@]}"; do
  master="${cluster}-master"
  MASTER_IP=$(tart ip "$master" 2>/dev/null)
  if [[ -z "$MASTER_IP" ]]; then
    log_warn "  VM IP 할당 대기 중... (최대 30초)"
    for i in $(seq 1 6); do
      sleep 5
      MASTER_IP=$(tart ip "$master" 2>/dev/null)
      [[ -n "$MASTER_IP" ]] && break
    done
  fi
  if [[ -z "$MASTER_IP" ]]; then
    log_error "$master IP를 가져올 수 없습니다"
    exit 1
  fi
done

echo ""

# ───────────────────────────────────────────────────────────
# Step 2: K8s 노드 상태 확인
# ───────────────────────────────────────────────────────────
log_step "[2/7] K8s 클러스터 노드 상태 확인..."

for cluster in "${TARGET_CLUSTERS[@]}"; do
  log_info "  ${cluster} 클러스터:"
  kubectl_cmd "$cluster" get nodes -o wide 2>/dev/null || {
    log_error "  ${cluster} 클러스터 접근 불가. kubeconfig 확인 필요: ${KUBECONFIG_DIR}/${cluster}.yaml"
    exit 1
  }
  echo ""
done

# ───────────────────────────────────────────────────────────
# Step 3: Docker 이미지 빌드
# ───────────────────────────────────────────────────────────
if [[ "$SKIP_BUILD" == "true" ]]; then
  log_step "[3/7] 이미지 빌드 건너뜀 (SKIP_BUILD=true)"
else
  log_step "[3/7] Docker 이미지 빌드 (ARM64)..."
  echo ""

  APPS_DIR="${PROJECT_ROOT}/apps"
  FAILED=()

  for app in "${IMAGES[@]}"; do
    log_info "  빌드: ${app}..."
    if docker build --platform linux/arm64 -t "${app}:latest" "${APPS_DIR}/${app}" > /tmp/build-${app}.log 2>&1; then
      log_info "  ✓ ${app}:latest 빌드 완료"
    else
      log_error "  ✗ ${app} 빌드 실패 (로그: /tmp/build-${app}.log)"
      FAILED+=("$app")
    fi
  done

  if [[ ${#FAILED[@]} -gt 0 ]]; then
    log_error "빌드 실패한 서비스: ${FAILED[*]}"
    log_error "로그를 확인하세요: /tmp/build-<service>.log"
    exit 1
  fi

  echo ""
  log_info "전체 이미지 빌드 완료: ${IMAGES[*]}"
fi

echo ""

# ───────────────────────────────────────────────────────────
# Step 4: 이미지를 워커 노드에 로드
# ───────────────────────────────────────────────────────────
if [[ "$SKIP_LOAD" == "true" ]]; then
  log_step "[4/7] 이미지 로드 건너뜀 (SKIP_LOAD=true)"
else
  log_step "[4/7] 이미지를 K8s 워커 노드에 로드..."
  echo ""

  for cluster in "${TARGET_CLUSTERS[@]}"; do
    for worker in ${WORKERS[$cluster]}; do
      WORKER_IP=$(tart ip "$worker" 2>/dev/null)
      if [[ -z "$WORKER_IP" ]]; then
        log_error "  ${worker} IP를 가져올 수 없습니다"
        continue
      fi

      log_info "  ${worker} (${WORKER_IP})에 이미지 로드 중..."

      for img in "${IMAGES[@]}"; do
        echo -n "    ${img}... "
        if docker save "${img}:latest" | sshpass -p admin ssh -o StrictHostKeyChecking=no admin@"${WORKER_IP}" \
          "sudo ctr -n k8s.io images import -" > /dev/null 2>&1; then
          echo "✓"
        else
          echo "✗ (실패)"
          log_warn "  ${img} 로드 실패 - ${worker}. 수동 확인 필요"
        fi
      done
    done
  done
fi

echo ""

# ───────────────────────────────────────────────────────────
# Step 5: Nginx Ingress Controller 설치
# ───────────────────────────────────────────────────────────
log_step "[5/7] Nginx Ingress Controller 확인..."

for cluster in "${TARGET_CLUSTERS[@]}"; do
  INGRESS_PODS=$(kubectl_cmd "$cluster" get pods -n ingress-nginx -l app.kubernetes.io/name=ingress-nginx 2>/dev/null | grep -c Running || true)
  if [[ "$INGRESS_PODS" -gt 0 ]]; then
    log_info "  ${cluster}: Nginx Ingress 이미 설치됨 (${INGRESS_PODS} pods)"
  else
    log_info "  ${cluster}: Nginx Ingress 설치 중..."
    "${PROJECT_ROOT}/scripts/install-nginx-ingress.sh" "$cluster" 2>/dev/null || \
      log_warn "  ${cluster}: Ingress 설치 실패 - 수동 설치 필요"
  fi
done

echo ""

# ───────────────────────────────────────────────────────────
# Step 6: 앱 배포
# ───────────────────────────────────────────────────────────
log_step "[6/7] 앱 배포..."

for cluster in "${TARGET_CLUSTERS[@]}"; do
  log_info "  ${cluster} 클러스터 배포 중..."
  "${PROJECT_ROOT}/scripts/deploy.sh" "$cluster"
  echo ""
done

# ───────────────────────────────────────────────────────────
# Step 7: 검증 및 접속 정보 출력
# ───────────────────────────────────────────────────────────
log_step "[7/7] 서비스 검증 및 접속 정보..."
echo ""

for cluster in "${TARGET_CLUSTERS[@]}"; do
  log_info "━━━ ${cluster} 클러스터 ━━━"

  # Pod 상태
  kubectl_cmd "$cluster" get pods -n ecommerce -o wide 2>/dev/null
  echo ""

  # 접속 정보
  MASTER_IP=$(tart ip "${cluster}-master" 2>/dev/null)
  if [[ -n "$MASTER_IP" ]]; then
    echo ""
    log_info "  접속 URL:"
    echo "    Frontend:        http://${MASTER_IP}:30080"
    echo "    API - Orders:    http://${MASTER_IP}:30080/api/orders"
    echo "    API - Products:  http://${MASTER_IP}:30080/api/products"
    echo "    API - Cart:      http://${MASTER_IP}:30080/api/cart"
    echo "    API - Users:     http://${MASTER_IP}:30080/api/users"
    echo "    API - Reviews:   http://${MASTER_IP}:30080/api/reviews"
    echo ""
    echo "    RabbitMQ UI:     http://${MASTER_IP}:31672 (guest/guest)"
    echo "    HAProxy Stats:   http://${MASTER_IP}:30884/stats"
    echo "    Kibana:          http://${MASTER_IP}:31601"
    echo "    Scouter WebApp:  http://${MASTER_IP}:30618"
    echo ""
  fi

  # API 헬스체크
  if [[ -n "$MASTER_IP" ]]; then
    log_info "  API 헬스체크:"
    for endpoint in "/healthz" "/api/orders/health" "/api/products" "/api/cart"; do
      STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://${MASTER_IP}:30080${endpoint}" 2>/dev/null || echo "000")
      if [[ "$STATUS" == "200" ]]; then
        echo "    ✓ ${endpoint}: ${STATUS}"
      else
        echo "    ✗ ${endpoint}: ${STATUS}"
      fi
    done
  fi
  echo ""
done

# ───────────────────────────────────────────────────────────
# 완료
# ───────────────────────────────────────────────────────────
echo ""
log_step "═══════════════════════════════════════════════════"
log_step "  환경 구축 완료!"
log_step ""
log_step "  다음 단계:"
log_step "    1. 브라우저에서 Frontend 접속"
log_step "    2. 회원가입/로그인 → 상품 검색 → 장바구니 → 주문"
log_step "    3. 부하 테스트: ./scripts/run-loadtest.sh smoke ${TARGET_CLUSTERS[0]}"
log_step "    4. 실습 가이드: docs/hands-on-lab.md"
log_step "═══════════════════════════════════════════════════"
