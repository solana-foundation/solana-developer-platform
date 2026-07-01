import { generateJwt } from "@coinbase/cdp-sdk/auth";
import type {
  CoinbasePaymentRampExecution,
  Counterparty,
  PaymentRampEstimate,
  PaymentRampQuote,
} from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp-support";
import { parseFiatCurrency } from "@sdp/types/payment-rails";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { badRequest, providerNotConfigured } from "@/lib/errors";
import { type ProviderRequestInit, providerFetchJson } from "../fetch";
import {
  createProviderRampSupport,
  isSolanaCryptoAsset,
  RAMP_RAIL_DUMPS,
  requireEnv,
  SOLANA_ASSET_TO_RAIL,
} from "../shared";
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

// v1 API: buy options, quotes, transaction status
const CDP_V1_API_BASE_URL = "https://api.developer.coinbase.com";
// v2 API: create onramp order (POST /platform/v2/onramp/orders)
const CDP_V2_API_BASE_URL = "https://api.cdp.coinbase.com/platform";

interface CoinbaseConfig {
  apiKeyName: string;
  apiKeySecret: string;
  apiBaseUrl: string;
}

// biome-ignore lint/correctness/noUnusedVariables: called by capability skill implementations (estimate, quote, etc.)
function readCoinbaseConfig(env: Record<string, string | undefined>): CoinbaseConfig {
  const apiKeyName = env.CDP_API_KEY?.trim();
  const apiKeySecret = env.CDP_API_SECRET?.trim();

  if (!apiKeyName || !apiKeySecret) {
    throw providerNotConfigured(
      "Coinbase Onramp is not configured. Set CDP_API_KEY and CDP_API_SECRET."
    );
  }

  return {
    apiKeyName,
    apiKeySecret,
    apiBaseUrl: CDP_V2_API_BASE_URL,
  };
}

interface BuyOptionsNetwork {
  name: string;
  display_name: string;
  chain_id: number;
  contract_address: string;
}

interface BuyOptionsPurchaseCurrency {
  id: string;
  name: string;
  symbol: string;
  icon_url: string;
  networks: BuyOptionsNetwork[];
}

interface BuyOptionsPaymentCurrencyLimit {
  id: string;
  min: string;
  max: string;
}

interface BuyOptionsPaymentCurrency {
  id: string;
  limits: BuyOptionsPaymentCurrencyLimit[];
}

interface BuyOptionsDump {
  payment_currencies: BuyOptionsPaymentCurrency[];
  purchase_currencies: BuyOptionsPurchaseCurrency[];
}

function extractSupport(dump: BuyOptionsDump): ProviderRampSupport {
  const support = createProviderRampSupport();

  // Headless v2 only supports USD — don't derive from payment_currencies.
  const usd = parseFiatCurrency("USD");
  if (usd) support.onrampFiats.add(usd);

  for (const currency of dump.purchase_currencies) {
    const hassolana = currency.networks.some((n) => n.name === "solana");
    if (!hassolana) continue;
    const symbol = currency.symbol.toUpperCase();
    if (!isSolanaCryptoAsset(symbol)) continue;
    support.onrampCryptos.add(SOLANA_ASSET_TO_RAIL[symbol]);
  }

  return support;
}

export interface CoinbaseExecuteOnrampInput {
  destinationWalletAddress: string;
  cryptoToken: string;
  fiatCurrency?: RampFiatCurrency;
  fiatAmount: string;
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
    const apiKeyName = requireEnv(env, "CDP_API_KEY");
    const apiKeySecret = requireEnv(env, "CDP_API_SECRET");

    const jwt = await generateJwt({
      apiKeyId: apiKeyName,
      apiKeySecret,
      requestMethod: "GET",
      requestHost: new URL(CDP_V1_API_BASE_URL).host,
      requestPath: "/onramp/v1/buy/options",
    });

    await writeDump(
      RAMP_RAIL_DUMPS.coinbase.buyOptions.name,
      await fetchJson(
        this.id,
        "GET /onramp/v1/buy/options",
        `${CDP_V1_API_BASE_URL}/onramp/v1/buy/options?country=US&networks=solana`,
        { headers: { Authorization: `Bearer ${jwt}` } }
      )
    );
  }

  async readRailSupport(readDump: RampDumpReader): Promise<ProviderRampSupport> {
    return extractSupport(await readDump<BuyOptionsDump>(RAMP_RAIL_DUMPS.coinbase.buyOptions.file));
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

  async executeOnramp(
    _ctx: RampRuntimeContext,
    _input: CoinbaseExecuteOnrampInput
  ): Promise<CoinbasePaymentRampExecution> {
    throw new Error("executeOnramp not yet implemented for coinbase");
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

    const jwt = await generateJwt({
      apiKeyId: config.apiKeyName,
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
