# 06. 모니터링과 관측성 (Observability)

---

## 이 단계에서 학습하는 기술

| 기술 | 개념 |
|------|------|
| **Prometheus** | Pull 기반 메트릭 수집 시스템. 각 서비스의 /metrics 엔드포인트를 주기적으로 HTTP GET하여 시계열 데이터를 수집 |
| **ServiceMonitor** | Prometheus Operator CRD. Service 셀렉터로 스크래핑 대상을 선언적으로 정의 |
| **Grafana** | 시계열 데이터 시각화 도구. PromQL 쿼리 결과를 대시보드 패널로 렌더링 |
| **EFK Stack** | Elasticsearch(저장) + Fluentd(수집) + Kibana(시각화). 중앙집중식 로그 수집 파이프라인 |
| **Scouter** | Java APM(Application Performance Management) 도구. 바이트코드 계측(instrumentation)으로 메서드 레벨 성능 추적 |
| **PrometheusRule** | 알림 규칙 CRD. PromQL 표현식으로 조건을 정의하고, 조건 충족 시 Alertmanager에 알림 전송 |

---

## 1. Prometheus 메트릭 수집

### 1.1 메트릭 수집 경로

```
┌──────────────────────────────────────────────────────────┐
│ Platform Cluster                                          │
│                                                          │
│  [Prometheus Server]                                      │
│       │ 15초마다 HTTP GET /metrics 또는 /actuator/prometheus│
│       │                                                   │
│       ├──→ order-service:8080/actuator/prometheus         │
│       ├──→ product-service:3000/metrics                   │
│       ├──→ cart-service:8081/metrics                      │
│       ├──→ user-service:8000/metrics                     │
│       ├──→ review-service:8082/metrics                   │
│       ├──→ notification-worker:3001/metrics              │
│       └──→ nginx-static:80/stub_status                   │
│                                                          │
│  [Grafana] ← PromQL 쿼리 ← [Prometheus]                  │
└──────────────────────────────────────────────────────────┘
```

**기술 해설 - Pull vs Push 모델**:
- **Pull (Prometheus)**: 모니터링 서버가 대상 서비스에 HTTP 요청을 보내 메트릭을 가져옴. 서비스는 /metrics 엔드포인트만 노출하면 됨
- **Push (StatsD, Datadog Agent)**: 서비스가 메트릭 데이터를 모니터링 서버로 전송

Pull 모델의 장점:
- 서비스가 모니터링 서버의 주소를 알 필요 없음 (느슨한 결합)
- 서비스 장애 시 scrape 실패로 즉시 감지 가능
- scrape interval을 중앙에서 제어 가능

### 1.2 ServiceMonitor CRD

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: order-service
  namespace: ecommerce
  labels:
    release: prometheus            # Prometheus Operator의 serviceMonitorSelector와 매칭
spec:
  selector:
    matchLabels:
      app: order-service           # 이 레이블을 가진 Service를 찾아서
  endpoints:
    - port: http                   # 해당 포트의
      path: /actuator/prometheus   # 이 경로를 15초마다 scrape
      interval: 15s
```

**기술 해설 - ServiceMonitor 동작**:
Prometheus Operator는 ServiceMonitor CRD를 감시(watch)한다. ServiceMonitor가 생성/수정되면, Operator가 Prometheus의 scrape_config를 자동 갱신한다. 이를 통해 Prometheus 설정 파일을 직접 편집하지 않고도 scraping 대상을 선언적으로 관리할 수 있다.

### 1.3 각 서비스의 메트릭 구현

| 서비스 | 라이브러리 | 메트릭 예시 |
|--------|----------|-----------|
| order-service | Spring Boot Actuator + Micrometer | `http_server_requests_seconds`, `jvm_memory_used_bytes`, `hikaricp_connections_active` |
| product-service | prom-client (Node.js) | `http_request_duration_seconds`, `nodejs_heap_size_used_bytes`, `product_cache_hits_total` |
| cart-service | promhttp (Go) | `http_requests_total`, `go_goroutines`, `cart_checkouts_total` |
| user-service | prometheus-fastapi-instrumentator | `http_request_duration_seconds`, `python_gc_collections_total` |
| review-service | actix-web-prom | `http_requests_total`, `http_request_duration_seconds` |

### 1.4 메트릭 확인 (실습)

```bash
DEV_IP=$(tart ip dev-master)

# 각 서비스의 메트릭 엔드포인트 직접 조회
curl -s http://${DEV_IP}:30080/api/orders/actuator/prometheus | head -20
curl -s http://${DEV_IP}:30080/api/products/metrics | head -20

# Prometheus UI에서 PromQL 실행 (platform 클러스터)
PLATFORM_IP=$(tart ip platform-master)
# 브라우저: http://${PLATFORM_IP}:30090

# PromQL 예시:
# rate(http_server_requests_seconds_count[5m])        → 초당 요청 수
# histogram_quantile(0.99, rate(http_server_requests_seconds_bucket[5m])) → P99 레이턴시
# sum(increase(http_server_requests_seconds_count{status=~"5.."}[5m]))    → 5xx 에러 수
```

---

## 2. PrometheusRule (알림 규칙)

### 2.1 SLA/SLO 알림

```yaml
# monitoring/prometheus-rules/sla-rules.yaml
groups:
  - name: ecommerce-sla
    rules:
      - alert: OrderServiceHighLatency
        expr: histogram_quantile(0.99, rate(http_server_requests_seconds_bucket{service="order-service"}[5m])) > 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "order-service P99 레이턴시가 1초를 초과"

      - alert: HighErrorRate
        expr: sum(rate(http_server_requests_seconds_count{status=~"5.."}[5m])) / sum(rate(http_server_requests_seconds_count[5m])) > 0.01
        for: 5m
        labels:
          severity: critical
```

**기술 해설 - PromQL**:
- `rate()`: counter 메트릭의 초당 증가율 계산. 5분 윈도우 내의 데이터 포인트를 선형 회귀하여 산출
- `histogram_quantile(0.99, ...)`: 히스토그램 버킷에서 99번째 백분위수(P99) 계산. 100개 요청 중 99번째로 느린 응답 시간
- `for: 5m`: 조건이 5분 연속 충족되어야 알림 발생. 일시적 스파이크에 의한 거짓 알림(false positive) 방지

### 2.2 알림 흐름

```
[PrometheusRule 조건 충족]
       ↓
[Prometheus → Alertmanager]
       ↓
[Alertmanager → 통보 채널]
  ├── Slack webhook
  ├── PagerDuty
  └── Email
```

---

## 3. Grafana 대시보드

### 3.1 대시보드 구성

이 프로젝트에는 2개의 대시보드가 포함되어 있다:

**ecommerce-overview.json**:
- RPS (초당 요청 수) by service
- 에러율 (%) by status code
- P50/P95/P99 레이턴시
- RabbitMQ 큐 깊이

**autoscaling-dashboard.json**:
- HPA replicas vs desired replicas
- CPU 사용률 vs HPA threshold
- KEDA ScaledObject 상태
- Pod 생성/삭제 이벤트

### 3.2 대시보드 임포트 (실습)

```bash
PLATFORM_IP=$(tart ip platform-master)
echo "Grafana: http://${PLATFORM_IP}:30300"
# 기본 계정: admin / admin

# 대시보드 JSON 파일 위치:
# monitoring/grafana-dashboards/ecommerce-overview.json
# monitoring/grafana-dashboards/autoscaling-dashboard.json

# Grafana UI → Dashboards → Import → JSON 파일 업로드
```

---

## 4. EFK Stack (로그 수집)

### 4.1 아키텍처

```
[Pod stdout/stderr]
       ↓ 컨테이너 런타임이 /var/log/containers/*.log에 기록
[Fluentd DaemonSet]  ← 각 노드에 1개씩 배포
       ↓ tail 플러그인으로 로그 파일 읽기
       ↓ 파싱 (JSON, regexp)
       ↓ 태깅 (kubernetes metadata 추가)
[Elasticsearch]
       ↓ 인덱스 저장 (logstash-YYYY.MM.DD)
[Kibana]
       ↓ 검색, 시각화, 대시보드
```

**기술 해설 - Fluentd DaemonSet**:
DaemonSet은 모든 노드에 정확히 1개의 Pod를 배포하는 K8s 리소스이다. Fluentd를 DaemonSet으로 배포하면 모든 노드의 로그를 수집할 수 있다. 새 노드가 추가되면 자동으로 Fluentd Pod가 배포된다.

Fluentd는 `/var/log/containers/` 디렉토리를 마운트하여 컨테이너 로그를 읽는다. 컨테이너 런타임(containerd)은 각 컨테이너의 stdout/stderr을 이 디렉토리에 JSON 형식으로 기록한다.

**기술 해설 - Elasticsearch 인덱싱**:
Elasticsearch는 Lucene 기반의 분산 검색/분석 엔진이다. 문서를 역인덱스(inverted index)로 저장한다. 역인덱스는 각 토큰(단어)이 어떤 문서에 등장하는지를 기록하여, 전문 검색 시 O(1) 조회를 가능하게 한다.

### 4.2 로그 확인 (실습)

```bash
# Kibana 접속
DEV_IP=$(tart ip dev-master)
echo "Kibana: http://${DEV_IP}:31601"

# Elasticsearch 직접 쿼리
curl -s http://${DEV_IP}:31601/api/console/proxy?path=/_cat/indices | head -10

# 특정 서비스 로그 검색 (Kibana Discover)
# 필터: kubernetes.labels.app: "order-service"
# 시간 범위: Last 15 minutes
```

---

## 5. Scouter APM

### 5.1 구성

```
[order-service Pod]
  └── JVM에 -javaagent:/app/scouter-agent/scouter.agent.jar 로드
       ↓ 바이트코드 계측 (BCI)
       ↓ 메서드 실행 시간, SQL 실행 시간, 예외 정보 수집
[Scouter Collector] ← UDP:6100으로 에이전트 데이터 수신
[Scouter WebApp] ← HTTP:6188 (NodePort:30618)으로 시각화
```

**기술 해설 - 바이트코드 계측 (Bytecode Instrumentation)**:
Java Agent는 JVM의 `java.lang.instrument` API를 사용하여 클래스 로딩 시점에 바이트코드를 수정한다. 메서드의 진입점과 반환점에 타이밍 코드를 삽입하여, 소스코드 수정 없이 성능 데이터를 수집한다.

Scouter Agent가 수집하는 정보:
- XLog: 개별 HTTP 요청의 처리 경로 (메서드 호출 트리, SQL 쿼리, 응답 시간)
- 카운터: 초당 TPS, 활성 서비스 수, SQL 실행 횟수
- 프로파일: 메서드별 CPU 시간, 잠금 대기 시간

### 5.2 Scouter 확인 (실습)

```bash
PLATFORM_IP=$(tart ip platform-master)
echo "Scouter WebApp: http://${PLATFORM_IP}:30618"

# 부하 생성 후 XLog 확인
# → 각 점이 하나의 HTTP 요청
# → X축: 시간, Y축: 응답 시간
# → 느린 요청은 상단에 표시됨
```

---

## 6. 이 단계에서 확인할 것

- [ ] 각 서비스의 /metrics 엔드포인트가 Prometheus 형식으로 응답하는가
- [ ] Grafana에 Prometheus 데이터소스가 연결되었는가
- [ ] 대시보드 임포트 후 그래프에 데이터가 표시되는가
- [ ] Kibana에서 로그 검색이 가능한가
- [ ] Scouter WebApp에서 XLog가 표시되는가

다음 문서: [07-service-mesh-istio.md](07-service-mesh-istio.md)
