import { type CryptoRailId, parseFiatCurrency } from "@sdp/types/payment-rails";
import { AppError } from "@/lib/errors";
import { createProviderRampSupport, requireEnv } from "../common";
import { RAMP_RAIL_DUMPS } from "../constants";
import type {
  MutableProviderRampSupport,
  ProviderRampSupport,
  RampDumpReader,
  RampProviderClient,
  RampWebhookValidationContext,
  RampWebhookValidationResult,
} from "../types";

const MOONPAY_CRYPTO_CODES = ["sol", "usdc_sol", "usdt_sol", "usdg_sol", "pyusd_sol"] as const;
type MoonpayCryptoCode = (typeof MOONPAY_CRYPTO_CODES)[number];

const MOONPAY_CRYPTO_CODE_TO_RAIL = {
  sol: "sol.solana",
  usdc_sol: "usdc.solana",
  usdt_sol: "usdt.solana",
  usdg_sol: "usdg.solana",
  pyusd_sol: "pyusd.solana",
} as const satisfies Record<MoonpayCryptoCode, CryptoRailId>;

function isMoonpayCryptoCode(value: string): value is MoonpayCryptoCode {
  return (MOONPAY_CRYPTO_CODES as readonly string[]).includes(value);
}

interface MoonpayCurrencyEntry {
  type?: string;
  code?: string;
  isSuspended?: boolean;
  isSellSupported?: boolean;
  minBuyAmount?: number | null;
  minSellAmount?: number | null;
  metadata?: { networkCode?: string };
}

function addFiatSupport(
  entry: MoonpayCurrencyEntry,
  support: Pick<MutableProviderRampSupport, "onrampFiats" | "offrampFiats">
) {
  if (!entry.code) return;
  const parsed = parseFiatCurrency(entry.code);
  if (!parsed) {
    console.warn(`  [moonpay] unknown fiat code: ${entry.code}`);
    return;
  }
  if (entry.minBuyAmount != null) support.onrampFiats.add(parsed);
  if (entry.isSellSupported === true) support.offrampFiats.add(parsed);
}

function addCryptoSupport(
  entry: MoonpayCurrencyEntry,
  support: Pick<MutableProviderRampSupport, "onrampCryptos" | "offrampCryptos">
) {
  if (!entry.code) return;
  if (entry.isSuspended === true) return;
  if (entry.metadata?.networkCode !== "solana") return;
  if (!isMoonpayCryptoCode(entry.code)) return;

  const rail = MOONPAY_CRYPTO_CODE_TO_RAIL[entry.code];
  if (entry.minBuyAmount != null) support.onrampCryptos.add(rail);
  if (entry.isSellSupported === true && entry.minSellAmount != null) {
    support.offrampCryptos.add(rail);
  }
}

function extractSupport(currencies: readonly MoonpayCurrencyEntry[]): ProviderRampSupport {
  const support = createProviderRampSupport();

  for (const entry of currencies) {
    if (entry.type === "fiat") addFiatSupport(entry, support);
    if (entry.type === "crypto") addCryptoSupport(entry, support);
  }

  return support;
}

export class MoonpayRampClient implements RampProviderClient {
  readonly id = "moonpay";

  async _discoverRails({
    env,
    fetchJson,
    writeDump,
  }: Parameters<RampProviderClient["_discoverRails"]>[0]) {
    const apiKey = requireEnv(env, "MOONPAY_SANDBOX_API_KEY");
    const base = "https://api.moonpay.com";

    await writeDump(
      RAMP_RAIL_DUMPS.moonpay.currencies.name,
      await fetchJson(
        this.id,
        "GET /v3/currencies?show=all",
        `${base}/v3/currencies?show=all&apiKey=${apiKey}`
      )
    );
    await writeDump(
      RAMP_RAIL_DUMPS.moonpay.countries.name,
      await fetchJson(this.id, "GET /v3/countries", `${base}/v3/countries`)
    );
  }

  async readRailSupport(readDump: RampDumpReader): Promise<ProviderRampSupport> {
    return extractSupport(
      await readDump<readonly MoonpayCurrencyEntry[]>(RAMP_RAIL_DUMPS.moonpay.currencies.file)
    );
  }

  async validateWebhook(
    _context: RampWebhookValidationContext
  ): Promise<RampWebhookValidationResult> {
    throw new AppError("PROVIDER_NOT_CONFIGURED", "MoonPay webhook validation is not implemented", {
      provider: this.id,
    });
  }
}
