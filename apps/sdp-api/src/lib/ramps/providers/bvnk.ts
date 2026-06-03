import type { PaymentRampExecution, PaymentRampQuote, SdpEnvironment } from "@sdp/types";
import { parseFiatCurrency } from "@sdp/types/payment-rails";
import { AppError, providerNotConfigured } from "@/lib/errors";
import {
  createProviderRampSupport,
  isSolanaCryptoAsset,
  RAMP_RAIL_DUMPS,
  rampId,
  SOLANA_ASSET_TO_RAIL,
} from "../shared";
import type {
  ProviderRampSupport,
  RampDumpReader,
  RampExecuteOfframpInput,
  RampExecuteOnrampInput,
  RampOfframpQuoteInput,
  RampOnrampQuoteInput,
  RampProvider,
  RampRuntimeContext,
  RampWebhookValidationContext,
  RampWebhookValidationResult,
} from "../types";

const BVNK_PRODUCTION_API_URL = "https://api.bvnk.com";
const BVNK_SANDBOX_API_URL = "https://api.sandbox.bvnk.com";

export interface BvnkComplianceInput {
  /** Client IP, extracted from request headers by the handler (not the provider). */
  requesterIpAddress?: string;
  partyDetails?: Record<string, unknown>[];
}

interface BvnkConfig {
  auth: { authId: string; secretKey: string };
  walletId: string;
  apiBaseUrl: string;
}

function readBvnkConfig(env: Record<string, string | undefined>, mode: SdpEnvironment): BvnkConfig {
  const authId = (
    mode === "sandbox" ? env.BVNK_SANDBOX_HAWK_AUTH_ID : env.BVNK_HAWK_AUTH_ID
  )?.trim();
  const secretKey = (
    mode === "sandbox" ? env.BVNK_SANDBOX_HAWK_SECRET_KEY : env.BVNK_HAWK_SECRET_KEY
  )?.trim();
  const walletId = (mode === "sandbox" ? env.BVNK_SANDBOX_WALLET_ID : env.BVNK_WALLET_ID)?.trim();

  if (!walletId || !authId || !secretKey) {
    throw providerNotConfigured(
      mode === "sandbox"
        ? "BVNK sandbox is not configured. Set BVNK_SANDBOX_WALLET_ID, BVNK_SANDBOX_HAWK_AUTH_ID, and BVNK_SANDBOX_HAWK_SECRET_KEY."
        : "BVNK is not configured. Set BVNK_WALLET_ID, BVNK_HAWK_AUTH_ID, and BVNK_HAWK_SECRET_KEY."
    );
  }

  const apiBaseUrl =
    env.BVNK_API_BASE_URL?.trim() ||
    (mode === "sandbox" ? BVNK_SANDBOX_API_URL : BVNK_PRODUCTION_API_URL);
  try {
    new URL(apiBaseUrl);
  } catch {
    throw new AppError("INTERNAL_ERROR", "BVNK API URL configuration is invalid.");
  }

  return { auth: { authId, secretKey }, walletId, apiBaseUrl };
}

const BVNK_NETWORK_ALIASES: Record<string, string> = {
  algo: "ALGORAND",
  algorand: "ALGORAND",
  ada: "CARDANO",
  cardano: "CARDANO",
  bch: "BITCOIN_CASH",
  bitcoin_cash: "BITCOIN_CASH",
  bitcoincash: "BITCOIN_CASH",
  bnb: "BINANCE",
  binance: "BINANCE",
  btc: "BITCOIN",
  bitcoin: "BITCOIN",
  doge: "DOGECOIN",
  dogecoin: "DOGECOIN",
  eth: "ETHEREUM",
  ethereum: "ETHEREUM",
  ltc: "LITECOIN",
  litecoin: "LITECOIN",
  matic: "POLYGON",
  polygon: "POLYGON",
  sol: "SOLANA",
  solana: "SOLANA",
  tron: "TRON",
  trx: "TRON",
  xrp: "RIPPLE",
  ripple: "RIPPLE",
};

interface BvnkCurrencyNetwork {
  currency: string;
  network: string;
}

function normalizeBvnkCurrencyAndNetwork(value: string): BvnkCurrencyNetwork {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9_]+$/.test(normalized)) {
    throw new AppError("BAD_REQUEST", "cryptoToken must be a valid BVNK currency code");
  }

  const tokenParts = normalized.split("_").filter((part) => part.length > 0);
  const currency = tokenParts[0];
  if (!currency) {
    throw new AppError("BAD_REQUEST", "cryptoToken must include a BVNK currency code");
  }

  const networkHint = tokenParts.length > 1 ? tokenParts[tokenParts.length - 1]?.toLowerCase() : "";
  if (networkHint && BVNK_NETWORK_ALIASES[networkHint]) {
    return { currency, network: BVNK_NETWORK_ALIASES[networkHint] };
  }
  if (currency === "BTC") return { currency, network: "BITCOIN" };
  if (currency === "ETH") return { currency, network: "ETHEREUM" };
  if (currency === "SOL" || currency === "USDC" || currency === "USDT") {
    return { currency, network: "SOLANA" };
  }

  throw new AppError(
    "BAD_REQUEST",
    `Unsupported BVNK cryptoToken '${value}'. Provide token with network (for example: BTC, ETH, SOL, USDC_SOLANA).`
  );
}

function mapBvnkPaymentStatus(status: string | undefined): PaymentRampExecution["status"] {
  if (!status) return "pending";
  const normalized = status.trim().toUpperCase();
  if (
    normalized.includes("COMPLETE") ||
    normalized.includes("PAID") ||
    normalized.includes("SUCCESS")
  ) {
    return "completed";
  }
  if (normalized.includes("PROCESS")) return "processing";
  if (
    normalized.includes("FAIL") ||
    normalized.includes("EXPIRE") ||
    normalized.includes("CANCEL") ||
    normalized.includes("REJECT")
  ) {
    return "failed";
  }
  return "pending";
}

function buildBvnkComplianceDetails(
  input?: BvnkComplianceInput,
  options?: { requirePartyDetails?: boolean }
): { requesterIpAddress?: string; partyDetails: Record<string, unknown>[] } {
  const partyDetails = Array.isArray(input?.partyDetails)
    ? input.partyDetails.filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null && typeof entry === "object" && !Array.isArray(entry)
      )
    : [];

  if (options?.requirePartyDetails && partyDetails.length === 0) {
    throw new AppError(
      "BAD_REQUEST",
      "bvnkCompliance.partyDetails is required for BVNK off-ramp requests."
    );
  }

  return {
    ...(input?.requesterIpAddress ? { requesterIpAddress: input.requesterIpAddress } : {}),
    partyDetails,
  };
}

function safeParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

async function hmacSha256Base64(value: string, secretKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return Buffer.from(signature).toString("base64");
}

async function buildBvnkHawkAuthorizationHeader(
  url: URL,
  method: "GET" | "POST",
  authId: string,
  secretKey: string
): Promise<string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const resource = `${url.pathname}${url.search}`;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");

  const normalized = [
    "hawk.1.header",
    ts,
    nonce,
    method.toUpperCase(),
    resource,
    url.hostname.toLowerCase(),
    port,
    "",
    "",
    "",
  ].join("\n");

  const mac = await hmacSha256Base64(normalized, secretKey);
  return `Hawk id="${authId}", ts="${ts}", nonce="${nonce}", mac="${mac}"`;
}

async function bvnkRequest(
  config: BvnkConfig,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown }
): Promise<unknown> {
  const apiBaseUrl = config.apiBaseUrl.endsWith("/") ? config.apiBaseUrl : `${config.apiBaseUrl}/`;
  const url = new URL(path.replace(/^\//, ""), apiBaseUrl);
  const authorization = await buildBvnkHawkAuthorizationHeader(
    url,
    init.method,
    config.auth.authId,
    config.auth.secretKey
  );
  const response = await fetch(url.toString(), {
    method: init.method,
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const raw = await response.text();
  const parsed = safeParseJson(raw);

  if (!response.ok) {
    const parsedMessage =
      parsed && typeof parsed === "object"
        ? ((parsed as { message?: unknown; error?: unknown; reason?: unknown }).message ??
          (parsed as { message?: unknown; error?: unknown; reason?: unknown }).error ??
          (parsed as { message?: unknown; error?: unknown; reason?: unknown }).reason)
        : undefined;
    const message =
      typeof parsedMessage === "string" && parsedMessage.length > 0
        ? parsedMessage
        : `BVNK request failed with status ${response.status}`;
    throw mapBvnkErrorStatus(response.status, message);
  }

  return parsed ?? {};
}

/**
 * Normalizes a BVNK non-2xx status into an AppError. Auth failures point at our
 * Hawk credential configuration, rate limits surface as-is, and any 5xx is a
 * BVNK-side failure operators should investigate rather than a bad request body.
 */
function mapBvnkErrorStatus(status: number, message: string): AppError {
  if (status === 401 || status === 403) {
    return new AppError(
      "PROVIDER_NOT_CONFIGURED",
      `BVNK rejected the request credentials (status ${status}). Check the BVNK Hawk auth configuration.`
    );
  }
  if (status === 429) {
    return new AppError("RATE_LIMITED", message);
  }
  if (status >= 500) {
    return new AppError("INTERNAL_ERROR", `BVNK request failed with status ${status}.`);
  }
  return new AppError("BAD_REQUEST", message);
}

interface BvnkEstimateResponse {
  externalId?: string;
}

interface BvnkPaymentSummary {
  uuid?: string;
  status?: string;
  redirectUrl?: string;
  reference?: string;
}

function parseBvnkEstimateResponse(payload: unknown): BvnkEstimateResponse {
  if (typeof payload !== "object" || payload === null) {
    throw new AppError("BAD_REQUEST", "BVNK estimate response payload is invalid");
  }
  return payload as BvnkEstimateResponse;
}

function parseBvnkPaymentSummary(payload: unknown): BvnkPaymentSummary {
  if (typeof payload !== "object" || payload === null) {
    throw new AppError("BAD_REQUEST", "BVNK payment response payload is invalid");
  }
  return payload as BvnkPaymentSummary;
}

function toPositiveAmount(value: string, fieldName: string): number {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AppError("BAD_REQUEST", `${fieldName} must be a positive amount`);
  }
  return amount;
}

interface BvnkCurrencyEntry {
  code?: string;
  fiat?: boolean;
  supportsDeposits?: boolean;
  supportsWithdrawals?: boolean;
  protocols?: Array<{ networkCode?: string }>;
}

function extractSupport(
  depositList: readonly BvnkCurrencyEntry[],
  fiatList: readonly BvnkCurrencyEntry[],
  cryptoList: readonly BvnkCurrencyEntry[]
): ProviderRampSupport {
  const support = createProviderRampSupport();

  for (const entry of depositList) {
    if (entry.fiat !== true) continue;
    if (entry.supportsDeposits !== true) continue;
    if (!entry.code) continue;
    const parsed = parseFiatCurrency(entry.code);
    if (parsed) support.onrampFiats.add(parsed);
    else console.warn(`  [bvnk] unknown fiat code: ${entry.code}`);
  }

  for (const entry of fiatList) {
    if (entry.supportsWithdrawals !== true) continue;
    if (!entry.code) continue;
    const parsed = parseFiatCurrency(entry.code);
    if (parsed) support.offrampFiats.add(parsed);
    else console.warn(`  [bvnk] unknown fiat code: ${entry.code}`);
  }

  for (const entry of cryptoList) {
    if (!entry.code) continue;
    const upper = entry.code.toUpperCase();
    if (!isSolanaCryptoAsset(upper)) continue;
    const hasSolana = (entry.protocols ?? []).some((p) => p.networkCode === "SOLANA");
    if (!hasSolana) continue;
    const rail = SOLANA_ASSET_TO_RAIL[upper];
    if (entry.supportsWithdrawals === true) support.onrampCryptos.add(rail);
    if (entry.supportsDeposits === true) support.offrampCryptos.add(rail);
  }

  return support;
}

export class BvnkRampClient implements RampProvider {
  readonly id = "bvnk";

  async _discoverRails({
    env,
    fetchJson,
    writeDump,
  }: Parameters<RampProvider["_discoverRails"]>[0]) {
    const base = env.BVNK_RAMP_RAILS_API_BASE_URL?.trim() || "https://api.bvnk.com/";
    // biome-ignore lint/security/noSecrets: BVNK pagination query string, not a secret.
    const pageQuery = "?offset=0&max=1000";

    for (const request of [
      {
        path: `/api/currency/crypto${pageQuery}`,
        dumpName: RAMP_RAIL_DUMPS.bvnk.cryptoAnon.name,
      },
      {
        path: `/api/currency/fiat${pageQuery}`,
        dumpName: RAMP_RAIL_DUMPS.bvnk.fiatAnon.name,
      },
      {
        path: `/api/currency/deposit${pageQuery}`,
        dumpName: RAMP_RAIL_DUMPS.bvnk.depositAnon.name,
      },
    ]) {
      const url = new URL(request.path.replace(/^\//, ""), base);
      await writeDump(
        request.dumpName,
        await fetchJson(this.id, `anon ${request.path}`, url.toString(), {
          headers: {
            Accept: "application/json",
          },
        })
      );
    }
  }

  async readRailSupport(readDump: RampDumpReader): Promise<ProviderRampSupport> {
    return extractSupport(
      await readDump<readonly BvnkCurrencyEntry[]>(RAMP_RAIL_DUMPS.bvnk.depositAnon.file),
      await readDump<readonly BvnkCurrencyEntry[]>(RAMP_RAIL_DUMPS.bvnk.fiatAnon.file),
      await readDump<readonly BvnkCurrencyEntry[]>(RAMP_RAIL_DUMPS.bvnk.cryptoAnon.file)
    );
  }

  async validateWebhook(
    _context: RampWebhookValidationContext
  ): Promise<RampWebhookValidationResult> {
    throw new AppError("PROVIDER_NOT_CONFIGURED", "BVNK webhook validation is not implemented", {
      provider: this.id,
    });
  }

  async createOnrampQuote(
    _ctx: RampRuntimeContext,
    _input: RampOnrampQuoteInput
  ): Promise<PaymentRampQuote> {
    throw new AppError("BAD_REQUEST", "BVNK on-ramp quotes are not supported.");
  }

  async createOfframpQuote(
    _ctx: RampRuntimeContext,
    _input: RampOfframpQuoteInput
  ): Promise<PaymentRampQuote> {
    throw new AppError("BAD_REQUEST", "BVNK off-ramp quotes are not supported.");
  }

  async executeOnramp(
    { env, mode }: RampRuntimeContext,
    input: RampExecuteOnrampInput
  ): Promise<PaymentRampExecution> {
    const customerId = input.kycReference?.trim();
    if (!customerId) {
      throw new AppError(
        "BAD_REQUEST",
        "kycReference is required for BVNK onramp and must contain a BVNK customer id"
      );
    }

    const config = readBvnkConfig(env, mode);
    const { currency, network } = normalizeBvnkCurrencyAndNetwork(input.cryptoToken);
    const fiatCurrency = input.fiatCurrency ?? "USD";
    const amount = toPositiveAmount(input.fiatAmount, "fiatAmount");
    const externalReference = rampId("sdp_onramp");
    const complianceDetails = buildBvnkComplianceDetails(input.bvnkCompliance);

    const response = await bvnkRequest(config, "/api/v1/pay/summary", {
      method: "POST",
      body: {
        walletId: config.walletId,
        amount,
        currency: fiatCurrency,
        type: "IN",
        reference: externalReference,
        customerId,
        returnUrl: input.redirectUrl,
        payOutDetails: {
          code: "crypto",
          currency,
          address: input.destinationWalletAddress,
          network,
        },
        complianceDetails,
      },
    });

    const summary = parseBvnkPaymentSummary(response);
    return {
      id: rampId("ramp"),
      provider: "bvnk",
      status: mapBvnkPaymentStatus(summary.status),
      redirectUrl: typeof summary.redirectUrl === "string" ? summary.redirectUrl : undefined,
      reference:
        typeof summary.uuid === "string"
          ? summary.uuid
          : typeof summary.reference === "string"
            ? summary.reference
            : externalReference,
    };
  }

  async executeOfframp(
    { env, mode }: RampRuntimeContext,
    input: RampExecuteOfframpInput
  ): Promise<PaymentRampExecution> {
    const customerId = input.kycReference?.trim();
    if (!customerId) {
      throw new AppError(
        "BAD_REQUEST",
        "kycReference is required for BVNK offramp and must contain a BVNK customer id"
      );
    }

    const config = readBvnkConfig(env, mode);
    const { currency, network } = normalizeBvnkCurrencyAndNetwork(input.cryptoToken);
    const fiatCurrency = input.fiatCurrency ?? "USD";
    const paidRequiredAmount = toPositiveAmount(input.cryptoAmount, "cryptoAmount");
    const externalReference = rampId("sdp_offramp");
    const complianceDetails = buildBvnkComplianceDetails(input.bvnkCompliance, {
      requirePartyDetails: true,
    });

    const estimateResponse = await bvnkRequest(config, "/api/v1/pay/estimate", {
      method: "POST",
      body: {
        walletId: config.walletId,
        walletCurrency: fiatCurrency,
        paidCurrency: currency,
        paidRequiredAmount,
        reference: externalReference,
        network,
        complianceDetails,
      },
    });

    const estimate = parseBvnkEstimateResponse(estimateResponse);
    if (!estimate.externalId) {
      throw new AppError("BAD_REQUEST", "BVNK estimate response is missing externalId");
    }

    const summaryResponse = await bvnkRequest(
      config,
      `/api/v1/pay/estimate/${encodeURIComponent(estimate.externalId)}/accept`,
      {
        method: "POST",
        body: {
          customerId,
          payOutDetails: { currency, address: input.sourceWalletAddress, network },
          complianceDetails,
        },
      }
    );

    const summary = parseBvnkPaymentSummary(summaryResponse);
    return {
      id: rampId("ramp"),
      provider: "bvnk",
      status: mapBvnkPaymentStatus(summary.status),
      redirectUrl: typeof summary.redirectUrl === "string" ? summary.redirectUrl : undefined,
      reference:
        typeof summary.uuid === "string"
          ? summary.uuid
          : typeof summary.reference === "string"
            ? summary.reference
            : estimate.externalId,
    };
  }
}
