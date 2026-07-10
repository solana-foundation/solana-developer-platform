import { toNumberAmount } from "@sdp/solana/amount";
import type {
  Counterparty,
  PaymentRampEstimate,
  PaymentRampQuote,
  SdpEnvironment,
} from "@sdp/types";
import { getCryptoRailAssetLabel, type RampCurrencyLimit } from "@sdp/types/payment-rails";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { z } from "zod";
import {
  badRequest,
  internalError,
  providerNotConfigured,
  providerUnavailable,
} from "../../../errors";
import { readNumber, readRecord, readString } from "../../../json";
import { extractProviderErrorMessage, providerFetch, providerFetchJson } from "../../fetch";
import {
  isActiveIso4217CurrencyCode,
  isIso3166Alpha2CountryCode,
  RAMP_RAIL_DUMPS,
  requireEnv,
  SOLANA_ASSET_TO_RAIL,
  UNREPORTED_COUNTRY_SUPPORT,
  unreportedCurrencyLimit,
} from "../../shared";
import type {
  ProviderDeclaredRailSupport,
  ProviderRailSupportDistillation,
  RampEstimateOfframpInput,
  RampEstimateOnrampInput,
  RampOfframpQuoteInput,
  RampProvider,
  RampRawDumpReader,
  RampRuntimeContext,
  ValidateCounterpartyOptions,
} from "../../types";
import { muralCounterpartyRequirements } from "./counterparty";
import {
  MURAL_KYC_STATUSES,
  MURAL_TOS_STATUSES,
  type MuralAccountResolution,
  type MuralKycStatus,
  type MuralOrganizationResolution,
  type MuralPayinMethod,
} from "./provider-data";

const MURAL_PRODUCTION_BASE_URL = "https://api.muralpay.com";
const MURAL_SANDBOX_BASE_URL = "https://api-staging.muralpay.com";

export const MURAL_DECLARED_RAIL_SUPPORT = {
  onramp: { entityTypes: ["business"] },
  offramp: {
    countrySupport: UNREPORTED_COUNTRY_SUPPORT,
    entityTypes: [],
  },
} as const satisfies ProviderDeclaredRailSupport;

interface MuralConfig {
  apiKey: string;
  apiBaseUrl: string;
}

function readMuralConfig(
  env: Record<string, string | undefined>,
  mode: SdpEnvironment
): MuralConfig {
  const apiKey =
    mode === "sandbox" ? env.MURAL_PAY_SANDBOX_API_KEY?.trim() : env.MURAL_PAY_API_KEY?.trim();

  if (!apiKey) {
    throw providerNotConfigured(
      mode === "sandbox"
        ? "Mural sandbox is not configured. Set MURAL_PAY_SANDBOX_API_KEY."
        : "Mural is not configured. Set MURAL_PAY_API_KEY."
    );
  }

  return {
    apiKey,
    apiBaseUrl: mode === "sandbox" ? MURAL_SANDBOX_BASE_URL : MURAL_PRODUCTION_BASE_URL,
  };
}

function readMuralTransferApiKey(
  env: Record<string, string | undefined>,
  mode: SdpEnvironment
): string {
  const transferApiKey =
    mode === "sandbox"
      ? env.MURAL_PAY_SANDBOX_TRANSFER_API_KEY?.trim()
      : env.MURAL_PAY_TRANSFER_API_KEY?.trim();
  if (!transferApiKey) {
    throw providerNotConfigured(
      mode === "sandbox"
        ? "Mural sandbox transfer key is not configured. Set MURAL_PAY_SANDBOX_TRANSFER_API_KEY."
        : "Mural transfer key is not configured. Set MURAL_PAY_TRANSFER_API_KEY."
    );
  }
  return transferApiKey;
}

const MURAL_FIAT_RAIL_CODES = [
  "usd",
  "cop",
  "cop-bre-b",
  "cop-cobre-balance",
  "ars",
  "eur",
  "mxn",
  "brl",
  "clp",
  "pen",
  "bob",
  "crc",
  "zar",
  "usd-peru",
  "usd-china",
  "usd-panama",
  "usd-hong-kong",
] as const;

const muralCountrySchema = z.object({
  alpha2Code: z.string(),
  name: z.string(),
  subdivisions: z.array(z.object({ code: z.string(), name: z.string() })),
});

const muralCountriesResponseSchema = z.object({
  count: z.number().optional(),
  countries: z.array(muralCountrySchema),
});

function muralRailCurrencyCode(railCode: string, droppedCurrencyCodes: Set<string>): string | null {
  const currencyCodePart = railCode.split("-")[0];
  if (currencyCodePart.length === 0) {
    throw providerUnavailable(`Mural rail code "${railCode}" does not contain a currency prefix.`);
  }
  const currencyCode = currencyCodePart.toUpperCase();
  if (!isActiveIso4217CurrencyCode(currencyCode)) {
    droppedCurrencyCodes.add(currencyCode);
    return null;
  }
  return currencyCode;
}

export function distillMuralRailSupport(raw: unknown): ProviderRailSupportDistillation {
  const dump = z.record(z.string(), z.object({ status: z.number(), body: z.unknown() })).parse(raw);
  const countriesByCurrency = new Map<string, Set<string>>();
  const currenciesByCountry = new Map<string, Set<string>>();
  const droppedCurrencyCodes = new Set<string>();
  const droppedCountryCodes = new Set<string>();

  for (const [railCode, response] of Object.entries(dump)) {
    if (response.status < 200 || response.status >= 300) {
      throw providerUnavailable(
        `Mural countries dump for ${railCode} returned ${response.status}.`
      );
    }
    const parsed = muralCountriesResponseSchema.parse(response.body);
    if (parsed.countries.length === 0) {
      continue;
    }
    const currencyCode = muralRailCurrencyCode(railCode, droppedCurrencyCodes);
    if (currencyCode === null) {
      continue;
    }
    let countries = countriesByCurrency.get(currencyCode);
    if (countries === undefined) {
      countries = new Set<string>();
      countriesByCurrency.set(currencyCode, countries);
    }
    for (const country of parsed.countries) {
      const countryCode = country.alpha2Code.trim().toUpperCase();
      if (!isIso3166Alpha2CountryCode(countryCode)) {
        droppedCountryCodes.add(countryCode);
        continue;
      }
      countries.add(countryCode);
      let currencies = currenciesByCountry.get(countryCode);
      if (currencies === undefined) {
        currencies = new Set<string>();
        currenciesByCountry.set(countryCode, currencies);
      }
      currencies.add(currencyCode);
    }
  }

  if (countriesByCurrency.size === 0) {
    throw providerUnavailable("Mural countries dump contained no supported fiat rails.");
  }

  const onrampCurrencies: Record<string, RampCurrencyLimit> = {};
  for (const currencyCode of [...countriesByCurrency.keys()].sort()) {
    onrampCurrencies[currencyCode] = unreportedCurrencyLimit();
  }
  const countrySupportCountries: Record<string, readonly string[]> = {};
  for (const countryCode of [...currenciesByCountry.keys()].sort()) {
    const currencies = currenciesByCountry.get(countryCode);
    if (currencies === undefined) {
      throw providerUnavailable(`Mural country support missing currency list for ${countryCode}.`);
    }
    countrySupportCountries[countryCode] = [...currencies].sort();
  }

  return {
    snapshot: {
      onramp: {
        currencies: onrampCurrencies,
        cryptos: [SOLANA_ASSET_TO_RAIL.USDC],
        countrySupport: { coverage: "by-country", countries: countrySupportCountries },
      },
      offramp: {
        currencies: {},
        cryptos: [],
      },
    },
    droppedCurrencyCodes: [...droppedCurrencyCodes].sort(),
    droppedCountryCodes: [...droppedCountryCodes].sort(),
  };
}

interface MuralTokenToFiatRequest {
  tokenFeeRequests: ReadonlyArray<{
    amount: { tokenAmount: number; tokenSymbol: string };
    fiatAndRailCode: string;
  }>;
}

const muralTokenAmountSchema = z.object({
  tokenAmount: z.number(),
  tokenSymbol: z.string(),
});

const muralTokenToFiatFeeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("success"),
    exchangeRate: z.number(),
    estimatedFiatAmount: z.object({ fiatAmount: z.number(), fiatCurrencyCode: z.string() }),
    tokenAmount: muralTokenAmountSchema,
    feeTotal: muralTokenAmountSchema,
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
  }),
]);

const muralTokenToFiatResponseSchema = z.array(muralTokenToFiatFeeSchema);

interface MuralFiatToTokenRequest {
  fiatFeeRequests: ReadonlyArray<{
    fiatAmount: number;
    tokenSymbol: string;
    fiatAndRailCode: string;
  }>;
}

const muralFiatToTokenFeeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("success"),
    exchangeRate: z.number(),
    estimatedTokenAmountRequired: muralTokenAmountSchema,
    fiatAmount: z.object({ fiatAmount: z.number(), fiatCurrencyCode: z.string() }),
    feeTotal: muralTokenAmountSchema,
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

const muralFiatToTokenResponseSchema = z.array(muralFiatToTokenFeeSchema);

const muralOrganizationSchema = z.object({
  id: z.string().min(1),
  type: z.string(),
  tosStatus: z.enum(MURAL_TOS_STATUSES),
  kycStatus: z.object({ type: z.enum(MURAL_KYC_STATUSES) }),
});

const muralTosLinkSchema = z.object({ tosLink: z.string().min(1) });
const muralKycLinkSchema = z.object({ kycLink: z.string().min(1) });

export type MuralCreateOrganizationRequest =
  | { type: "individual"; firstName: string; lastName: string; email: string }
  | { type: "business"; businessName: string; email: string };

const muralPayinMethodSchema = z.object({
  status: z.string(),
  payinRailDetails: z.looseObject({ currency: z.string() }),
});

const muralAccountSchema = z.object({
  id: z.string().min(1),
  isApiEnabled: z.boolean(),
  status: z.string(),
  accountDetails: z.object({ payinMethods: z.array(muralPayinMethodSchema).optional() }).optional(),
});

const muralAccountsResponseSchema = z.array(muralAccountSchema);

export interface MuralPhysicalAddress {
  address1: string;
  country: string;
  state: string;
  city: string;
  zip: string;
}

export type MuralPayoutRecipientInfo =
  | {
      type: "individual";
      firstName: string;
      lastName: string;
      physicalAddress: MuralPhysicalAddress;
      email?: string;
    }
  | { type: "business"; name: string; physicalAddress: MuralPhysicalAddress; email?: string };

const muralPayoutRequestSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  transactionHash: z.string().optional(),
});

export type MuralWebhookEvent =
  | { kind: "kyc_status"; organizationId: string; kycStatus: MuralKycStatus }
  | { kind: "tos_accepted"; organizationId: string }
  | { kind: "account_credited"; organizationId: string; accountId: string; tokenAmount: number }
  | { kind: "payout_settled"; organizationId: string; payoutRequestId: string }
  | { kind: "payout_failed"; organizationId: string; payoutRequestId: string }
  | { kind: "ignore"; reason: string };

function parseMuralOrganizationResponse(response: unknown): MuralOrganizationResolution {
  const parsed = muralOrganizationSchema.safeParse(response);
  if (!parsed.success) {
    throw providerUnavailable("Mural organization response is malformed.", {
      provider: "mural",
      issues: z.flattenError(parsed.error).fieldErrors,
    });
  }
  return {
    id: parsed.data.id,
    type: parsed.data.type,
    tosStatus: parsed.data.tosStatus,
    kycStatus: parsed.data.kycStatus.type,
  };
}

function parseMuralPayoutRequest(response: unknown): {
  payoutRequestId: string;
  transactionHash?: string;
} {
  const parsed = muralPayoutRequestSchema.safeParse(response);
  if (!parsed.success) {
    throw providerUnavailable("Mural payout request response is malformed.", {
      provider: "mural",
      issues: z.flattenError(parsed.error).fieldErrors,
    });
  }
  if (parsed.data.transactionHash) {
    return { payoutRequestId: parsed.data.id, transactionHash: parsed.data.transactionHash };
  }
  return { payoutRequestId: parsed.data.id };
}

function parseMuralPayoutWebhookEvent(
  body: Record<string, unknown>,
  organizationId: string
): MuralWebhookEvent {
  const payoutRequestId = readString(body.payoutRequestId);
  const statusChangeDetails = readRecord(body.statusChangeDetails);
  const currentStatus =
    statusChangeDetails === undefined ? undefined : readRecord(statusChangeDetails.currentStatus);
  const status = currentStatus === undefined ? undefined : readString(currentStatus.type);
  if (!payoutRequestId) {
    throw badRequest('Mural "payout_request_status_changed" webhook is missing payoutRequestId', {
      provider: "mural",
    });
  }
  if (status === undefined) {
    throw badRequest(
      'Mural "payout_request_status_changed" webhook is missing the current status',
      { provider: "mural" }
    );
  }
  if (status === "executed") {
    return { kind: "payout_settled", organizationId, payoutRequestId };
  }
  if (status === "failed") {
    return { kind: "payout_failed", organizationId, payoutRequestId };
  }
  return { kind: "ignore", reason: `payout_status:${status}` };
}

function parseMuralWebhookEvent(payload: unknown): MuralWebhookEvent {
  const root = readRecord(payload);
  const body = root === undefined ? undefined : readRecord(root.payload);
  if (body === undefined) {
    throw badRequest("Mural webhook is missing the payload envelope", { provider: "mural" });
  }
  const type = readString(body.type);
  if (
    type !== "verification_status_changed" &&
    type !== "tos_accepted" &&
    type !== "account_credited" &&
    type !== "payout_request_status_changed"
  ) {
    return { kind: "ignore", reason: `unhandled_event:${type === undefined ? "unknown" : type}` };
  }
  const organizationId = readString(body.organizationId);
  if (!organizationId) {
    throw badRequest(`Mural "${type}" webhook is missing organizationId`, { provider: "mural" });
  }

  switch (type) {
    case "verification_status_changed": {
      const currentStatus = readRecord(body.currentStatus);
      const status = currentStatus === undefined ? undefined : readString(currentStatus.type);
      if (status === undefined) {
        throw badRequest(
          'Mural "verification_status_changed" webhook is missing the current status',
          { provider: "mural" }
        );
      }
      const parsedStatus = z.enum(MURAL_KYC_STATUSES).safeParse(status);
      if (!parsedStatus.success) {
        return { kind: "ignore", reason: `unknown_kyc_status:${status}` };
      }
      return { kind: "kyc_status", organizationId, kycStatus: parsedStatus.data };
    }
    case "tos_accepted":
      return { kind: "tos_accepted", organizationId };
    case "account_credited": {
      const accountId = readString(body.accountId);
      const tokenAmountRecord = readRecord(body.tokenAmount);
      const tokenAmount =
        tokenAmountRecord === undefined ? undefined : readNumber(tokenAmountRecord.tokenAmount);
      if (!accountId || tokenAmount === undefined) {
        throw badRequest('Mural "account_credited" webhook is missing accountId or tokenAmount', {
          provider: "mural",
        });
      }
      return { kind: "account_credited", organizationId, accountId, tokenAmount };
    }
    case "payout_request_status_changed":
      return parseMuralPayoutWebhookEvent(body, organizationId);
  }
}

export class MuralRampClient implements RampProvider {
  readonly id = "mural";
  readonly declaredRailSupport = MURAL_DECLARED_RAIL_SUPPORT;

  private async requestJson<TResponse, TBody>(
    { env, mode }: RampRuntimeContext,
    method: "GET" | "POST",
    path: string,
    options: {
      body?: TBody;
      headers?: Record<string, string>;
    }
  ): Promise<TResponse> {
    const { apiKey, apiBaseUrl } = readMuralConfig(env, mode);
    return providerFetchJson<TResponse, TBody>(this.id, `${apiBaseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, ...options.headers },
      body: options.body,
    });
  }

  private async requestMaybeEmpty<TBody>(
    { env, mode }: RampRuntimeContext,
    method: "GET" | "POST",
    path: string,
    options: {
      body?: TBody;
      headers?: Record<string, string>;
    }
  ): Promise<unknown> {
    const { apiKey, apiBaseUrl } = readMuralConfig(env, mode);
    const { response, parsed } = await providerFetch<TBody>(this.id, `${apiBaseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, ...options.headers },
      body: options.body,
    });
    if (!response.ok) {
      throw providerUnavailable(
        extractProviderErrorMessage(parsed, `Mural request failed with status ${response.status}`),
        { provider: this.id, providerStatus: response.status }
      );
    }
    if (parsed === undefined) {
      return null;
    }
    return parsed;
  }

  async createOrganization(
    ctx: RampRuntimeContext,
    request: MuralCreateOrganizationRequest
  ): Promise<MuralOrganizationResolution> {
    return parseMuralOrganizationResponse(
      await this.requestJson<unknown, MuralCreateOrganizationRequest>(
        ctx,
        "POST",
        "/api/organizations",
        { body: request }
      )
    );
  }

  async getOrganization(
    ctx: RampRuntimeContext,
    organizationId: string
  ): Promise<MuralOrganizationResolution> {
    return parseMuralOrganizationResponse(
      await this.requestJson<unknown, never>(
        ctx,
        "GET",
        `/api/organizations/${encodeURIComponent(organizationId)}`,
        {}
      )
    );
  }

  async getTosLink(ctx: RampRuntimeContext, organizationId: string): Promise<string> {
    const response = await this.requestJson<unknown, never>(
      ctx,
      "GET",
      `/api/organizations/${encodeURIComponent(organizationId)}/tos-link`,
      {}
    );
    const parsed = muralTosLinkSchema.safeParse(response);
    if (!parsed.success) {
      throw providerUnavailable("Mural TOS link response is malformed.", { provider: this.id });
    }
    return parsed.data.tosLink;
  }

  async getKycLink(ctx: RampRuntimeContext, organizationId: string): Promise<string> {
    const response = await this.requestJson<unknown, never>(
      ctx,
      "GET",
      `/api/organizations/${encodeURIComponent(organizationId)}/kyc-link/v2`,
      {}
    );
    const parsed = muralKycLinkSchema.safeParse(response);
    if (!parsed.success) {
      throw providerUnavailable("Mural KYC link response is malformed.", { provider: this.id });
    }
    return parsed.data.kycLink;
  }

  async listAccounts(
    ctx: RampRuntimeContext,
    organizationId: string
  ): Promise<MuralAccountResolution[]> {
    const response = await this.requestJson<unknown, never>(ctx, "GET", "/api/accounts", {
      headers: { "on-behalf-of": organizationId },
    });
    const parsed = muralAccountsResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw providerUnavailable("Mural accounts response is malformed.", {
        provider: this.id,
        issues: z.flattenError(parsed.error).fieldErrors,
      });
    }
    return parsed.data.map((account): MuralAccountResolution => {
      const accountDetails = account.accountDetails;
      const payinMethods =
        accountDetails === undefined || accountDetails.payinMethods === undefined
          ? []
          : accountDetails.payinMethods.map(
              (method): MuralPayinMethod => ({
                status: method.status,
                currency: method.payinRailDetails.currency,
                payinRailDetails: method.payinRailDetails,
              })
            );
      return {
        id: account.id,
        isApiEnabled: account.isApiEnabled,
        status: account.status,
        payinMethods,
      };
    });
  }

  async createAccount(
    ctx: RampRuntimeContext,
    organizationId: string,
    name: string
  ): Promise<void> {
    await this.requestMaybeEmpty(ctx, "POST", "/api/accounts", {
      body: { name },
      headers: { "on-behalf-of": organizationId },
    });
  }

  /**
   * Triggers a sandbox fiat payin. `amountValue` is in the currency's minor
   * units (cents) per Mural's `/api/sandbox/simulate/payin` amount contract.
   */
  async simulatePayin(
    ctx: RampRuntimeContext,
    input: {
      organizationId: string;
      destinationAccountId: string;
      rail: "ach" | "wire" | "spei" | "pix" | "cvu";
      amountValue: string;
      currencySymbol: string;
    }
  ): Promise<unknown> {
    return this.requestMaybeEmpty(ctx, "POST", "/api/sandbox/simulate/payin", {
      body: {
        destinationAccountId: input.destinationAccountId,
        rail: {
          type: input.rail,
          amount: { value: input.amountValue, currencySymbol: input.currencySymbol },
        },
      },
      headers: { "on-behalf-of": input.organizationId },
    });
  }

  async createPayout(
    ctx: RampRuntimeContext,
    input: {
      organizationId: string;
      sourceAccountId: string;
      tokenAmount: number;
      walletAddress: string;
      recipientInfo: MuralPayoutRecipientInfo;
      idempotencyKey: string;
    }
  ): Promise<{ payoutRequestId: string; transactionHash?: string }> {
    return parseMuralPayoutRequest(
      await this.requestJson<unknown, unknown>(ctx, "POST", "/api/payouts/payout", {
        body: {
          sourceAccountId: input.sourceAccountId,
          payouts: [
            {
              amount: { tokenAmount: input.tokenAmount, tokenSymbol: "USD" },
              payoutDetails: {
                type: "blockchain",
                walletDetails: { walletAddress: input.walletAddress, blockchain: "SOLANA" },
              },
              recipientInfo: input.recipientInfo,
            },
          ],
        },
        headers: { "on-behalf-of": input.organizationId, "idempotency-key": input.idempotencyKey },
      })
    );
  }

  async executePayout(
    ctx: RampRuntimeContext,
    input: { organizationId: string; payoutRequestId: string }
  ): Promise<{ payoutRequestId: string; transactionHash?: string }> {
    const transferApiKey = readMuralTransferApiKey(ctx.env, ctx.mode);
    return parseMuralPayoutRequest(
      await this.requestJson<unknown, never>(
        ctx,
        "POST",
        `/api/payouts/payout/${encodeURIComponent(input.payoutRequestId)}/execute`,
        { headers: { "on-behalf-of": input.organizationId, "transfer-api-key": transferApiKey } }
      )
    );
  }

  validateCounterparty(
    counterparty: Counterparty,
    options: ValidateCounterpartyOptions
  ): CounterpartyRequirements {
    return muralCounterpartyRequirements(counterparty, options);
  }

  async _discoverRails({
    env,
    fetchJson,
    writeDump,
  }: Parameters<RampProvider["_discoverRails"]>[0]) {
    const apiKey = requireEnv(env, "MURAL_PAY_SANDBOX_API_KEY");
    const headers = { Authorization: `Bearer ${apiKey}` };

    const entries = await Promise.all(
      MURAL_FIAT_RAIL_CODES.map(
        async (railCode) =>
          [
            railCode,
            await fetchJson(
              this.id,
              `GET /api/utilities/countries/${railCode}`,
              `${MURAL_SANDBOX_BASE_URL}/api/utilities/countries/${railCode}`,
              { headers }
            ),
          ] as const
      )
    );

    await writeDump(RAMP_RAIL_DUMPS.mural.countries.name, {
      status: 200,
      body: Object.fromEntries(entries),
    });
  }

  async distillRailSupport(readDump: RampRawDumpReader): Promise<ProviderRailSupportDistillation> {
    return distillMuralRailSupport(await readDump(RAMP_RAIL_DUMPS.mural.countries.file));
  }

  parseMuralWebhookEvent(payload: unknown): MuralWebhookEvent {
    return parseMuralWebhookEvent(payload);
  }

  async estimateOnramp(
    { env, mode }: RampRuntimeContext,
    input: RampEstimateOnrampInput
  ): Promise<PaymentRampEstimate> {
    const { apiKey, apiBaseUrl } = readMuralConfig(env, mode);
    const tokenSymbol = getCryptoRailAssetLabel(input.assetRail);

    const response = await providerFetchJson<unknown, MuralFiatToTokenRequest>(
      this.id,
      `${apiBaseUrl}/api/payouts/fees/fiat-to-token`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: {
          fiatFeeRequests: [
            {
              fiatAmount: toNumberAmount(input.fiatAmount),
              tokenSymbol,
              fiatAndRailCode: input.fiatCurrency.toLowerCase(),
            },
          ],
        },
      }
    );

    const parsed = muralFiatToTokenResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw providerUnavailable("Mural fiat-to-token response is malformed.", {
        provider: this.id,
        issues: z.flattenError(parsed.error).fieldErrors,
      });
    }
    if (parsed.data.length === 0) {
      throw providerUnavailable("Mural returned no fiat-to-token result.", { provider: this.id });
    }
    const fee = parsed.data[0];
    if (fee === undefined) {
      throw providerUnavailable("Mural returned no fiat-to-token result.", { provider: this.id });
    }
    if (fee.type === "error") {
      throw providerUnavailable(`Mural on-ramp estimate failed: ${fee.message}`, {
        provider: this.id,
      });
    }
    if (fee.estimatedTokenAmountRequired.tokenAmount <= 0) {
      throw providerUnavailable("Mural returned a non-positive on-ramp token amount.", {
        provider: this.id,
      });
    }

    return {
      provider: this.id,
      direction: "onramp",
      fiatCurrency: input.fiatCurrency,
      assetRail: input.assetRail,
      fiatAmount: input.fiatAmount,
      cryptoAmount: String(fee.estimatedTokenAmountRequired.tokenAmount),
      exchangeRate: String(fee.exchangeRate),
      fees: {
        currency: tokenSymbol,
        total: String(fee.feeTotal.tokenAmount),
        provider: String(fee.feeTotal.tokenAmount),
      },
    };
  }

  async estimateOfframp(
    { env, mode }: RampRuntimeContext,
    input: RampEstimateOfframpInput
  ): Promise<PaymentRampEstimate> {
    const { apiKey, apiBaseUrl } = readMuralConfig(env, mode);
    const tokenSymbol = getCryptoRailAssetLabel(input.assetRail);

    const response = await providerFetchJson<unknown, MuralTokenToFiatRequest>(
      this.id,
      `${apiBaseUrl}/api/payouts/fees/token-to-fiat`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: {
          tokenFeeRequests: [
            {
              amount: { tokenAmount: toNumberAmount(input.cryptoAmount), tokenSymbol },
              fiatAndRailCode: input.fiatCurrency.toLowerCase(),
            },
          ],
        },
      }
    );

    const parsed = muralTokenToFiatResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw providerUnavailable("Mural token-to-fiat response is malformed.", {
        provider: this.id,
        issues: z.flattenError(parsed.error).fieldErrors,
      });
    }
    if (parsed.data.length === 0) {
      throw providerUnavailable("Mural returned no token-to-fiat result.", { provider: this.id });
    }
    const fee = parsed.data[0];
    if (fee === undefined) {
      throw providerUnavailable("Mural returned no token-to-fiat result.", { provider: this.id });
    }
    if (fee.type === "error") {
      throw providerUnavailable(`Mural off-ramp estimate failed: ${fee.message}`, {
        provider: this.id,
      });
    }
    if (fee.estimatedFiatAmount.fiatAmount <= 0) {
      throw providerUnavailable("Mural returned a non-positive off-ramp fiat amount.", {
        provider: this.id,
      });
    }

    return {
      provider: this.id,
      direction: "offramp",
      fiatCurrency: input.fiatCurrency,
      assetRail: input.assetRail,
      fiatAmount: String(fee.estimatedFiatAmount.fiatAmount),
      cryptoAmount: String(fee.tokenAmount.tokenAmount),
      exchangeRate: String(fee.exchangeRate),
      fees: {
        currency: tokenSymbol,
        total: String(fee.feeTotal.tokenAmount),
        provider: String(fee.feeTotal.tokenAmount),
      },
    };
  }

  async createOfframpQuote(
    _ctx: RampRuntimeContext,
    _input: RampOfframpQuoteInput
  ): Promise<PaymentRampQuote> {
    throw internalError("Mural off-ramp quote is not implemented yet.");
  }
}

export { parseMuralWebhookEvent };
