# 리소스 버짓 계획서

> 13개 VM, 4개 클러스터의 리소스 배분 계획과 Pod 리소스 관리 전략

---

## 1. 호스트 리소스 총량

| 항목 | 사양 | 비고 |
|------|------|------|
| CPU | Apple Silicon 16 cores | ARM64 아키텍처 |
| RAM | 128 GB | LPDDR5 |
| Disk | 1.8 TB (여유 ~835 GB) | NVMe SSD |
| 가상화 | Tart (Apple Virtualization Framework) | 하드웨어 가속 |

---

## 2. VM 리소스 배분

### 2.1 전체 배분 요약

| 클러스터 | VM 수 | vCPU | RAM | Disk | 역할 |
|---------|--------|------|-----|------|------|
| platform | 3 | 7 | 24 GB | 60 GB | 모니터링, GitOps |
| dev | 2 | 4 | 12 GB | 40 GB | 개발, Istio |
| staging | 3 | 8 | 24 GB | 60 GB | 스테이징 |
| prod | 5 | 13 | 48 GB | 100 GB | 프로덕션 HA |
| **합계** | **13** | **32** | **108 GB** | **260 GB** | |

### 2.2 오버커밋 분석

```
CPU 오버커밋: 32 vCPU / 16 cores = 2.0x
  → 허용 범위 (일반적으로 4:1까지 허용)
  → 모든 VM이 동시에 CPU 100% 사용하지 않음

RAM 사용률: 108 GB / 128 GB = 84%
  → 호스트 OS + Docker 빌드용 ~20 GB 여유
  → 전체 기동 시 메모리 압박 가능 → 권장 운영 모드 참고

Disk 사용률: 260 GB / 835 GB = 31%
  → 충분한 여유 (컨테이너 이미지, 로그, PV 포함)
```

### 2.3 VM 상세 스펙

| VM 이름 | vCPU | RAM | Disk | 역할 상세 |
|---------|------|-----|------|----------|
| platform-master | 2 | 4 GB | 20 GB | K8s API Server, etcd, scheduler |
| platform-worker1 | 3 | 12 GB | 20 GB | Prometheus, Grafana, ArgoCD |
| platform-worker2 | 2 | 8 GB | 20 GB | Jaeger, Loki, Scouter |
| dev-master | 2 | 4 GB | 20 GB | K8s control plane |
| dev-worker1 | 2 | 8 GB | 20 GB | 앱 전체 (단일 레플리카) + Istio |
| staging-master | 2 | 4 GB | 20 GB | K8s control plane |
| staging-worker1 | 3 | 10 GB | 20 GB | 앱 서비스 (2 레플리카) |
| staging-worker2 | 3 | 10 GB | 20 GB | 앱 서비스 (topology spread) |
| prod-master | 2 | 4 GB | 20 GB | K8s control plane |
| prod-worker1 | 3 | 12 GB | 20 GB | WAS 서비스 (HA, HPA) |
| prod-worker2 | 3 | 12 GB | 20 GB | WAS 서비스 (HA, HPA) |
| prod-worker3 | 3 | 12 GB | 20 GB | WAS 스케일아웃 버퍼 |
| prod-worker4 | 2 | 8 GB | 20 GB | 데이터 티어 (DB, MQ, Cache) |

---

## 3. Pod 리소스 버짓

### 3.1 서비스별 리소스 할당

| 서비스 | CPU requests | CPU limits | Mem requests | Mem limits | 비고 |
|--------|-------------|-----------|-------------|-----------|------|
| order-service | 100m | 500m | 256Mi | 512Mi | JVM 힙 메모리 필요 |
| product-service | 100m | 400m | 128Mi | 256Mi | V8 엔진 메모리 |
| cart-service | 50m | 300m | 64Mi | 128Mi | Go 바이너리, 경량 |
| user-service | 50m | 300m | 128Mi | 256Mi | Uvicorn + asyncpg |
| review-service | 30m | 200m | 32Mi | 64Mi | Rust, 최소 메모리 |
| notification-worker | 50m | 200m | 128Mi | 256Mi | amqplib + ioredis |
| nginx-static | 50m | 200m | 64Mi | 128Mi | 정적 서빙 |
| apache-legacy | 50m | 200m | 64Mi | 128Mi | mod_proxy |
| haproxy | 50m | 200m | 64Mi | 128Mi | L4/L7 프록시 |
| postgresql | 100m | 500m | 256Mi | 512Mi | ACID 연산 |
| mongodb | 100m | 500m | 256Mi | 512Mi | WiredTiger 캐시 |
| redis | 50m | 200m | 64Mi | 256Mi | maxmemory 200MB |
| rabbitmq | 100m | 300m | 256Mi | 512Mi | 큐 메시지 버퍼 |
| elasticsearch | 200m | 1000m | 512Mi | 1Gi | JVM 힙 |
| fluentd | 50m | 200m | 128Mi | 256Mi | DaemonSet |
| kibana | 100m | 500m | 256Mi | 512Mi | UI 렌더링 |

### 3.2 단일 레플리카 합계

```
CPU requests 합계: ~1,280m (1.28 cores)
CPU limits 합계:   ~5,200m (5.2 cores)
Mem requests 합계: ~2,448Mi (~2.4 GB)
Mem limits 합계:   ~5,312Mi (~5.2 GB)

→ 워커 노드 1개 (2C/8G) 기준:
  CPU requests: 1.28 / 2.0 = 64% → 스케줄 가능
  Mem requests: 2.4 / 8.0 = 30% → 여유 있음
```

### 3.3 prod 스케일아웃 시 리소스 예측

```
평시 (기본 레플리카):
  WAS 5종 × 3 replicas = 15 pods
  WEB 1종 × 2 replicas = 2 pods (nginx)
  WEB 1종 × 1 replica  = 1 pod (apache)
  Worker × 1 replica    = 1 pod
  Data 4종 × 1 replica  = 4 pods
  합계: 23 pods
  CPU requests: ~2.8 cores / Mem requests: ~5.6 GB

피크 (HPA 스케일아웃):
  WAS → HPA max 기준 약 40 pods
  Worker → KEDA max 10 pods
  합계: ~55 pods
  CPU requests: ~5.0 cores / Mem requests: ~10 GB

prod 워커 가용 리소스:
  4 workers × (3C+3C+3C+2C) = 11 cores
  4 workers × (12G+12G+12G+8G) = 44 GB
  → 피크 시에도 CPU 45%, RAM 23% 사용 → 충분한 여유
```

---

## 4. 리소스 최적화 전략

### 4.1 requests vs limits 설계 원칙

```
requests: 서비스가 정상 운영에 필요한 최소 리소스
  → 스케줄러가 노드 배치 시 사용
  → 너무 높으면 → Pod가 스케줄 안 됨 (Pending)
  → 너무 낮으면 → 다른 Pod와 경쟁, 성능 저하

limits: 서비스가 사용 가능한 최대 리소스
  → 초과 시 CPU throttling, Memory OOMKilled
  → requests 대비 2~5배 설정 (burst 허용)
```

### 4.2 언어별 메모리 특성

| 언어 | 서비스 | 메모리 특성 | 설정 근거 |
|------|--------|-----------|----------|
| Java (JVM) | order-service | 힙 메모리 크기에 비례, GC 오버헤드 | 256Mi req (초기 힙) → 512Mi lim (최대 힙) |
| Node.js (V8) | product-service | V8 힙 + 버퍼, 기본 ~1.5GB 제한 | 128Mi req → 256Mi lim |
| Go | cart-service | 바이너리 크기 작음, GC 효율적 | 64Mi req → 128Mi lim |
| Python (CPython) | user-service | GIL, asyncio 기반 | 128Mi req → 256Mi lim |
| Rust | review-service | 힙 할당 최소화, 메모리 안전 | 32Mi req → 64Mi lim |

---

## 5. 운영 시나리오별 리소스

### 5.1 권장 운영 모드

```
[모드 1] 풀 프로덕션 시뮬레이션
  기동: platform + prod = 18C/72G
  용도: 부하 테스트, HPA 검증, 모니터링 시연
  호스트 여유: ~56 GB RAM

[모드 2] 개발 + 운영
  기동: platform + dev + prod = 24C/84G
  용도: 개발 후 바로 prod 배포 검증
  호스트 여유: ~44 GB RAM

[모드 3] 전체 파이프라인
  기동: 전체 13VM = 32C/108G
  용도: 완전한 dev → staging → prod 파이프라인 데모
  호스트 여유: ~20 GB RAM (부하 테스트 시 swap 가능)

[모드 4] 최소 개발
  기동: dev만 = 4C/12G
  용도: 앱 코드 수정 및 디버깅
  호스트 여유: ~116 GB RAM
```

### 5.2 리소스 부족 시 대응

```
증상: Pod Pending (Insufficient cpu/memory)
대응:
  1. kubectl describe pod → Events에서 원인 확인
  2. kubectl top nodes → 노드별 실 사용률 확인
  3. 불필요한 클러스터 중지 (tart stop staging-master staging-worker1 staging-worker2)
  4. HPA maxReplicas 축소
  5. 서비스 requests 값 하향 조정

증상: OOMKilled
대응:
  1. kubectl describe pod → Last State: Terminated, Reason: OOMKilled
  2. 해당 서비스의 memory limits 증가
  3. 애플리케이션 메모리 누수 점검
  4. JVM의 경우 -Xmx 값 limits의 70%로 설정
```
