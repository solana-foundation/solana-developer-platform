import type {
  Counterparty,
  PaymentRampEstimate,
  PaymentRampQuote,
  SdpEnvironment,
} from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import { getCryptoRailAssetLabel, type RampCurrencyLimit } from "@sdp/types/payment-rails";
import {
  checkRampDestination,
  MONEYGRAM_WIDGET_APPROVED_HOSTS,
} from "@sdp/types/ramp-destinations";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { z } from "zod";
import {
  estimateNotAvailable,
  internalError,
  providerNotConfigured,
  providerUnavailable,
} from "../../../errors";
import { providerFetchJson } from "../../fetch";
import { readyCounterparty } from "../../requirements";
import {
  isActiveIso4217CurrencyCode,
  paymentTransferUuid,
  RAMP_RAIL_DUMPS,
  requireEnv,
  UNREPORTED_COUNTRY_SUPPORT,
  unreportedCurrencyLimit,
} from "../../shared";
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

const MONEYGRAM_SANDBOX_BASE_URL = "https://playground.xramps.moneygram.com";

const MONEYGRAM_REQUEST_TIMEOUT_MS = 30_000;

export const MONEYGRAM_DECLARED_RAIL_SUPPORT = {
  onramp: {
    countrySupport: UNREPORTED_COUNTRY_SUPPORT,
    entityTypes: ["individual"],
  },
  offramp: {
    countrySupport: UNREPORTED_COUNTRY_SUPPORT,
    entityTypes: ["individual"],
  },
} as const satisfies ProviderDeclaredRailSupport;

const MONEYGRAM_OFFRAMP_DESTINATION: Partial<Record<RampFiatCurrency, string>> = {
  USD: "USA",
  MXN: "MEX",
};

const MONEYGRAM_ORIGINATING_COUNTRY = "USA";

const MONEYGRAM_ONRAMP_DESTINATION = {
  country: "USA",
  subdivision: "US-TX",
} as const;

const moneygramCurrencyEntrySchema = z.object({
  code: z.string(),
  type: z.string(),
});

const amountDetailSchema = z.object({
  value: z.number(),
  currencyCode: z.string(),
});

const withdrawEstimateSchema = z.object({
  sendAmountDetails: z.object({
    partnerFees: amountDetailSchema,
    totalAmount: amountDetailSchema,
  }),
  payoutAmountDetails: z.object({
    fxRate: z.number(),
    totalAmount: amountDetailSchema,
  }),
});

const cashInQuoteSchema = z.object({
  serviceOptions: z.array(
    z.object({
      serviceOptionCode: z.string(),
      quote: z.object({
        sendAmount: z.object({ value: z.string(), currency: z.string() }),
        receiveAmount: z.object({ value: z.string(), currency: z.string() }),
        fees: z.object({
          mgi: z.object({ value: z.string(), currency: z.string() }),
          partner: z.object({ value: z.string(), currency: z.string() }),
          total: z.object({ value: z.string(), currency: z.string() }),
        }),
        exchangeRate: z.number(),
      }),
    })
  ),
});

const sessionSchema = z.object({
  sessionToken: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  widgetUrl: z.string().trim().min(1),
  walletType: z.literal("custodial"),
});

const MONEYGRAM_AWAITING_FUNDS_STATUS = "awaiting_funds";

const listedTransactionSchema = z.object({
  transactionId: z.string().trim().min(1),
  customerIdentifier: z.string().trim().min(1),
  mgiProfileId: z.string().trim().min(1).nullable(),
  transactionType: z.enum(["cash-in", "cash-out"]),
  sendAsset: z.string().trim().min(1),
  sendChain: z.string().trim().min(1),
});

const transactionListSchema = z.object({
  transactions: z.array(listedTransactionSchema),
});

const transactionStatusSchema = z.object({
  status: z.string().trim().min(1),
  asset: z.string().trim().min(1),
  depositAddress: z.string().trim().min(1).optional(),
  depositMemo: z.string().trim().min(1).optional(),
  sendAmount: z.string().trim().min(1).optional(),
});

/**
 * The deposit instruction MoneyGram is waiting on for a committed off-ramp:
 * the Ramps status API says `awaiting_funds` and names the address and amount.
 */
export interface MoneygramAwaitingDeposit {
  depositAddress: string;
  depositMemo?: string;
  sendAmount: string;
}

interface MoneygramSessionInput {
  customerIdentifier: string;
  walletAddress: string;
  walletTransactionId: string;
}

/**
 * A MoneyGram transaction proven to belong to the counterparty: it carries the
 * customerIdentifier SDP sent when the counterparty's sessions were minted.
 */
export interface MoneygramOwnedTransaction {
  profileId: string;
  transactionType: "cash-in" | "cash-out";
}

type MoneygramSession = z.infer<typeof sessionSchema>;

function requireWalletTransactionId(paymentTransferId: string | undefined): string {
  if (paymentTransferId === undefined) {
    throw internalError("MoneyGram sessions require the SDP payment transfer id.");
  }
  return paymentTransferUuid(paymentTransferId);
}

function requireMoneygramSecretKey(
  env: Record<string, string | undefined>,
  mode: SdpEnvironment
): string {
  if (mode !== "sandbox") {
    throw providerNotConfigured("MoneyGram is sandbox-only during the pilot.");
  }
  return requireEnv(env, "MONEYGRAM_SANDBOX_SECRET_KEY");
}

export function distillMoneygramRailSupport(raw: unknown): ProviderRailSupportDistillation {
  const currencies = z.array(moneygramCurrencyEntrySchema).parse(raw);
  const droppedCodes = new Set<string>();
  const offrampCurrencies: Record<string, RampCurrencyLimit> = {};
  for (const entry of currencies) {
    if (entry.type !== "fiat") {
      continue;
    }
    const code = entry.code.trim().toUpperCase();
    if (!isActiveIso4217CurrencyCode(code)) {
      droppedCodes.add(code);
      continue;
    }
    offrampCurrencies[code] = unreportedCurrencyLimit();
  }
  if (Object.keys(offrampCurrencies).length === 0) {
    throw new Error("MoneyGram currencies dump contained no fiat currencies.");
  }
  return {
    snapshot: {
      onramp: {
        currencies: { USD: unreportedCurrencyLimit() },
        cryptos: ["usdc.solana"],
      },
      offramp: {
        currencies: offrampCurrencies,
        cryptos: ["usdc.solana"],
      },
    },
    droppedCurrencyCodes: [...droppedCodes].sort(),
    droppedCountryCodes: [],
  };
}

export class MoneygramRampClient implements RampProvider {
  readonly id = "moneygram";
  readonly declaredRailSupport = MONEYGRAM_DECLARED_RAIL_SUPPORT;

  validateCounterparty(
    _counterparty: Counterparty,
    options: ValidateCounterpartyOptions
  ): CounterpartyRequirements {
    return readyCounterparty(this.id, options.direction);
  }

  async discoverCurrencyAndRails(
    context: RampDiscoveryContext
  ): Promise<ProviderRailSupportDistillation> {
    if (!context.offline) {
      const { env, fetchJson, writeDump } = context;
      await writeDump(
        RAMP_RAIL_DUMPS.moneygram.currencies.name,
        await fetchJson(
          this.id,
          "GET /api/v1/currencies",
          `${MONEYGRAM_SANDBOX_BASE_URL}/api/v1/currencies`,
          {
            headers: {
              "x-api-key": requireEnv(env, "MONEYGRAM_SANDBOX_PUBLIC_KEY"),
              "User-Agent": "sdp-api/ramps",
            },
          }
        )
      );
    }
    return distillMoneygramRailSupport(
      await context.readDump(RAMP_RAIL_DUMPS.moneygram.currencies.file)
    );
  }

  async estimateOnramp(
    { env, mode }: RampRuntimeContext,
    input: RampEstimateOnrampInput
  ): Promise<PaymentRampEstimate> {
    if (input.fiatCurrency !== "USD") {
      throw estimateNotAvailable("MoneyGram on-ramp is limited to USD during the pilot.", {
        provider: this.id,
      });
    }
    const secretKey = requireMoneygramSecretKey(env, mode);
    const asset = getCryptoRailAssetLabel(input.assetRail);
    const response = await providerFetchJson<unknown, Record<string, unknown>>(
      this.id,
      `${MONEYGRAM_SANDBOX_BASE_URL}/api/v1/quotes`,
      {
        method: "POST",
        headers: { "x-api-key": secretKey, "User-Agent": "sdp-api/ramps" },
        body: {
          destinationCountry: MONEYGRAM_ONRAMP_DESTINATION.country,
          destinationSubdivision: MONEYGRAM_ONRAMP_DESTINATION.subdivision,
          sendAmount: Number(input.fiatAmount),
          asset,
          chain: "solana",
          transactionType: "cash-in",
          serviceOptionCode: "DIRECT_TO_ACCT",
          receiveCurrencyCode: input.fiatCurrency,
        },
      }
    );
    const parsed = cashInQuoteSchema.safeParse(response);
    if (!parsed.success) {
      throw providerUnavailable("MoneyGram on-ramp estimate response is malformed.", {
        provider: this.id,
        issues: z.flattenError(parsed.error).fieldErrors,
      });
    }
    const option = parsed.data.serviceOptions.find(
      ({ serviceOptionCode }) => serviceOptionCode === "DIRECT_TO_ACCT"
    );
    if (!option) {
      throw estimateNotAvailable("MoneyGram did not return a cash-in service option.", {
        provider: this.id,
      });
    }
    if (option.quote.fees.total.currency !== input.fiatCurrency) {
      throw providerUnavailable("MoneyGram returned on-ramp fees outside the fiat send currency.", {
        provider: this.id,
      });
    }
    if (option.quote.receiveAmount.currency !== asset) {
      throw providerUnavailable(
        "MoneyGram returned an on-ramp receive amount outside the crypto asset.",
        { provider: this.id }
      );
    }
    return {
      provider: this.id,
      direction: "onramp",
      fiatCurrency: input.fiatCurrency,
      assetRail: input.assetRail,
      fiatAmount: option.quote.sendAmount.value,
      cryptoAmount: option.quote.receiveAmount.value,
      exchangeRate: String(option.quote.exchangeRate),
      fees: {
        currency: input.fiatCurrency,
        total: option.quote.fees.total.value,
        provider: option.quote.fees.mgi.value,
      },
    };
  }

  async createOnrampQuote(
    ctx: RampRuntimeContext,
    input: RampOnrampQuoteInput
  ): Promise<PaymentRampQuote> {
    return this.createSessionQuote(ctx, "on-ramp", {
      customerIdentifier: input.externalCustomerId,
      walletAddress: input.destinationWalletAddress,
      walletTransactionId: requireWalletTransactionId(input.paymentTransferId),
    });
  }

  async estimateOfframp(
    { env, mode }: RampRuntimeContext,
    input: RampEstimateOfframpInput
  ): Promise<PaymentRampEstimate> {
    const destinationCountryCode = MONEYGRAM_OFFRAMP_DESTINATION[input.fiatCurrency];
    if (!destinationCountryCode) {
      throw estimateNotAvailable(
        `MoneyGram off-ramp estimates are limited to ${Object.keys(MONEYGRAM_OFFRAMP_DESTINATION).join(", ")} during the pilot.`,
        { provider: this.id }
      );
    }

    const secretKey = requireMoneygramSecretKey(env, mode);
    const sendCurrencyCode = getCryptoRailAssetLabel(input.assetRail);

    const url = new URL(
      `${MONEYGRAM_SANDBOX_BASE_URL}/api/v1/crypto/withdraw/estimateQuoteWithFee`
    );
    url.searchParams.set("amount", input.cryptoAmount);
    url.searchParams.set("originatingCountryCode", MONEYGRAM_ORIGINATING_COUNTRY);
    url.searchParams.set("destinationCountryCode", destinationCountryCode);
    url.searchParams.set("sendCurrencyCode", sendCurrencyCode);
    url.searchParams.set("receiveCurrencyCode", input.fiatCurrency);

    const response = await providerFetchJson<unknown>(this.id, url.toString(), {
      method: "GET",
      headers: { "x-api-key": secretKey, "User-Agent": "sdp-api/ramps" },
    });

    const parsed = withdrawEstimateSchema.safeParse(response);
    if (!parsed.success) {
      throw providerUnavailable("MoneyGram estimate response is malformed.", {
        provider: this.id,
        issues: z.flattenError(parsed.error).fieldErrors,
      });
    }

    const { sendAmountDetails, payoutAmountDetails } = parsed.data;
    const partnerFee = String(sendAmountDetails.partnerFees.value);

    return {
      provider: this.id,
      direction: "offramp",
      fiatCurrency: input.fiatCurrency,
      assetRail: input.assetRail,
      fiatAmount: String(payoutAmountDetails.totalAmount.value),
      cryptoAmount: String(sendAmountDetails.totalAmount.value),
      exchangeRate: String(payoutAmountDetails.fxRate),
      fees: {
        currency: sendCurrencyCode,
        total: partnerFee,
        provider: partnerFee,
      },
    };
  }

  async createOfframpQuote(
    ctx: RampRuntimeContext,
    input: RampOfframpQuoteInput
  ): Promise<PaymentRampQuote> {
    return this.createSessionQuote(ctx, "off-ramp", {
      customerIdentifier: input.externalCustomerId,
      walletAddress: input.sourceWalletAddress,
      walletTransactionId: requireWalletTransactionId(input.paymentTransferId),
    });
  }

  /**
   * Reads the committed off-ramp MoneyGram is waiting to be funded, so the deposit
   * address and amount come from the Ramps API under our secret key rather than
   * from the widget callback in the browser.
   *
   * @param ctx - Provider env and environment mode.
   * @param transactionId - The Ramps transaction id surfaced by `onTransactionCreated`.
   * @returns The deposit address, optional memo, and USDC amount MoneyGram expects.
   * @throws When the transaction is not `awaiting_funds`, is not USDC, or has no deposit instruction yet.
   */
  async getAwaitingDeposit(
    { env, mode }: RampRuntimeContext,
    transactionId: string
  ): Promise<MoneygramAwaitingDeposit> {
    const secretKey = requireMoneygramSecretKey(env, mode);
    const response = await providerFetchJson<unknown>(
      this.id,
      `${MONEYGRAM_SANDBOX_BASE_URL}/api/v1/transactions/${encodeURIComponent(transactionId)}/status`,
      {
        method: "GET",
        headers: { "x-api-key": secretKey, "User-Agent": "sdp-api/ramps" },
        signal: AbortSignal.timeout(MONEYGRAM_REQUEST_TIMEOUT_MS),
      }
    );
    const parsed = transactionStatusSchema.safeParse(response);
    if (!parsed.success) {
      throw providerUnavailable("MoneyGram transaction status response is malformed.", {
        provider: this.id,
        issues: z.flattenError(parsed.error).fieldErrors,
      });
    }
    const { status, asset, depositAddress, depositMemo, sendAmount } = parsed.data;
    if (status !== MONEYGRAM_AWAITING_FUNDS_STATUS) {
      throw providerUnavailable(`MoneyGram transaction is ${status}, not awaiting funds.`, {
        provider: this.id,
        transactionId,
      });
    }
    if (asset !== "USDC") {
      throw providerUnavailable(`MoneyGram transaction asset is ${asset}, not USDC.`, {
        provider: this.id,
        transactionId,
      });
    }
    if (!depositAddress || !sendAmount) {
      throw providerUnavailable("MoneyGram transaction has no deposit instruction yet.", {
        provider: this.id,
        transactionId,
      });
    }
    return { depositAddress, sendAmount, ...(depositMemo ? { depositMemo } : {}) };
  }

  /**
   * Finds the MoneyGram transaction the widget reported and proves it belongs to
   * the counterparty: it must carry the customerIdentifier SDP sent and be USDC on
   * Solana. The browser supplies the transaction id, so nothing about it is
   * trusted until MoneyGram confirms these under the secret key.
   *
   * MoneyGram's transaction list is partner-wide and, as of the Sep 2026 sandbox,
   * ignores every filter and pagination parameter; the status endpoint carries no
   * customer reference, and the session's `walletTransactionId` is not echoed as
   * the transaction's `partnerTransactionId`, so there is no per-transfer bind
   * available. The list is scanned client-side and only the fields above are
   * parsed, never the per-transaction KYC data.
   *
   * @param ctx - Provider env and environment mode.
   * @param input.transactionId - The Ramps transaction id the widget surfaced.
   * @param input.customerIdentifier - The identifier SDP sent for the counterparty.
   * @returns The owned transaction, or null when no transaction with that id belongs to this customer.
   * @throws When the transaction is owned but is not USDC on Solana, or has no MoneyGram profile.
   */
  async findOwnedTransaction(
    { env, mode }: RampRuntimeContext,
    input: { transactionId: string; customerIdentifier: string }
  ): Promise<MoneygramOwnedTransaction | null> {
    const secretKey = requireMoneygramSecretKey(env, mode);
    const response = await providerFetchJson<unknown>(
      this.id,
      `${MONEYGRAM_SANDBOX_BASE_URL}/api/v1/transactions`,
      {
        method: "GET",
        headers: { "x-api-key": secretKey, "User-Agent": "sdp-api/ramps" },
        signal: AbortSignal.timeout(MONEYGRAM_REQUEST_TIMEOUT_MS),
      }
    );
    const parsed = transactionListSchema.safeParse(response);
    if (!parsed.success) {
      throw providerUnavailable("MoneyGram transaction list response is malformed.", {
        provider: this.id,
        issues: z.flattenError(parsed.error).fieldErrors,
      });
    }
    const owned = parsed.data.transactions.find(
      (transaction) =>
        transaction.transactionId === input.transactionId &&
        transaction.customerIdentifier === input.customerIdentifier
    );
    if (!owned) {
      return null;
    }
    if (owned.sendAsset !== "USDC" || owned.sendChain !== "solana") {
      throw providerUnavailable(
        `MoneyGram transaction is ${owned.sendAsset} on ${owned.sendChain}, not USDC on Solana.`,
        { provider: this.id, transactionId: input.transactionId }
      );
    }
    if (owned.mgiProfileId === null) {
      throw providerUnavailable("MoneyGram transaction has no customer profile yet.", {
        provider: this.id,
        transactionId: input.transactionId,
      });
    }
    return { profileId: owned.mgiProfileId, transactionType: owned.transactionType };
  }

  /**
   * Custodial partner records reject a session without a customerIdentifier; the
   * counterparty id is the stable identifier MoneyGram keys its KYC profile on.
   * SDP only integrates the custodial contract (deposit-address funding from a
   * custody wallet), so a session minted as non-custodial is a misconfigured
   * partner record and fails the parse.
   */
  private async mintSession(
    secretKey: string,
    input: MoneygramSessionInput
  ): Promise<MoneygramSession> {
    const session = await providerFetchJson<unknown, MoneygramSessionInput & { chain: "solana" }>(
      this.id,
      `${MONEYGRAM_SANDBOX_BASE_URL}/api/v1/sessions`,
      {
        method: "POST",
        headers: { "x-api-key": secretKey, "User-Agent": "sdp-api/ramps" },
        body: { ...input, chain: "solana" },
        signal: AbortSignal.timeout(MONEYGRAM_REQUEST_TIMEOUT_MS),
      }
    );
    const parsed = sessionSchema.safeParse(session);
    if (!parsed.success) {
      throw providerUnavailable("MoneyGram session response is malformed.", {
        provider: this.id,
        issues: z.flattenError(parsed.error).fieldErrors,
      });
    }
    return parsed.data;
  }

  /**
   * The sessions API always returns a widgetUrl pinned to mode=off-ramp; the widget
   * reads its direction solely from that query param, so rewrite it per direction.
   */
  private async createSessionQuote(
    { env, mode }: RampRuntimeContext,
    widgetMode: "on-ramp" | "off-ramp",
    input: MoneygramSessionInput
  ): Promise<PaymentRampQuote> {
    const secretKey = requireMoneygramSecretKey(env, mode);
    const session = await this.mintSession(secretKey, input);

    // The dashboard loads this URL into the MoneyGram SDK and derives its API
    // base from its origin, so anything but HTTPS on an approved host fails closed.
    const destination = checkRampDestination(session.widgetUrl, [
      ...MONEYGRAM_WIDGET_APPROVED_HOSTS,
    ]);
    if (!destination.ok) {
      throw providerUnavailable("MoneyGram returned an untrusted widget URL.", {
        provider: this.id,
        reason: destination.reason,
      });
    }
    const widgetUrl = destination.url;
    widgetUrl.searchParams.set("mode", widgetMode);

    return {
      provider: this.id,
      id: session.sessionId,
      status: "pending",
      deliveryMode: "session_widget",
      sessionToken: session.sessionToken,
      sessionId: session.sessionId,
      widgetUrl: widgetUrl.toString(),
      expiresAt: moneygramSessionExpiry(session.sessionToken),
    };
  }
}

/** Sessions expire when their JWT does; MoneyGram documents a 1h TTL, used as the fallback. */
const MONEYGRAM_SESSION_FALLBACK_TTL_MS = 60 * 60 * 1000;

/**
 * Reads the `exp` claim from the widget session JWT so the session's expiry can
 * be bound to the transfer record. The token is not verified here — it is
 * MoneyGram's credential, not ours — this only extracts the expiry it declares.
 */
export function moneygramSessionExpiry(sessionToken: string, now: number = Date.now()): string {
  const fallback = new Date(now + MONEYGRAM_SESSION_FALLBACK_TTL_MS).toISOString();
  const payloadSegment = sessionToken.split(".")[1];
  if (!payloadSegment) {
    return fallback;
  }
  try {
    const base64 = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= 0) {
      return fallback;
    }
    return new Date(payload.exp * 1000).toISOString();
  } catch {
    return fallback;
  }
}
