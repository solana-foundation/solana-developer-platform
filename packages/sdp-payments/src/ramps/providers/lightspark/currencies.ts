import { formatDecimalAmount } from "@sdp/solana/amount";
import type { CryptoRailId } from "@sdp/types/payment-rails";
import { z } from "zod";
import { providerUnavailable } from "../../../errors";
import {
  basicAuthHeader,
  isActiveIso4217CurrencyCode,
  isSolanaCryptoAsset,
  RAMP_RAIL_DUMPS,
  SOLANA_ASSET_TO_RAIL,
} from "../../shared";
import type {
  ProviderRailSupportDistillation,
  RampDiscoveryContext,
  RampRawDumpReader,
} from "../../types";
import { readLightsparkConfig } from "./client";

const LIGHTSPARK_DISCOVERY_CRYPTO = "USDC";

const gridRateCurrencySchema = z.object({
  code: z.string(),
  decimals: z.number().int().nonnegative(),
});

const gridExchangeRatesDumpSchema = z.object({
  data: z.array(
    z.object({
      sourceCurrency: gridRateCurrencySchema,
      destinationCurrency: gridRateCurrencySchema,
      minSendingAmount: z.number(),
      maxSendingAmount: z.number(),
    })
  ),
});

type GridExchangeRateRow = z.infer<typeof gridExchangeRatesDumpSchema>["data"][number];

interface MinorUnitLimit {
  min: number;
  max: number;
  decimals: number;
}

/**
 * Merges one corridor's sending bounds into the per-currency limit table.
 * Currencies reachable over several rails keep the widest bounds.
 *
 * @param limits - Accumulator keyed by currency code.
 * @param code - Normalized currency code the corridor pays out in.
 * @param row - Exchange-rate row carrying the corridor's sending bounds.
 */
function mergeSendingLimit(
  limits: Map<string, MinorUnitLimit>,
  code: string,
  row: GridExchangeRateRow
): void {
  if (!Number.isInteger(row.minSendingAmount) || !Number.isInteger(row.maxSendingAmount)) {
    throw providerUnavailable(`Lightspark ${code} sending limits must be integer minor units.`);
  }
  const existing = limits.get(code);
  if (existing === undefined) {
    limits.set(code, {
      min: row.minSendingAmount,
      max: row.maxSendingAmount,
      decimals: row.sourceCurrency.decimals,
    });
    return;
  }
  if (existing.decimals !== row.sourceCurrency.decimals) {
    throw providerUnavailable(`Lightspark ${code} corridors disagree on source currency decimals.`);
  }
  existing.min = Math.min(existing.min, row.minSendingAmount);
  existing.max = Math.max(existing.max, row.maxSendingAmount);
}

/**
 * Formats accumulated minor-unit sending bounds as major-unit decimal strings.
 *
 * @param limits - Per-currency minor-unit bounds.
 * @returns Currency table in the snapshot's limit shape.
 */
function formatLimits(limits: Map<string, MinorUnitLimit>) {
  return Object.fromEntries(
    [...limits.entries()].map(([code, limit]) => [
      code,
      {
        min: formatDecimalAmount(BigInt(limit.min), limit.decimals),
        max: formatDecimalAmount(BigInt(limit.max), limit.decimals),
      },
    ])
  );
}

/**
 * Distills Lightspark exchange-rate corridors into the rail-support snapshot.
 * Off-ramp rows come from `exchange-rates?sourceCurrency=USDC` (crypto out to
 * fiat), on-ramp rows from `exchange-rates?destinationCurrency=USDC` (fiat in
 * to crypto). Limits are sending-amount bounds denominated in each corridor's
 * source currency: USDC for off-ramps, the fiat currency for on-ramps.
 * Crypto-to-crypto corridors are skipped; inactive ISO 4217 codes are dropped
 * and reported.
 *
 * @param offrampRatesRaw - Raw `sourceCurrency=USDC` exchange-rates dump.
 * @param onrampRatesRaw - Raw `destinationCurrency=USDC` exchange-rates dump.
 * @returns Snapshot plus the currency codes dropped from it.
 */
export function distillLightsparkRailSupport(
  offrampRatesRaw: unknown,
  onrampRatesRaw: unknown
): ProviderRailSupportDistillation {
  const offrampLimits = new Map<string, MinorUnitLimit>();
  const onrampLimits = new Map<string, MinorUnitLimit>();
  const onrampCryptos = new Set<CryptoRailId>();
  const offrampCryptos = new Set<CryptoRailId>();
  const droppedCurrencyCodes = new Set<string>();

  for (const row of gridExchangeRatesDumpSchema.parse(offrampRatesRaw).data) {
    const source = row.sourceCurrency.code.trim().toUpperCase();
    if (!isSolanaCryptoAsset(source)) {
      throw providerUnavailable(
        `Lightspark off-ramp rate source must be a crypto asset; got ${source}.`
      );
    }
    offrampCryptos.add(SOLANA_ASSET_TO_RAIL[source]);
    const destination = row.destinationCurrency.code.trim().toUpperCase();
    if (isSolanaCryptoAsset(destination)) {
      continue;
    }
    if (!/^[A-Z]{3}$/.test(destination)) {
      continue;
    }
    if (!isActiveIso4217CurrencyCode(destination)) {
      droppedCurrencyCodes.add(destination);
      continue;
    }
    mergeSendingLimit(offrampLimits, destination, row);
  }

  for (const row of gridExchangeRatesDumpSchema.parse(onrampRatesRaw).data) {
    const destination = row.destinationCurrency.code.trim().toUpperCase();
    if (!isSolanaCryptoAsset(destination)) {
      throw providerUnavailable(
        `Lightspark on-ramp rate destination must be a crypto asset; got ${destination}.`
      );
    }
    onrampCryptos.add(SOLANA_ASSET_TO_RAIL[destination]);
    const source = row.sourceCurrency.code.trim().toUpperCase();
    if (isSolanaCryptoAsset(source)) {
      continue;
    }
    if (!/^[A-Z]{3,4}$/.test(source)) {
      continue;
    }
    if (!isActiveIso4217CurrencyCode(source)) {
      droppedCurrencyCodes.add(source);
      continue;
    }
    mergeSendingLimit(onrampLimits, source, row);
  }

  return {
    snapshot: {
      onramp: {
        currencies: formatLimits(onrampLimits),
        cryptos: [...onrampCryptos].sort(),
      },
      offramp: {
        currencies: formatLimits(offrampLimits),
        cryptos: [...offrampCryptos].sort(),
      },
    },
    droppedCurrencyCodes: [...droppedCurrencyCodes].sort(),
    droppedCountryCodes: [],
  };
}

/**
 * Fetches both exchange-rate corridor dumps from the Grid sandbox API.
 *
 * @param context - Discovery context supplying env, fetch, and dump sinks.
 */
export async function discoverLightsparkCurrencies({
  env,
  fetchJson,
  writeDump,
}: RampDiscoveryContext): Promise<void> {
  const config = readLightsparkConfig(env, "sandbox");
  const base = config.apiBaseUrl;
  const headers = {
    Authorization: basicAuthHeader(config.tokenId, config.clientSecret),
  };

  await writeDump(
    RAMP_RAIL_DUMPS.lightspark.offrampRates.name,
    await fetchJson(
      "lightspark",
      `GET /exchange-rates?sourceCurrency=${LIGHTSPARK_DISCOVERY_CRYPTO}`,
      `${base}/exchange-rates?sourceCurrency=${LIGHTSPARK_DISCOVERY_CRYPTO}`,
      { headers }
    )
  );
  await writeDump(
    RAMP_RAIL_DUMPS.lightspark.onrampRates.name,
    await fetchJson(
      "lightspark",
      `GET /exchange-rates?destinationCurrency=${LIGHTSPARK_DISCOVERY_CRYPTO}`,
      `${base}/exchange-rates?destinationCurrency=${LIGHTSPARK_DISCOVERY_CRYPTO}`,
      { headers }
    )
  );
}

/**
 * Reads both committed corridor dumps and distills the rail-support snapshot.
 *
 * @param readDump - Reader over the committed raw dumps.
 * @returns Distilled snapshot plus dropped currency codes.
 */
export async function readLightsparkRailSupport(
  readDump: RampRawDumpReader
): Promise<ProviderRailSupportDistillation> {
  return distillLightsparkRailSupport(
    await readDump(RAMP_RAIL_DUMPS.lightspark.offrampRates.file),
    await readDump(RAMP_RAIL_DUMPS.lightspark.onrampRates.file)
  );
}
