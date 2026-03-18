# MAU 1천만 E-Commerce Platform 구현 가이드

이 블로그 시리즈는 MAU 1천만 규모 e-commerce 플랫폼을 **처음부터 끝까지 직접 구현**하는 과정을 다룬다.

모든 명령어는 **복사-붙여넣기**만으로 실행할 수 있도록 작성되어 있다.

## 블로그 목차

| 편 | 제목 | 핵심 내용 | 소요 시간 |
|----|------|----------|----------|
| [01](01-project-design.md) | 프로젝트 설계 | 트래픽 산출, 아키텍처 설계, 기술 선택 | 1시간 |
| [02](02-tart-vm-kubernetes.md) | Tart VM + K8s 클러스터 구축 | VM 10대 생성, kubeadm, Cilium CNI | 3-4시간 |
| [03](03-microservice-development.md) | 5개 언어 마이크로서비스 개발 | Java/Node.js/Go/Python/Rust 구현 | 5-6시간 |
| [04](04-container-build-deploy.md) | Docker 빌드 + K8s 배포 | ARM64 이미지, containerd 로드, Kustomize | 2-3시간 |
| [05](05-data-tier-messaging.md) | DB 3종 + RabbitMQ | PostgreSQL, MongoDB, Redis, MQ | 2시간 |
| [06](06-autoscaling.md) | HPA + KEDA 오토스케일링 | CPU/큐 기반 스케일링, PDB | 2시간 |
| [07](07-service-mesh-istio.md) | Istio 서비스 메시 | 서킷브레이커, mTLS, 재시도 | 2시간 |
| [08](08-monitoring-observability.md) | 모니터링 + 로그 수집 | Prometheus, Grafana, EFK | 2-3시간 |
| [09](09-gitops-argocd.md) | ArgoCD GitOps | App-of-Apps, 자동/수동 배포 | 1-2시간 |
| [10](10-loadtest-analysis.md) | k6 부하 테스트 | 5단계 시나리오, 결과 분석 | 2-3시간 |

## 사전 요구사항

### 하드웨어
- Apple Silicon Mac (M1 이상)
- RAM 64GB 이상 (128GB 권장)
- 디스크 여유 300GB 이상

### 소프트웨어 설치

```bash
# VM 가상화
brew install cirruslabs/cli/tart

# K8s 도구
brew install kubectl helm kustomize jq

# Docker (이미지 빌드)
brew install docker

# VM SSH 자동화
brew install esolitos/ipa/sshpass

# 부하 테스트
brew install k6

# 확인
tart --version && kubectl version --client && helm version --short && k6 version
```

### 기본 지식
- Linux 기본 명령어 (ssh, apt, systemctl)
- Docker 기초 (Dockerfile, build, save)
- Kubernetes 기초 개념 (Pod, Deployment, Service, Namespace)

### 핵심 개념 미리 알기

이 시리즈에서 반복 등장하는 핵심 개념:

| 용어 | 한 줄 설명 |
|------|-----------|
| **Tart** | Apple Silicon Mac 전용 가상화 CLI. VM을 생성하고 관리한다. |
| **kubeconfig** | kubectl이 K8s 클러스터에 접속하기 위한 인증 파일. 02편에서 생성하여 `kubeconfig/` 디렉토리에 저장한다. |
| **Kustomize** | K8s 매니페스트를 환경별(dev/staging/prod)로 분리 관리하는 도구. base + overlay 패턴을 사용한다. |
| **HPA** | Horizontal Pod Autoscaler. CPU/메모리 사용률에 따라 Pod 수를 자동 조절한다. |
| **KEDA** | 외부 이벤트(MQ 큐 깊이 등)를 기반으로 Pod를 스케일링하는 오퍼레이터. |
| **ServiceMonitor** | Prometheus Operator가 제공하는 CRD. 모니터링 대상을 선언적으로 등록한다. |
| **CRD** | Custom Resource Definition. K8s 기본 리소스 외에 사용자가 정의한 리소스 타입. |

> **중요**: 02편에서 Tart VM과 K8s 클러스터를 구축하면 `kubeconfig/` 디렉토리에 클러스터별 인증 파일이 생성된다. 이후 모든 편의 `kubectl --kubeconfig=kubeconfig/{클러스터}.yaml` 명령어는 이 파일을 사용한다.

## 전체 재현 흐름

```
01편: 설계 문서 작성, 디렉토리 구조 생성
  ↓
02편: Tart VM 10대 생성 → kubeadm 4클러스터 → Cilium CNI
  ↓
03편: 7개 마이크로서비스 소스코드 작성
  ↓
04편: Docker 빌드 → containerd 로드 → Kustomize 배포 → API 동작 확인
  ↓
05편: PostgreSQL/MongoDB/Redis/RabbitMQ 설정 이해
  ↓
06편: KEDA 설치 → prod 배포 → HPA 스케일아웃 관찰
  ↓
07편: Istio 설치 → 서킷브레이커/mTLS 적용
  ↓
08편: ServiceMonitor 설정 → Grafana 대시보드 → 알림 규칙
  ↓
09편: ArgoCD App-of-Apps 등록 → Git push 자동 배포 확인
  ↓
10편: k6 smoke → average → peak → stress → soak 순차 실행
```

## 소요 시간

전체를 처음부터 따라하면 약 **25-30시간** 소요된다.
환경 구축(02편)이 가장 오래 걸리며, 이미 VM이 준비되어 있다면 절반으로 줄어든다.
