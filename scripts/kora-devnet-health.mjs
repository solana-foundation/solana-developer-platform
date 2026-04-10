const KORA_RPC_URL = process.env.KORA_RPC_URL;
const KORA_API_KEY = process.env.KORA_API_KEY;

const MIN_BALANCE_LAMPORTS = parseNonNegativeInt(process.env.KORA_MIN_BALANCE_LAMPORTS, 1_000_000);
const TIMEOUT_MS = parseNonNegativeInt(process.env.KORA_TIMEOUT_MS, 15_000);

const PUBLIC_KEY_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// biome-ignore lint/nursery/noSecrets: JSON-RPC method name, not a secret.
const GET_LATEST_BLOCKHASH_METHOD = "getLatestBlockhash";

if (!KORA_RPC_URL) {
  fail("Kora devnet health check requires KORA_RPC_URL.");
}

const solanaRpc = await selectHealthySolanaRpc();

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

  const blockhashResponse = await solanaJsonRpc(GET_LATEST_BLOCKHASH_METHOD, [
    { commitment: "confirmed" },
  ]);
  const blockhash = blockhashResponse?.value?.blockhash;
  if (!blockhash || !PUBLIC_KEY_REGEX.test(blockhash)) {
    fail("Solana RPC health check failed: missing latest blockhash.");
  }

  const balanceResponse = await solanaJsonRpc("getBalance", [
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

async function solanaJsonRpc(method, params = []) {
  return jsonRpc(solanaRpc.url, method, params, { "Content-Type": "application/json" });
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

async function selectHealthySolanaRpc() {
  const candidates = getSolanaRpcCandidates();
  if (candidates.length === 0) {
    return undefined;
  }

  const failures = [];
  for (const candidate of candidates) {
    try {
      const response = await jsonRpc(
        candidate.url,
        GET_LATEST_BLOCKHASH_METHOD,
        [{ commitment: "confirmed" }],
        { "Content-Type": "application/json" }
      );
      if (response?.value?.blockhash) {
        return candidate;
      }
      throw new Error("missing latest blockhash");
    } catch (error) {
      failures.push(
        `${candidate.key} (${safeHostname(candidate.url)}): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  fail(`No healthy Solana RPC URL found. Checked: ${failures.join("; ")}`);
}

function getSolanaRpcCandidates() {
  const seen = new Set();

  return solanaRpcKeys().flatMap((key) => {
    const url = process.env[key];
    if (!url || seen.has(url)) {
      return [];
    }

    seen.add(url);
    return [{ key, url }];
  });
}

function solanaRpcKeys() {
  return [
    "SOLANA_RPC_URL",
    "SOLANA_RPC_ALCHEMY_URL",
    "SOLANA_RPC_QUICKNODE_URL",
    "SOLANA_RPC_TRITON_URL",
    "SOLANA_RPC_HELIUS_URL",
  ];
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

function safeHostname(rawUrl) {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "invalid-url";
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
