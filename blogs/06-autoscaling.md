# 06. HPA + KEDA로 탄력적 오토스케일링 구현하기

## 핵심 요약

CPU/메모리 기반 HPA로 WAS 서비스의 수평 스케일링을 구현하고, KEDA로 RabbitMQ 큐 깊이 기반 이벤트 드리븐 스케일링을 구현한다. PDB로 롤링 업데이트 시 가용성을 보장한다.

---

## 1. 사전 준비: metrics-server

HPA가 동작하려면 **metrics-server**가 클러스터에 설치되어 있어야 한다. metrics-server는 각 노드의 kubelet에서 CPU/메모리 사용량을 수집하여 HPA에 제공하는 컴포넌트다.

```bash
# metrics-server 설치 확인
kubectl --kubeconfig=kubeconfig/prod.yaml \
  get deployment metrics-server -n kube-system

# 설치되어 있지 않다면:
kubectl --kubeconfig=kubeconfig/prod.yaml apply -f \
  https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# Tart VM은 자체 서명 인증서를 사용하므로 --kubelet-insecure-tls 옵션 추가
kubectl --kubeconfig=kubeconfig/prod.yaml \
  patch deployment metrics-server -n kube-system \
  --type='json' -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'

# 동작 확인 (1-2분 후)
kubectl --kubeconfig=kubeconfig/prod.yaml top nodes
kubectl --kubeconfig=kubeconfig/prod.yaml top pods -n ecommerce
```

> **metrics-server란?** K8s 클러스터의 각 노드에서 Pod별 CPU/메모리 사용량을 실시간 수집하는 경량 모니터링 서비스다. `kubectl top` 명령어와 HPA가 이 데이터를 사용한다. Prometheus와 달리 시계열 저장 없이 현재 상태만 제공한다.

---

## 2. HPA 동작 원리

### 2.1 HPA가 Pod 수를 결정하는 공식

```
desiredReplicas = ceil( currentReplicas × (currentMetricValue / desiredMetricValue) )

예시: order-service
  현재 레플리카: 3
  현재 CPU 사용률: 80%
  목표 CPU 사용률: 50%

  계산: ceil(3 × 80/50) = ceil(4.8) = 5
  결과: 3 → 5 Pod로 스케일아웃
```

### 2.2 HPA 컨트롤 루프

```
매 15초마다:
1. metrics-server에서 Pod CPU/Memory 사용량 조회
2. 현재 사용률 / 목표 사용률 비율 계산
3. desiredReplicas 산출
4. stabilization window 확인 (급격한 변동 방지)
5. scaling policy 확인 (한 번에 몇 개까지 변경 가능한지)
6. Deployment의 spec.replicas 업데이트
```

### 2.3 HPA 매니페스트 상세

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: order-service-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: prod-order-service
  minReplicas: 3          # 최소 3개 (HA 보장)
  maxReplicas: 10         # 최대 10개 (리소스 상한)
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 50    # CPU 50% 초과 시 스케일아웃
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 70    # 메모리 70% 초과 시 스케일아웃
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30   # 30초 동안 안정적이면 스케일업
      policies:
        - type: Pods
          value: 3                      # 한 번에 최대 3개 추가
          periodSeconds: 60
        - type: Percent
          value: 50                     # 또는 현재의 50% 추가
          periodSeconds: 60
      selectPolicy: Max                 # 두 정책 중 큰 쪽 적용
    scaleDown:
      stabilizationWindowSeconds: 300  # 5분 동안 안정적이면 스케일다운
      policies:
        - type: Pods
          value: 1                      # 한 번에 1개만 제거
          periodSeconds: 120            # 2분 간격
```

**스케일업 정책 해석**: 60초마다 "3개 추가" 또는 "현재의 50% 추가" 중 큰 쪽을 적용한다. 현재 6개 Pod라면 50%=3개이므로 동일하지만, 현재 10개라면 50%=5개가 적용된다.

**스케일다운 정책 해석**: 5분간 안정 확인 후, 2분마다 1개씩만 줄인다. 급격한 축소로 인한 서비스 불안정을 방지한다.

### 2.4 서비스별 HPA 설정

| 서비스 | Min | Max | CPU 목표 | Mem 목표 | 이유 |
|--------|-----|-----|---------|---------|------|
| order-service | 3 | 10 | 50% | 70% | 가장 무거운 서비스, 트랜잭션 + MQ 발행 |
| product-service | 3 | 10 | 50% | 70% | 읽기 트래픽 70%, 캐시 미스 시 부하 급증 |
| cart-service | 3 | 8 | 50% | - | Go로 메모리 효율적, CPU만 모니터링 |
| user-service | 3 | 8 | 50% | 70% | 인증/세션 처리, bcrypt 해싱이 CPU 집약적 |
| review-service | 2 | 6 | 50% | - | Rust로 최소 리소스, 트래픽도 적음 |
| nginx-static | 2 | 6 | 60% | - | 정적 파일 + 프록시, 60%로 여유 확보 |

---

## 3. KEDA 동작 원리

### 3.1 HPA와 KEDA의 차이

```
HPA:
  트리거 → Pod 내부 메트릭 (CPU, Memory)
  용도   → 컴퓨팅 부하 기반 스케일링
  범위   → minReplicas 이상에서만 동작

KEDA:
  트리거 → 외부 이벤트 소스 (MQ 큐 깊이, HTTP 요청 수, DB 행 수 등)
  용도   → 이벤트 드리븐 스케일링
  범위   → 0까지 스케일다운 가능 (scale-to-zero)
```

### 3.2 KEDA 컨트롤 루프

```
매 10초마다 (pollingInterval):
1. RabbitMQ에 큐 깊이 질의 (HTTP Management API)
2. 각 큐의 메시지 수 확인
3. 메시지 수 > threshold (5) 이면 스케일아웃
4. 모든 큐가 비어있으면 cooldownPeriod (60초) 후 스케일다운
5. KEDA가 HPA를 생성/관리하여 Pod 수 조절
```

### 3.3 KEDA ScaledObject

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: notification-worker-scaler
spec:
  scaleTargetRef:
    name: prod-notification-worker
  pollingInterval: 10          # 10초마다 큐 확인
  cooldownPeriod: 60           # 큐가 빈 후 60초 대기 후 축소
  minReplicaCount: 1           # 최소 1개 (0으로 하면 scale-to-zero)
  maxReplicaCount: 10
  triggers:
    - type: rabbitmq
      metadata:
        host: "amqp://guest:guest@prod-rabbitmq:5672"
        queueName: "order.created"
        mode: QueueLength
        value: "5"             # 5개 이상이면 스케일아웃
    - type: rabbitmq
      metadata:
        queueName: "order.shipped"
        mode: QueueLength
        value: "5"
    - type: rabbitmq
      metadata:
        queueName: "order.cancelled"
        mode: QueueLength
        value: "5"
```

### 3.4 KEDA 설치

```bash
# Helm으로 KEDA 설치 (또는 스크립트 사용: ./scripts/install-keda.sh prod)
helm repo add kedacore https://kedacore.github.io/charts
helm repo update
helm upgrade --install keda kedacore/keda \
  --namespace keda-system \
  --create-namespace \
  --kubeconfig=kubeconfig/prod.yaml \
  --wait
```

---

## 4. PDB (Pod Disruption Budget)

### 4.1 PDB가 필요한 이유

노드 업그레이드, 클러스터 유지보수 시 `kubectl drain`이 실행되면 해당 노드의 모든 Pod가 퇴거(eviction)된다. PDB 없이는 서비스의 모든 Pod가 동시에 내려갈 수 있다.

```
PDB 없을 때:
  Node1: [order-pod-1, order-pod-2]
  Node2: [order-pod-3]

  kubectl drain Node1 → order-pod-1, order-pod-2 동시 종료
  → 일시적으로 order-pod-3만 남아 서비스 불안정

PDB 있을 때 (minAvailable: 2):
  kubectl drain Node1
  → order-pod-1 종료 시도 (남은 2개 ≥ minAvailable)
  → order-pod-2 종료 시도 → 차단! (남은 1개 < minAvailable)
  → Node2에 새 Pod 스케줄 후 drain 계속
```

### 4.2 PDB 매니페스트

```yaml
# critical 서비스: 최소 2개 유지
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: order-service-pdb
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: order-service

---
# secondary 서비스: 최소 1개 유지
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: review-service-pdb
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: review-service
```

---

## 5. 스케일링 관찰하기

### 5.1 HPA 실시간 모니터링

```bash
# 프로젝트 루트에서 실행
cd ~/devops_dummpy  # 프로젝트 루트 경로로 이동

# HPA 상태 실시간 관찰
kubectl --kubeconfig=kubeconfig/prod.yaml \
  get hpa -n ecommerce -w

# 출력 예시:
# NAME                  REFERENCE                    TARGETS     MINPODS  MAXPODS  REPLICAS
# order-service-hpa     Deployment/prod-order-svc    45%/50%     3        10       3
# ...
# order-service-hpa     Deployment/prod-order-svc    82%/50%     3        10       3
# order-service-hpa     Deployment/prod-order-svc    82%/50%     3        10       5  ← 스케일아웃!
```

### 5.2 부하를 줘서 HPA 트리거

```bash
# 별도 터미널에서 stress-test 실행
./scripts/run-loadtest.sh stress-test prod

# 동시에 HPA 관찰
watch -n 2 'kubectl --kubeconfig=kubeconfig/prod.yaml get hpa -n ecommerce'
```

---

## 6. topologySpreadConstraints + podAntiAffinity

prod overlay에서 Pod가 노드에 고르게 분산되도록 설정:

```yaml
# resource-patches.yaml (prod)
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: kubernetes.io/hostname
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels:
        app: order-service

affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          labelSelector:
            matchLabels:
              app: order-service
          topologyKey: kubernetes.io/hostname
```

**topologySpreadConstraints**: 노드 간 Pod 수 차이(skew)가 1을 초과하면 스케줄링 거부.
**podAntiAffinity**: 같은 노드에 동일 서비스 Pod 배치를 기피.

---

## 다음 편

[07. Istio 서비스 메시: 서킷브레이커와 mTLS](07-service-mesh-istio.md)에서는 서비스 간 통신의 안정성과 보안을 강화한다.
