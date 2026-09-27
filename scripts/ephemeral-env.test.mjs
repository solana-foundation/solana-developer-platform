import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Runs the real deploy path of ephemeral-env.sh against a stubbed gcloud, so
// CI fails when the clone topology drifts even though the script only runs
// against live Cloud Run during ephemeral deployments.
const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, "../.github/scripts/ephemeral-env.sh");
const PR = "2133";
const URL = "https://sdp-dev-api-pr-2133.example.run.app";
const BASE_API = "sdp-dev-api-public";
const BASE_WORKER = "sdp-dev-worker";
const BASE_MIGRATE = "sdp-dev-api-public-migrate";

// Mimics dev's gated API export: proxy trust is on behind the load balancer.
const API_SERVICE_YAML = `
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: sdp-dev-api-public
  annotations:
    run.googleapis.com/ingress: internal-and-cloud-load-balancing
spec:
  traffic:
    - percent: 100
  template:
    metadata:
      name: sdp-dev-api-public-00001-abc
    spec:
      containers:
        - image: us-central1-docker.pkg.dev/solana-developer-platform-dev/sdp-dev/sdp-api-public:main
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: sdp-dev-api
                  key: database-url
            - name: REDIS_URL
              value: redis://redis:6379
            - name: K_SERVICE
              value: sdp-dev-api-public
            - name: TRUST_PROXY_HEADERS
              value: "true"
status:
  url: https://sdp-dev-api-public.example.run.app
`;

const WORKER_YAML = `
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: sdp-dev-worker
  annotations:
    run.googleapis.com/ingress: internal
spec:
  traffic:
    - percent: 100
  template:
    metadata:
      name: sdp-dev-worker-00001-abc
    spec:
      containers:
        - image: us-central1-docker.pkg.dev/solana-developer-platform-dev/sdp-dev/sdp-api-public:main
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: sdp-dev-api
                  key: database-url
status:
  url: https://sdp-dev-worker.example.run.app
`;

const MIGRATE_JOB_YAML = `
apiVersion: run.googleapis.com/v1
kind: Job
metadata:
  name: sdp-dev-api-public-migrate
spec:
  template:
    metadata:
      name: sdp-dev-api-public-migrate
    spec:
      template:
        spec:
          containers:
            - image: us-central1-docker.pkg.dev/solana-developer-platform-dev/sdp-dev/sdp-api-public:main
              env:
                - name: DATABASE_URL
                  valueFrom:
                    secretKeyRef:
                      name: sdp-dev-api
                      key: database-url
`;

function stubGcloud(dir, record, fixtures) {
  fs.writeFileSync(path.join(dir, "api.yaml"), fixtures.api);
  fs.writeFileSync(path.join(dir, "worker.yaml"), fixtures.worker);
  fs.writeFileSync(path.join(dir, "migrate.yaml"), fixtures.migrate);
  fs.writeFileSync(
    path.join(dir, "gcloud"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${*}" == *"services describe ${BASE_API}"* ]]; then
  cat "${path.join(dir, "api.yaml")}"; exit 0
fi
if [[ "\${*}" == *"jobs describe ${BASE_MIGRATE}"* ]]; then
  cat "${path.join(dir, "migrate.yaml")}"; exit 0
fi
if [[ "\${*}" == *"services describe ${BASE_WORKER}"* ]]; then
  cat "${path.join(dir, "worker.yaml")}"; exit 0
fi
if [[ "\${*}" == *replace* ]]; then
  for a in "$@"; do
    if [[ -f "\${a}" ]]; then
      cp "\${a}" "$(mktemp "${path.join(record, "replace-XXXXXX.json")}")"
    fi
  done
fi
if [[ "\${*}" == *status.url* ]]; then
  echo "${URL}"; exit 0
fi
if [[ "\${*}" == *describe* ]]; then
  exit 1
fi
exit 0
`
  );
  fs.chmodSync(path.join(dir, "gcloud"), 0o755);
}

function deploy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ephemeral-env-"));
  const record = path.join(dir, "record");
  fs.mkdirSync(record);
  fs.mkdirSync(path.join(dir, "bin"));
  stubGcloud(path.join(dir, "bin"), record, {
    api: API_SERVICE_YAML,
    worker: WORKER_YAML,
    migrate: MIGRATE_JOB_YAML,
  });
  const out = execFileSync(
    "bash",
    [script, "deploy", PR, "us-central1-docker.pkg.dev/pr-image@sha256:abc"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${path.join(dir, "bin")}:${process.env.PATH}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  ).trim();
  assert.equal(out, URL, "deploy prints the ephemeral service URL");
  const payloads = fs
    .readdirSync(record)
    .map((f) => JSON.parse(fs.readFileSync(path.join(record, f), "utf8")));
  return payloads;
}

function containerEnv(payload) {
  return payload.spec.template.spec.containers[0].env;
}

test("the public ephemeral API clone drops the inherited proxy-trust opt-in", () => {
  const payloads = deploy();
  const api = payloads.find((p) => p.metadata?.name === `sdp-dev-api-pr-${PR}`);
  assert.ok(api, "the ephemeral API service was replaced");
  assert.equal(api.metadata.annotations["run.googleapis.com/ingress"], "all");
  const names = containerEnv(api).map((entry) => entry.name);
  assert.ok(
    names.includes("TRUST_PROXY_HEADERS") === false,
    `public ephemeral API must not inherit TRUST_PROXY_HEADERS (env: ${names.join(", ")})`
  );
  assert.ok(names.includes("EPHEMERAL_DB_NAME"));
  assert.ok(names.includes("EPHEMERAL_REDIS_DB"));
  assert.ok(names.includes("DATABASE_URL"), "the rest of dev's environment is still copied");
  assert.equal(api.metadata.labels["sdp-ephemeral-pr"], PR);
  assert.equal(
    api.spec.template.spec.containers[0].image,
    "us-central1-docker.pkg.dev/pr-image@sha256:abc"
  );
});

test("the worker clone keeps its ephemeral environment wiring", () => {
  const payloads = deploy();
  const worker = payloads.find((p) => p.metadata?.name === `sdp-dev-worker-pr-${PR}`);
  assert.ok(worker, "the ephemeral worker service was replaced");
  const names = containerEnv(worker).map((entry) => entry.name);
  assert.ok(names.includes("EPHEMERAL_DB_NAME"));
  assert.ok(names.includes("EPHEMERAL_REDIS_DB"));
});
