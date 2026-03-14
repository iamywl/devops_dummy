# 03. Kustomize 배포 구조와 실행

---

## 이 단계에서 학습하는 기술

| 기술 | 개념 |
|------|------|
| **Kustomize** | K8s 매니페스트의 선언적 커스터마이징 도구. base 매니페스트에 환경별 패치를 overlay하여 환경 분리 |
| **Strategic Merge Patch** | K8s 리소스의 필드를 부분적으로 덮어쓰는 패치 방식. 전체 파일을 교체하지 않고 변경 부분만 선언 |
| **namePrefix** | Kustomize가 모든 리소스의 metadata.name 앞에 접두사를 붙여 환경별 리소스 이름 충돌 방지 |
| **Namespace** | K8s의 논리적 격리 단위. 같은 네임스페이스 내에서 Service 이름으로 DNS 해석 가능 |

---

## 1. 디렉토리 구조 이해

```
manifests/
├── base/                          # 환경 공통 리소스 정의
│   ├── kustomization.yaml         # 리소스 목록 선언
│   ├── namespace.yaml             # ecommerce 네임스페이스
│   ├── web-tier/                  # WEB 계층 (nginx, apache)
│   ├── was-tier/                  # WAS 계층 (5 서비스 + 1 워커)
│   ├── data-tier/                 # 데이터 계층 (postgresql, mongodb, redis, secrets)
│   ├── messaging/                 # 메시징 (rabbitmq)
│   ├── loadbalancer/              # 로드밸런서 (haproxy)
│   ├── logging/                   # 로그 수집 (EFK)
│   ├── monitoring/                # APM (scouter)
│   └── ingress/                   # Ingress 라우팅 규칙
│
└── overlays/                      # 환경별 패치
    ├── dev/                       # namePrefix: dev-
    │   ├── kustomization.yaml     # base 참조 + 패치 선언
    │   ├── resource-patches.yaml  # replicas: 1, 최소 리소스
    │   └── dev-config.yaml        # LOG_LEVEL: debug
    ├── staging/
    │   ├── kustomization.yaml
    │   ├── resource-patches.yaml  # replicas: 2, topology spread
    │   └── staging-config.yaml    # LOG_LEVEL: info
    └── prod/
        ├── kustomization.yaml
        ├── resource-patches.yaml  # replicas: 3, podAntiAffinity
        ├── hpa.yaml               # HPA 6개
        ├── pdb.yaml               # PDB 8개
        ├── keda-scalers.yaml      # KEDA ScaledObject
        └── prod-config.yaml       # LOG_LEVEL: warn
```

### 1.1 Kustomize의 동작 원리

```
kustomize build manifests/overlays/dev/

1. base/kustomization.yaml에 선언된 모든 리소스를 로드
2. overlay/dev/kustomization.yaml의 패치를 적용
   - namePrefix: "dev-" → 모든 리소스 이름에 dev- 접두사
   - patchesStrategicMerge → 특정 필드만 덮어쓰기
3. 최종 YAML 출력 → kubectl apply에 전달
```

**기술 해설 - Strategic Merge Patch vs JSON Patch**:
- **Strategic Merge Patch**: K8s 리소스의 구조를 이해하고, 리스트 항목을 키(name 필드)로 매칭하여 병합한다. 예를 들어 containers 배열에서 name이 같은 컨테이너의 필드만 덮어쓴다.
- **JSON Patch**: RFC 6902 기반. `op`, `path`, `value`로 절대 경로를 지정하여 수정한다. 더 정밀하지만 가독성이 낮다.

Kustomize는 Strategic Merge Patch를 기본으로 사용한다.

---

## 2. base 매니페스트 분석

### 2.1 kustomization.yaml

```yaml
# manifests/base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - namespace.yaml
  - web-tier/nginx-configmap.yaml
  - web-tier/nginx-static.yaml
  - web-tier/apache-legacy.yaml
  - was-tier/order-service.yaml
  - was-tier/product-service.yaml
  - was-tier/cart-service.yaml
  - was-tier/user-service.yaml
  - was-tier/review-service.yaml
  - was-tier/notification-worker.yaml
  - data-tier/secrets.yaml
  - data-tier/postgresql.yaml
  - data-tier/mongodb.yaml
  - data-tier/redis.yaml
  - messaging/rabbitmq.yaml
  - loadbalancer/haproxy.yaml
  - logging/efk-stack.yaml
  - monitoring/scouter.yaml
  - ingress/ingress-routes.yaml
```

이 파일이 Kustomize의 진입점이다. `resources`에 나열된 모든 YAML 파일이 로드된다.

### 2.2 Deployment 구조 (order-service 예시)

```yaml
# manifests/base/was-tier/order-service.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  namespace: ecommerce
  labels:
    app: order-service
    tier: was
spec:
  replicas: 1                      # base에서는 1
  selector:
    matchLabels:
      app: order-service
  template:
    metadata:
      labels:
        app: order-service
        tier: was
    spec:
      containers:
        - name: order-service
          image: order-service:latest
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 8080
          env:
            - name: SPRING_DATASOURCE_URL
              value: "jdbc:postgresql://postgresql:5432/orders"
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: 500m
              memory: 512Mi
          readinessProbe:
            httpGet:
              path: /actuator/health
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /actuator/health
              port: 8080
            initialDelaySeconds: 60
            periodSeconds: 15
```

**기술 해설 - resources.requests vs resources.limits**:
- `requests`: 스케줄러가 노드 배치 시 사용하는 값. 이 양 이상의 가용 리소스가 있는 노드에만 Pod를 배치
- `limits`: 컨테이너가 사용할 수 있는 상한. CPU limits 초과 시 throttling(실행 시간 제한), Memory limits 초과 시 OOMKilled(프로세스 강제 종료)
- requests < limits: burstable QoS. 평시에는 requests만 사용하고, 부하 시 limits까지 사용 가능

**기술 해설 - readinessProbe vs livenessProbe**:
- `readinessProbe`: Pod가 트래픽을 받을 준비가 되었는지 확인. 실패 시 Service의 Endpoints에서 제거되어 트래픽이 전달되지 않음
- `livenessProbe`: Pod가 정상 동작하는지 확인. 실패 시 kubelet이 컨테이너를 재시작
- `initialDelaySeconds`: 컨테이너 시작 후 첫 probe까지 대기 시간. JVM 기반 서비스는 초기화에 시간이 걸리므로 30~60초 설정

### 2.3 StatefulSet (PostgreSQL)

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgresql
spec:
  serviceName: postgresql          # headless service 이름
  replicas: 1
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 5Gi
```

**기술 해설 - Deployment vs StatefulSet**:
- **Deployment**: 무상태(stateless) 워크로드용. Pod 이름이 랜덤 해시(order-service-7d4f8b-xyz). Pod 교체 시 새로운 이름과 IP를 받음
- **StatefulSet**: 상태 유지(stateful) 워크로드용. Pod 이름이 순서 번호(postgresql-0, postgresql-1). 고정된 네트워크 ID와 영구 볼륨 유지. 순차적 생성/삭제 보장

데이터베이스는 StatefulSet을 사용한다. Pod가 재시작되더라도 같은 PersistentVolume이 재연결되어 데이터가 보존된다.

---

## 3. overlay 패치 분석

### 3.1 dev overlay

```yaml
# manifests/overlays/dev/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - ../../base

namePrefix: dev-                   # 모든 리소스 이름에 dev- 접두사

patchesStrategicMerge:
  - resource-patches.yaml
  - dev-config.yaml
```

```yaml
# manifests/overlays/dev/resource-patches.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: any                        # 와일드카드 → 모든 Deployment에 적용
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: "*"
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 256Mi
```

### 3.2 prod overlay

```yaml
# manifests/overlays/prod/resource-patches.yaml
spec:
  replicas: 3                     # 기본 3 레플리카
  template:
    spec:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                topologyKey: kubernetes.io/hostname
```

**기술 해설 - topologySpreadConstraints**:
Pod를 topology domain(노드, 존, 리전) 간에 균등하게 분배하는 제약 조건이다.
- `maxSkew: 1`: 가장 많은 도메인과 가장 적은 도메인의 Pod 수 차이가 1 이하
- `topologyKey: kubernetes.io/hostname`: 노드 단위로 분산
- `DoNotSchedule`: 조건을 만족하지 못하면 스케줄하지 않음 (prod)
- `ScheduleAnyway`: 조건 불만족 시에도 스케줄하되, 가능한 균등 분배 (staging)

예: 워커 3대에 order-service 3 replicas → 각 노드에 1개씩 배치

**기술 해설 - podAntiAffinity**:
같은 레이블을 가진 Pod가 같은 노드에 배치되는 것을 제한한다.
- `preferredDuringSchedulingIgnoredDuringExecution`: 선호 조건. 가능하면 분산하되, 불가능하면 같은 노드에도 배치
- `requiredDuringSchedulingIgnoredDuringExecution`: 필수 조건. 위반 시 스케줄 불가

prod에서는 preferred를 사용한다. 노드 수가 부족할 때도 Pod가 스케줄될 수 있도록 하면서, 가능한 분산 배치를 유도한다.

---

## 4. 배포 실행

### 4.1 dev 환경 배포

```bash
# 방법 1: 스크립트 사용
./scripts/deploy.sh dev

# 방법 2: 수동 실행
kustomize build manifests/overlays/dev/ | \
  kubectl --kubeconfig=../tart-infra/kubeconfig/dev.yaml apply -f -
```

### 4.2 배포 결과 확인

```bash
export KUBECONFIG=../tart-infra/kubeconfig/dev.yaml

# Pod 상태 확인
kubectl get pods -n ecommerce -o wide

# 예상 출력:
# NAME                                    READY   STATUS    NODE
# dev-order-service-xxx-yyy               1/1     Running   dev-worker1
# dev-product-service-xxx-yyy             1/1     Running   dev-worker1
# dev-cart-service-xxx-yyy                1/1     Running   dev-worker1
# dev-user-service-xxx-yyy                1/1     Running   dev-worker1
# dev-review-service-xxx-yyy              1/1     Running   dev-worker1
# dev-notification-worker-xxx-yyy         1/1     Running   dev-worker1
# dev-nginx-static-xxx-yyy                1/1     Running   dev-worker1
# dev-postgresql-0                        1/1     Running   dev-worker1
# dev-mongodb-0                           1/1     Running   dev-worker1
# dev-redis-xxx-yyy                       1/1     Running   dev-worker1
# dev-rabbitmq-0                          1/1     Running   dev-worker1

# Service 확인
kubectl get svc -n ecommerce

# PersistentVolumeClaim 확인
kubectl get pvc -n ecommerce
```

### 4.3 환경별 차이 비교

```bash
# dev와 prod의 최종 매니페스트 차이 비교
diff <(kustomize build manifests/overlays/dev/) \
     <(kustomize build manifests/overlays/prod/)

# 주요 차이점:
# - namePrefix: dev- vs prod-
# - replicas: 1 vs 3
# - resource requests/limits 크기
# - prod에만 HPA, PDB, KEDA 리소스 존재
# - prod에만 topologySpreadConstraints, podAntiAffinity 존재
```

---

## 5. 서비스 접속 확인

```bash
DEV_IP=$(tart ip dev-master)

# 프론트엔드 (Nginx)
curl -s http://${DEV_IP}:30080/ | head -20

# 상품 API (Node.js → MongoDB)
curl -s http://${DEV_IP}:30080/api/products | python3 -m json.tool

# 주문 생성 (Spring Boot → PostgreSQL → RabbitMQ)
curl -X POST http://${DEV_IP}:30080/api/orders \
  -H "Content-Type: application/json" \
  -d '{"userId":"user-1","productId":"prod-1","quantity":1,"totalPrice":29.99}'

# 장바구니 (Go → Redis)
curl -X POST http://${DEV_IP}:30080/api/cart \
  -H "Content-Type: application/json" \
  -d '{"userId":"user-1","productId":"prod-1","quantity":2}'
curl -s http://${DEV_IP}:30080/api/cart/user-1

# 유저 등록 (FastAPI → PostgreSQL)
curl -X POST http://${DEV_IP}:30080/api/users/register \
  -H "Content-Type: application/json" \
  -d '{"username":"test","email":"test@test.com","password":"pass123"}'

# 리뷰 작성 (Actix-web → MongoDB)
curl -X POST http://${DEV_IP}:30080/api/reviews \
  -H "Content-Type: application/json" \
  -d '{"productId":"prod-1","userId":"user-1","rating":5,"comment":"Good"}'
```

---

## 6. 이 단계에서 확인할 것

- [ ] `kubectl get pods -n ecommerce` → 모든 Pod가 Running/Ready
- [ ] `kubectl get svc -n ecommerce` → 모든 Service의 ClusterIP 할당됨
- [ ] `kubectl get pvc -n ecommerce` → PVC가 Bound 상태
- [ ] curl로 각 API 엔드포인트가 정상 응답
- [ ] `kustomize build`로 dev, staging, prod의 차이를 비교했는가

다음 문서: [04-service-architecture.md](04-service-architecture.md)
