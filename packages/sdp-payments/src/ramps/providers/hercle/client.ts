import type {
  Counterparty,
  HerclePaymentRampInstruction,
  PaymentRampEstimate,
  PaymentRampQuote,
  SdpEnvironment,
} from "@sdp/types";
import {
  type CryptoRailId,
  type CryptoRailNetwork,
  getCryptoRailAssetLabel,
  SOLANA_CRYPTO_RAILS,
} from "@sdp/types/payment-rails";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { z } from "zod";
import {
  badRequest,
  internalError,
  providerNotConfigured,
  SdpPaymentsError,
} from "../../../errors";
import { hmacSha256Base64 } from "../../../hash";
import { classifyProviderStatus, extractProviderErrorMessage, providerFetch } from "../../fetch";
import { UNREPORTED_COUNTRY_SUPPORT, unreportedCurrencyLimit } from "../../shared";
import type {
  ProviderDeclaredRailSupport,
  ProviderRailSupportDistillation,
  RampDiscoveryContext,
  RampEstimateOfframpInput,
  RampEstimateOnrampInput,
  RampOfframpQuoteInput,
  RampOnrampQuoteInput,
  RampProvider,
  RampRuntimeContext,
  ValidateCounterpartyOptions,
} from "../../types";
import { hercleCounterpartyRequirements } from "./counterparty";
import type { HercleSettlementStatus } from "./provider-data";

/**
 * Hercle — headless fiat on-ramp provider (Signed Key v1 lane, /partner/v1).
 * Business counterparties become Hercle sub-accounts; every scoped call rides one
 * platform credential plus the `on-behalf-of` header. Launch corridor: EUR -> USDC (Solana).
 * There is no off-ramp (Mural's shape): the rail declares none, and the off-ramp methods refuse.
 */
export const HERCLE_DECLARED_RAIL_SUPPORT = {
  onramp: { countrySupport: UNREPORTED_COUNTRY_SUPPORT, entityTypes: ["business"] },
  offramp: { countrySupport: UNREPORTED_COUNTRY_SUPPORT, entityTypes: [] },
} as const satisfies ProviderDeclaredRailSupport;

interface HercleConfig {
  clientId: string;
  clientSecret: string;
  apiBaseUrl: string;
}

function readHercleConfig(
  env: Record<string, string | undefined>,
  mode: SdpEnvironment
): HercleConfig {
  const clientId =
    mode === "sandbox" ? env.HERCLE_SANDBOX_CLIENT_ID?.trim() : env.HERCLE_CLIENT_ID?.trim();
  const clientSecret =
    mode === "sandbox"
      ? env.HERCLE_SANDBOX_CLIENT_SECRET?.trim()
      : env.HERCLE_CLIENT_SECRET?.trim();
  const apiBaseUrl =
    mode === "sandbox" ? env.HERCLE_SANDBOX_API_BASE_URL?.trim() : env.HERCLE_API_BASE_URL?.trim();

  if (!clientId || !clientSecret || !apiBaseUrl) {
    throw providerNotConfigured(
      mode === "sandbox"
        ? "Hercle sandbox is not configured. Set HERCLE_SANDBOX_CLIENT_ID, HERCLE_SANDBOX_CLIENT_SECRET and HERCLE_SANDBOX_API_BASE_URL."
        : "Hercle is not configured. Set HERCLE_CLIENT_ID, HERCLE_CLIENT_SECRET and HERCLE_API_BASE_URL."
    );
  }

  try {
    new URL(apiBaseUrl);
  } catch {
    throw internalError(`Hercle API base URL "${apiBaseUrl}" is not a valid URL.`);
  }

  return { clientId, clientSecret, apiBaseUrl };
}

/**
 * Hercle Signed Key v1: Base64(HMAC-SHA256(secret, ts + METHOD + pathWithQuery + rawBody)),
 * concatenated with no separators. The same body string handed to the signer MUST be the
 * one sent on the wire — providerFetch passes strings through untouched.
 */
export async function buildHercleSignature(
  secret: string,
  timestampSeconds: number,
  method: string,
  pathWithQuery: string,
  rawBody: string
): Promise<string> {
  return hmacSha256Base64(
    `${timestampSeconds}${method.toUpperCase()}${pathWithQuery}${rawBody}`,
    secret
  );
}

/** Quotes carry a token symbol ("SOL"), estimates a rail id ("sol.solana"); both resolve here. */
export function parseCryptoRail(cryptoToken: string): CryptoRailId {
  const normalized = cryptoToken.trim().toLowerCase();
  const railId = normalized.includes(".") ? normalized : `${normalized}.solana`;
  const parsed = z.enum(SOLANA_CRYPTO_RAILS).safeParse(railId);
  if (!parsed.success) {
    throw badRequest(`Unsupported crypto token "${cryptoToken}" for Hercle.`, {
      provider: "hercle",
    });
  }
  return parsed.data;
}

function railNetwork(assetRail: CryptoRailId): CryptoRailNetwork {
  return assetRail.slice(assetRail.indexOf(".") + 1) as CryptoRailNetwork;
}

const hercleEstimateResponseSchema = z.object({
  fiatCurrency: z.string(),
  fiatAmount: z.string(),
  cryptoAmount: z.string(),
  exchangeRate: z.string(),
  fees: z.object({ currency: z.string(), total: z.string() }),
  minFiatAmount: z.string().optional(),
  maxFiatAmount: z.string().optional(),
  expiresAt: z.string().optional(),
});

const hercleOnrampOrderResponseSchema = z.object({
  orderId: z.string().min(1),
  fiatCurrency: z.string(),
  fiatAmount: z.string(),
  bankAccount: z.object({
    iban: z.string().optional(),
    bic: z.string().optional(),
    bankName: z.string().optional(),
    accountHolder: z.string().optional(),
    paymentReference: z.string().optional(),
    payerAccountHolder: z.string().optional(),
  }),
  expiresAt: z.string().optional(),
});

const hercleAccountResponseSchema = z.object({
  accountId: z.string().min(1),
  externalReference: z.string(),
  verificationStatus: z.string(),
  replayed: z.boolean().nullable().optional(),
});

const hercleVerificationResponseSchema = z.object({
  status: z.string(),
  verificationUrl: z.string().optional(),
});

export type HercleAccountResponse = z.infer<typeof hercleAccountResponseSchema>;
export type HercleVerificationResponse = z.infer<typeof hercleVerificationResponseSchema>;

/**
 * The business's acceptance of Hercle's terms, attested by SDP on its behalf (TS-KYC-01 D14). Hercle refuses to
 * open an account without both mandatory consents, exactly as its own sign-up does; `acceptedAt` is when the
 * business ticked the boxes in the collect step.
 */
export interface HercleConsents {
  termsAndConditions: true;
  privacyPolicy: true;
  acceptedAt: string;
}

export interface HercleCreateAccountRequest {
  companyName: string;
  registrationNumber?: string;
  registeredAddress?: { line1?: string; city?: string; postalCode?: string; country?: string };
  jurisdiction: string;
  fundingMode: string;
  accountLabel?: string;
  externalReference: string;
  consents: HercleConsents;
}

export class HercleRampClient implements RampProvider {
  readonly id = "hercle";
  readonly declaredRailSupport = HERCLE_DECLARED_RAIL_SUPPORT;

  /** Declared, not fetched: the partner surface has no discovery endpoint, and limits come back on the quote. */
  async discoverCurrencyAndRails(
    _context: RampDiscoveryContext
  ): Promise<ProviderRailSupportDistillation> {
    return {
      snapshot: {
        onramp: {
          currencies: { EUR: unreportedCurrencyLimit() },
          cryptos: ["usdc.solana", "sol.solana"],
        },
        offramp: { currencies: {}, cryptos: [] },
      },
      droppedCurrencyCodes: [],
      droppedCountryCodes: [],
    };
  }

  private async request<T>(
    { env, mode }: RampRuntimeContext,
    method: "GET" | "POST" | "PATCH",
    pathWithQuery: string,
    options: { body?: unknown; onBehalfOf?: string; idempotencyKey?: string } = {}
  ): Promise<T> {
    const config = readHercleConfig(env, mode);
    const rawBody = options.body === undefined ? "" : JSON.stringify(options.body);
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const signature = await buildHercleSignature(
      config.clientSecret,
      timestampSeconds,
      method,
      pathWithQuery,
      rawBody
    );

    const { response, parsed } = await providerFetch<string>(
      this.id,
      `${config.apiBaseUrl}${pathWithQuery}`,
      {
        method,
        headers: {
          "X-Hercle-Client": config.clientId,
          "X-Hercle-Ts": String(timestampSeconds),
          "X-Hercle-Signature": signature,
          ...(options.onBehalfOf ? { "on-behalf-of": options.onBehalfOf } : {}),
          ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
        },
        // Pre-serialized so the wire bytes are exactly the signed bytes.
        body: rawBody === "" ? undefined : rawBody,
      }
    );

    if (!response.ok) {
      const message = extractProviderErrorMessage(
        parsed,
        `Hercle request failed with status ${response.status}`
      );
      if (response.status === 401 || response.status === 403) {
        throw providerNotConfigured(
          `Hercle rejected the request (status ${response.status}): ${message}`
        );
      }
      throw new SdpPaymentsError(classifyProviderStatus(response.status), message, {
        provider: this.id,
        providerStatus: response.status,
      });
    }

    if (parsed === undefined) {
      throw new SdpPaymentsError(
        "PROVIDER_UNAVAILABLE",
        "Hercle returned an unparseable response",
        { provider: this.id }
      );
    }

    return parsed as T;
  }

  private parseWith<T>(schema: z.ZodType<T>, payload: unknown, label: string): T {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new SdpPaymentsError("PROVIDER_UNAVAILABLE", `Hercle ${label} response is malformed.`, {
        provider: this.id,
        issues: z.flattenError(parsed.error).fieldErrors,
      });
    }
    return parsed.data;
  }

  // ── Counterparty provisioning (called by the API-side ensure helpers) ──

  async createAccount(
    ctx: RampRuntimeContext,
    request: HercleCreateAccountRequest,
    idempotencyKey: string
  ): Promise<HercleAccountResponse> {
    return this.parseWith(
      hercleAccountResponseSchema,
      await this.request(ctx, "POST", "/partner/v1/accounts", { body: request, idempotencyKey }),
      "account"
    );
  }

  async createVerification(
    ctx: RampRuntimeContext,
    accountId: string,
    idempotencyKey: string
  ): Promise<HercleVerificationResponse> {
    return this.parseWith(
      hercleVerificationResponseSchema,
      await this.request(
        ctx,
        "POST",
        `/partner/v1/accounts/${encodeURIComponent(accountId)}/verifications`,
        { body: {}, idempotencyKey }
      ),
      "verification"
    );
  }

  async getVerification(
    ctx: RampRuntimeContext,
    accountId: string
  ): Promise<HercleVerificationResponse> {
    return this.parseWith(
      hercleVerificationResponseSchema,
      await this.request(
        ctx,
        "GET",
        `/partner/v1/accounts/${encodeURIComponent(accountId)}/verification`
      ),
      "verification"
    );
  }

  validateCounterparty(
    counterparty: Counterparty,
    options: ValidateCounterpartyOptions
  ): CounterpartyRequirements {
    return hercleCounterpartyRequirements(counterparty, options);
  }

  // ── Rails: static launch corridor (EUR -> USDC on Solana, on-ramp only) ──
  // Hercle's currencies endpoint ships with the ramps surface; until then the corridor
  // is an explicit tested snapshot (Stripe pattern) refreshed via this distillation.

  async _discoverRails(): Promise<void> {
    // No discovery API at launch — the snapshot below is authoritative.
  }

  async distillRailSupport(): Promise<ProviderRailSupportDistillation> {
    return {
      snapshot: {
        onramp: {
          currencies: { EUR: unreportedCurrencyLimit() },
          cryptos: ["usdc.solana"],
        },
        offramp: { currencies: {}, cryptos: [] },
      },
      droppedCurrencyCodes: [],
      droppedCountryCodes: [],
    };
  }

  // ── Estimates ──

  async estimateOnramp(
    ctx: RampRuntimeContext,
    input: RampEstimateOnrampInput
  ): Promise<PaymentRampEstimate> {
    const estimate = this.parseWith(
      hercleEstimateResponseSchema,
      await this.request(ctx, "POST", "/partner/v1/quotes/estimate", {
        body: {
          direction: "onramp",
          fiatCurrency: input.fiatCurrency,
          fiatAmount: input.fiatAmount,
          cryptoAsset: getCryptoRailAssetLabel(input.assetRail),
          network: railNetwork(input.assetRail),
        },
      }),
      "estimate"
    );

    return {
      provider: this.id,
      direction: "onramp",
      fiatCurrency: input.fiatCurrency,
      assetRail: input.assetRail,
      fiatAmount: estimate.fiatAmount,
      cryptoAmount: estimate.cryptoAmount,
      exchangeRate: estimate.exchangeRate,
      fees: { currency: input.fiatCurrency, total: estimate.fees.total },
      minFiatAmount: estimate.minFiatAmount,
      maxFiatAmount: estimate.maxFiatAmount,
      expiresAt: estimate.expiresAt,
    };
  }

  async estimateOfframp(
    _ctx: RampRuntimeContext,
    _input: RampEstimateOfframpInput
  ): Promise<PaymentRampEstimate> {
    throw badRequest("Hercle does not offer an off-ramp.", { provider: this.id });
  }

  // ── Quotes (the quote is the order — deliveryMode manual_instructions) ──

  async createOnrampQuote(
    ctx: RampRuntimeContext,
    input: RampOnrampQuoteInput
  ): Promise<PaymentRampQuote> {
    if (!input.fiatCurrency) {
      throw badRequest("fiatCurrency is required for a Hercle on-ramp order.", {
        provider: this.id,
      });
    }
    const assetRail = parseCryptoRail(input.cryptoToken);

    const order = this.parseWith(
      hercleOnrampOrderResponseSchema,
      await this.request(ctx, "POST", "/partner/v1/orders/onramp", {
        body: {
          fiatCurrency: input.fiatCurrency,
          fiatAmount: input.fiatAmount,
          cryptoAsset: getCryptoRailAssetLabel(assetRail),
          network: railNetwork(assetRail),
          destinationWalletAddress: input.destinationWalletAddress,
        },
        onBehalfOf: input.externalCustomerId,
        idempotencyKey: `sdp-onramp-${input.externalCustomerId}-${input.fiatCurrency}-${input.fiatAmount}-${input.destinationWalletAddress}`,
      }),
      "on-ramp order"
    );

    const instruction: HerclePaymentRampInstruction = {
      provider: "hercle",
      kind: "fiat_funding",
      fiatCurrency: order.fiatCurrency,
      bankAccount: order.bankAccount,
      instructionsNotes:
        order.bankAccount.payerAccountHolder === undefined
          ? `Wire ${order.fiatAmount} ${order.fiatCurrency} from your registered business account; include the payment reference so Hercle can match the transfer.`
          : `Wire ${order.fiatAmount} ${order.fiatCurrency} from a bank account held in the name of ${order.bankAccount.payerAccountHolder}; a transfer from any other account is returned by the bank. Include the payment reference so Hercle can match the transfer.`,
    };

    return {
      id: order.orderId,
      provider: "hercle",
      status: "pending",
      deliveryMode: "manual_instructions",
      paymentInstructions: [instruction],
      expiresAt: order.expiresAt,
    };
  }

  async createOfframpQuote(
    _ctx: RampRuntimeContext,
    _input: RampOfframpQuoteInput
  ): Promise<PaymentRampQuote> {
    throw badRequest("Hercle does not offer an off-ramp.", { provider: this.id });
  }

  /**
   * Sandbox only. Applies the outcome the bank rail would report, which Hercle
   * then delivers as a normal signed settlement webhook — so the event the client sees
   * is the production one, only its trigger is simulated.
   */
  async simulateSettlement(
    ctx: RampRuntimeContext,
    input: { orderId: string; status?: HercleSettlementStatus }
  ): Promise<unknown> {
    return this.request<unknown>(
      ctx,
      "POST",
      `/partner/v1/orders/${encodeURIComponent(input.orderId)}/simulate-settlement`,
      { body: { status: input.status ?? "settled" } }
    );
  }
}
