# DevOps E-Commerce 포트폴리오 학습계획서

> 하루 2시간 기준 | 총 5주 (25일) | 2026-03-17(화) ~ 04-18(금)

---

## 전체 진행률

- [ ] 1주차: 인프라 기초 (10h)
- [ ] 2주차: 서비스 아키텍처 (10h)
- [ ] 3주차: 운영 기술 (10h)
- [ ] 4주차: 고급 주제 (10h)
- [ ] 5주차: 종합 실습 + 정리 (10h)

| 주차 | 기간 | 주제 | 학습시간 |
|------|------|------|---------|
| **1주차** | 03/17 ~ 03/21 | 인프라 기초: VM, K8s, Docker, 배포 | 10시간 |
| **2주차** | 03/24 ~ 03/28 | 서비스 아키텍처: 소스코드, 통신, 데이터 | 10시간 |
| **3주차** | 03/31 ~ 04/04 | 운영 기술: 오토스케일링, 모니터링, 로깅 | 10시간 |
| **4주차** | 04/07 ~ 04/11 | 고급 주제: Istio, ArgoCD, 부하테스트 | 10시간 |
| **5주차** | 04/14 ~ 04/18 | 종합 실습, 복습, 블로그 정리 | 10시간 |
| **합계** | | | **50시간** |

---

## 1주차: 인프라 기초 (03/17 ~ 03/21)

> 목표: VM 환경 구축부터 K8s 배포까지 전체 파이프라인을 이해한다.

### Day 1 (03/17 화) - 프로젝트 구조 파악 + 아키텍처 이해

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 1시간 | README.md를 정독하고, 디렉토리 구조를 전체 탐색한다. 프로젝트 3개(tart-infra/middle_ware/devops_dummpy)의 관계를 파악한다. | `README.md`, `docs/review/00-overview.md` |
| 1시간 | 전체 시스템 아키텍처 다이어그램을 직접 노트에 그려본다. 멀티티어(WEB→WAS→DB), 멀티클러스터(dev/staging/prod/platform) 구조를 파악한다. | `docs/architecture.md` |

**학습 체크:**
- [ ] README.md 정독 완료
- [ ] docs/review/00-overview.md 읽기 완료
- [ ] docs/architecture.md 읽기 완료
- [ ] 디렉토리 구조(apps/manifests/helm/argocd/loadtest/monitoring/scripts/docs) 파악 완료

**이해도 체크:**
- [ ] 7개 서비스 이름과 사용 언어를 빈 종이에 써볼 수 있다
- [ ] 4개 클러스터(dev/staging/prod/platform)의 역할을 각각 설명할 수 있다
- [ ] 서비스 간 통신 흐름(주문생성→RabbitMQ→notification-worker)을 그릴 수 있다
- [ ] 프로젝트 3개(tart-infra/middle_ware/devops_dummpy)의 관계를 설명할 수 있다

---

### Day 2 (03/18 수) - Tart VM + K8s 클러스터 구성

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 1.5시간 | Tart VM 개념을 학습하고, VM 생성(tart clone/set), kubeadm init/join을 통한 클러스터 구성, Cilium CNI 설치 과정을 익힌다. | `docs/review/01-vm-cluster-setup.md` |
| 0.5시간 | VM 리소스 배분을 이해한다. 13개 VM의 vCPU/RAM 할당, 오버커밋 2:1 비율의 근거, 권장 운영 모드(풀 프로덕션 vs 최소 기동)를 파악한다. | `docs/resource-budget.md` |

**학습 체크:**
- [ ] docs/review/01-vm-cluster-setup.md 읽기 완료
- [ ] docs/resource-budget.md 읽기 완료

**실습 체크:**
- [ ] `tart list`로 VM 목록을 확인했다
- [ ] `kubectl get nodes`로 각 클러스터 노드 상태를 확인했다
- [ ] 각 클러스터의 vCPU/RAM 할당표를 직접 정리했다

**이해도 체크:**
- [ ] Tart가 Apple Virtualization Framework 기반인 이유를 이해했다
- [ ] kubeadm init/join 과정(control-plane 초기화 → worker join)을 설명할 수 있다
- [ ] master 노드와 worker 노드의 역할 차이를 설명할 수 있다
- [ ] 오버커밋 2:1이 실용적으로 문제없는 이유를 이해했다

---

### Day 3 (03/19 목) - Docker 멀티스테이지 빌드

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 1시간 | 7개 서비스의 Dockerfile을 분석한다. 빌드 스테이지 분리(builder→runtime), 레이어 캐싱, ARM64 빌드 방식을 파악한다. | `docs/review/02-container-image-build.md` |
| 1시간 | `./scripts/build-images.sh`를 실행하고, 이미지 크기를 비교한다. VM에 이미지를 로드(docker save + ctr import)한다. | `apps/*/Dockerfile` 7개 |

**학습 체크:**
- [ ] docs/review/02-container-image-build.md 읽기 완료
- [ ] apps/order-service/Dockerfile 분석 완료 (Java/Spring Boot)
- [ ] apps/product-service/Dockerfile 분석 완료 (Node.js)
- [ ] apps/cart-service/Dockerfile 분석 완료 (Go)
- [ ] apps/user-service/Dockerfile 분석 완료 (Python)
- [ ] apps/review-service/Dockerfile 분석 완료 (Rust)
- [ ] apps/notification-worker/Dockerfile 분석 완료 (Node.js)
- [ ] apps/frontend/Dockerfile 분석 완료 (Nginx)

**실습 체크:**
- [ ] `./scripts/build-images.sh` 실행에 성공했다
- [ ] `docker images`로 7개 이미지를 확인했다
- [ ] 이미지 크기 비교 결과를 메모했다 (Go ~15MB vs Java ~200MB vs Rust ~50MB)

**이해도 체크:**
- [ ] 멀티스테이지 빌드가 이미지 크기를 줄이는 원리를 설명할 수 있다
- [ ] Go/Rust가 Java보다 이미지가 작은 이유를 설명할 수 있다
- [ ] 레이어 캐싱이 빌드 속도에 미치는 영향을 이해했다

---

### Day 4 (03/20 금) - Kustomize 배포

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 1시간 | Kustomize의 base/overlay 패턴, namePrefix, 리소스 패치 개념을 학습한다. `kustomize build`로 dev/staging/prod 렌더링 결과를 비교한다. | `docs/review/03-kustomize-deploy.md` |
| 1시간 | `manifests/base/` 매니페스트를 분석하고, `./scripts/deploy.sh dev`를 실행하여 dev 클러스터에 배포한다. | `manifests/base/` 전체 |

**학습 체크:**
- [ ] docs/review/03-kustomize-deploy.md 읽기 완료
- [ ] manifests/base/kustomization.yaml 분석 완료
- [ ] manifests/base/web-tier/ 매니페스트 분석 완료
- [ ] manifests/base/was-tier/ 매니페스트 분석 완료
- [ ] manifests/base/data-tier/ 매니페스트 분석 완료
- [ ] manifests/overlays/dev/kustomization.yaml 분석 완료
- [ ] manifests/overlays/prod/kustomization.yaml 분석 완료

**실습 체크:**
- [ ] `kustomize build manifests/overlays/dev` 출력을 확인했다
- [ ] `kustomize build manifests/overlays/prod` 출력을 확인했다
- [ ] dev/staging/prod의 replicas, LOG_LEVEL 차이를 비교했다
- [ ] `./scripts/deploy.sh dev` 실행에 성공했다
- [ ] `kubectl get pods -n ecommerce`로 12개 이상의 Pod가 Running 상태임을 확인했다

**이해도 체크:**
- [ ] base/overlay 패턴의 장점을 설명할 수 있다
- [ ] Deployment와 StatefulSet의 차이를 설명할 수 있다
- [ ] resources.requests와 limits의 차이를 설명할 수 있다
- [ ] readinessProbe와 livenessProbe의 차이를 설명할 수 있다

---

### Day 5 (03/21 토) - 1주차 복습 + 전체 파이프라인 재확인

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 1시간 | VM 기동 → kubectl get nodes → deploy → verify 순서로 전체 파이프라인을 처음부터 재실행한다. | `./scripts/demo.sh dev` |
| 1시간 | 이해가 부족한 부분을 재학습하고, 트러블슈팅 가이드를 읽는다. | `docs/troubleshooting.md` |

**실습 체크:**
- [ ] `./scripts/demo.sh dev` 또는 수동으로 전체 파이프라인을 재실행했다
- [ ] `./scripts/verify.sh dev`가 통과했다

**복습 체크:**
- [ ] docs/troubleshooting.md 읽기 완료
- [ ] 1주차에서 이해가 부족했던 부분을 재학습했다
- [ ] VM 기동→K8s 클러스터→Docker 빌드→Kustomize 배포의 전체 흐름을 말로 설명할 수 있다

---

## 2주차: 서비스 아키텍처 (03/24 ~ 03/28)

> 목표: 각 서비스의 내부 구조, 통신 흐름, 데이터 아키텍처를 완전히 이해한다.

### Day 6 (03/24 월) - WAS 서비스 소스코드 분석 (1/2)

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 1시간 | **order-service** (Java/Spring Boot): JPA Entity→Repository→Service→Controller 구조, RabbitMQ 이벤트 발행, Actuator 메트릭 노출 방식을 분석한다. | `apps/order-service/src/` |
| 1시간 | **product-service** (Node.js/Express): Mongoose 스키마, Redis 캐시 미들웨어(TTL 60s), prom-client 메트릭, 샘플 데이터 시딩 로직을 분석한다. | `apps/product-service/src/` |

**학습 체크:**
- [ ] order-service: OrderApplication.java (메인 클래스) 분석 완료
- [ ] order-service: controller/ (REST API) 분석 완료
- [ ] order-service: service/ (비즈니스 로직 + RabbitMQ 발행) 분석 완료
- [ ] order-service: repository/ (JPA Repository) 분석 완료
- [ ] order-service: model/ (JPA Entity) 분석 완료
- [ ] order-service: config/ (RabbitMQ 설정) 분석 완료
- [ ] order-service: application.properties (DB/MQ/Actuator 설정) 분석 완료
- [ ] product-service: index.js (Express 서버, MongoDB/Redis 연결) 분석 완료
- [ ] product-service: routes/products.js (CRUD API + Redis 캐시) 분석 완료
- [ ] product-service: models/Product.js (Mongoose 스키마) 분석 완료
- [ ] product-service: middleware/cache.js (Redis 캐시 미들웨어) 분석 완료

**이해도 체크:**
- [ ] Spring Boot의 Controller→Service→Repository 레이어 구조를 설명할 수 있다
- [ ] RabbitMQ의 Exchange/Queue/Binding 관계를 설명할 수 있다
- [ ] Redis 캐시 HIT/MISS 흐름을 코드에서 추적할 수 있다
- [ ] prom-client로 커스텀 메트릭을 노출하는 방식을 이해했다

---

### Day 7 (03/25 화) - WAS 서비스 소스코드 분석 (2/2)

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 40분 | **cart-service** (Go): main.go에서 Redis Hash를 조작하는 방식, checkout 시 order-service를 HTTP 호출하는 흐름, promhttp 메트릭을 분석한다. | `apps/cart-service/main.go` |
| 40분 | **user-service** (Python/FastAPI): AsyncSession 기반 비동기 DB 연결, JWT 인증, SQLAlchemy 비동기 모델을 분석한다. | `apps/user-service/` |
| 40분 | **review-service** (Rust/Actix-web): 핸들러 구조, MongoDB aggregation을 활용한 별점 통계, 중복 방지 로직을 분석한다. | `apps/review-service/src/main.rs` |

**학습 체크:**
- [ ] cart-service: main.go (Redis Hash 기반 장바구니 CRUD) 분석 완료
- [ ] cart-service: go.mod (의존성: go-redis, prometheus client) 확인 완료
- [ ] user-service: main.py (FastAPI 앱, 라우터 등록) 분석 완료
- [ ] user-service: models.py (SQLAlchemy 비동기 모델) 분석 완료
- [ ] user-service: database.py (AsyncSession, DB 연결) 분석 완료
- [ ] review-service: src/main.rs (REST API + MongoDB 연결) 분석 완료
- [ ] review-service: Cargo.toml (의존성: actix-web, mongodb, serde) 확인 완료
- [ ] notification-worker: src/worker.js (큐 소비 + 알림 시뮬레이션) 분석 완료

**이해도 체크:**
- [ ] 5개 WAS 각각이 어떤 DB와 연결되는지 말할 수 있다
- [ ] Go의 초경량 바이너리, Rust의 메모리 안전성 등 언어별 장점을 설명할 수 있다
- [ ] cart-service의 checkout이 order-service를 HTTP로 호출하는 흐름을 이해했다
- [ ] FastAPI의 비동기 ASGI 방식과 Swagger 자동 문서 생성 원리를 이해했다

---

### Day 8 (03/26 수) - 서비스 간 통신 흐름 + API 호출 실습

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 1시간 | curl로 전체 API를 호출한다. 상품 생성→조회, 주문 생성→RabbitMQ→notification-worker 로그 확인, 장바구니 CRUD→checkout 흐름을 따라간다. | `docs/review/04-service-architecture.md` |
| 1시간 | **Lab 1** (멀티티어 체험)과 **Lab 2** (RabbitMQ 이벤트) 실습을 진행한다. | `docs/hands-on-lab.md` Lab 1, 2 |

**학습 체크:**
- [ ] docs/review/04-service-architecture.md 읽기 완료

**실습 체크:**
- [ ] curl: GET /api/products (상품 조회) 성공
- [ ] curl: POST /api/products (상품 생성) 성공
- [ ] curl: POST /api/orders (주문 생성) 성공
- [ ] curl: GET /api/orders (주문 조회) 성공
- [ ] curl: POST /api/cart (장바구니 추가) 성공
- [ ] curl: GET /api/cart/:userId (장바구니 조회) 성공
- [ ] curl: POST /api/users/register (유저 등록) 성공
- [ ] curl: POST /api/reviews (리뷰 작성) 성공
- [ ] curl: GET /healthz (헬스체크) 성공
- [ ] Lab 1 완료: 멀티티어(WEB→WAS→DB) 체험
- [ ] Lab 2 완료: RabbitMQ 이벤트 흐름 확인

**이해도 체크:**
- [ ] 주문 생성 후 notification-worker 로그에서 이벤트 수신을 확인했다
- [ ] RabbitMQ Management UI(포트 31672)에서 큐 상태를 확인했다
- [ ] rabbitmqctl list_queues로 consumers 수가 1 이상임을 확인했다

---

### Day 9 (03/27 목) - 데이터 아키텍처 + 캐시 전략

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 1시간 | 데이터베이스 분리 전략을 학습한다. PostgreSQL(트랜잭션)→주문/유저, MongoDB(문서형)→상품/리뷰, Redis(인메모리)→캐시/세션/장바구니로 나눈 이유를 파악한다. | `docs/architecture.md` 4절 |
| 1시간 | **Lab 3** (Redis 캐시 HIT/MISS 관찰)과 **Lab 4** (Rate Limiting 체험) 실습을 진행한다. | `docs/hands-on-lab.md` Lab 3, 4 |

**학습 체크:**
- [ ] docs/architecture.md 4절 (데이터 아키텍처) 읽기 완료
- [ ] manifests/base/data-tier/postgresql.yaml 분석 완료 (StatefulSet + PVC)
- [ ] manifests/base/data-tier/mongodb.yaml 분석 완료 (StatefulSet + PVC)
- [ ] manifests/base/data-tier/redis.yaml 분석 완료 (Deployment, 비영속)

**실습 체크:**
- [ ] Lab 3 완료: Redis 캐시 HIT/MISS를 관찰했다
- [ ] redis-cli KEYS "products:*" 실행으로 캐시 키를 확인했다
- [ ] redis-cli TTL "products:list" 실행으로 남은 TTL을 확인했다
- [ ] 상품 생성 후 캐시가 자동 무효화되는 것을 확인했다
- [ ] Lab 4 완료: Rate Limiting을 체험했다
- [ ] 요청 초과 시 429/503 응답이 반환되는 것을 확인했다
- [ ] HAProxy Stats 대시보드(포트 30884)에서 deny 카운트 증가를 확인했다

**이해도 체크:**
- [ ] SQL과 NoSQL의 선택 기준을 자기 말로 설명할 수 있다
- [ ] Redis를 캐시/세션/장바구니에 사용하는 이유를 설명할 수 있다
- [ ] StatefulSet(DB)과 Deployment(Redis)를 구분하여 사용하는 이유를 이해했다

---

### Day 10 (03/28 금) - 트래픽 대응 전략 + 2주차 복습

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 1시간 | 멀티레벨 캐시(Nginx L1→Redis L2→DB L3), HAProxy Rate Limiting(stick-table), 백프레셔(KEDA) 전략을 학습한다. | `docs/traffic-handling.md` |
| 1시간 | 2주차 복습: 서비스 간 통신 다이어그램을 빈 종이에 직접 그려보고, 전체 API 엔드포인트를 정리한다. | 자체 복습 |

**학습 체크:**
- [ ] docs/traffic-handling.md 읽기 완료

**복습 체크:**
- [ ] 서비스 간 통신 다이어그램을 직접 그렸다
- [ ] 멀티레벨 캐시 3단계(Nginx→Redis→DB) 흐름을 설명할 수 있다
- [ ] HAProxy stick-table 기반 Rate Limiting의 원리를 이해했다
- [ ] 백프레셔가 시스템 과부하를 방지하는 방식을 설명할 수 있다

---

## 3주차: 운영 기술 (03/31 ~ 04/04)

> 목표: 프로덕션 운영에 필요한 오토스케일링, 모니터링, 로깅을 이해한다.

### Day 11 (03/31 월) - HPA 오토스케일링

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 1시간 | HPA 개념을 학습한다. CPU/메모리 기반 수평 스케일링, 스케일업/다운 정책(stabilizationWindow, selectPolicy)을 파악하고, `manifests/overlays/prod/hpa.yaml`을 분석한다. | `docs/review/05-autoscaling.md` |
| 1시간 | prod 클러스터에 배포한 후 `kubectl get hpa`를 확인하고, **Lab 6** (HPA 스케일아웃 관찰) 실습을 진행한다. | `docs/hands-on-lab.md` Lab 6 |

**학습 체크:**
- [ ] docs/review/05-autoscaling.md 읽기 완료
- [ ] manifests/overlays/prod/hpa.yaml 분석 완료 (6개 HPA)
- [ ] manifests/overlays/prod/pdb.yaml 분석 완료 (8개 PDB)

**실습 체크:**
- [ ] `./scripts/deploy.sh prod` 실행에 성공했다
- [ ] `kubectl get hpa -n ecommerce`로 HPA 상태를 확인했다
- [ ] Lab 6 완료: stress-test로 HPA를 트리거했다
- [ ] `kubectl get hpa -n ecommerce -w`로 REPLICAS 변화를 실시간 관찰했다
- [ ] 부하 종료 후 5분(stabilizationWindow) 대기 → 스케일다운이 발생하는 것을 확인했다

**이해도 체크:**
- [ ] HPA의 minReplicas/maxReplicas/targetCPU 설정을 설명할 수 있다
- [ ] stabilizationWindowSeconds(300초)가 필요한 이유를 이해했다 (급격한 축소 방지)
- [ ] selectPolicy: Max의 의미를 이해했다 (Percent 정책과 Pods 정책 중 큰 쪽 적용)

---

### Day 12 (04/01 화) - KEDA + PDB

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 1시간 | KEDA 개념을 학습한다. 이벤트 기반 스케일링, ScaledObject 구조, RabbitMQ 큐 깊이 트리거를 파악하고, `manifests/overlays/prod/keda-scalers.yaml`을 분석한다. | `docs/review/05-autoscaling.md` |
| 1시간 | PDB(PodDisruptionBudget) 개념을 학습하고, **Lab 7** (KEDA 이벤트 기반 스케일링) 실습을 진행한다. | `docs/hands-on-lab.md` Lab 7 |

**학습 체크:**
- [ ] manifests/overlays/prod/keda-scalers.yaml 분석 완료
- [ ] KEDA ScaledObject 구조(triggers/pollingInterval/cooldownPeriod)를 파악했다

**실습 체크:**
- [ ] `./scripts/install-keda.sh prod` 실행에 성공했다
- [ ] Lab 7 완료: 주문 100개를 생성하여 RabbitMQ 큐에 메시지를 쌓고 worker 스케일아웃을 관찰했다
- [ ] `kubectl get scaledobject -n ecommerce`로 ScaledObject 상태를 확인했다
- [ ] 큐가 소진된 후 cooldownPeriod(60초) 경과 → 스케일다운이 발생하는 것을 확인했다

**이해도 체크:**
- [ ] HPA(CPU 기반)와 KEDA(이벤트 기반)의 차이를 설명할 수 있다
- [ ] KEDA가 RabbitMQ 큐 깊이 5 초과 시 트리거되는 원리를 이해했다
- [ ] PDB의 minAvailable이 롤링 업데이트 시 최소 가용 Pod 수를 보장하는 방식을 이해했다

---

### Day 13 (04/02 수) - Prometheus + Grafana 모니터링

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 1시간 | Prometheus 개념을 학습한다. ServiceMonitor CRD의 역할, Pull 방식 스크래핑을 파악하고, 각 서비스의 /metrics 엔드포인트를 curl로 확인한다. `monitoring/service-monitors/`를 분석한다. | `docs/review/06-monitoring-observability.md` |
| 1시간 | Grafana 대시보드를 임포트하고, PrometheusRule(SLA 알림)을 분석한다. **Lab 9** 실습을 진행한다. | `docs/hands-on-lab.md` Lab 9 |

**학습 체크:**
- [ ] docs/review/06-monitoring-observability.md 읽기 완료
- [ ] monitoring/service-monitors/ 7개 ServiceMonitor 분석 완료
- [ ] monitoring/grafana-dashboards/ecommerce-overview.json 구조 파악 완료
- [ ] monitoring/grafana-dashboards/autoscaling-dashboard.json 구조 파악 완료

**실습 체크:**
- [ ] curl로 order-service /actuator/prometheus 응답을 확인했다
- [ ] curl로 product-service /metrics 응답을 확인했다
- [ ] curl로 cart-service /metrics 응답을 확인했다
- [ ] Prometheus Targets에서 모든 서비스가 UP 상태임을 확인했다
- [ ] Grafana 대시보드를 임포트했다 (ecommerce-overview + autoscaling)
- [ ] Lab 9 완료

**이해도 체크:**
- [ ] ServiceMonitor가 Prometheus에게 스크래핑 대상을 알려주는 방식을 이해했다
- [ ] Grafana 대시보드에서 RPS, 레이턴시, 에러율 패널에 데이터가 표시되는 것을 확인했다
- [ ] PromQL 기본 쿼리(예: `rate(http_requests_total[5m])`)의 의미를 이해했다

---

### Day 14 (04/03 목) - EFK 로그 수집 + SLA 알림

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 1시간 | EFK Stack의 구조를 학습한다. Elasticsearch(저장) + Fluentd(수집, DaemonSet) + Kibana(검색/시각화) 역할을 파악하고, `manifests/base/logging/efk-stack.yaml`을 분석한다. **Lab 10** 실습을 진행한다. | `docs/hands-on-lab.md` Lab 10 |
| 1시간 | PrometheusRule SLA 알림 규칙을 분석한다. P99 > 1s, 에러율 > 1%, Pod 재시작 등 5개 규칙의 PromQL 표현식을 해석한다. | `monitoring/prometheus-rules/sla-rules.yaml` |

**학습 체크:**
- [ ] manifests/base/logging/efk-stack.yaml 분석 완료
- [ ] monitoring/prometheus-rules/sla-rules.yaml 분석 완료
- [ ] 5개 알림 규칙의 PromQL 표현식을 해석했다

**실습 체크:**
- [ ] Lab 10 완료: EFK 로그 수집을 체험했다
- [ ] Elasticsearch 클러스터 상태(green 또는 yellow)를 확인했다
- [ ] Kibana UI(포트 31601)에 접속했다
- [ ] Kibana에서 서비스별 로그 필터링에 성공했다

**이해도 체크:**
- [ ] Fluentd가 DaemonSet으로 배포되는 이유(노드마다 1개씩 배치하여 로그 수집)를 이해했다
- [ ] SLA 알림 규칙 5개(P99>1s, 에러율>1%, Pod 재시작, HPA 최대치 유지, 큐 백로그)의 조건과 심각도를 설명할 수 있다
- [ ] 메트릭(Prometheus), 로그(EFK), 트레이싱(Jaeger) 각각의 역할 차이를 설명할 수 있다

---

### Day 15 (04/04 금) - 3주차 복습

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 1시간 | 오토스케일링 총정리: HPA + KEDA + PDB의 관계를 다이어그램으로 그려본다. | 자체 복습 |
| 1시간 | 모니터링 총정리: 메트릭, 로그, 트레이싱, APM 각각의 역할을 구분하여 정리한다. | 자체 복습 |

**복습 체크:**
- [ ] HPA(CPU→Pod 수 증가) + KEDA(큐→워커 증가) + PDB(최소 가용 보장) 관계도를 그렸다
- [ ] 각 서비스의 메트릭 엔드포인트와 사용 라이브러리를 정리했다
- [ ] Prometheus→Grafana→AlertManager 파이프라인을 설명할 수 있다
- [ ] EFK 파이프라인(Fluentd 수집→Elasticsearch 저장→Kibana 검색)을 설명할 수 있다

---

## 4주차: 고급 주제 (04/07 ~ 04/11)

> 목표: 서비스 메시, GitOps, 부하 테스트 등 프로덕션급 기술을 습득한다.

### Day 16 (04/07 월) - Istio 서비스 메시 (1/2)

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 1시간 | Istio 개념을 학습한다. 사이드카 프록시(Envoy)의 역할, mTLS(PeerAuthentication STRICT 모드)를 통한 서비스 간 암호화 통신을 파악한다. | `docs/review/07-service-mesh-istio.md` |
| 1시간 | `manifests/istio/` 3개 파일을 상세 분석한다. destination-rules.yaml(서킷브레이커), virtual-services.yaml(재시도/타임아웃/카나리), peer-authentication.yaml(mTLS) 각각의 설정을 파악한다. | `manifests/istio/` |

**학습 체크:**
- [ ] docs/review/07-service-mesh-istio.md 읽기 완료
- [ ] manifests/istio/destination-rules.yaml 분석 완료 (서킷브레이커, connectionPool)
- [ ] manifests/istio/virtual-services.yaml 분석 완료 (재시도, 타임아웃, 카나리)
- [ ] manifests/istio/peer-authentication.yaml 분석 완료 (mTLS STRICT)

**이해도 체크:**
- [ ] Istio 사이드카 프록시(Envoy)가 수행하는 역할을 설명할 수 있다
- [ ] mTLS가 필요한 이유(서비스 간 통신 암호화)를 설명할 수 있다
- [ ] Data Plane(Envoy)과 Control Plane(istiod)의 차이를 설명할 수 있다

---

### Day 17 (04/08 화) - Istio 서비스 메시 (2/2) + 서킷브레이커 실습

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 1시간 | 서킷브레이커의 동작 원리를 학습한다. outlierDetection 파라미터, connectionPool 설정, 카나리 배포 패턴을 파악한다. | `docs/review/07-service-mesh-istio.md` |
| 1시간 | **Lab 8** (서킷브레이커 체험) 실습을 진행한다. Pod를 강제 종료한 후 Istio가 비정상 엔드포인트를 제거하는 것을 관찰한다. | `docs/hands-on-lab.md` Lab 8 |

**실습 체크:**
- [ ] istio-injection=enabled 레이블을 적용했다
- [ ] DestinationRule과 VirtualService를 적용했다
- [ ] Lab 8 완료: Pod 강제 종료 후 서킷브레이커 동작을 관찰했다
- [ ] Pod 삭제 후에도 서비스 가용성이 유지되는 것을 확인했다
- [ ] 새 Pod가 복구된 후 트래픽이 재분배되는 것을 확인했다

**이해도 체크:**
- [ ] 서킷브레이커가 장애 전파를 막는 원리를 설명할 수 있다
- [ ] outlierDetection(연속 5xx 3회→30초 제거→최대 50% 제거) 설정을 설명할 수 있다
- [ ] 카나리 배포에서 VirtualService의 weight를 조절하는 방식을 이해했다

---

### Day 18 (04/09 수) - ArgoCD GitOps

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 1시간 | ArgoCD 개념을 학습한다. GitOps 원칙(Git = Single Source of Truth), App-of-Apps 패턴을 파악하고, `argocd/` 디렉토리의 4개 파일을 분석한다. | `docs/review/08-gitops-argocd.md` |
| 1시간 | **Lab 12** (ArgoCD 동기화 체험) 실습을 진행한다. auto-sync(dev)와 manual-sync(prod)의 차이를 확인하고, selfHeal 테스트를 수행한다. | `docs/hands-on-lab.md` Lab 12 |

**학습 체크:**
- [ ] docs/review/08-gitops-argocd.md 읽기 완료
- [ ] argocd/app-of-apps.yaml 분석 완료 (루트 Application)
- [ ] argocd/dev-app.yaml 분석 완료 (auto-sync)
- [ ] argocd/staging-app.yaml 분석 완료 (manual sync)
- [ ] argocd/prod-app.yaml 분석 완료 (manual sync)

**실습 체크:**
- [ ] app-of-apps.yaml을 적용했다
- [ ] ArgoCD UI(포트 30443)에 접속했다
- [ ] Lab 12 완료: auto-sync(dev)와 manual-sync(prod) 차이를 확인했다
- [ ] selfHeal 테스트: kubectl edit로 리소스를 변경한 후 ArgoCD가 자동 복원하는 것을 확인했다

**이해도 체크:**
- [ ] GitOps의 장점(선언적 관리, 감사 추적, 손쉬운 롤백)을 설명할 수 있다
- [ ] ArgoCD UI에서 Synced/OutOfSync/Healthy/Degraded 각 상태의 의미를 이해했다
- [ ] App-of-Apps 패턴이 멀티 환경 관리에 유리한 이유를 설명할 수 있다

---

### Day 19 (04/10 목) - Helm 차트 + Kustomize 비교

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 1시간 | Helm 개념을 학습한다. Chart.yaml/values.yaml 구조, templates/ 내 조건부 렌더링을 파악한다. **Lab 11** (Kustomize 환경별 비교) 실습을 진행한다. | `helm/devops-ecommerce/`, Lab 11 |
| 1시간 | Helm과 Kustomize의 장단점을 비교 정리한다. 실무에서의 선택 기준을 정리한다. | 자체 정리 |

**학습 체크:**
- [ ] helm/devops-ecommerce/Chart.yaml 분석 완료
- [ ] helm/devops-ecommerce/values.yaml 분석 완료
- [ ] helm/devops-ecommerce/values-dev.yaml과 values-prod.yaml의 차이를 비교했다
- [ ] helm/devops-ecommerce/templates/ 내 조건부 렌더링(if .Values.hpa.enabled) 분석 완료

**실습 체크:**
- [ ] Lab 11 완료: Kustomize 환경별 비교를 수행했다
- [ ] `helm template` 출력을 확인했다
- [ ] `kustomize build`와 `helm template`의 출력을 비교했다

**이해도 체크:**
- [ ] Helm의 Go 템플릿 문법을 기본적으로 읽을 수 있다
- [ ] Helm(패키징/파라미터화)과 Kustomize(패치/오버레이) 각각의 장단점을 설명할 수 있다
- [ ] 실무에서 Helm을 사용할 때와 Kustomize를 사용할 때의 기준을 설명할 수 있다

---

### Day 20 (04/11 금) - k6 부하 테스트

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 1시간 | MAU 1천만 트래픽 산출 근거(MAU→DAU→RPS 변환)를 학습한다. k6 시나리오 5개의 코드를 분석하고, SLA threshold 설정을 파악한다. | `docs/traffic-simulation.md`, `docs/review/09-loadtest-analysis.md` |
| 1시간 | **Lab 5** (k6 부하 테스트) 실습을 진행한다. smoke test를 실행하고, k6 출력 메트릭을 해석한다. | `docs/hands-on-lab.md` Lab 5 |

**학습 체크:**
- [ ] docs/traffic-simulation.md 읽기 완료
- [ ] docs/review/09-loadtest-analysis.md 읽기 완료
- [ ] loadtest/k6/scenarios/smoke.js 분석 완료 (10 VU, 1분)
- [ ] loadtest/k6/scenarios/average-load.js 분석 완료 (200 VU, 10분)
- [ ] loadtest/k6/scenarios/peak-load.js 분석 완료 (500 VU, 15분)
- [ ] loadtest/k6/scenarios/stress-test.js 분석 완료 (2000 VU, 20분)
- [ ] loadtest/k6/scenarios/soak-test.js 분석 완료 (200 VU, 2시간)
- [ ] loadtest/k6/lib/helpers.js 분석 완료 (SLA threshold)
- [ ] loadtest/k6/lib/endpoints.js 분석 완료 (API 엔드포인트)

**실습 체크:**
- [ ] `./scripts/run-loadtest.sh smoke dev` 실행에 성공했다
- [ ] Lab 5 완료: k6 결과 메트릭을 해석했다
- [ ] Grafana에서 부하 중 실시간 변화를 관찰했다

**이해도 체크:**
- [ ] MAU 1천만 → DAU 33만 → 평균 193 RPS → 피크 278 RPS 계산 과정을 설명할 수 있다
- [ ] k6 결과에서 P95/P99 레이턴시와 에러율을 읽고 SLA 충족 여부를 판단할 수 있다
- [ ] 5개 시나리오(smoke/average/peak/stress/soak)의 목적 차이를 설명할 수 있다

---

## 5주차: 종합 실습 + 정리 (04/14 ~ 04/18)

> 목표: 전체를 엮어 E2E 시나리오를 재현하고, 블로그 작성과 면접을 준비한다.

### Day 21 (04/14 월) - 프로덕션 풀 시나리오 재현

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 2시간 | prod 클러스터에 풀 배포 → stress-test 실행 → HPA 최대 스케일아웃 관찰 → KEDA 큐 기반 스케일링 확인 → Grafana 실시간 관찰 → 서킷브레이커 동작 확인까지 전체 E2E 시나리오를 재현한다. | **Lab 13** (E2E 데모) |

**실습 체크:**
- [ ] `./scripts/deploy.sh prod` 실행에 성공했다
- [ ] `./scripts/run-loadtest.sh stress-test prod` 실행에 성공했다
- [ ] Lab 13 완료: 전체 E2E 시나리오를 재현했다
- [ ] HPA가 3→10 레플리카까지 확장되는 것을 관찰했다
- [ ] KEDA로 notification-worker가 스케일아웃되는 것을 관찰했다
- [ ] Grafana에서 부하 중 RPS/레이턴시/에러율 변화를 캡처했다
- [ ] 부하 종료 후 스케일다운이 발생하는 것을 관찰했다

---

### Day 22 (04/15 화) - 장애 시나리오 + 트러블슈팅

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 1시간 | 의도적 장애를 시뮬레이션한다. DB Pod 삭제 후 서비스 복구를 관찰하고, 리소스 부족(OOM) 상황을 시뮬레이션한다. | `docs/troubleshooting.md` |
| 1시간 | 트러블슈팅을 실전 연습한다. kubectl describe/logs/events 명령으로 장애 원인을 분석한다. | 자체 실습 |

**실습 체크:**
- [ ] DB Pod(postgresql 또는 mongodb)를 삭제한 후 자동 복구를 관찰했다
- [ ] 의존 서비스(order-service 등)의 에러 로그를 확인했다
- [ ] DB Pod 복구 후 서비스가 정상화되는 것을 확인했다
- [ ] `kubectl describe pod`의 Events 섹션을 분석했다
- [ ] `kubectl logs`로 에러 메시지를 분석했다
- [ ] `kubectl top pods`로 리소스 사용량을 확인했다

**이해도 체크:**
- [ ] Pod CrashLoopBackOff 발생 시 원인 분석 순서(describe→logs→events)를 이해했다
- [ ] OOMKilled가 발생하는 조건(memory limits 초과)을 이해했다
- [ ] StatefulSet의 Pod가 삭제되면 같은 이름과 PVC로 재생성되는 것을 이해했다

---

### Day 23 (04/16 수) - 전체 아키텍처 직접 그리기

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 1시간 | 빈 종이에 전체 아키텍처를 처음부터 직접 그린다. Traffic→WEB→WAS→DB, 모니터링 계층, 오토스케일링 흐름을 포함한다. | 문서 없이 암기 확인 |
| 1시간 | 각 기술 선택 이유를 한 줄로 정리한다. 총 15개 항목을 면접에서 바로 답할 수 있도록 준비한다. | 면접 준비 |

**완료 체크:**
- [ ] 전체 아키텍처 다이어그램을 문서 없이 직접 그렸다
- [ ] 기술 선택 이유를 15개 항목으로 정리했다:
  - [ ] PostgreSQL: ACID 트랜잭션, 주문/유저 데이터 정합성 보장
  - [ ] MongoDB: 스키마리스 문서형, 상품/리뷰의 유연한 구조 저장
  - [ ] Redis: 인메모리 고속 R/W, 캐시/세션/장바구니 용도
  - [ ] RabbitMQ: 비동기 이벤트 처리, KEDA 연동을 통한 이벤트 기반 스케일링
  - [ ] Go: 초경량 바이너리, 최소 메모리 사용, 고성능 카트 서비스에 적합
  - [ ] Rust: 메모리 안전성, 고성능 HTTP 프레임워크, 리뷰 서비스에 적합
  - [ ] Spring Boot: 엔터프라이즈 표준, JPA/Actuator 기본 제공
  - [ ] FastAPI: 비동기 ASGI, Swagger 자동 문서 생성
  - [ ] Kustomize: base/overlay 패턴, 환경별 매니페스트 관리에 적합
  - [ ] Istio: mTLS 암호화 통신, 서킷브레이커, 카나리 배포 지원
  - [ ] ArgoCD: GitOps 기반 선언적 배포, 자동 동기화 및 롤백
  - [ ] HPA: CPU/메모리 기반 수평 스케일링, K8s 네이티브
  - [ ] KEDA: 이벤트 기반 스케일링, 큐 깊이 연동
  - [ ] EFK: 중앙 집중식 로그 수집 및 검색
  - [ ] k6: JavaScript 기반 시나리오 작성, MAU 트래픽 시뮬레이션에 적합

---

### Day 24 (04/17 목) - 스크린샷 캡처 + 블로그 소재 정리

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 1시간 | 블로그용 스크린샷을 캡처한다. 각 도구의 UI와 CLI 출력 화면을 포함한다. | README 10절 |
| 1시간 | 블로그 시리즈 목차를 확정하고, 1편(프로젝트 소개) 초안을 작성한다. | README 10절 |

**완료 체크:**
- [ ] 스크린샷 캡처 완료:
  - [ ] `tart list` 출력 (13개 VM 목록)
  - [ ] `kubectl get nodes` 출력 (각 클러스터별)
  - [ ] `kubectl get pods -n ecommerce` 출력
  - [ ] Grafana ecommerce-overview 대시보드
  - [ ] Grafana autoscaling 대시보드 (HPA 변화 그래프)
  - [ ] ArgoCD UI (App-of-Apps 트리 구조)
  - [ ] k6 부하 테스트 결과 출력
  - [ ] RabbitMQ Management UI (큐 상태)
  - [ ] HAProxy Stats 대시보드
  - [ ] Kibana 로그 검색 화면
- [ ] 블로그 시리즈 목차를 확정했다 (18편)
- [ ] 1편 초안 작성을 완료했다

---

### Day 25 (04/18 금) - 최종 복습 + 면접 대비

| 시간 | 학습 내용 | 참고 문서 |
|------|----------|----------|
| 1시간 | 면접 예상 질문에 대해 자문자답 형식으로 답변을 준비한다. | 자체 정리 |
| 1시간 | 5주간 학습한 전체 내용을 빠르게 리뷰하고, 부족한 부분을 메모한다. | 전체 복습 |

**완료 체크:**
- [ ] 면접 예상 질문 답변 준비 완료:
  - [ ] "이 프로젝트에서 가장 어려웠던 점은 무엇이었는가?"
  - [ ] "MAU 1천만 트래픽을 어떻게 산출했는가?"
  - [ ] "오토스케일링이 작동하지 않을 경우 어떻게 대응하는가?"
  - [ ] "모니터링 알림을 받았을 때 대응 순서는 어떻게 되는가?"
  - [ ] "카나리 배포 전략을 설명하라."
  - [ ] "서킷브레이커가 없으면 어떤 문제가 발생하는가?"
  - [ ] "왜 5가지 언어를 사용했는가?"
  - [ ] "Helm과 Kustomize 중 어떤 기준으로 선택하는가?"
  - [ ] "DB를 왜 3종류(PostgreSQL/MongoDB/Redis)로 분리했는가?"
  - [ ] "GitOps의 장점과 단점은 무엇인가?"
- [ ] 5주 전체 학습 내용의 최종 리뷰를 완료했다
- [ ] 부족한 부분을 메모하고 추가 학습 계획을 수립했다

---

## 일일 학습 루틴 권장

```
1. 문서 읽기 (30분)
   → review 가이드 또는 architecture 문서를 정독한다.

2. 코드/매니페스트 분석 (30분)
   → 소스코드, Dockerfile, YAML을 직접 읽고 주석을 단다.

3. 실습 (45분)
   → 명령어를 직접 실행하고, Lab을 따라 하고, curl로 API를 테스트한다.

4. 정리 (15분)
   → 배운 내용을 메모하고, 체크리스트를 확인하고, 다음 날 예습 범위를 확인한다.
```

---

## 학습 우선순위 (시간이 부족할 경우)

| 우선순위 | 주제 | 이유 |
|---------|------|------|
| **1 (필수)** | K8s 배포 (Kustomize) | DevOps의 핵심 역량이다 |
| **1 (필수)** | 서비스 아키텍처 + 통신 흐름 | 면접에서 반드시 질문하는 영역이다 |
| **1 (필수)** | HPA 오토스케일링 | 프로덕션 운영의 핵심 기능이다 |
| **2 (중요)** | Prometheus + Grafana | 모니터링은 DevOps의 기본 소양이다 |
| **2 (중요)** | k6 부하 테스트 | MAU 1천만이 이 프로젝트의 핵심 차별점이다 |
| **2 (중요)** | ArgoCD GitOps | CI/CD 분야의 주요 트렌드이다 |
| **3 (권장)** | Istio 서비스 메시 | 고급 주제이나 면접에서 차별화 요소가 된다 |
| **3 (권장)** | KEDA + EFK | 심화 주제이다 |
| **4 (선택)** | Helm 차트 | Kustomize를 이해한 후 비교 학습용이다 |
| **4 (선택)** | 블로그 작성 | 시간 여유가 있을 때 진행한다 |

---

## 주제별 소요시간 총정리

| 주제 | 학습 | 실습 | 복습 | 합계 |
|------|------|------|------|------|
| 프로젝트 구조 + 아키텍처 | 2h | - | 1h | **3h** |
| VM + K8s 클러스터 | 1.5h | 1h | 0.5h | **3h** |
| Docker 이미지 빌드 | 1h | 1h | - | **2h** |
| Kustomize 배포 | 1h | 1h | 0.5h | **2.5h** |
| 서비스 소스코드 (5개 WAS) | 3h | 1h | - | **4h** |
| 서비스 간 통신 + API | 1h | 2h | - | **3h** |
| 데이터 아키텍처 + 캐시 | 1h | 1h | - | **2h** |
| 트래픽 대응 전략 | 1h | - | 0.5h | **1.5h** |
| HPA 오토스케일링 | 1h | 1h | 0.5h | **2.5h** |
| KEDA + PDB | 1h | 1h | - | **2h** |
| Prometheus + Grafana | 1h | 1h | 0.5h | **2.5h** |
| EFK + SLA 알림 | 1h | 1h | - | **2h** |
| Istio 서비스 메시 | 2h | 2h | - | **4h** |
| ArgoCD GitOps | 1h | 1h | - | **2h** |
| Helm + Kustomize 비교 | 1h | 1h | - | **2h** |
| k6 부하 테스트 | 1h | 1h | - | **2h** |
| 종합 실습 (E2E) | - | 2h | - | **2h** |
| 장애 시나리오 | 1h | 1h | - | **2h** |
| 아키텍처 정리 + 면접 준비 | 2h | - | 2h | **4h** |
| 블로그 준비 | 2h | - | - | **2h** |
| **합계** | | | | **~50h** |
