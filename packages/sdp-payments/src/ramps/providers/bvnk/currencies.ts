import type { CryptoRailId, RampCurrencyLimit } from "@sdp/types/payment-rails";
import { z } from "zod";
import {
  isActiveIso4217CurrencyCode,
  isSolanaCryptoAsset,
  RAMP_RAIL_DUMPS,
  SOLANA_ASSET_TO_RAIL,
  unreportedCurrencyLimit,
} from "../../shared";
import type { ProviderRailSupportDistillation, RampDiscoveryContext } from "../../types";
import { BVNK_SANDBOX_API_URL } from "./client";

/** Sandbox fiat set; BVNK's sandbox executes only these fiats while the catalogs list the global set. */
export const BVNK_SANDBOX_FIAT_CURRENCIES = ["EUR", "USD"] as const;
export type BvnkFiatCurrency = (typeof BVNK_SANDBOX_FIAT_CURRENCIES)[number];

/**
 * Narrowing guard for the BVNK sandbox fiat set, shared by every gate that
 * decides whether BVNK may serve a fiat currency.
 *
 * @param code - Currency code to test.
 * @returns Whether the code is in the sandbox fiat set.
 */
export function isBvnkFiatCurrency(code: string): code is BvnkFiatCurrency {
  return (BVNK_SANDBOX_FIAT_CURRENCIES as readonly string[]).includes(code);
}

const bvnkCurrencyEntrySchema = z.object({
  code: z.string().optional(),
  fiat: z.boolean().optional(),
  supportsDeposits: z.boolean().optional(),
  supportsWithdrawals: z.boolean().optional(),
  protocols: z.array(z.object({ networkCode: z.string().optional() })).optional(),
});

function addBvnkFiatCurrency(
  target: Record<string, RampCurrencyLimit>,
  code: string,
  droppedCodes: Set<string>
): void {
  const normalized = code.trim().toUpperCase();
  if (!BVNK_SANDBOX_FIAT_CURRENCIES.some((currency) => currency === normalized)) {
    return;
  }
  if (!isActiveIso4217CurrencyCode(normalized)) {
    droppedCodes.add(normalized);
    return;
  }
  target[normalized] = unreportedCurrencyLimit();
}

/**
 * Distills the BVNK currency dumps into the rail-support snapshot intersected
 * with the sandbox fiat set. Deposit entries with deposit support become
 * on-ramp fiat currencies, fiat entries with withdrawal support become off-ramp
 * fiat currencies, and crypto entries traded on the Solana protocol become the
 * crypto rails. Codes outside the sandbox fiat set are skipped silently;
 * inactive or non-ISO 4217 codes inside it are dropped and reported.
 *
 * @param depositRaw - Raw BVNK deposit-currency dump body.
 * @param fiatRaw - Raw BVNK fiat-currency dump body.
 * @param cryptoRaw - Raw BVNK crypto-currency dump body.
 * @returns Snapshot plus the currency codes dropped from it.
 */
export function distillBvnkRailSupport(
  depositRaw: unknown,
  fiatRaw: unknown,
  cryptoRaw: unknown
): ProviderRailSupportDistillation {
  const depositList = z.array(bvnkCurrencyEntrySchema).parse(depositRaw);
  const fiatList = z.array(bvnkCurrencyEntrySchema).parse(fiatRaw);
  const cryptoList = z.array(bvnkCurrencyEntrySchema).parse(cryptoRaw);
  const droppedCodes = new Set<string>();
  const onrampCurrencies: Record<string, RampCurrencyLimit> = {};
  const offrampCurrencies: Record<string, RampCurrencyLimit> = {};
  const onrampCryptos = new Set<CryptoRailId>();
  const offrampCryptos = new Set<CryptoRailId>();

  for (const entry of depositList) {
    if (entry.fiat !== true) {
      continue;
    }
    if (entry.supportsDeposits !== true) {
      continue;
    }
    if (entry.code === undefined) {
      continue;
    }
    addBvnkFiatCurrency(onrampCurrencies, entry.code, droppedCodes);
  }

  for (const entry of fiatList) {
    if (entry.supportsWithdrawals !== true) {
      continue;
    }
    if (entry.code === undefined) {
      continue;
    }
    addBvnkFiatCurrency(offrampCurrencies, entry.code, droppedCodes);
  }

  for (const entry of cryptoList) {
    if (entry.code === undefined) {
      continue;
    }
    const upper = entry.code.toUpperCase();
    if (!isSolanaCryptoAsset(upper)) {
      continue;
    }
    if (entry.protocols === undefined) {
      continue;
    }
    const hasSolana = entry.protocols.some((protocol) => protocol.networkCode === "SOLANA");
    if (!hasSolana) {
      continue;
    }
    const rail = SOLANA_ASSET_TO_RAIL[upper];
    if (entry.supportsWithdrawals === true) {
      onrampCryptos.add(rail);
    }
    if (entry.supportsDeposits === true) {
      offrampCryptos.add(rail);
    }
  }

  return {
    snapshot: {
      onramp: {
        currencies: onrampCurrencies,
        cryptos: [...onrampCryptos].sort(),
      },
      offramp: {
        currencies: offrampCurrencies,
        cryptos: [...offrampCryptos].sort(),
      },
    },
    droppedCurrencyCodes: [...droppedCodes].sort(),
    droppedCountryCodes: [],
  };
}

/**
 * Provider entry point for the ramp-support script: fetches the BVNK currency
 * dumps (skipped when offline) and distills them into the rail-support
 * snapshot.
 *
 * @param context - Discovery context supplying env, fetch, and dump access.
 * @returns Distilled snapshot plus dropped currency codes.
 */
export async function discoverBvnkCurrencyAndRails(
  context: RampDiscoveryContext
): Promise<ProviderRailSupportDistillation> {
  if (!context.offline) {
    const { fetchJson, writeDump } = context;
    // biome-ignore lint/security/noSecrets: BVNK pagination query string, not a secret.
    const pageQuery = "?offset=0&max=1000";

    await Promise.all(
      [
        {
          path: `/api/currency/crypto${pageQuery}`,
          dumpName: RAMP_RAIL_DUMPS.bvnk.cryptoAnon.name,
        },
        {
          path: `/api/currency/fiat${pageQuery}`,
          dumpName: RAMP_RAIL_DUMPS.bvnk.fiatAnon.name,
        },
        {
          path: `/api/currency/deposit${pageQuery}`,
          dumpName: RAMP_RAIL_DUMPS.bvnk.depositAnon.name,
        },
      ].map(async (request) => {
        const url = new URL(request.path, BVNK_SANDBOX_API_URL);
        await writeDump(
          request.dumpName,
          await fetchJson("bvnk", `anon ${request.path}`, url.toString(), {
            headers: { Accept: "application/json" },
          })
        );
      })
    );
  }
  const [deposit, fiat, crypto] = await Promise.all([
    context.readDump(RAMP_RAIL_DUMPS.bvnk.depositAnon.file),
    context.readDump(RAMP_RAIL_DUMPS.bvnk.fiatAnon.file),
    context.readDump(RAMP_RAIL_DUMPS.bvnk.cryptoAnon.file),
  ]);
  return distillBvnkRailSupport(deposit, fiat, crypto);
}
