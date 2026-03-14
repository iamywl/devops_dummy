# 프로젝트 재연 가이드 - 개요

> 이 문서 시리즈를 순서대로 따라가면, 이 프로젝트의 전체 인프라를 직접 구축하고
> 각 단계에서 사용된 기술의 동작 원리를 이해할 수 있다.

---

## 문서 순서

| 순서 | 파일 | 내용 | 소요 시간 |
|------|------|------|----------|
| 00 | `00-overview.md` | 이 문서. 프로젝트 구조와 선행 조건 | 10분 |
| 01 | `01-vm-cluster-setup.md` | Tart VM 생성, kubeadm K8s 클러스터 구성 | 2시간 |
| 02 | `02-container-image-build.md` | 7개 마이크로서비스 Docker 이미지 빌드 | 30분 |
| 03 | `03-kustomize-deploy.md` | Kustomize base/overlay 구조와 배포 | 1시간 |
| 04 | `04-service-architecture.md` | 각 서비스의 내부 구조와 통신 흐름 | 1시간 |
| 05 | `05-autoscaling.md` | HPA, KEDA, PDB 동작 원리와 검증 | 1시간 |
| 06 | `06-monitoring-observability.md` | Prometheus, Grafana, EFK, Scouter 구성 | 1시간 |
| 07 | `07-service-mesh-istio.md` | Istio mTLS, 서킷브레이커, VirtualService | 1시간 |
| 08 | `08-gitops-argocd.md` | ArgoCD App-of-Apps 패턴, sync 정책 | 30분 |
| 09 | `09-loadtest-analysis.md` | k6 부하 테스트 실행과 결과 분석 | 1시간 |

---

## 선행 조건

### 하드웨어

- Apple Silicon Mac (M1/M2/M3/M4)
- RAM: 64 GB 이상 (전체 클러스터 기동 시 108 GB 사용)
- 디스크 여유: 300 GB 이상

### 소프트웨어 설치

```bash
# 패키지 매니저
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# VM 가상화
brew install cirruslabs/cli/tart

# 컨테이너 빌드
brew install docker

# Kubernetes 도구
brew install kubectl helm kustomize

# 부하 테스트
brew install k6

# SSH 자동화 (비밀번호 자동 입력)
brew install esolitos/ipa/sshpass

# 설치 확인
tart --version
kubectl version --client
helm version --short
kustomize version
k6 version
docker --version
```

### 프로젝트 클론

```bash
cd ~/sideproject
git clone <repo-url> devops_dummpy
cd devops_dummpy
```

### 선행 프로젝트 (tart-infra)

이 프로젝트는 `tart-infra` 프로젝트에서 생성한 VM과 K8s 클러스터 위에서 동작한다.
`tart-infra`가 제공하는 것:
- 13개 Tart VM (ARM64 Linux)
- kubeadm으로 구성된 4개 K8s 클러스터
- Cilium CNI (Container Network Interface)
- kubeconfig 파일 (`tart-infra/kubeconfig/dev.yaml` 등)

```bash
# tart-infra가 없으면 먼저 구축
cd ../tart-infra
# tart-infra의 README를 따라 진행
```

---

## 프로젝트 디렉토리 구조 이해

```
devops_dummpy/
├── apps/              # 마이크로서비스 소스코드 (7개, 5개 언어)
├── manifests/         # Kubernetes 매니페스트
│   ├── base/          #   Kustomize 베이스 (환경 공통)
│   ├── overlays/      #   환경별 오버레이 (dev/staging/prod)
│   └── istio/         #   Istio 서비스 메시 설정
├── helm/              # Helm 차트 (대안 배포 방식)
├── argocd/            # ArgoCD Application 정의 (GitOps)
├── loadtest/          # k6 부하 테스트 시나리오
├── monitoring/        # Prometheus/Grafana 설정
├── scripts/           # 자동화 스크립트
└── docs/              # 문서
    └── review/        # 이 재연 가이드
```

각 디렉토리의 역할은 해당 단계의 문서에서 상세히 다룬다.

---

## 클러스터 토폴로지

```
호스트 (Apple Silicon, 128GB)
│
├── platform 클러스터 (7C/24G, 3 nodes)
│   └── 모니터링/관리: Prometheus, Grafana, ArgoCD, Jaeger, Loki, Scouter
│
├── dev 클러스터 (4C/12G, 2 nodes)
│   └── 개발: 단일 레플리카, Istio 활성화, debug 로그
│
├── staging 클러스터 (8C/24G, 3 nodes)
│   └── 스테이징: 2 레플리카, topologySpreadConstraints
│
└── prod 클러스터 (13C/48G, 5 nodes)
    └── 프로덕션: 3 레플리카(base), HPA(max 10), KEDA, PDB, podAntiAffinity
```

다음 문서: [01-vm-cluster-setup.md](01-vm-cluster-setup.md)
