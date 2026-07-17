import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "render-wrangler-config.mjs");

test("renders recurring collection settings into the Wrangler worker vars", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `sdp-wrangler-${process.pid}-`));
  const configPath = path.join(directory, "wrangler.toml");
  const outPath = path.join(directory, "rendered-wrangler.toml");
  const template = [
    'id = "your_dev_hyperdrive_id"',
    'id = "your_dev_api_keys_kv_id"',
    'id = "your_dev_rate_limits_kv_id"',
    'id = "your_dev_cache_kv_id"',
    'id = "your_dev_sessions_kv_id"',
    "",
    "[env.dev.vars]",
    'PAYMENTS_RECURRING_ENABLED = "false"',
    "",
  ].join("\n");

  fs.writeFileSync(configPath, template, "utf8");

  try {
    const result = spawnSync(
      process.execPath,
      [script, "--env", "dev", "--config", configPath, "--out", outPath],
      {
        env: {
          CLOUDFLARE_HYPERDRIVE_ID: "hd_dev_real",
          CLOUDFLARE_KV_SDP_API_KEYS_ID: "kv_api_keys_real",
          CLOUDFLARE_KV_SDP_RATE_LIMITS_ID: "kv_rate_limits_real",
          CLOUDFLARE_KV_SDP_CACHE_ID: "kv_cache_real",
          CLOUDFLARE_KV_SDP_SESSIONS_ID: "kv_sessions_real",
          PAYMENTS_RECURRING_ENABLED: "true",
          PAYMENTS_RECURRING_COLLECTION_ENABLED: "true",
          PAYMENTS_RECURRING_COLLECTION_BATCH_SIZE: "7",
          PAYMENTS_RECURRING_COLLECTION_RETRY_AFTER_MINUTES: "45",
        },
        encoding: "utf8",
        timeout: 10_000,
      }
    );

    assert.equal(result.status, 0, result.stderr);
    const rendered = fs.readFileSync(outPath, "utf8");
    assert.match(rendered, /^PAYMENTS_RECURRING_ENABLED = "true"$/m);
    assert.match(rendered, /^PAYMENTS_RECURRING_COLLECTION_ENABLED = "true"$/m);
    assert.match(rendered, /^PAYMENTS_RECURRING_COLLECTION_BATCH_SIZE = "7"$/m);
    assert.match(rendered, /^PAYMENTS_RECURRING_COLLECTION_RETRY_AFTER_MINUTES = "45"$/m);
    assert.doesNotMatch(rendered, /your_dev_/);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

const productionEnv = {
  CLOUDFLARE_HYPERDRIVE_ID: "11111111111111111111111111111111",
  CLOUDFLARE_KV_SDP_API_KEYS_ID: "22222222222222222222222222222222",
  CLOUDFLARE_KV_SDP_RATE_LIMITS_ID: "33333333333333333333333333333333",
  CLOUDFLARE_KV_SDP_CACHE_ID: "44444444444444444444444444444444",
  CLOUDFLARE_KV_SDP_SESSIONS_ID: "55555555555555555555555555555555",
  SDP_DEPLOYMENT_MODE: "managed",
  SOLANA_NETWORK: "mainnet-beta",
  SOLANA_RPC_URL: "https://rpc.example",
  SOLANA_RPC_DEFAULT_PROVIDER: "helius",
  SOLANA_RPC_TRITON_URL: "https://triton.example",
  SOLANA_RPC_HELIUS_URL: "https://helius.example",
  SOLANA_RPC_ALCHEMY_URL: "https://alchemy.example",
  SOLANA_RPC_QUICKNODE_URL: "https://quicknode.example",
  SOLANA_RPC_VALIDATIONCLOUD_URL: "https://validation-cloud.example",
  FEE_PAYMENT_PROVIDER: "kora",
  KORA_RPC_URL: "https://kora.example",
  PAYMENTS_RECURRING_ENABLED: "true",
  PAYMENTS_RECURRING_COLLECTION_ENABLED: "true",
  PAYMENTS_RECURRING_COLLECTION_BATCH_SIZE: "25",
  PAYMENTS_RECURRING_COLLECTION_RETRY_AFTER_MINUTES: "30",
};

test("production render keeps deployment config as Wrangler vars", () => {
  const outPath = path.join(os.tmpdir(), `sdp-wrangler-production-${process.pid}.toml`);

  try {
    const result = spawnSync(process.execPath, [script, "--env", "production", "--out", outPath], {
      env: productionEnv,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);

    const rendered = fs.readFileSync(outPath, "utf8");
    const productionVars = /\[env\.production\.vars\]\n([\s\S]*)$/.exec(rendered)?.[1];
    assert.ok(productionVars, "production vars section must exist");
    assert.match(productionVars, /^SDP_DEPLOYMENT_MODE = "managed"$/m);
    assert.match(productionVars, /^SOLANA_NETWORK = "mainnet-beta"$/m);
    assert.match(productionVars, /^SOLANA_RPC_HELIUS_URL = "https:\/\/helius\.example"$/m);
    assert.match(
      productionVars,
      /^SOLANA_RPC_VALIDATIONCLOUD_URL = "https:\/\/validation-cloud\.example"$/m
    );
    assert.match(productionVars, /^KORA_RPC_URL = "https:\/\/kora\.example"$/m);
    assert.match(productionVars, /^PAYMENTS_RECURRING_ENABLED = "true"$/m);
    assert.match(productionVars, /^PAYMENTS_RECURRING_COLLECTION_ENABLED = "true"$/m);
    assert.match(productionVars, /^PAYMENTS_RECURRING_COLLECTION_BATCH_SIZE = "25"$/m);
    assert.match(productionVars, /^PAYMENTS_RECURRING_COLLECTION_RETRY_AFTER_MINUTES = "30"$/m);
    assert.doesNotMatch(rendered, /your_production_/);
  } finally {
    fs.rmSync(outPath, { force: true });
  }
});

test("production render fails when required Doppler vars are missing", () => {
  const outPath = path.join(os.tmpdir(), `sdp-wrangler-production-missing-${process.pid}.toml`);
  const { SOLANA_NETWORK: _network, SOLANA_RPC_URL: _rpcUrl, ...incompleteEnv } = productionEnv;

  try {
    const result = spawnSync(process.execPath, [script, "--env", "production", "--out", outPath], {
      env: incompleteEnv,
      encoding: "utf8",
      timeout: 10_000,
    });

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Doppler config is missing required production Worker vars: SOLANA_NETWORK, SOLANA_RPC_URL/
    );
    assert.equal(fs.existsSync(outPath), false);
  } finally {
    fs.rmSync(outPath, { force: true });
  }
});

test("production render rejects placeholder-like Doppler vars", () => {
  const outPath = path.join(os.tmpdir(), `sdp-wrangler-production-placeholder-${process.pid}.toml`);

  try {
    const result = spawnSync(process.execPath, [script, "--env", "production", "--out", outPath], {
      env: { ...productionEnv, KORA_RPC_URL: "https://some_your_endpoint.example" },
      encoding: "utf8",
      timeout: 10_000,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /placeholder values for production: KORA_RPC_URL/);
    assert.equal(fs.existsSync(outPath), false);
  } finally {
    fs.rmSync(outPath, { force: true });
  }
});
