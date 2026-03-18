# 09. ArgoCD GitOps: App-of-Apps 패턴으로 배포 자동화

## 핵심 요약

ArgoCD를 설치하고 App-of-Apps 패턴으로 3개 환경(dev/staging/prod)의 배포를 자동화한다. dev는 Git push 시 자동 배포, staging/prod는 수동 승인 후 배포한다.

---

## 1. GitOps란

### 1.1 기존 배포 vs GitOps

```
기존 방식 (Push 기반):
  개발자 → CI 파이프라인 → kubectl apply → K8s 클러스터
  문제: 누가 언제 무엇을 배포했는지 추적 어려움
       클러스터 상태와 Git 상태가 다를 수 있음 (drift)

GitOps (Pull 기반):
  개발자 → Git push → ArgoCD가 감지 → Git과 클러스터 상태 비교 → 자동 동기화
  장점: Git이 단일 진실 소스 (Single Source of Truth)
       모든 변경 이력이 Git에 남음
       클러스터 상태가 항상 Git과 일치
```

### 1.2 ArgoCD 동작 원리

```
ArgoCD 컨트롤 루프 (매 3분):

1. Git 저장소 poll (또는 webhook으로 즉시 감지)
2. Git의 manifests/overlays/{env}/ 내용 읽기
3. Kustomize build 실행 → 원하는 상태(Desired State) 생성
4. 클러스터의 현재 상태(Live State) 조회
5. Desired vs Live 비교 (diff)
6. syncPolicy에 따라:
   ├── automated: 자동으로 kubectl apply
   └── manual: UI에서 Sync 버튼 대기
7. Health Check (Pod Ready, Deployment Rollout 완료 등)
```

---

## 2. ArgoCD 설치

```bash
cd ~/devops_dummpy  # 프로젝트 루트 경로로 이동

# platform 클러스터에 ArgoCD 설치
kubectl --kubeconfig=kubeconfig/platform.yaml \
  create namespace argocd

kubectl --kubeconfig=kubeconfig/platform.yaml \
  apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# Pod가 모두 Running이 될 때까지 대기
kubectl --kubeconfig=kubeconfig/platform.yaml \
  wait --for=condition=Ready pod --all -n argocd --timeout=300s

# ArgoCD 서버를 NodePort로 노출
kubectl --kubeconfig=kubeconfig/platform.yaml \
  patch svc argocd-server -n argocd \
  -p '{"spec": {"type": "NodePort", "ports": [{"port": 443, "nodePort": 30443}]}}'

# 초기 비밀번호 확인
ARGOCD_PW=$(kubectl --kubeconfig=kubeconfig/platform.yaml \
  -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d)

PLATFORM_IP=$(tart ip platform-master)
echo "ArgoCD UI: https://${PLATFORM_IP}:30443"
echo "Username: admin"
echo "Password: ${ARGOCD_PW}"
```

---

## 3. App-of-Apps 패턴

### 3.1 왜 App-of-Apps인가

```
개별 Application 등록:
  argocd app create dev-ecommerce --repo ... --path manifests/overlays/dev
  argocd app create staging-ecommerce --repo ... --path manifests/overlays/staging
  argocd app create prod-ecommerce --repo ... --path manifests/overlays/prod
  → 3개를 각각 관리해야 함. 환경 추가 시 수동 등록 필요.

App-of-Apps:
  argocd app create ecommerce-apps --repo ... --path argocd/
  → 루트 Application 1개만 등록. argocd/ 디렉토리의 YAML이 하위 Application을 자동 생성.
  → 환경 추가 시 argocd/에 YAML 하나만 추가하면 됨.
```

### 3.2 매니페스트 구조

**argocd/app-of-apps.yaml** (루트):

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ecommerce-apps
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/YOUR_GITHUB_ID/devops_dummpy.git  # ← 본인 저장소로 변경
    targetRevision: main
    path: argocd        # 이 디렉토리의 YAML들을 하위 Application으로 생성
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated:
      prune: true       # Git에서 삭제된 리소스를 클러스터에서도 삭제
      selfHeal: true    # 수동 변경을 감지하고 Git 상태로 복구
```

> `repoURL`은 본인의 GitHub 저장소 URL로 변경해야 한다. 이 저장소를 fork하거나 push한 주소를 사용한다.

**argocd/dev-app.yaml**:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ecommerce-dev           # ← 실제 파일명과 일치
  namespace: argocd
  labels:
    app.kubernetes.io/part-of: devops-ecommerce
    environment: dev
spec:
  project: default
  source:
    repoURL: https://github.com/YOUR_GITHUB_ID/devops_dummpy.git  # ← 본인 저장소
    targetRevision: HEAD
    path: manifests/overlays/dev
  destination:
    name: dev-cluster            # argocd cluster add로 등록한 이름
    namespace: ecommerce
  syncPolicy:
    automated:                   # dev는 자동 동기화
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

**argocd/prod-app.yaml**:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ecommerce-prod           # ← 실제 파일명과 일치
  namespace: argocd
  labels:
    app.kubernetes.io/part-of: devops-ecommerce
    environment: prod
spec:
  project: default
  source:
    repoURL: https://github.com/YOUR_GITHUB_ID/devops_dummpy.git  # ← 본인 저장소
    targetRevision: HEAD
    path: manifests/overlays/prod
  destination:
    name: prod-cluster           # argocd cluster add로 등록한 이름
    namespace: ecommerce
  syncPolicy:                    # prod는 수동 동기화 (automated 없음)
    syncOptions:
      - CreateNamespace=true
```

### 3.3 repoURL과 destination.server 설정 방법

```bash
# 1. GitHub 저장소 URL 확인 (본인이 push한 원격 저장소)
git remote -v
# origin  https://github.com/YOUR_GITHUB_ID/devops_dummpy.git

# 2. 각 클러스터 API server IP 확인
for ENV in dev staging prod; do
  IP=$(tart ip ${ENV}-master)
  echo "${ENV}: https://${IP}:6443"
done

# 3. argocd/ 디렉토리의 YAML 파일에서 repoURL과 server를 실제 값으로 치환
# 예시 (sed로 일괄 치환):
REPO_URL=$(git remote get-url origin)
sed -i '' "s|https://github.com/YOUR_GITHUB_ID/devops_dummpy.git|${REPO_URL}|g" argocd/*.yaml

DEV_IP=$(tart ip dev-master)
sed -i '' "s|DEV_MASTER_IP|${DEV_IP}|g" argocd/dev-app.yaml

PROD_IP=$(tart ip prod-master)
sed -i '' "s|PROD_MASTER_IP|${PROD_IP}|g" argocd/prod-app.yaml

STAGING_IP=$(tart ip staging-master)
sed -i '' "s|STAGING_MASTER_IP|${STAGING_IP}|g" argocd/staging-app.yaml
```

### 3.3 배포 흐름

```
Git push (manifests/overlays/dev/ 변경)
    │
    ▼
ArgoCD가 감지 (3분 이내 또는 webhook 즉시)
    │
    ├── ecommerce-dev: automated → 자동 동기화
    │
    ├── ecommerce-staging: 수동 → ArgoCD UI에서 "OutOfSync" 표시
    │   └── 담당자가 Sync 버튼 클릭 → 동기화
    │
    └── ecommerce-prod: 수동 → ArgoCD UI에서 "OutOfSync" 표시
        └── 담당자가 Sync 버튼 클릭 → 동기화
```

---

## 4. 멀티클러스터 연결

ArgoCD(platform 클러스터)에서 다른 클러스터에 배포하려면 클러스터 등록이 필요하다.

```bash
# ArgoCD CLI 설치
brew install argocd

# ArgoCD 로그인
PLATFORM_IP=$(tart ip platform-master)
argocd login ${PLATFORM_IP}:30443 \
  --username admin \
  --password "${ARGOCD_PW}" \
  --insecure

# 앱 클러스터 등록 (kubeconfig의 context 이름을 확인하여 사용)
# kubeconfig에 context가 하나면 자동 선택됨
argocd cluster add kubernetes-admin@kubernetes \
  --kubeconfig=kubeconfig/dev.yaml \
  --name dev-cluster -y

argocd cluster add kubernetes-admin@kubernetes \
  --kubeconfig=kubeconfig/staging.yaml \
  --name staging-cluster -y

argocd cluster add kubernetes-admin@kubernetes \
  --kubeconfig=kubeconfig/prod.yaml \
  --name prod-cluster -y

# 등록 확인
argocd cluster list
# 예상 출력:
# SERVER                          NAME             STATUS
# https://in-cluster              in-cluster       Successful
# https://192.168.64.x:6443       dev-cluster      Successful
# https://192.168.64.x:6443       staging-cluster  Successful
# https://192.168.64.x:6443       prod-cluster     Successful
```

> `kubernetes-admin@kubernetes`는 kubeadm으로 생성한 클러스터의 기본 context 이름이다.
> `kubectl --kubeconfig=kubeconfig/dev.yaml config get-contexts`로 확인할 수 있다.

---

## 5. App-of-Apps 적용

```bash
# 루트 Application 생성
kubectl --kubeconfig=kubeconfig/platform.yaml \
  apply -f argocd/app-of-apps.yaml

# ArgoCD UI에서 확인:
# ecommerce-apps (루트)
#   ├── ecommerce-dev (Synced, Healthy)
#   ├── ecommerce-staging (OutOfSync)
#   └── ecommerce-prod (OutOfSync)
```

---

## 6. selfHeal 동작 확인

```bash
# 수동으로 dev에서 Pod를 삭제해보기
kubectl --kubeconfig=kubeconfig/dev.yaml \
  delete pod -n ecommerce -l app=order-service

# ArgoCD가 감지하고 자동 복구:
# "Syncing: selfHeal triggered"
# → Deployment가 새 Pod를 생성
```

---

## 다음 편

[10. k6 부하 테스트로 MAU 1천만 시뮬레이션하기](10-loadtest-analysis.md)에서는 실제 트래픽을 발생시켜 시스템의 한계를 확인한다.
