# 02. Tart VM으로 K8s 멀티클러스터 구축하기

## 핵심 요약

Apple Silicon Mac 위에 Tart VM 10대를 생성하고, kubeadm으로 4개 K8s 클러스터(platform/dev/staging/prod)를 부트스트랩한다. CNI는 Cilium을 사용하며, kube-proxy를 완전히 대체하는 eBPF 기반 고성능 네트워킹을 구현한다.

이 편의 모든 명령어는 터미널에 복사-붙여넣기하여 그대로 실행할 수 있다.

---

## 1. Tart란

Tart는 Apple Virtualization Framework를 래핑한 CLI 도구다. Apple Silicon에서 네이티브 ARM64 VM을 실행한다.

```
동작 원리:
  macOS Host
    └── Apple Virtualization.framework (Type 2 하이퍼바이저)
        └── Tart CLI (VM 라이프사이클 관리)
            └── Ubuntu 24.04 ARM64 Guest VM
                └── containerd + kubeadm (K8s 노드)
```

**Tart를 선택한 이유**:
- VirtualBox/UTM: x86 에뮬레이션 오버헤드 → Tart: 네이티브 ARM64, 성능 저하 없음
- kind/k3d: 컨테이너 내 K8s → Tart: 실제 VM이므로 kubeadm으로 프로덕션 동일 K8s 구축
- 클라우드(EKS/GKE): 비용 발생 → Tart: 비용 0원, 오프라인 가능

---

## 2. 사전 설치

```bash
# Tart 설치
brew install cirruslabs/cli/tart

# K8s 도구
brew install kubectl helm kustomize jq

# VM SSH 자동화
brew install esolitos/ipa/sshpass

# 확인
tart --version && kubectl version --client && helm version --short && jq --version
```

---

## 3. 클러스터 설계

이 프로젝트는 4개 클러스터, 10대 VM을 사용한다.

```json
{
  "base_image": "ghcr.io/cirruslabs/ubuntu:latest",
  "ssh_user": "admin",
  "ssh_password": "admin",
  "clusters": [
    {
      "name": "platform",
      "pod_cidr": "10.10.0.0/16",
      "service_cidr": "10.96.0.0/16",
      "nodes": [
        { "name": "platform-master",  "role": "master", "cpu": 2, "memory": 4096 },
        { "name": "platform-worker1", "role": "worker", "cpu": 3, "memory": 12288 },
        { "name": "platform-worker2", "role": "worker", "cpu": 2, "memory": 8192 }
      ]
    },
    {
      "name": "dev",
      "pod_cidr": "10.20.0.0/16",
      "service_cidr": "10.97.0.0/16",
      "nodes": [
        { "name": "dev-master",  "role": "master", "cpu": 2, "memory": 4096 },
        { "name": "dev-worker1", "role": "worker", "cpu": 2, "memory": 8192 }
      ]
    },
    {
      "name": "staging",
      "pod_cidr": "10.30.0.0/16",
      "service_cidr": "10.98.0.0/16",
      "nodes": [
        { "name": "staging-master",  "role": "master", "cpu": 2, "memory": 4096 },
        { "name": "staging-worker1", "role": "worker", "cpu": 2, "memory": 8192 }
      ]
    },
    {
      "name": "prod",
      "pod_cidr": "10.40.0.0/16",
      "service_cidr": "10.99.0.0/16",
      "nodes": [
        { "name": "prod-master",  "role": "master", "cpu": 2, "memory": 3072 },
        { "name": "prod-worker1", "role": "worker", "cpu": 2, "memory": 8192 },
        { "name": "prod-worker2", "role": "worker", "cpu": 2, "memory": 8192 }
      ]
    }
  ]
}
```

**Pod/Service CIDR를 클러스터별로 다르게 설정하는 이유**: 향후 멀티클러스터 네트워킹(Cilium Cluster Mesh)을 적용할 때 IP 충돌을 방지한다.

---

## 4. VM 생성

### 4.1 베이스 이미지 다운로드

```bash
# Ubuntu 24.04 ARM64 OCI 이미지 다운로드 (약 2GB, 최초 1회)
tart pull ghcr.io/cirruslabs/ubuntu:latest
```

### 4.2 10대 VM 복제 및 리소스 할당

```bash
# VM 복제
VMS=(
  platform-master platform-worker1 platform-worker2
  dev-master dev-worker1
  staging-master staging-worker1
  prod-master prod-worker1 prod-worker2
)

for vm in "${VMS[@]}"; do
  echo "복제: ${vm}"
  tart clone ghcr.io/cirruslabs/ubuntu:latest "$vm"
done

# 리소스 할당 (clusters.json 기반)
tart set platform-master  --cpu 2 --memory 4096
tart set platform-worker1 --cpu 3 --memory 12288
tart set platform-worker2 --cpu 2 --memory 8192

tart set dev-master  --cpu 2 --memory 4096
tart set dev-worker1 --cpu 2 --memory 8192

tart set staging-master  --cpu 2 --memory 4096
tart set staging-worker1 --cpu 2 --memory 8192

tart set prod-master  --cpu 2 --memory 3072
tart set prod-worker1 --cpu 2 --memory 8192
tart set prod-worker2 --cpu 2 --memory 8192

echo "VM 생성 완료"
tart list
```

### 4.3 전체 VM 기동

```bash
# --net-softnet-allow: VM 간 통신을 위한 소프트넷 브릿지 모드 활성화
# 이 옵션 없이는 VM끼리 ping이 안 되어 kubeadm join이 실패한다
for vm in "${VMS[@]}"; do
  echo "기동: ${vm}"
  tart run "$vm" --no-graphics --net-softnet-allow=0.0.0.0/0 &
  sleep 2
done

# IP 할당 대기 (DHCP, 약 30-60초)
echo "IP 할당 대기 중..."
sleep 30

# IP 확인
for vm in "${VMS[@]}"; do
  ip=$(tart ip "$vm" 2>/dev/null || echo "대기중...")
  echo "  ${vm}: ${ip}"
done
```

> **중요**: `--net-softnet-allow=0.0.0.0/0` 옵션은 Tart의 Softnet 브릿지 모드를 활성화한다.
> 기본 NAT 모드에서는 VM 간 통신이 차단되어 kubeadm join이 실패한다.
> Softnet 모드에서 VM은 192.168.65.x 대역의 IP를 DHCP로 할당받는다.

---

## 5. 노드 준비 (모든 VM 공통)

각 VM에 SSH 접속하여 K8s 노드에 필요한 설정을 적용한다.

### 5.1 SSH 헬퍼 함수 정의

```bash
# 이 함수를 터미널에 먼저 붙여넣기
ssh_exec() {
  local ip="$1"; shift
  sshpass -p admin ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR admin@"$ip" "$@"
}

ssh_exec_sudo() {
  local ip="$1"; shift
  sshpass -p admin ssh -o StrictHostKeyChecking=no -o LogLevel=ERROR admin@"$ip" "echo admin | sudo -S bash -c '$*'"
}
```

### 5.2 모든 노드에 공통 설정 적용

```bash
for vm in "${VMS[@]}"; do
  ip=$(tart ip "$vm")
  echo "=== ${vm} (${ip}) 노드 준비 ==="

  ssh_exec_sudo "$ip" "
    # 스왑 비활성화 (K8s 요구사항)
    swapoff -a && sed -i '/swap/d' /etc/fstab

    # 커널 모듈 로드 (컨테이너 네트워킹)
    cat > /etc/modules-load.d/k8s.conf <<EOF
overlay
br_netfilter
EOF
    modprobe overlay
    modprobe br_netfilter

    # sysctl 설정 (브릿지 트래픽이 iptables를 통과하도록)
    cat > /etc/sysctl.d/k8s.conf <<EOF
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
EOF
    sysctl --system

    # 호스트명 설정
    hostnamectl set-hostname '$vm'
  "
  echo "  ✓ ${vm} 준비 완료"
done
```

---

## 6. containerd 설치

```bash
for vm in "${VMS[@]}"; do
  ip=$(tart ip "$vm")
  echo "=== ${vm} containerd 설치 ==="

  ssh_exec_sudo "$ip" "
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq containerd apt-transport-https ca-certificates curl gnupg conntrack

    mkdir -p /etc/containerd
    containerd config default > /etc/containerd/config.toml
    # SystemdCgroup 활성화 (kubelet과 cgroup 드라이버 일치 필수)
    sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml

    systemctl restart containerd
    systemctl enable containerd
  "
  echo "  ✓ ${vm} containerd 설치 완료"
done
```

**왜 SystemdCgroup = true인가**: kubelet은 기본적으로 systemd cgroup 드라이버를 사용한다. containerd도 동일하게 맞추지 않으면 Pod 생성 시 cgroup 충돌로 CrashLoopBackOff가 발생한다.

---

## 7. kubeadm / kubelet / kubectl 설치

```bash
K8S_VERSION="1.31"

for vm in "${VMS[@]}"; do
  ip=$(tart ip "$vm")
  echo "=== ${vm} kubeadm 설치 ==="

  ssh_exec_sudo "$ip" "
    curl -fsSL https://pkgs.k8s.io/core:/stable:/v${K8S_VERSION}/deb/Release.key | \
      gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg 2>/dev/null

    echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v${K8S_VERSION}/deb/ /' \
      > /etc/apt/sources.list.d/kubernetes.list

    apt-get update -qq
    apt-get install -y -qq kubelet kubeadm kubectl
    apt-mark hold kubelet kubeadm kubectl
    systemctl enable kubelet
  "
  echo "  ✓ ${vm} kubeadm 설치 완료"
done
```

---

## 8. kubeadm으로 클러스터 부트스트랩

### 8.1 Master 노드 초기화

각 클러스터의 master에서 `kubeadm init`을 실행한다.

```bash
# 클러스터별 설정
declare -A POD_CIDR SERVICE_CIDR MASTER_NAMES
POD_CIDR[platform]="10.10.0.0/16"; SERVICE_CIDR[platform]="10.96.0.0/16"; MASTER_NAMES[platform]="platform-master"
POD_CIDR[dev]="10.20.0.0/16";      SERVICE_CIDR[dev]="10.97.0.0/16";      MASTER_NAMES[dev]="dev-master"
POD_CIDR[staging]="10.30.0.0/16";  SERVICE_CIDR[staging]="10.98.0.0/16";  MASTER_NAMES[staging]="staging-master"
POD_CIDR[prod]="10.40.0.0/16";     SERVICE_CIDR[prod]="10.99.0.0/16";     MASTER_NAMES[prod]="prod-master"

# kubeconfig 저장 디렉토리 (devops_dummpy 프로젝트 내)
mkdir -p kubeconfig

for cluster in platform dev staging prod; do
  master="${MASTER_NAMES[$cluster]}"
  master_ip=$(tart ip "$master")
  pod_cidr="${POD_CIDR[$cluster]}"
  svc_cidr="${SERVICE_CIDR[$cluster]}"

  echo "══════════════════════════════════════"
  echo "  ${cluster} 클러스터 초기화"
  echo "  Master: ${master} (${master_ip})"
  echo "  Pod CIDR: ${pod_cidr}"
  echo "  Service CIDR: ${svc_cidr}"
  echo "══════════════════════════════════════"

  # 이전 상태 정리
  ssh_exec_sudo "$master_ip" "
    kubeadm reset -f 2>/dev/null || true
    rm -rf /etc/kubernetes /var/lib/kubelet /var/lib/etcd /etc/cni/net.d
    iptables -F 2>/dev/null || true
    iptables -X 2>/dev/null || true
    iptables -t nat -F 2>/dev/null || true
    systemctl restart containerd
  "

  # kubeadm init
  # --skip-phases=addon/kube-proxy: Cilium이 kube-proxy를 완전히 대체
  ssh_exec_sudo "$master_ip" "
    kubeadm init \
      --pod-network-cidr='${pod_cidr}' \
      --service-cidr='${svc_cidr}' \
      --skip-phases=addon/kube-proxy \
      --apiserver-advertise-address='${master_ip}' \
      --node-name='${master}'
  "

  # kubeconfig 설정 (master VM 내부)
  ssh_exec "$master_ip" "mkdir -p \$HOME/.kube && sudo cp /etc/kubernetes/admin.conf \$HOME/.kube/config && sudo chown \$(id -u):\$(id -g) \$HOME/.kube/config"

  # kubeconfig 로컬로 복사
  sshpass -p admin scp -o StrictHostKeyChecking=no admin@${master_ip}:.kube/config kubeconfig/${cluster}.yaml
  echo "  ✓ ${cluster} kubeconfig 저장: kubeconfig/${cluster}.yaml"
done
```

**왜 `--skip-phases=addon/kube-proxy`인가**: Cilium의 `kubeProxyReplacement: true` 설정은 kube-proxy를 eBPF로 완전히 대체한다. 기존 kube-proxy가 설치되어 있으면 서비스 라우팅이 충돌한다.

### 8.2 Worker 노드 조인

```bash
declare -A WORKERS
WORKERS[platform]="platform-worker1 platform-worker2"
WORKERS[dev]="dev-worker1"
WORKERS[staging]="staging-worker1"
WORKERS[prod]="prod-worker1 prod-worker2"

for cluster in platform dev staging prod; do
  master="${MASTER_NAMES[$cluster]}"
  master_ip=$(tart ip "$master")

  # join 토큰 생성
  join_cmd=$(ssh_exec_sudo "$master_ip" "kubeadm token create --print-join-command")

  for worker in ${WORKERS[$cluster]}; do
    worker_ip=$(tart ip "$worker")
    echo "  ${worker} (${worker_ip}) → ${cluster} 클러스터 조인..."

    # 이전 상태 정리
    ssh_exec_sudo "$worker_ip" "
      kubeadm reset -f 2>/dev/null || true
      rm -rf /etc/kubernetes /var/lib/kubelet /etc/cni/net.d
      iptables -F 2>/dev/null || true
      systemctl restart containerd
    "

    # 조인
    ssh_exec_sudo "$worker_ip" "${join_cmd} --node-name='${worker}'"
    echo "  ✓ ${worker} 조인 완료"
  done
done
```

---

## 9. Cilium CNI 설치

### 9.1 Cilium 설치

```bash
# Cilium Helm 저장소 추가
helm repo add cilium https://helm.cilium.io/
helm repo update

for cluster in platform dev staging prod; do
  master="${MASTER_NAMES[$cluster]}"
  master_ip=$(tart ip "$master")
  pod_cidr="${POD_CIDR[$cluster]}"

  echo "=== ${cluster} Cilium 설치 ==="

  helm upgrade --install cilium cilium/cilium \
    --kubeconfig "kubeconfig/${cluster}.yaml" \
    --namespace kube-system \
    --set kubeProxyReplacement=true \
    --set ipam.mode=cluster-pool \
    --set "ipam.operator.clusterPoolIPv4PodCIDRList={${pod_cidr}}" \
    --set cluster.name="${cluster}" \
    --set k8sServiceHost="${master_ip}" \
    --set k8sServicePort=6443 \
    --set operator.replicas=1 \
    --set resources.requests.cpu=100m \
    --set resources.requests.memory=128Mi \
    --set resources.limits.memory=512Mi \
    --wait --timeout 10m

  echo "  ✓ ${cluster} Cilium 설치 완료"
done
```

**kubeProxyReplacement=true의 의미**: Cilium이 eBPF 프로그램으로 서비스 로드밸런싱(ClusterIP, NodePort, ExternalIP)을 처리한다. iptables 규칙 대비 성능이 높고, 규칙 수가 서비스 수에 비례하지 않는다.

### 9.2 노드 상태 확인

```bash
for cluster in platform dev staging prod; do
  echo "━━━ ${cluster} ━━━"
  kubectl --kubeconfig=kubeconfig/${cluster}.yaml get nodes -o wide
  echo ""
done

# 예상 출력:
# ━━━ dev ━━━
# NAME          STATUS   ROLES           AGE   VERSION    INTERNAL-IP
# dev-master    Ready    control-plane   5m    v1.31.x    192.168.65.x
# dev-worker1   Ready    <none>          3m    v1.31.x    192.168.65.y
```

모든 노드가 `Ready` 상태면 성공이다. `NotReady`라면 Cilium Pod가 아직 기동 중이니 1-2분 기다린다.

```bash
# Cilium Pod 상태 확인
kubectl --kubeconfig=kubeconfig/dev.yaml get pods -n kube-system -l k8s-app=cilium
```

---

## 10. 클러스터 검증

```bash
# 각 클러스터에서 테스트 Pod 실행
for cluster in dev staging prod; do
  echo "=== ${cluster} Pod 테스트 ==="
  kubectl --kubeconfig=kubeconfig/${cluster}.yaml run test-nginx \
    --image=nginx:alpine --restart=Never --rm -it \
    -- wget -qO- --timeout=3 http://kubernetes.default.svc:443 2>&1 | head -3
  echo ""
done
```

---

## 11. 일상적인 VM 관리

### 11.1 VM 기동 (매일 작업 시작 시)

```bash
VMS=(platform-master platform-worker1 platform-worker2 dev-master dev-worker1 staging-master staging-worker1 prod-master prod-worker1 prod-worker2)

for vm in "${VMS[@]}"; do
  tart run "$vm" --no-graphics --net-softnet-allow=0.0.0.0/0 &
  sleep 1
done

# IP 할당 대기
sleep 20

# 클러스터 상태 확인
for cluster in dev staging prod; do
  echo "━━━ ${cluster} ━━━"
  kubectl --kubeconfig=kubeconfig/${cluster}.yaml get nodes
done
```

### 11.2 VM 종료 (작업 종료 시)

```bash
for vm in "${VMS[@]}"; do
  tart stop "$vm" 2>/dev/null
done
```

### 11.3 VM 전체 삭제 (초기화 시)

```bash
for vm in "${VMS[@]}"; do
  tart stop "$vm" 2>/dev/null
  tart delete "$vm" 2>/dev/null
done
```

---

## 12. 트러블슈팅

### 12.1 VM IP가 할당되지 않을 때

```bash
# IP 폴링 (최대 3분)
vm="dev-master"
for i in $(seq 1 60); do
  ip=$(tart ip "$vm" 2>/dev/null)
  if [[ -n "$ip" ]]; then
    echo "${vm}: ${ip}"
    break
  fi
  sleep 3
done
```

### 12.2 kubeadm init 실패

```bash
ip=$(tart ip dev-master)

# containerd 상태 확인
ssh_exec_sudo "$ip" "systemctl status containerd"

# kubelet 로그 확인
ssh_exec_sudo "$ip" "journalctl -u kubelet --no-pager -n 30"

# 흔한 원인: 스왑이 켜져 있음
ssh_exec_sudo "$ip" "swapoff -a"
```

### 12.3 노드가 NotReady

```bash
# Cilium Pod 상태 확인
kubectl --kubeconfig=kubeconfig/dev.yaml get pods -n kube-system -l k8s-app=cilium

# Cilium 로그
kubectl --kubeconfig=kubeconfig/dev.yaml logs -n kube-system -l k8s-app=cilium --tail=20
```

### 12.4 VM 재부팅 후 IP 변경

Tart VM의 IP는 DHCP로 할당되므로 재부팅 시 변경될 수 있다. kubeconfig의 API 서버 주소를 업데이트해야 한다.

```bash
for cluster in platform dev staging prod; do
  master="${cluster}-master"
  new_ip=$(tart ip "$master")
  # kubeconfig의 서버 주소 업데이트
  sed -i '' "s|https://[0-9.]*:6443|https://${new_ip}:6443|" kubeconfig/${cluster}.yaml
  echo "${cluster}: ${new_ip}"
done
```

---

## 다음 편

[03. 5개 언어로 마이크로서비스 개발하기](03-microservice-development.md)에서는 7개 마이크로서비스를 구현한다.
