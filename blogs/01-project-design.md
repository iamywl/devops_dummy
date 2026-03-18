# 01. 프로젝트 설계: MAU 1천만을 어떻게 로컬에서 재현할 것인가

## 핵심 요약

MAU 1천만 서비스의 트래픽 패턴을 수학적으로 산출하고, 이를 로컬 Apple Silicon Mac 위에서 재현 가능한 규모로 설계한다. 13대의 경량 VM 위에 4개 K8s 클러스터를 구축하고, 7개 마이크로서비스 + 3종 DB + MQ + 모니터링 + 서비스 메시를 배치한다.

---

## 1. 트래픽 규모 산출

서비스의 규모를 정하는 것은 인프라 설계의 출발점이다. "MAU 1천만"이라는 숫자를 실제 인프라 사양으로 변환해야 한다.

### 1.1 MAU → RPS 환산 공식

```
MAU 10,000,000명
├── DAU = MAU / 30 = ~333,000명/일
│   (일반적인 e-commerce DAU/MAU 비율: 3~5%)
│
├── 유저당 세션 = 5 세션/일
│   (모바일 앱 기준 평균 세션 수)
│
├── 세션당 요청 = 10 요청/세션
│   (페이지 로드 + API 호출 합산)
│
├── 일일 총 요청 = 333K × 5 × 10 = 16,650,000 req/day
│
├── 평균 RPS = 16.65M / 86,400초 = ~193 RPS
│
├── 피크 팩터 = 3x
│   (점심/저녁 시간대에 트래픽 집중)
│
├── 피크 RPS = 193 × 3 ≈ 580 RPS
│   (평균 RPS의 3배, 점심/저녁 피크 시간대)
│
└── 버스트 피크 = 500~1000 RPS
    (타임세일, 이벤트, 푸시 알림 직후)
```

### 1.2 트래픽 패턴 분석

실제 e-commerce 서비스의 API 호출 비율을 분석하면:

```
읽기 : 쓰기 = 85 : 15

구체적으로:
├── 50% 상품 목록 조회 (GET /api/products)
│   → 캐시 적중률 90% 이상 기대
│
├── 20% 상품 상세 조회 (GET /api/products/:id)
│   → 캐시 적중률 80% 이상 기대
│
├── 15% 장바구니 조작 (POST/GET /api/cart)
│   → Redis 직접 읽기/쓰기 (영속성 불필요)
│
└── 15% 주문 생성 (POST /api/orders)
    → DB 쓰기 + MQ 발행 (가장 무거운 연산)
    → 이 15%가 시스템 병목의 핵심
```

### 1.3 이 수치가 인프라 설계에 미치는 영향

| 산출 결과 | 설계 결정 |
|----------|----------|
| 피크 580 RPS | prod 클러스터에 WAS 3-10 레플리카, HPA 활성화 |
| 읽기 70% | product-service에 Redis 캐시 계층 추가 (TTL 60초) |
| 주문 15% | order-service에 가장 높은 리소스 할당 (100m-500m CPU) |
| 버스트 1000 RPS | stress-test 시나리오로 HPA 한계점 탐색 |
| 비동기 알림 | RabbitMQ + notification-worker + KEDA 이벤트 스케일링 |

---

## 2. 아키텍처 설계

### 2.1 3-Tier 아키텍처 선택 이유

```
┌─────────┐    ┌─────────┐    ┌─────────┐
│ WEB Tier │ →  │ WAS Tier │ →  │Data Tier│
│ Nginx    │    │ 5개 서비스│    │ 3종 DB  │
│ Apache   │    │ + 1 워커 │    │ + MQ    │
│ HAProxy  │    │          │    │         │
└─────────┘    └─────────┘    └─────────┘
```

**왜 3-Tier인가**:
- 각 계층을 독립적으로 스케일링할 수 있음 (WEB은 2-6, WAS는 3-10)
- 장애 격리: WEB이 죽어도 WAS/DB는 영향 없음
- 보안: WEB만 외부에 노출, WAS/DB는 내부 네트워크
- 실무에서 가장 보편적인 구조이므로 운영 역량 증명에 적합

### 2.2 마이크로서비스 분리 기준

도메인 주도 설계(DDD)의 Bounded Context 개념을 적용:

| 서비스 | Bounded Context | 데이터 소유권 | 독립 배포 가능 |
|--------|----------------|-------------|--------------|
| order-service | 주문 관리 | orders 테이블 (PostgreSQL) | O |
| product-service | 상품 카탈로그 | products 컬렉션 (MongoDB) | O |
| cart-service | 장바구니 | cart:{userId} 키 (Redis) | O |
| user-service | 사용자 인증 | users 테이블 (PostgreSQL) | O |
| review-service | 리뷰 관리 | reviews 컬렉션 (MongoDB) | O |
| notification-worker | 알림 발송 | 데이터 미소유 (이벤트 소비) | O |

**핵심**: 각 서비스가 자신의 데이터를 독점적으로 소유한다. 다른 서비스의 DB에 직접 접근하지 않고, API 또는 이벤트로만 통신한다.

### 2.3 멀티클러스터 설계

```
┌────────────────┐
│ platform       │  → 모니터링/관리 전용 (Prometheus, Grafana, ArgoCD)
│ 7C / 24GB      │  → 앱과 분리하여 모니터링 시스템의 안정성 보장
└────────────────┘

┌──────┐ ┌──────────┐ ┌──────────────┐
│ dev  │ │ staging  │ │ prod         │
│ 4C   │ │ 8C       │ │ 13C          │
│ 12GB │ │ 24GB     │ │ 48GB         │
│      │ │          │ │              │
│ 1 rep│ │ 2 rep    │ │ 3 rep + HPA  │
│ debug│ │ info     │ │ warn         │
│      │ │ topology │ │ HPA+KEDA+PDB │
│      │ │ spread   │ │ antiAffinity │
└──────┘ └──────────┘ └──────────────┘
```

**왜 4개 클러스터인가**:
- **환경 격리**: dev에서 실험해도 prod에 영향 없음
- **점진적 배포**: dev → staging → prod 순으로 검증
- **모니터링 독립**: platform 클러스터가 죽어도 앱 클러스터는 정상 동작
- **실무 재현**: 대부분의 기업이 최소 dev/staging/prod 분리

---

## 3. 기술 선택 의사결정

### 3.1 언어/프레임워크 선택 매트릭스

```
              성능     메모리     개발속도    생태계    선택된 서비스
Java/Spring   ★★★     ★★       ★★★★      ★★★★★   order (트랜잭션)
Node.js       ★★★★    ★★★      ★★★★★     ★★★★    product (비동기I/O)
Go            ★★★★★   ★★★★★    ★★★       ★★★     cart (경량)
Python        ★★★     ★★★      ★★★★★     ★★★★    user (빠른개발)
Rust          ★★★★★   ★★★★★    ★★        ★★      review (안전성)
```

### 3.2 DB 선택 의사결정 트리

```
데이터 특성 분석:
│
├── 트랜잭션 정합성 필수?
│   ├── YES → PostgreSQL
│   │   └── 주문 (금액, 상태), 유저 (인증 정보)
│   │
│   └── NO → 다음 질문
│
├── 스키마가 자주 변경되거나 비정형?
│   ├── YES → MongoDB
│   │   └── 상품 (카테고리별 속성 다름), 리뷰 (텍스트+평점)
│   │
│   └── NO → 다음 질문
│
└── 빠른 읽기/쓰기, 임시 데이터?
    └── YES → Redis
        └── 캐시 (TTL 60s), 세션 (JWT), 장바구니 (TTL 24h)
```

---

## 4. 리소스 계획

### 4.1 VM 리소스 배분

호스트 머신: Apple Silicon Mac, 16 cores, 128GB RAM

```
총 10 VM = 21 vCPU + 약 67GB RAM (오버커밋 비율 약 1.3:1)

platform: master(2C/4G) + worker1(3C/12G) + worker2(2C/8G) = 7C/24G
dev:      master(2C/4G) + worker1(2C/8G) = 4C/12G
staging:  master(2C/4G) + worker1(2C/8G) = 4C/12G
prod:     master(2C/3G) + worker1(2C/8G) + worker2(2C/8G) = 6C/19G
```

### 4.2 Pod 리소스 설계 원칙

```
request = 평상시 사용량 (스케줄링 기준)
limit   = 최대 허용량 (OOMKill 방지)

설계 원칙:
├── limit / request 비율 = 2~5x
│   (버스트 허용하되 과도한 자원 독점 방지)
│
├── Java(Spring Boot): request 100m/256Mi, limit 500m/512Mi
│   (JVM 힙 크기가 고정적이므로 메모리 limit 넉넉히)
│
├── Go: request 50m/64Mi, limit 300m/128Mi
│   (Go 바이너리는 경량, GC 오버헤드 최소)
│
└── Rust: request 30m/32Mi, limit 200m/64Mi
    (가장 적은 리소스, 메모리 안전 + 제로 오버헤드)
```

---

## 5. 직접 해보기

### 5.1 설계 문서 작성

프로젝트를 시작하기 전에 다음을 정리한다:

1. **트래픽 산출표** 작성 (MAU → DAU → RPS → 피크 RPS)
2. **서비스 목록** 정리 (이름, 언어, DB, 포트)
3. **VM 리소스 배분표** 작성 (클러스터별 vCPU, RAM)
4. **네트워크 설계** (NodePort 범위, 서비스 간 통신 방식)

### 5.2 디렉토리 구조 생성

```bash
mkdir -p devops_dummpy/{apps,manifests,scripts,monitoring,loadtest,argocd,helm,docs,blogs}

# 앱 디렉토리
for svc in order-service product-service cart-service user-service review-service notification-worker frontend; do
  mkdir -p devops_dummpy/apps/$svc
done

# 매니페스트 디렉토리
mkdir -p devops_dummpy/manifests/{base/{web-tier,was-tier,data-tier,messaging,loadbalancer,logging,monitoring,ingress},overlays/{dev,staging,prod},istio}

# 모니터링
mkdir -p devops_dummpy/monitoring/{service-monitors,prometheus-rules,grafana-dashboards}

# 부하 테스트
mkdir -p devops_dummpy/loadtest/k6/{scenarios,lib}

echo "디렉토리 구조 생성 완료"
find devops_dummpy -type d | head -30
```

---

## 다음 편

[02. Tart VM으로 K8s 멀티클러스터 구축하기](02-tart-vm-kubernetes.md)에서는 설계한 인프라를 실제로 구축한다.
