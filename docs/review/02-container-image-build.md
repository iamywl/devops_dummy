# 02. 컨테이너 이미지 빌드

---

## 이 단계에서 학습하는 기술

| 기술 | 개념 |
|------|------|
| **멀티스테이지 빌드** | Dockerfile에서 빌드 단계와 런타임 단계를 분리하여 최종 이미지 크기를 최소화하는 기법 |
| **ARM64 크로스 빌드** | `--platform linux/arm64` 플래그로 Apple Silicon에서 ARM64 Linux 이미지를 빌드 |
| **컨테이너 레이어** | Docker 이미지는 읽기 전용 레이어의 스택. 각 Dockerfile 명령이 하나의 레이어를 생성 |
| **containerd 이미지 로드** | K8s 워커 노드의 containerd에 이미지를 직접 import하여 레지스트리 없이 배포 |

---

## 1. 7개 서비스 이미지 빌드

### 1.1 빌드 실행

```bash
cd ~/sideproject/devops_dummpy

# 전체 빌드 (스크립트 사용)
./scripts/build-images.sh

# 또는 개별 빌드
docker build --platform linux/arm64 -t order-service:latest apps/order-service/
docker build --platform linux/arm64 -t product-service:latest apps/product-service/
docker build --platform linux/arm64 -t cart-service:latest apps/cart-service/
docker build --platform linux/arm64 -t user-service:latest apps/user-service/
docker build --platform linux/arm64 -t review-service:latest apps/review-service/
docker build --platform linux/arm64 -t notification-worker:latest apps/notification-worker/
docker build --platform linux/arm64 -t frontend:latest apps/frontend/
```

### 1.2 빌드 결과 확인

```bash
docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}" | \
  grep -E "order|product|cart|user|review|notification|frontend"

# 예상 출력:
# REPOSITORY            TAG       SIZE
# order-service         latest    ~280MB (JVM 포함)
# product-service       latest    ~180MB (Node.js 포함)
# cart-service          latest    ~15MB  (Go 정적 바이너리)
# user-service          latest    ~120MB (Python + 의존성)
# review-service        latest    ~80MB  (Rust 바이너리 + glibc)
# notification-worker   latest    ~180MB (Node.js 포함)
# frontend              latest    ~40MB  (Nginx + 정적 파일)
```

---

## 2. Dockerfile 구조 분석

### 2.1 order-service (Java/Spring Boot) - 3단계 빌드

```dockerfile
# Stage 1: Maven 빌드
FROM --platform=linux/arm64 maven:3.9-eclipse-temurin-17 AS build
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:go-offline     # 의존성 캐싱 레이어
COPY src ./src
RUN mvn package -DskipTests       # JAR 생성

# Stage 2: Scouter Agent 다운로드
FROM --platform=linux/arm64 eclipse-temurin:17-jre-alpine AS scouter
# Scouter Java Agent를 다운로드

# Stage 3: 런타임
FROM --platform=linux/arm64 eclipse-temurin:17-jre-alpine
COPY --from=build /app/target/*.jar app.jar
COPY --from=scouter /opt/scouter/agent.java /app/scouter-agent
ENTRYPOINT ["sh", "-c", "java ${JAVA_OPTS:-} -jar app.jar"]
```

**기술 해설 - 멀티스테이지 빌드**:
빌드 도구(Maven, GCC, npm dev dependencies)는 런타임에 불필요하다. 멀티스테이지 빌드에서 `AS build`로 지정한 스테이지의 결과물만 `COPY --from=build`로 최종 이미지에 복사한다.

- 단일 스테이지: Maven(~500MB) + JDK(~400MB) + 앱 = ~1GB
- 멀티스테이지: JRE-alpine(~100MB) + JAR(~50MB) = ~280MB

**기술 해설 - 의존성 캐싱**:
`COPY pom.xml` → `RUN mvn dependency:go-offline` 순서로 실행하면, pom.xml이 변경되지 않는 한 의존성 다운로드 레이어가 캐시된다. 소스코드만 수정 시 빌드 시간이 수 분에서 수 초로 단축된다. Docker는 각 명령의 입력(COPY 대상 파일의 해시)이 이전과 동일하면 캐시된 레이어를 재사용한다.

### 2.2 cart-service (Go) - 정적 바이너리 빌드

```dockerfile
FROM --platform=linux/arm64 golang:1.22-alpine AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download               # 의존성 캐싱
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o cart-service .

FROM --platform=linux/arm64 alpine:3.19
COPY --from=build /app/cart-service /usr/local/bin/
CMD ["cart-service"]
```

**기술 해설 - CGO_ENABLED=0**:
Go는 기본적으로 C 라이브러리(glibc)에 동적 링크한다. `CGO_ENABLED=0`으로 설정하면 순수 Go 코드만으로 정적 바이너리를 생성한다. 이 바이너리는 libc 의존성이 없으므로 `scratch`(빈 이미지)나 `alpine`(musl libc) 위에서도 실행 가능하다. 결과 이미지 크기가 ~15MB로 가장 작다.

### 2.3 review-service (Rust) - 크로스 컴파일

```dockerfile
FROM --platform=linux/arm64 rust:1.77-slim AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release          # 의존성만 빌드 (캐싱)
COPY src ./src
RUN cargo build --release

FROM --platform=linux/arm64 debian:bookworm-slim
COPY --from=build /app/target/release/review-service /usr/local/bin/
CMD ["review-service"]
```

**기술 해설 - Rust 의존성 캐싱**:
Rust는 `cargo build` 시 Cargo.toml의 의존성을 먼저 컴파일한다. 더미 `main.rs`로 한 번 빌드한 후 실제 소스를 복사하면, 의존성 컴파일 결과가 캐시된 레이어에 보존된다. Rust 의존성 컴파일은 수 분이 걸리므로, 이 캐싱으로 반복 빌드 시간이 크게 단축된다.

---

## 3. 이미지를 K8s 워커 노드에 로드

### 3.1 왜 이미지 로드가 필요한가

Tart VM 내부의 K8s 노드는 Docker Hub나 외부 레지스트리에 접근할 수 없을 수 있다. 또한 로컬에서 빌드한 이미지(`latest` 태그)는 레지스트리에 push하지 않았으므로, 워커 노드의 containerd에 직접 로드해야 한다.

K8s Pod 생성 시 kubelet이 containerd에 이미지를 요청한다. containerd의 로컬 스토리지에 이미지가 없으면 `ImagePullBackOff` 에러가 발생한다.

### 3.2 로드 명령

```bash
IMAGES="order-service product-service cart-service user-service review-service notification-worker frontend"

# dev 클러스터 워커에 로드
WORKER_IP=$(tart ip dev-worker1)
for img in $IMAGES; do
  docker save ${img}:latest | \
    sshpass -p admin ssh -o StrictHostKeyChecking=no admin@${WORKER_IP} \
    "sudo ctr -n k8s.io images import -"
done
```

**기술 해설 - docker save / ctr import 파이프라인**:
1. `docker save`: 로컬 Docker 이미지를 tar 아카이브로 직렬화 (stdout 출력)
2. SSH 파이프: tar 데이터를 네트워크를 통해 워커 노드로 전송
3. `ctr -n k8s.io images import`: containerd의 `k8s.io` 네임스페이스에 이미지를 import

containerd는 네임스페이스로 이미지를 격리한다. kubelet은 `k8s.io` 네임스페이스의 이미지만 사용하므로, 반드시 `-n k8s.io`를 지정해야 한다.

### 3.3 prod 클러스터 (4개 워커에 모두 로드)

```bash
for worker in prod-worker1 prod-worker2 prod-worker3 prod-worker4; do
  WORKER_IP=$(tart ip $worker)
  echo "Loading images to $worker ($WORKER_IP)..."
  for img in $IMAGES; do
    docker save ${img}:latest | \
      sshpass -p admin ssh -o StrictHostKeyChecking=no admin@${WORKER_IP} \
      "sudo ctr -n k8s.io images import -"
  done
done
```

HPA 스케일아웃 시 Pod가 어떤 워커 노드에 스케줄될지 예측할 수 없다. 따라서 모든 워커 노드에 이미지를 미리 로드해 두어야 한다. 이미지가 없는 노드에 Pod가 스케줄되면 `ImagePullBackOff` 상태로 대기하게 된다.

### 3.4 imagePullPolicy 설정

매니페스트에서 `imagePullPolicy: IfNotPresent`로 설정되어 있다:
```yaml
containers:
  - name: order-service
    image: order-service:latest
    imagePullPolicy: IfNotPresent
```

- `IfNotPresent`: 로컬에 이미지가 있으면 사용, 없으면 pull 시도
- `Always`: 항상 레지스트리에서 pull (latest 태그의 기본값이므로 명시적 설정 필요)
- `Never`: 로컬 이미지만 사용, 없으면 에러

---

## 4. 이 단계에서 확인할 것

```bash
# 빌드된 이미지 목록 확인
docker images | grep -E "order|product|cart|user|review|notification|frontend"

# 워커 노드에 이미지가 로드되었는지 확인
ssh admin@$(tart ip dev-worker1) "sudo ctr -n k8s.io images list | grep -E 'order|product|cart'"

# 이미지 크기 비교 (언어별 차이 관찰)
docker images --format "{{.Repository}}: {{.Size}}" | sort
```

- [ ] 7개 이미지 모두 빌드 성공
- [ ] Go 이미지가 가장 작은가 (~15MB)
- [ ] Java 이미지가 가장 큰가 (~280MB)
- [ ] 대상 클러스터의 모든 워커 노드에 이미지가 로드되었는가

다음 문서: [03-kustomize-deploy.md](03-kustomize-deploy.md)
