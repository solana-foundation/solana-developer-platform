import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { paymentAttempt, runLive, validateConfig } from "./fireblocks-live.mjs";

const source = "11111111111111111111111111111111";
// biome-ignore lint/security/noSecrets: Public wrapped SOL mint used as a synthetic recipient.
const recipient = "So11111111111111111111111111111111111111112";
const config = {
  baseUrl: "http://127.0.0.1:8787",
  network: "mainnet-beta",
  projectId: "prj_live",
  custodyWalletId: "cwlt_live",
  rpcUrl: "https://rpc.example.test",
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
  id: "xfer_live",
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
      return Response.json({ data: { wallets: [{ ...wallet, ...overrides.wallet }] } });
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
            : transfer,
        },
      });
    }
    if (url.endsWith(`/v1/payments/transfers/${transfer.id}`))
      return Response.json({ data: { transfer } });
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
    assert.deepEqual(result, {
      transferId: transfer.id,
      signature: transfer.signature,
      status: transfer.status,
    });
    await assert.rejects(paymentAttempt(receiptPath, { different: "intent" }), /different payment/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent runner starts share the same durable payment key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fireblocks-live-race-"));
  try {
    const path = join(dir, "intent.json");
    const [first, ...retries] = await Promise.all([
      paymentAttempt(path, { amount: "1" }),
      paymentAttempt(path, { amount: "1" }),
      paymentAttempt(path, { amount: "1" }),
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
