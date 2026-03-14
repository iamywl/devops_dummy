# 09. k6 부하 테스트와 결과 분석

---

## 이 단계에서 학습하는 기술

| 기술 | 개념 |
|------|------|
| **k6** | Go 기반 부하 테스트 도구. JavaScript로 시나리오를 작성하고, VU(Virtual User) 기반으로 동시 요청을 생성 |
| **VU (Virtual User)** | 독립적인 HTTP 클라이언트 인스턴스. 각 VU는 시나리오 스크립트를 반복 실행하며, 동시 사용자를 시뮬레이션 |
| **RPS** | Requests Per Second. 초당 처리 요청 수. VU 수 × (1 / 평균 응답 시간) 으로 근사 계산 |
| **P99 레이턴시** | 전체 요청의 99%가 이 시간 이내에 응답함을 의미. 상위 1% 느린 요청의 하한값 |
| **SLO** | Service Level Objective. 서비스 품질 목표 (예: P99 < 1s, 가용성 99.9%). SLA 위반 여부 판정 기준 |

---

## 1. k6 시나리오 구조

### 1.1 파일 구성

```
loadtest/k6/
├── lib/
│   ├── endpoints.js       # API 엔드포인트 URL 정의
│   └── helpers.js         # 공통 SLA 임계값, 커스텀 메트릭
└── scenarios/
    ├── smoke.js           # 10 VU, 1분 (기본 검증)
    ├── average-load.js    # 200 VU, 10분 (~200 RPS)
    ├── peak-load.js       # 500 VU, 15분 (~300 RPS)
    ├── stress-test.js     # 2000 VU, 20분 (한계점 탐색)
    └── soak-test.js       # 200 VU, 2시간 (장시간 안정성)
```

### 1.2 시나리오 코드 구조

```javascript
// smoke.js 예시
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 10,
  duration: '1m',
  thresholds: {
    http_req_duration: ['p(95)<500'],    // P95 < 500ms
    http_req_failed: ['rate<0.01'],      // 에러율 < 1%
  },
};

export default function () {
  // 각 VU가 이 함수를 반복 실행
  let res = http.get(`${BASE_URL}/api/products`);
  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 500ms': (r) => r.timings.duration < 500,
  });
  sleep(1);  // 1초 대기 (실제 사용자 행동 시뮬레이션)
}
```

**기술 해설 - VU 실행 모델**:
k6는 각 VU를 goroutine(Go의 경량 스레드)으로 실행한다. 각 VU는 `default function()`을 독립적으로 반복 실행한다. `sleep(1)`은 1초간 VU를 대기시켜 실제 사용자의 행동 간격을 시뮬레이션한다.

10 VU × sleep(1초) × 평균 응답 시간 50ms ≈ 10 RPS
200 VU × sleep(1초) × 평균 응답 시간 50ms ≈ 200 RPS

**기술 해설 - thresholds**:
`thresholds`는 테스트 통과/실패 기준이다. k6 종료 시 모든 threshold를 평가하여, 하나라도 위반하면 exit code 99를 반환한다. CI/CD 파이프라인에서 자동 품질 게이트로 사용할 수 있다.

---

## 2. 시나리오별 실행

### 2.1 Smoke Test (배포 검증)

```bash
./scripts/run-loadtest.sh smoke dev

# 목적: 배포 후 모든 엔드포인트가 정상 응답하는지 확인
# 기대 결과:
#   ✓ http_req_duration.........: p(95)=xxx (< 500ms)
#   ✓ http_req_failed...........: 0.00% (< 1%)
#   ✓ checks....................: 100.00%
```

### 2.2 Average Load (일반 트래픽)

```bash
./scripts/run-loadtest.sh average-load dev

# 패턴: ramp-up 2분 → 200 VU 유지 6분 → ramp-down 2분
# 관찰 포인트:
#   1. 응답 시간이 VU 증가에 비례하여 증가하는가
#   2. ramp-up 중 에러가 발생하는가
#   3. 안정 구간(6분)에서 응답 시간이 일정한가
```

### 2.3 Peak Load (MAU 1천만 피크)

```bash
./scripts/run-loadtest.sh peak-load prod

# 500 VU → ~300 RPS (MAU 1천만 피크 시간대 시뮬레이션)
# 관찰 포인트:
#   1. prod 클러스터의 HPA가 트리거되는가
#   2. 응답 시간이 SLO(P99 < 2s) 이내인가
#   3. Redis 캐시 HIT 비율이 유지되는가
```

### 2.4 Stress Test (한계점 탐색)

```bash
# 별도 터미널에서 HPA 관찰
kubectl --kubeconfig=../tart-infra/kubeconfig/prod.yaml get hpa -n ecommerce -w

# 스트레스 테스트 실행
./scripts/run-loadtest.sh stress-test prod

# 단계적 VU 증가: 200 → 500 → 1000 → 2000
# 관찰 포인트:
#   1. 어떤 VU 수에서 P99 > 2s가 되는가 (breaking point)
#   2. 어떤 서비스에서 먼저 에러가 발생하는가
#   3. HPA maxReplicas에 도달하는 시점
#   4. DB 커넥션 풀 소진 증상
```

### 2.5 Soak Test (장시간 안정성)

```bash
./scripts/run-loadtest.sh soak-test prod

# 200 VU × 2시간
# 관찰 포인트:
#   1. 메모리 사용량이 시간에 따라 증가하는가 (메모리 누수)
#   2. 커넥션 풀이 점진적으로 고갈되는가
#   3. GC 빈도가 증가하는가 (JVM: order-service)
#   4. 2시간 후에도 초기와 동일한 응답 시간을 유지하는가
```

---

## 3. 결과 분석

### 3.1 k6 출력 해석

```
          /\      |‾‾| /‾‾/   /‾‾/
     /\  /  \     |  |/  /   /  /
    /  \/    \    |     (   /   ‾‾\
   /          \   |  |\  \ |  (‾)  |
  / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: loadtest/k6/scenarios/peak-load.js
     output: -

  scenarios: (100.00%) 1 scenario, 500 max VUs, 15m30s max duration

  data_received..................: 245 MB 272 kB/s
  data_sent......................: 12 MB  13 kB/s
  http_req_blocked...............: avg=1.2ms   p(95)=5ms
  http_req_connecting............: avg=0.8ms   p(95)=3ms
  http_req_duration..............: avg=45ms    p(95)=120ms  p(99)=350ms
  http_req_failed................: 0.12%
  http_req_receiving.............: avg=0.5ms   p(95)=2ms
  http_req_sending...............: avg=0.1ms   p(95)=0.3ms
  http_req_waiting...............: avg=44ms    p(95)=118ms
  http_reqs......................: 285000 316/s
  iteration_duration.............: avg=1.05s   p(95)=1.12s
  iterations.....................: 285000 316/s
  vus............................: 500    min=0    max=500
  vus_max........................: 500    min=500  max=500
```

**각 메트릭의 의미**:

| 메트릭 | 의미 | 분석 포인트 |
|--------|------|-----------|
| `http_req_duration` | 전체 요청 처리 시간 (연결 + 전송 + 대기 + 수신) | P95, P99 값이 SLO 이내인가 |
| `http_req_blocked` | 커넥션 획득 대기 시간 | 높으면 커넥션 풀 부족 |
| `http_req_connecting` | TCP 연결 수립 시간 | 높으면 네트워크 문제 또는 서버 부하 |
| `http_req_waiting` | 서버 처리 시간 (TTFB) | 서버 측 병목 지표 |
| `http_req_failed` | 실패한 요청 비율 | SLO 대비 에러율 |
| `http_reqs` | 총 요청 수 및 RPS | 목표 RPS 달성 여부 |
| `iteration_duration` | VU의 한 사이클 완료 시간 | sleep 포함, 전체 사이클 시간 |

### 3.2 병목 식별 방법

```
P95 < 200ms, P99 < 500ms → 정상 (여유 있음)
P95 < 500ms, P99 > 1s    → 일부 요청에서 병목 발생
  → http_req_waiting이 높은가?   → 서버 처리 시간 (DB 쿼리, 비즈니스 로직)
  → http_req_blocked가 높은가?   → 커넥션 풀 부족
  → http_req_connecting이 높은가? → TCP 수준 문제

에러율 > 1% → 서비스 한계 초과
  → 503 Service Unavailable     → 서비스 과부하, 서킷브레이커 동작
  → 502 Bad Gateway             → upstream 서비스 응답 없음
  → 504 Gateway Timeout         → upstream 서비스 타임아웃
```

### 3.3 Grafana와 연계 분석

부하 테스트 실행 중 Grafana 대시보드를 함께 관찰하면 다음을 확인할 수 있다:

```bash
PLATFORM_IP=$(tart ip platform-master)
echo "Grafana: http://${PLATFORM_IP}:30300"

# 대시보드에서 확인할 것:
# 1. ecommerce-overview: RPS 그래프가 k6 VU 증가와 비례하여 증가하는가
# 2. autoscaling-dashboard: HPA replicas가 변하는 시점
# 3. CPU 사용률 그래프와 HPA threshold(50%) 교차 시점
# 4. RabbitMQ 큐 깊이 변화 → KEDA 스케일링 트리거 시점
```

---

## 4. 결과 저장 및 비교

```bash
# JSON 형식으로 결과 저장
k6 run --out json=loadtest/results/peak-load-$(date +%Y%m%d-%H%M).json \
  loadtest/k6/scenarios/peak-load.js

# 이전 결과와 비교
# → 코드 변경 전후 P95, P99 레이턴시 차이
# → 인프라 변경 (HPA max 증가 등) 전후 비교
# → 캐시 설정 변경 (TTL 조절) 전후 비교
```

---

## 5. 이 단계에서 확인할 것

- [ ] smoke 테스트가 모든 threshold를 통과하는가
- [ ] peak-load 시 HPA 스케일업이 발생하는가
- [ ] stress-test에서 breaking point를 식별했는가
- [ ] Grafana 대시보드에서 부하 테스트 기간의 메트릭이 보이는가
- [ ] k6 결과와 Grafana 메트릭이 일치하는가 (RPS, 에러율)

---

## 전체 재연 완료 체크리스트

| 단계 | 문서 | 완료 |
|------|------|------|
| VM + K8s 클러스터 | 01-vm-cluster-setup.md | [ ] |
| Docker 이미지 빌드 | 02-container-image-build.md | [ ] |
| Kustomize 배포 | 03-kustomize-deploy.md | [ ] |
| 서비스 구조 이해 | 04-service-architecture.md | [ ] |
| 오토스케일링 | 05-autoscaling.md | [ ] |
| 모니터링 | 06-monitoring-observability.md | [ ] |
| Istio 서비스 메시 | 07-service-mesh-istio.md | [ ] |
| ArgoCD GitOps | 08-gitops-argocd.md | [ ] |
| 부하 테스트 | 09-loadtest-analysis.md | [ ] |

모든 단계를 완료하면, 이 프로젝트의 전체 아키텍처를 이해하고 직접 재현할 수 있다.
