import type {
  Counterparty,
  PaymentRampEstimate,
  PaymentRampQuote,
  SdpEnvironment,
} from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp-support";
import { getCryptoRailAssetLabel, type RampCurrencyLimit } from "@sdp/types/payment-rails";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { z } from "zod";
import { estimateNotAvailable, providerNotConfigured, providerUnavailable } from "../../../errors";
import { providerFetchJson } from "../../fetch";
import { readyCounterparty } from "../../requirements";
import {
  isActiveIso4217CurrencyCode,
  RAMP_RAIL_DUMPS,
  requireEnv,
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

const MONEYGRAM_SANDBOX_BASE_URL = "https://playground.xramps.moneygram.com";

export const MONEYGRAM_DECLARED_RAIL_SUPPORT = {
  onramp: {
    countrySupport: UNREPORTED_COUNTRY_SUPPORT,
    entityTypes: [],
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

const sessionSchema = z.object({
  sessionToken: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  widgetUrl: z.string().trim().min(1),
});

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
        currencies: {},
        cryptos: [],
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

  async _discoverRails({
    env,
    fetchJson,
    writeDump,
  }: Parameters<RampProvider["_discoverRails"]>[0]) {
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

  async distillRailSupport(readDump: RampRawDumpReader): Promise<ProviderRailSupportDistillation> {
    return distillMoneygramRailSupport(await readDump(RAMP_RAIL_DUMPS.moneygram.currencies.file));
  }

  async estimateOnramp(
    _ctx: RampRuntimeContext,
    _input: RampEstimateOnrampInput
  ): Promise<PaymentRampEstimate> {
    throw estimateNotAvailable("MoneyGram does not support on-ramp.", { provider: this.id });
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
    { env, mode }: RampRuntimeContext,
    _input: RampOfframpQuoteInput
  ): Promise<PaymentRampQuote> {
    const secretKey = requireMoneygramSecretKey(env, mode);
    const session = await providerFetchJson<unknown, Record<never, never>>(
      this.id,
      `${MONEYGRAM_SANDBOX_BASE_URL}/api/v1/sessions`,
      {
        method: "POST",
        headers: { "x-api-key": secretKey, "User-Agent": "sdp-api/ramps" },
        body: {},
      }
    );

    const parsed = sessionSchema.safeParse(session);
    if (!parsed.success) {
      throw providerUnavailable("MoneyGram session response is malformed.", {
        provider: this.id,
        issues: z.flattenError(parsed.error).fieldErrors,
      });
    }

    return {
      provider: this.id,
      id: parsed.data.sessionId,
      status: "pending",
      deliveryMode: "session_widget",
      sessionToken: parsed.data.sessionToken,
      sessionId: parsed.data.sessionId,
      widgetUrl: parsed.data.widgetUrl,
      sdkUrl: `${MONEYGRAM_SANDBOX_BASE_URL}/sdk/index.global.js`,
    };
  }
}
