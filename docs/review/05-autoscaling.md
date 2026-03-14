# 05. 오토스케일링: HPA, KEDA, PDB

---

## 이 단계에서 학습하는 기술

| 기술 | 개념 |
|------|------|
| **HPA** | Horizontal Pod Autoscaler. CPU/메모리 사용률 기반으로 Deployment의 replicas 수를 자동 조절. metrics-server가 수집한 리소스 메트릭을 기반으로 동작 |
| **KEDA** | Kubernetes Event-Driven Autoscaler. 외부 이벤트 소스(RabbitMQ 큐 깊이, Kafka lag 등)를 기반으로 스케일링. HPA를 내부적으로 생성 |
| **PDB** | PodDisruptionBudget. 자발적 중단(drain, 롤링 업데이트) 시 최소 가용 Pod 수를 보장하는 제약 조건 |
| **metrics-server** | kubelet의 cAdvisor에서 CPU/메모리 메트릭을 수집하여 API Server에 제공하는 컴포넌트. HPA의 입력 데이터 원천 |

---

## 1. HPA (Horizontal Pod Autoscaler)

### 1.1 동작 원리

```
[metrics-server] ← kubelet/cAdvisor (10~15초 주기 수집)
       ↓
[HPA Controller] ← 15초 주기로 메트릭 확인
       ↓
현재 CPU 사용률 계산:
  desiredReplicas = ceil(currentReplicas × (currentMetricValue / desiredMetricValue))
       ↓
예: 현재 3 replicas, CPU 사용률 75%, 목표 50%
    desiredReplicas = ceil(3 × (75 / 50)) = ceil(4.5) = 5
       ↓
[Deployment.spec.replicas = 5로 패치]
```

**기술 해설 - HPA 알고리즘**:
HPA Controller는 kube-controller-manager 내에서 실행된다. `--horizontal-pod-autoscaler-sync-period` (기본 15초)마다 다음을 수행한다:

1. metrics-server API에서 대상 Pod들의 CPU/메모리 사용률을 조회
2. 모든 Pod의 사용률 평균을 계산
3. `desiredReplicas = ceil(currentReplicas × (currentValue / targetValue))`
4. stabilizationWindow 내에서 가장 보수적인(안전한) 값을 선택
5. Deployment의 replicas를 패치

`ceil()` 함수를 사용하므로, 목표 이상의 부하가 있으면 반드시 1개 이상 추가된다. 단, `--horizontal-pod-autoscaler-tolerance` (기본 0.1, 즉 10%)만큼의 오차는 무시한다.

### 1.2 이 프로젝트의 HPA 설정

| 서비스 | 메트릭 | 목표 | min | max | scaleUp | scaleDown |
|--------|--------|------|-----|-----|---------|-----------|
| order-service | CPU 50%, Mem 70% | Utilization | 3 | 10 | 3 pods or 50%/60s | 1 pod/120s |
| product-service | CPU 50%, Mem 70% | Utilization | 3 | 10 | 3 pods or 50%/60s | 1 pod/120s |
| cart-service | CPU 50% | Utilization | 3 | 8 | 2 pods/60s | 1 pod/120s |
| user-service | CPU 50%, Mem 70% | Utilization | 3 | 8 | 2 pods/60s | 1 pod/120s |
| review-service | CPU 50% | Utilization | 2 | 6 | 2 pods/60s | 1 pod/120s |
| nginx-static | CPU 60% | Utilization | 2 | 6 | 2 pods/60s | 1 pod/120s |

### 1.3 scaleUp/scaleDown 정책의 의미

```yaml
behavior:
  scaleUp:
    stabilizationWindowSeconds: 30
    policies:
      - type: Pods
        value: 3
        periodSeconds: 60
      - type: Percent
        value: 50
        periodSeconds: 60
    selectPolicy: Max
  scaleDown:
    stabilizationWindowSeconds: 300
    policies:
      - type: Pods
        value: 1
        periodSeconds: 120
```

**기술 해설 - stabilizationWindow**:
- **scaleUp stabilization (30초)**: 스케일업 결정 후 30초간 대기하며, 그 사이에 메트릭이 변하면 재계산. 짧게 설정하여 빠른 스케일업 허용
- **scaleDown stabilization (300초)**: 스케일다운 결정 후 5분간 대기. 트래픽 변동으로 인한 불필요한 스케일다운-업 반복(thrashing)을 방지

**기술 해설 - selectPolicy: Max**:
scaleUp에 Pods(3개 추가)와 Percent(50% 증가) 두 정책이 있을 때, `Max`는 둘 중 더 많이 스케일하는 쪽을 선택한다.
- 현재 3 replicas: Pods=3 (→6), Percent=50% (→5) → Max=6
- 현재 8 replicas: Pods=3 (→11→max10), Percent=50% (→12→max10) → Max=10

burst 트래픽에 빠르게 대응하기 위해 Max를 사용한다.

### 1.4 HPA 동작 확인 (실습)

```bash
export KUBECONFIG=../tart-infra/kubeconfig/prod.yaml

# 1. HPA 상태 확인
kubectl get hpa -n ecommerce
# 출력 예:
# NAME                  REFERENCE                TARGETS     MINPODS  MAXPODS  REPLICAS
# order-service-hpa     Deployment/order-service  15%/50%    3        10       3

# 2. 부하 생성 (별도 터미널에서)
./scripts/run-loadtest.sh stress-test prod

# 3. HPA 실시간 관찰
kubectl get hpa -n ecommerce -w
# TARGETS 컬럼이 50%를 초과하면 REPLICAS가 증가하기 시작

# 4. Pod 분산 확인
kubectl get pods -n ecommerce -l app=order-service -o wide
# NODE 컬럼에서 여러 워커 노드에 분산되었는지 확인

# 5. 부하 종료 후 scaleDown 관찰 (5분 후)
# REPLICAS가 점진적으로 감소 (120초마다 1개씩)
```

---

## 2. KEDA (Kubernetes Event-Driven Autoscaler)

### 2.1 동작 원리

```
[RabbitMQ Queue] → KEDA가 주기적으로 큐 깊이 조회 (pollingInterval: 10초)
       ↓
큐 메시지 수 > threshold (value: 5)
       ↓
KEDA가 HPA를 생성/수정
       ↓
notification-worker의 replicas 증가
       ↓
큐 메시지가 처리되어 0으로 줄어듦
       ↓
cooldownPeriod (60초) 후 스케일다운
       ↓
restoreToOriginalReplicaCount: true → 원래 replicas (1)로 복원
```

**기술 해설 - KEDA vs HPA**:
HPA는 CPU/메모리 같은 리소스 메트릭만 사용한다. KEDA는 외부 시스템(RabbitMQ, Kafka, AWS SQS 등)의 메트릭을 기반으로 스케일링한다. 내부적으로 KEDA는 HPA를 생성하고 `external` 또는 `object` 타입 메트릭을 주입한다.

KEDA의 핵심 장점: 큐에 메시지가 없으면 replicas를 0으로 줄일 수 있다(scale-to-zero). HPA는 최소 1개의 Pod를 유지해야 한다.

### 2.2 이 프로젝트의 KEDA 설정

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: notification-worker-scaler
spec:
  scaleTargetRef:
    name: prod-notification-worker
  pollingInterval: 10              # 10초마다 큐 깊이 확인
  cooldownPeriod: 60               # 스케일다운 전 60초 대기
  minReplicaCount: 1               # 최소 1개
  maxReplicaCount: 10              # 최대 10개
  triggers:
    - type: rabbitmq
      metadata:
        queueName: "order.created"
        mode: QueueLength
        value: "5"                 # 큐에 메시지 5개 이상이면 스케일업
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

3개 큐의 메시지 합이 threshold를 초과하면 스케일업이 트리거된다.

### 2.3 KEDA 동작 확인 (실습)

```bash
# 1. KEDA 설치
./scripts/install-keda.sh prod

# 2. ScaledObject 상태 확인
kubectl get scaledobject -n ecommerce
kubectl describe scaledobject notification-worker-scaler -n ecommerce

# 3. 대량 주문 생성 (큐에 메시지 축적)
for i in $(seq 1 50); do
  curl -s -X POST http://${PROD_IP}:30080/api/orders \
    -H "Content-Type: application/json" \
    -d "{\"userId\":\"user-${i}\",\"productId\":\"prod-1\",\"quantity\":1,\"totalPrice\":29.99}" &
done
wait

# 4. RabbitMQ 큐 깊이 확인
curl -s -u guest:guest http://${PROD_IP}:31672/api/queues/%2F/order.created | \
  python3 -c "import sys,json; print('Messages:', json.load(sys.stdin)['messages'])"

# 5. notification-worker Pod 수 관찰
kubectl get pods -n ecommerce -l app=notification-worker -w
# → 새로운 Pod가 생성되는 것을 관찰

# 6. 큐가 비워진 후 60초 대기 → Pod 수 감소 관찰
```

---

## 3. PDB (PodDisruptionBudget)

### 3.1 동작 원리

PDB는 자발적 중단(voluntary disruption) 시 최소 가용 Pod 수를 보장한다.

자발적 중단:
- `kubectl drain` (노드 유지보수)
- Deployment 롤링 업데이트
- 클러스터 오토스케일러의 노드 축소

비자발적 중단 (PDB 적용 대상 아님):
- 노드 하드웨어 장애
- OOMKilled
- 커널 패닉

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
spec:
  minAvailable: 2                  # 항상 최소 2개 Pod 유지
  selector:
    matchLabels:
      app: order-service
      environment: prod
```

**기술 해설 - minAvailable vs maxUnavailable**:
- `minAvailable: 2`: 3개 중 최소 2개는 항상 Running 유지. 1개씩만 중단 가능
- `maxUnavailable: 1`: 동시에 최대 1개만 중단 가능. 효과는 동일

롤링 업데이트 시 PDB를 위반하면 업데이트가 대기한다. 기존 Pod가 Ready 상태가 된 후에야 다음 Pod를 종료한다.

### 3.2 이 프로젝트의 PDB 설정

| 서비스 | minAvailable | 이유 |
|--------|-------------|------|
| order-service | 2 | 주문 처리 중단 방지. 트랜잭션 무결성 |
| product-service | 2 | 상품 조회 가용성 (트래픽 50%) |
| cart-service | 2 | 장바구니 조작 연속성 |
| user-service | 2 | 로그인/인증 가용성 |
| review-service | 1 | 비핵심 서비스, 단일 장애 허용 |
| nginx-static | 1 | 프론트엔드 접근성 유지 |
| postgresql | 1 | 단일 인스턴스, 중단 최소화 |
| rabbitmq | 1 | 메시지 유실 방지 |

### 3.3 PDB 동작 확인 (실습)

```bash
# PDB 상태 확인
kubectl get pdb -n ecommerce
# 출력 예:
# NAME                   MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
# order-service-pdb      2               N/A                1                     10m

# ALLOWED DISRUPTIONS가 0이면 → 추가 Pod 중단 불가
# replicas가 3이고 minAvailable이 2이면 → ALLOWED DISRUPTIONS = 1

# drain 시뮬레이션
kubectl drain prod-worker1 --ignore-daemonsets --delete-emptydir-data
# → PDB를 위반하는 Pod는 drain이 대기함
# → 다른 노드에서 새 Pod가 Ready된 후에야 기존 Pod 종료
```

---

## 4. 세 기술의 조합

```
트래픽 증가
  → HPA: CPU 50% 초과 감지 → replicas 3 → 5 → 8 (30초 내)
  → KEDA: 큐 깊이 5 초과 → notification-worker 1 → 5 (10초 내)

롤링 업데이트 수행
  → PDB: order-service minAvailable=2 → 1개씩만 교체
  → topologySpreadConstraints: 새 Pod를 다른 노드에 배치

트래픽 감소
  → HPA: 5분 stabilization 후 → 120초마다 1 Pod씩 축소
  → KEDA: 큐 비워짐 → 60초 cooldown → 원래 replicas(1)로 복원
```

---

## 5. 이 단계에서 확인할 것

- [ ] `kubectl get hpa -n ecommerce` → TARGETS에 실제 CPU 사용률이 표시되는가
- [ ] 부하 테스트 시 replicas가 증가하는가
- [ ] 부하 종료 후 5분 뒤 replicas가 감소하는가
- [ ] `kubectl get pdb -n ecommerce` → ALLOWED DISRUPTIONS > 0인가
- [ ] KEDA ScaledObject가 Ready 상태인가

다음 문서: [06-monitoring-observability.md](06-monitoring-observability.md)
