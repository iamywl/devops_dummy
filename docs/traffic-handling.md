# 트래픽 대응 전략 가이드

> MAU 1천만 서비스에서 실제로 적용하는 트래픽 대응 패턴과 이 프로젝트에서의 구현 방법

---

## 1. 멀티레벨 캐시 전략

### 1.1 캐시 계층 구조

```
[클라이언트 요청]
     │
     ▼
┌─────────────────────────┐
│ L1: Nginx Proxy Cache   │  ← 정적 리소스 (HTML, CSS, JS, 이미지)
│ TTL: 1h, 메모리 기반     │     proxy_cache_path 설정
└────────┬────────────────┘
         │ MISS
         ▼
┌─────────────────────────┐
│ L2: Redis Cache         │  ← API 응답 캐시 (상품 목록, 상품 상세)
│ TTL: 60s, maxmem 200MB  │     product-service의 cache.js 미들웨어
│ 정책: allkeys-lru       │     캐시 키: products:list, products:{id}
└────────┬────────────────┘
         │ MISS
         ▼
┌─────────────────────────┐
│ L3: Database            │  ← MongoDB (상품), PostgreSQL (주문)
│ 커넥션 풀 관리           │     인덱스 최적화, 쿼리 튜닝
└─────────────────────────┘
```

### 1.2 캐시 무효화 전략

```
상품 생성/수정/삭제 시:
  1. DB에 반영
  2. Redis SCAN으로 관련 캐시 키 삭제 (prefix: "products:")
  3. 다음 요청에서 DB 조회 → 캐시 재생성

장점: 캐시 일관성 보장
단점: 삭제 직후 순간적으로 DB 부하 증가 (thundering herd)
대응: Redis lock으로 하나의 요청만 DB 조회하도록 제어
```

### 1.3 이 프로젝트에서 확인하는 방법

```bash
# 1. 상품 조회 → Redis 캐시 HIT 확인
curl http://${DEV_IP}:30080/api/products          # 첫 요청: DB 조회
curl http://${DEV_IP}:30080/api/products          # 두 번째: Redis HIT (응답 빨라짐)

# 2. Redis에서 캐시 키 직접 확인
kubectl exec -it dev-redis-xxx -n ecommerce -- redis-cli KEYS "products:*"

# 3. 상품 생성 → 캐시 무효화 확인
curl -X POST http://${DEV_IP}:30080/api/products \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Product","price":100,"category":"test","stock":50}'

# 캐시 키가 삭제되었는지 확인
kubectl exec -it dev-redis-xxx -n ecommerce -- redis-cli KEYS "products:*"
```

---

## 2. 커넥션 풀 관리

### 2.1 서비스별 커넥션 풀 전략

| 서비스 | DB | 풀 방식 | 설정 |
|--------|-----|---------|------|
| order-service | PostgreSQL | HikariCP (Spring Boot 기본) | max-pool: 10, min-idle: 5 |
| product-service | MongoDB | Mongoose 내장 풀 | poolSize: 10 |
| cart-service | Redis | go-redis 내장 풀 | PoolSize: 10 |
| user-service | PostgreSQL | SQLAlchemy async pool | pool_size: 10, max_overflow: 5 |
| review-service | MongoDB | mongodb-rust 내장 풀 | max_pool_size: 10 |

### 2.2 커넥션 풀 고갈 시나리오

```
문제 상황:
  부하 테스트 중 order-service에서 커넥션 풀 고갈 발생
  → "HikariPool-1 - Connection is not available, request timed out after 30000ms"

원인:
  동시 요청 > 풀 크기일 때 대기 큐 초과

해결:
  1. application.properties에서 풀 크기 조정
     spring.datasource.hikari.maximum-pool-size=20
  2. 쿼리 최적화 (느린 쿼리가 커넥션을 오래 점유)
  3. HPA가 Pod를 추가하면 전체 커넥션 수 자동 증가
```

### 2.3 이 프로젝트에서 확인하는 방법

```bash
# HikariCP 메트릭 확인 (Actuator)
curl http://${DEV_IP}:30080/api/orders/actuator/metrics/hikaricp.connections.active

# stress-test로 커넥션 풀 부하 유발
./scripts/run-loadtest.sh stress-test dev

# Grafana에서 커넥션 풀 사용량 모니터링
#   PromQL: hikaricp_connections_active{app="order-service"}
```

---

## 3. Rate Limiting 전략

### 3.1 다중 계층 Rate Limiting

```
┌──────────────────────────────────────────────┐
│ Layer 1: HAProxy                              │
│ stick-table 기반, IP당 100 req/10s            │
│ 429 Too Many Requests 반환                    │
├──────────────────────────────────────────────┤
│ Layer 2: Nginx Ingress                        │
│ limit_req_zone, IP당 100 req/s               │
│ burst=50 허용 후 초과분 지연 처리              │
├──────────────────────────────────────────────┤
│ Layer 3: Istio EnvoyFilter (선택)             │
│ 서비스별 Rate Limit                           │
│ order-service: 50 req/s (쓰기 보호)           │
│ product-service: 200 req/s (읽기 허용)        │
├──────────────────────────────────────────────┤
│ Layer 4: 애플리케이션 레벨                     │
│ Redis 기반 sliding window rate limiter        │
│ 사용자별 세밀한 제어                           │
└──────────────────────────────────────────────┘
```

### 3.2 이 프로젝트에서 확인하는 방법

```bash
# HAProxy rate limit 테스트 (빠르게 반복 요청)
for i in $(seq 1 200); do
  curl -s -o /dev/null -w "%{http_code} " http://${DEV_IP}:30880/api/products
done
# → 100회 이후 429 응답 확인

# HAProxy Stats 대시보드에서 확인
open http://${DEV_IP}:30884/stats

# Nginx rate limit 테스트
for i in $(seq 1 150); do
  curl -s -o /dev/null -w "%{http_code} " http://${DEV_IP}:30080/api/products
done
# → burst 초과 시 503 응답
```

---

## 4. 백프레셔(Backpressure) 패턴

### 4.1 메시지 큐 기반 백프레셔

```
[주문 요청 급증]
     │
     ▼
order-service ──publish──→ RabbitMQ Queue ──consume──→ notification-worker
                           │
                           │ 큐 깊이 증가
                           │
                     ┌─────▼──────┐
                     │ KEDA 감지   │
                     │ queueLength │
                     │ > 5         │
                     └─────┬──────┘
                           │
                     ┌─────▼──────────────┐
                     │ notification-worker  │
                     │ 1 → 5 레플리카 확장  │
                     │ 큐 소비 속도 증가    │
                     └────────────────────┘
```

### 4.2 이 프로젝트에서 확인하는 방법

```bash
# 1. 대량 주문 생성으로 큐에 메시지 쌓기
for i in $(seq 1 100); do
  curl -s -X POST http://${DEV_IP}:30080/api/orders \
    -H "Content-Type: application/json" \
    -d "{\"userId\":\"user-$i\",\"productId\":\"prod-1\",\"quantity\":1,\"totalPrice\":29.99}"
done

# 2. RabbitMQ 큐 깊이 확인
kubectl exec -it prod-rabbitmq-0 -n ecommerce -- \
  rabbitmqctl list_queues name messages

# 3. KEDA ScaledObject로 notification-worker 스케일아웃 관찰
kubectl get pods -n ecommerce -l app=notification-worker -w

# 4. 큐가 비워지면 자동 스케일다운 확인 (cooldownPeriod: 60s)
```

---

## 5. 서킷브레이커 패턴

### 5.1 Istio DestinationRule 기반

```
정상 상태 (Closed):
  order-service → product-service 호출 정상

장애 감지 (Open):
  product-service 연속 3회 5xx 응답
  → Istio가 해당 엔드포인트를 30초간 제거 (ejection)
  → 다른 정상 엔드포인트로 트래픽 전환
  → 최대 50%의 엔드포인트까지 제거 가능

복구 확인 (Half-Open):
  30초 후 제거된 엔드포인트로 테스트 요청
  → 성공하면 다시 풀에 포함
  → 실패하면 ejection 시간 2배 증가
```

### 5.2 이 프로젝트에서 확인하는 방법

```bash
# 1. product-service Pod 하나를 의도적으로 장애 유발
kubectl exec -it dev-product-service-xxx -n ecommerce -- kill 1

# 2. Istio가 해당 Pod를 ejection하는 것 확인
istioctl proxy-config endpoint dev-order-service-xxx -n ecommerce | grep product

# 3. 트래픽이 정상 Pod로만 라우팅되는지 확인
for i in $(seq 1 10); do
  curl -s http://${DEV_IP}:30080/api/products | head -1
done
```

---

## 6. Graceful Shutdown & Zero-Downtime 배포

### 6.1 롤링 업데이트 전략

```yaml
spec:
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1        # 동시에 1개 새 Pod 생성
      maxUnavailable: 0  # 기존 Pod 0개 삭제 (무중단)
```

### 6.2 이 프로젝트에서 확인하는 방법

```bash
# 1. 부하 테스트 실행 중에 이미지 업데이트
./scripts/run-loadtest.sh average-load dev &

# 2. 롤링 업데이트 수행
kubectl set image deployment/dev-order-service \
  order-service=order-service:v2 -n ecommerce

# 3. k6 결과에서 에러율 0% 확인 → zero-downtime 달성
```
