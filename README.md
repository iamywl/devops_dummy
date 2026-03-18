# MAU 1천만 E-Commerce Platform

> Apple Silicon Mac 위에 Tart VM + Kubernetes 멀티클러스터를 구축하고,
> **실제 MAU 1천만 규모의 트래픽 패턴을 시뮬레이션하여 오토스케일링이 작동하는 것을 증명**하는 프로젝트

---

## 1. 프로젝트 개요

### 1.1 무엇을 구현했는가

7개 마이크로서비스로 구성된 e-commerce 플랫폼을 Kubernetes 멀티클러스터(dev/staging/prod) 위에 배포하고, MAU 1천만 규모 트래픽을 k6로 시뮬레이션하여 HPA/KEDA 기반 오토스케일링, Istio 서비스 메시, Prometheus/Grafana 모니터링, ArgoCD GitOps가 **실제로 동작**하는 것을 보여준다.

### 1.2 왜 만들었는가

DevOps 엔지니어로서 **대규모 서비스를 설계/배포/스케일링/모니터링할 수 있음**을 증명하기 위해 만들었다.

"쿠버네티스를 사용해봤습니다" 수준이 아니라, 다음을 직접 시연할 수 있어야 한다:

- **트래픽 규모 산출**: MAU → DAU → RPS → 피크 RPS로 이어지는 용량 산정
- **환경 분리**: dev(단일 레플리카) → staging(2 레플리카, prod 유사) → prod(HA + 오토스케일링)
- **부하 대응**: CPU 기반 HPA, 큐 기반 KEDA, PDB로 가용성 보장
- **장애 격리**: Istio 서킷브레이커, mTLS, 재시도 정책
- **관측성**: Prometheus 메트릭 → Grafana 대시보드 → SLA 알림 → 로그 수집(EFK)
- **자동화**: Kustomize/Helm 배포, ArgoCD GitOps, 스크립트 원클릭 구축

### 1.3 어떻게 구현했는가

```
[호스트: Apple Silicon Mac, 128GB RAM]
    │
    ├── Tart VM 10대 (Apple Virtualization Framework)
    │   ├── dev 클러스터:     master + worker1 (4 vCPU / 12GB)
    │   ├── staging 클러스터: master + worker1 (4 vCPU / 12GB)
    │   ├── prod 클러스터:    master + worker1,2 (6 vCPU / 19GB)
    │   └── platform 클러스터: master + worker1,2 (7 vCPU / 24GB)
    │       → Prometheus, Grafana, ArgoCD, Jaeger
    │
    ├── kubeadm으로 각 클러스터 부트스트랩
    │   └── Cilium CNI → eBPF 기반 고성능 네트워킹
    │
    ├── 7개 마이크로서비스 (5개 언어, 3개 DB, 1개 MQ)
    │   └── Docker 멀티스테이지 빌드 → containerd로 직접 로드
    │
    ├── Kustomize base/overlay로 환경별 배포
    │   └── prod: HPA + KEDA + PDB + topologySpread + podAntiAffinity
    │
    └── k6 부하 테스트 (smoke → average → peak → stress → soak)
        └── MAU 1천만 피크: 500 VU → ~300 RPS → HPA 스케일아웃 관찰
```

---

## 2. 핵심 설계 의사결정

### 2.1 왜 5개 언어를 사용했는가

| 서비스 | 언어/프레임워크 | 선택 이유 |
|--------|----------------|----------|
| order-service | Java 17 / Spring Boot 3.2 / Tomcat 10 | **엔터프라이즈 표준 WAS**. 주문은 트랜잭션 정합성이 최우선 → JPA + ACID. Scouter APM으로 Java WAS 모니터링 시연. 대부분의 국내 기업이 Tomcat 기반이므로 운영 역량 증명에 핵심 |
| product-service | Node.js 20 / Express | **비동기 I/O 기반 고성능 읽기 서비스**. 상품 조회는 전체 트래픽의 70%를 차지하는 읽기 위주 → Redis 캐시 + MongoDB 조합이 자연스러움. prom-client로 Prometheus 메트릭 노출 |
| cart-service | Go 1.22 / net/http | **최소 메모리, 최고 성능**. 장바구니는 단순 CRUD + Redis Hash 조작 → 프레임워크 없이 표준 라이브러리만으로 구현. 32Mi 메모리로 동작하는 초경량 서비스 |
| user-service | Python 3.12 / FastAPI | **비동기 ASGI + 자동 API 문서**. 사용자 인증은 JWT + Session 관리가 핵심 → FastAPI의 async SQLAlchemy + Pydantic 검증이 적합. Swagger 자동 생성 |
| review-service | Rust 1.77 / Actix-web | **메모리 안전 + 초고성능**. 리뷰는 MongoDB Aggregation Pipeline으로 평점 집계 → Rust의 소유권 모델이 동시성 안전성 보장. 가장 낮은 리소스(30m CPU, 32Mi mem)로 동작 |
| notification-worker | Node.js 20 / amqplib | **이벤트 소비자**. RabbitMQ 큐에서 주문 이벤트를 소비하여 알림 시뮬레이션. KEDA가 큐 깊이를 감지하여 워커 스케일링 |

**핵심 의도**: 실제 현업에서 마주치는 폴리글랏 마이크로서비스 환경을 재현하여, 특정 언어에 종속되지 않고 **서비스 특성에 맞는 기술을 선택할 수 있는 판단력**을 보여준다.

### 2.2 왜 DB를 3개로 분리했는가

| DB | 담당 서비스 | 선택 이유 |
|----|-----------|----------|
| PostgreSQL 16 | order-service, user-service | 주문과 사용자 데이터는 **ACID 트랜잭션이 필수**. 금액, 상태 변경, 유저 정보는 정합성이 깨지면 안 됨 |
| MongoDB 7 | product-service, review-service | 상품 카탈로그와 리뷰는 **스키마가 유동적**. 상품 속성(색상, 사이즈, 옵션)이 카테고리마다 다르고, 리뷰도 텍스트+이미지+평점 등 비정형 |
| Redis 7 | cart-service (주 저장소), product-service (캐시), user-service (세션) | 장바구니는 **24시간 TTL의 임시 데이터** → 인메모리가 적합. 상품 캐시는 60초 TTL로 DB 부하 경감. 세션은 JWT 검증용 |

**핵심 원칙**: 서비스별 데이터 특성에 맞는 DB를 선택하는 **Polyglot Persistence** 패턴. 모든 데이터를 하나의 RDBMS에 넣는 모놀리식 접근의 한계를 극복한다.

### 2.3 왜 RabbitMQ를 사용했는가

**동기**: 주문 생성 시 알림 전송을 동기적으로 처리하면 주문 API 응답 지연이 발생한다.

**해결**: Topic Exchange 기반 비동기 이벤트 발행.

```
order-service → [RabbitMQ Topic Exchange] → order.created 큐
                                          → order.shipped 큐
                                          → order.cancelled 큐
                                                    ↓
                                          notification-worker (소비)
                                                    ↓
                                          이메일/SMS/푸시 시뮬레이션
```

**KEDA 연동**: 큐에 메시지가 5개 이상 쌓이면 notification-worker Pod를 자동 스케일아웃 (최대 10개). 큐가 비면 1개로 축소. 이것이 **이벤트 드리븐 오토스케일링**의 핵심.

### 2.4 왜 HAProxy를 추가했는가

Nginx Ingress Controller가 이미 L7 라우팅을 담당하지만, HAProxy를 별도로 두는 이유:

- **L4 로드밸런싱**: TCP 레벨에서 백엔드 헬스체크 + 가중치 기반 분산
- **stick-table Rate Limiting**: IP별 100 req/s 제한을 커널에 가까운 레벨에서 처리
- **Stats UI**: 실시간 트래픽 모니터링 대시보드 (포트 30884)
- **실무 재현**: 대부분의 대규모 서비스에서 Nginx/HAProxy 이중화 구조를 사용

### 2.5 왜 Tart VM을 선택했는가

| 대안 | 문제점 | Tart의 장점 |
|------|--------|------------|
| Docker Desktop + kind/k3d | 컨테이너 내 K8s → 네트워크 제약, eBPF 불가, 멀티 클러스터 어려움 | **실제 VM** 위에 kubeadm → 프로덕션과 동일한 K8s 환경 |
| VirtualBox/UTM | x86 에뮬레이션 오버헤드, 무거움 | Apple Virtualization Framework → **네이티브 ARM64**, 경량 |
| Multipass | 기능 제한, Terraform 연동 불편 | Terraform Provider 존재, CLI 간결, IP 할당 안정적 |
| 클라우드(EKS/GKE) | 비용 발생, 로컬 재현 불가 | **비용 0원**, 오프라인 가능, 인프라 전체를 직접 통제 |

---

## 3. 아키텍처

### 3.1 전체 시스템 구성도

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                    HOST MACHINE                         │
                    │           Apple Silicon Mac (M-series)                  │
                    │           CPU: 16 cores / RAM: 128GB                   │
                    │                                                         │
  ┌──────────────── │ ──────────────────────────────────────────────────────┐ │
  │  Tart VMs       │                                                      │ │
  │                 │                                                      │ │
  │  ┌─────────────────────────────────────────────────────────────────┐   │ │
  │  │ PLATFORM Cluster (모니터링/관리)                                │   │ │
  │  │ master(2C/4G) + worker1(3C/12G) + worker2(2C/8G) = 7C/24G     │   │ │
  │  │ → Prometheus, Grafana, ArgoCD, Jaeger, Loki                    │   │ │
  │  └─────────────────────────────────────────────────────────────────┘   │ │
  │                                                                        │ │
  │  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────────────┐│ │
  │  │ DEV Cluster       │ │ STAGING Cluster  │ │ PROD Cluster             ││ │
  │  │ master(2C/4G)     │ │ master(2C/4G)    │ │ master(2C/3G)            ││ │
  │  │ worker1(2C/8G)    │ │ worker1(2C/8G)   │ │ worker1(2C/8G)           ││ │
  │  │ = 4C/12G          │ │ = 4C/12G         │ │ worker2(2C/8G)           ││ │
  │  │ → 단일 레플리카    │ │ → 2 레플리카     │ │ = 6C/19G                 ││ │
  │  │ → Istio 활성화    │ │                   │ │ → HA+HPA+KEDA+PDB       ││ │
  │  └──────────────────┘ └──────────────────┘ └──────────────────────────┘│ │
  └────────────────────────────────────────────────────────────────────────┘ │
                    └─────────────────────────────────────────────────────────┘
```

### 3.2 애플리케이션 아키텍처

```
[사용자/k6 부하생성기]
        │
        ▼
┌───────────────────────────────────────────────────────┐
│                    TRAFFIC LAYER                       │
│  Nginx Ingress Controller (NodePort:30080)             │
│  → 경로 기반 라우팅 (/api/orders, /api/products, ...) │
└───────┬───────────────┬───────────────┬───────────────┘
        │               │               │
   ┌────▼────┐    ┌─────▼─────┐   ┌─────▼─────┐
   │ Nginx   │    │ Apache    │   │ HAProxy   │
   │ 정적+   │    │ HTTPD     │   │ L4/L7 LB  │
   │ 프록시  │    │ 레거시    │   │ Rate Limit│
   └────┬────┘    └─────┬─────┘   └─────┬─────┘
        │               │               │
┌───────▼───────────────▼───────────────▼───────────────┐
│                     WAS LAYER                          │
│                                                        │
│  ┌─────────────────┐ ┌─────────────────┐ ┌──────────┐ │
│  │ order-service   │ │ product-service │ │cart-svc  │ │
│  │ Java 17         │ │ Node.js 20      │ │Go 1.22   │ │
│  │ Spring Boot 3.2 │ │ Express         │ │net/http  │ │
│  │ Tomcat 10       │ │                 │ │          │ │
│  │ → POST/GET      │ │ → GET/POST      │ │→ CRUD   │ │
│  │   /api/orders   │ │   /api/products │ │ /api/cart│ │
│  └────────┬────────┘ └────────┬────────┘ └─────┬────┘ │
│           │                   │                 │      │
│  ┌─────────────────┐ ┌─────────────────┐ ┌──────────┐ │
│  │ user-service    │ │ review-service  │ │notify-   │ │
│  │ Python 3.12     │ │ Rust 1.77       │ │worker    │ │
│  │ FastAPI         │ │ Actix-web       │ │Node.js   │ │
│  │ → /api/users    │ │ → /api/reviews  │ │RabbitMQ  │ │
│  └─────────────────┘ └─────────────────┘ │Consumer  │ │
│                                          └──────────┘ │
└────────┬──────────────────────┬─────────────────┘─────┘
         │                      │                 │
┌────────▼──────────────────────┴─────────────────▼──────┐
│                    MESSAGE QUEUE                        │
│              RabbitMQ 3 (Topic Exchange)                │
│              Queue: order.created / shipped / cancelled │
└────────────────────────────────────────────────────────┘
         │                      │                 │
┌────────▼──────┐  ┌────────────▼──┐  ┌───────────▼─────┐
│ PostgreSQL 16 │  │ MongoDB 7     │  │ Redis 7         │
│ (StatefulSet) │  │ (StatefulSet) │  │ (Deployment)    │
│ 주문, 유저    │  │ 상품, 리뷰    │  │ 캐시, 세션,     │
│ ACID 트랜잭션 │  │ 스키마리스    │  │ 장바구니        │
└───────────────┘  └───────────────┘  └─────────────────┘
```

### 3.3 서비스 간 통신 흐름

**주문 생성 플로우 (동기 + 비동기 혼합)**:

```
1. POST /api/orders → order-service
2. order-service → PostgreSQL INSERT (JPA, 트랜잭션)
3. order-service → RabbitMQ PUBLISH "order.created" (비동기)
4. order-service → HTTP 201 응답 (여기서 사용자 응답 완료)
5. notification-worker ← RabbitMQ CONSUME (백그라운드)
6. notification-worker → 이메일/SMS/푸시 시뮬레이션
```

**상품 조회 플로우 (캐시 전략)**:

```
1. GET /api/products → product-service
2. Redis 캐시 확인 (HIT → 바로 응답, ~1ms)
3. 캐시 MISS → MongoDB 조회 (~5ms)
4. Redis에 결과 저장 (TTL 60초)
5. 응답 반환
```

---

## 4. 각 계층별 동작 원리

### 4.1 오토스케일링 메커니즘

**HPA (Horizontal Pod Autoscaler)가 Pod를 늘리는 원리**:

HPA는 metrics-server가 수집한 Pod의 CPU/Memory 사용률을 주기적으로(기본 15초) 확인한다. 현재 사용률이 목표값(예: CPU 50%)을 초과하면, `필요 레플리카 = ceil(현재 레플리카 × 현재 사용률 / 목표 사용률)` 공식으로 필요한 Pod 수를 계산하고 Deployment의 replicas를 조정한다.

```
order-service 예시:
  현재: 3 Pod, CPU 사용률 80%
  목표: CPU 50%
  계산: ceil(3 × 80/50) = ceil(4.8) = 5
  결과: 3 → 5 Pod로 스케일아웃

스케일링 정책:
  Scale Up:  30초 안정화 → 60초마다 최대 3 Pod 또는 50% 증가 (큰 쪽 적용)
  Scale Down: 300초 안정화 → 120초마다 1 Pod 감소 (급격한 축소 방지)
```

**KEDA (Kubernetes Event-Driven Autoscaling)가 워커를 늘리는 원리**:

KEDA는 HPA와 다르게 **외부 이벤트 소스**(RabbitMQ 큐 깊이)를 메트릭으로 사용한다. KEDA Operator가 RabbitMQ에 주기적으로(10초) 큐 길이를 질의하고, 메시지가 5개 이상이면 ScaledObject에 정의된 대로 Pod를 증가시킨다. 큐가 비면 `minReplicaCount: 1`까지 축소한다.

```
notification-worker:
  트리거: order.created 큐 > 5 messages
  범위: 1 → 10 Pod
  Scale Up: 즉시 (stabilization 0초), 30초마다 최대 3 Pod 추가
  Scale Down: 120초 안정화 후, 60초마다 1 Pod 감소
```

**PDB (Pod Disruption Budget)의 역할**:

노드 드레인이나 클러스터 업그레이드 시 동시에 내려가는 Pod 수를 제한한다. `minAvailable: 2`로 설정하면, 최소 2개 Pod가 항상 Running 상태를 유지해야 하므로 롤링 업데이트/노드 점검 시에도 서비스 중단이 없다.

### 4.2 Istio 서비스 메시 동작 원리

**서킷브레이커가 장애를 격리하는 원리**:

Istio의 Envoy 사이드카 프록시가 각 Pod에 주입되어 모든 트래픽을 가로챈다. DestinationRule의 `outlierDetection` 설정에 따라:

```yaml
outlierDetection:
  consecutive5xxErrors: 3    # 연속 5xx 3회 발생 시
  interval: 10s              # 10초 간격으로 검사
  baseEjectionTime: 30s      # 해당 엔드포인트를 30초간 트래픽 풀에서 제거
  maxEjectionPercent: 50     # 전체 엔드포인트의 최대 50%만 제거 (전체 장애 방지)
```

**mTLS의 동작 원리**:

Istio의 Citadel(istiod)이 각 Pod에 X.509 인증서를 자동 발급한다. `PeerAuthentication: STRICT` 모드에서는 모든 Pod-to-Pod 통신이 TLS로 암호화된다. 인증서 교체(rotation)도 자동으로 수행되므로 애플리케이션 코드 변경 없이 제로 트러스트 네트워크를 구현한다.

**VirtualService 재시도 정책**:

```
order-service: 타임아웃 10s, 3회 재시도, 5xx/reset/connect-failure 시
product-service: 타임아웃 5s, 2회 재시도, 5xx/connect-failure 시
cart-service: 타임아웃 3s, 2회 재시도, 5xx/connect-failure 시
```

### 4.3 Kustomize base/overlay 패턴

**왜 Kustomize를 사용했는가**: Helm은 템플릿 엔진이라 values.yaml이 복잡해지면 가독성이 떨어진다. Kustomize는 원본 YAML을 그대로 유지하면서 환경별로 **패치만 적용**하는 방식이라 변경점이 명확하다.

```
manifests/
├── base/              ← 모든 환경에 공통인 "원본" (replicas: 1, 최소 리소스)
│   ├── namespace.yaml
│   ├── web-tier/      ← Nginx, Apache
│   ├── was-tier/      ← 5개 서비스 + 1개 워커
│   ├── data-tier/     ← PostgreSQL, MongoDB, Redis
│   ├── messaging/     ← RabbitMQ
│   ├── loadbalancer/  ← HAProxy
│   ├── logging/       ← EFK Stack
│   └── monitoring/    ← Scouter APM
│
├── overlays/
│   ├── dev/           ← namePrefix: dev-, replicas: 1, LOG_LEVEL: debug
│   ├── staging/       ← namePrefix: staging-, replicas: 2, LOG_LEVEL: info
│   └── prod/          ← namePrefix: prod-, replicas: 3, LOG_LEVEL: warn
│                         + HPA, PDB, KEDA, topologySpread, podAntiAffinity
│
└── istio/             ← VirtualService, DestinationRule, PeerAuthentication
```

**배포 명령**:

```bash
# dev 환경 배포
kubectl apply -k manifests/overlays/dev/

# prod 환경 배포 (HPA + KEDA + PDB 포함)
kubectl apply -k manifests/overlays/prod/
```

### 4.4 ArgoCD App-of-Apps 패턴

**왜 App-of-Apps인가**: 3개 환경(dev/staging/prod)을 개별 ArgoCD Application으로 등록하면 관리가 번거롭다. App-of-Apps 패턴은 **루트 Application 하나가 하위 Application들을 자동 생성/관리**한다.

```
app-of-apps.yaml (루트)
    │
    ├── dev-app.yaml      → manifests/overlays/dev/    (syncPolicy: automated)
    ├── staging-app.yaml  → manifests/overlays/staging/ (syncPolicy: manual)
    └── prod-app.yaml     → manifests/overlays/prod/    (syncPolicy: manual)
```

dev는 Git push 시 자동 배포, staging/prod는 수동 승인 후 배포.

### 4.5 모니터링 파이프라인

**메트릭 수집 흐름**:

```
애플리케이션 → /metrics 엔드포인트 노출
    │           (prom-client, micrometer, promhttp)
    ▼
ServiceMonitor CRD → Prometheus에 스크래핑 대상 등록
    │                  (15초 간격)
    ▼
Prometheus → 메트릭 저장 (TSDB)
    │
    ├── Grafana → 대시보드 시각화
    │   ├── ecommerce-overview: RPS, 에러율, 레이턴시 P95/P99, 큐 깊이
    │   └── autoscaling-dashboard: HPA 레플리카 수, CPU/메모리, KEDA 이벤트
    │
    └── PrometheusRule → 알림
        ├── OrderServiceHighLatency: P99 > 1s (5분 지속) → warning
        ├── HighErrorRate: 에러율 > 1% (5분 지속) → critical
        ├── PodRestartLoop: 1시간 내 3회 이상 재시작 → warning
        ├── HPAMaxedOut: 최대 레플리카 5분 이상 유지 → warning
        └── RabbitMQQueueBacklog: 큐 100개 초과 (5분 지속) → warning
```

**로그 수집 흐름 (EFK Stack)**:

```
각 Pod stdout/stderr → Fluentd DaemonSet (노드당 1개)
    │                     td-agent가 컨테이너 로그 수집
    ▼
Elasticsearch → 인덱싱 및 저장
    │
    ▼
Kibana → 로그 검색, 필터링, 시각화 (포트 31601)
```

### 4.6 부하 테스트 설계

**MAU 1천만 → RPS 환산**:

```
MAU 10,000,000명
├── DAU = MAU / 30 = ~333,000명/일
├── 세션 = 5 세션/유저/일
├── 요청 = 10 요청/세션
├── 일일 총 요청 = 333K × 5 × 10 = 16,650,000 req/day
│
├── 평균 RPS = 16.65M / 86,400 = ~193 RPS
├── 피크 팩터 = 3x (피크 시간대 집중)
├── 피크 RPS = ~278 RPS
└── 버스트 피크 = ~500-1000 RPS (이벤트, 세일)
```

**트래픽 분포 (실제 e-commerce 패턴 반영)**:

```
50% 상품 목록 조회 (GET /api/products)       → Redis 캐시 HIT
20% 상품 상세 조회 (GET /api/products/:id)   → Redis 캐시 HIT
15% 장바구니 조작 (POST/GET /api/cart)       → Redis 직접 R/W
15% 주문 생성 (POST /api/orders)             → DB Write + MQ Publish
```

**k6 시나리오**:

| 시나리오 | VU | 시간 | 예상 RPS | 목적 |
|---------|-----|------|---------|------|
| smoke | 10 | 1분 | ~10 | 엔드포인트 동작 확인 |
| average-load | 200 | 10분 | ~200 | 평일 평균 트래픽 |
| peak-load | 500 | 15분 | ~300 | MAU 1천만 피크 시간 |
| stress-test | 2000 | 20분 | ~1000+ | HPA 한계점 탐색, 이벤트/세일 버스트 |
| soak-test | 200 | 2시간 | ~200 | 메모리 누수, 커넥션 풀 고갈 탐지 |

**SLA 기준**:
- P95 응답시간 < 500ms
- P99 응답시간 < 1s
- 에러율 < 1%

---

## 5. VM 리소스 배분

총 **10개 VM**, vCPU 합계 **21 cores**, RAM 합계 **약 67 GB**

> 호스트 16코어에 vCPU 21개 할당 (약 1.3:1 오버커밋).
> Tart는 Apple Virtualization Framework 기반이라 경량이며,
> 모든 VM을 동시에 기동해도 호스트에 충분한 여유가 있음.

| 클러스터 | VM 이름 | Role | vCPU | RAM | 용도 |
|---------|---------|------|------|-----|------|
| **platform** | platform-master | master | 2 | 4 GB | K8s control plane |
| | platform-worker1 | worker | 3 | 12 GB | Prometheus, Grafana, ArgoCD |
| | platform-worker2 | worker | 2 | 8 GB | Jaeger, Loki |
| **dev** | dev-master | master | 2 | 4 GB | K8s control plane |
| | dev-worker1 | worker | 2 | 8 GB | 앱 전체 (단일 레플리카) |
| **staging** | staging-master | master | 2 | 4 GB | K8s control plane |
| | staging-worker1 | worker | 2 | 8 GB | 앱 서비스 (2 레플리카) |
| **prod** | prod-master | master | 2 | 3 GB | K8s control plane |
| | prod-worker1 | worker | 2 | 8 GB | 앱 서비스 (HA, HPA) |
| | prod-worker2 | worker | 2 | 8 GB | 앱 서비스 (HA, HPA) |

**운영 모드 가이드**:

```
풀 프로덕션:    platform + prod (13C/43G) → 실제 운영 시뮬레이션
개발 + 운영:    platform + dev + prod (17C/55G)
전체 파이프라인: 전체 10VM (21C/67G) → 부하 테스트 시
최소 기동:      dev만 (4C/12G) → 앱 개발/디버깅
```

### Pod 리소스 버짓

| 서비스 | CPU req/limit | Memory req/limit | prod 레플리카 |
|--------|--------------|-----------------|--------------|
| nginx-static | 50m / 200m | 64Mi / 128Mi | 2-6 (HPA) |
| apache-legacy | 50m / 200m | 64Mi / 128Mi | 1 |
| order-service | 100m / 500m | 256Mi / 512Mi | 3-10 (HPA) |
| product-service | 100m / 400m | 128Mi / 256Mi | 3-10 (HPA) |
| cart-service | 50m / 300m | 64Mi / 128Mi | 3-8 (HPA) |
| user-service | 50m / 300m | 128Mi / 256Mi | 3-8 (HPA) |
| review-service | 30m / 200m | 32Mi / 64Mi | 2-6 (HPA) |
| notification-worker | 50m / 200m | 128Mi / 256Mi | 1-10 (KEDA) |
| postgresql | 100m / 500m | 256Mi / 512Mi | 1 |
| mongodb | 100m / 500m | 256Mi / 512Mi | 1 |
| redis | 50m / 200m | 64Mi / 256Mi | 1 |
| rabbitmq | 100m / 300m | 256Mi / 512Mi | 1 |

---

## 6. 기술 스택 전체

| 계층 | 기술 | 버전 | 역할 |
|------|------|------|------|
| **WEB** | Nginx | 1.24 | 리버스 프록시, 정적 파일 서빙, 응답 캐시 |
| **WEB** | Apache HTTPD | 2.4 | 레거시 호환 (mod_proxy, mod_balancer) |
| **WAS** | Spring Boot / Tomcat | 3.2 / 10 | 주문 서비스 (JPA, AMQP, Actuator) |
| **WAS** | Express (Node.js) | 20 LTS | 상품 서비스 (Mongoose, Redis 캐시) |
| **WAS** | net/http (Go) | 1.22 | 장바구니 서비스 (Redis Hash) |
| **WAS** | FastAPI (Python) | 3.12 | 사용자 서비스 (async SQLAlchemy, JWT) |
| **WAS** | Actix-web (Rust) | 1.77 | 리뷰 서비스 (MongoDB Aggregation) |
| **LB** | HAProxy | 2.9 | L4/L7 로드밸런싱, stick-table Rate Limiting |
| **SQL** | PostgreSQL | 16 | 주문/유저 (ACID 트랜잭션) |
| **NoSQL** | MongoDB | 7 | 상품/리뷰 (스키마리스 문서형) |
| **Cache** | Redis | 7 | 캐시, 세션, 장바구니 (인메모리) |
| **MQ** | RabbitMQ | 3 | Topic Exchange 이벤트 브로커 |
| **Logging** | EFK Stack | ES 8.12 | 중앙 로그 수집 (Fluentd → ES → Kibana) |
| **APM** | Scouter | 2.20 | Java WAS 성능 모니터링 |
| **VM** | Tart | latest | Apple Silicon 네이티브 경량 VM |
| **K8s** | kubeadm | - | 베어메탈 K8s 클러스터 부트스트랩 |
| **CNI** | Cilium | - | eBPF 기반 고성능 네트워킹 |
| **배포** | Kustomize | - | base/overlay 환경별 배포 |
| **배포** | Helm | - | 파라미터화된 차트 패키징 |
| **GitOps** | ArgoCD | - | App-of-Apps, 자동/수동 Sync |
| **Mesh** | Istio | - | mTLS, 서킷브레이커, 재시도, 카나리 |
| **모니터링** | Prometheus + Grafana | - | 메트릭 수집 + 대시보드 + SLA 알림 |
| **스케일링** | HPA / KEDA | v2 / - | CPU 기반 / 이벤트 기반 오토스케일링 |
| **부하테스트** | k6 | - | 5단계 트래픽 시뮬레이션 |

---

## 7. 디렉토리 구조

```
devops_dummpy/
├── README.md
├── apps/                              # 마이크로서비스 소스코드
│   ├── order-service/                 # Java 17 / Spring Boot 3.2 / Tomcat 10
│   ├── product-service/               # Node.js 20 / Express
│   ├── cart-service/                   # Go 1.22 / net/http
│   ├── user-service/                  # Python 3.12 / FastAPI
│   ├── review-service/                # Rust 1.77 / Actix-web
│   ├── notification-worker/           # Node.js 20 / RabbitMQ Consumer
│   └── frontend/                      # Nginx Static Site
│
├── manifests/                         # Kubernetes 매니페스트
│   ├── base/                          # Kustomize 베이스 (15개 리소스)
│   ├── overlays/{dev,staging,prod}/   # 환경별 오버레이
│   └── istio/                         # 서비스 메시 설정
│
├── helm/devops-ecommerce/             # Helm 차트
├── argocd/                            # GitOps (App-of-Apps)
├── loadtest/k6/                       # k6 부하 테스트 시나리오
├── monitoring/                        # ServiceMonitor, PrometheusRule, Grafana 대시보드
├── scripts/                           # 자동화 스크립트
├── blogs/                             # 단계별 구현 가이드 블로그
└── docs/                              # 설계 문서, 실습 가이드
```

---

## 8. 사전 준비

### 8.1 호스트 요구사항

- Apple Silicon Mac (M1/M2/M3/M4)
- RAM: 64GB 이상 권장 (128GB 최적)
- 디스크 여유: 300GB 이상

### 8.2 필수 소프트웨어

```bash
# VM 가상화
brew install cirruslabs/cli/tart

# Kubernetes 도구
brew install kubectl helm kustomize

# 이미지 빌드
brew install docker

# 부하 테스트
brew install k6

# VM SSH 자동화
brew install esolitos/ipa/sshpass

# 설치 확인
tart --version && kubectl version --client && helm version && k6 version
```

### 8.3 인프라 구축 (Tart VM + K8s 클러스터)

이 프로젝트는 Tart VM 위에 kubeadm으로 구축된 K8s 클러스터가 필요하다.
전체 구축 과정은 [blogs/02-tart-vm-kubernetes.md](blogs/02-tart-vm-kubernetes.md)에 복사-붙여넣기 가능한 명령어로 상세히 기술되어 있다.

요약하면:

```bash
# 1. Tart VM 10대 생성 (Ubuntu 24.04 ARM64)
tart pull ghcr.io/cirruslabs/ubuntu:latest
for vm in platform-master platform-worker1 platform-worker2 \
          dev-master dev-worker1 staging-master staging-worker1 \
          prod-master prod-worker1 prod-worker2; do
  tart clone ghcr.io/cirruslabs/ubuntu:latest "$vm"
done

# 2. VM 기동 (--net-softnet-allow: VM 간 통신 필수)
for vm in ...; do
  tart run "$vm" --no-graphics --net-softnet-allow=0.0.0.0/0 &
done

# 3. 각 VM에 containerd + kubeadm 설치 (SSH)
# 4. kubeadm init/join으로 4개 클러스터 부트스트랩
# 5. Cilium CNI 설치 (kubeProxyReplacement=true)
# 6. kubeconfig를 kubeconfig/ 디렉토리에 저장

# 구축 후 확인
kubectl --kubeconfig=kubeconfig/dev.yaml get nodes
kubectl --kubeconfig=kubeconfig/prod.yaml get nodes
```

상세 절차는 blogs/02 편을 참고한다.

---

## 9. 재현 가이드 (Quick Start)

### Step 1: Docker 이미지 빌드

```bash
# 7개 앱 이미지를 ARM64로 빌드 (약 10-15분)
./scripts/build-images.sh

# 빌드 결과 확인
docker images | grep -E "order|product|cart|user|review|notification|frontend"
```

### Step 2: K8s 노드에 이미지 로드

```bash
# docker save → ssh → containerd import
WORKER_IP=$(tart ip dev-worker1)
for img in order-service product-service cart-service user-service review-service notification-worker frontend; do
  docker save ${img}:latest | \
    sshpass -p admin ssh admin@${WORKER_IP} "sudo ctr -n k8s.io images import -"
done
```

### Step 3: Nginx Ingress Controller 설치

```bash
./scripts/install-nginx-ingress.sh dev
```

### Step 4: 앱 배포

```bash
# dev 환경 배포
./scripts/deploy.sh dev

# 배포 상태 확인
./scripts/verify.sh dev
```

### Step 5: API 동작 확인

```bash
DEV_IP=$(tart ip dev-master)

# 상품 조회
curl http://${DEV_IP}:30080/api/products

# 주문 생성
curl -X POST http://${DEV_IP}:30080/api/orders \
  -H "Content-Type: application/json" \
  -d '{"userId":"user-1","productId":"prod-1","quantity":1,"totalPrice":29.99}'

# 장바구니
curl -X POST http://${DEV_IP}:30080/api/cart \
  -H "Content-Type: application/json" \
  -d '{"userId":"user-1","productId":"prod-1","quantity":2}'
```

### Step 6: 부하 테스트

```bash
# Smoke 테스트
./scripts/run-loadtest.sh smoke dev

# MAU 1천만 피크 시뮬레이션 (prod 환경 권장)
./scripts/run-loadtest.sh peak-load prod
```

### Step 7: 프로덕션 배포 (HPA + KEDA)

```bash
# KEDA 설치
./scripts/install-keda.sh prod

# prod 배포
./scripts/deploy.sh prod

# HPA 스케일아웃 관찰 (별도 터미널)
kubectl --kubeconfig=kubeconfig/prod.yaml get hpa -n ecommerce -w

# 스트레스 테스트로 HPA 트리거
./scripts/run-loadtest.sh stress-test prod
```

---

## 10. 라이선스

이 프로젝트는 학습/포트폴리오 목적으로 제작되었습니다.
