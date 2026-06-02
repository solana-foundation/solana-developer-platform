import { createVerify } from "node:crypto";
import type { LightsparkPaymentRampInstruction } from "@sdp/types";
import { parseFiatCurrency } from "@sdp/types/payment-rails";
import { AppError } from "@/lib/errors";
import {
  basicAuthHeader,
  createProviderRampSupport,
  isSolanaCryptoAsset,
  requireEnv,
  SOLANA_ASSET_TO_RAIL,
} from "../common";
import { RAMP_RAIL_DUMPS } from "../constants";
import { type ProviderRequestInit, providerFetchJson } from "../fetch";
import type {
  ProviderRampSupport,
  RampDumpReader,
  RampProviderClient,
  RampWebhookValidationContext,
  RampWebhookValidationResult,
} from "../types";

/** Connection details for live Grid API calls. */
export interface LightsparkConfig {
  tokenId: string;
  clientSecret: string;
  apiBaseUrl: string;
}

export type LightsparkCustomerType = "INDIVIDUAL" | "BUSINESS";

export interface CreateLightsparkCustomerInput {
  platformCustomerId: string;
  customerType: LightsparkCustomerType;
  fullName: string;
  email?: string;
}

export interface LightsparkCustomer {
  id: string;
}

interface GridCreateCustomerBody {
  platformCustomerId: string;
  customerType: LightsparkCustomerType;
  fullName: string;
  email?: string;
}

interface GridCustomerResponse {
  id: string;
}

interface GridCustomerListResponse {
  data: GridCustomerResponse[];
}

interface GridCreateQuoteBody {
  source: {
    sourceType: "REALTIME_FUNDING";
    customerId: string;
    currency: string;
  };
  destination: {
    destinationType: "ACCOUNT";
    accountId: string;
    currency: string;
  };
  lockedCurrencySide: "SENDING" | "RECEIVING";
  lockedCurrencyAmount: number;
  description: string;
}

interface GridPaymentInstruction {
  accountOrWalletInfo: LightsparkPaymentRampInstruction["accountOrWalletInfo"];
  instructionsNotes?: string;
  isPlatformAccount?: boolean;
}

interface GridQuoteResponse {
  id: string;
  status: string;
  paymentInstructions?: GridPaymentInstruction[];
  exchangeRate: number;
  totalSendingAmount: number;
  totalReceivingAmount: number;
  feesIncluded: number;
  expiresAt: string;
}

export interface CreateLightsparkOnrampQuoteInput {
  /** Grid customer that will fund the quote in real time. */
  customerId: string;
  /** Grid external account id the crypto will be delivered to (e.g. ExternalAccount:...). */
  destinationAccountId: string;
  /** Source fiat currency code (e.g. USD). */
  fiatCurrency: string;
  /** Destination crypto currency code (e.g. USDC). */
  cryptoCurrency: string;
  /** Locked sending amount in the fiat currency's smallest unit (cents). */
  fiatAmountMinorUnits: number;
  description?: string;
}

export interface LightsparkQuote {
  id: string;
  status?: string;
  paymentInstructions?: LightsparkPaymentRampInstruction[];
  exchangeRate?: number;
  totalSendingAmount?: number;
  totalReceivingAmount?: number;
  feesIncluded?: number;
  expiresAt?: string;
}

interface LightsparkSupportedCurrency {
  currencyCode?: string;
  enabledTransactionTypes?: string[];
}

interface LightsparkConfigDump {
  embeddedWalletConfig?: { appName?: string };
  supportedCurrencies?: readonly LightsparkSupportedCurrency[];
}

function extractSupport(config: LightsparkConfigDump): ProviderRampSupport {
  const support = createProviderRampSupport();
  const platformIsSolana = config.embeddedWalletConfig?.appName === "Solana";

  for (const entry of config.supportedCurrencies ?? []) {
    const code = entry.currencyCode;
    if (!code) continue;
    const upper = code.toUpperCase();
    const enabled = entry.enabledTransactionTypes ?? [];

    if (isSolanaCryptoAsset(upper)) {
      if (platformIsSolana && enabled.includes("OUTGOING")) {
        support.onrampCryptos.add(SOLANA_ASSET_TO_RAIL[upper]);
        support.offrampCryptos.add(SOLANA_ASSET_TO_RAIL[upper]);
      }
      continue;
    }

    const parsed = parseFiatCurrency(upper);
    if (!parsed) continue;
    if (enabled.includes("INCOMING")) support.onrampFiats.add(parsed);
    if (enabled.includes("OUTGOING")) support.offrampFiats.add(parsed);
  }

  return support;
}

export class LightsparkRampClient implements RampProviderClient {
  readonly id = "lightspark";

  async _discoverRails({
    env,
    fetchJson,
    writeDump,
  }: Parameters<RampProviderClient["_discoverRails"]>[0]) {
    const clientId = requireEnv(env, "LIGHTSPARK_GRID_SANDBOX_CLIENT_ID");
    const clientSecret = requireEnv(env, "LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET");
    const base =
      env.LIGHTSPARK_GRID_API_BASE_URL?.trim() || "https://api.lightspark.com/grid/2025-10-13";
    const headers = {
      Authorization: basicAuthHeader(clientId, clientSecret),
    };

    await writeDump(
      RAMP_RAIL_DUMPS.lightspark.config.name,
      await fetchJson(this.id, "GET /config", `${base}/config`, { headers })
    );
  }

  async readRailSupport(readDump: RampDumpReader): Promise<ProviderRampSupport> {
    return extractSupport(
      await readDump<LightsparkConfigDump>(RAMP_RAIL_DUMPS.lightspark.config.file)
    );
  }

  /**
   * Verifies a Grid webhook via the `X-Grid-Signature` header: an ECDSA P-256 /
   * SHA-256 signature over the raw request body, checked against the Grid
   * webhook public key (PEM/SPKI). The header is JSON `{"v":1,"s":"<base64>"}`.
   */
  async validateWebhook({
    env,
    environment,
    headers,
    rawBody,
  }: RampWebhookValidationContext): Promise<RampWebhookValidationResult> {
    const publicKey = requireEnv(
      env,
      environment === "sandbox"
        ? "LIGHTSPARK_GRID_SANDBOX_WEBHOOK_PUBLIC_KEY"
        : "LIGHTSPARK_GRID_WEBHOOK_PUBLIC_KEY"
    );

    const signatureHeader = headers.get("x-grid-signature")?.trim();
    if (!signatureHeader) {
      throw new AppError("UNAUTHORIZED", "Lightspark webhook is missing x-grid-signature", {
        provider: this.id,
      });
    }

    // Grid sends `{"v":1,"s":"<base64 DER ECDSA>"}`; fall back to bare base64.
    let signatureB64 = signatureHeader;
    try {
      const parsed = JSON.parse(signatureHeader) as { s?: unknown };
      if (parsed && typeof parsed.s === "string") {
        signatureB64 = parsed.s;
      }
    } catch {
      // Not JSON — treat the header value as bare base64.
    }

    const verified = createVerify("SHA256")
      .update(rawBody)
      .verify(
        // Doppler may store the PEM with literal "\n"; normalize to real newlines.
        { key: publicKey.replace(/\\n/g, "\n"), format: "pem", type: "spki" },
        Buffer.from(signatureB64, "base64")
      );
    if (!verified) {
      throw new AppError("UNAUTHORIZED", "Invalid Lightspark webhook signature", {
        provider: this.id,
      });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new AppError("BAD_REQUEST", "Lightspark webhook body must be valid JSON", {
        provider: this.id,
      });
    }

    return { provider: this.id, payload };
  }

  private async request<TResponse, TBody = never>(
    config: LightsparkConfig,
    path: string,
    init: ProviderRequestInit<TBody>
  ): Promise<TResponse> {
    const base = config.apiBaseUrl.endsWith("/") ? config.apiBaseUrl : `${config.apiBaseUrl}/`;
    const url = new URL(path, base);

    return providerFetchJson<TResponse, TBody>(this.id, url.toString(), {
      ...init,
      headers: {
        Authorization: basicAuthHeader(config.tokenId, config.clientSecret),
        ...init.headers,
      },
    });
  }

  /** Creates a native Grid customer for a counterparty (KYC'd buyer). */
  async createCustomer(
    config: LightsparkConfig,
    input: CreateLightsparkCustomerInput
  ): Promise<LightsparkCustomer> {
    const response = await this.request<GridCustomerResponse, GridCreateCustomerBody>(
      config,
      "customers",
      {
        method: "POST",
        body: {
          platformCustomerId: input.platformCustomerId,
          customerType: input.customerType,
          fullName: input.fullName,
          ...(input.email ? { email: input.email } : {}),
        },
      }
    );

    return { id: response.id };
  }

  /** Looks up an existing Grid customer by the platform-side id we assigned. */
  async findCustomerByPlatformId(
    config: LightsparkConfig,
    platformCustomerId: string
  ): Promise<LightsparkCustomer | null> {
    const query = new URLSearchParams({ platformCustomerId, limit: "1" });
    const response = await this.request<GridCustomerListResponse>(
      config,
      `customers?${query.toString()}`,
      { method: "GET" }
    );
    const [existing] = response.data;
    return existing ? { id: existing.id } : null;
  }

  /**
   * Idempotent customer creation keyed on platformCustomerId. Grid rejects a
   * duplicate platformCustomerId with 409; we recover by returning the customer
   * that already exists, so concurrent callers converge instead of orphaning one.
   */
  async getOrCreateCustomer(
    config: LightsparkConfig,
    input: CreateLightsparkCustomerInput
  ): Promise<LightsparkCustomer> {
    try {
      return await this.createCustomer(config, input);
    } catch (error) {
      if (error instanceof AppError && error.code === "CONFLICT") {
        const existing = await this.findCustomerByPlatformId(config, input.platformCustomerId);
        if (existing) {
          return existing;
        }
      }
      throw error;
    }
  }

  /** Creates a just-in-time (real-time funded) onramp quote and locks the FX rate. */
  async createOnrampQuote(
    config: LightsparkConfig,
    input: CreateLightsparkOnrampQuoteInput
  ): Promise<LightsparkQuote> {
    const response = await this.request<GridQuoteResponse, GridCreateQuoteBody>(config, "quotes", {
      method: "POST",
      body: {
        source: {
          sourceType: "REALTIME_FUNDING",
          customerId: input.customerId,
          currency: input.fiatCurrency,
        },
        destination: {
          destinationType: "ACCOUNT",
          accountId: input.destinationAccountId,
          currency: input.cryptoCurrency,
        },
        lockedCurrencySide: "SENDING",
        lockedCurrencyAmount: input.fiatAmountMinorUnits,
        description: input.description ?? "SDP onramp",
      },
    });

    return parseLightsparkQuote(response);
  }
}

function parseLightsparkQuote(raw: GridQuoteResponse): LightsparkQuote {
  return {
    id: raw.id,
    status: raw.status,
    paymentInstructions: raw.paymentInstructions?.map((instruction) => ({
      provider: "lightspark" as const,
      ...instruction,
    })),
    exchangeRate: raw.exchangeRate,
    totalSendingAmount: raw.totalSendingAmount,
    totalReceivingAmount: raw.totalReceivingAmount,
    feesIncluded: raw.feesIncluded,
    expiresAt: raw.expiresAt,
  };
}
