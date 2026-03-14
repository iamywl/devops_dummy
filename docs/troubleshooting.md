# 환경 이슈 & 트러블슈팅 가이드

> Tart VM + 베어메탈 K8s + Apple Silicon 환경에서 실제로 겪는 이슈와 해결 방법

---

## 1. ARM64 (Apple Silicon) 관련 이슈

### 1.1 이미지 호환성 문제

```
문제:
  docker pull 시 "no matching manifest for linux/arm64" 에러

원인:
  일부 Docker 이미지가 amd64만 제공 (ARM64 미지원)

해결:
  ✓ 공식 이미지 중 ARM64 지원 확인된 것만 사용
  ✓ 이 프로젝트에서 사용하는 베이스 이미지 (모두 ARM64 지원):
    - eclipse-temurin:17-jre-alpine (Java)
    - node:20-alpine (Node.js)
    - golang:1.22-alpine (Go)
    - python:3.12-slim (Python)
    - rust:1.77-slim-bookworm (Rust)
    - postgres:16-alpine
    - mongo:7-jammy
    - redis:7-alpine
    - rabbitmq:3-management-alpine
    - nginx:alpine
    - httpd:2.4-alpine
    - haproxy:2.9-alpine
    - elasticsearch:8.12.0 (ARM64 지원)
    - kibana:8.12.0 (ARM64 지원)

  ✗ ARM64 미지원으로 사용 불가:
    - 일부 구버전 scouter 이미지
    - 일부 서드파티 exporter
```

### 1.2 Rust 크로스 컴파일 이슈

```
문제:
  Rust 프로젝트 Docker 빌드 시 링킹 에러
  "error: linking with `cc` failed: exit status: 1"

원인:
  ARM64 환경에서 일부 C 의존성 빌드 실패

해결:
  Dockerfile에서 필요한 빌드 의존성 설치:
    RUN apt-get update && apt-get install -y pkg-config libssl-dev

  또는 musl 정적 빌드:
    RUN rustup target add aarch64-unknown-linux-musl
    RUN cargo build --release --target aarch64-unknown-linux-musl
```

### 1.3 JVM 메모리 설정 차이

```
문제:
  ARM64 JVM에서 기본 메모리 사용량이 amd64와 다를 수 있음
  Container OOMKilled 발생

원인:
  JVM Compressed Oops 동작 차이, ARM64에서 페이지 크기 4K vs 16K(macOS)

해결:
  JAVA_OPTS에 명시적 힙 크기 지정:
    -Xms256m -Xmx512m -XX:+UseG1GC
  K8s 리소스 limit을 힙 크기의 1.5~2배로 설정:
    limits: { memory: 512Mi }  (Xmx=512m이면 limit=768Mi~1Gi)
```

---

## 2. 베어메탈 Kubernetes 이슈

### 2.1 LoadBalancer 타입 Service가 Pending 상태

```
문제:
  Service type: LoadBalancer → EXTERNAL-IP가 영원히 <pending>

원인:
  클라우드 환경이 아니므로 LoadBalancer 프로비저너 없음

해결:
  방법 1: NodePort 사용 (이 프로젝트에서 채택)
    spec:
      type: NodePort
      ports:
        - port: 80
          nodePort: 30080

  방법 2: MetalLB 설치 (VM IP 대역에서 VIP 할당)
    helm install metallb metallb/metallb -n metallb-system
    # L2 모드로 VM 네트워크 대역의 IP 할당

  방법 3: HAProxy (이 프로젝트에 포함)
    L4/L7 로드밸런싱을 직접 구성
```

### 2.2 PersistentVolume 프로비저닝 실패

```
문제:
  StatefulSet의 PVC가 Pending 상태
  "no persistent volumes available for this claim"

원인:
  베어메탈 K8s에 기본 StorageClass 없음

해결:
  방법 1: local-path-provisioner 설치 (Rancher)
    kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.26/deploy/local-path-storage.yaml
    kubectl patch storageclass local-path -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'

  방법 2: hostPath 직접 지정 (개발용)
    volumes:
      - name: data
        hostPath:
          path: /mnt/data/postgresql
          type: DirectoryOrCreate

  방법 3: NFS 서버 구성 (멀티노드 공유 필요 시)
    platform-worker1에 NFS 서버 → 다른 노드에서 마운트

확인:
  kubectl get sc                    # StorageClass 확인
  kubectl get pv,pvc -n ecommerce   # PV/PVC 상태 확인
```

### 2.3 CoreDNS / 서비스 디스커버리 이슈

```
문제:
  Pod 간 통신에서 "could not resolve host: order-service" 에러

원인:
  1. CoreDNS Pod가 정상 동작하지 않음
  2. Pod의 /etc/resolv.conf가 올바르지 않음
  3. NetworkPolicy가 DNS 트래픽 차단

진단:
  # CoreDNS 상태 확인
  kubectl get pods -n kube-system -l k8s-app=kube-dns

  # DNS 해석 테스트
  kubectl run -it --rm dnstest --image=busybox --restart=Never -- \
    nslookup order-service.ecommerce.svc.cluster.local

  # Pod에서 직접 확인
  kubectl exec -it dev-product-service-xxx -n ecommerce -- \
    cat /etc/resolv.conf

해결:
  CoreDNS 재시작: kubectl rollout restart deployment/coredns -n kube-system
  resolv.conf 확인: search ecommerce.svc.cluster.local svc.cluster.local cluster.local
```

---

## 3. Tart VM 관련 이슈

### 3.1 VM 간 네트워크 통신 불가

```
문제:
  다른 클러스터의 VM끼리 통신 안 됨 (ping 실패)

원인:
  Tart VM은 기본적으로 NAT 모드로 실행되어 호스트를 통해서만 통신

진단:
  tart ip dev-master      # VM의 IP 확인
  tart ip prod-master     # 다른 클러스터 VM IP 확인
  # 같은 서브넷인지 확인 (192.168.64.x)

해결:
  Tart VM은 기본적으로 shared network (192.168.64.0/24) 사용
  → 같은 서브넷이므로 VM 간 직접 통신 가능

  안 될 경우:
  1. VM 내부 방화벽 확인: sudo ufw status
  2. iptables 규칙 확인: sudo iptables -L
  3. VM 재시작: tart stop <vm> && tart start <vm>
```

### 3.2 VM 디스크 용량 부족

```
문제:
  VM 디스크 20GB가 Docker 이미지와 K8s 데이터로 꽉 참
  → Pod가 Evicted 상태

진단:
  # VM 내부에서 디스크 확인
  ssh admin@$(tart ip dev-worker1) "df -h"

  # containerd 이미지 확인
  ssh admin@$(tart ip dev-worker1) "sudo crictl images"

해결:
  1. 미사용 이미지 정리:
     ssh admin@$(tart ip dev-worker1) "sudo crictl rmi --prune"

  2. 완료된 Pod 정리:
     kubectl delete pods --field-selector=status.phase=Failed -n ecommerce

  3. VM 디스크 확장 (Tart):
     tart stop dev-worker1
     tart set dev-worker1 --disk-size 40  # 40GB로 확장
     tart start dev-worker1
     # VM 내부에서 파티션 확장:
     ssh admin@$(tart ip dev-worker1) "sudo growpart /dev/vda 1 && sudo resize2fs /dev/vda1"
```

### 3.3 VM 시작 후 K8s 노드 NotReady

```
문제:
  tart start 후 kubectl get nodes에서 NotReady

원인:
  kubelet 서비스가 자동 시작되지 않거나 인증서 만료

진단:
  ssh admin@$(tart ip dev-master) "sudo systemctl status kubelet"
  ssh admin@$(tart ip dev-master) "sudo journalctl -u kubelet --since '5 min ago'"

해결:
  1. kubelet 재시작:
     ssh admin@$(tart ip dev-master) "sudo systemctl restart kubelet"

  2. 인증서 갱신 (장기간 중지 후):
     ssh admin@$(tart ip dev-master) "sudo kubeadm certs renew all"
     ssh admin@$(tart ip dev-master) "sudo systemctl restart kubelet"

  3. swap 비활성화 확인:
     ssh admin@$(tart ip dev-master) "sudo swapoff -a"
```

---

## 4. 애플리케이션 레벨 이슈

### 4.1 Spring Boot 기동 시간 느림 (order-service)

```
문제:
  order-service Pod가 Ready까지 60초 이상 소요
  → readinessProbe 실패로 트래픽 전달 안 됨

원인:
  1. JVM Cold Start + Spring Context 초기화
  2. Flyway/JPA DDL auto → 첫 기동 시 스키마 생성
  3. 메모리 부족 시 GC thrashing

해결:
  1. startupProbe 설정 (readinessProbe 전에 충분한 시간 확보):
     startupProbe:
       failureThreshold: 12
       periodSeconds: 5   # 최대 60초 대기

  2. JVM 워밍업:
     JAVA_OPTS: "-XX:+TieredCompilation -XX:TieredStopAtLevel=1"
     (빠른 기동을 위해 C2 컴파일러 비활성화)

  3. Spring Boot lazy initialization:
     spring.main.lazy-initialization=true
```

### 4.2 MongoDB 연결 타임아웃 (product-service)

```
문제:
  "MongoServerSelectionError: connect ECONNREFUSED mongodb:27017"

원인:
  1. MongoDB Pod가 아직 Ready 아님
  2. DNS 해석 실패
  3. product-service가 MongoDB보다 먼저 시작

해결:
  1. 연결 재시도 로직 (product-service/src/index.js에 구현됨):
     mongoose.connect(MONGO_URI, {
       serverSelectionTimeoutMS: 5000,
       retryWrites: true,
     });

  2. initContainer로 DB 대기:
     initContainers:
       - name: wait-for-mongo
         image: busybox
         command: ['sh', '-c', 'until nc -z mongodb 27017; do sleep 2; done']
```

### 4.3 RabbitMQ 큐 메시지 유실

```
문제:
  order-service에서 발행한 이벤트가 notification-worker에서 처리 안 됨

원인:
  1. 큐가 durable=false로 설정됨 (RabbitMQ 재시작 시 유실)
  2. Consumer가 ack 전에 크래시
  3. Exchange-Queue 바인딩 미설정

진단:
  # RabbitMQ 관리 UI에서 큐 상태 확인
  open http://${DEV_IP}:31672  (guest/guest)
  # Queues 탭에서 order.created.queue 확인

  # CLI로 확인
  kubectl exec -it dev-rabbitmq-0 -n ecommerce -- \
    rabbitmqctl list_queues name messages consumers

해결:
  1. 큐 durable: true 확인 (RabbitMQConfig.java에 설정됨)
  2. Consumer에서 manual ack 사용 (worker.js에서 channel.ack(msg))
  3. Dead Letter Queue 설정으로 실패 메시지 보존
```

---

## 5. 모니터링 / 옵저버빌리티 이슈

### 5.1 Prometheus 메트릭 수집 안 됨

```
문제:
  ServiceMonitor를 만들었는데 Prometheus Targets에 안 보임

원인:
  1. ServiceMonitor의 label이 Prometheus Operator의 serviceMonitorSelector와 불일치
  2. Service의 port name이 ServiceMonitor의 endpoints.port와 불일치

진단:
  # Prometheus의 serviceMonitorSelector 확인
  kubectl get prometheus -n monitoring -o yaml | grep -A5 serviceMonitorSelector

  # ServiceMonitor 확인
  kubectl get servicemonitor -n ecommerce -o yaml

해결:
  ServiceMonitor에 release: prometheus 라벨 추가 (이미 적용됨)
  Service의 port name과 ServiceMonitor의 endpoints.port 일치시키기
```

### 5.2 EFK 로그 수집 안 됨

```
문제:
  Kibana에서 ecommerce-logs 인덱스가 보이지 않음

원인:
  1. Fluentd DaemonSet이 실행되지 않음
  2. 로그 파일 경로가 다름 (containerd vs docker)
  3. Elasticsearch 연결 실패

진단:
  # Fluentd Pod 로그 확인
  kubectl logs -l app=fluentd -n ecommerce --tail=50

  # 컨테이너 로그 경로 확인 (VM 내부)
  ssh admin@$(tart ip dev-worker1) "ls /var/log/containers/ | head"

  # Elasticsearch 상태 확인
  kubectl exec -it dev-elasticsearch-0 -n ecommerce -- \
    curl -s localhost:9200/_cluster/health | python3 -m json.tool

해결:
  containerd 환경에서는 로그 경로가 /var/log/pods/ 하위
  Fluentd 설정에서 path 수정 필요할 수 있음
```

---

## 6. 리소스 관련 이슈

### 6.1 Worker 노드 메모리 부족

```
문제:
  Pod가 Evicted 상태 → "The node was low on resource: memory"

진단:
  kubectl describe node dev-worker1 | grep -A5 "Allocated resources"
  kubectl top nodes
  kubectl top pods -n ecommerce

해결:
  1. 불필요한 서비스 리소스 줄이기:
     EFK 스택은 dev에서 비활성화 (리소스 절약)
     → overlays/dev/kustomization.yaml에서 logging 제외

  2. 특정 서비스만 배포:
     kubectl apply -f manifests/base/was-tier/order-service.yaml -n ecommerce

  3. VM 메모리 증가:
     tart stop dev-worker1
     tart set dev-worker1 --memory 12288  # 12GB
     tart start dev-worker1
```

### 6.2 HPA가 스케일 안 함

```
문제:
  CPU 사용률이 높은데 HPA가 replicas를 늘리지 않음

원인:
  1. metrics-server 미설치
  2. Pod에 resources.requests 미설정
  3. HPA의 scaleTargetRef 이름 불일치

진단:
  kubectl get hpa -n ecommerce
  kubectl describe hpa order-service-hpa -n ecommerce
  kubectl top pods -n ecommerce

해결:
  1. metrics-server 설치 확인:
     kubectl get pods -n kube-system | grep metrics-server

  2. resources.requests 확인 (HPA는 requests 기준으로 계산):
     kubectl get deployment dev-order-service -n ecommerce -o yaml | grep -A4 resources

  3. targetRef name이 namePrefix 포함한 정확한 이름인지 확인:
     scaleTargetRef.name: prod-order-service  (not: order-service)
```
