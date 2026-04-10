import {
  safeHostname,
  selectHealthySolanaRpcUrl,
  solanaJsonRpc,
  solanaRpcKeys,
} from "./lib/solana-rpc-health.mjs";

const KORA_RPC_URL = process.env.KORA_RPC_URL;
const KORA_API_KEY = process.env.KORA_API_KEY;

const MIN_BALANCE_LAMPORTS = parseNonNegativeInt(process.env.KORA_MIN_BALANCE_LAMPORTS, 1_000_000);
const TIMEOUT_MS = parseNonNegativeInt(process.env.KORA_TIMEOUT_MS, 15_000);

const PUBLIC_KEY_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

if (!KORA_RPC_URL) {
  fail("Kora devnet health check requires KORA_RPC_URL.");
}

const solanaRpc = await selectHealthySolanaRpcUrl(process.env, { timeoutMs: TIMEOUT_MS });

if (!solanaRpc) {
  const missing = [];
  for (const key of solanaRpcKeys()) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }

  fail(`Kora devnet health check requires ${missing.join(", ")}.`);
}

try {
  await checkKoraLiveness(KORA_RPC_URL);

  const config = await koraRpc("getConfig");
  if (!config?.validation_config?.allowed_programs) {
    fail("Kora health check failed: missing validation_config.allowed_programs.");
  }

  const payerResponse = await koraRpc("getPayerSigner");
  const feePayerAddress =
    payerResponse?.signer_address ?? payerResponse?.payment_address ?? payerResponse?.payerSigner;

  if (!feePayerAddress || !PUBLIC_KEY_REGEX.test(feePayerAddress)) {
    fail("Kora health check failed: invalid or missing fee payer address.");
  }

  // biome-ignore lint/nursery/noSecrets: JSON-RPC method name, not a secret.
  const blockhashResponse = await solanaJsonRpc(solanaRpc.url, "getLatestBlockhash", [
    { commitment: "confirmed" },
  ]);
  const blockhash = blockhashResponse?.value?.blockhash;
  if (!blockhash || !PUBLIC_KEY_REGEX.test(blockhash)) {
    fail("Solana RPC health check failed: missing latest blockhash.");
  }

  const balanceResponse = await solanaJsonRpc(solanaRpc.url, "getBalance", [
    feePayerAddress,
    { commitment: "confirmed" },
  ]);
  const feePayerLamports = balanceResponse?.value ?? 0;
  if (feePayerLamports < MIN_BALANCE_LAMPORTS) {
    fail(
      `Kora fee payer balance too low: ${feePayerLamports} lamports, min ${MIN_BALANCE_LAMPORTS}.`
    );
  }

  console.log(
    `Kora devnet health check passed using ${solanaRpc.key} (${safeHostname(
      solanaRpc.url
    )}). Fee payer ${feePayerAddress} has ${feePayerLamports} lamports.`
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

async function checkKoraLiveness(koraUrl) {
  const response = await fetchWithTimeout(new URL("/liveness", koraUrl), {
    headers: requestHeaders(),
  });

  if (!response.ok) {
    fail(`Kora liveness check failed with HTTP ${response.status}.`);
  }
}

async function koraRpc(method, params = []) {
  return jsonRpc(KORA_RPC_URL, method, params, requestHeaders());
}

async function jsonRpc(url, method, params, headers) {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  if (!response.ok) {
    throw new Error(`${method} failed with HTTP ${response.status}.`);
  }

  const payload = await response.json();
  if (payload.error) {
    throw new Error(`${method} failed: ${payload.error.message ?? "unknown JSON-RPC error"}`);
  }

  return payload.result;
}

function requestHeaders() {
  return {
    "Content-Type": "application/json",
    ...(KORA_API_KEY ? { "x-api-key": KORA_API_KEY } : {}),
  };
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function parseNonNegativeInt(raw, fallback) {
  if (!raw) return fallback;

  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
