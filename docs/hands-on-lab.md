# 핸즈온 실습 가이드

> 이 문서를 따라 하나씩 실행하면서 MAU 1천만 e-commerce 플랫폼의 각 기능을 직접 체험할 수 있습니다.
> 각 Lab은 독립적이므로 관심 있는 Lab부터 진행해도 됩니다.

---

## 사전 준비

```bash
# 1. 환경변수 설정 (모든 Lab에서 사용)
export DEV_IP=$(tart ip dev-master)
export PROD_IP=$(tart ip prod-master)
export KUBECONFIG_DEV=../tart-infra/kubeconfig/dev.yaml
export KUBECONFIG_PROD=../tart-infra/kubeconfig/prod.yaml

# 2. kubectl alias 설정 (편의)
alias kdev="kubectl --kubeconfig=${KUBECONFIG_DEV}"
alias kprod="kubectl --kubeconfig=${KUBECONFIG_PROD}"

# 3. 이미지 빌드 및 배포 (최초 1회)
./scripts/build-images.sh
./scripts/deploy.sh dev
./scripts/verify.sh dev
```

---

## Lab 1: 멀티티어 아키텍처 체험 (WEB → WAS → DB)

### 목표
Nginx(WEB) → Spring Boot/Express/Go(WAS) → PostgreSQL/MongoDB/Redis(DB) 흐름을 직접 확인

### 실습

```bash
# ── 1-1. 프론트엔드 (Nginx 정적 서빙) ──
curl -s http://${DEV_IP}:30080/ | head -20
# → HTML 페이지 반환 확인

# ── 1-2. 상품 서비스 (Node.js/Express → MongoDB) ──
# 상품 생성
curl -s -X POST http://${DEV_IP}:30080/api/products \
  -H "Content-Type: application/json" \
  -d '{"name":"MacBook Pro M4","price":2499,"category":"electronics","stock":100}' | jq .

# 상품 목록 조회
curl -s http://${DEV_IP}:30080/api/products | jq .

# ── 1-3. 주문 서비스 (Spring Boot/Tomcat → PostgreSQL + RabbitMQ) ──
curl -s -X POST http://${DEV_IP}:30080/api/orders \
  -H "Content-Type: application/json" \
  -d '{"userId":"user-1","productId":"prod-1","quantity":1,"totalPrice":2499}' | jq .

# 주문 목록 조회
curl -s http://${DEV_IP}:30080/api/orders | jq .

# ── 1-4. 장바구니 서비스 (Go → Redis) ──
# 장바구니에 상품 추가
curl -s -X POST http://${DEV_IP}:30080/api/cart \
  -H "Content-Type: application/json" \
  -d '{"userId":"user-1","productId":"prod-1","quantity":2}' | jq .

# 장바구니 조회
curl -s http://${DEV_IP}:30080/api/cart/user-1 | jq .

# ── 1-5. 유저 서비스 (Python/FastAPI → PostgreSQL) ──
# 유저 생성
curl -s -X POST http://${DEV_IP}:30080/api/users/register \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","email":"test@example.com","password":"securepass123"}' | jq .

# 유저 목록
curl -s http://${DEV_IP}:30080/api/users | jq .

# ── 1-6. 리뷰 서비스 (Rust/Actix-web → MongoDB) ──
# 리뷰 작성
curl -s -X POST http://${DEV_IP}:30080/api/reviews \
  -H "Content-Type: application/json" \
  -d '{"productId":"prod-1","userId":"user-1","rating":5,"comment":"Amazing product!"}' | jq .

# 리뷰 조회
curl -s http://${DEV_IP}:30080/api/reviews/prod-1 | jq .
```

### 확인 포인트
- 각 API의 응답 형태와 HTTP 상태 코드 확인
- `kdev get pods -n ecommerce` → 각 서비스 Pod가 Running 상태인지 확인
- `kdev logs -l app=order-service -n ecommerce --tail=5` → 로그에서 DB 쿼리, MQ 발행 확인

---

## Lab 2: 이벤트 기반 비동기 처리 (RabbitMQ)

### 목표
주문 생성 → RabbitMQ 이벤트 발행 → notification-worker 소비 흐름 확인

### 실습

```bash
# ── 2-1. RabbitMQ Management UI 접속 ──
echo "RabbitMQ UI: http://${DEV_IP}:31672"
# 브라우저에서 접속 (guest / guest)
# Queues 탭에서 order.created.queue 확인

# ── 2-2. notification-worker 로그 모니터링 (별도 터미널) ──
kdev logs -f -l app=notification-worker -n ecommerce

# ── 2-3. 주문 생성 → 이벤트 발행 관찰 ──
for i in $(seq 1 5); do
  curl -s -X POST http://${DEV_IP}:30080/api/orders \
    -H "Content-Type: application/json" \
    -d "{\"userId\":\"user-${i}\",\"productId\":\"prod-1\",\"quantity\":1,\"totalPrice\":29.99}"
  echo ""
done

# ── 2-4. notification-worker 로그에서 수신 확인 ──
# → "Processing order event: { orderId: ... }" 로그가 5개 출력되는지 확인

# ── 2-5. RabbitMQ 큐 상태 CLI로 확인 ──
kdev exec -it $(kdev get pods -n ecommerce -l app=rabbitmq -o name | head -1) \
  -n ecommerce -- rabbitmqctl list_queues name messages consumers
```

### 확인 포인트
- 주문 생성 후 notification-worker 로그에 이벤트가 즉시 출력되는지
- RabbitMQ UI에서 큐의 message rate 그래프 확인
- consumers 컬럼이 1 이상인지 확인 (worker가 연결됨)

---

## Lab 3: Redis 캐시 동작 확인

### 목표
캐시 HIT/MISS를 직접 관찰하고, 캐시 무효화가 정상 동작하는지 확인

### 실습

```bash
# ── 3-1. 첫 번째 요청 (캐시 MISS → MongoDB 조회) ──
time curl -s http://${DEV_IP}:30080/api/products > /dev/null
# → 응답 시간 기록 (예: 0.050s)

# ── 3-2. 두 번째 요청 (캐시 HIT → Redis에서 반환) ──
time curl -s http://${DEV_IP}:30080/api/products > /dev/null
# → 응답 시간이 더 빨라야 함 (예: 0.010s)

# ── 3-3. Redis에서 캐시 키 직접 확인 ──
REDIS_POD=$(kdev get pods -n ecommerce -l app=redis -o name | head -1)
kdev exec -it ${REDIS_POD} -n ecommerce -- redis-cli KEYS "products:*"
# → "products:list" 등의 키가 보여야 함

# ── 3-4. 캐시 TTL 확인 ──
kdev exec -it ${REDIS_POD} -n ecommerce -- redis-cli TTL "products:list"
# → 남은 TTL 초 확인 (최대 60초)

# ── 3-5. 상품 생성 → 캐시 무효화 확인 ──
curl -s -X POST http://${DEV_IP}:30080/api/products \
  -H "Content-Type: application/json" \
  -d '{"name":"iPhone 16","price":999,"category":"electronics","stock":200}'

# 캐시가 삭제되었는지 확인
kdev exec -it ${REDIS_POD} -n ecommerce -- redis-cli KEYS "products:*"
# → 캐시 키가 비어있어야 함 (삭제됨)

# ── 3-6. 다시 조회 → 새 캐시 생성 확인 ──
curl -s http://${DEV_IP}:30080/api/products > /dev/null
kdev exec -it ${REDIS_POD} -n ecommerce -- redis-cli KEYS "products:*"
# → 새 캐시 키 생성 확인
```

### 확인 포인트
- 첫 요청 vs 두 번째 요청 응답 시간 차이 (캐시 효과)
- 상품 CRUD 후 캐시가 자동 무효화되는지
- `redis-cli INFO stats` → keyspace_hits, keyspace_misses 값 확인

---

## Lab 4: Rate Limiting 체험

### 목표
Nginx + HAProxy의 Rate Limiting이 실제로 동작하는지 확인

### 실습

```bash
# ── 4-1. Nginx Rate Limit 테스트 (100 req/s, burst=50) ──
echo "=== Nginx Rate Limit Test ==="
for i in $(seq 1 200); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://${DEV_IP}:30080/api/products)
  if [ "$STATUS" != "200" ]; then
    echo "Request ${i}: HTTP ${STATUS} ← Rate limited!"
  fi
done
# → 일정 횟수 이후 503 응답이 나타나기 시작

# ── 4-2. HAProxy Rate Limit 테스트 (IP당 100 req/10s) ──
echo "=== HAProxy Rate Limit Test ==="
for i in $(seq 1 200); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://${DEV_IP}:30880/api/products)
  if [ "$STATUS" != "200" ]; then
    echo "Request ${i}: HTTP ${STATUS} ← Rate limited!"
  fi
done
# → 100회 이후 429 Too Many Requests 응답

# ── 4-3. HAProxy Stats 대시보드 확인 ──
echo "HAProxy Stats: http://${DEV_IP}:30884/stats"
# → 브라우저에서 접속하여 요청 통계, 에러 카운트 확인
```

### 확인 포인트
- 정상 응답(200)에서 제한 응답(429/503)으로 전환되는 시점
- HAProxy Stats 대시보드에서 deny 카운트 증가 확인
- 10초 대기 후 다시 요청하면 정상 응답이 돌아오는지 확인

---

## Lab 5: 부하 테스트 (k6)

### 목표
k6로 실제 트래픽 패턴을 시뮬레이션하고 시스템 응답 확인

### 실습

```bash
# ── 5-1. Smoke 테스트 (10 VU, 1분 - 기본 동작 검증) ──
./scripts/run-loadtest.sh smoke dev
# → 결과에서 확인할 항목:
#   - http_req_duration: avg < 500ms
#   - http_req_failed: 0%
#   - checks: 100% passed

# ── 5-2. Average Load (200 VU, 10분 - 평일 트래픽) ──
./scripts/run-loadtest.sh average-load dev
# → 결과에서 확인할 항목:
#   - http_reqs: 총 요청 수
#   - http_req_duration p(95): < 1s
#   - iterations: 완료된 반복 수

# ── 5-3. 부하 테스트 중 모니터링 (별도 터미널) ──
# Pod CPU/메모리 사용량 관찰
watch -n 2 "kdev top pods -n ecommerce"

# 서비스별 응답 시간 관찰
while true; do
  echo -n "$(date +%H:%M:%S) | orders: "
  curl -s -o /dev/null -w "%{time_total}s" http://${DEV_IP}:30080/api/orders
  echo -n " | products: "
  curl -s -o /dev/null -w "%{time_total}s" http://${DEV_IP}:30080/api/products
  echo ""
  sleep 2
done
```

### 확인 포인트
- k6 결과 요약에서 SLA 기준 충족 여부 (P95 < 1s, 에러율 < 1%)
- `kubectl top pods` 에서 부하 중 CPU/메모리 증가 관찰
- 부하 종료 후 리소스 사용량이 정상으로 돌아오는지

---

## Lab 6: HPA 오토스케일링 체험 (prod 클러스터)

### 목표
CPU 부하 증가 시 HPA가 자동으로 Pod 수를 늘리는 것을 관찰

### 사전 준비

```bash
# prod 클러스터 배포 (HPA + PDB 포함)
./scripts/deploy.sh prod
./scripts/verify.sh prod
```

### 실습

```bash
# ── 6-1. 현재 HPA 상태 확인 ──
kprod get hpa -n ecommerce
# → REPLICAS: 2/2, TARGETS: <current>/<target>

# ── 6-2. 별도 터미널에서 HPA 실시간 모니터링 ──
kprod get hpa -n ecommerce -w
# → REPLICAS 변화를 실시간 관찰

# ── 6-3. 별도 터미널에서 Pod 수 실시간 모니터링 ──
watch -n 2 "kprod get pods -n ecommerce -l app=order-service"

# ── 6-4. 스트레스 테스트로 HPA 트리거 ──
./scripts/run-loadtest.sh stress-test prod
# → 2000 VU 부하로 CPU 사용률 상승

# ── 6-5. HPA 스케일아웃 관찰 ──
# 약 1-2분 후:
#   order-service: 2 → 4 → 6 레플리카로 확장
#   product-service: 2 → 4 레플리카로 확장
#   cart-service: 2 → 3 레플리카로 확장

# ── 6-6. 부하 종료 후 스케일다운 관찰 ──
# 5분 (stabilizationWindowSeconds: 300) 후:
#   점진적으로 원래 레플리카 수로 감소
```

### 확인 포인트
- HPA의 TARGETS 열에서 CPU 사용률이 50% 초과하는지
- REPLICAS가 minReplicas에서 증가하는지
- 부하 종료 후 5분 대기 → 스케일다운 발생 확인
- `kprod describe hpa <name> -n ecommerce` → Events에서 스케일 이벤트 기록 확인

---

## Lab 7: KEDA 이벤트 기반 스케일링 (RabbitMQ 큐)

### 목표
RabbitMQ 큐에 메시지가 쌓이면 KEDA가 notification-worker를 자동 확장하는 것을 관찰

### 사전 준비

```bash
# KEDA 설치 (prod 클러스터)
./scripts/install-keda.sh prod
```

### 실습

```bash
# ── 7-1. 현재 notification-worker 레플리카 확인 ──
kprod get pods -n ecommerce -l app=notification-worker
# → 1개 Pod

# ── 7-2. 별도 터미널에서 worker Pod 실시간 모니터링 ──
kprod get pods -n ecommerce -l app=notification-worker -w

# ── 7-3. 대량 주문 생성으로 RabbitMQ 큐에 메시지 쌓기 ──
echo "=== Sending 100 orders ==="
for i in $(seq 1 100); do
  curl -s -X POST http://${PROD_IP}:30080/api/orders \
    -H "Content-Type: application/json" \
    -d "{\"userId\":\"user-${i}\",\"productId\":\"prod-1\",\"quantity\":1,\"totalPrice\":29.99}" > /dev/null
  echo -n "."
done
echo " Done!"

# ── 7-4. RabbitMQ 큐 깊이 확인 ──
kprod exec -it $(kprod get pods -n ecommerce -l app=rabbitmq -o name | head -1) \
  -n ecommerce -- rabbitmqctl list_queues name messages
# → order.created.queue: messages > 5 → KEDA 트리거

# ── 7-5. KEDA가 worker를 스케일아웃하는지 관찰 ──
# 약 30초 후:
#   notification-worker: 1 → 3 → 5 레플리카로 확장
#   큐 소비 속도가 빨라짐

# ── 7-6. 큐가 비워지면 자동 스케일다운 확인 ──
# cooldownPeriod (60초) 경과 후:
#   notification-worker: 5 → 3 → 1 레플리카로 감소
kprod get scaledobject -n ecommerce
```

### 확인 포인트
- 큐 깊이 > 5 → worker Pod 수 증가
- 큐 소진 → cooldownPeriod 후 worker Pod 수 감소
- `kprod describe scaledobject notification-worker-scaler -n ecommerce` → Events 확인

---

## Lab 8: 서킷브레이커 체험 (Istio)

### 목표
서비스 장애 시 Istio가 자동으로 비정상 엔드포인트를 제거하는 것을 관찰

### 사전 준비

```bash
# Istio 매니페스트 적용 (dev 클러스터에 Istio가 설치되어 있어야 함)
kdev apply -f manifests/istio/destination-rules.yaml
kdev apply -f manifests/istio/virtual-services.yaml
```

### 실습

```bash
# ── 8-1. 정상 상태에서 요청 확인 ──
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "Request ${i}: HTTP %{http_code}, Time: %{time_total}s\n" \
    http://${DEV_IP}:30080/api/products
done
# → 모든 요청이 200 OK

# ── 8-2. product-service Pod 하나를 강제 종료 (장애 시뮬레이션) ──
POD_NAME=$(kdev get pods -n ecommerce -l app=product-service -o name | head -1)
echo "Killing: ${POD_NAME}"
kdev delete ${POD_NAME} -n ecommerce --grace-period=0 --force

# ── 8-3. Istio가 비정상 엔드포인트를 제거하는지 확인 ──
# proxy-config로 endpoint 상태 확인 (Istio sidecar가 있을 때)
ORDER_POD=$(kdev get pods -n ecommerce -l app=order-service -o name | head -1)
kdev exec ${ORDER_POD} -n ecommerce -c istio-proxy -- \
  pilot-agent request GET clusters | grep product-service

# ── 8-4. 서비스 요청이 정상 Pod로만 라우팅되는지 확인 ──
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "Request ${i}: HTTP %{http_code}\n" \
    http://${DEV_IP}:30080/api/products
done
# → K8s가 새 Pod를 생성할 때까지 기존 정상 Pod로만 라우팅

# ── 8-5. Pod 복구 확인 ──
kdev get pods -n ecommerce -l app=product-service -w
# → 새 Pod가 Running/Ready로 돌아오면 트래픽 재분배
```

### 확인 포인트
- Istio DestinationRule의 outlierDetection 설정 확인
- 장애 Pod 제거 후에도 서비스 가용성 유지
- K8s의 자동 복구(Deployment)와 Istio의 트래픽 관리가 함께 작동

---

## Lab 9: Prometheus 메트릭 + Grafana 대시보드

### 목표
각 서비스가 노출하는 메트릭을 Prometheus가 수집하고 Grafana에서 시각화되는 것을 확인

### 실습

```bash
# ── 9-1. 서비스별 메트릭 엔드포인트 직접 확인 ──

# order-service (Spring Boot Actuator)
curl -s http://${DEV_IP}:30080/api/orders/actuator/prometheus | head -20
# → jvm_memory_used_bytes, http_server_requests_seconds 등

# product-service (prom-client)
PRODUCT_POD=$(kdev get pods -n ecommerce -l app=product-service -o name | head -1)
kdev port-forward ${PRODUCT_POD} 3000:3000 -n ecommerce &
curl -s http://localhost:3000/metrics | head -20
kill %1
# → http_request_duration_seconds, nodejs_heap_size_total_bytes 등

# cart-service (promhttp)
CART_POD=$(kdev get pods -n ecommerce -l app=cart-service -o name | head -1)
kdev port-forward ${CART_POD} 8081:8081 -n ecommerce &
curl -s http://localhost:8081/metrics | head -20
kill %1
# → cart_operations_total, go_goroutines 등

# ── 9-2. Prometheus Targets 확인 ──
PLATFORM_IP=$(tart ip platform-master)
echo "Prometheus: http://${PLATFORM_IP}:30090"
# → Status > Targets에서 ecommerce 서비스들이 UP 상태인지 확인

# ── 9-3. Grafana 대시보드 임포트 ──
echo "Grafana: http://${PLATFORM_IP}:30300"
# → 브라우저에서 접속 (admin/admin)
# → + > Import > Upload JSON file
#   - monitoring/grafana-dashboards/ecommerce-overview.json
#   - monitoring/grafana-dashboards/autoscaling-dashboard.json

# ── 9-4. 부하 테스트 중 대시보드 관찰 ──
./scripts/run-loadtest.sh average-load dev
# → Grafana에서 실시간으로 RPS, 레이턴시, 에러율 변화 관찰
```

### 확인 포인트
- 각 서비스의 /metrics 엔드포인트 정상 응답
- Prometheus Targets에서 모든 서비스가 UP
- Grafana 대시보드에서 패널에 데이터가 표시되는지

---

## Lab 10: EFK 로그 수집 체험

### 목표
Fluentd가 Pod 로그를 수집하여 Elasticsearch에 저장하고 Kibana에서 검색

### 실습

```bash
# ── 10-1. EFK Pod 상태 확인 ──
kdev get pods -n ecommerce -l 'app in (elasticsearch, fluentd, kibana)'
# → 3개 컴포넌트 모두 Running

# ── 10-2. Elasticsearch 클러스터 상태 확인 ──
ES_POD=$(kdev get pods -n ecommerce -l app=elasticsearch -o name | head -1)
kdev exec -it ${ES_POD} -n ecommerce -- \
  curl -s localhost:9200/_cluster/health | python3 -m json.tool
# → status: "green" 또는 "yellow"

# ── 10-3. 인덱스 확인 ──
kdev exec -it ${ES_POD} -n ecommerce -- \
  curl -s localhost:9200/_cat/indices?v
# → ecommerce-logs-YYYY.MM.DD 인덱스가 있어야 함

# ── 10-4. 로그 데이터 생성 (API 요청을 보내면 로그 발생) ──
for i in $(seq 1 20); do
  curl -s http://${DEV_IP}:30080/api/products > /dev/null
  curl -s -X POST http://${DEV_IP}:30080/api/orders \
    -H "Content-Type: application/json" \
    -d "{\"userId\":\"user-${i}\",\"productId\":\"prod-1\",\"quantity\":1,\"totalPrice\":9.99}" > /dev/null
done

# ── 10-5. Kibana UI 접속 ──
echo "Kibana: http://${DEV_IP}:31601"
# → 브라우저에서 접속
# → Management > Index Patterns > Create: "ecommerce-logs-*"
# → Discover 탭에서 로그 검색

# ── 10-6. CLI로 로그 검색 ──
kdev exec -it ${ES_POD} -n ecommerce -- \
  curl -s "localhost:9200/ecommerce-logs-*/_search?q=kubernetes.labels.app:order-service&size=3" \
  | python3 -m json.tool
```

### 확인 포인트
- Elasticsearch에 로그 인덱스가 생성되었는지
- Kibana에서 서비스별 로그 필터링이 가능한지
- `kubernetes.labels.app` 필드로 특정 서비스 로그만 검색

---

## Lab 11: Kustomize 환경별 배포 비교

### 목표
동일한 base 매니페스트가 dev/staging/prod에서 어떻게 다르게 적용되는지 확인

### 실습

```bash
# ── 11-1. 각 환경의 최종 매니페스트 비교 (dry-run) ──

# dev: 단일 레플리카, namePrefix: dev-
kustomize build manifests/overlays/dev | grep "replicas:" | head -5
kustomize build manifests/overlays/dev | grep "name: dev-" | head -5

# staging: 2 레플리카, namePrefix: staging-
kustomize build manifests/overlays/staging | grep "replicas:" | head -5
kustomize build manifests/overlays/staging | grep "name: staging-" | head -5

# prod: 2 레플리카 + HPA + PDB, namePrefix: prod-
kustomize build manifests/overlays/prod | grep "replicas:" | head -5
kustomize build manifests/overlays/prod | grep "kind: HorizontalPodAutoscaler"
kustomize build manifests/overlays/prod | grep "kind: PodDisruptionBudget"

# ── 11-2. 리소스 차이 비교 ──
echo "=== Dev resources ==="
kustomize build manifests/overlays/dev | grep -A4 "resources:" | head -15

echo "=== Prod resources ==="
kustomize build manifests/overlays/prod | grep -A4 "resources:" | head -15

# ── 11-3. 환경별 ConfigMap 비교 ──
echo "=== Dev LOG_LEVEL ==="
kustomize build manifests/overlays/dev | grep "LOG_LEVEL"

echo "=== Prod LOG_LEVEL ==="
kustomize build manifests/overlays/prod | grep "LOG_LEVEL"
```

### 확인 포인트
- dev: 1 레플리카, debug 로깅, 최소 리소스
- staging: 2 레플리카, info 로깅
- prod: 2 레플리카 기본 + HPA(최대 6), PDB, KEDA, warn 로깅

---

## Lab 12: ArgoCD GitOps 동기화 체험

### 목표
git push로 코드를 변경하면 ArgoCD가 자동으로 K8s에 반영하는 것을 확인

### 실습

```bash
# ── 12-1. ArgoCD UI 접속 ──
PLATFORM_IP=$(tart ip platform-master)
echo "ArgoCD: https://${PLATFORM_IP}:30443"
# → admin / (초기 비밀번호: kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d)

# ── 12-2. App-of-Apps 등록 ──
kubectl --kubeconfig=../tart-infra/kubeconfig/platform.yaml \
  apply -f argocd/app-of-apps.yaml

# ── 12-3. ArgoCD UI에서 앱 상태 확인 ──
# → devops-ecommerce-apps 아래 dev-ecommerce, staging-ecommerce, prod-ecommerce 3개 앱
# → dev-ecommerce: Synced / Healthy (auto-sync 설정)

# ── 12-4. 코드 변경 → auto-sync 관찰 (dev) ──
# 예: product-service 레플리카를 2로 변경
# manifests/overlays/dev/resource-patches.yaml 수정 후 git push
# → ArgoCD가 자동으로 감지하고 sync

# ── 12-5. Manual Sync (staging/prod) ──
# staging/prod는 manual sync → ArgoCD UI에서 "Sync" 버튼 클릭
```

### 확인 포인트
- ArgoCD UI에서 앱의 Sync 상태 (Synced / OutOfSync)
- Health 상태 (Healthy / Degraded / Missing)
- auto-sync(dev) vs manual-sync(staging/prod) 차이
- Application Details에서 리소스 트리 확인

---

## Lab 13: 전체 데모 시나리오 (End-to-End)

### 목표
모든 컴포넌트를 사용하는 전체 시나리오를 처음부터 끝까지 실행

### 실습

```bash
# ── 전체 자동화 데모 (약 20분) ──
./scripts/demo.sh dev

# 또는 수동으로 단계별 실행:

# 1. 이미지 빌드 (5분)
./scripts/build-images.sh

# 2. dev 배포 (1분)
./scripts/deploy.sh dev

# 3. 서비스 검증 (1분)
./scripts/verify.sh dev

# 4. API 기능 테스트
DEV_IP=$(tart ip dev-master)

# 상품 생성
curl -s -X POST http://${DEV_IP}:30080/api/products \
  -H "Content-Type: application/json" \
  -d '{"name":"Demo Product","price":49.99,"category":"demo","stock":100}' | jq .

# 주문 생성 (→ RabbitMQ → notification-worker)
curl -s -X POST http://${DEV_IP}:30080/api/orders \
  -H "Content-Type: application/json" \
  -d '{"userId":"demo-user","productId":"prod-1","quantity":1,"totalPrice":49.99}' | jq .

# 5. Smoke 테스트 (1분)
./scripts/run-loadtest.sh smoke dev

# 6. 결과 확인
echo "=== Pod Status ==="
kdev get pods -n ecommerce
echo ""
echo "=== HPA Status ==="
kdev get hpa -n ecommerce 2>/dev/null || echo "(HPA is prod-only)"
echo ""
echo "=== Services ==="
kdev get svc -n ecommerce

echo ""
echo "모니터링 대시보드:"
echo "  Grafana:    http://$(tart ip platform-master):30300"
echo "  Prometheus: http://$(tart ip platform-master):30090"
echo "  RabbitMQ:   http://${DEV_IP}:31672"
echo "  Kibana:     http://${DEV_IP}:31601"
echo "  HAProxy:    http://${DEV_IP}:30884/stats"
```

---

## 실습 완료 후 정리

```bash
# dev 환경 리소스 정리
kdev delete namespace ecommerce

# 또는 VM 중지 (다음에 이어서 할 때)
tart stop dev-master dev-worker1
```

---

## 트러블슈팅

실습 중 문제가 발생하면 아래 문서를 참고하세요:

- [환경 이슈 & 트러블슈팅 가이드](troubleshooting.md) - ARM64, 베어메탈 K8s, Tart VM 관련 이슈
- [트래픽 대응 전략 가이드](traffic-handling.md) - 캐시, Rate Limiting, 백프레셔 등
