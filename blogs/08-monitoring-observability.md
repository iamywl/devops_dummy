# 08. Prometheus + Grafana + EFK로 관측성 확보

## 핵심 요약

Prometheus ServiceMonitor로 7개 서비스의 메트릭을 자동 수집하고, Grafana 대시보드로 시각화하며, PrometheusRule로 SLA 위반 알림을 설정한다. EFK Stack(Elasticsearch + Fluentd + Kibana)으로 중앙 로그 수집 파이프라인을 구축한다.

---

## 1. 모니터링 아키텍처

```
┌──────────────────────────────────────────────────┐
│                 앱 클러스터 (dev/staging/prod)    │
│                                                    │
│  order-service ──/actuator/prometheus──┐          │
│  product-service ──/metrics──────────┤           │
│  cart-service ──/metrics─────────────┤           │
│  user-service ──/metrics─────────────┤           │
│  review-service ──/metrics───────────┤           │
│  notification-worker ──/metrics──────┤           │
│  nginx-static ──/stub_status─────────┘           │
│                                                    │
│  각 Pod stdout/stderr ──→ Fluentd DaemonSet     │
│                              │                    │
│                              ▼                    │
│                        Elasticsearch              │
│                              │                    │
│                              ▼                    │
│                           Kibana                  │
└──────────────────┬───────────────────────────────┘
                   │ ServiceMonitor 스크래핑
                   ▼
┌──────────────────────────────────────────────────┐
│            platform 클러스터                       │
│                                                    │
│  Prometheus ← ServiceMonitor CRD                  │
│      │                                            │
│      ├──→ Grafana (대시보드 시각화)               │
│      │     ├── ecommerce-overview                 │
│      │     └── autoscaling-dashboard              │
│      │                                            │
│      └──→ Alertmanager (SLA 알림)                 │
│            └── PrometheusRule                      │
└──────────────────────────────────────────────────┘
```

---

## 2. Prometheus + Grafana 설치

platform 클러스터에 kube-prometheus-stack을 Helm으로 설치한다:

```bash
cd ~/devops_dummpy  # 프로젝트 루트 경로로 이동

# Helm 레포 추가
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

# platform 클러스터에 kube-prometheus-stack 설치
helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --kubeconfig=kubeconfig/platform.yaml \
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false \
  --set prometheus.service.type=NodePort \
  --set prometheus.service.nodePort=30090 \
  --set grafana.service.type=NodePort \
  --set grafana.service.nodePort=30300 \
  --set alertmanager.service.type=NodePort \
  --set alertmanager.service.nodePort=30903 \
  --wait

# 설치 확인
kubectl --kubeconfig=kubeconfig/platform.yaml \
  get pods -n monitoring

# Grafana 접속 정보
PLATFORM_IP=$(tart ip platform-master)
echo "Grafana:      http://${PLATFORM_IP}:30300  (admin / prom-operator)  ← Helm 기본 비밀번호"
echo "Prometheus:   http://${PLATFORM_IP}:30090"
echo "Alertmanager: http://${PLATFORM_IP}:30903"
```

> `serviceMonitorSelectorNilUsesHelmValues=false` 설정은 Prometheus가 모든 네임스페이스의 ServiceMonitor를 자동으로 수집하도록 한다. 이 설정이 없으면 Helm으로 설치된 ServiceMonitor만 인식한다.

---

## 3. ServiceMonitor 설정

### 3.1 ServiceMonitor 동작 원리

> **용어 설명**
> - **CRD (Custom Resource Definition)**: K8s의 기본 리소스(Pod, Service 등) 외에 사용자가 정의한 커스텀 리소스. ServiceMonitor, PrometheusRule 등은 Prometheus Operator가 제공하는 CRD다.
> - **Prometheus Operator**: kube-prometheus-stack Helm 차트에 포함되어 있으며, ServiceMonitor CRD를 감시하다가 새로운 모니터링 대상이 추가되면 Prometheus 설정을 자동으로 업데이트한다.
> - **스크래핑(Scraping)**: Prometheus가 대상 서비스의 `/metrics` 엔드포인트에 주기적으로 HTTP GET 요청을 보내 메트릭을 수집하는 방식. Push가 아니라 Pull 방식이다.

Prometheus Operator가 ServiceMonitor CRD를 감시한다. ServiceMonitor가 생성되면 Prometheus 설정에 자동으로 스크래핑 대상이 추가된다.

```
ServiceMonitor 생성
    │
    ▼
Prometheus Operator가 감지
    │
    ▼
prometheus.yml에 scrape_config 자동 추가
    │
    ▼
Prometheus가 15초마다 해당 엔드포인트를 GET 요청
    │
    ▼
메트릭 데이터 TSDB에 저장
```

### 3.2 서비스별 ServiceMonitor

```yaml
# order-service (Java/Spring Boot Actuator)
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: order-service-monitor
  labels:
    release: prometheus    # Prometheus Operator 셀렉터와 매치
spec:
  selector:
    matchLabels:
      app: order-service
  endpoints:
    - port: http
      path: /actuator/prometheus    # Micrometer → Prometheus 포맷
      interval: 15s

---
# product-service (Node.js prom-client)
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: product-service-monitor
spec:
  selector:
    matchLabels:
      app: product-service
  endpoints:
    - port: http
      path: /metrics               # prom-client 기본 경로
      interval: 15s
```

### 3.3 ServiceMonitor 적용

```bash
# ServiceMonitor 파일 적용
kubectl --kubeconfig=kubeconfig/dev.yaml \
  apply -f monitoring/service-monitors/

# 적용 확인
kubectl --kubeconfig=kubeconfig/dev.yaml \
  get servicemonitor -n ecommerce

# Prometheus targets에서 확인 (1-2분 후)
PLATFORM_IP=$(tart ip platform-master)
echo "Prometheus Targets: http://${PLATFORM_IP}:30090/targets"
```

### 3.4 각 서비스가 노출하는 메트릭

| 서비스 | 라이브러리 | 경로 | 핵심 메트릭 |
|--------|-----------|------|-----------|
| order-service | Micrometer | /actuator/prometheus | http_server_requests_seconds, jvm_memory_used |
| product-service | prom-client | /metrics | http_requests_total, http_request_duration_seconds |
| cart-service | promhttp | /metrics | http_requests_total, cart_checkouts_total |
| user-service | prometheus-fastapi-instrumentator | /metrics | http_requests_total |
| review-service | actix-web-prom | /metrics | http_requests_total |
| notification-worker | prom-client | /metrics | notification_messages_consumed_total, notification_sent_total |

---

## 4. Grafana 대시보드

### 4.1 ecommerce-overview 대시보드

```
패널 구성:
┌─────────────────────────────────────────────┐
│ RPS (Requests Per Second)                   │
│ sum(rate(http_requests_total[5m])) by (app) │
├─────────────────────────────────────────────┤
│ Error Rate (%)                              │
│ sum(rate(http_requests_total{status=~"5.."}))│
│ / sum(rate(http_requests_total))             │
├─────────────────────────────────────────────┤
│ Latency P95 / P99                           │
│ histogram_quantile(0.95, ...)               │
├─────────────────────────────────────────────┤
│ RabbitMQ Queue Depth                        │
│ rabbitmq_queue_messages                     │
└─────────────────────────────────────────────┘
```

### 4.2 대시보드 임포트

```bash
# Grafana UI에서 JSON 임포트
# monitoring/grafana-dashboards/ecommerce-overview.json
# monitoring/grafana-dashboards/autoscaling-dashboard.json

PLATFORM_IP=$(tart ip platform-master)
echo "Grafana: http://${PLATFORM_IP}:30300"
# 계정: admin / prom-operator (kube-prometheus-stack Helm 기본값)
```

---

## 5. PrometheusRule (SLA 알림)

### 5.1 알림 규칙 설계

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: ecommerce-sla-rules
spec:
  groups:
    - name: ecommerce.sla
      rules:
        # 1. 주문 서비스 지연
        - alert: OrderServiceHighLatency
          expr: |
            histogram_quantile(0.99,
              sum(rate(http_server_requests_seconds_bucket{app="order-service"}[5m])) by (le)
            ) > 1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "order-service P99 레이턴시가 1초를 초과"

        # 2. 전체 에러율
        - alert: HighErrorRate
          expr: |
            sum(rate(http_requests_total{status=~"5.."}[5m]))
            / sum(rate(http_requests_total[5m])) > 0.01
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "전체 에러율이 1%를 초과"

        # 3. Pod 재시작 루프
        - alert: PodRestartLoop
          expr: |
            increase(kube_pod_container_status_restarts_total{namespace="ecommerce"}[1h]) > 3
          labels:
            severity: warning

        # 4. HPA 최대치 도달
        - alert: HPAMaxedOut
          expr: |
            kube_horizontalpodautoscaler_status_current_replicas
            == kube_horizontalpodautoscaler_spec_max_replicas
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "HPA가 최대 레플리카에 도달 - 스케일아웃 불가"

        # 5. RabbitMQ 큐 적체
        - alert: RabbitMQQueueBacklog
          expr: |
            rabbitmq_queue_messages{queue="order.created"} > 100
          for: 5m
          labels:
            severity: warning
```

---

### 5.2 PrometheusRule 적용

```bash
# PrometheusRule 적용
kubectl --kubeconfig=kubeconfig/platform.yaml \
  apply -f monitoring/prometheus-rules/

# 적용 확인
kubectl --kubeconfig=kubeconfig/platform.yaml \
  get prometheusrules -n monitoring

# Prometheus Alerts 페이지에서 확인
PLATFORM_IP=$(tart ip platform-master)
echo "Alerts: http://${PLATFORM_IP}:30090/alerts"
```

---

## 6. EFK Stack (로그 수집)

### 6.1 동작 원리

```
1. 각 Pod가 stdout/stderr로 로그 출력
2. containerd가 /var/log/containers/*.log 에 저장
3. Fluentd DaemonSet이 각 노드의 로그 파일을 tail
4. Fluentd가 파싱 → 태깅 → Elasticsearch로 전송
5. Kibana에서 인덱스 패턴 생성 후 검색/시각화
```

### 6.2 K8s 매니페스트

```yaml
# Elasticsearch
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: elasticsearch
spec:
  containers:
    - name: elasticsearch
      image: docker.elastic.co/elasticsearch/elasticsearch:8.12.0
      env:
        - name: discovery.type
          value: single-node
        - name: ES_JAVA_OPTS
          value: "-Xms256m -Xmx256m"
      resources:
        requests: { cpu: 200m, memory: 512Mi }
        limits:   { cpu: 1000m, memory: 1Gi }

---
# Fluentd DaemonSet
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: fluentd
spec:
  template:
    spec:
      containers:
        - name: fluentd
          image: fluent/fluentd-kubernetes-daemonset:v1-debian-elasticsearch
          volumeMounts:
            - name: varlog
              mountPath: /var/log
            - name: containers
              mountPath: /var/log/containers    # containerd 환경 (docker가 아님)
              readOnly: true
      volumes:
        - name: varlog
          hostPath: { path: /var/log }
        - name: containers
          hostPath: { path: /var/log/containers }

---
# Kibana
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kibana
spec:
  containers:
    - name: kibana
      image: docker.elastic.co/kibana/kibana:8.12.0
      env:
        - name: ELASTICSEARCH_HOSTS
          value: "http://elasticsearch:9200"
```

### 6.3 EFK 배포

EFK 스택은 base 매니페스트에 포함되어 있어 04편의 Kustomize 배포 시 함께 설치된다.

```bash
# EFK Pod 확인
kubectl --kubeconfig=kubeconfig/dev.yaml \
  get pods -n ecommerce -l 'app in (elasticsearch,fluentd,kibana)'

# Kibana 접속
DEV_IP=$(tart ip dev-master)
echo "Kibana: http://${DEV_IP}:31601"

# Kibana UI에서:
# 1. Stack Management → Index Patterns → Create
# 2. Index Pattern: logstash-*
# 3. Time Field: @timestamp
# 4. Discover 탭에서 로그 검색
```

---

## 7. Scouter APM (Java 전용)

### 7.1 동작 원리

Scouter Java Agent가 JVM에 주입되어 메서드 실행 시간, SQL 쿼리, HTTP 요청을 추적한다. order-service의 Dockerfile에서 `-javaagent` 옵션으로 주입한다.

```
order-service JVM
    │
    └── Scouter Agent (javaagent)
        │
        ├── 메서드 실행 시간 수집
        ├── SQL 쿼리 추적
        ├── HTTP 요청/응답 추적
        │
        └── UDP/TCP → Scouter Collector → Scouter WebApp
                                           (http://<IP>:30618)
```

---

## 다음 편

[09. ArgoCD GitOps: App-of-Apps 패턴으로 배포 자동화](09-gitops-argocd.md)에서는 Git 커밋 기반 자동 배포를 설정한다.
