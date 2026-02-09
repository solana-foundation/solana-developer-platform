import { KoraClient } from "@sdp/api/services/adapters";
import { createSignerFromBase58 } from "@sdp/api/services/solana";
import { env } from "./env";

type SolanaRpcResponse<T> =
  | { jsonrpc: "2.0"; id: number; result: T }
  | { jsonrpc: "2.0"; id: number; error: { code: number; message: string; data?: unknown } };

const PRECHECK_CACHE_KEY = "__sdp_integration_preflight__";

type PreflightState = {
  promise: Promise<void>;
};

function getPreflightState(): PreflightState {
  const g = globalThis as unknown as Record<string, unknown>;
  let state = g[PRECHECK_CACHE_KEY] as PreflightState | undefined;
  if (!state) {
    state = { promise: runPreflight() };
    g[PRECHECK_CACHE_KEY] = state;
  }
  return state;
}

export async function ensureIntegrationPreflight(): Promise<void> {
  await getPreflightState().promise;
}

async function runPreflight(): Promise<void> {
  const missing: string[] = [];
  if (!env.SOLANA_RPC_URL) missing.push("SOLANA_RPC_URL");
  if (!env.CUSTODY_PRIVATE_KEY) missing.push("CUSTODY_PRIVATE_KEY");
  if (!env.KORA_RPC_URL) missing.push("KORA_RPC_URL");

  if (missing.length > 0) {
    throw new Error(
      `Integration tests require the following env vars to be set: ${missing.join(", ")}`
    );
  }

  // Narrow optional env vars to concrete strings (Biome forbids non-null assertions).
  const solanaRpcUrl = env.SOLANA_RPC_URL;
  const custodyPrivateKey = env.CUSTODY_PRIVATE_KEY;
  const koraUrl = env.KORA_RPC_URL;
  if (!solanaRpcUrl || !custodyPrivateKey || !koraUrl) {
    // This should be unreachable because of the `missing` check above.
    throw new Error("Integration preflight internal error: required env vars were missing.");
  }

  // Validate Solana RPC connectivity early so failures are explicit.
  await assertSolanaRpcHealthy(solanaRpcUrl);

  // Ensure the custody signer exists on-chain.
  //
  // Even with Kora fee sponsorship, some downstream libraries (ex: Mosaic SDK) expect the
  // authority account to exist (ie. have been created with at least 1 lamport) and will error
  // if RPC returns `null` for getAccountInfo(publicKey).
  await ensureCustodyAccountExists(solanaRpcUrl, custodyPrivateKey);

  // Validate Kora connectivity and that it can sponsor transactions (fee payer exists and is funded).
  const koraClient = new KoraClient({
    rpcUrl: koraUrl,
    ...(env.KORA_API_KEY ? { apiKey: env.KORA_API_KEY } : {}),
  });

  const config = await withLabel("Kora.getConfig", () => koraClient.getConfig());
  if (!config?.validation_config?.allowed_programs) {
    throw new Error("Kora preflight failed: missing validation_config.allowed_programs");
  }

  const payerSignerResp = await withLabel("Kora.getPayerSigner", () => koraClient.getPayerSigner());
  const feePayerAddress =
    (payerSignerResp as { signer_address?: string }).signer_address ??
    (payerSignerResp as { payment_address?: string }).payment_address ??
    (payerSignerResp as { payerSigner?: string }).payerSigner;

  if (!feePayerAddress) {
    throw new Error(
      "Kora preflight failed: fee payer address missing (expected signer_address/payment_address/payerSigner)"
    );
  }

  const feePayerLamports = await solanaGetBalance(solanaRpcUrl, feePayerAddress);
  const minLamports = getKoraMinBalanceLamports();
  if (feePayerLamports < minLamports) {
    throw new Error(
      `Kora preflight failed: fee payer balance too low (${feePayerLamports} lamports, min ${minLamports}).`
    );
  }
}

async function ensureCustodyAccountExists(rpcUrl: string, custodyPrivateKeyBase58: string) {
  const signer = await createSignerFromBase58(custodyPrivateKeyBase58);
  const custodyAddress = signer.address;

  const exists = await solanaAccountExists(rpcUrl, custodyAddress);
  if (exists) return;

  // Devnet-only convenience: request a small airdrop so the account exists on-chain.
  // If the RPC provider blocks airdrops, we fail fast with actionable instructions.
  const airdropLamports = 1_000_000; // 0.001 SOL is enough to create the account.
  // biome-ignore lint/nursery/noSecrets: label string (false positive).
  await withLabel("Solana.requestAirdrop(custody)", async () => {
    await solanaRequestAirdrop(rpcUrl, custodyAddress, airdropLamports);
    await waitForAccountExistence(rpcUrl, custodyAddress, 30_000);
  }).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Custody signer does not exist on-chain (${custodyAddress}). ` +
        `Fund it once on devnet (ex: request an airdrop) then rerun. Details: ${msg}`
    );
  });
}

function getKoraMinBalanceLamports(): number {
  const raw = (env as unknown as Record<string, unknown>).KORA_MIN_BALANCE_LAMPORTS;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  // Default to 0.001 SOL which is enough for many transactions while avoiding false failures.
  return 1_000_000;
}

async function assertSolanaRpcHealthy(rpcUrl: string): Promise<void> {
  type LatestBlockhash = {
    value: { blockhash: string; lastValidBlockHeight: number };
  };
  // biome-ignore lint/nursery/noSecrets: JSON-RPC method name (false positive).
  const resp = await solanaRpc<LatestBlockhash>(rpcUrl, "getLatestBlockhash", [
    { commitment: "confirmed" },
  ]);
  const blockhash = resp?.value?.blockhash;
  if (!blockhash) {
    throw new Error("Solana RPC preflight failed: missing blockhash");
  }
}

async function solanaGetBalance(rpcUrl: string, address: string): Promise<number> {
  type Balance = { value: number };
  const resp = await solanaRpc<Balance>(rpcUrl, "getBalance", [
    address,
    { commitment: "confirmed" },
  ]);
  return resp.value ?? 0;
}

async function solanaAccountExists(rpcUrl: string, address: string): Promise<boolean> {
  type AccountInfo = {
    value: null | {
      lamports: number;
      owner: string;
      executable: boolean;
      rentEpoch: number;
      data: [string, string];
    };
  };

  const resp = await solanaRpc<AccountInfo>(rpcUrl, "getAccountInfo", [
    address,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  return resp.value !== null;
}

async function solanaRequestAirdrop(
  rpcUrl: string,
  address: string,
  lamports: number
): Promise<string> {
  // Many public RPC providers disable airdrops; we surface a clear error if so.
  return await solanaRpc<string>(rpcUrl, "requestAirdrop", [address, lamports]);
}

async function waitForAccountExistence(rpcUrl: string, address: string, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await solanaAccountExists(rpcUrl, address);
    if (exists) return;
    // eslint-disable-next-line no-await-in-loop
    await sleep(1_000);
  }
  throw new Error(`Timed out waiting for account ${address} to exist on-chain.`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function solanaRpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const res = await withTimeout(
    15_000,
    fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body })
  );

  const json = (await res.json()) as SolanaRpcResponse<T>;
  if ("error" in json) {
    throw new Error(`Solana RPC error calling ${method}: ${json.error.message}`);
  }
  return json.result;
}

async function withTimeout<T>(ms: number, promise: Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    // If the passed promise is a fetch, it will respect AbortController.
    // If it's not, this still enforces an upper bound on the awaited time.
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        controller.signal.addEventListener("abort", () =>
          reject(new Error(`Timed out after ${ms}ms`))
        )
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withLabel<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await withTimeout(15_000, fn());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} failed: ${msg}`);
  }
}
