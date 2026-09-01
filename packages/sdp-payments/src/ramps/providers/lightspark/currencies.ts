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
import type { ProviderRailSupportDistillation, RampDiscoveryContext } from "../../types";
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
  const droppedCurrencyCodes = new Set<string>();
  const offramp = distillDirection(offrampRatesRaw, "sourceCurrency", droppedCurrencyCodes);
  const onramp = distillDirection(onrampRatesRaw, "destinationCurrency", droppedCurrencyCodes);
  return {
    snapshot: { onramp, offramp },
    droppedCurrencyCodes: [...droppedCurrencyCodes].sort(),
    droppedCountryCodes: [],
  };
}

/**
 * Distills one direction's corridors: the crypto side must always be a known
 * Solana asset, the other side is the fiat currency table. Crypto-to-crypto
 * corridors are skipped; non-ISO fiat codes are collected as dropped.
 *
 * @param raw - Raw exchange-rates dump for the direction.
 * @param cryptoSide - Which side of each corridor carries the crypto asset.
 * @param dropped - Accumulator for currency codes excluded from the snapshot.
 * @returns The direction's snapshot slice.
 */
function distillDirection(
  raw: unknown,
  cryptoSide: "sourceCurrency" | "destinationCurrency",
  dropped: Set<string>
) {
  const fiatSide = cryptoSide === "sourceCurrency" ? "destinationCurrency" : "sourceCurrency";
  const limits = new Map<string, MinorUnitLimit>();
  const cryptos = new Set<CryptoRailId>();
  for (const row of gridExchangeRatesDumpSchema.parse(raw).data) {
    const crypto = row[cryptoSide].code.trim().toUpperCase();
    if (!isSolanaCryptoAsset(crypto)) {
      throw providerUnavailable(
        `Lightspark rate ${cryptoSide} must be a crypto asset; got ${crypto}.`
      );
    }
    cryptos.add(SOLANA_ASSET_TO_RAIL[crypto]);
    const fiat = row[fiatSide].code.trim().toUpperCase();
    if (isSolanaCryptoAsset(fiat)) {
      continue;
    }
    if (!isActiveIso4217CurrencyCode(fiat)) {
      dropped.add(fiat);
      continue;
    }
    mergeSendingLimit(limits, fiat, row);
  }
  return { currencies: formatLimits(limits), cryptos: [...cryptos].sort() };
}

/**
 * Provider entry point for the ramp-support script: fetches both Grid
 * exchange-rate corridor dumps (skipped when offline) and distills them into
 * the rail-support snapshot.
 *
 * @param context - Discovery context supplying env, fetch, and dump access.
 * @returns Distilled snapshot plus dropped currency codes.
 */
export async function discoverLightsparkCurrencyAndRails(
  context: RampDiscoveryContext
): Promise<ProviderRailSupportDistillation> {
  if (!context.offline) {
    const config = readLightsparkConfig(context.env, "sandbox");
    const headers = {
      Authorization: basicAuthHeader(config.tokenId, config.clientSecret),
    };
    await context.writeDump(
      RAMP_RAIL_DUMPS.lightspark.offrampRates.name,
      await context.fetchJson(
        "lightspark",
        `GET /exchange-rates?sourceCurrency=${LIGHTSPARK_DISCOVERY_CRYPTO}`,
        `${config.apiBaseUrl}/exchange-rates?sourceCurrency=${LIGHTSPARK_DISCOVERY_CRYPTO}`,
        { headers }
      )
    );
    await context.writeDump(
      RAMP_RAIL_DUMPS.lightspark.onrampRates.name,
      await context.fetchJson(
        "lightspark",
        `GET /exchange-rates?destinationCurrency=${LIGHTSPARK_DISCOVERY_CRYPTO}`,
        `${config.apiBaseUrl}/exchange-rates?destinationCurrency=${LIGHTSPARK_DISCOVERY_CRYPTO}`,
        { headers }
      )
    );
  }
  return distillLightsparkRailSupport(
    await context.readDump(RAMP_RAIL_DUMPS.lightspark.offrampRates.file),
    await context.readDump(RAMP_RAIL_DUMPS.lightspark.onrampRates.file)
  );
}
