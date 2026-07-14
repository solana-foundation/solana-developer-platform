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
