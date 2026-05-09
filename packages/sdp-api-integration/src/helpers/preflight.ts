import { KoraClient } from "@sdp/api/services/adapters";
import { env } from "./env";

type SolanaRpcResponse<T> =
  | { jsonrpc: "2.0"; id: number; result: T }
  | { jsonrpc: "2.0"; id: number; error: { code: number; message: string; data?: unknown } };

const PRECHECK_CACHE_KEY = "__sdp_integration_preflight__";
const REQUIRED_KORA_ALLOWED_PROGRAMS = [
  // biome-ignore lint/security/noSecrets: Public Solana program ID, not a secret.
  "TACLkU6CiCdkQN2MjoyDkVg2yAH9zkxiHDsiztQ52TP",
  // biome-ignore lint/security/noSecrets: Public Solana program ID, not a secret.
  "GATEzzqxhJnsWF6vHRsgtixxSB8PaQdcqGEVTEHWiULz",
] as const;

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
  if (!env.PRIVY_APP_ID) missing.push("PRIVY_APP_ID");
  if (!env.PRIVY_APP_SECRET) missing.push("PRIVY_APP_SECRET");
  if (!env.KORA_RPC_URL) missing.push("KORA_RPC_URL");

  if (missing.length > 0) {
    throw new Error(
      `Integration tests require the following env vars to be set: ${missing.join(", ")}`
    );
  }

  // Narrow optional env vars to concrete strings (Biome forbids non-null assertions).
  const solanaRpcUrl = env.SOLANA_RPC_URL;
  const koraUrl = env.KORA_RPC_URL;
  if (!solanaRpcUrl || !koraUrl) {
    // This should be unreachable because of the `missing` check above.
    throw new Error("Integration preflight internal error: required env vars were missing.");
  }

  // Validate Solana RPC connectivity early so failures are explicit.
  await assertSolanaRpcHealthy(solanaRpcUrl);

  // Validate Kora connectivity and that it can sponsor transactions (fee payer exists and is funded).
  const koraClient = new KoraClient({
    rpcUrl: koraUrl,
    ...(env.KORA_API_KEY ? { apiKey: env.KORA_API_KEY } : {}),
  });

  const config = await withLabel("Kora.getConfig", () => koraClient.getConfig());
  if (!config?.validation_config?.allowed_programs) {
    throw new Error("Kora preflight failed: missing validation_config.allowed_programs");
  }
  const missingAllowedPrograms = REQUIRED_KORA_ALLOWED_PROGRAMS.filter(
    (program) => !config.validation_config.allowed_programs.includes(program)
  );
  if (missingAllowedPrograms.length > 0) {
    throw new Error(
      `Kora preflight failed: missing required sRFC-37 allowed programs: ${missingAllowedPrograms.join(", ")}. Update Kora validation_config.allowed_programs.`
    );
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

async function solanaRpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await withTimeout(
        15_000,
        fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body })
      );

      const json = (await res.json()) as SolanaRpcResponse<T>;
      if ("error" in json) {
        throw new Error(`Solana RPC error calling ${method}: ${json.error.message}`);
      }
      return json.result;
    } catch (error) {
      if (attempt < maxRetries && isRetryableSolanaRpcError(error)) {
        await sleep((attempt + 1) * 500);
        continue;
      }

      throw error;
    }
  }

  throw new Error(`Solana RPC error calling ${method}`);
}

function isRetryableSolanaRpcError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("unable to complete request") ||
    message.includes("request timed out") ||
    message.includes("timed out") ||
    message.includes("service unavailable") ||
    message.includes("try again") ||
    message.includes("too many requests") ||
    message.includes("429") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
