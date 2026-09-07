#!/usr/bin/env node
// biome-ignore-all lint/security/noSecrets: This local-only test helper contains public Solana addresses, not secrets.
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";

const koraRpcUrl = requiredEnv("KORA_RPC_URL");
const solanaRpcUrl = requiredEnv("SOLANA_RPC_URL");
const timeoutMs = parsePositiveInteger(process.env.KORA_TIMEOUT_MS ?? "45000", "KORA_TIMEOUT_MS");
const confirmationTimeoutMs = parsePositiveInteger(
  process.env.KORA_SURFPOOL_CONFIRMATION_TIMEOUT_MS ?? "30000",
  "KORA_SURFPOOL_CONFIRMATION_TIMEOUT_MS"
);
const memoProgramAddress = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

const payer = await koraRpc("getPayerSigner", {});
const feePayer = payer.signer_address ?? payer.payment_address ?? payer.payerSigner;
if (!feePayer) throw new Error("Kora warmup could not resolve the fee payer address.");

const latest = await solanaRpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (value) => setTransactionMessageFeePayer(feePayer, value),
  (value) =>
    setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: latest.value.blockhash,
        lastValidBlockHeight: latest.value.lastValidBlockHeight,
      },
      value
    ),
  (value) =>
    appendTransactionMessageInstructions(
      [
        {
          programAddress: memoProgramAddress,
          accounts: [],
          data: new TextEncoder().encode(`sdp kora surfpool warmup ${Date.now()}`),
        },
      ],
      value
    )
);
const transaction = compileTransaction(message);
const encodedTransaction = Buffer.from(getTransactionEncoder().encode(transaction)).toString(
  "base64"
);
const result = await koraRpc("signAndSendTransaction", {
  transaction: encodedTransaction,
  signer_key: feePayer,
  user_id: "sdp:surfpool:warmup",
  respond_after: "sent",
});
const signature = result.signature ?? signatureFromEncodedTransaction(result.signed_transaction);
await waitForSignature(signature);
console.log(`Kora Surfpool warmup confirmed ${signature}.`);

async function koraRpc(method, params) {
  return jsonRpc(koraRpcUrl, method, params, timeoutMs);
}

async function solanaRpc(method, params = []) {
  return jsonRpc(solanaRpcUrl, method, params, timeoutMs);
}

async function jsonRpc(url, method, params, requestTimeoutMs) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) {
    throw new Error(`${method} failed: ${payload.error.message ?? JSON.stringify(payload.error)}`);
  }
  return payload.result;
}

function signatureFromEncodedTransaction(encodedTransaction) {
  if (!encodedTransaction) throw new Error("Kora warmup returned no transaction signature.");
  const decoded = getTransactionDecoder().decode(Buffer.from(encodedTransaction, "base64"));
  return getSignatureFromTransaction(decoded);
}

async function waitForSignature(signature) {
  const deadline = Date.now() + confirmationTimeoutMs;
  while (Date.now() < deadline) {
    const statuses = await solanaRpc("getSignatureStatuses", [[signature]]);
    const status = statuses?.value?.[0];
    if (status) {
      if (status.err) {
        throw new Error(`Kora warmup transaction failed: ${JSON.stringify(status.err)}`);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Kora warmup transaction ${signature} was not observed after ${confirmationTimeoutMs}ms.`
  );
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Kora Surfpool warmup.`);
  return value;
}

function parsePositiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}
