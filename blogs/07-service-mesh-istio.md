# 07. Istio 서비스 메시: 서킷브레이커와 mTLS

## 핵심 요약

Istio 서비스 메시를 설치하여 서비스 간 통신에 서킷브레이커(장애 격리), mTLS(암호화), 재시도 정책(안정성), 타임아웃(지연 전파 방지)을 애플리케이션 코드 변경 없이 적용한다.

---

## 1. 서비스 메시가 필요한 이유

### 1.1 문제 상황

```
order-service → product-service 호출 시:

시나리오 1: product-service 응답 지연 (10초+)
  → order-service 스레드가 블로킹
  → order-service 스레드 풀 고갈
  → order-service도 응답 불능 → 장애 전파 (Cascading Failure)

시나리오 2: product-service 일부 Pod 장애
  → 요청이 죽은 Pod로 계속 전달
  → 에러율 증가 → 전체 서비스 품질 저하
```

### 1.2 서비스 메시의 해결 방식

> **용어 설명**
> - **Envoy**: Lyft에서 개발한 고성능 L7 프록시. 모든 네트워크 트래픽을 중간에서 가로채어 로드밸런싱, 서킷브레이커, TLS 암호화 등을 수행한다.
> - **사이드카(Sidecar)**: K8s Pod 내에서 메인 컨테이너 옆에 함께 배포되는 보조 컨테이너. Istio는 각 Pod에 Envoy를 사이드카로 자동 주입한다.
> - **서비스 메시**: 모든 Pod에 사이드카 프록시를 주입하여, 서비스 간 통신을 인프라 레벨에서 제어하는 아키텍처. 애플리케이션 코드를 변경할 필요가 없다.

```
각 Pod에 Envoy 사이드카 프록시 주입:

┌──────────────────┐     ┌──────────────────┐
│ order-service    │     │ product-service  │
│  ┌────────────┐  │     │  ┌────────────┐  │
│  │ 애플리케이션│  │     │  │ 애플리케이션│  │
│  └─────┬──────┘  │     │  └─────▲──────┘  │
│        │         │     │        │         │
│  ┌─────▼──────┐  │     │  ┌─────┴──────┐  │
│  │ Envoy      │──┼─────┼──│ Envoy      │  │
│  │ Sidecar    │  │     │  │ Sidecar    │  │
│  │ ─ 서킷브레이커│     │  │            │  │
│  │ ─ 재시도     │      │  │            │  │
│  │ ─ 타임아웃   │      │  │            │  │
│  │ ─ mTLS      │      │  │ ─ mTLS     │  │
│  └────────────┘  │     │  └────────────┘  │
└──────────────────┘     └──────────────────┘

핵심: 애플리케이션 코드 변경 없음. 네트워크 계층에서 처리.
```

---

## 2. Istio 설치

```bash
cd ~/devops_dummpy  # 프로젝트 루트 경로로 이동

# istioctl 설치 (Mac)
curl -L https://istio.io/downloadIstio | sh -
sudo mv istio-*/bin/istioctl /usr/local/bin/
istioctl version --short

# dev 클러스터에 Istio 설치 (demo 프로필: 모든 기능 포함)
istioctl install --set profile=demo \
  --kubeconfig=kubeconfig/dev.yaml -y

# prod 클러스터에 Istio 설치 (default 프로필: 프로덕션용)
istioctl install --set profile=default \
  --kubeconfig=kubeconfig/prod.yaml -y

# ecommerce 네임스페이스에 사이드카 자동 주입 활성화
for ENV in dev prod; do
  kubectl --kubeconfig=kubeconfig/${ENV}.yaml \
    label namespace ecommerce istio-injection=enabled --overwrite
done

# 기존 Pod 재시작 (사이드카 주입을 위해)
kubectl --kubeconfig=kubeconfig/dev.yaml \
  rollout restart deployment -n ecommerce

# Istio Pod 확인
kubectl --kubeconfig=kubeconfig/dev.yaml \
  get pods -n istio-system
# 예상: istiod, istio-ingressgateway, istio-egressgateway 모두 Running
```

---

## 3. 서킷브레이커 (DestinationRule)

### 3.1 동작 원리

```
서킷브레이커 상태 전이:

CLOSED (정상)
    │
    │ 연속 5xx 3회
    ▼
OPEN (차단) → 해당 엔드포인트를 30초간 트래픽 풀에서 제거
    │
    │ 30초 경과
    ▼
HALF-OPEN → 시험 요청 1개 전송
    │
    ├── 성공 → CLOSED (복구)
    └── 실패 → OPEN (다시 차단)
```

### 3.2 매니페스트

```yaml
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: order-service-dr
  namespace: ecommerce
spec:
  host: order-service
  trafficPolicy:
    outlierDetection:
      consecutive5xxErrors: 3      # 연속 5xx 3회 시 퇴출
      interval: 10s                # 10초 간격으로 검사
      baseEjectionTime: 30s        # 30초간 퇴출
      maxEjectionPercent: 50       # 전체 엔드포인트의 최대 50%만 퇴출
```

**maxEjectionPercent: 50** 의미: 전체 Pod 중 50% 이상을 동시에 퇴출하지 않는다. 모든 Pod가 장애일 때 전부 퇴출하면 서비스 자체가 죽으므로, 최소 50%는 유지한다.

---

## 4. VirtualService (재시도, 타임아웃)

### 4.1 서비스별 정책

```yaml
# order-service: 가장 보수적 (중요 서비스)
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: order-service-vs
spec:
  hosts: [order-service]
  http:
    - route:
        - destination:
            host: order-service
            port: { number: 8080 }
      timeout: 10s                          # 10초 타임아웃
      retries:
        attempts: 3                          # 3회 재시도
        perTryTimeout: 3s                    # 시도당 3초
        retryOn: 5xx,reset,connect-failure,retriable-4xx

---
# cart-service: 가장 공격적 (빠른 응답 기대)
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: cart-service-vs
spec:
  hosts: [cart-service]
  http:
    - route:
        - destination:
            host: cart-service
            port: { number: 8081 }
      timeout: 3s                           # 3초 타임아웃
      retries:
        attempts: 2                          # 2회 재시도
        perTryTimeout: 1s
        retryOn: 5xx,connect-failure
```

**타임아웃 설계 원칙**:
- order-service(10s): DB 트랜잭션 + MQ 발행이 포함되어 상대적으로 느림
- product-service(5s): 캐시 미스 시 MongoDB 조회 시간 고려
- cart-service(3s): Redis 직접 조회, 빠른 응답 기대

---

## 5. mTLS (PeerAuthentication)

### 5.1 동작 원리

```
Istiod (컨트롤 플레인):
  │
  ├── 각 Pod에 X.509 인증서 자동 발급
  ├── 인증서 자동 교체 (기본 24시간)
  └── CA 관리 (Root CA → Workload Certificate)

Pod-to-Pod 통신:
  order-service ──[TLS 1.3]──> product-service

  1. order의 Envoy가 자신의 인증서로 TLS 핸드셰이크 시작
  2. product의 Envoy가 인증서 검증 (같은 CA에서 발급된 것인지)
  3. 양방향 인증 완료 → 암호화 통신 시작
  4. 애플리케이션은 평문 HTTP로 통신 (Envoy가 처리)
```

### 5.2 매니페스트

```yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: ecommerce
spec:
  mtls:
    mode: STRICT    # 모든 통신에 mTLS 강제
```

**STRICT vs PERMISSIVE**:
- STRICT: mTLS가 아닌 통신은 거부. 보안 최고 수준.
- PERMISSIVE: mTLS/평문 모두 허용. 마이그레이션 시 사용.

---

## 6. 매니페스트 적용

```bash
cd ~/devops_dummpy  # 프로젝트 루트 경로로 이동

# Istio 리소스가 manifests/istio/ 디렉토리에 있다
ls manifests/istio/
# destination-rules.yaml  virtual-services.yaml  peer-authentication.yaml

# dev 클러스터에 적용
kubectl --kubeconfig=kubeconfig/dev.yaml \
  apply -f manifests/istio/

# prod 클러스터에 적용
kubectl --kubeconfig=kubeconfig/prod.yaml \
  apply -f manifests/istio/

# 적용 확인
kubectl --kubeconfig=kubeconfig/dev.yaml \
  get destinationrules,virtualservices,peerauthentication -n ecommerce
```

---

## 7. 확인

```bash
# Istio 사이드카 주입 확인 (READY 2/2 = 앱 + Envoy)
kubectl --kubeconfig=kubeconfig/dev.yaml get pods -n ecommerce
# NAME                          READY   STATUS
# dev-order-service-xxx         2/2     Running    ← 2/2 = 사이드카 있음

# mTLS 확인 (Pod 이름을 실제 이름으로 대체)
ORDER_POD=$(kubectl --kubeconfig=kubeconfig/dev.yaml \
  get pod -n ecommerce -l app=order-service -o jsonpath='{.items[0].metadata.name}')
istioctl proxy-config secret $ORDER_POD -n ecommerce \
  --kubeconfig=kubeconfig/dev.yaml

# 트래픽 관찰 (Kiali 대시보드)
istioctl dashboard kiali --kubeconfig=kubeconfig/dev.yaml
```

---

## 다음 편

[08. Prometheus + Grafana + EFK로 관측성 확보](08-monitoring-observability.md)에서는 모니터링 파이프라인을 구축한다.
