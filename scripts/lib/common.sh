#!/usr/bin/env bash
# Common utilities for devops_dummpy scripts
set -euo pipefail

# ─── Paths ───
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TART_INFRA_ROOT="$(cd "$PROJECT_ROOT/../tart-infra" && pwd)"
KUBECONFIG_DIR="${TART_INFRA_ROOT}/kubeconfig"

# ─── Colors ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ─── Logging ───
log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
log_step()  { echo -e "${CYAN}[STEP]${NC}  $*"; }

# ─── Cluster helpers ───
CLUSTERS=("dev" "staging" "prod")

kubectl_cmd() {
  local cluster="$1"
  shift
  local kubeconfig="${KUBECONFIG_DIR}/${cluster}.yaml"
  if [[ ! -f "$kubeconfig" ]]; then
    log_error "Kubeconfig not found: $kubeconfig"
    return 1
  fi
  kubectl --kubeconfig="$kubeconfig" "$@"
}

helm_cmd() {
  local cluster="$1"
  shift
  local kubeconfig="${KUBECONFIG_DIR}/${cluster}.yaml"
  helm --kubeconfig="$kubeconfig" "$@"
}

# ─── SSH helpers (reuse tart-infra pattern) ───
ssh_exec() {
  local vm_name="$1"
  shift
  local ip
  ip=$(tart ip "$vm_name" 2>/dev/null || echo "")
  if [[ -z "$ip" ]]; then
    log_error "Cannot get IP for VM: $vm_name"
    return 1
  fi
  sshpass -p admin ssh -o StrictHostKeyChecking=no admin@"$ip" "$@"
}

# ─── Wait for pods ───
wait_for_pods() {
  local cluster="$1"
  local namespace="${2:-ecommerce}"
  local timeout="${3:-300}"

  log_info "Waiting for pods in $cluster/$namespace (timeout: ${timeout}s)..."
  kubectl_cmd "$cluster" wait --for=condition=Ready pods \
    --all -n "$namespace" --timeout="${timeout}s" 2>/dev/null || {
    log_warn "Some pods not ready in $cluster/$namespace"
    kubectl_cmd "$cluster" get pods -n "$namespace"
    return 1
  }
  log_info "All pods ready in $cluster/$namespace"
}
