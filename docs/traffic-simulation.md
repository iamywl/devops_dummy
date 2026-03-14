# MAU 1천만 트래픽 시뮬레이션 설계

> MAU 10,000,000 서비스의 트래픽 패턴을 분석하고,
> k6 부하 테스트 시나리오로 매핑하는 과정을 상세히 기술한다.

---

## 1. 트래픽 산출 근거

### 1.1 MAU → RPS 변환

```
MAU: 10,000,000명

Step 1: DAU 산출
  MAU / 30 = ~333,000 DAU
  (일반적 MAU:DAU 비율 = 30:1 ~ 10:1, 보수적으로 30:1 적용)

Step 2: 세션 수
  5 세션/유저/일 (앱 3회 + 웹 2회)

Step 3: 세션당 요청 수
  10 요청/세션
  (페이지뷰 3 + API 호출 5 + 정적 리소스 2)

Step 4: 일일 총 요청
  333,000 × 5 × 10 = 16,650,000 req/day

Step 5: 평균 RPS
  16,650,000 / 86,400 = ~193 RPS

Step 6: 피크 시간대 (피크 팩터 3x)
  피크 일일 요청: ~50,000,000 req/day
  피크 시간 집중: 일일 트래픽 20% = ~10,000,000 req/hour
  피크 RPS: ~278 RPS

Step 7: 버스트 피크 (이벤트, 세일)
  피크의 2~4배: ~500~1,000 RPS
```

### 1.2 트래픽 분포 (시간대별)

```
RPS
1000 │                    ╱╲ (이벤트/세일 버스트)
 800 │                   ╱  ╲
 600 │                  ╱    ╲
 400 │         ╱──────╲╱      ╲──────╲
 300 │        ╱ 피크 시간대              ╲
 200 │───────╱ (11:00~15:00,              ╲───────
 100 │        19:00~22:00)
  50 │  새벽 (02:00~06:00)
     └────────────────────────────────────────────
     0    4    8   12   16   20   24  시간
```

---

## 2. e-commerce 트래픽 패턴

### 2.1 API 호출 비율

| 패턴 | API | 비율 | 특성 |
|------|-----|------|------|
| 상품 목록 조회 | GET /api/products | 50% | Redis 캐시 HIT 90%+ |
| 상품 상세 조회 | GET /api/products/:id | 20% | Redis 캐시 HIT 80%+ |
| 장바구니 조작 | POST/GET/PUT/DELETE /api/cart | 15% | Redis 직접 R/W, 빠름 |
| 주문 생성 | POST /api/orders | 5% | DB Write + MQ Publish (무거움) |
| 유저 관련 | POST/GET /api/users | 5% | 로그인/회원가입, JWT |
| 리뷰 관련 | POST/GET /api/reviews | 5% | MongoDB Write/Read |

### 2.2 읽기:쓰기 비율

```
전체 비율: 읽기 70% : 쓰기 30%

읽기 (70%):
  ├── 상품 목록 조회 (50%) → 대부분 캐시 HIT
  └── 상품 상세 조회 (20%) → 캐시 또는 MongoDB

쓰기 (30%):
  ├── 장바구니 (15%) → Redis (가벼움)
  ├── 주문 생성 (5%) → PostgreSQL + RabbitMQ (무거움)
  ├── 유저 (5%) → PostgreSQL (보통)
  └── 리뷰 (5%) → MongoDB (보통)
```

---

## 3. k6 시나리오 설계

### 3.1 시나리오 개요

| 시나리오 | 파일 | VU | 시간 | 예상 RPS | 목적 |
|---------|------|-----|------|---------|------|
| **smoke** | `smoke.js` | 10 | 1분 | ~10 | 배포 후 기본 동작 확인 |
| **average-load** | `average-load.js` | 200 | 10분 | ~200 | 평일 평균 트래픽 시뮬레이션 |
| **peak-load** | `peak-load.js` | 500 | 15분 | ~300 | MAU 1천만 피크 시간대 |
| **stress-test** | `stress-test.js` | 2000 | 20분 | ~1000+ | 한계점 탐색, HPA 트리거 |
| **soak-test** | `soak-test.js` | 200 | 2시간 | ~200 | 장시간 안정성, 메모리 누수 |

### 3.2 시나리오별 상세

#### Smoke Test (smoke.js)

```
목적: 배포 직후 모든 엔드포인트가 정상 응답하는지 확인
패턴: 10 VU × 1분, 모든 API 순회
SLA: P95 < 500ms, 에러율 < 1%
트리거: scripts/deploy.sh 이후 자동 실행

VU
10 │ ──────────────────
   └─────────────────── time
   0                 1분
```

#### Average Load (average-load.js)

```
목적: 평일 일반 트래픽에서 서비스 안정성 확인
패턴: ramp-up 2분 → 200 VU 유지 6분 → ramp-down 2분
SLA: P95 < 500ms, P99 < 1s, 에러율 < 0.5%
관찰: 응답 시간 추이, 캐시 HIT 비율

VU
200│      ┌────────────┐
   │     ╱              ╲
   │    ╱                ╲
   └───╱──────────────────╲── time
   0  2분              8분 10분
```

#### Peak Load (peak-load.js)

```
목적: MAU 1천만 피크 시간대 (~278 RPS) 시뮬레이션
패턴: ramp-up 3분 → 500 VU 유지 9분 → ramp-down 3분
SLA: P95 < 800ms, P99 < 2s, 에러율 < 1%
관찰: HPA 스케일업 시작, Redis 캐시 효과

VU
500│      ┌────────────┐
   │     ╱              ╲
   │    ╱                ╲
   └───╱──────────────────╲── time
   0  3분             12분 15분
```

#### Stress Test (stress-test.js)

```
목적: 서비스 한계점(breaking point) 탐색, HPA 최대 스케일아웃 유도
패턴: 단계적 증가 200 → 500 → 1000 → 2000 VU
SLA: 없음 (한계 탐색)
관찰: 언제 P99 > 2s 되는지, 언제 에러 발생하는지, HPA max 도달 시점

VU
2000│                  ┌──────┐
1000│            ┌─────┘      │
 500│      ┌─────┘            │
 200│ ┌────┘                  │
    └─┘───────────────────────┘ time
    0  5분  10분  15분       20분
```

#### Soak Test (soak-test.js)

```
목적: 장시간 운영 안정성 확인 (메모리 누수, 커넥션 풀 고갈)
패턴: 200 VU × 2시간 지속
SLA: P95 < 500ms (2시간 내내), 에러율 < 0.1%
관찰: 메모리 증가 추이, GC 패턴, 커넥션 수, Pod 재시작

VU
200│ ────────────────────────────────────────
   └──────────────────────────────────────── time
   0                                      2시간
```

---

## 4. SLA/SLO 정의

### 4.1 서비스별 SLO

| 서비스 | 가용성 | P95 레이턴시 | P99 레이턴시 | 에러율 |
|--------|--------|------------|------------|--------|
| order-service | 99.9% | < 500ms | < 1s | < 0.5% |
| product-service | 99.9% | < 200ms | < 500ms | < 0.5% |
| cart-service | 99.9% | < 100ms | < 300ms | < 0.5% |
| user-service | 99.9% | < 300ms | < 800ms | < 0.5% |
| review-service | 99.5% | < 300ms | < 800ms | < 1% |
| nginx-static | 99.9% | < 50ms | < 200ms | < 0.1% |

### 4.2 Prometheus 알림 규칙 매핑

```yaml
# sla-rules.yaml에 정의된 알림
OrderServiceHighLatency:
  조건: P99 > 1s (5분 지속)
  심각도: warning
  대응: HPA 스케일업 확인, DB 커넥션 풀 확인

HighErrorRate:
  조건: 에러율 > 1% (5분 지속)
  심각도: critical
  대응: Pod 상태 확인, 로그 분석, 서킷브레이커 상태

PodRestartLoop:
  조건: 1시간 내 3회 이상 재시작
  심각도: warning
  대응: OOMKilled 확인, 리소스 limit 조정

HPAMaxedOut:
  조건: maxReplicas 도달 5분 이상
  심각도: warning
  대응: maxReplicas 증가 또는 리소스 최적화

RabbitMQQueueBacklog:
  조건: 큐 메시지 100개 초과 (5분 지속)
  심각도: warning
  대응: KEDA 스케일링 확인, consumer 처리 속도 확인
```

---

## 5. 부하 테스트 실행 가이드

### 5.1 실행 방법

```bash
# Smoke 테스트 (배포 후 기본 검증)
./scripts/run-loadtest.sh smoke dev

# Average Load (일반 트래픽)
./scripts/run-loadtest.sh average-load dev

# Peak Load (피크 시간대 - prod 권장)
./scripts/run-loadtest.sh peak-load prod

# Stress Test (한계 탐색 - prod 권장)
./scripts/run-loadtest.sh stress-test prod

# Soak Test (장시간 안정성)
./scripts/run-loadtest.sh soak-test prod
```

### 5.2 결과 분석 포인트

```
1. 응답 시간 추이
   → 시간이 지남에 따라 증가하면 → 메모리 누수 또는 커넥션 풀 문제

2. 에러율 변화
   → 특정 VU 수 이상에서 급증하면 → 해당 지점이 breaking point

3. HPA 반응 시간
   → CPU 50% 초과 후 몇 초 만에 스케일업 시작되는지
   → stabilizationWindowSeconds (30s) + 메트릭 수집 주기 (15s) = ~45s

4. 캐시 HIT 비율
   → product-service의 Redis 캐시 HIT 비율 확인
   → 90% 이상이어야 DB 부하 감소 효과

5. RabbitMQ 큐 깊이
   → 주문 생성 부하 시 큐 깊이 변화
   → KEDA가 notification-worker를 스케일업하는 시점 확인
```

### 5.3 결과 저장

```bash
# k6 JSON 결과 저장
k6 run --out json=loadtest/results/peak-load-$(date +%Y%m%d).json \
  loadtest/k6/scenarios/peak-load.js

# 결과 비교 (이전 결과와)
# loadtest/results/ 디렉토리에 날짜별 저장
```

---

## 6. 용량 산정

### 6.1 서비스별 예상 Pod 수 (피크 시)

| 서비스 | 평시 | 피크 | 버스트 | 트리거 |
|--------|------|------|--------|--------|
| order-service | 3 | 5-6 | 8-10 | CPU > 50% |
| product-service | 3 | 4-5 | 7-10 | CPU > 50% |
| cart-service | 3 | 4-5 | 6-8 | CPU > 50% |
| user-service | 3 | 4 | 5-8 | CPU > 50% |
| review-service | 2 | 3 | 4-6 | CPU > 50% |
| nginx-static | 2 | 3 | 4-6 | CPU > 60% |
| notification-worker | 1 | 3-5 | 7-10 | 큐 > 5 |
| **합계** | **17** | **26-33** | **41-58** | |

### 6.2 노드 용량

```
prod 클러스터 워커 노드 (4대):
  worker1 (3C/12G): WAS 서비스 HA
  worker2 (3C/12G): WAS 서비스 HA
  worker3 (3C/12G): WAS 스케일아웃 버퍼
  worker4 (2C/8G):  데이터 티어 (PostgreSQL, MongoDB, Redis, RabbitMQ)

총 가용 리소스: 11C/44G
단일 레플리카 합계: ~1.3C/2.5G
풀 스케일아웃 시: ~5.8C/14.5G (44G RAM 기준 충분)
```
