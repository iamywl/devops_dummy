# 07. Istio 서비스 메시

---

## 이 단계에서 학습하는 기술

| 기술 | 개념 |
|------|------|
| **서비스 메시** | 서비스 간 통신을 인프라 계층에서 제어하는 아키텍처 패턴. 애플리케이션 코드 수정 없이 트래픽 관리, 보안, 관측성을 제공 |
| **사이드카 프록시** | 각 Pod에 Envoy 프록시 컨테이너를 자동 주입하여 모든 인바운드/아웃바운드 트래픽을 가로채고 제어 |
| **mTLS** | Mutual TLS. 클라이언트와 서버 양쪽 모두 인증서를 제시하여 상호 인증. 서비스 간 통신 암호화 |
| **서킷브레이커** | 장애가 발생한 서비스로의 요청을 차단하여 장애 전파(cascading failure)를 방지하는 패턴 |
| **VirtualService** | Istio CRD. 트래픽 라우팅 규칙(재시도, 타임아웃, 카나리 배포 가중치)을 정의 |
| **DestinationRule** | Istio CRD. 목적지 서비스의 부하분산 정책, 서킷브레이커, TLS 설정을 정의 |

---

## 1. Istio 아키텍처

### 1.1 구성 요소

```
┌──────────────────────────────────────────────────────────┐
│ Control Plane (istiod)                                    │
│  ├── Pilot: 라우팅 규칙을 Envoy 설정으로 변환하여 배포     │
│  ├── Citadel: 인증서 발급/갱신 (mTLS용)                   │
│  └── Galley: 설정 검증                                    │
└─────────────────────────┬────────────────────────────────┘
                          │ xDS API (gRPC)
    ┌─────────────────────┼─────────────────────┐
    │                     │                     │
┌───▼──────────┐  ┌───────▼────────┐  ┌────────▼───────┐
│ Pod A         │  │ Pod B          │  │ Pod C          │
│ ┌──────────┐ │  │ ┌──────────┐   │  │ ┌──────────┐   │
│ │ App      │ │  │ │ App      │   │  │ │ App      │   │
│ └────┬─────┘ │  │ └────┬─────┘   │  │ └────┬─────┘   │
│ ┌────▼─────┐ │  │ ┌────▼─────┐   │  │ ┌────▼─────┐   │
│ │ Envoy    │ │  │ │ Envoy    │   │  │ │ Envoy    │   │
│ │ (sidecar)│ │  │ │ (sidecar)│   │  │ │ (sidecar)│   │
│ └──────────┘ │  │ └──────────┘   │  │ └──────────┘   │
└──────────────┘  └────────────────┘  └────────────────┘
```

**기술 해설 - xDS API**:
istiod(control plane)는 xDS(x Discovery Service) gRPC API를 통해 각 Envoy 프록시에 설정을 배포한다.
- LDS (Listener Discovery): 어떤 포트에서 트래픽을 수신할지
- RDS (Route Discovery): 어떤 경로를 어떤 클러스터로 라우팅할지
- CDS (Cluster Discovery): 업스트림 클러스터(서비스) 목록
- EDS (Endpoint Discovery): 각 클러스터의 실제 Pod IP 목록

VirtualService나 DestinationRule을 변경하면, istiod가 xDS를 통해 모든 Envoy에 실시간으로 설정을 전파한다. Envoy는 hot reload를 지원하므로 재시작 없이 설정이 적용된다.

### 1.2 사이드카 주입

```bash
# 네임스페이스에 자동 주입 활성화
kubectl label namespace ecommerce istio-injection=enabled

# Pod 재생성 시 istio-init + istio-proxy 컨테이너가 자동 추가됨
kubectl get pod <pod-name> -n ecommerce -o jsonpath='{.spec.containers[*].name}'
# 출력: order-service istio-proxy
```

**기술 해설 - 사이드카 주입 메커니즘**:
K8s MutatingAdmissionWebhook을 사용한다. Pod 생성 요청이 API Server에 도달하면, API Server가 Istio의 webhook 서버에 요청을 전달한다. webhook이 Pod spec에 istio-proxy 컨테이너와 istio-init initContainer를 추가한다.

istio-init은 iptables 규칙을 설정하여 Pod의 모든 트래픽을 Envoy 프록시(포트 15001/15006)로 리다이렉트한다. 이후 애플리케이션은 평소처럼 HTTP 요청을 보내지만, 실제로는 Envoy를 통해 전송된다.

---

## 2. mTLS (상호 TLS 인증)

### 2.1 PeerAuthentication 설정

```yaml
# manifests/istio/peer-authentication.yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: ecommerce
spec:
  mtls:
    mode: STRICT
```

**기술 해설 - mTLS 동작**:
```
[Pod A: Envoy] ──── TLS Handshake ───→ [Pod B: Envoy]
     │                                        │
     ├── 클라이언트 인증서 제시                ├── 서버 인증서 제시
     ├── 서버 인증서 검증 (Citadel CA)        ├── 클라이언트 인증서 검증
     └── 암호화 채널 수립                     └── 통신 허용
```

- `STRICT`: mTLS 필수. 인증서 없는 요청은 거부
- `PERMISSIVE`: mTLS와 평문(plaintext) 모두 허용. 마이그레이션 단계에서 사용
- `DISABLE`: mTLS 비활성화

Citadel(istiod 내장)이 각 워크로드에 SPIFFE ID 기반의 X.509 인증서를 발급한다. 인증서는 자동 갱신되며, 기본 24시간 유효하다.

### 2.2 mTLS 확인 (실습)

```bash
export KUBECONFIG=../tart-infra/kubeconfig/dev.yaml

# mTLS 적용 확인
istioctl x describe pod $(kubectl get pod -n ecommerce -l app=order-service -o name | head -1) -n ecommerce

# Pod 간 통신이 암호화되는지 확인
istioctl proxy-config cluster $(kubectl get pod -n ecommerce -l app=order-service -o name | head -1).ecommerce
```

---

## 3. 서킷브레이커

### 3.1 DestinationRule 설정

```yaml
# manifests/istio/destination-rules.yaml
apiVersion: networking.istio.io/v1alpha3
kind: DestinationRule
metadata:
  name: order-service
spec:
  host: order-service
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
      http:
        h2UpgradePolicy: DEFAULT
        http1MaxPendingRequests: 100
        http2MaxRequests: 1000
    outlierDetection:
      consecutive5xxErrors: 3
      interval: 10s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
```

**기술 해설 - outlierDetection (이상치 탐지)**:
Envoy는 각 업스트림 엔드포인트(Pod)의 응답을 감시한다.
- `consecutive5xxErrors: 3`: 연속 3회 5xx 응답 발생 시 해당 Pod를 이상치로 판정
- `interval: 10s`: 10초마다 이상치 판정 수행
- `baseEjectionTime: 30s`: 이상치 Pod를 30초간 로드밸런싱 풀에서 제거(eject)
- `maxEjectionPercent: 50`: 전체 Pod의 최대 50%까지만 제거. 50% 초과 시 이상치 판정을 중지하여 전체 서비스 중단 방지

제거된 Pod는 baseEjectionTime 경과 후 다시 풀에 복귀한다. 복귀 후에도 오류가 지속되면 ejection 시간이 기하급수적으로 증가한다(exponential backoff).

**기술 해설 - connectionPool**:
- `maxConnections: 100`: TCP 연결 최대 100개. 초과 시 요청이 큐잉되거나 거부
- `http1MaxPendingRequests: 100`: 대기 중인 HTTP 요청 최대 100개. 초과 시 503 반환
이 설정은 하나의 장애 서비스가 커넥션을 소진하여 다른 서비스에 영향을 주는 것(connection exhaustion)을 방지한다.

### 3.2 서킷브레이커 동작 확인 (실습)

```bash
# 1. order-service Pod 중 하나를 의도적으로 장애 상태로 만들기
kubectl exec -n ecommerce $(kubectl get pod -n ecommerce -l app=order-service -o name | head -1) -- \
  kill -STOP 1
# → 해당 Pod가 요청에 응답하지 않음 → 5xx 반환

# 2. Envoy 프록시 로그에서 ejection 확인
kubectl logs -n ecommerce $(kubectl get pod -n ecommerce -l app=order-service -o name | head -1) -c istio-proxy | \
  grep "eject"

# 3. 다른 Pod로 트래픽이 자동 분산되는지 확인
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "%{http_code}\n" http://${DEV_IP}:30080/api/orders
done
# → 초기 몇 개 503 후, 정상 Pod로 트래픽 이동하여 200 응답

# 4. 복구
kubectl exec -n ecommerce $(kubectl get pod -n ecommerce -l app=order-service -o name | head -1) -- \
  kill -CONT 1
```

---

## 4. VirtualService (트래픽 관리)

### 4.1 재시도 + 타임아웃

```yaml
# manifests/istio/virtual-services.yaml
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: order-service
spec:
  hosts:
    - order-service
  http:
    - route:
        - destination:
            host: order-service
      retries:
        attempts: 3
        perTryTimeout: 2s
        retryOn: "5xx,reset,connect-failure,retriable-4xx"
      timeout: 10s
```

**기술 해설 - 재시도 정책**:
- `attempts: 3`: 최대 3회 재시도. 원본 요청 포함 총 4회 시도
- `perTryTimeout: 2s`: 각 시도의 타임아웃. 2초 이내 응답 없으면 재시도
- `retryOn`: 재시도 조건. `5xx`(서버 오류), `reset`(연결 초기화), `connect-failure`(연결 실패)
- `timeout: 10s`: 전체 요청 타임아웃. 재시도 포함 10초 초과 시 503 반환

재시도는 멱등(idempotent)한 요청에 적합하다. GET 요청은 안전하지만, POST 요청의 재시도는 중복 주문을 유발할 수 있다. 이를 방지하려면 서비스 측에서 멱등성 키(idempotency key)를 구현해야 한다.

---

## 5. 이 단계에서 확인할 것

- [ ] `istioctl proxy-status` → 모든 Envoy가 SYNCED 상태인가
- [ ] mTLS가 STRICT 모드로 적용되었는가
- [ ] 서킷브레이커 테스트 시 장애 Pod가 ejected 되는가
- [ ] 정상 Pod로 트래픽이 자동 전환되는가
- [ ] VirtualService의 재시도가 동작하는가 (503 후 자동 재시도)

다음 문서: [08-gitops-argocd.md](08-gitops-argocd.md)
