import type { Counterparty, PaymentRampEstimate, PaymentRampQuote } from "@sdp/types";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { badRequest, providerNotConfigured } from "@/lib/errors";
import { type ProviderRequestInit, providerFetchJson } from "../fetch";
import { createProviderRampSupport, RAMP_RAIL_DUMPS, requireEnv } from "../shared";
import type {
  ProviderRampSupport,
  RampDumpReader,
  RampEstimateOfframpInput,
  RampEstimateOnrampInput,
  RampOfframpQuoteInput,
  RampOnrampQuoteInput,
  RampProvider,
  RampRuntimeContext,
  RampSettlementEvent,
  RampWebhookValidationContext,
  RampWebhookValidationResult,
  ValidateCounterpartyOptions,
} from "../types";

const CDP_ONRAMP_API_BASE_URL = "https://api.developer.coinbase.com";

interface CoinbaseConfig {
  apiKeyName: string;
  apiKeySecret: string;
  apiBaseUrl: string;
}

// biome-ignore lint/correctness/noUnusedVariables: called by capability skill implementations (estimate, quote, etc.)
function readCoinbaseConfig(env: Record<string, string | undefined>): CoinbaseConfig {
  const apiKeyName = env.CDP_ONRAMP_API_KEY_NAME?.trim();
  const apiKeySecret = env.CDP_ONRAMP_API_KEY_SECRET?.trim();

  if (!apiKeyName || !apiKeySecret) {
    throw providerNotConfigured(
      "Coinbase Onramp is not configured. Set CDP_ONRAMP_API_KEY_NAME and CDP_ONRAMP_API_KEY_SECRET."
    );
  }

  return {
    apiKeyName,
    apiKeySecret,
    apiBaseUrl: env.CDP_ONRAMP_API_BASE_URL?.trim() || CDP_ONRAMP_API_BASE_URL,
  };
}

export class CoinbaseRampClient implements RampProvider {
  readonly id = "coinbase";

  validateCounterparty(
    _counterparty: Counterparty,
    _options: ValidateCounterpartyOptions
  ): CounterpartyRequirements {
    throw new Error("validateCounterparty not yet implemented for coinbase");
  }

  async _discoverRails({
    env,
    fetchJson,
    writeDump,
  }: Parameters<RampProvider["_discoverRails"]>[0]): Promise<void> {
    const apiKeyName = requireEnv(env, "CDP_ONRAMP_API_KEY_NAME");
    const apiKeySecret = requireEnv(env, "CDP_ONRAMP_API_KEY_SECRET");
    const base = env.CDP_ONRAMP_API_BASE_URL?.trim() || CDP_ONRAMP_API_BASE_URL;

    const jwt = await generateCdpJwt({
      apiKeyName,
      apiKeySecret,
      requestMethod: "GET",
      requestHost: new URL(base).host,
      requestPath: "/onramp/v1/buy/options",
    });

    await writeDump(
      RAMP_RAIL_DUMPS.coinbase.buyOptions.name,
      await fetchJson(
        this.id,
        "GET /onramp/v1/buy/options",
        `${base}/onramp/v1/buy/options?country=US`,
        { headers: { Authorization: `Bearer ${jwt}` } }
      )
    );
  }

  async readRailSupport(readDump: RampDumpReader): Promise<ProviderRampSupport> {
    const support = createProviderRampSupport();
    // TODO(integrate-estimate): parse buy options dump and populate onrampFiats/onrampCryptos
    await readDump(RAMP_RAIL_DUMPS.coinbase.buyOptions.file);
    return support;
  }

  async validateWebhook(
    _context: RampWebhookValidationContext
  ): Promise<RampWebhookValidationResult> {
    throw new Error("validateWebhook not yet implemented for coinbase");
  }

  parseSettlementEvent(_payload: unknown): RampSettlementEvent {
    throw new Error("parseSettlementEvent not yet implemented for coinbase");
  }

  async estimateOnramp(
    _ctx: RampRuntimeContext,
    _input: RampEstimateOnrampInput
  ): Promise<PaymentRampEstimate> {
    throw new Error("estimateOnramp not yet implemented for coinbase");
  }

  async estimateOfframp(
    _ctx: RampRuntimeContext,
    _input: RampEstimateOfframpInput
  ): Promise<PaymentRampEstimate> {
    throw badRequest("Coinbase Onramp does not support off-ramp.");
  }

  async createOnrampQuote(
    _ctx: RampRuntimeContext,
    _input: RampOnrampQuoteInput
  ): Promise<PaymentRampQuote> {
    throw new Error("createOnrampQuote not yet implemented for coinbase");
  }

  async createOfframpQuote(
    _ctx: RampRuntimeContext,
    _input: RampOfframpQuoteInput
  ): Promise<PaymentRampQuote> {
    throw badRequest("Coinbase Onramp does not support off-ramp.");
  }

  private async request<TResponse, TBody = never>(
    config: CoinbaseConfig,
    path: string,
    init: ProviderRequestInit<TBody>
  ): Promise<TResponse> {
    const base = config.apiBaseUrl.endsWith("/") ? config.apiBaseUrl : `${config.apiBaseUrl}/`;
    const url = new URL(path, base);

    const jwt = await generateCdpJwt({
      apiKeyName: config.apiKeyName,
      apiKeySecret: config.apiKeySecret,
      requestMethod: init.method,
      requestHost: url.host,
      requestPath: url.pathname,
    });

    return providerFetchJson<TResponse, TBody>(this.id, url.toString(), {
      ...init,
      headers: {
        Authorization: `Bearer ${jwt}`,
        ...init.headers,
      },
    });
  }
}

interface CdpJwtOptions {
  apiKeyName: string;
  apiKeySecret: string;
  requestMethod: string;
  requestHost: string;
  requestPath: string;
}

async function generateCdpJwt(opts: CdpJwtOptions): Promise<string> {
  const { apiKeyName, apiKeySecret, requestMethod, requestHost, requestPath } = opts;

  const uri = `${requestMethod.toUpperCase()} ${requestHost}${requestPath}`;
  const now = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 16);

  const header = { alg: "ES256", typ: "JWT", kid: apiKeyName, nonce };
  const payload = {
    sub: apiKeyName,
    iss: "cdp",
    aud: ["cdp_service"],
    nbf: now,
    exp: now + 120,
    uri,
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const message = `${encodedHeader}.${encodedPayload}`;

  const privateKey = await importEcPrivateKey(apiKeySecret);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(message)
  );

  return `${message}.${base64url(signature)}`;
}

function base64url(input: string | ArrayBuffer): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function importEcPrivateKey(pemOrBase64: string): Promise<CryptoKey> {
  const cleaned = pemOrBase64
    .replace(/-----BEGIN EC PRIVATE KEY-----/, "")
    .replace(/-----END EC PRIVATE KEY-----/, "")
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");

  const der = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
}
