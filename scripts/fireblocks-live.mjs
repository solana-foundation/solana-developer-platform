#!/usr/bin/env node
// Opt-in live tests through SDP. No Fireblocks private key is exported or accepted here.
import assert from "node:assert/strict";
import { createHash, randomUUID, scryptSync } from "node:crypto";
import { link, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { SOL_MINT } from "@sdp/types/well-known-tokens";

// biome-ignore lint/security/noSecrets: Public Solana mainnet genesis hash.
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function validateConfig(config) {
  const base = new URL(config.baseUrl);
  assert(
    ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname),
    "SDP must be a local instance"
  );
  assert.equal(base.protocol, "http:", "Use the local HTTP API directly");
  assert(
    !base.username && !base.password && !base.search && !base.hash && base.pathname === "/",
    "baseUrl must be an origin"
  );
  const rpc = new URL(config.rpcUrl);
  assert.equal(rpc.protocol, "https:", "Use your HTTPS mainnet RPC");
  assert(!rpc.username && !rpc.password && !rpc.hash, "Invalid RPC URL");
  for (const key of ["projectId", "custodyWalletId"]) {
    assert.equal(typeof config[key], "string", `${key} is required`);
    assert(/^[a-zA-Z0-9_-]{1,128}$/.test(config[key]), `Invalid ${key}`);
  }
  if (config.feePayer !== undefined)
    assert(ADDRESS.test(config.feePayer), "Invalid fee payer address");
  assert.equal(config.network, "mainnet-beta", "This runner is explicitly for mainnet-beta");
  return {
    baseUrl: base.origin,
    rpcUrl: rpc.href,
    projectId: config.projectId,
    custodyWalletId: config.custodyWalletId,
    network: "mainnet-beta",
    feePayer: config.feePayer,
    payment: config.payment,
  };
}

function paymentBody(config) {
  const payment = config.payment;
  assert(payment && ADDRESS.test(payment.destination), "Set an explicit payment destination");
  assert(
    payment.token === "SOL" || ADDRESS.test(payment.token),
    "Use SOL or an explicit token mint"
  );
  assert(
    typeof payment.amount === "string" &&
      /^(0|[1-9]\d*)(\.\d+)?$/.test(payment.amount) &&
      /[1-9]/.test(payment.amount),
    "Set a positive decimal payment amount as a string"
  );
  assert(payment.amount.length <= 40, "Payment amount is too long");
  assert(
    payment.memo === undefined || (typeof payment.memo === "string" && payment.memo.length <= 256),
    "Invalid memo"
  );
  return {
    sourceCustodyWalletId: config.custodyWalletId,
    destination: payment.destination,
    token: payment.token,
    amount: payment.amount,
    memo: payment.memo,
  };
}

/** Persist intent BEFORE the first request. Retries never choose a fresh payment key. */
export async function paymentAttempt(path, intent, apiKey) {
  assert(
    typeof apiKey === "string" && apiKey.startsWith("sk_"),
    "A receipt must be bound to an SDP API key"
  );
  const apiKeyFingerprint = scryptSync(apiKey, "sdp-fireblocks-live-receipt-v1", 32).toString(
    "hex"
  );
  const fingerprint = createHash("sha256").update(JSON.stringify(intent)).digest("hex");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const proposed = {
    fingerprint,
    apiKeyFingerprint,
    idempotencyKey: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(proposed, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    // Publish a complete file atomically without replacing a concurrent attempt.
    await link(temporary, path);
    return proposed;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = JSON.parse(await readFile(path, "utf8"));
    assert.equal(
      existing.fingerprint,
      fingerprint,
      "This receipt belongs to a different payment. Review it; choose a new receipt path only for an intentional new payment."
    );
    assert.equal(
      existing.apiKeyFingerprint,
      apiKeyFingerprint,
      "This receipt belongs to a different SDP API key (or predates key binding). Do not resend. Inspect the original transfer in SDP and Fireblocks."
    );
    assert.match(existing.idempotencyKey, /^[a-f0-9-]{36}$/);
    assert.equal(typeof existing.createdAt, "string");
    assert(Number.isFinite(Date.parse(existing.createdAt)), "Invalid receipt creation date");
    return {
      fingerprint,
      apiKeyFingerprint,
      idempotencyKey: existing.idempotencyKey,
      createdAt: existing.createdAt,
    };
  } finally {
    await unlink(temporary);
  }
}

export async function runLive(rawConfig, mode, options = {}) {
  const config = validateConfig(rawConfig);
  assert(
    ["preflight", "signer", "payment", "status"].includes(mode),
    "Choose preflight, signer, payment, or status"
  );
  if (mode === "signer") assert(ADDRESS.test(config.feePayer), "Signer check needs feePayer");
  if (mode === "status")
    assert(options.receiptPath, "Status requires --receipt from the payment attempt");
  const fetcher = options.fetchImpl ?? fetch;
  const log = options.log ?? console.log;
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Standalone opt-in runner, never a cached Turbo task.
  const apiKey = options.apiKey ?? process.env.SDP_LIVE_API_KEY;
  assert(
    apiKey?.startsWith("sk_"),
    "Set SDP_LIVE_API_KEY to a production SDP API key bound to this wallet"
  );
  if (mode === "payment") {
    assert.equal(
      options.sendMainnet,
      true,
      "Payment requires --send-mainnet; it spends real funds"
    );
    assert(options.receiptPath, "Payment requires --receipt to preserve its idempotency key");
    paymentBody(config);
  }
  const api = async (path, body, idempotencyKey) => {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "X-Project-ID": config.projectId,
      "Content-Type": "application/json",
    };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    let response;
    try {
      response = await fetcher(`${config.baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
    } catch {
      throw new Error(
        "SDP request did not return a response. Its outcome may be unknown. Preserve the payment receipt and retry with the same command; do not create another payment."
      );
    }
    const envelope = await response.json();
    if (!response.ok)
      throw new Error(
        `SDP HTTP ${response.status}: ${envelope.error?.code ?? "request_failed"}. Inspect the dashboard for details; keep the same receipt for any retry.`
      );
    return envelope.data;
  };
  const rpc = async (requests) => {
    let response;
    try {
      response = await fetcher(config.rpcUrl, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          requests.map(([method, params], id) => ({ jsonrpc: "2.0", id, method, params }))
        ),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error("Mainnet RPC request failed");
    }
    assert(response.ok, `Mainnet RPC HTTP ${response.status}`);
    const results = await response.json();
    return requests.map((_, id) => {
      const entry = results.find((item) => item.id === id);
      assert(entry && !entry.error, `Mainnet RPC operation ${id} failed`);
      return entry.result;
    });
  };
  const project = (await api(`/v1/projects/${encodeURIComponent(config.projectId)}`)).project;
  assert.equal(project.environment, "production", "The SDP project must be production");
  let wallet;
  let result;
  if (mode === "status") {
    // The operational wallet list omits deactivated connections. Recover the
    // existing transfer directly, then verify its receipt and exact intent below.
    const saved = JSON.parse(await readFile(`${options.receiptPath}.result.json`, "utf8"));
    assert(
      typeof saved.transferId === "string" && /^xfr_[a-zA-Z0-9_-]{1,100}$/.test(saved.transferId),
      "Receipt has an invalid transfer ID"
    );
    result = await api(`/v1/payments/transfers/${encodeURIComponent(saved.transferId)}`);
    assert(result?.transfer, "SDP did not return the recorded transfer");
    assert.equal(result.transfer.id, saved.transferId, "Transfer does not match the receipt");
    wallet = { id: config.custodyWalletId, publicKey: result.transfer.source };
  } else {
    const query = new URLSearchParams({
      provider: "fireblocks",
      view: "summary",
      includeBalances: "false",
    });
    const wallets = (await api(`/v1/wallets?${query}`)).wallets;
    wallet = wallets.find((item) => item.id === config.custodyWalletId);
    assert(
      wallet && wallet.provider === "fireblocks" && wallet.custodyConnectionId,
      "Select a Fireblocks BYOK wallet in this project"
    );
    assert(
      wallet.status === "active" && wallet.isRuntimeExecutionAllowed === true,
      "The Fireblocks connection must be active and enabled"
    );
  }
  assert(ADDRESS.test(wallet.publicKey), "Invalid source address");
  const preflightReads = [["getGenesisHash", []]];
  if (mode !== "status")
    preflightReads.push([
      "getMultipleAccounts",
      [
        [wallet.publicKey, ...(mode === "signer" ? [config.feePayer] : [])],
        { encoding: "base64", commitment: "confirmed" },
      ],
    ]);
  const [genesis, accounts] = await rpc(preflightReads);
  assert.equal(genesis, MAINNET_GENESIS, "RPC is not Solana mainnet-beta");
  const payerLamports = mode === "signer" ? (accounts.value[1]?.lamports ?? 0) : null;
  const sourceLamports = mode === "status" ? null : (accounts.value[0]?.lamports ?? 0);
  log(
    JSON.stringify({
      check: "preflight",
      network: "mainnet-beta",
      wallet: wallet.publicKey,
      feePayer: config.feePayer,
      feePayerLamports: payerLamports,
      sourceLamports,
    })
  );
  if (mode !== "status")
    assert(
      sourceLamports >= 10_000,
      "Fund the source Fireblocks vault with SOL for network fees, including USDC transfers."
    );
  if (mode === "preflight") return { wallet, payerLamports, sourceLamports };
  if (mode === "signer") {
    assert(
      payerLamports >= 10_000,
      "Fund the local fee payer before the optional RAW signer check."
    );
    log(
      "Approve the memo signer check in Fireblocks now. This test never broadcasts or transfers funds."
    );
    const result = await api("/v1/wallets/signer-check", { walletId: wallet.walletId });
    assert.equal(result.walletAddress, wallet.publicKey);
    assert.equal(result.feePayer, config.feePayer);
    assert.equal(result.simulated, true);
    assert(typeof result.signature === "string" && result.signature.length > 0);
    log("PASS: real Fireblocks signature verified and memo simulated; nothing broadcast.");
    return result;
  }
  const body = paymentBody(config);
  assert.notEqual(
    body.destination,
    wallet.publicKey,
    "Choose a distinct recipient for the payment test"
  );
  const attempt = await paymentAttempt(
    options.receiptPath,
    {
      baseUrl: config.baseUrl,
      projectId: config.projectId,
      source: wallet.publicKey,
      body,
    },
    apiKey
  );
  log(
    JSON.stringify({
      action: mode === "status" ? "read-payment-status" : "send-mainnet-payment",
      source: wallet.publicKey,
      ...body,
      idempotencyKey: attempt.idempotencyKey,
    })
  );
  if (mode !== "status") {
    log(
      "Approve the payment in Fireblocks. Fireblocks builds, signs and broadcasts; the source vault pays fees."
    );
    result = await api("/v1/payments/transfers", body, attempt.idempotencyKey);
  }
  if (!result?.transfer) {
    throw new Error(
      "SDP did not return a transfer; the payment may be awaiting an SDP policy approval. Check Approvals in the dashboard. Preserve this receipt."
    );
  }
  const transfer = result.transfer;
  assert.equal(transfer.custodyWalletId, wallet.id);
  assert.equal(transfer.projectId, config.projectId);
  assert.equal(transfer.source, wallet.publicKey);
  assert.equal(transfer.destination, body.destination);
  assert.equal(transfer.amount, body.amount);
  assert.equal(transfer.token, body.token === "SOL" ? SOL_MINT : body.token);
  assert(
    typeof transfer.id === "string" && /^xfr_[a-zA-Z0-9_-]{1,100}$/.test(transfer.id),
    "Invalid transfer ID in SDP response"
  );
  // The local receipt only needs this validated identifier for status recovery.
  // Do not persist arbitrary response fields, provider metadata or credentials.
  await writeFile(
    `${options.receiptPath}.result.json`,
    `${JSON.stringify({ transferId: transfer.id }, null, 2)}\n`,
    { mode: 0o600 }
  );
  if (transfer.status === "processing") {
    log(
      `PENDING: ${transfer.id}; Fireblocks ${transfer.fireblocks?.status ?? "status unavailable"}. Approve in Fireblocks, then run status with the same --receipt. Do not create another payment.`
    );
    return { transferId: transfer.id, status: transfer.status, fireblocks: transfer.fireblocks };
  }
  assert(
    ["confirmed", "finalized"].includes(transfer.status),
    `Payment is ${transfer.status}; inspect SDP before taking further action. Preserve the receipt.`
  );
  assert(transfer.signature, "Confirmed payment is missing its signature");
  const [statuses] = await rpc([
    ["getSignatureStatuses", [[transfer.signature], { searchTransactionHistory: true }]],
  ]);
  const chain = statuses.value[0];
  assert(
    chain && chain.err === null && ["confirmed", "finalized"].includes(chain.confirmationStatus),
    "Payment not confirmed by mainnet RPC yet. Preserve the receipt and recheck; do not send another payment."
  );
  log(`PASS: mainnet payment confirmed: https://explorer.solana.com/tx/${transfer.signature}`);
  return { transferId: transfer.id, signature: transfer.signature, status: transfer.status };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values, positionals } = parseArgs({
      options: {
        config: { type: "string" },
        receipt: { type: "string" },
        "send-mainnet": { type: "boolean" },
        help: { type: "boolean" },
      },
      allowPositionals: true,
    });
    if (values.help) {
      console.log(
        // biome-ignore lint/security/noSecrets: CLI usage text, not a credential.
        "Usage: node scripts/fireblocks-live.mjs <preflight|signer|payment|status> --config <file>",
        "[--send-mainnet --receipt <file>]"
      );
      console.log("Set SDP_LIVE_API_KEY locally. See docs/ops/fireblocks-byok.md.");
      console.log("No tests run implicitly.");
    } else {
      assert(values.config && positionals.length === 1, "Provide a mode and --config; use --help");
      const config = JSON.parse(await readFile(resolve(values.config), "utf8"));
      await runLive(config, positionals[0], {
        sendMainnet: values["send-mainnet"],
        receiptPath: values.receipt ? resolve(values.receipt) : undefined,
      });
    }
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
