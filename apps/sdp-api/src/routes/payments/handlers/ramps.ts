import type { SdpEnvironment } from "@sdp/types";
import { getDb } from "@/db";
import { parseDecimalAmount } from "@/lib/amount";
import { AppError, providerNotConfigured } from "@/lib/errors";
import { success } from "@/lib/response";
import { isAddress } from "@/lib/solana";
import { assertProviderAvailable } from "@/services/provider-availability.service";
import type { AppContext } from "../context";
import { assertWalletPolicyAllowsTransfer } from "../policy";
import { executeOfframpSchema, executeOnrampSchema } from "../schemas";
import { type ResolvedScope, resolveScope, resolveWalletAddress } from "../wallets";

const MOONPAY_ONRAMP_URL = "https://buy.moonpay.com";
const MOONPAY_OFFRAMP_URL = "https://sell.moonpay.com";
const MOONPAY_SANDBOX_ONRAMP_URL = "https://buy-sandbox.moonpay.com";
const MOONPAY_SANDBOX_OFFRAMP_URL = "https://sell-sandbox.moonpay.com";
const MOONPAY_ONRAMP_MIN_USD = 20;
const BVNK_PRODUCTION_API_URL = "https://api.bvnk.com";
const BVNK_SANDBOX_API_URL = "https://api.sandbox.bvnk.com";

type RampExecutionStatus = "pending" | "processing" | "completed" | "failed";

type RampExecutionResult = {
  id: string;
  provider: string;
  status: RampExecutionStatus;
  redirectUrl?: string;
  reference?: string;
};

type BvnkComplianceInput = {
  partyDetails?: Record<string, unknown>[];
};

type RampProviderId = "moonpay" | "lightspark" | "bvnk";

type ExecuteOnrampInput = {
  provider: RampProviderId;
  destinationWallet: string;
  cryptoToken: string;
  fiatCurrency?: "USD";
  fiatAmount: string;
  kycReference?: string;
  redirectUrl?: string;
  bvnkCompliance?: BvnkComplianceInput;
};

type ExecuteOfframpInput = {
  provider: RampProviderId;
  sourceWallet: string;
  cryptoToken: string;
  fiatCurrency?: "USD";
  cryptoAmount: string;
  kycReference?: string;
  redirectUrl?: string;
  bvnkCompliance?: BvnkComplianceInput;
};

type ExecuteRampInput =
  | ({ direction: "onramp" } & ExecuteOnrampInput)
  | ({ direction: "offramp" } & ExecuteOfframpInput);

type RampProviderExecutor = {
  executeOnramp: (
    c: AppContext,
    scope: ResolvedScope,
    input: ExecuteOnrampInput
  ) => Promise<RampExecutionResult>;
  executeOfframp: (
    c: AppContext,
    scope: ResolvedScope,
    input: ExecuteOfframpInput
  ) => Promise<RampExecutionResult>;
};

function normalizeMoonPayCurrencyCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9_]+$/.test(normalized)) {
    throw new AppError(
      "BAD_REQUEST",
      "cryptoToken must be a valid token symbol or MoonPay currency code"
    );
  }

  if (normalized === "USDC") {
    return "usdc_sol";
  }

  if (normalized === "USDT") {
    return "usdt_sol";
  }

  if (normalized.endsWith("_SOLANA")) {
    return `${normalized.slice(0, -"_SOLANA".length)}_SOL`.toLowerCase();
  }

  return normalized.toLowerCase();
}

/**
 * Resolves the product environment for provider credentials.
 * API-key callers are scoped by the key. Dashboard/session callers default to
 * sandbox while that is the only supported dashboard mode.
 */
function resolveSdpEnvironment(c: AppContext): SdpEnvironment {
  const apiKey = c.get("apiKey");
  if (apiKey) {
    return apiKey.environment;
  }
  return "sandbox";
}

interface RampsProviderEnvironment {
  sandbox: string | undefined;
  production: string | undefined;
}

function envForMode(mode: SdpEnvironment, env: RampsProviderEnvironment): string | undefined {
  return env[mode]?.trim();
}

function configForMode<T extends Record<string, RampsProviderEnvironment>>(
  mode: SdpEnvironment,
  envs: T
): Record<keyof T, string | undefined> {
  return Object.fromEntries(
    Object.entries(envs).map(([key, env]) => [key, envForMode(mode, env)])
  ) as Record<keyof T, string | undefined>;
}

type MoonPayConfig = {
  apiKey: string;
  secretKey: string;
  onrampUrl: string;
  offrampUrl: string;
};

type LightsparkConfig = {
  tokenId: string;
  clientSecret: string;
  apiBaseUrl: string;
};

type BvnkAuthConfig = { type: "hawk"; authId: string; secretKey: string };

type BvnkConfig = {
  auth: BvnkAuthConfig;
  walletId: string;
  apiBaseUrl: string;
};

type LightsparkQuoteStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "EXPIRED";

type LightsparkQuote = {
  id?: string;
  quoteStatus?: LightsparkQuoteStatus;
  status?: LightsparkQuoteStatus;
  paymentInstructions?: {
    url?: string;
  };
};

type LightsparkExternalAccount = {
  id?: string;
  accountInfo?: {
    accountType?: string;
    address?: string;
  };
};

type BvnkEstimateResponse = {
  externalId?: string;
};

type BvnkPaymentSummary = {
  uuid?: string;
  status?: string;
  redirectUrl?: string;
  reference?: string;
};

const LIGHTSPARK_DEFAULT_GRID_API_URL = "https://api.lightspark.com/grid/2025-10-13";

function getMoonPayConfig(c: AppContext): MoonPayConfig {
  const mode = resolveSdpEnvironment(c);
  const { apiKey, secretKey } = configForMode(mode, {
    apiKey: { sandbox: c.env.MOONPAY_SANDBOX_API_KEY, production: c.env.MOONPAY_API_KEY },
    secretKey: { sandbox: c.env.MOONPAY_SANDBOX_SECRET_KEY, production: c.env.MOONPAY_SECRET_KEY },
  });

  if (!apiKey || !secretKey) {
    throw providerNotConfigured(
      mode === "sandbox"
        ? "MoonPay sandbox is not configured. Set MOONPAY_SANDBOX_API_KEY and MOONPAY_SANDBOX_SECRET_KEY."
        : "MoonPay is not configured. Set MOONPAY_API_KEY and MOONPAY_SECRET_KEY."
    );
  }

  const defaultOnrampUrl = mode === "sandbox" ? MOONPAY_SANDBOX_ONRAMP_URL : MOONPAY_ONRAMP_URL;
  const defaultOfframpUrl = mode === "sandbox" ? MOONPAY_SANDBOX_OFFRAMP_URL : MOONPAY_OFFRAMP_URL;

  const onrampUrlRaw = c.env.MOONPAY_ONRAMP_URL ?? defaultOnrampUrl;
  const offrampUrlRaw = c.env.MOONPAY_OFFRAMP_URL ?? defaultOfframpUrl;

  try {
    new URL(onrampUrlRaw);
    new URL(offrampUrlRaw);
  } catch {
    throw new AppError("INTERNAL_ERROR", "MoonPay URL configuration is invalid.");
  }

  return {
    apiKey,
    secretKey,
    onrampUrl: onrampUrlRaw,
    offrampUrl: offrampUrlRaw,
  };
}

function getLightsparkConfig(c: AppContext): LightsparkConfig {
  const mode = resolveSdpEnvironment(c);
  const { tokenId, clientSecret } = configForMode(mode, {
    tokenId: {
      sandbox: c.env.LIGHTSPARK_GRID_SANDBOX_CLIENT_ID,
      production: c.env.LIGHTSPARK_GRID_CLIENT_ID,
    },
    clientSecret: {
      sandbox: c.env.LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET,
      production: c.env.LIGHTSPARK_GRID_CLIENT_SECRET,
    },
  });

  if (!tokenId || !clientSecret) {
    throw providerNotConfigured(
      mode === "sandbox"
        ? "Lightspark sandbox is not configured. Set LIGHTSPARK_GRID_SANDBOX_CLIENT_ID and LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET."
        : "Lightspark is not configured. Set LIGHTSPARK_GRID_CLIENT_ID and LIGHTSPARK_GRID_CLIENT_SECRET."
    );
  }

  return {
    tokenId,
    clientSecret,
    apiBaseUrl: LIGHTSPARK_DEFAULT_GRID_API_URL,
  };
}

function getBvnkConfig(c: AppContext): BvnkConfig {
  const mode = resolveSdpEnvironment(c);
  const { hawkAuthId, hawkSecretKey, walletId } = configForMode(mode, {
    hawkAuthId: { sandbox: c.env.BVNK_SANDBOX_HAWK_AUTH_ID, production: c.env.BVNK_HAWK_AUTH_ID },
    hawkSecretKey: {
      sandbox: c.env.BVNK_SANDBOX_HAWK_SECRET_KEY,
      production: c.env.BVNK_HAWK_SECRET_KEY,
    },
    walletId: { sandbox: c.env.BVNK_SANDBOX_WALLET_ID, production: c.env.BVNK_WALLET_ID },
  });

  const missingMsg =
    mode === "sandbox"
      ? "BVNK sandbox is not configured. Set BVNK_SANDBOX_WALLET_ID, BVNK_SANDBOX_HAWK_AUTH_ID, and BVNK_SANDBOX_HAWK_SECRET_KEY."
      : "BVNK is not configured. Set BVNK_WALLET_ID, BVNK_HAWK_AUTH_ID, and BVNK_HAWK_SECRET_KEY.";

  if (!walletId || !hawkAuthId || !hawkSecretKey) {
    throw providerNotConfigured(missingMsg);
  }

  const defaultApiBaseUrl = mode === "sandbox" ? BVNK_SANDBOX_API_URL : BVNK_PRODUCTION_API_URL;
  const apiBaseUrl = c.env.BVNK_API_BASE_URL?.trim() || defaultApiBaseUrl;
  try {
    new URL(apiBaseUrl);
  } catch {
    throw new AppError("INTERNAL_ERROR", "BVNK API URL configuration is invalid.");
  }

  const auth: BvnkAuthConfig = {
    type: "hawk",
    authId: hawkAuthId,
    secretKey: hawkSecretKey,
  };

  return {
    auth,
    walletId,
    apiBaseUrl,
  };
}

function encodeBasicAuth(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function safeParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function toPositiveNumberAmount(value: string, fieldName: string): number {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AppError("BAD_REQUEST", `${fieldName} must be a positive amount`);
  }
  return amount;
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

type BvnkCurrencyNetwork = {
  currency: string;
  network: string;
};

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
    return {
      currency,
      network: BVNK_NETWORK_ALIASES[networkHint],
    };
  }

  if (currency === "BTC") {
    return { currency, network: "BITCOIN" };
  }
  if (currency === "ETH") {
    return { currency, network: "ETHEREUM" };
  }
  if (currency === "SOL") {
    return { currency, network: "SOLANA" };
  }

  if (currency === "USDC" || currency === "USDT") {
    return { currency, network: "SOLANA" };
  }

  throw new AppError(
    "BAD_REQUEST",
    `Unsupported BVNK cryptoToken '${value}'. Provide token with network (for example: BTC, ETH, SOL, USDC_SOLANA).`
  );
}

function mapBvnkPaymentStatus(status: string | undefined): RampExecutionStatus {
  if (!status) {
    return "pending";
  }

  const normalized = status.trim().toUpperCase();
  if (
    normalized.includes("COMPLETE") ||
    normalized.includes("PAID") ||
    normalized.includes("SUCCESS")
  ) {
    return "completed";
  }
  if (normalized.includes("PROCESS")) {
    return "processing";
  }
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
  c: AppContext,
  input?: BvnkComplianceInput,
  options?: { requirePartyDetails?: boolean }
): {
  requesterIpAddress?: string;
  partyDetails: Record<string, unknown>[];
} {
  const requesterIpAddressRaw = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for");
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
    ...(requesterIpAddressRaw
      ? { requesterIpAddress: requesterIpAddressRaw.split(",")[0]?.trim() }
      : {}),
    partyDetails,
  };
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
  init: {
    method: "GET" | "POST";
    body?: unknown;
  }
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

    throw new AppError("BAD_REQUEST", message);
  }

  return parsed ?? {};
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

async function lightsparkRequest(
  config: LightsparkConfig,
  path: string,
  init: {
    method: "GET" | "POST";
    body?: unknown;
  }
): Promise<unknown> {
  const apiBaseUrl = config.apiBaseUrl.endsWith("/") ? config.apiBaseUrl : `${config.apiBaseUrl}/`;
  const url = new URL(path, apiBaseUrl);
  const auth = encodeBasicAuth(`${config.tokenId}:${config.clientSecret}`);

  const response = await fetch(url.toString(), {
    method: init.method,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
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
        : `Lightspark request failed with status ${response.status}`;

    throw new AppError("BAD_REQUEST", message);
  }

  return parsed ?? {};
}

function normalizeLightsparkCurrencyCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9_]+$/.test(normalized)) {
    throw new AppError("BAD_REQUEST", "cryptoToken must be a valid Lightspark currency code");
  }
  return normalized;
}

function getLightsparkCurrencyDecimals(currencyCode: string): number {
  const normalized = currencyCode.trim().toUpperCase();
  if (normalized === "BTC") {
    return 8;
  }
  if (normalized === "SOL") {
    return 9;
  }
  if (normalized === "USDC") {
    return 6;
  }

  throw new AppError(
    "BAD_REQUEST",
    `Unsupported lightspark cryptoToken: ${currencyCode}. Supported values: BTC, SOL, USDC`
  );
}

function assertLightsparkAccountId(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new AppError("BAD_REQUEST", `${fieldName} is required for lightspark`);
  }
  if (!normalized.includes(":")) {
    throw new AppError(
      "BAD_REQUEST",
      `${fieldName} must be a Lightspark account identifier (for example: ExternalAccount:...)`
    );
  }
  return normalized;
}

function parseLightsparkExternalAccount(payload: unknown): LightsparkExternalAccount {
  if (typeof payload !== "object" || payload === null) {
    return {};
  }

  const raw = payload as {
    id?: unknown;
    accountInfo?: {
      accountType?: unknown;
      address?: unknown;
    };
  };

  return {
    id: typeof raw.id === "string" ? raw.id : undefined,
    accountInfo:
      raw.accountInfo && typeof raw.accountInfo === "object"
        ? {
            accountType:
              typeof raw.accountInfo.accountType === "string"
                ? raw.accountInfo.accountType
                : undefined,
            address:
              typeof raw.accountInfo.address === "string" ? raw.accountInfo.address : undefined,
          }
        : undefined,
  };
}

async function listLightsparkCustomerExternalAccounts(
  config: LightsparkConfig,
  customerId: string,
  currency: string
): Promise<LightsparkExternalAccount[]> {
  const externalAccounts: LightsparkExternalAccount[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 10; page += 1) {
    const query = new URLSearchParams();
    query.set("customerId", customerId);
    query.set("currency", currency);
    query.set("limit", "100");
    if (cursor) {
      query.set("cursor", cursor);
    }

    const response = await lightsparkRequest(config, `customers/external-accounts?${query}`, {
      method: "GET",
    });

    if (typeof response !== "object" || response === null) {
      throw new AppError("BAD_REQUEST", "Lightspark external accounts response is invalid");
    }

    const payload = response as {
      data?: unknown;
      hasMore?: unknown;
      nextCursor?: unknown;
    };

    const accounts = Array.isArray(payload.data) ? payload.data : [];
    externalAccounts.push(...accounts.map(parseLightsparkExternalAccount));

    const hasMore = payload.hasMore === true;
    cursor =
      typeof payload.nextCursor === "string" && payload.nextCursor.length > 0
        ? payload.nextCursor
        : undefined;

    if (!hasMore || !cursor) {
      break;
    }
  }

  return externalAccounts;
}

async function resolveLightsparkOnrampDestinationAccountId(
  config: LightsparkConfig,
  customerId: string,
  destinationWallet: string,
  currency: string
): Promise<string> {
  const normalized = destinationWallet.trim();
  if (normalized.length === 0) {
    throw new AppError("BAD_REQUEST", "destinationWallet is required for lightspark");
  }

  if (normalized.includes(":")) {
    return assertLightsparkAccountId(normalized, "destinationWallet");
  }

  if (!isAddress(normalized)) {
    throw new AppError(
      "BAD_REQUEST",
      "destinationWallet must be a Lightspark account id (for example ExternalAccount:...) or a Solana wallet address"
    );
  }

  const externalAccounts = await listLightsparkCustomerExternalAccounts(
    config,
    customerId,
    currency
  );
  const existing = externalAccounts.find((account) => {
    if (!account.id) {
      return false;
    }
    const accountType = account.accountInfo?.accountType?.toUpperCase();
    const address = account.accountInfo?.address;
    return accountType === "SOLANA_WALLET" && address === normalized;
  });

  if (existing?.id) {
    return existing.id;
  }

  const createResponse = await lightsparkRequest(config, "customers/external-accounts", {
    method: "POST",
    body: {
      customerId,
      currency,
      accountInfo: {
        accountType: "SOLANA_WALLET",
        address: normalized,
      },
    },
  });

  const created = parseLightsparkExternalAccount(createResponse);
  if (!created.id) {
    throw new AppError("BAD_REQUEST", "Lightspark external account response is missing id");
  }

  return created.id;
}

function toLightsparkMinorUnitsInteger(value: bigint, fieldName: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError("BAD_REQUEST", `${fieldName} is too large for Lightspark quote minor units`);
  }

  return Number(value);
}

function mapLightsparkQuoteStatus(status: string | undefined): RampExecutionStatus {
  if (!status) {
    return "pending";
  }

  const normalized = status.trim().toUpperCase();
  if (normalized === "COMPLETED") {
    return "completed";
  }
  if (normalized === "PROCESSING") {
    return "processing";
  }
  if (normalized === "FAILED" || normalized === "EXPIRED") {
    return "failed";
  }
  return "pending";
}

function parseLightsparkQuote(payload: unknown): LightsparkQuote {
  if (typeof payload !== "object" || payload === null) {
    throw new AppError("BAD_REQUEST", "Lightspark response payload is invalid");
  }
  return payload as LightsparkQuote;
}

async function createMoonPaySignature(unsignedQuery: string, secretKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(unsignedQuery));
  return Buffer.from(signature).toString("base64");
}

async function buildSignedMoonPayWidgetUrl(
  baseUrl: string,
  secretKey: string,
  params: Record<string, string | undefined>
): Promise<string> {
  const url = new URL(baseUrl);
  const sortedEntries = Object.entries(params).sort(([left], [right]) => left.localeCompare(right));

  for (const [key, value] of sortedEntries) {
    if (!value) {
      continue;
    }
    url.searchParams.set(key, value);
  }

  const signature = await createMoonPaySignature(url.search, secretKey);
  url.searchParams.set("signature", signature);

  return url.toString();
}

const bvnkRampProvider: RampProviderExecutor = {
  async executeOnramp(c, scope, input) {
    const customerId = input.kycReference?.trim();
    if (!customerId) {
      throw new AppError(
        "BAD_REQUEST",
        "kycReference is required for BVNK onramp and must contain a BVNK customer id"
      );
    }

    const config = getBvnkConfig(c);
    const destinationAddress = resolveWalletAddress(
      scope.wallets,
      input.destinationWallet,
      "destinationWallet",
      scope.auth,
      ["payments:write"]
    );
    const { currency, network } = normalizeBvnkCurrencyAndNetwork(input.cryptoToken);
    const amount = toPositiveNumberAmount(input.fiatAmount, "fiatAmount");
    const externalReference = `sdp_onramp_${crypto.randomUUID()}`;
    const complianceDetails = buildBvnkComplianceDetails(c, input.bvnkCompliance);

    const response = await bvnkRequest(config, "/api/v1/pay/summary", {
      method: "POST",
      body: {
        walletId: config.walletId,
        amount,
        currency: "USD",
        type: "IN",
        reference: externalReference,
        customerId,
        returnUrl: input.redirectUrl,
        payOutDetails: {
          code: "crypto",
          currency,
          address: destinationAddress,
          network,
        },
        complianceDetails,
      },
    });

    const summary = parseBvnkPaymentSummary(response);
    return {
      id: `ramp_${crypto.randomUUID()}`,
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
  },

  async executeOfframp(c, scope, input) {
    const customerId = input.kycReference?.trim();
    if (!customerId) {
      throw new AppError(
        "BAD_REQUEST",
        "kycReference is required for BVNK offramp and must contain a BVNK customer id"
      );
    }

    const config = getBvnkConfig(c);
    const destinationAddress = resolveWalletAddress(
      scope.wallets,
      input.sourceWallet,
      "sourceWallet",
      scope.auth,
      ["payments:write"]
    );
    const { currency, network } = normalizeBvnkCurrencyAndNetwork(input.cryptoToken);
    const paidRequiredAmount = toPositiveNumberAmount(input.cryptoAmount, "cryptoAmount");
    const externalReference = `sdp_offramp_${crypto.randomUUID()}`;
    const complianceDetails = buildBvnkComplianceDetails(c, input.bvnkCompliance, {
      requirePartyDetails: true,
    });

    const estimateResponse = await bvnkRequest(config, "/api/v1/pay/estimate", {
      method: "POST",
      body: {
        walletId: config.walletId,
        walletCurrency: "USD",
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
          payOutDetails: {
            currency,
            address: destinationAddress,
            network,
          },
          complianceDetails,
        },
      }
    );

    const summary = parseBvnkPaymentSummary(summaryResponse);
    return {
      id: `ramp_${crypto.randomUUID()}`,
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
  },
};

const moonPayRampProvider: RampProviderExecutor = {
  async executeOnramp(c, scope, input) {
    const destinationWalletAddress = resolveWalletAddress(
      scope.wallets,
      input.destinationWallet,
      "destinationWallet",
      scope.auth,
      ["payments:write"]
    );
    const amount = toPositiveNumberAmount(input.fiatAmount, "fiatAmount");
    if (amount < MOONPAY_ONRAMP_MIN_USD) {
      throw new AppError(
        "BAD_REQUEST",
        `MoonPay on-ramp requires fiatAmount to be at least ${MOONPAY_ONRAMP_MIN_USD} USD`
      );
    }
    const moonPay = getMoonPayConfig(c);

    const redirectUrl = await buildSignedMoonPayWidgetUrl(moonPay.onrampUrl, moonPay.secretKey, {
      apiKey: moonPay.apiKey,
      baseCurrencyCode: "usd",
      baseCurrencyAmount: input.fiatAmount,
      currencyCode: normalizeMoonPayCurrencyCode(input.cryptoToken),
      walletAddress: destinationWalletAddress,
      redirectURL: input.redirectUrl,
      externalCustomerId: input.kycReference,
      externalTransactionId: `sdp_onramp_${crypto.randomUUID()}`,
    });

    return {
      id: `ramp_${crypto.randomUUID()}`,
      provider: "moonpay",
      status: "pending",
      redirectUrl,
    };
  },

  async executeOfframp(c, scope, input) {
    const sourceWalletAddress = resolveWalletAddress(
      scope.wallets,
      input.sourceWallet,
      "sourceWallet",
      scope.auth,
      ["payments:write"]
    );
    const moonPay = getMoonPayConfig(c);
    const externalTransactionId = `sdp_offramp_${crypto.randomUUID()}`;

    const redirectUrl = await buildSignedMoonPayWidgetUrl(moonPay.offrampUrl, moonPay.secretKey, {
      apiKey: moonPay.apiKey,
      baseCurrencyCode: normalizeMoonPayCurrencyCode(input.cryptoToken),
      baseCurrencyAmount: input.cryptoAmount,
      quoteCurrencyCode: "usd",
      refundWalletAddress: sourceWalletAddress,
      redirectURL: input.redirectUrl,
      externalCustomerId: input.kycReference,
      externalTransactionId,
    });

    return {
      id: `ramp_${crypto.randomUUID()}`,
      provider: "moonpay",
      status: "pending",
      redirectUrl,
      reference: externalTransactionId,
    };
  },
};

const lightsparkRampProvider: RampProviderExecutor = {
  async executeOnramp(c, _scope, input) {
    const customerId = input.kycReference?.trim();
    if (!customerId) {
      throw new AppError(
        "BAD_REQUEST",
        "kycReference is required for lightspark onramp and must contain a Lightspark customer id"
      );
    }

    const cryptoCurrency = normalizeLightsparkCurrencyCode(input.cryptoToken);
    const fiatAmountMinorUnits = toLightsparkMinorUnitsInteger(
      parseDecimalAmount(input.fiatAmount, 2),
      "fiatAmount"
    );
    const config = getLightsparkConfig(c);
    const destinationAccountId = await resolveLightsparkOnrampDestinationAccountId(
      config,
      customerId,
      input.destinationWallet,
      cryptoCurrency
    );

    const quoteResponse = await lightsparkRequest(config, "quotes", {
      method: "POST",
      body: {
        source: {
          sourceType: "REALTIME_FUNDING",
          customerId,
          currency: "USD",
        },
        destination: {
          destinationType: "ACCOUNT",
          accountId: destinationAccountId,
          currency: cryptoCurrency,
        },
        lockedCurrencySide: "SENDING",
        lockedCurrencyAmount: fiatAmountMinorUnits,
        description: "SDP onramp",
      },
    });

    const quote = parseLightsparkQuote(quoteResponse);
    return {
      id: `ramp_${crypto.randomUUID()}`,
      provider: "lightspark",
      status: mapLightsparkQuoteStatus(quote.quoteStatus ?? quote.status),
      redirectUrl: quote.paymentInstructions?.url,
      reference: quote.id,
    };
  },

  async executeOfframp(c, _scope, input) {
    const sourceAccountId = assertLightsparkAccountId(input.sourceWallet, "sourceWallet");
    const destinationAccountId = assertLightsparkAccountId(
      input.kycReference ?? "",
      "kycReference"
    );
    const cryptoCurrency = normalizeLightsparkCurrencyCode(input.cryptoToken);
    const cryptoAmountMinorUnits = toLightsparkMinorUnitsInteger(
      parseDecimalAmount(input.cryptoAmount, getLightsparkCurrencyDecimals(cryptoCurrency)),
      "cryptoAmount"
    );
    const config = getLightsparkConfig(c);

    const quoteResponse = await lightsparkRequest(config, "quotes", {
      method: "POST",
      body: {
        source: {
          sourceType: "ACCOUNT",
          accountId: sourceAccountId,
          currency: cryptoCurrency,
        },
        destination: {
          destinationType: "ACCOUNT",
          accountId: destinationAccountId,
          currency: "USD",
        },
        lockedCurrencySide: "SENDING",
        lockedCurrencyAmount: cryptoAmountMinorUnits,
        description: "SDP offramp",
      },
    });

    const quote = parseLightsparkQuote(quoteResponse);
    if (!quote.id) {
      throw new AppError("BAD_REQUEST", "Lightspark quote response is missing id");
    }

    const executeResponse = await lightsparkRequest(
      config,
      `quotes/${encodeURIComponent(quote.id)}/execute`,
      {
        method: "POST",
      }
    );
    const executedQuote = parseLightsparkQuote(executeResponse);

    return {
      id: `ramp_${crypto.randomUUID()}`,
      provider: "lightspark",
      status: mapLightsparkQuoteStatus(executedQuote.quoteStatus ?? executedQuote.status),
      redirectUrl: executedQuote.paymentInstructions?.url,
      reference: quote.id,
    };
  },
};

const RAMP_PROVIDER_REGISTRY: Record<RampProviderId, RampProviderExecutor> = {
  moonpay: moonPayRampProvider,
  lightspark: lightsparkRampProvider,
  bvnk: bvnkRampProvider,
};

async function resolveRampProvider(
  c: AppContext,
  providerId: RampProviderId,
  organizationId: string
): Promise<RampProviderExecutor> {
  await assertProviderAvailable(
    c.env,
    getDb(c.env),
    organizationId,
    "ramps",
    providerId,
    resolveSdpEnvironment(c) === "sandbox"
  );

  const provider = RAMP_PROVIDER_REGISTRY[providerId];
  if (!provider) {
    throw new AppError("BAD_REQUEST", `Unsupported ramp provider: ${providerId}`);
  }

  return provider;
}

async function executeRampWithProvider(
  c: AppContext,
  input: ExecuteRampInput
): Promise<RampExecutionResult> {
  const scope = await resolveScope(c);
  const provider = await resolveRampProvider(c, input.provider, scope.auth.organizationId);

  if (input.direction === "onramp") {
    return await provider.executeOnramp(c, scope, input);
  }

  const sourceWallet = scope.wallets.find(
    (wallet) => wallet.walletId === input.sourceWallet || wallet.publicKey === input.sourceWallet
  );
  if (sourceWallet) {
    await assertWalletPolicyAllowsTransfer(c, {
      organizationId: scope.auth.organizationId,
      projectId: scope.auth.projectId,
      wallet: sourceWallet,
      enforceDestinationAllowlist: false,
      token: input.cryptoToken,
      amount: input.cryptoAmount,
    });
  }

  return await provider.executeOfframp(c, scope, input);
}

export async function executeOnramp(c: AppContext) {
  const body = await c.req.json();
  const parsed = executeOnrampSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const ramp = await executeRampWithProvider(c, {
    ...parsed.data,
    direction: "onramp",
  });

  return success(c, { ramp });
}

export async function executeOfframp(c: AppContext) {
  const body = await c.req.json();
  const parsed = executeOfframpSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const ramp = await executeRampWithProvider(c, {
    ...parsed.data,
    direction: "offramp",
  });

  return success(c, { ramp });
}
