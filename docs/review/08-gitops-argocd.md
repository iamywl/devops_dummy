# 08. ArgoCD GitOps

---

## 이 단계에서 학습하는 기술

| 기술 | 개념 |
|------|------|
| **GitOps** | Git 저장소를 단일 진실 공급원(Single Source of Truth)으로 사용하는 운영 방법론. 클러스터 상태를 Git에 선언하고, 에이전트가 자동 동기화 |
| **ArgoCD** | K8s 전용 GitOps CD 도구. Git 저장소의 매니페스트와 클러스터 상태를 비교(diff)하여 자동 또는 수동 동기화 |
| **App-of-Apps** | ArgoCD 패턴. 하나의 루트 Application이 다른 Application들을 관리. 멀티 환경 배포를 중앙 관리 |
| **Sync Policy** | ArgoCD의 동기화 정책. automated(자동 동기화), manual(수동 승인), self-heal(드리프트 자동 복구) |

---

## 1. GitOps 원칙

### 1.1 선언적 상태 관리

```
전통적 배포:
  개발자 → CI 서버 → kubectl apply → 클러스터
  (push 모델: CI가 클러스터에 직접 접근)

GitOps 배포:
  개발자 → git push → Git 저장소 ← ArgoCD (pull)→ 클러스터
  (pull 모델: ArgoCD가 Git을 주기적으로 확인)
```

**기술 해설 - Push vs Pull 배포 모델**:
- **Push 모델**: CI 파이프라인이 kubectl 명령을 실행하여 클러스터에 직접 배포. CI 서버에 클러스터 접근 권한(kubeconfig)이 필요. CI 서버 침해 시 클러스터도 위험
- **Pull 모델**: ArgoCD가 클러스터 내부에서 실행되며, Git 저장소를 폴링하여 변경 감지. 클러스터 외부에 kubeconfig를 노출하지 않음. 보안상 우수

### 1.2 드리프트 탐지

ArgoCD는 3분마다(기본값) Git의 매니페스트와 클러스터 실제 상태를 비교한다. 누군가 `kubectl edit`으로 직접 수정하면 "OutOfSync" 상태로 표시된다. `self-heal`이 활성화되면 자동으로 Git 상태로 되돌린다.

---

## 2. App-of-Apps 패턴

### 2.1 구조

```
argocd/
├── app-of-apps.yaml       # 루트 Application
│     ↓ manages
├── dev-app.yaml            # dev 환경 Application
├── staging-app.yaml        # staging 환경 Application
└── prod-app.yaml           # prod 환경 Application
```

```yaml
# argocd/app-of-apps.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ecommerce-apps
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/ywlee/devops_dummpy.git
    path: argocd                   # 이 디렉토리의 YAML을 읽어 Application 생성
    targetRevision: main
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

**기술 해설 - App-of-Apps 동작 순서**:
1. `app-of-apps.yaml`을 platform 클러스터에 적용
2. ArgoCD가 `argocd/` 디렉토리를 스캔하여 3개 Application CRD 발견
3. 각 Application이 `manifests/overlays/<env>/`를 소스로 참조
4. ArgoCD가 각 환경의 매니페스트를 해당 클러스터에 동기화

### 2.2 환경별 Application

```yaml
# argocd/dev-app.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ecommerce-dev
spec:
  source:
    repoURL: https://github.com/ywlee/devops_dummpy.git
    path: manifests/overlays/dev
    targetRevision: main
  destination:
    server: https://<dev-master-ip>:6443
    namespace: ecommerce
  syncPolicy:
    automated:                     # dev: 자동 동기화
      prune: true                  # Git에서 삭제된 리소스는 클러스터에서도 삭제
      selfHeal: true               # 수동 변경 자동 복원
```

```yaml
# argocd/prod-app.yaml
spec:
  syncPolicy: {}                   # prod: 수동 동기화 (빈 syncPolicy)
```

**기술 해설 - Sync 정책 차이**:
- **dev (automated + selfHeal)**: Git push 즉시 반영. 개발 속도 우선
- **staging (automated)**: Git push 시 자동 반영하되, 수동 변경은 허용
- **prod (manual)**: ArgoCD UI에서 명시적 Sync 버튼 클릭 필요. 실수 방지

`prune: true`는 Git에서 리소스 정의를 삭제하면 클러스터에서도 해당 리소스를 삭제한다. `false`이면 Git에서 삭제해도 클러스터에 남아있어 좀비 리소스가 된다.

---

## 3. ArgoCD 배포 (실습)

### 3.1 ArgoCD 설치 확인

```bash
export KUBECONFIG=../tart-infra/kubeconfig/platform.yaml

# ArgoCD가 platform 클러스터에 설치되어 있는지 확인
kubectl get pods -n argocd
# 출력:
# argocd-server-xxx       Running
# argocd-repo-server-xxx  Running
# argocd-application-controller-xxx  Running

# 초기 admin 비밀번호 확인
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d
```

### 3.2 App-of-Apps 등록

```bash
# 루트 Application 등록
kubectl apply -f argocd/app-of-apps.yaml

# 등록된 Application 확인
kubectl get applications -n argocd
# 출력:
# NAME              SYNC STATUS   HEALTH STATUS
# ecommerce-apps    Synced        Healthy
# ecommerce-dev     Synced        Healthy
# ecommerce-staging OutOfSync     Missing
# ecommerce-prod    OutOfSync     Missing
```

### 3.3 ArgoCD UI 확인

```bash
PLATFORM_IP=$(tart ip platform-master)
echo "ArgoCD UI: https://${PLATFORM_IP}:30443"
# 계정: admin / (위에서 확인한 비밀번호)

# UI에서 확인할 것:
# 1. 앱 트리 구조 (App-of-Apps → 3개 환경)
# 2. 각 앱의 Sync Status
# 3. 리소스 다이어그램 (Deployment → ReplicaSet → Pod)
# 4. diff 뷰 (Git vs Live)
```

### 3.4 GitOps 워크플로우 확인

```bash
# 1. 코드 변경 (예: replicas 변경)
vim manifests/overlays/dev/resource-patches.yaml
# replicas: 1 → replicas: 2

# 2. Git push
git add . && git commit -m "dev replicas 2로 변경" && git push

# 3. ArgoCD 감지 (최대 3분 대기, 또는 UI에서 Refresh)
# dev-app의 상태가 OutOfSync → Synced로 변경됨

# 4. 클러스터에서 확인
kubectl --kubeconfig=../tart-infra/kubeconfig/dev.yaml get pods -n ecommerce
# → 각 서비스의 Pod가 2개로 증가
```

---

## 4. ArgoCD 내부 동작

### 4.1 동기화 프로세스

```
[Git Repository]
       ↓ 3분마다 폴링 (또는 webhook)
[argocd-repo-server]
       ↓ kustomize build / helm template 실행
       ↓ 렌더링된 매니페스트 생성
[argocd-application-controller]
       ↓ 렌더링 결과와 클러스터 Live 상태 비교
       ↓ diff 계산
       ├── Synced: 차이 없음
       └── OutOfSync: 차이 있음
              ↓ (automated sync 또는 수동 sync)
       [kubectl apply] → 클러스터에 반영
```

**기술 해설 - argocd-repo-server**:
repo-server는 Git 저장소를 클론하고, Kustomize/Helm/plain YAML을 렌더링하는 역할이다. 보안을 위해 격리된 환경에서 실행되며, 클러스터 접근 권한이 없다. 렌더링 결과만 application-controller에 전달한다.

---

## 5. 이 단계에서 확인할 것

- [ ] ArgoCD UI에 접속 가능한가
- [ ] App-of-Apps 등록 후 3개 Application이 생성되는가
- [ ] Git push 후 dev 환경에 자동 반영되는가
- [ ] 클러스터에서 `kubectl edit`으로 수정 후 selfHeal이 동작하는가
- [ ] prod Application은 수동 Sync만 가능한가

다음 문서: [09-loadtest-analysis.md](09-loadtest-analysis.md)
