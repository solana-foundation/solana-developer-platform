import { apiTestSupport } from "@sdp/api/test-support";
import { probeGatewayHealth } from "@sdp/private-channels";
import { withTransientRpcRetry } from "@sdp/rpc";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { address as toAddress } from "@solana/kit";
import { env } from "#env-impl";
import { getIntegrationCustodyProvider } from "./custody-provider";
import {
  getIntegrationLaneKora,
  getIntegrationLaneRpc,
  laneRpcPoolEnvKeyPattern,
} from "./kora-lane";
import { privateChannelProbeTransport } from "./private-channels";

const { DVP_SWAP_PROGRAM_PROGRAM_ADDRESS, KoraClient } = apiTestSupport;

const PRECHECK_CACHE_KEY = "__sdp_integration_preflight__";
// biome-ignore lint/security/noSecrets: Public Solana program ID, not a secret.
const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const REQUIRED_SURFPOOL_ALLOWED_PROGRAMS = [
  // biome-ignore lint/security/noSecrets: Public Solana program ID, not a secret.
  "TACLkU6CiCdkQN2MjoyDkVg2yAH9zkxiHDsiztQ52TP",
  // biome-ignore lint/security/noSecrets: Public Solana program ID, not a secret.
  "GATEzzqxhJnsWF6vHRsgtixxSB8PaQdcqGEVTEHWiULz",
  MEMO_PROGRAM_ADDRESS,
] as const;
const REQUIRED_LIVE_KORA_ALLOWED_PROGRAMS = [MEMO_PROGRAM_ADDRESS] as const;
const SOLANA_RPC_PREFLIGHT_TIMEOUT_MS = 15_000;

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
  // Suite scope is explicit when SDP_INTEGRATION_SUITE is set (e.g. `kora`, `spc`,
  // `kora,spc`); otherwise it is inferred from configured env for back-compat, so
  // existing Kora/on-chain shards keep working unchanged.
  const requested = getRequestedSuites();
  const laneKoraConfigured = !!getIntegrationLaneKora().rpcUrl;
  const koraInScope = requested ? requested.has("kora") : laneKoraConfigured;
  // DvP needs a cluster, custody signer, and Kora sponsorship. Private Channels
  // remains independent because the DvP lane never calls its gateway.
  const dvpInScope = requested === null ? false : requested.has("dvp");
  const spcInScope = requested
    ? requested.has("spc")
    : !laneKoraConfigured && !!readEnv("PRIVATE_CHANNEL_GATEWAY_URL");

  if (!koraInScope && !spcInScope && !dvpInScope) {
    // biome-ignore lint/security/noSecrets: environment variable names in a help message, not a secret.
    const suites = "SDP_INTEGRATION_SUITE=kora|spc|dvp";
    throw new Error(
      `Integration preflight: no suite in scope. Set ${getIntegrationLaneKora().rpcUrlEnvKey} or PRIVATE_CHANNEL_GATEWAY_URL, or select explicitly with ${suites}.`
    );
  }

  // Each scope validates only its own dependencies: an SPC-only run must not
  // require Kora, or the Private Channels suites are unreachable without standing
  // up a Kora harness they never call.
  if (koraInScope || dvpInScope) {
    await preflightKoraSuite();
  }
  if (spcInScope) {
    await preflightSpcSuite();
  }
  if (dvpInScope) {
    await preflightDvpSuite();
  }
}

/**
 * What a DvP run actually needs: a cluster, Kora sponsorship, and a custody
 * signer to be the organization's side of a trade.
 *
 * Deliberately short. Everything else DvP touches — the settlement authority,
 * the escrows, the policy rows — is created by the code under test, and a
 * pre-flight that provisioned them would be checking its own fixture rather
 * than the product.
 */
async function preflightDvpSuite(): Promise<void> {
  const integrationCustodyProvider = getIntegrationCustodyProvider();
  const missing: string[] = [];
  if (!getIntegrationLaneRpc()) missing.push(laneRpcPoolEnvKeyPattern());
  const laneKora = getIntegrationLaneKora();
  if (!laneKora.rpcUrl) missing.push(laneKora.rpcUrlEnvKey);
  if (integrationCustodyProvider === "local" && !env.CUSTODY_PRIVATE_KEY) {
    missing.push("CUSTODY_PRIVATE_KEY");
  }
  if (missing.length > 0) {
    throw new Error(`Integration preflight (dvp): missing ${missing.join(", ")}.`);
  }
}

function readEnv(key: string): string {
  const value = (env as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

async function preflightSpcSuite(): Promise<void> {
  const missing: string[] = [];
  const gatewayUrl = readEnv("PRIVATE_CHANNEL_GATEWAY_URL");
  if (!gatewayUrl) missing.push("PRIVATE_CHANNEL_GATEWAY_URL");

  if (missing.length > 0) {
    throw new Error(
      `Private Channels integration tests require the following env vars to be set: ${missing.join(", ")}`
    );
  }

  // Fail with "the gateway is down" rather than letting each test time out.
  const health = await withLabel("PrivateChannels.probeGatewayHealth", () =>
    probeGatewayHealth(gatewayUrl, privateChannelProbeTransport)
  );
  if (health.status === "unreachable") {
    throw new Error(
      `Private Channels preflight failed: gateway ${safeHost(gatewayUrl)} is unreachable (${health.error ?? "no error reported"}).`
    );
  }
}

/** Host and port only — the gateway URL may carry a provider key. */
function safeHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return "<invalid url>";
  }
}

function getRequestedSuites(): Set<string> | null {
  const raw = (env as { SDP_INTEGRATION_SUITE?: string }).SDP_INTEGRATION_SUITE;
  if (!raw || raw.trim() === "") {
    return null;
  }
  return new Set(
    raw
      .split(",")
      .map((suite) => suite.trim().toLowerCase())
      .filter(Boolean)
  );
}

async function preflightKoraSuite(): Promise<void> {
  const integrationCustodyProvider = getIntegrationCustodyProvider();
  const missing: string[] = [];
  const laneRpc = getIntegrationLaneRpc();
  if (!laneRpc) missing.push(laneRpcPoolEnvKeyPattern());
  const laneKora = getIntegrationLaneKora();
  if (!laneKora.rpcUrl) missing.push(laneKora.rpcUrlEnvKey);
  if (integrationCustodyProvider === "local") {
    if (!env.CUSTODY_PRIVATE_KEY) missing.push("CUSTODY_PRIVATE_KEY");
  } else {
    if (!env.PRIVY_APP_ID) missing.push("PRIVY_APP_ID");
    if (!env.PRIVY_APP_SECRET) missing.push("PRIVY_APP_SECRET");
  }

  if (missing.length > 0) {
    throw new Error(
      `Integration tests require the following env vars to be set: ${missing.join(", ")}`
    );
  }

  // Narrow optional env vars to concrete strings (Biome forbids non-null assertions).
  const koraUrl = laneKora.rpcUrl;
  if (!laneRpc || !koraUrl) {
    // This should be unreachable because of the `missing` check above.
    throw new Error("Integration preflight internal error: required env vars were missing.");
  }

  // Validate Kora connectivity and that it can sponsor transactions (fee payer exists and is funded).
  const koraClient = new KoraClient({
    rpcUrl: koraUrl,
    ...(laneKora.apiKey ? { apiKey: laneKora.apiKey } : {}),
  });

  // These are independent read-only checks. Run them together so the two Kora
  // requests cannot consume the setup hook budget ahead of the bounded RPC retries.
  const [, config, payerSignerResp] = await Promise.all([
    assertSolanaRpcHealthy(laneRpc),
    withLabel("Kora.getConfig", () => koraClient.getConfig()),
    withLabel("Kora.getPayerSigner", () => koraClient.getPayerSigner()),
  ]);

  if (!config?.validation_config?.allowed_programs) {
    throw new Error("Kora preflight failed: missing validation_config.allowed_programs");
  }
  const requiredAllowedPrograms = getRequiredKoraAllowedPrograms();
  const missingAllowedPrograms = requiredAllowedPrograms.filter(
    (program) => !config.validation_config.allowed_programs.includes(program)
  );
  if (missingAllowedPrograms.length > 0) {
    throw new Error(
      `Kora preflight failed: missing required ${getKoraPreflightScopeLabel()} allowed programs: ${missingAllowedPrograms.join(", ")}. Update Kora validation_config.allowed_programs.`
    );
  }

  const feePayerAddress =
    (payerSignerResp as { signer_address?: string }).signer_address ??
    (payerSignerResp as { payment_address?: string }).payment_address ??
    (payerSignerResp as { payerSigner?: string }).payerSigner;

  if (!feePayerAddress) {
    throw new Error(
      "Kora preflight failed: fee payer address missing (expected signer_address/payment_address/payerSigner)"
    );
  }

  const feePayerLamports = await solanaGetBalance(laneRpc, feePayerAddress);
  const minLamports = getKoraMinBalanceLamports();
  if (feePayerLamports < minLamports) {
    throw new Error(
      `Kora preflight failed: fee payer balance too low (${feePayerLamports} lamports, min ${minLamports}).`
    );
  }
}

function getRequiredKoraAllowedPrograms(): readonly string[] {
  const requested = getRequestedSuites();
  const dvpRequired = requested === null ? false : requested.has("dvp");
  const base = isKoraSurfpoolShim()
    ? REQUIRED_SURFPOOL_ALLOWED_PROGRAMS
    : REQUIRED_LIVE_KORA_ALLOWED_PROGRAMS;
  return dvpRequired ? [...base, DVP_SWAP_PROGRAM_PROGRAM_ADDRESS] : base;
}

function getKoraPreflightScopeLabel(): string {
  const requested = getRequestedSuites();
  if (requested === null ? false : requested.has("dvp")) {
    return "DvP";
  }
  if (isKoraSurfpoolShim()) {
    return "Surfpool-backed SDP";
  }

  return "live smoke";
}

function isKoraSurfpoolShim(): boolean {
  return (env as { KORA_SURFPOOL_SHIM?: string }).KORA_SURFPOOL_SHIM === "true";
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

async function assertSolanaRpcHealthy(rpc: SolanaRpc): Promise<void> {
  const response = await withTransientRpcRetry(() =>
    rpc
      .getLatestBlockhash({ commitment: "confirmed" })
      .send({ abortSignal: AbortSignal.timeout(SOLANA_RPC_PREFLIGHT_TIMEOUT_MS) })
  );
  if (!response.value.blockhash) {
    throw new Error("Solana RPC preflight failed: missing blockhash");
  }
}

async function solanaGetBalance(rpc: SolanaRpc, address: string): Promise<number> {
  const response = await withTransientRpcRetry(() =>
    rpc
      .getBalance(toAddress(address), { commitment: "confirmed" })
      .send({ abortSignal: AbortSignal.timeout(SOLANA_RPC_PREFLIGHT_TIMEOUT_MS) })
  );
  return Number(response.value);
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
