import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { paymentAttempt, runLive, validateConfig } from "./fireblocks-live.mjs";

const source = "11111111111111111111111111111111";
const recipient = SOL_MINT;
const config = {
  baseUrl: "http://127.0.0.1:8787",
  network: "mainnet-beta",
  projectId: "prj_live",
  custodyWalletId: "cwlt_live",
  rpcUrl: "https://rpc.example.test/",
  feePayer: recipient,
  payment: { destination: recipient, token: "SOL", amount: "0.00001" },
};
const wallet = {
  id: config.custodyWalletId,
  walletId: "fb_0",
  provider: "fireblocks",
  custodyConnectionId: "cconn_live",
  status: "active",
  isRuntimeExecutionAllowed: true,
  publicKey: source,
};
const transfer = {
  id: "xfr_live",
  custodyWalletId: wallet.id,
  projectId: config.projectId,
  source,
  destination: recipient,
  amount: "0.00001",
  token: recipient,
  status: "confirmed",
  signature: "signature",
};

function transport(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    assert.equal(init.redirect, "error");
    if (url === config.rpcUrl)
      return Response.json(
        JSON.parse(init.body).map(({ id, method }) => ({
          id,
          result: {
            // biome-ignore lint/security/noSecrets: Public Solana mainnet genesis hash.
            getGenesisHash: overrides.genesis ?? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
            getMultipleAccounts: {
              value: [
                { lamports: overrides.source ?? 2_000_000 },
                { lamports: overrides.payer ?? 1_000_000 },
              ],
            },
            getSignatureStatuses: { value: [{ err: null, confirmationStatus: "confirmed" }] },
          }[method],
        }))
      );
    if (url.endsWith(`/v1/projects/${config.projectId}`))
      return Response.json({
        data: { project: { environment: overrides.environment ?? "production" } },
      });
    if (url.includes("/v1/wallets?"))
      return Response.json({
        data: { wallets: overrides.walletMissing ? [] : [{ ...wallet, ...overrides.wallet }] },
      });
    if (url.endsWith("/signer-check"))
      return Response.json({
        data: {
          walletAddress: source,
          feePayer: config.feePayer,
          simulated: true,
          signature: "memo-signature",
        },
      });
    if (url.endsWith("/v1/payments/transfers")) {
      if (overrides.unknown) throw new Error("socket closed");
      return Response.json({
        data: {
          transfer: overrides.pending
            ? {
                ...transfer,
                status: "processing",
                signature: null,
                fireblocks: {
                  transactionId: "fb_proposal",
                  status: "PENDING_AUTHORIZATION",
                  subStatus: null,
                },
              }
            : { ...transfer, ...overrides.transfer },
        },
      });
    }
    if (url.endsWith(`/v1/payments/transfers/${transfer.id}`))
      return Response.json({ data: { transfer: { ...transfer, ...overrides.transfer } } });
    throw new Error("Unexpected request");
  };
  return { calls, fetchImpl, apiKey: "sk_test_runner", log: () => {} };
}

test("refuses remote SDP origins and malformed config before sending credentials", () => {
  assert.throws(
    () => validateConfig({ ...config, baseUrl: "https://remote.example.test" }),
    /local instance/
  );
  assert.throws(
    () => validateConfig({ ...config, baseUrl: "http://localhost:8787/redirect" }),
    /origin/
  );
  assert.throws(() => validateConfig({ ...config, network: "devnet" }), /mainnet/);
});

test("payment cannot execute without explicit spending opt-in", async () => {
  const t = transport();
  await assert.rejects(runLive(config, "payment", t), /--send-mainnet/);
  assert.equal(t.calls.length, 0);
});

test("preflight makes only reads and refuses devnet, non-BYOK, disabled wallets and unfunded source vaults", async () => {
  for (const overrides of [
    { genesis: "devnet" },
    { environment: "sandbox" },
    { wallet: { custodyConnectionId: null } },
    { wallet: { isRuntimeExecutionAllowed: false } },
    { source: 0 },
  ]) {
    const t = transport(overrides);
    await assert.rejects(runLive(config, "preflight", t));
    assert.equal(
      t.calls.filter((call) => call.method === "POST" && call.url !== config.rpcUrl).length,
      0
    );
  }
  await runLive(config, "preflight", transport());
});

test("signer test invokes only the no-broadcast SDP signer check", async () => {
  const t = transport();
  await runLive(config, "signer", t);
  const writes = t.calls.filter((call) => call.method === "POST" && call.url !== config.rpcUrl);
  assert.equal(writes.length, 1);
  assert(writes[0].url.endsWith("/v1/wallets/signer-check"));
  assert.deepEqual(JSON.parse(writes[0].body), { walletId: "fb_0" });
});

test("payment and signer modes still refuse disabled wallets before starting work", async () => {
  for (const mode of ["payment", "signer"]) {
    const t = transport({ wallet: { isRuntimeExecutionAllowed: false } });
    await assert.rejects(
      runLive(config, mode, { ...t, sendMainnet: true, receiptPath: "unused-receipt.json" }),
      /must be active and enabled/
    );
    assert.equal(t.calls.filter((call) => call.method === "POST").length, 0);
  }
});

test("status recovers an accepted transfer without requiring an operational wallet or funds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fireblocks-disabled-status-"));
  try {
    const receiptPath = join(dir, "payment.json");
    await runLive(config, "payment", {
      ...transport({ pending: true }),
      receiptPath,
      sendMainnet: true,
    });
    for (const overrides of [
      { wallet: { isRuntimeExecutionAllowed: false }, source: 0 },
      { walletMissing: true, source: 0 },
    ]) {
      const t = transport(overrides);
      const result = await runLive(config, "status", { ...t, receiptPath });
      assert.equal(result.status, "confirmed");
      assert.equal(
        t.calls.some((call) => call.url.includes("/v1/wallets")),
        false
      );
      assert.equal(
        t.calls.filter((call) => call.method === "POST" && call.url !== config.rpcUrl).length,
        0
      );
      const rpcMethods = t.calls
        .filter((call) => call.url === config.rpcUrl)
        .flatMap((call) => JSON.parse(call.body).map((request) => request.method));
      assert.deepEqual(rpcMethods, ["getGenesisHash", "getSignatureStatuses"]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status still binds the recovered transfer to the receipt, key, project, wallet and payment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fireblocks-status-intent-"));
  try {
    const receiptPath = join(dir, "payment.json");
    await runLive(config, "payment", {
      ...transport({ pending: true }),
      receiptPath,
      sendMainnet: true,
    });
    for (const patch of [
      { id: "xfr_other" },
      { custodyWalletId: "cwlt_other" },
      { projectId: "prj_other" },
      { source: recipient },
      { destination: source },
      { amount: "1" },
      { token: source },
    ]) {
      const t = transport({ walletMissing: true, transfer: patch });
      await assert.rejects(runLive(config, "status", { ...t, receiptPath }));
      assert.equal(
        t.calls.filter((call) => call.method === "POST" && call.url !== config.rpcUrl).length,
        0
      );
      assert.deepEqual(JSON.parse(await readFile(`${receiptPath}.result.json`, "utf8")), {
        transferId: transfer.id,
      });
    }
    await assert.rejects(
      runLive(config, "status", {
        ...transport({ walletMissing: true }),
        apiKey: "sk_other",
        receiptPath,
      }),
      /different SDP API key/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unknown payment outcome preserves the exact intent and key on retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fireblocks-live-runner-"));
  try {
    const receiptPath = join(dir, "payment.json");
    const first = transport({ unknown: true });
    await assert.rejects(
      runLive(config, "payment", { ...first, receiptPath, sendMainnet: true }),
      /outcome may be unknown/
    );
    const second = transport();
    await runLive(config, "payment", { ...second, receiptPath, sendMainnet: true });
    const before = first.calls.find((call) => call.url.endsWith("/transfers"));
    const after = second.calls.find((call) => call.url.endsWith("/transfers"));
    assert.equal(before.headers["Idempotency-Key"], after.headers["Idempotency-Key"]);
    assert.equal(before.body, after.body);
    const result = JSON.parse(await readFile(`${receiptPath}.result.json`, "utf8"));
    assert.deepEqual(result, { transferId: transfer.id });
    await assert.rejects(
      paymentAttempt(receiptPath, { different: "intent" }, "sk_test"),
      /different payment/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent runner starts share the same durable payment key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fireblocks-live-race-"));
  try {
    const path = join(dir, "intent.json");
    const [first, ...retries] = await Promise.all([
      paymentAttempt(path, { amount: "1" }, "sk_test"),
      paymentAttempt(path, { amount: "1" }, "sk_test"),
      paymentAttempt(path, { amount: "1" }, "sk_test"),
    ]);
    assert(retries.every((attempt) => attempt.idempotencyKey === first.idempotencyKey));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("native payment returns pending and status mode reconciles by GET without another payment POST", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fireblocks-native-runner-"));
  try {
    const receiptPath = join(dir, "payment.json");
    const first = transport({ pending: true });
    const pending = await runLive({ ...config, feePayer: undefined }, "payment", {
      ...first,
      receiptPath,
      sendMainnet: true,
    });
    assert.equal(pending.status, "processing");
    const read = transport();
    const confirmed = await runLive({ ...config, feePayer: undefined }, "status", {
      ...read,
      receiptPath,
    });
    assert.equal(confirmed.status, "confirmed");
    assert.equal(
      read.calls.filter((call) => call.method === "POST" && call.url !== config.rpcUrl).length,
      0
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses a new API key against an existing receipt before submitting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fireblocks-key-binding-"));
  try {
    const receiptPath = join(dir, "payment.json");
    const first = transport();
    await runLive(config, "payment", {
      ...first,
      apiKey: "sk_original",
      receiptPath,
      sendMainnet: true,
    });
    const second = transport();
    await assert.rejects(
      runLive(config, "payment", {
        ...second,
        apiKey: "sk_rotated",
        receiptPath,
        sendMainnet: true,
      }),
      /different SDP API key/
    );
    assert.equal(
      second.calls.filter((call) => call.url.endsWith("/v1/payments/transfers")).length,
      0
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("only explicit config and receipt fields reach local SDP; RPC never receives the SDP credential", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fireblocks-file-boundary-"));
  try {
    const receiptPath = join(dir, "payment.json");
    const marker = "unexpected-private-file-content";
    const input = {
      ...config,
      unexpected: marker,
      payment: { ...config.payment, unexpected: marker },
    };
    const first = transport();
    await runLive(input, "payment", { ...first, receiptPath, sendMainnet: true });
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    await writeFile(receiptPath, JSON.stringify({ ...receipt, unexpected: marker }));
    const retry = transport();
    await runLive(input, "payment", { ...retry, receiptPath, sendMainnet: true });
    assert(!JSON.stringify(retry.calls).includes(marker));
    for (const call of retry.calls) {
      if (call.url === config.rpcUrl) {
        assert(!JSON.stringify(call).includes(retry.apiKey));
        assert.equal(call.headers.Authorization, undefined);
      } else {
        assert.equal(new URL(call.url).origin, config.baseUrl);
        assert.equal(call.headers.Authorization, `Bearer ${retry.apiKey}`);
      }
    }
    const result = JSON.parse(await readFile(`${receiptPath}.result.json`, "utf8"));
    assert.deepEqual(result, { transferId: transfer.id });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid network identifiers are never persisted to the result receipt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fireblocks-response-boundary-"));
  try {
    const receiptPath = join(dir, "payment.json");
    const t = transport({ transfer: { id: "../../untrusted-path" } });
    await assert.rejects(
      runLive(config, "payment", { ...t, receiptPath, sendMainnet: true }),
      /Invalid transfer ID/
    );
    await assert.rejects(readFile(`${receiptPath}.result.json`), { code: "ENOENT" });
    assert(JSON.parse(await readFile(receiptPath, "utf8")).idempotencyKey);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("response metadata is not copied into the local result receipt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fireblocks-response-projection-"));
  try {
    const receiptPath = join(dir, "payment.json");
    const t = transport({ transfer: { unexpected: "provider-secret-or-untrusted-data" } });
    await runLive(config, "payment", { ...t, receiptPath, sendMainnet: true });
    assert.deepEqual(JSON.parse(await readFile(`${receiptPath}.result.json`, "utf8")), {
      transferId: transfer.id,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tampered status identifiers cannot change the local SDP request path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fireblocks-status-boundary-"));
  try {
    const receiptPath = join(dir, "payment.json");
    await runLive(config, "payment", { ...transport(), receiptPath, sendMainnet: true });
    await writeFile(
      `${receiptPath}.result.json`,
      JSON.stringify({ transferId: "xfr_good/../../api-keys" })
    );
    const t = transport();
    await assert.rejects(runLive(config, "status", { ...t, receiptPath }), /invalid transfer ID/);
    assert(!t.calls.some((call) => call.url.includes("/v1/payments/transfers")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
