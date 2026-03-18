# 10. k6 부하 테스트로 MAU 1천만 시뮬레이션하기

## 핵심 요약

k6로 5단계 부하 테스트(smoke → average → peak → stress → soak)를 실행하여 MAU 1천만 트래픽을 시뮬레이션하고, HPA 스케일아웃을 관찰하며, 시스템의 병목점을 식별한다.

---

## 1. k6란

k6는 Grafana Labs에서 개발한 Go 기반 부하 테스트 도구다. JavaScript로 시나리오를 작성하고, 바이너리 하나로 대량의 가상 사용자(VU)를 생성한다.

```
k6의 동작 원리:

k6 바이너리 (Go)
    │
    ├── JavaScript VM (goja) ← 시나리오 스크립트 실행
    │       │
    │       ├── VU 1: HTTP 요청 → 응답 수집 → 메트릭 기록
    │       ├── VU 2: HTTP 요청 → 응답 수집 → 메트릭 기록
    │       ├── ...
    │       └── VU N: HTTP 요청 → 응답 수집 → 메트릭 기록
    │
    └── 실시간 메트릭 집계
         ├── 터미널 출력 (기본)
         ├── JSON 파일 (--out json=result.json)
         └── Prometheus (--out experimental-prometheus-rw)
```

---

## 2. 시나리오 설계

### 2.1 공통 설정

**loadtest/k6/lib/endpoints.js**:

```javascript
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:30080';

export const ENDPOINTS = {
  PRODUCTS_LIST:    `${BASE_URL}/api/products`,
  PRODUCT_BY_ID:    (id) => `${BASE_URL}/api/products/${id}`,
  ORDERS_CREATE:    `${BASE_URL}/api/orders`,
  ORDERS_LIST:      `${BASE_URL}/api/orders`,
  CART_ADD:         `${BASE_URL}/api/cart`,
  CART_GET:         (userId) => `${BASE_URL}/api/cart/${userId}`,
  USERS_REGISTER:   `${BASE_URL}/api/users/register`,
  REVIEWS_CREATE:   `${BASE_URL}/api/reviews`,
  HEALTH:           `${BASE_URL}/healthz`,
};
```

**loadtest/k6/lib/helpers.js**:

```javascript
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// Custom metrics (k6가 수집하는 커스텀 지표)
export const errorRate = new Rate('errors');
export const orderLatency = new Trend('order_latency', true);
export const productLatency = new Trend('product_latency', true);
export const cartLatency = new Trend('cart_latency', true);

// SLA 기준: P95 < 500ms, P99 < 1000ms, 에러율 < 1%
export const SLA_THRESHOLDS = {
  http_req_duration: ['p(95)<500', 'p(99)<1000'],
  http_req_failed: ['rate<0.01'],
  errors: ['rate<0.01'],
};

export function checkResponse(res, name) {
  const result = check(res, {
    [`${name} status 2xx`]: (r) => r.status >= 200 && r.status < 300,
    [`${name} response time < 1s`]: (r) => r.timings.duration < 1000,
  });
  errorRate.add(!result);
  return result;
}

// 랜덤 유저/상품 ID 생성 (부하 테스트용)
export function randomUserId() {
  return `user-${Math.floor(Math.random() * 10000)}`;
}

export function randomProductId() {
  return `prod-${Math.floor(Math.random() * 100)}`;
}
```

### 2.2 5단계 시나리오

**1. Smoke Test** - 엔드포인트 동작 확인:

```javascript
// loadtest/k6/scenarios/smoke.js
export const options = {
  vus: 10,
  duration: '1m',
  thresholds: SLA_THRESHOLDS,
};

export default function() {
  // 모든 엔드포인트를 한 번씩 호출
  let res = http.get(ENDPOINTS.PRODUCTS_LIST);
  checkResponse(res, 'GET products');
  sleep(1);

  res = http.post(ENDPOINTS.ORDERS_CREATE, orderPayload, headers);
  checkResponse(res, 'POST order');
  sleep(1);
}
```

**2. Average Load** - 평일 평균 트래픽:

```javascript
// loadtest/k6/scenarios/average-load.js
import http from 'k6/http';
import { sleep } from 'k6';
import { ENDPOINTS } from '../lib/endpoints.js';
import { checkResponse, randomUserId, randomProductId,
         productLatency, orderLatency, cartLatency, SLA_THRESHOLDS } from '../lib/helpers.js';

export const options = {
  stages: [
    { duration: '2m', target: 50 },    // 2분간 50 VU로 시작 (워밍업)
    { duration: '5m', target: 200 },   // 5분간 200 VU로 증가
    { duration: '2m', target: 200 },   // 2분간 200 VU 유지
    { duration: '1m', target: 0 },     // 1분간 램프다운
  ],
  thresholds: SLA_THRESHOLDS,
};

export default function () {
  const userId = randomUserId();
  const productId = randomProductId();

  // 60% 상품 목록 조회 (가장 빈번한 요청)
  if (Math.random() < 0.6) {
    const res = http.get(ENDPOINTS.PRODUCTS_LIST);
    checkResponse(res, 'GET products');
    productLatency.add(res.timings.duration);
    sleep(0.5);
    return;
  }

  // 20% 장바구니 조작
  if (Math.random() < 0.5) {
    const cartPayload = JSON.stringify({
      userId: userId,
      productId: productId,
      quantity: Math.floor(Math.random() * 5) + 1,
    });
    const res = http.post(ENDPOINTS.CART_ADD, cartPayload, {
      headers: { 'Content-Type': 'application/json' },
    });
    checkResponse(res, 'POST cart');
    cartLatency.add(res.timings.duration);
    sleep(0.3);
    return;
  }

  // 20% 주문 생성 (DB 쓰기 + MQ 발행, 가장 무거운 경로)
  const orderPayload = JSON.stringify({
    userId: userId,
    productId: productId,
    quantity: 1,
    totalPrice: (Math.random() * 100 + 10).toFixed(2),
  });
  const res = http.post(ENDPOINTS.ORDERS_CREATE, orderPayload, {
    headers: { 'Content-Type': 'application/json' },
  });
  checkResponse(res, 'POST order');
  orderLatency.add(res.timings.duration);
  sleep(0.5);
}
```

**3. Peak Load** - MAU 1천만 피크 시간:

```javascript
export const options = {
  stages: [
    { duration: '2m', target: 100 },
    { duration: '3m', target: 300 },
    { duration: '5m', target: 500 },   // 피크: 500 VU ≈ 300 RPS
    { duration: '3m', target: 300 },
    { duration: '2m', target: 0 },
  ],
};
```

**4. Stress Test** - 한계점 탐색:

```javascript
export const options = {
  stages: [
    { duration: '2m', target: 500 },
    { duration: '5m', target: 1000 },
    { duration: '5m', target: 2000 },  // 극한: 2000 VU
    { duration: '5m', target: 1000 },
    { duration: '3m', target: 0 },
  ],
};
```

**5. Soak Test** - 장시간 안정성:

```javascript
export const options = {
  stages: [
    { duration: '5m', target: 200 },
    { duration: '110m', target: 200 },  // 2시간 유지
    { duration: '5m', target: 0 },
  ],
};
// 목적: 메모리 누수, 커넥션 풀 고갈, GC 압력 탐지
```

---

## 3. 테스트 실행

### 3.1 실행 스크립트

```bash
#!/bin/bash
# scripts/run-loadtest.sh

SCENARIO=$1
CLUSTER=${2:-dev}

MASTER_IP=$(tart ip ${CLUSTER}-master)
BASE_URL="http://${MASTER_IP}:30080"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RESULT_FILE="loadtest/results/${SCENARIO}_${TIMESTAMP}.json"

echo "부하 테스트 시작: ${SCENARIO} → ${CLUSTER} (${BASE_URL})"

k6 run \
  --env BASE_URL="${BASE_URL}" \
  --out json="${RESULT_FILE}" \
  "loadtest/k6/scenarios/${SCENARIO}.js"

echo "결과: ${RESULT_FILE}"
```

### 3.2 실행 예시

```bash
cd ~/devops_dummpy  # 프로젝트 루트 경로로 이동

# 결과 저장 디렉토리 생성
mkdir -p loadtest/results

# 실행 권한 부여
chmod +x scripts/run-loadtest.sh

# 1. Smoke 테스트 (1분, 기본 검증) - 먼저 dev에서 검증
./scripts/run-loadtest.sh smoke dev

# 2. Average Load (10분, 평일 트래픽)
./scripts/run-loadtest.sh average-load dev

# 3. Peak Load (15분, MAU 1천만 피크) - prod에서 실행
./scripts/run-loadtest.sh peak-load prod

# 4. Stress Test + HPA 관찰 (별도 터미널 2개 필요)
# 터미널 1: 부하 생성
./scripts/run-loadtest.sh stress-test prod

# 터미널 2: HPA 실시간 관찰
watch -n 2 'kubectl --kubeconfig=kubeconfig/prod.yaml get hpa -n ecommerce'

# 5. Soak Test (2시간, 장시간 안정성) - 시간 여유가 있을 때 실행
./scripts/run-loadtest.sh soak-test prod
```

---

## 4. 결과 분석

### 4.1 k6 출력 해석

```
     ✓ GET products status 2xx
     ✓ POST order status 2xx

     checks.....................: 99.2%  ✓ 14880  ✗ 120
     data_received..............: 45 MB  300 kB/s
     data_sent..................: 12 MB  80 kB/s

     http_req_duration..........: avg=45ms  min=2ms  med=25ms  max=2.1s  p(90)=120ms  p(95)=250ms  p(99)=890ms
     http_req_failed............: 0.80%
     http_reqs..................: 15000   100/s

     error_rate.................: 0.80%  ✓ (< 1%)
     ✓ http_req_duration........: p(95) < 500ms  ✓
                                  p(99) < 1000ms ✓
```

**핵심 지표 해석**:
- `p(95)=250ms`: 95%의 요청이 250ms 이내 (SLA 충족: < 500ms)
- `p(99)=890ms`: 99%의 요청이 890ms 이내 (SLA 충족: < 1000ms)
- `error_rate=0.80%`: 에러율 0.8% (SLA 충족: < 1%)
- `http_reqs=100/s`: 초당 100 요청 처리

### 4.2 병목 식별

```
자주 발생하는 병목 패턴:

1. order-service P99 > 1s
   원인: PostgreSQL 커넥션 풀 고갈 또는 RabbitMQ 발행 지연
   해결: 커넥션 풀 크기 증가, HPA 스케일아웃

2. product-service 첫 요청 느림
   원인: Redis 캐시 콜드 스타트, MongoDB 커넥션 초기화
   해결: 캐시 워밍업, 커넥션 풀 프리로드

3. stress-test에서 5xx 급증
   원인: HPA 스케일아웃 지연 (30초 안정화 대기)
   해결: stabilizationWindowSeconds 축소 또는 minReplicas 증가

4. soak-test에서 메모리 점진 증가
   원인: 메모리 누수 (주로 Node.js/Java에서)
   해결: 프로파일링, 힙 덤프 분석
```

### 4.3 HPA 스케일아웃 관찰

stress-test 실행 시 HPA 변화:

```
시간    order-svc  product-svc  cart-svc
00:00   3/10       3/10         3/8       ← 초기 상태
02:00   3/10       3/10         3/8       ← 500 VU 램프업
04:00   5/10       4/10         4/8       ← CPU 50% 초과, 스케일아웃 시작
06:00   7/10       6/10         5/8       ← 1000 VU
08:00   10/10      8/10         7/8       ← 2000 VU, 최대치 근접
10:00   10/10      10/10        8/8       ← HPA 최대, HPAMaxedOut 알림
13:00   7/10       6/10         5/8       ← 램프다운, 스케일다운 시작
18:00   3/10       3/10         3/8       ← 안정화 후 최소치 복귀
```

---

## 5. Grafana에서 결과 확인

부하 테스트 중 Grafana 대시보드에서 실시간 확인:

```bash
PLATFORM_IP=$(tart ip platform-master)
echo "Grafana: http://${PLATFORM_IP}:30300"

# 확인할 패널:
# 1. RPS 추이 → 부하 증가에 따른 처리량 변화
# 2. P95/P99 레이턴시 → SLA 위반 여부
# 3. Error Rate → 5xx 에러 급증 시점
# 4. HPA Replica Count → 스케일아웃/다운 타이밍
# 5. CPU/Memory 사용률 → 리소스 포화도
# 6. RabbitMQ Queue Depth → 메시지 적체 여부
```

---

## 6. 결과 정리

부하 테스트 후 다음을 정리한다:

```
| 시나리오 | RPS | P95 | P99 | 에러율 | 최대 Pod | 결과 |
|---------|-----|-----|-----|-------|---------|------|
| smoke   | 10  | 50ms | 120ms | 0% | 1 | PASS |
| average | 200 | 120ms | 350ms | 0.2% | 3 | PASS |
| peak    | 300 | 250ms | 890ms | 0.8% | 6 | PASS |
| stress  | 1000+ | 500ms | 2.1s | 3.2% | MAX | P99 초과 |
| soak    | 200 | 130ms | 400ms | 0.3% | 3 | PASS |
```

**결론**: MAU 1천만 피크 트래픽(~300 RPS)은 SLA를 충족하며 처리 가능. 버스트 트래픽(1000+ RPS)에서는 HPA 최대치에 도달하여 P99가 SLA를 초과하므로, maxReplicas 증가 또는 노드 추가가 필요하다.

---

## 마무리

이 10편의 블로그 시리즈를 통해 MAU 1천만 규모 e-commerce 플랫폼의 전체 구현 과정을 다루었다:

1. 트래픽 산출 및 아키텍처 설계
2. Tart VM + K8s 멀티클러스터 구축
3. 5개 언어 마이크로서비스 개발
4. Docker 빌드 + Kustomize 배포
5. DB 3종 + RabbitMQ 구성
6. HPA + KEDA 오토스케일링
7. Istio 서비스 메시
8. Prometheus + Grafana + EFK 모니터링
9. ArgoCD GitOps
10. k6 부하 테스트 및 분석

각 편의 코드와 설정은 이 프로젝트의 해당 디렉토리에서 확인할 수 있다.
