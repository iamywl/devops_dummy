# 04. Docker 멀티스테이지 빌드와 K8s 배포

## 핵심 요약

7개 마이크로서비스를 ARM64용 Docker 이미지로 빌드하고, containerd에 직접 로드한 뒤, Kustomize base/overlay 패턴으로 dev/staging/prod 환경에 배포한다.

---

## 1. 멀티스테이지 빌드의 원리

**멀티스테이지 빌드**는 빌드 도구(Maven, npm, cargo)를 포함하는 "빌드 스테이지"와 실행 파일만 포함하는 "런타임 스테이지"를 분리하여 최종 이미지 크기를 줄이는 기법이다.

```
일반 빌드:    [JDK + Maven + 소스 + 의존성 + JAR] = 800MB+
멀티스테이지: [JRE + JAR만]                        = 150MB

빌드 스테이지 → 컴파일 → 아티팩트 추출
     ↓                      ↓
     (삭제)           런타임 스테이지에 COPY
```

### 1.1 언어별 Dockerfile 패턴

**Java (order-service)** - 3단계 빌드:

```dockerfile
# Stage 1: Maven 빌드
FROM maven:3.9-eclipse-temurin-17 AS builder
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:go-offline      # 의존성만 먼저 다운로드 (레이어 캐싱)
COPY src ./src
RUN mvn package -DskipTests        # JAR 생성

# Stage 2: Scouter APM 에이전트
FROM alpine:3.19 AS scouter
RUN wget -O /tmp/scouter.tar.gz \
  https://github.com/scouter-project/scouter/releases/download/v2.20.0/scouter-all-2.20.0.tar.gz
RUN tar xzf /tmp/scouter.tar.gz -C /opt

# Stage 3: 경량 런타임
FROM eclipse-temurin:17-jre-alpine
RUN addgroup -S app && adduser -S app -G app    # non-root 사용자
COPY --from=builder /app/target/*.jar /app/app.jar
COPY --from=scouter /opt/scouter/agent.java /app/scouter-agent
USER app                                         # 보안: root로 실행하지 않음
EXPOSE 8080
ENTRYPOINT ["sh", "-c", "java ${JAVA_OPTS} -jar /app/app.jar"]
```

**Go (cart-service)** - 가장 작은 이미지:

```dockerfile
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o cart-service .

FROM alpine:3.19
RUN adduser -D app
COPY --from=builder /app/cart-service /app/cart-service
USER app
EXPOSE 8081
CMD ["/app/cart-service"]
# 최종 이미지: ~15MB
```

**Rust (review-service)** - 빌드 시간 최장:

```dockerfile
FROM rust:1.77-slim AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main(){}" > src/main.rs
RUN cargo build --release            # 의존성만 빌드 (캐싱)
COPY src ./src
RUN cargo build --release            # 실제 빌드

FROM debian:bookworm-slim
COPY --from=builder /app/target/release/review-service /app/review-service
EXPOSE 8082
CMD ["/app/review-service"]
# 최종 이미지: ~30MB
```

---

## 2. ARM64 이미지 빌드

Apple Silicon에서 빌드하므로 `--platform linux/arm64`를 명시한다.

```bash
#!/bin/bash
# scripts/build-images.sh

APPS_DIR="./apps"
IMAGES=(
  "order-service"
  "product-service"
  "cart-service"
  "user-service"
  "review-service"
  "notification-worker"
  "frontend"
)

for app in "${IMAGES[@]}"; do
  echo "빌드: ${app}..."
  docker build --platform linux/arm64 \
    -t "${app}:latest" \
    "${APPS_DIR}/${app}"
  echo "  ✓ ${app}:latest 빌드 완료"
done

# 빌드 확인
docker images | grep -E "order|product|cart|user|review|notification|frontend"
```

---

## 3. K8s 워커 노드에 이미지 로드

레지스트리 없이 **docker save → ssh → containerd import** 방식으로 이미지를 전달한다.

```bash
# 동작 원리:
# 1. docker save: 이미지를 tar 스트림으로 출력
# 2. ssh 파이프: tar 스트림을 VM으로 전송
# 3. ctr images import: containerd에 직접 로드 (k8s.io 네임스페이스)

IMAGES="order-service product-service cart-service user-service review-service notification-worker frontend"

# 클러스터별 워커 목록 (실제 VM에 맞춤)
declare -A WORKERS
WORKERS[dev]="dev-worker1"
WORKERS[staging]="staging-worker1"
WORKERS[prod]="prod-worker1 prod-worker2"

# 대상 클러스터 선택 (dev부터 시작 권장)
TARGET="dev"

for worker in ${WORKERS[$TARGET]}; do
  WORKER_IP=$(tart ip "$worker")
  echo "=== ${worker} (${WORKER_IP})에 이미지 로드 ==="

  for img in $IMAGES; do
    echo -n "  ${img}... "
    docker save "${img}:latest" | \
      sshpass -p admin ssh -o StrictHostKeyChecking=no admin@${WORKER_IP} \
      "sudo ctr -n k8s.io images import -"
    echo "✓"
  done
done

# 확인 (워커 노드에서)
WORKER_IP=$(tart ip dev-worker1)
sshpass -p admin ssh -o StrictHostKeyChecking=no admin@${WORKER_IP} \
  "sudo ctr -n k8s.io images list | grep -E 'order|product|cart'"
```

> **참고**: `k8s.io` 네임스페이스는 kubelet이 사용하는 containerd 네임스페이스다.
> 다른 네임스페이스에 로드하면 K8s에서 이미지를 찾지 못한다.

staging이나 prod에 배포할 때는 `TARGET="staging"` 또는 `TARGET="prod"`로 변경하여 같은 과정을 반복한다.

---

## 4. Kustomize 배포

### 4.1 base 구조

`manifests/base/`에 모든 환경에 공통인 리소스를 정의한다.

**base/kustomization.yaml**:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: ecommerce
commonLabels:
  app.kubernetes.io/part-of: devops-ecommerce
resources:
  - namespace.yaml
  - web-tier/nginx-static.yaml
  - web-tier/apache-legacy.yaml
  - was-tier/order-service.yaml
  - was-tier/product-service.yaml
  - was-tier/cart-service.yaml
  - was-tier/user-service.yaml
  - was-tier/review-service.yaml
  - was-tier/notification-worker.yaml
  - data-tier/postgresql.yaml
  - data-tier/mongodb.yaml
  - data-tier/redis.yaml
  - data-tier/secrets.yaml
  - messaging/rabbitmq.yaml
  - loadbalancer/haproxy.yaml
  - logging/efk-stack.yaml
  - monitoring/scouter.yaml
  - ingress/ingress-routes.yaml
```

### 4.2 overlay 구조

**dev** (최소 환경):

```yaml
# overlays/dev/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: ecommerce
namePrefix: dev-          # 모든 리소스 이름에 dev- 접두사
commonLabels:
  environment: dev
resources:
  - ../../base
patches:
  - path: resource-patches.yaml    # replicas: 1
  - path: dev-config.yaml          # LOG_LEVEL: debug
```

**prod** (풀 스케일):

```yaml
# overlays/prod/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: ecommerce
namePrefix: prod-
commonLabels:
  environment: prod
resources:
  - ../../base
  - hpa.yaml              # HPA 6개 (WAS 5 + nginx)
  - pdb.yaml              # PDB 8개
  - keda-scalers.yaml     # KEDA ScaledObject
  - prod-config.yaml      # LOG_LEVEL: warn
patches:
  - path: resource-patches.yaml    # replicas: 3, topologySpread, antiAffinity
```

### 4.3 배포 실행

```bash
# 프로젝트 루트로 이동
cd ~/devops_dummpy  # 프로젝트 루트 경로로 이동

# dev 배포 (스크립트 사용)
./scripts/deploy.sh dev

# 또는 직접 kubectl 실행
kubectl --kubeconfig=kubeconfig/dev.yaml apply -k manifests/overlays/dev/

# 배포 상태 확인 (Pod가 Running이 될 때까지 대기)
kubectl --kubeconfig=kubeconfig/dev.yaml get pods -n ecommerce -w

# prod 배포 (HPA + KEDA + PDB 포함)
./scripts/deploy.sh prod
```

### 4.4 배포 결과 확인

```bash
# 예상 출력 (dev):
# NAME                              READY   STATUS    RESTARTS
# dev-order-service-xxx             1/1     Running   0
# dev-product-service-xxx           1/1     Running   0
# dev-cart-service-xxx              1/1     Running   0
# dev-user-service-xxx              1/1     Running   0
# dev-review-service-xxx            1/1     Running   0
# dev-notification-worker-xxx       1/1     Running   0
# dev-nginx-static-xxx              1/1     Running   0
# dev-postgresql-0                  1/1     Running   0
# dev-mongodb-0                     1/1     Running   0
# dev-redis-xxx                     1/1     Running   0
# dev-rabbitmq-0                    1/1     Running   0
```

---

## 5. 서비스 접속 확인

```bash
DEV_IP=$(tart ip dev-master)

# 프론트엔드
curl http://${DEV_IP}:30080/

# API 엔드포인트
curl http://${DEV_IP}:30080/api/products
curl -X POST http://${DEV_IP}:30080/api/orders \
  -H "Content-Type: application/json" \
  -d '{"userId":"user-1","productId":"prod-1","quantity":1,"totalPrice":29.99}'

# 모니터링 UI
echo "RabbitMQ: http://${DEV_IP}:31672 (guest/guest)"
echo "HAProxy:  http://${DEV_IP}:30884/stats"
echo "Kibana:   http://${DEV_IP}:31601"
```

---

## 다음 편

[05. 데이터베이스 3종 + RabbitMQ 구성](05-data-tier-messaging.md)에서는 PostgreSQL, MongoDB, Redis, RabbitMQ의 K8s 설정과 운영을 다룬다.
