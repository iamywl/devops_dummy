# 시스템 아키텍처 상세

> MAU 1천만 e-commerce 플랫폼의 전체 아키텍처 설계 문서.
> 각 계층의 역할, 서비스 간 통신 흐름, 데이터 흐름을 상세히 기술한다.

---

## 1. 전체 아키텍처 개요

### 1.1 멀티티어 구조

```
┌─────────────────────────────────────────────────────────────────────┐
│                        TRAFFIC LAYER                                │
│  HAProxy (L4/L7 LB) → Nginx Ingress Controller (NodePort:30080)    │
│  Rate Limiting: 100 req/s per IP, stick-table 기반                  │
└──────────┬──────────────────────────────┬───────────────────────────┘
           │                              │
┌──────────▼──────────┐    ┌──────────────▼──────────────┐
│     WEB TIER         │    │        WAS TIER              │
│  nginx-static        │    │  order-service   (Java)      │
│  apache-legacy       │    │  product-service (Node.js)   │
│                      │    │  cart-service    (Go)         │
│                      │    │  user-service   (Python)      │
│                      │    │  review-service (Rust)        │
│                      │    │  notification-worker (Node.js)│
└──────────────────────┘    └──────────────┬───────────────┘
                                           │
┌──────────────────────────────────────────▼───────────────────────────┐
│                        DATA TIER                                     │
│  PostgreSQL 16 (주문/유저)  │  MongoDB 7 (상품/리뷰)  │  Redis 7 (캐시) │
│                            │                         │                 │
│                        RabbitMQ 3 (이벤트 큐)                          │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 계층별 역할

| 계층 | 구성요소 | 역할 |
|------|---------|------|
| **Traffic** | HAProxy, Nginx Ingress | L4/L7 로드밸런싱, Rate Limiting, TLS 종단 |
| **WEB** | nginx-static, apache-legacy | 정적 파일 서빙, 리버스 프록시, 레거시 호환 |
| **WAS** | 5개 마이크로서비스 + 1 워커 | 비즈니스 로직, REST API, 이벤트 처리 |
| **Message** | RabbitMQ | 비동기 이벤트 처리 (order → notification) |
| **Data** | PostgreSQL, MongoDB, Redis | 영속 데이터, 문서 저장, 인메모리 캐시 |

---

## 2. 서비스 상세

### 2.1 WAS 서비스 (5개, 5개 언어)

| 서비스 | 언어/프레임워크 | 포트 | 데이터베이스 | 핵심 기능 |
|--------|---------------|------|------------|----------|
| **order-service** | Java 17 / Spring Boot 3.x / Tomcat | 8080 | PostgreSQL | 주문 CRUD, 주문 상태 관리 (PENDING→CONFIRMED→SHIPPED→DELIVERED/CANCELLED), RabbitMQ 이벤트 발행, Scouter APM |
| **product-service** | Node.js 20 / Express | 3000 | MongoDB + Redis | 상품 CRUD, 텍스트 검색, 카테고리 필터, 가격/정렬, Redis 캐시 (TTL 60s), 10개 샘플 데이터 자동 시딩 |
| **cart-service** | Go 1.22 / net/http | 8081 | Redis | 장바구니 CRUD, 수량 변경, 개별 삭제, 24시간 TTL, checkout (→ order-service HTTP 호출) |
| **user-service** | Python 3.12 / FastAPI / Uvicorn | 8000 | PostgreSQL | 회원가입/로그인 (JWT), 프로필 수정, 비밀번호 변경, 세션 관리, 관리자/사용자 역할 |
| **review-service** | Rust 1.77 / Actix-web | 8082 | MongoDB | 리뷰 CRUD, 별점 통계 (MongoDB aggregation), 중복 방지, 소유자 검증, 페이지네이션 |

### 2.2 Worker 서비스 (1개)

| 서비스 | 언어 | 역할 |
|--------|------|------|
| **notification-worker** | Node.js 20 | RabbitMQ 3개 큐 소비 (order.created, order.shipped, order.cancelled), 알림 채널 시뮬레이션 (email/SMS/push), Redis에 알림 이력 저장 |

### 2.3 WEB 서비스 (2개)

| 서비스 | 엔진 | 역할 |
|--------|------|------|
| **nginx-static** | Nginx 1.24 | SPA 프론트엔드 서빙, API 리버스 프록시, proxy_cache (L1 캐시) |
| **apache-legacy** | Apache HTTPD 2.4 | 레거시 시스템 호환 데모, mod_proxy 리버스 프록시 |

---

## 3. 서비스 간 통신 흐름

### 3.1 주문 생성 플로우 (동기 + 비동기)

```
[Frontend SPA]
     │ POST /api/orders
     ▼
[Nginx Ingress] ─→ [order-service (Tomcat)]
                          │
                          ├─ 1. PostgreSQL INSERT (주문 저장)
                          │
                          ├─ 2. RabbitMQ PUBLISH
                          │     Exchange: order.exchange (topic)
                          │     Routing Keys:
                          │       order.created  → 신규 주문
                          │       order.shipped  → 배송 시작
                          │       order.cancelled → 주문 취소
                          │
                          └─ 3. HTTP 201 응답
                                    │
                                    ▼ (비동기)
                          [notification-worker]
                            ├─ 이메일 알림 시뮬레이션
                            ├─ SMS 알림 시뮬레이션
                            ├─ Push 알림 시뮬레이션
                            └─ Redis LPUSH (알림 이력 저장, 최근 100건)
```

### 3.2 장바구니 → 주문 전환 플로우 (서비스 간 HTTP 통신)

```
[Frontend SPA]
     │ POST /api/cart/checkout
     ▼
[cart-service (Go)]
     │
     ├─ 1. Redis HGETALL (장바구니 조회)
     │
     ├─ 2. HTTP POST → order-service:8080/api/orders
     │     (장바구니 → 주문 변환)
     │
     ├─ 3. Redis DEL (장바구니 비우기)
     │
     └─ 4. HTTP 200 응답 (주문 ID 반환)
             cart_checkouts_total 메트릭 증가
```

### 3.3 상품 조회 플로우 (캐시 계층)

```
[Frontend SPA]
     │ GET /api/products?category=electronics&sort=price
     ▼
[Nginx proxy_cache] ─ HIT → 즉시 응답 (L1)
     │ MISS
     ▼
[product-service (Express)]
     │
     ├─ Redis GET → HIT → 응답 (L2, TTL 60s)
     │
     └─ MISS → MongoDB find() → Redis SET → 응답 (L3)
```

---

## 4. 데이터 아키텍처

### 4.1 데이터베이스 분리 전략

| DB | 서비스 | 데이터 특성 | 선택 이유 |
|----|--------|-----------|----------|
| **PostgreSQL 16** | order-service, user-service | 트랜잭션 필요, 정합성 중요 | ACID, JOIN, 외래키 제약 |
| **MongoDB 7** | product-service, review-service | 스키마 유연, 비정규화 | 문서형, 텍스트 검색, aggregation |
| **Redis 7** | cart-service, product-service(캐시), user-service(세션), notification-worker(이력) | 빠른 R/W, TTL | 인메모리, Hash/List/String |

### 4.2 메시지 큐 설계

```
RabbitMQ 3
├── Exchange: order.exchange (type: topic)
│   ├── Queue: order.created   ← Binding Key: order.created
│   ├── Queue: order.shipped   ← Binding Key: order.shipped
│   └── Queue: order.cancelled ← Binding Key: order.cancelled
│
├── Producer: order-service (Spring AMQP)
│   └── 주문 상태 변경 시 해당 이벤트 발행
│
└── Consumer: notification-worker (amqplib)
    └── 3개 큐 각각 구독, 채널별 알림 처리
```

---

## 5. 멀티클러스터 아키텍처

### 5.1 클러스터 배치 전략

```
┌───────────────────────────────────────────────────────────────┐
│                    Apple Silicon Host (128GB)                   │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ PLATFORM Cluster (7C/24G, 3 nodes)                       │  │
│  │ → Prometheus, Grafana, ArgoCD, Jaeger, Loki, Scouter     │  │
│  │ → 모든 앱 클러스터의 메트릭/로그를 중앙 수집              │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌───────────┐  ┌────────────────┐  ┌──────────────────────┐  │
│  │ DEV       │  │ STAGING        │  │ PROD                 │  │
│  │ 4C/12G    │  │ 8C/24G         │  │ 13C/48G              │  │
│  │ 2 nodes   │  │ 3 nodes        │  │ 5 nodes              │  │
│  │           │  │                │  │                      │  │
│  │ 1 replica │  │ 2 replicas     │  │ 3 replicas (base)    │  │
│  │ Istio on  │  │ topology spread│  │ HPA max 10           │  │
│  │ debug log │  │ prod-like      │  │ KEDA max 10          │  │
│  │           │  │                │  │ PDB minAvailable 2   │  │
│  │           │  │                │  │ podAntiAffinity      │  │
│  └───────────┘  └────────────────┘  └──────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

### 5.2 환경별 차이

| 설정 | dev | staging | prod |
|------|-----|---------|------|
| namePrefix | dev- | staging- | prod- |
| replicas (base) | 1 | 2 | 3 |
| HPA | 없음 | 없음 | 6개 (max 6~10) |
| KEDA | 없음 | 없음 | 1개 (max 10) |
| PDB | 없음 | 없음 | 8개 |
| topology spread | 없음 | ScheduleAnyway | DoNotSchedule |
| pod anti-affinity | 없음 | 없음 | preferred |
| LOG_LEVEL | debug | info | warn |
| Istio | 활성화 | 비활성화 | 비활성화 |

---

## 6. 네트워크 아키텍처

### 6.1 트래픽 흐름

```
[외부 트래픽]
     │
     ▼ (NodePort 30080)
[Nginx Ingress Controller]
     │ 경로 기반 라우팅:
     │  /              → nginx-static (프론트엔드)
     │  /api/orders    → order-service
     │  /api/products  → product-service
     │  /api/cart      → cart-service
     │  /api/users     → user-service
     │  /api/reviews   → review-service
     │  /legacy        → apache-legacy
     ▼
[ClusterIP Service] → [Pod (Deployment/StatefulSet)]
```

### 6.2 서비스 포트 맵

| 서비스 | ClusterIP Port | NodePort | 프로토콜 |
|--------|---------------|----------|---------|
| nginx-static | 80 | 30080 (via Ingress) | HTTP |
| order-service | 8080 | - | HTTP |
| product-service | 3000 | - | HTTP |
| cart-service | 8081 | - | HTTP |
| user-service | 8000 | - | HTTP |
| review-service | 8082 | - | HTTP |
| postgresql | 5432 | - | TCP |
| mongodb | 27017 | - | TCP |
| redis | 6379 | - | TCP |
| rabbitmq | 5672 / 15672 | 31672 | AMQP / HTTP |
| haproxy stats | 8404 | 30884 | HTTP |
| kibana | 5601 | 31601 | HTTP |
| scouter webapp | 6188 | 30618 | HTTP |

---

## 7. 모니터링 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│                    PLATFORM Cluster                          │
│                                                              │
│  ┌──────────────┐  ┌──────────┐  ┌────────────────────────┐ │
│  │ Prometheus   │  │ Grafana  │  │ ArgoCD                 │ │
│  │ ServiceMonitor│  │ Dashboard│  │ App-of-Apps            │ │
│  │ → scrape     │  │ → 시각화  │  │ → GitOps Sync          │ │
│  └──────┬───────┘  └────┬─────┘  └────────────────────────┘ │
│         │               │                                    │
│  ┌──────▼───────┐  ┌────▼─────┐  ┌────────────────────────┐ │
│  │ PrometheusRule│  │ Alertmgr │  │ Scouter APM            │ │
│  │ SLA 알림     │  │ → 통보   │  │ → Java Agent (order)   │ │
│  └──────────────┘  └──────────┘  │ → Collector + WebApp   │ │
│                                   └────────────────────────┘ │
│  ┌───────────────────────────────────────────────────────┐   │
│  │ EFK Stack                                              │   │
│  │ Fluentd (DaemonSet) → Elasticsearch → Kibana           │   │
│  └───────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 7.1 메트릭 수집 경로

| 서비스 | 메트릭 엔드포인트 | 라이브러리 |
|--------|-----------------|----------|
| order-service | /actuator/prometheus | Spring Boot Actuator + Micrometer |
| product-service | /metrics | prom-client (Node.js) |
| cart-service | /metrics | promhttp (Go) |
| user-service | /metrics | prometheus-fastapi-instrumentator |
| review-service | /metrics | actix-web-prom |
| notification-worker | /metrics | prom-client (Node.js) |

---

## 8. 보안 아키텍처

### 8.1 Istio 서비스 메시 (dev 클러스터)

```yaml
# mTLS: 서비스 간 통신 암호화
PeerAuthentication:
  mode: STRICT  # 모든 통신 mTLS 강제

# 서킷브레이커: 장애 전파 차단
DestinationRule:
  outlierDetection:
    consecutive5xxErrors: 3
    interval: 10s
    baseEjectionTime: 30s
    maxEjectionPercent: 50

# 재시도 + 타임아웃
VirtualService:
  retries:
    attempts: 3
    perTryTimeout: 2s
  timeout: 10s
```

### 8.2 시크릿 관리

- DB 비밀번호: Kubernetes Secret (`manifests/base/data-tier/secrets.yaml`)
- `.gitignore`에 `*.secret`, `*.key`, `kubeconfig/` 등록
- 프로덕션에서는 외부 시크릿 관리 (Vault, Sealed Secrets) 권장

---

## 9. 확장성 설계

### 9.1 수평 확장 (HPA + KEDA)

- **CPU 기반 (HPA)**: order, product, cart, user, review, nginx → CPU 50~60% 초과 시 스케일아웃
- **이벤트 기반 (KEDA)**: notification-worker → RabbitMQ 큐 깊이 5 초과 시 스케일아웃
- **burst 대응**: Percent 기반 정책 (50% 증가) + Pods 기반 정책 (3개 추가), selectPolicy: Max

### 9.2 안정성 확보 (PDB)

- Critical 서비스 (order, product, cart, user): `minAvailable: 2` → 롤링 업데이트 시 최소 2개 보장
- Non-critical 서비스 (review, nginx, postgresql, rabbitmq): `minAvailable: 1`

### 9.3 분산 배치

- `topologySpreadConstraints`: 노드 간 Pod 균등 분배 (maxSkew: 1)
- `podAntiAffinity`: 같은 노드에 동일 서비스 Pod 배치 최소화
- prod 워커 3대에 WAS 분산, 워커 1대는 데이터 티어 전용
