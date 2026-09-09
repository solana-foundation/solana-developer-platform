#!/usr/bin/env bash
# Ephemeral per-PR API environments on dev (PRO-1767).
#
#   ephemeral-env.sh deploy <pr-number> <image>
#   ephemeral-env.sh teardown <pr-number>
#
# deploy clones the dev migrate job and the dev API/worker services into
# per-PR copies that share dev's secrets but land on their own database
# (EPHEMERAL_DB_NAME) and redis keyspace (EPHEMERAL_REDIS_DB). teardown
# drops the database, flushes the redis db, and deletes the clones.
set -euo pipefail

PROJECT="${PROJECT_ID:-solana-developer-platform-dev}"
REGION="${REGION:-us-central1}"
BASE_API_SERVICE="sdp-dev-api-public"
BASE_WORKER_SERVICE="sdp-dev-worker"
BASE_MIGRATE_JOB="sdp-dev-api-public-migrate"

cmd="${1:?usage: ephemeral-env.sh <deploy|teardown> <pr-number> [image]}"
pr="${2:?pr number is required}"
[[ "${pr}" =~ ^[0-9]+$ ]] || { echo "pr number must be numeric" >&2; exit 1; }

api_service="sdp-dev-api-pr-${pr}"
worker_service="sdp-dev-worker-pr-${pr}"
db_job="sdp-dev-api-pr-${pr}-db"
db_name="sdp_api_pr_${pr}"

run() { gcloud run "$@" --project "${PROJECT}" --region "${REGION}"; }

list_redis_claims() { # prints "<pr> <db>" for every labeled job and service
  local kind
  for kind in jobs services; do
    run "${kind}" list --filter 'metadata.labels.sdp-ephemeral-redis-db:*' \
      --format 'value(metadata.labels.sdp-ephemeral-pr,metadata.labels.sdp-ephemeral-redis-db)'
  done
}

# On a same-second race two PRs could pick the same slot; the offset scan makes
# that need pr1 ≡ pr2 (mod 15), and verify_redis_claim (lower PR wins) turns the
# residue into a loud failure whose rerun converges on a free slot.
redis_db_taken() { # <claims> <db> — taken by a PR that outranks us?
  awk -v pr="${pr}" -v db="$2" '$2 == db && $1 != pr && $1 < pr { found = 1 } END { exit !found }' <<<"$1"
}

allocate_redis_db() {
  local claims own db i
  claims="$(list_redis_claims)"
  own="$(run jobs describe "${db_job}" \
    --format 'value(metadata.labels.sdp-ephemeral-redis-db)' 2>/dev/null || true)"
  if [[ -n "${own}" ]] && ! redis_db_taken "${claims}" "${own}"; then
    echo "${own}"; return
  fi
  for i in $(seq 0 14); do
    db=$(((pr + i) % 15 + 1))
    if ! awk -v db="${db}" '$2 == db { found = 1 } END { exit !found }' <<<"${claims}"; then
      echo "${db}"; return
    fi
  done
  echo "all 15 redis logical dbs are claimed by live ephemeral environments; tear one down first" >&2
  return 1
}

verify_redis_claim() { # after claiming: fail if a lower-numbered PR holds our db
  local db="$1"
  if redis_db_taken "$(list_redis_claims)" "${db}"; then
    echo "redis db ${db} is claimed by an older ephemeral environment; rerun the deploy to pick a new slot" >&2
    return 1
  fi
}

yaml_to_json() {
  python3 -c 'import yaml, json, sys; json.dump(yaml.safe_load(sys.stdin), sys.stdout)'
}

export_json() { # <services|jobs> <name>
  run "$1" describe "$2" --format=export | yaml_to_json
}

ephemeral_env_json() {
  jq -n --arg db "${db_name}" --arg redis "${redis_db}" \
    '[{name: "EPHEMERAL_DB_NAME", value: $db}, {name: "EPHEMERAL_REDIS_DB", value: $redis}]'
}

deploy() {
  local image="${1:?image is required}"
  local tmp; tmp="$(mktemp -d)"

  redis_db="$(allocate_redis_db)"

  export_json services "${BASE_API_SERVICE}" >"${tmp}/api.json"

  # Per-PR database job: the migrate-job clone re-pointed at the bundled
  # ephemeral-db.js entrypoint. REDIS_URL is copied from the API service so
  # the job can flush the PR's redis db.
  export_json jobs "${BASE_MIGRATE_JOB}" | jq \
    --arg name "${db_job}" --arg pr "${pr}" --arg image "${image}" \
    --arg redisdb "${redis_db}" \
    --argjson extra "$(ephemeral_env_json)" \
    --argjson redis "$(jq '[.spec.template.spec.containers[0].env[] | select(.name == "REDIS_URL")]' "${tmp}/api.json")" \
    '.metadata.name = $name
     | .metadata.labels["sdp-ephemeral-pr"] = $pr
     | .metadata.labels["sdp-ephemeral-redis-db"] = $redisdb
     | .spec.template.spec.template.spec.containers[0].image = $image
     | .spec.template.spec.template.spec.containers[0].command = ["node", "ephemeral-db.js"]
     | .spec.template.spec.template.spec.containers[0].args = ["ensure"]
     | .spec.template.spec.template.spec.containers[0].env =
         ((.spec.template.spec.template.spec.containers[0].env // []) + $redis + $extra)
    ' >"${tmp}/${db_job}.json"
  run jobs replace "${tmp}/${db_job}.json" >/dev/null
  if ! verify_redis_claim "${redis_db}"; then
    run jobs delete "${db_job}" --quiet
    exit 1
  fi
  run jobs execute "${db_job}" --wait

  jq --arg name "${api_service}" --arg pr "${pr}" --arg image "${image}" \
    --arg redisdb "${redis_db}" \
    --argjson extra "$(ephemeral_env_json)" \
    '.metadata.name = $name
     | .metadata.labels["sdp-ephemeral-pr"] = $pr
     | .metadata.labels["sdp-ephemeral-redis-db"] = $redisdb
     | .metadata.annotations["run.googleapis.com/ingress"] = "all"
     | del(.spec.traffic, .spec.template.metadata.name, .status)
     | .spec.template.metadata.annotations["autoscaling.knative.dev/minScale"] = "0"
     | .spec.template.metadata.annotations["autoscaling.knative.dev/maxScale"] = "2"
     | .spec.template.spec.containers[0].image = $image
     | .spec.template.spec.containers[0].env =
         ((.spec.template.spec.containers[0].env // []) + $extra)
    ' "${tmp}/api.json" >"${tmp}/${api_service}.json"
  run services replace "${tmp}/${api_service}.json" >/dev/null
  run services add-iam-policy-binding "${api_service}" \
    --member allUsers --role roles/run.invoker >/dev/null

  export_json services "${BASE_WORKER_SERVICE}" | jq \
    --arg name "${worker_service}" --arg pr "${pr}" --arg image "${image}" \
    --argjson extra "$(ephemeral_env_json)" \
    '.metadata.name = $name
     | .metadata.labels["sdp-ephemeral-pr"] = $pr
     | del(.spec.traffic, .spec.template.metadata.name, .status)
     | .spec.template.spec.containers[0].image = $image
     | .spec.template.spec.containers[0].env =
         ((.spec.template.spec.containers[0].env // []) + $extra)
    ' >"${tmp}/${worker_service}.json"
  run services replace "${tmp}/${worker_service}.json" >/dev/null

  run services describe "${api_service}" --format='value(status.url)'
}

teardown() {
  if run jobs describe "${db_job}" >/dev/null 2>&1; then
    local drop_args="drop" own_db
    own_db="$(run jobs describe "${db_job}" \
      --format 'value(metadata.labels.sdp-ephemeral-redis-db)' 2>/dev/null || true)"
    if [[ -n "${own_db}" ]] && redis_db_taken "$(list_redis_claims)" "${own_db}"; then
      echo "redis db ${own_db} belongs to an older PR; dropping database only" >&2
      drop_args="drop,skip-redis"
    fi
    run jobs execute "${db_job}" --args "${drop_args}" --wait || echo "database drop failed; dropping resources anyway" >&2
    run jobs delete "${db_job}" --quiet
  fi
  for service in "${api_service}" "${worker_service}"; do
    if run services describe "${service}" >/dev/null 2>&1; then
      run services delete "${service}" --quiet
    fi
  done
}

case "${cmd}" in
  deploy) deploy "${3:?image is required}" ;;
  teardown) teardown ;;
  *) echo "unknown command: ${cmd}" >&2; exit 1 ;;
esac
