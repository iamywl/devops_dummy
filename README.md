# DevOps E-Commerce Platform - MAU 10M Architecture

> Apple Silicon Mac + Tart VM + Kubernetes 멀티클러스터 위에서
> **MAU 1천만 트래픽을 소화하는 e-commerce 플랫폼**을 설계/구축/운영하는 DevOps 포트폴리오 프로젝트

---

## 1. 프로젝트 소개

### 1.1 왜 이 프로젝트를 만들었는가

- 데브옵스 엔지니어로서 **대규모 서비스를 운영할 수 있음**을 증명하기 위한 포트폴리오
- 단순히 "쿠버네티스 할 줄 압니다"가 아니라, **실제 MAU 1천만 규모의 트래픽 패턴을 시뮬레이션**하고 오토스케일링이 작동하는 것을 보여줌
- 관련 프로젝트 3개가 하나의 스토리를 구성:

| 프로젝트 | 증명하는 역량 |
|---------|-------------|
| [`tart-infra`](../tart-infra/) | 인프라를 **코드로 프로비저닝**할 수 있음 (Terraform + Tart VM + K8s) |
| [`middle_ware`](../middle_ware/) | WEB/WAS 미들웨어를 **구성/운영**할 수 있음 (Nginx + Tomcat + SSO + APM) |
| **`devops_dummpy` (이 프로젝트)** | 대규모 서비스를 **설계/배포/스케일링/모니터링**할 수 있음 |

### 1.2 이 프로젝트에서 다루는 것

- **멀티티어 마이크로서비스** 아키텍처 (WEB → WAS → DB)
- **웹서버 2종**: Nginx (리버스 프록시 + 정적 서빙) + Apache HTTPD (레거시 호환)
- **WAS 5종**: Tomcat/Spring Boot (Java) + Express (Node.js) + Go (net/http) + FastAPI (Python) + Actix-web (Rust)
- **로드밸런서**: HAProxy (L4/L7 로드밸런싱, stick-table Rate Limiting)
- **데이터베이스 3종**: PostgreSQL (SQL) + MongoDB (NoSQL) + Redis (Cache)
- **메시지 큐**: RabbitMQ (이벤트 기반 비동기 처리)
- **로그 수집**: EFK Stack (Elasticsearch + Fluentd + Kibana)
- **탄력적 스케일링**: HPA (CPU 기반) + KEDA (큐 기반) + PDB (안정성)
- **서비스 메시**: Istio (서킷브레이커, mTLS, 카나리 배포)
- **GitOps CI/CD**: ArgoCD (App-of-Apps 패턴)
- **모니터링**: Prometheus + Grafana + ServiceMonitor + SLA 알림
- **부하 테스트**: k6 (MAU 1천만 트래픽 시뮬레이션)

---

## 2. 아키텍처

### 2.1 전체 시스템 구성도

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
  │  ┌──────────────────┐ ┌──────────────────┐ ┌────────────────────────┐ │ │
  │  │ DEV Cluster       │ │ STAGING Cluster  │ │ PROD Cluster           │ │ │
  │  │ master(2C/4G)     │ │ master(2C/4G)    │ │ master(2C/3G)          │ │ │
  │  │ worker1(2C/8G)    │ │ worker1(2C/8G)   │ │ worker1(2C/8G)         │ │ │
  │  │ = 4C/12G          │ │ = 4C/12G         │ │ worker2(2C/8G)         │ │ │
  │  │ → 단일 레플리카    │ │ → 2 레플리카     │ │ = 6C/19G               │ │ │
  │  │ → Istio 활성화    │ │ → prod 유사 설정  │ │ → HA + HPA + KEDA     │ │ │
  │  └──────────────────┘ └──────────────────┘ └────────────────────────┘ │ │
  └────────────────────────────────────────────────────────────────────────┘ │
                    └─────────────────────────────────────────────────────────┘
```

### 2.2 애플리케이션 아키텍처

```
[사용자/k6 부하생성기]
        │
        ▼
┌───────────────────────────────────────────────────────┐
│                    TRAFFIC LAYER                       │
│  Nginx Ingress Controller (NodePort:30080)             │
│  - Rate Limiting: 100 req/s per IP                     │
│  - 경로 기반 라우팅                                     │
└───────┬───────────────┬───────────────┬───────────────┘
        │               │               │
   ┌────▼────┐    ┌─────▼─────┐   ┌─────▼─────┐
   │ Nginx   │    │ Apache    │   │ Nginx     │
   │ (정적+  │    │ HTTPD     │   │ (어드민)  │
   │ 프록시) │    │ (레거시)  │   │           │
   └────┬────┘    └─────┬─────┘   └─────┬─────┘
        │               │               │
┌───────▼───────────────▼───────────────▼───────────────┐
│                     WAS LAYER                          │
│                                                        │
│  ┌─────────────────┐ ┌─────────────────┐ ┌──────────┐ │
│  │ order-service   │ │ product-service │ │cart-svc  │ │
│  │ ─────────────── │ │ ─────────────── │ │────────  │ │
│  │ Tomcat          │ │ Node.js 20      │ │Go 1.22   │ │
│  │ Spring Boot 3.x │ │ Express         │ │net/http  │ │
│  │ Java 17         │ │                 │ │          │ │
│  │ → POST/GET      │ │ → GET/POST      │ │→ CRUD   │ │
│  │   /api/orders   │ │   /api/products │ │ /api/cart│ │
│  │ → Actuator      │ │ → /metrics      │ │→/metrics│ │
│  │   /prometheus   │ │   (prom-client) │ │(promhttp)│ │
│  └────────┬────────┘ └────────┬────────┘ └─────┬────┘ │
│           │                   │                 │      │
│  ┌─────────────────┐ ┌─────────────────┐ ┌──────────┐ │
│  │ user-service    │ │ review-service  │ │notify-   │ │
│  │ ─────────────── │ │ ─────────────── │ │worker    │ │
│  │ Python 3.12     │ │ Rust 1.77       │ │Node.js   │ │
│  │ FastAPI         │ │ Actix-web       │ │RabbitMQ  │ │
│  │ → /api/users    │ │ → /api/reviews  │ │Consumer  │ │
│  └─────────────────┘ └─────────────────┘ └──────────┘ │
└────────┬──────────────────────┬─────────────────┘──────┘
         │                      │                 │
┌────────▼──────────────────────┴─────────────────▼──────┐
│                    MESSAGE QUEUE                        │
│              RabbitMQ 3 (Management)                    │
│              Queue: order.created                       │
│              Exchange: order.exchange (topic)           │
└────────────────────────────────────────────────────────┘
         │                      │                 │
┌────────▼──────┐  ┌────────────▼──┐  ┌───────────▼─────┐
│ PostgreSQL 16 │  │ MongoDB 7     │  │ Redis 7         │
│ (StatefulSet) │  │ (StatefulSet) │  │ (Deployment)    │
│               │  │               │  │                 │
│ DB: orders    │  │ DB: products  │  │ Cache: 상품     │
│ 테이블: 주문,  │  │ Collection:   │  │ Session: 장바구니│
│ 유저 정보     │  │ 상품, 리뷰    │  │ Rate Limit      │
│ PVC: 5Gi      │  │ PVC: 5Gi      │  │ maxmem: 200MB   │
└───────────────┘  └───────────────┘  └─────────────────┘
```

### 2.3 서비스 간 통신 흐름

```
[사용자가 주문 생성]
     │
     ▼
  POST /api/orders
     │
     ▼
  order-service (Tomcat/Spring Boot)
     │
     ├── 1. PostgreSQL에 주문 저장 (JPA)
     │
     ├── 2. RabbitMQ에 "order.created" 이벤트 발행
     │       │
     │       ▼
     │   notification-worker (Node.js)
     │       └── 알림 전송 시뮬레이션 (이메일/SMS)
     │
     └── 3. HTTP 201 응답 반환

[사용자가 상품 조회]
     │
     ▼
  GET /api/products
     │
     ▼
  product-service (Node.js/Express)
     │
     ├── 1. Redis 캐시 확인 (HIT → 바로 응답)
     │
     └── 2. 캐시 MISS → MongoDB 조회 → Redis 캐시 저장 (TTL 60s) → 응답
```

---

## 3. 호스트 리소스 및 VM 리소스 배분

### 3.1 호스트 머신 사양

| 항목 | 사양 |
|------|------|
| CPU | Apple Silicon (16 cores) |
| RAM | 128 GB |
| Disk | 1.8 TB (여유: ~835 GB) |
| OS | macOS (Darwin 24.6.0) |
| 가상화 | Tart (Apple Virtualization Framework) |

### 3.2 VM 리소스 배분 상세

총 **10개 VM**, vCPU 합계 **21 cores**, RAM 합계 **67 GB**

> 호스트 16코어에 vCPU 21개를 할당하므로 약 1.3:1 오버커밋.
> Tart는 Apple Virtualization Framework 기반이라 경량이고,
> 모든 VM을 동시에 100% 사용하는 경우는 드물기 때문에 실용적으로 문제없음.
> RAM은 128GB 중 67GB 사용으로 여유 있음 (호스트 OS + Docker 빌드용으로 ~60GB 확보).

| 클러스터 | VM 이름 | Role | vCPU | RAM | Disk | 용도 |
|---------|---------|------|------|-----|------|------|
| **platform** | platform-master | master | 2 | 4 GB | 20 GB | K8s control plane |
| | platform-worker1 | worker | 3 | 12 GB | 20 GB | Prometheus, Grafana, ArgoCD |
| | platform-worker2 | worker | 2 | 8 GB | 20 GB | Jaeger, Loki |
| **dev** | dev-master | master | 2 | 4 GB | 20 GB | K8s control plane |
| | dev-worker1 | worker | 2 | 8 GB | 20 GB | 앱 전체 (단일 레플리카) |
| **staging** | staging-master | master | 2 | 4 GB | 20 GB | K8s control plane |
| | staging-worker1 | worker | 2 | 8 GB | 20 GB | 앱 전체 (2 레플리카) |
| **prod** | prod-master | master | 2 | 3 GB | 20 GB | K8s control plane |
| | prod-worker1 | worker | 2 | 8 GB | 20 GB | 앱 서비스 (HA) |
| | prod-worker2 | worker | 2 | 8 GB | 20 GB | 앱 서비스 (HA) |
| **합계** | | | **21** | **67 GB** | **200 GB** | |

### 3.3 리소스 운영 가이드

```
VM 전체 동시 기동 시:
  ├── 호스트 RAM 사용: 67GB / 128GB (52%) → 안전
  ├── 호스트 CPU 사용: 21 vCPU / 16 cores (오버커밋 1.3x) → 허용 범위
  └── 호스트 Disk 사용: 200GB / 835GB 여유 (24%) → 충분

리소스가 부족할 경우:
  ├── dev + prod만 기동 (staging 중지): 10C/35G
  ├── dev만 기동 (개발 단계): 4C/12G
  └── platform + 하나의 앱 클러스터만 기동: 11C/36G
```

### 3.4 Pod 리소스 버짓 (서비스당)

| 서비스 | CPU req/limit | Memory req/limit | prod 레플리카 |
|--------|--------------|-----------------|--------------|
| nginx-static | 50m / 200m | 64Mi / 128Mi | 2 |
| apache-legacy | 50m / 200m | 64Mi / 128Mi | 1 |
| order-service (Tomcat) | 100m / 500m | 256Mi / 512Mi | 2-6 (HPA) |
| product-service (Node.js) | 100m / 400m | 128Mi / 256Mi | 2-6 (HPA) |
| cart-service (Go) | 50m / 300m | 64Mi / 128Mi | 2-4 (HPA) |
| user-service (FastAPI) | 50m / 300m | 128Mi / 256Mi | 2-4 (HPA) |
| review-service (Rust) | 30m / 200m | 32Mi / 64Mi | 2-4 (HPA) |
| notification-worker | 50m / 200m | 128Mi / 256Mi | 1-5 (KEDA) |
| haproxy | 50m / 200m | 64Mi / 128Mi | 1 |
| elasticsearch | 200m / 1000m | 512Mi / 1Gi | 1 |
| fluentd (DaemonSet) | 50m / 200m | 128Mi / 256Mi | 노드당 1 |
| kibana | 100m / 500m | 256Mi / 512Mi | 1 |
| postgresql | 100m / 500m | 256Mi / 512Mi | 1 |
| mongodb | 100m / 500m | 256Mi / 512Mi | 1 |
| redis | 50m / 200m | 64Mi / 256Mi | 1 |
| rabbitmq | 100m / 300m | 256Mi / 512Mi | 1 |
| **합계 (단일 레플리카)** | **~1.3** | **~2.5 GB** | |

> 워커 노드 1개 (2 CPU, 8 GB)에 단일 레플리카 기준 전체 앱이 충분히 들어감.
> prod에서 HPA가 스케일아웃하면 2개 워커 노드에 걸쳐 분산됨.

---

## 4. 기술 스택 상세

| 계층 | 기술 | 버전 | 선택 이유 |
|------|------|------|----------|
| **WEB** | Nginx | 1.24+ | 고성능 리버스 프록시, 정적 파일 서빙, rate limiting |
| **WEB** | Apache HTTPD | 2.4 | 레거시 시스템 호환성 데모 (mod_proxy, balancer) |
| **WAS** | Tomcat (Spring Boot) | 10.x (3.2.x) | 엔터프라이즈 표준 Java WAS, JPA + Actuator 메트릭 |
| **WAS** | Node.js (Express) | 20 LTS | 비동기 I/O 기반 고성능 API, Mongoose ODM |
| **WAS** | Go (net/http) | 1.22 | 초경량 바이너리, 최소 메모리, 고성능 카트 서비스 |
| **WAS** | FastAPI (Uvicorn) | Python 3.12 | 비동기 ASGI, 자동 API 문서(Swagger), 유저 서비스 |
| **WAS** | Actix-web | Rust 1.77 | 초고성능 HTTP 프레임워크, 메모리 안전, 리뷰 서비스 |
| **LB** | HAProxy | 2.9 | L4/L7 로드밸런싱, stick-table Rate Limiting, Stats UI |
| **SQL** | PostgreSQL | 16 | ACID 트랜잭션, 주문/유저 데이터 정합성 보장 |
| **NoSQL** | MongoDB | 7 | 스키마리스 문서형, 상품 카탈로그/리뷰 유연 저장 |
| **Cache** | Redis | 7 | 인메모리 캐시 (상품), 세션 스토어 (장바구니) |
| **MQ** | RabbitMQ | 3 | AMQP 메시지 큐, KEDA 연동, Management UI |
| **Logging** | EFK Stack | ES 8.12 | Elasticsearch + Fluentd + Kibana, 중앙 로그 수집 |
| **Container** | Docker | - | ARM64 멀티스테이지 빌드 |
| **Orchestration** | Kubernetes | kubeadm | 멀티클러스터 (dev/staging/prod) |
| **VM** | Tart | latest | Apple Silicon 네이티브, 경량 VM |
| **IaC** | Terraform | - | VM + K8s 프로비저닝 자동화 |
| **K8s 배포** | Kustomize | - | 환경별 오버레이 (base + dev/staging/prod) |
| **K8s 배포** | Helm | - | 파라미터화된 차트 패키징 |
| **CI/CD** | ArgoCD | - | GitOps, App-of-Apps 패턴, 자동 Sync |
| **Service Mesh** | Istio | - | mTLS, 서킷브레이커, 카나리, 트래픽 관리 |
| **Monitoring** | Prometheus | - | 메트릭 수집, ServiceMonitor CRD |
| **Visualization** | Grafana | - | 대시보드 (e-commerce 개요, 오토스케일링) |
| **Alerting** | PrometheusRule | - | SLA 위반 알림 (P99 > 1s, 에러율 > 1%) |
| **Autoscale** | HPA | v2 | CPU/메모리 기반 수평 스케일링 |
| **Autoscale** | KEDA | - | RabbitMQ 큐 깊이 기반 이벤트 드리븐 스케일링 |
| **Load Test** | k6 | - | MAU 1천만 트래픽 패턴 시뮬레이션 |

---

## 5. 디렉토리 구조

```
devops_dummpy/
│
├── README.md                              # 이 파일 (프로젝트 전체 가이드)
├── .gitignore
│
├── apps/                                  # ── 마이크로서비스 소스코드 ──
│   │
│   ├── order-service/                     # [WAS] Java Spring Boot + Tomcat
│   │   ├── Dockerfile                     #   멀티스테이지 빌드 (maven → temurin-jre)
│   │   ├── pom.xml                        #   Spring Boot 3.2.x, JPA, AMQP, Actuator
│   │   └── src/main/
│   │       ├── java/com/devops/order/
│   │       │   ├── OrderApplication.java  #   메인 클래스
│   │       │   ├── controller/            #   REST API (POST/GET /api/orders)
│   │       │   ├── service/               #   비즈니스 로직 + RabbitMQ 발행
│   │       │   ├── repository/            #   JPA Repository
│   │       │   ├── model/                 #   Order JPA Entity (UUID, status enum)
│   │       │   └── config/                #   RabbitMQ 설정 (Exchange, Queue, Binding)
│   │       └── resources/
│   │           └── application.properties #   DB/MQ/Actuator 설정
│   │
│   ├── product-service/                   # [WAS] Node.js Express
│   │   ├── Dockerfile                     #   멀티스테이지 빌드 (node:20-alpine)
│   │   ├── package.json                   #   express, mongoose, ioredis, prom-client
│   │   └── src/
│   │       ├── index.js                   #   Express 서버, MongoDB/Redis 연결
│   │       ├── routes/products.js         #   CRUD API + Redis 캐시
│   │       ├── models/Product.js          #   Mongoose 스키마 (상품, 리뷰)
│   │       └── middleware/cache.js        #   Redis 캐시 미들웨어 (TTL 60s)
│   │
│   ├── cart-service/                      # [WAS] Go net/http
│   │   ├── Dockerfile                     #   멀티스테이지 빌드 (golang → alpine)
│   │   ├── go.mod / go.sum               #   go-redis, prometheus client
│   │   └── main.go                        #   Redis Hash 기반 장바구니 CRUD
│   │
│   ├── user-service/                      # [WAS] Python FastAPI + Uvicorn
│   │   ├── Dockerfile                     #   멀티스테이지 빌드 (python:3.12-slim)
│   │   ├── requirements.txt               #   fastapi, uvicorn, asyncpg, redis
│   │   ├── main.py                        #   FastAPI 앱, 라우터 등록
│   │   ├── models.py                      #   SQLAlchemy 비동기 모델 (User)
│   │   └── database.py                    #   AsyncSession, DB 연결
│   │
│   ├── review-service/                    # [WAS] Rust Actix-web
│   │   ├── Dockerfile                     #   멀티스테이지 빌드 (rust → debian-slim)
│   │   ├── Cargo.toml                     #   actix-web, mongodb, serde
│   │   └── src/main.rs                    #   REST API + MongoDB 연결
│   │
│   ├── notification-worker/               # [Worker] Node.js RabbitMQ Consumer
│   │   ├── Dockerfile
│   │   ├── package.json                   #   amqplib, prom-client
│   │   └── src/worker.js                 #   큐 소비 + 알림 시뮬레이션
│   │
│   └── frontend/                          # [WEB] Nginx Static Site
│       ├── Dockerfile                     #   nginx:alpine 기반
│       ├── nginx.conf                     #   리버스 프록시 설정
│       └── public/
│           └── index.html                 #   E-Commerce 랜딩 페이지
│
├── manifests/                             # ── Kubernetes 매니페스트 ──
│   │
│   ├── base/                              # Kustomize 베이스 (공통)
│   │   ├── kustomization.yaml             #   전체 리소스 목록
│   │   ├── namespace.yaml                 #   ecommerce 네임스페이스
│   │   ├── web-tier/
│   │   │   ├── nginx-configmap.yaml       #   Nginx 설정 (upstream, rate limit)
│   │   │   ├── nginx-static.yaml          #   Nginx Deployment + NodePort Service
│   │   │   └── apache-legacy.yaml         #   Apache HTTPD + mod_proxy 설정
│   │   ├── was-tier/
│   │   │   ├── order-service.yaml         #   Deployment + Service (Tomcat, 8080)
│   │   │   ├── product-service.yaml       #   Deployment + Service (Node.js, 3000)
│   │   │   ├── cart-service.yaml          #   Deployment + Service (Go, 8081)
│   │   │   ├── user-service.yaml          #   Deployment + Service (FastAPI, 8000)
│   │   │   ├── review-service.yaml        #   Deployment + Service (Actix-web, 8082)
│   │   │   └── notification-worker.yaml   #   Deployment (Service 없음, consumer)
│   │   ├── data-tier/
│   │   │   ├── postgresql.yaml            #   StatefulSet + PVC + Headless Service
│   │   │   ├── mongodb.yaml               #   StatefulSet + PVC + Headless Service
│   │   │   ├── redis.yaml                 #   Deployment + Service (캐시, 비영속)
│   │   │   └── secrets.yaml               #   DB/MQ 자격증명
│   │   ├── messaging/
│   │   │   └── rabbitmq.yaml              #   StatefulSet + Management UI
│   │   ├── loadbalancer/
│   │   │   └── haproxy.yaml               #   HAProxy L4/L7 LB + Stats + Rate Limit
│   │   ├── logging/
│   │   │   └── efk-stack.yaml             #   Elasticsearch + Fluentd + Kibana
│   │   └── ingress/
│   │       └── ingress-routes.yaml        #   경로 기반 Ingress 라우팅
│   │
│   ├── overlays/                          # 환경별 Kustomize 오버레이
│   │   ├── dev/
│   │   │   ├── kustomization.yaml         #   namePrefix: dev-
│   │   │   ├── resource-patches.yaml      #   replicas: 1
│   │   │   └── dev-config.yaml            #   LOG_LEVEL: debug
│   │   ├── staging/
│   │   │   ├── kustomization.yaml         #   namePrefix: staging-
│   │   │   ├── resource-patches.yaml      #   replicas: 2
│   │   │   └── staging-config.yaml        #   LOG_LEVEL: info
│   │   └── prod/
│   │       ├── kustomization.yaml         #   namePrefix: prod-
│   │       ├── resource-patches.yaml      #   replicas: 2, topologySpread
│   │       ├── hpa.yaml                   #   HPA 3개 (order, product, cart)
│   │       ├── pdb.yaml                   #   PDB 4개 (minAvailable: 1)
│   │       ├── keda-scalers.yaml          #   KEDA ScaledObject (notification-worker)
│   │       └── prod-config.yaml           #   LOG_LEVEL: warn
│   │
│   └── istio/                             # Istio 서비스 메시
│       ├── destination-rules.yaml         #   서킷브레이커 (outlierDetection)
│       ├── virtual-services.yaml          #   재시도, 타임아웃, 카나리
│       └── peer-authentication.yaml       #   mTLS STRICT 모드
│
├── helm/                                  # ── Helm 차트 ──
│   └── devops-ecommerce/
│       ├── Chart.yaml
│       ├── values.yaml                    #   기본값
│       ├── values-dev.yaml                #   dev 오버라이드
│       ├── values-staging.yaml            #   staging 오버라이드
│       ├── values-prod.yaml               #   prod 오버라이드 (HPA+KEDA 활성화)
│       └── templates/
│           ├── _helpers.tpl
│           ├── namespace.yaml
│           ├── was-tier.yaml              #   4개 WAS 서비스 템플릿
│           ├── hpa.yaml                   #   조건부 HPA
│           └── NOTES.txt                  #   설치 후 안내 메시지
│
├── argocd/                                # ── GitOps CI/CD ──
│   ├── app-of-apps.yaml                   #   루트 Application
│   ├── dev-app.yaml                       #   dev → auto-sync
│   ├── staging-app.yaml                   #   staging → manual sync
│   └── prod-app.yaml                      #   prod → manual sync
│
├── loadtest/                              # ── 부하 테스트 ──
│   └── k6/
│       ├── lib/
│       │   ├── endpoints.js               #   API 엔드포인트 정의
│       │   └── helpers.js                 #   공통 유틸 (SLA 임계값, 커스텀 메트릭)
│       └── scenarios/
│           ├── smoke.js                   #   10 VU, 1분 (기본 검증)
│           ├── average-load.js            #   200 VU, 10분 (~200 RPS)
│           ├── peak-load.js               #   500 VU, 15분 (~300 RPS, MAU 1천만 피크)
│           ├── stress-test.js             #   2000 VU, 20분 (한계점 탐색)
│           └── soak-test.js               #   200 VU, 2시간 (메모리 누수 탐지)
│
├── monitoring/                            # ── 모니터링 ──
│   ├── service-monitors/
│   │   ├── order-service-monitor.yaml     #   /actuator/prometheus 스크래핑
│   │   ├── product-service-monitor.yaml   #   /metrics 스크래핑
│   │   └── cart-service-monitor.yaml      #   /metrics 스크래핑
│   ├── prometheus-rules/
│   │   └── sla-rules.yaml                #   P99>1s, 에러율>1%, Pod 재시작 알림
│   └── grafana-dashboards/
│       ├── ecommerce-overview.json        #   RPS, 에러율, 레이턴시, 큐 깊이
│       └── autoscaling-dashboard.json     #   HPA 레플리카, CPU%, KEDA 이벤트
│
├── scripts/                               # ── 자동화 스크립트 ──
│   ├── lib/
│   │   └── common.sh                     #   공통 함수 (kubectl_cmd, ssh_exec, 로깅)
│   ├── build-images.sh                    #   7개 앱 Docker 이미지 빌드 (ARM64)
│   ├── deploy.sh <cluster>               #   특정 클러스터에 Kustomize 배포
│   ├── deploy-all.sh                      #   전체 클러스터 배포
│   ├── verify.sh [cluster|all]           #   서비스 헬스체크 + 엔드포인트 검증
│   ├── run-loadtest.sh <scenario> [cluster] # k6 부하테스트 실행
│   ├── install-keda.sh [cluster]         #   KEDA 오퍼레이터 설치
│   ├── install-nginx-ingress.sh [cluster] #   Nginx Ingress Controller 설치
│   └── demo.sh [cluster]                 #   풀 데모 (빌드→배포→검증→테스트)
│
└── docs/                                  # ── 문서 ──
    ├── architecture.md
    ├── traffic-simulation.md
    ├── resource-budget.md
    ├── hands-on-lab.md                    #   13개 Lab 실습 가이드
    ├── traffic-handling.md                #   멀티레벨 캐시, Rate Limit, 백프레셔
    └── troubleshooting.md                 #   ARM64, 베어메탈 K8s, Tart VM 이슈
```

---

## 6. 사전 준비 (Prerequisites)

### 6.1 호스트 머신 요구사항

- **Apple Silicon Mac** (M1/M2/M3/M4)
- RAM: 64GB 이상 권장 (128GB 최적)
- 디스크 여유: 300GB 이상

### 6.2 필요 소프트웨어

```bash
# Tart (VM 가상화)
brew install cirruslabs/cli/tart

# Kubernetes 도구
brew install kubectl helm kustomize

# Docker (이미지 빌드)
brew install docker

# 부하 테스트
brew install k6

# (선택) Terraform - tart-infra에서 사용
brew install terraform

# (선택) sshpass - VM SSH 자동화
brew install esolitos/ipa/sshpass

# 설치 확인
tart --version && kubectl version --client && helm version && k6 version
```

### 6.3 사전 인프라 구축 (tart-infra 필요)

> 이 프로젝트는 [`tart-infra`](../tart-infra/) 프로젝트로 구축한 K8s 클러스터 위에서 동작합니다.
> tart-infra가 제공하는 것: Tart VM 10개, kubeadm K8s 4개 클러스터, Cilium CNI, Prometheus, Grafana, ArgoCD, Istio

```bash
# tart-infra 클러스터가 정상인지 확인
cd ../tart-infra
tart list                              # 10개 VM 확인
kubectl --kubeconfig=kubeconfig/dev.yaml get nodes    # dev 클러스터 확인
kubectl --kubeconfig=kubeconfig/prod.yaml get nodes   # prod 클러스터 확인
```

---

## 7. 재현 가이드 (Step-by-Step)

### Step 1: 프로젝트 클론 및 확인

```bash
cd ~/sideproject
git clone <this-repo-url> devops_dummpy
cd devops_dummpy

# 디렉토리 구조 확인
find . -type f | grep -v '.git/' | wc -l  # 약 94개 파일
```

### Step 2: Docker 이미지 빌드

```bash
# 7개 앱 이미지를 ARM64로 빌드 (약 10-15분)
./scripts/build-images.sh

# 빌드 결과 확인
docker images | grep -E "order-service|product-service|cart-service|user-service|review-service|notification-worker|frontend"
```

> **트러블슈팅**: `docker build` 실패 시 Docker Desktop이 실행 중인지 확인.
> Spring Boot 빌드는 Maven 의존성 다운로드로 인해 첫 빌드에 시간이 걸림.

### Step 3: K8s 클러스터에 이미지 로드

Tart VM 내부의 containerd에 이미지를 로드해야 합니다:

```bash
# 방법 1: docker save + ssh load (가장 간단)
IMAGES="order-service product-service cart-service user-service review-service notification-worker frontend"
WORKER_IP=$(tart ip dev-worker1)

for img in $IMAGES; do
  docker save ${img}:latest | \
    sshpass -p admin ssh admin@${WORKER_IP} "sudo ctr -n k8s.io images import -"
done

# 방법 2: 로컬 레지스트리 구축 (선택)
# platform 클러스터에 Docker Registry를 배포하고 이미지를 push/pull
```

### Step 4: Nginx Ingress Controller 설치

```bash
# 각 앱 클러스터에 Nginx Ingress Controller 설치
./scripts/install-nginx-ingress.sh dev
./scripts/install-nginx-ingress.sh staging   # staging 사용 시
./scripts/install-nginx-ingress.sh prod      # prod 사용 시
```

### Step 5: 앱 배포 (dev 환경부터)

```bash
# dev 클러스터에 배포
./scripts/deploy.sh dev

# 배포 상태 확인
./scripts/verify.sh dev

# 예상 출력:
# [INFO]  Pod status:
# NAME                                READY   STATUS    RESTARTS
# dev-order-service-xxx               1/1     Running   0
# dev-product-service-xxx             1/1     Running   0
# dev-cart-service-xxx                1/1     Running   0
# dev-user-service-xxx                1/1     Running   0
# dev-review-service-xxx              1/1     Running   0
# dev-notification-worker-xxx         1/1     Running   0
# dev-nginx-static-xxx                1/1     Running   0
# dev-apache-legacy-xxx               1/1     Running   0
# dev-postgresql-0                    1/1     Running   0
# dev-mongodb-0                       1/1     Running   0
# dev-redis-xxx                       1/1     Running   0
# dev-rabbitmq-0                      1/1     Running   0
```

### Step 6: 서비스 접속 확인

```bash
DEV_IP=$(tart ip dev-master)

# 프론트엔드
curl http://${DEV_IP}:30080/

# 상품 API (Node.js → MongoDB)
curl http://${DEV_IP}:30080/api/products

# 주문 생성 (Spring Boot/Tomcat → PostgreSQL → RabbitMQ)
curl -X POST http://${DEV_IP}:30080/api/orders \
  -H "Content-Type: application/json" \
  -d '{"userId":"user-1","productId":"prod-1","quantity":1,"totalPrice":29.99}'

# 장바구니 (Go → Redis)
curl -X POST http://${DEV_IP}:30080/api/cart \
  -H "Content-Type: application/json" \
  -d '{"userId":"user-1","productId":"prod-1","quantity":2}'

curl http://${DEV_IP}:30080/api/cart/user-1

# 유저 서비스 (Python/FastAPI → PostgreSQL)
curl -X POST http://${DEV_IP}:30080/api/users/register \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","email":"test@example.com","password":"pass123"}'

# 리뷰 서비스 (Rust/Actix-web → MongoDB)
curl -X POST http://${DEV_IP}:30080/api/reviews \
  -H "Content-Type: application/json" \
  -d '{"productId":"prod-1","userId":"user-1","rating":5,"comment":"Great!"}'

# 헬스체크
curl http://${DEV_IP}:30080/healthz
```

### Step 7: 부하 테스트 (k6)

```bash
# Smoke 테스트 (1분, 기본 검증)
./scripts/run-loadtest.sh smoke dev

# Average Load (10분, 일반 트래픽)
./scripts/run-loadtest.sh average-load dev

# Peak Load (15분, MAU 1천만 피크 시뮬레이션)
./scripts/run-loadtest.sh peak-load prod
```

### Step 8: 프로덕션 배포 (HPA + KEDA)

```bash
# KEDA 설치 (prod 클러스터)
./scripts/install-keda.sh prod

# prod 배포 (HPA + PDB + KEDA ScaledObject 포함)
./scripts/deploy.sh prod

# HPA 상태 확인
kubectl --kubeconfig=../tart-infra/kubeconfig/prod.yaml \
  get hpa -n ecommerce

# 스트레스 테스트로 HPA 트리거
./scripts/run-loadtest.sh stress-test prod

# HPA 스케일아웃 관찰 (별도 터미널)
kubectl --kubeconfig=../tart-infra/kubeconfig/prod.yaml \
  get hpa -n ecommerce -w
```

### Step 9: ArgoCD 연동 (GitOps)

```bash
# ArgoCD에 앱 등록 (platform 클러스터에서)
kubectl --kubeconfig=../tart-infra/kubeconfig/platform.yaml \
  apply -f argocd/app-of-apps.yaml

# ArgoCD UI 접속 (platform 클러스터의 ArgoCD NodePort)
PLATFORM_IP=$(tart ip platform-master)
echo "ArgoCD UI: http://${PLATFORM_IP}:30443"
```

### Step 10: 모니터링 확인

```bash
# Grafana 접속 (platform 클러스터)
PLATFORM_IP=$(tart ip platform-master)
echo "Grafana: http://${PLATFORM_IP}:30300"

# Grafana에서 대시보드 임포트:
#   monitoring/grafana-dashboards/ecommerce-overview.json
#   monitoring/grafana-dashboards/autoscaling-dashboard.json
```

---

## 8. MAU 1천만 트래픽 시뮬레이션 근거

### 8.1 트래픽 계산

```
MAU 10,000,000명
├── DAU = MAU / 30 = ~333,000명/일
├── 세션 = 5 세션/유저/일
├── 요청 = 10 요청/세션
├── 일일 총 요청 = 333K × 5 × 10 = 16,650,000 req/day
│
├── 평균 RPS = 16.65M / 86,400 = ~193 RPS
├── 피크 팩터 = 3x (피크 시간대 집중)
├── 피크 일일 = ~50M req/day
├── 피크 시간 = 일일 20% = ~10M req/hour = ~2,778 req/min = ~278 RPS
└── 버스트 피크 = ~500-1000 RPS (이벤트, 세일 등)
```

### 8.2 k6 시나리오 매핑

| 시나리오 | VU | 시간 | 예상 RPS | 시뮬레이션 대상 |
|---------|-----|------|---------|---------------|
| `smoke` | 10 | 1분 | ~10 | 엔드포인트 동작 확인 |
| `average-load` | 200 | 10분 | ~200 | 평일 평균 트래픽 |
| `peak-load` | 500 | 15분 | ~300 | **MAU 1천만 피크 시간** |
| `stress-test` | 2000 | 20분 | ~1000+ | 이벤트/세일 버스트, HPA 한계점 |
| `soak-test` | 200 | 2시간 | ~200 | 장시간 안정성 (메모리 누수, 커넥션 풀) |

### 8.3 트래픽 패턴 (읽기:쓰기 비율)

```
실제 e-commerce 트래픽 패턴:
├── 50% 상품 목록 조회 (GET /api/products)      → Redis 캐시 HIT
├── 20% 상품 상세 조회 (GET /api/products/:id)  → Redis 캐시 HIT
├── 15% 장바구니 조작 (POST/GET /api/cart)      → Redis 직접 R/W
└── 15% 주문 생성 (POST /api/orders)            → DB Write + MQ Publish
                                                    → notification-worker 트리거
```

---

## 9. 프로덕션 기능 상세

### 9.1 오토스케일링

| 방식 | 대상 | 트리거 | 범위 |
|------|------|--------|------|
| **HPA** | order-service | CPU > 50% | 2 → 6 레플리카 |
| **HPA** | product-service | CPU > 50% | 2 → 6 레플리카 |
| **HPA** | cart-service | CPU > 50% | 2 → 4 레플리카 |
| **KEDA** | notification-worker | RabbitMQ 큐 > 5개 | 1 → 5 레플리카 |
| **PDB** | 모든 WAS + Nginx | - | minAvailable: 1 |

HPA 스케일링 정책:
- **Scale Up**: 30초 안정화, 60초마다 최대 2 Pod 추가
- **Scale Down**: 300초 안정화 (급격한 축소 방지), 120초마다 1 Pod 감소

### 9.2 서킷브레이커 (Istio)

```yaml
outlierDetection:
  consecutive5xxErrors: 3    # 연속 5xx 3회 시
  interval: 10s              # 10초 간격 검사
  baseEjectionTime: 30s      # 30초간 제거
  maxEjectionPercent: 50     # 최대 50% 엔드포인트 제거
```

### 9.3 SLA/SLO 알림 규칙

| 알림 | 조건 | 심각도 |
|------|------|--------|
| OrderServiceHighLatency | P99 > 1초 (5분 지속) | warning |
| HighErrorRate | 에러율 > 1% (5분 지속) | critical |
| PodRestartLoop | 1시간 내 3회 이상 재시작 | warning |
| HPAMaxedOut | 최대 레플리카 5분 이상 유지 | warning |
| RabbitMQQueueBacklog | 큐 100개 초과 (5분 지속) | warning |

---

## 10. 블로그 작성 가이드

이 프로젝트를 블로그 시리즈로 작성할 때 추천하는 구성:

| 편 | 제목 (예시) | 핵심 내용 |
|----|-----------|----------|
| 1편 | 프로젝트 소개: MAU 1천만 서비스를 로컬에서 구현하기 | 동기, 아키텍처 설계, 기술 선택 이유 |
| 2편 | Tart VM으로 멀티 K8s 클러스터 구축하기 | tart-infra 프로젝트, VM 리소스 배분, kubeadm |
| 3편 | 마이크로서비스 설계: 왜 5가지 언어를 썼는가 | Java/Node.js/Go/Python/Rust 선택 이유, DB 분리 전략 |
| 4편 | Nginx + Apache: 웹서버 이중화와 리버스 프록시 | WEB 계층 구성, rate limiting, 레거시 호환 |
| 5편 | 5가지 WAS 심층 분석: Tomcat + Express + Go + FastAPI + Actix | 각 WAS 특성, 성능 비교, Prometheus 메트릭 |
| 6편 | PostgreSQL + MongoDB + Redis: 멀티 DB 전략 | SQL vs NoSQL 사용 분기, Redis 캐시 전략 |
| 7편 | RabbitMQ와 이벤트 기반 아키텍처 | 주문 이벤트 흐름, KEDA 연동 |
| 8편 | Kustomize + Helm: K8s 배포 전략 비교 | base/overlay 패턴, Helm 파라미터화 |
| 9편 | ArgoCD GitOps: App-of-Apps 패턴 | 멀티 환경 배포 자동화, sync 정책 |
| 10편 | Istio 서비스 메시: 서킷브레이커와 mTLS | 장애 격리, 보안 통신, 카나리 배포 |
| 11편 | HPA + KEDA: 탄력적 오토스케일링 | CPU 기반 vs 이벤트 기반, 스케일링 관찰 |
| 12편 | k6 부하 테스트: MAU 1천만 시뮬레이션 | 트래픽 계산, 시나리오 설계, 결과 분석 |
| 13편 | Prometheus + Grafana: SRE 대시보드 구축 | ServiceMonitor, 알림 규칙, 대시보드 |
| 14편 | HAProxy L4/L7 로드밸런싱과 Rate Limiting | stick-table, Stats UI, 트래픽 제어 |
| 15편 | EFK Stack으로 중앙 로그 수집 | Elasticsearch + Fluentd + Kibana 구축 |
| 16편 | 트래픽 대응 전략: 캐시, 백프레셔, 서킷브레이커 | 멀티레벨 캐시, KEDA 백프레셔, Istio 서킷브레이커 |
| 17편 | 트러블슈팅 사례 모음 | OOM, 커넥션 풀, HPA 미작동 등 실제 이슈 |
| 18편 | 회고: 이 프로젝트에서 배운 것들 | 개선점, 실무 vs 포트폴리오 차이 |

### 블로그 작성 팁

- 각 편마다 **스크린샷**을 첨부 (Grafana 대시보드, ArgoCD UI, k6 결과, `kubectl get pods` 출력)
- 장애 시나리오를 **의도적으로 만들고 해결하는 과정**을 기록하면 매우 인상적
- `tart list` → VM 기동 → `kubectl get nodes` → 앱 배포 → 부하 테스트 → HPA 확장 순서로 진행하면 자연스러운 스토리라인

---

## 11. 관련 프로젝트

| 프로젝트 | 설명 | 핵심 기술 |
|---------|------|----------|
| [`tart-infra`](../tart-infra/) | Tart VM + K8s 클러스터 프로비저닝 | Terraform, kubeadm, Cilium, Prometheus |
| [`middle_ware`](../middle_ware/) | Docker Compose WEB/WAS 미들웨어 | Nginx, Tomcat, MySQL, Keycloak, Scouter |
| **`devops_dummpy`** | MAU 1천만 E-Commerce 플랫폼 | K8s, Helm, ArgoCD, Istio, HPA, KEDA, k6 |

---

## 12. 라이선스

이 프로젝트는 학습/포트폴리오 목적으로 제작되었습니다.
# devops_dummy
