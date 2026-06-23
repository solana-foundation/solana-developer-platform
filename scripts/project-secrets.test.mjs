import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "project-secrets.mjs");

function run(command, env = {}, extraArgs = []) {
  const result = spawnSync(process.execPath, [script, command, ...extraArgs], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("docker emits KEY=VALUE for committed and secret keys", () => {
  const result = run("docker", {
    SDP_RUNTIME: "node",
    SOLANA_NETWORK: "mainnet-beta",
    CLERK_SECRET_KEY: "sk_test_clerk",
    PRIVY_APP_SECRET: "privy_secret",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^SDP_RUNTIME=node$/m);
  assert.match(result.stdout, /^SOLANA_NETWORK=mainnet-beta$/m);
  assert.match(result.stdout, /^CLERK_SECRET_KEY=sk_test_clerk$/m);
  assert.match(result.stdout, /^PRIVY_APP_SECRET=privy_secret$/m);
});

test("docker excludes LOCAL_ONLY_API_ENV_KEYS even when set", () => {
  const result = run("docker", {
    DATABASE_URL: "postgresql://localhost/sdp",
    REDIS_URL: "redis://localhost:6379",
    SOLANA_MOCK: "1",
    RUN_INTEGRATION_TESTS: "1",
    CLERK_SECRET_KEY: "sk_test_clerk",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /^DATABASE_URL=/m);
  assert.doesNotMatch(result.stdout, /^REDIS_URL=/m);
  assert.doesNotMatch(result.stdout, /^SOLANA_MOCK=/m);
  assert.doesNotMatch(result.stdout, /^RUN_INTEGRATION_TESTS=/m);
});

test("docker escapes literal newlines in values as \\\\n", () => {
  const result = run("docker", { CLERK_SECRET_KEY: "line1\nline2\r\nline3" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^CLERK_SECRET_KEY=line1\\nline2\\nline3$/m);
  assert.equal(
    result.stdout.split("\n").filter((l) => l.startsWith("CLERK_SECRET_KEY=")).length,
    1
  );
});

test("docker omits keys whose values are missing or empty", () => {
  const result = run("docker", { CLERK_SECRET_KEY: "" });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /^CLERK_SECRET_KEY=/m);
  assert.equal(result.stdout, "");
});

test("cloudflare output stays valid JSON without committed or local-only keys", () => {
  const result = run("cloudflare", {
    SDP_RUNTIME: "workers",
    SOLANA_NETWORK: "mainnet-beta",
    DATABASE_URL: "postgresql://localhost/sdp",
    CLERK_SECRET_KEY: "sk_test_clerk",
    MONEYGRAM_SANDBOX_PUBLIC_KEY: "moneygram_public",
    MONEYGRAM_SANDBOX_SECRET_KEY: "moneygram_secret",
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.CLERK_SECRET_KEY, "sk_test_clerk");
  assert.equal(payload.MONEYGRAM_SANDBOX_PUBLIC_KEY, "moneygram_public");
  assert.equal(payload.MONEYGRAM_SANDBOX_SECRET_KEY, "moneygram_secret");
  assert.equal(payload.SDP_RUNTIME, undefined);
  assert.equal(payload.SOLANA_NETWORK, undefined);
  assert.equal(payload.DATABASE_URL, undefined);
});

test("cloudflare-batches writes JSON files up to the requested batch size", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `sdp-cloudflare-batches-${process.pid}-`));
  try {
    const result = run(
      "cloudflare-batches",
      {
        CLERK_AUDIENCE: "audience",
        CLERK_JWKS_URL: "https://clerk.test/jwks",
        CLERK_SECRET_KEY: "sk_test_clerk",
        CLERK_WEBHOOK_SECRET: "whsec_test",
        PRIVY_APP_SECRET: "privy_secret",
        SOLANA_NETWORK: "mainnet-beta",
      },
      ["--out-dir", outDir, "--batch-size", "2"]
    );
    assert.equal(result.status, 0, result.stderr);

    const files = fs.readdirSync(outDir).sort();
    assert.deepEqual(files, [
      "cloudflare-secrets-001.json",
      "cloudflare-secrets-002.json",
      "cloudflare-secrets-003.json",
    ]);

    const payloads = files.map((file) =>
      JSON.parse(fs.readFileSync(path.join(outDir, file), "utf8"))
    );
    assert.deepEqual(Object.keys(payloads[0]), ["CLERK_JWKS_URL", "CLERK_AUDIENCE"]);
    assert.deepEqual(Object.keys(payloads[1]), ["CLERK_SECRET_KEY", "CLERK_WEBHOOK_SECRET"]);
    assert.deepEqual(Object.keys(payloads[2]), ["PRIVY_APP_SECRET"]);
    assert.equal(payloads[0].SOLANA_NETWORK, undefined);
  } finally {
    fs.rmSync(outDir, { force: true, recursive: true });
  }
});

test("cloudflare-batches writes no files when no Cloudflare secrets are set", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `sdp-cloudflare-empty-${process.pid}-`));
  try {
    const result = run("cloudflare-batches", {}, ["--out-dir", outDir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /wrote 0 Cloudflare secret batches/);
    assert.deepEqual(fs.readdirSync(outDir), []);
  } finally {
    fs.rmSync(outDir, { force: true, recursive: true });
  }
});

test("unknown command exits non-zero and prints usage", () => {
  const result = run("nonsense");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
  assert.match(result.stderr, /cloudflare/);
  assert.match(result.stderr, /cloudflare-batches/);
  assert.match(result.stderr, /docker/);
});

test("docker preserves $ and inline = verbatim", () => {
  const result = run("docker", {
    // biome-ignore lint/security/noSecrets: synthetic fixture, not a real key
    CLERK_SECRET_KEY: "sk_test_with$dollar=equals",
    PRIVY_APP_SECRET: "abc.def-ghi/jkl+mno",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^CLERK_SECRET_KEY=sk_test_with\$dollar=equals$/m);
  assert.match(result.stdout, /^PRIVY_APP_SECRET=abc\.def-ghi\/jkl\+mno$/m);
});

test("docker fails on value with leading whitespace", () => {
  const result = run("docker", { CLERK_SECRET_KEY: "  oops_indented" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CLERK_SECRET_KEY/);
  assert.match(result.stderr, /leading whitespace/);
});

test("docker preserves value starting with '#' verbatim", () => {
  // godotenv treats `#` as an inline-comment trigger only when preceded by
  // whitespace, so a value starting with `#` is safe.
  const result = run("docker", { CLERK_SECRET_KEY: "#literal_hash_prefix" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^CLERK_SECRET_KEY=#literal_hash_prefix$/m);
});

test("docker fails on value containing space + '#' inline-comment trigger", () => {
  const result = run("docker", { CLERK_SECRET_KEY: "secret_value #anything" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CLERK_SECRET_KEY/);
  assert.match(result.stderr, /inline comment/);
});

test("docker fails on value containing tab + '#' inline-comment trigger", () => {
  const result = run("docker", { CLERK_SECRET_KEY: "secret_value\t#anything" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CLERK_SECRET_KEY/);
  assert.match(result.stderr, /inline comment/);
});

test("--out writes docker env file to disk", () => {
  const outPath = path.join(os.tmpdir(), `sdp-docker-${process.pid}-${Date.now()}.env`);
  try {
    const result = run("docker", { CLERK_SECRET_KEY: "sk_test" }, ["--out", outPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^wrote ${outPath.replace(/[/.\\]/g, "\\$&")}$`, "m"));
    const written = fs.readFileSync(outPath, "utf8");
    assert.match(written, /^CLERK_SECRET_KEY=sk_test$/m);
  } finally {
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  }
});
