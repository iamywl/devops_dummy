# 01. VM 생성과 K8s 클러스터 구성

---

## 이 단계에서 학습하는 기술

| 기술 | 개념 |
|------|------|
| **Tart** | Apple Virtualization Framework 기반 VM 관리 도구. QEMU와 달리 macOS 하이퍼바이저를 직접 사용하여 near-native 성능 제공 |
| **kubeadm** | Kubernetes 공식 클러스터 부트스트래핑 도구. control plane 컴포넌트(API Server, etcd, scheduler, controller-manager)를 초기화 |
| **Cilium** | eBPF 기반 CNI 플러그인. 커널 레벨에서 패킷 필터링/라우팅을 수행하므로 iptables 기반 CNI보다 처리량이 높음 |
| **etcd** | 분산 키-값 저장소. K8s의 모든 클러스터 상태(Pod, Service, ConfigMap 등)를 저장. Raft 합의 알고리즘으로 일관성 보장 |

---

## 1. Tart VM 생성

### 1.1 베이스 이미지 생성

```bash
# Ubuntu 22.04 ARM64 이미지를 Tart에 등록
tart create --from-ipsw none ubuntu-base
# 또는 미리 만들어진 이미지 사용
tart clone ghcr.io/cirruslabs/ubuntu:latest ubuntu-base

# 베이스 이미지 설정 (SSH 접속 가능하도록)
tart run ubuntu-base
# VM 내부에서:
#   sudo apt update && sudo apt install -y openssh-server curl
#   sudo systemctl enable ssh
#   exit
```

### 1.2 클러스터 VM 생성 (13개)

```bash
# platform 클러스터 (3 nodes)
tart clone ubuntu-base platform-master
tart set platform-master --cpu 2 --memory 4096 --disk-size 20
tart clone ubuntu-base platform-worker1
tart set platform-worker1 --cpu 3 --memory 12288 --disk-size 20
tart clone ubuntu-base platform-worker2
tart set platform-worker2 --cpu 2 --memory 8192 --disk-size 20

# dev 클러스터 (2 nodes)
tart clone ubuntu-base dev-master
tart set dev-master --cpu 2 --memory 4096 --disk-size 20
tart clone ubuntu-base dev-worker1
tart set dev-worker1 --cpu 2 --memory 8192 --disk-size 20

# staging 클러스터 (3 nodes)
tart clone ubuntu-base staging-master
tart set staging-master --cpu 2 --memory 4096 --disk-size 20
tart clone ubuntu-base staging-worker1
tart set staging-worker1 --cpu 3 --memory 10240 --disk-size 20
tart clone ubuntu-base staging-worker2
tart set staging-worker2 --cpu 3 --memory 10240 --disk-size 20

# prod 클러스터 (5 nodes)
tart clone ubuntu-base prod-master
tart set prod-master --cpu 2 --memory 4096 --disk-size 20
tart clone ubuntu-base prod-worker1
tart set prod-worker1 --cpu 3 --memory 12288 --disk-size 20
tart clone ubuntu-base prod-worker2
tart set prod-worker2 --cpu 3 --memory 12288 --disk-size 20
tart clone ubuntu-base prod-worker3
tart set prod-worker3 --cpu 3 --memory 12288 --disk-size 20
tart clone ubuntu-base prod-worker4
tart set prod-worker4 --cpu 2 --memory 8192 --disk-size 20
```

### 1.3 VM 기동 및 IP 확인

```bash
# 전체 VM 기동
for vm in platform-master platform-worker1 platform-worker2 \
          dev-master dev-worker1 \
          staging-master staging-worker1 staging-worker2 \
          prod-master prod-worker1 prod-worker2 prod-worker3 prod-worker4; do
  tart start "$vm" &
done
wait

# IP 확인 (DHCP 할당까지 10-30초 소요)
sleep 15
tart list
```

**동작 원리**: Tart는 macOS의 Virtualization.framework를 사용하여 ARM64 Linux VM을 실행한다. 각 VM은 호스트의 NAT 네트워크에 연결되며, DHCP로 IP를 할당받는다. VM 간 통신은 호스트 내부 네트워크를 통해 이루어진다.

---

## 2. K8s 클러스터 구성 (kubeadm)

### 2.1 각 노드에 컨테이너 런타임 설치

```bash
# 모든 VM에 SSH 접속하여 실행
# (tart-infra의 스크립트가 자동화하지만, 수동 재연 시 아래 순서)

VM_IP=$(tart ip dev-master)
ssh admin@${VM_IP}

# containerd 설치 (CRI 호환 컨테이너 런타임)
sudo apt-get update
sudo apt-get install -y containerd

# containerd 설정 생성
sudo mkdir -p /etc/containerd
containerd config default | sudo tee /etc/containerd/config.toml
# SystemdCgroup = true 로 변경 (kubelet과 cgroup 드라이버 일치 필요)
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
sudo systemctl restart containerd
```

**기술 해설 - CRI (Container Runtime Interface)**:
K8s는 1.24부터 Docker를 직접 지원하지 않는다. 대신 CRI 규격을 구현한 런타임(containerd, CRI-O)을 사용한다. containerd는 Docker에서 분리된 경량 런타임으로, 이미지 pull, 컨테이너 생성/삭제, 네임스페이스 격리를 담당한다.

**기술 해설 - cgroup 드라이버**:
Linux의 cgroup(control group)은 프로세스 그룹의 CPU/메모리 사용량을 제한한다. kubelet과 containerd가 같은 cgroup 드라이버(systemd 또는 cgroupfs)를 사용해야 한다. 불일치 시 Pod가 정상 스케줄되지 않는다.

### 2.2 kubeadm, kubelet, kubectl 설치

```bash
# 모든 노드에서 실행
sudo apt-get install -y apt-transport-https ca-certificates curl gpg

# K8s 패키지 저장소 등록
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.29/deb/Release.key | \
  sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.29/deb/ /' | \
  sudo tee /etc/apt/sources.list.d/kubernetes.list

sudo apt-get update
sudo apt-get install -y kubelet kubeadm kubectl
sudo apt-mark hold kubelet kubeadm kubectl

# swap 비활성화 (kubelet 요구사항)
sudo swapoff -a
sudo sed -i '/ swap / s/^/#/' /etc/fstab

# 커널 모듈 로드 (네트워킹)
cat <<EOF | sudo tee /etc/modules-load.d/k8s.conf
overlay
br_netfilter
EOF
sudo modprobe overlay
sudo modprobe br_netfilter

# sysctl 파라미터 설정
cat <<EOF | sudo tee /etc/sysctl.d/k8s.conf
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
EOF
sudo sysctl --system
```

**기술 해설 - swap 비활성화**:
kubelet은 기본적으로 swap이 활성화된 노드에서 실행을 거부한다. swap은 디스크를 가상 메모리로 사용하는 기능인데, 컨테이너의 메모리 제한(resource limits)이 정확히 동작하려면 물리 메모리만 사용해야 한다. swap 사용 시 OOMKilled 판정이 지연되어 노드 전체의 성능 저하를 유발할 수 있다.

**기술 해설 - br_netfilter**:
Linux bridge를 통과하는 패킷이 iptables 규칙을 적용받도록 하는 커널 모듈이다. K8s Service의 ClusterIP 라우팅은 iptables(또는 IPVS) 규칙으로 구현되므로, bridge 트래픽에도 이 규칙이 적용되어야 Pod 간 통신이 정상 동작한다.

### 2.3 Control Plane 초기화 (마스터 노드)

```bash
# dev-master에서 실행
sudo kubeadm init \
  --pod-network-cidr=10.244.0.0/16 \
  --service-cidr=10.96.0.0/12 \
  --apiserver-advertise-address=$(hostname -I | awk '{print $1}')

# kubeconfig 복사
mkdir -p $HOME/.kube
sudo cp /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
```

**기술 해설 - kubeadm init가 수행하는 작업**:
1. **인증서 생성**: CA, API Server, kubelet 등의 TLS 인증서를 `/etc/kubernetes/pki/`에 생성
2. **etcd 기동**: 클러스터 상태 저장소. 단일 마스터에서는 로컬 etcd를 static pod로 실행
3. **API Server 기동**: REST API 엔드포인트. 모든 kubectl 명령은 이 서버를 통해 처리
4. **Controller Manager 기동**: Deployment, ReplicaSet 등의 컨트롤러 루프 실행
5. **Scheduler 기동**: Pod를 노드에 배치하는 스케줄링 결정

`--pod-network-cidr`은 Pod에 할당할 IP 대역이다. CNI 플러그인(Cilium)이 이 대역을 사용하여 각 노드에 서브넷을 할당한다.

### 2.4 CNI 설치 (Cilium)

```bash
# Cilium CLI 설치
CILIUM_CLI_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)
curl -L --fail --remote-name-all \
  https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-arm64.tar.gz
sudo tar xzvf cilium-linux-arm64.tar.gz -C /usr/local/bin
rm cilium-linux-arm64.tar.gz

# Cilium 설치
cilium install

# 상태 확인
cilium status --wait
```

**기술 해설 - CNI (Container Network Interface)**:
CNI는 컨테이너 네트워킹의 표준 인터페이스이다. K8s는 CNI 플러그인 없이는 Pod 간 통신이 불가능하다. Cilium은 eBPF(extended Berkeley Packet Filter)를 사용하여 커널 내에서 직접 패킷을 처리한다.

기존 CNI(Flannel, Calico)는 iptables 규칙을 생성하여 패킷을 라우팅한다. 서비스 수가 증가하면 iptables 규칙도 선형적으로 증가하여 성능이 저하된다. Cilium은 eBPF 프로그램을 커널에 로드하여 O(1) 복잡도로 패킷을 처리한다.

### 2.5 워커 노드 조인

```bash
# 마스터에서 조인 토큰 생성
kubeadm token create --print-join-command
# 출력 예: kubeadm join 192.168.64.x:6443 --token xxx --discovery-token-ca-cert-hash sha256:yyy

# 각 워커 노드에서 조인 명령 실행
ssh admin@$(tart ip dev-worker1)
sudo kubeadm join 192.168.64.x:6443 --token xxx --discovery-token-ca-cert-hash sha256:yyy
```

### 2.6 클러스터 확인

```bash
# 마스터에서 확인
kubectl get nodes -o wide
# 출력 예:
# NAME          STATUS   ROLES           AGE   VERSION   INTERNAL-IP
# dev-master    Ready    control-plane   5m    v1.29.x   192.168.64.2
# dev-worker1   Ready    <none>          3m    v1.29.x   192.168.64.3
```

**기술 해설 - 노드 상태**:
`STATUS: Ready`는 kubelet이 API Server에 정상적으로 heartbeat를 보내고 있음을 의미한다. kubelet은 기본 10초 간격으로 NodeStatus를 업데이트한다. 40초 동안 heartbeat가 없으면 `NotReady`로 전환되고, controller-manager가 해당 노드의 Pod를 다른 노드로 재스케줄한다.

---

## 3. 4개 클러스터 모두 구성

위 과정을 platform, dev, staging, prod 4개 클러스터에 대해 반복한다.

```bash
# kubeconfig 파일 관리
mkdir -p ../tart-infra/kubeconfig/
# 각 클러스터 마스터에서 admin.conf를 복사
scp admin@$(tart ip platform-master):.kube/config ../tart-infra/kubeconfig/platform.yaml
scp admin@$(tart ip dev-master):.kube/config ../tart-infra/kubeconfig/dev.yaml
scp admin@$(tart ip staging-master):.kube/config ../tart-infra/kubeconfig/staging.yaml
scp admin@$(tart ip prod-master):.kube/config ../tart-infra/kubeconfig/prod.yaml
```

### 확인 명령

```bash
# 각 클러스터의 노드 상태 확인
for cluster in platform dev staging prod; do
  echo "=== ${cluster} ==="
  kubectl --kubeconfig=../tart-infra/kubeconfig/${cluster}.yaml get nodes
done
```

---

## 4. 이 단계에서 확인할 것

- [ ] `tart list`에 13개 VM이 모두 running 상태인가
- [ ] 각 클러스터의 `kubectl get nodes`에서 모든 노드가 Ready인가
- [ ] `cilium status`에서 Cilium이 OK인가
- [ ] VM 간 ping이 가능한가 (`tart ip` 확인 후 ping)

다음 문서: [02-container-image-build.md](02-container-image-build.md)
