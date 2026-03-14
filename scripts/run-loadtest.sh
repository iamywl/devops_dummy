#!/usr/bin/env bash
# Run k6 load test scenario
source "$(dirname "$0")/lib/common.sh"

SCENARIO="${1:-smoke}"
CLUSTER="${2:-dev}"
K6_DIR="${PROJECT_ROOT}/loadtest/k6"
RESULTS_DIR="${PROJECT_ROOT}/loadtest/results"

VALID_SCENARIOS=("smoke" "average-load" "peak-load" "stress-test" "soak-test")
if [[ ! " ${VALID_SCENARIOS[*]} " =~ " ${SCENARIO} " ]]; then
  log_error "Invalid scenario: $SCENARIO"
  log_info "Valid scenarios: ${VALID_SCENARIOS[*]}"
  exit 1
fi

SCENARIO_FILE="${K6_DIR}/scenarios/${SCENARIO}.js"
if [[ ! -f "$SCENARIO_FILE" ]]; then
  log_error "Scenario file not found: $SCENARIO_FILE"
  exit 1
fi

# Get target URL
MASTER_IP=$(tart ip "${CLUSTER}-master" 2>/dev/null || echo "localhost")
BASE_URL="http://${MASTER_IP}:30080"

log_step "Running k6 ${SCENARIO} test against ${BASE_URL}..."

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RESULT_FILE="${RESULTS_DIR}/${SCENARIO}_${TIMESTAMP}.json"

k6 run \
  -e BASE_URL="${BASE_URL}" \
  --out json="${RESULT_FILE}" \
  --summary-trend-stats="min,avg,med,max,p(90),p(95),p(99)" \
  "$SCENARIO_FILE"

log_step "Results saved to: ${RESULT_FILE}"
