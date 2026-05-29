import { parseFiatCurrency } from "@sdp/types/payment-rails";
import { createProviderRampSupport, isSolanaCryptoAsset, SOLANA_ASSET_TO_RAIL } from "../common";
import { RAMP_RAIL_DUMPS } from "../constants";
import type { ProviderRampSupport, RampDumpReader, RampProviderClient } from "../types";

interface BvnkCurrencyEntry {
  code?: string;
  fiat?: boolean;
  supportsDeposits?: boolean;
  supportsWithdrawals?: boolean;
  protocols?: Array<{ networkCode?: string }>;
}

function extractSupport(
  depositList: readonly BvnkCurrencyEntry[],
  fiatList: readonly BvnkCurrencyEntry[],
  cryptoList: readonly BvnkCurrencyEntry[]
): ProviderRampSupport {
  const support = createProviderRampSupport();

  for (const entry of depositList) {
    if (entry.fiat !== true) continue;
    if (entry.supportsDeposits !== true) continue;
    if (!entry.code) continue;
    const parsed = parseFiatCurrency(entry.code);
    if (parsed) support.onrampFiats.add(parsed);
    else console.warn(`  [bvnk] unknown fiat code: ${entry.code}`);
  }

  for (const entry of fiatList) {
    if (entry.supportsWithdrawals !== true) continue;
    if (!entry.code) continue;
    const parsed = parseFiatCurrency(entry.code);
    if (parsed) support.offrampFiats.add(parsed);
    else console.warn(`  [bvnk] unknown fiat code: ${entry.code}`);
  }

  for (const entry of cryptoList) {
    if (!entry.code) continue;
    const upper = entry.code.toUpperCase();
    if (!isSolanaCryptoAsset(upper)) continue;
    const hasSolana = (entry.protocols ?? []).some((p) => p.networkCode === "SOLANA");
    if (!hasSolana) continue;
    const rail = SOLANA_ASSET_TO_RAIL[upper];
    if (entry.supportsWithdrawals === true) support.onrampCryptos.add(rail);
    if (entry.supportsDeposits === true) support.offrampCryptos.add(rail);
  }

  return support;
}

export class BvnkRampClient implements RampProviderClient {
  readonly id = "bvnk";

  async _discoverRails({
    fetchJson,
    writeDump,
  }: Parameters<RampProviderClient["_discoverRails"]>[0]) {
    const sandboxBase = "https://api.sandbox.bvnk.com/";
    // biome-ignore lint/security/noSecrets: BVNK pagination query string, not a secret.
    const pageQuery = "?offset=0&max=1000";

    for (const request of [
      {
        path: `/api/currency/crypto${pageQuery}`,
        dumpName: RAMP_RAIL_DUMPS.bvnk.cryptoSandboxAnon.name,
      },
      {
        path: `/api/currency/fiat${pageQuery}`,
        dumpName: RAMP_RAIL_DUMPS.bvnk.fiatSandboxAnon.name,
      },
      {
        path: `/api/currency/deposit${pageQuery}`,
        dumpName: RAMP_RAIL_DUMPS.bvnk.depositSandboxAnon.name,
      },
    ]) {
      const url = new URL(request.path.replace(/^\//, ""), sandboxBase);
      await writeDump(
        request.dumpName,
        await fetchJson(this.id, `sandbox-anon ${request.path}`, url.toString(), {
          headers: {
            Accept: "application/json",
          },
        })
      );
    }
  }

  async readRailSupport(readDump: RampDumpReader): Promise<ProviderRampSupport> {
    return extractSupport(
      await readDump<readonly BvnkCurrencyEntry[]>(RAMP_RAIL_DUMPS.bvnk.depositSandboxAnon.file),
      await readDump<readonly BvnkCurrencyEntry[]>(RAMP_RAIL_DUMPS.bvnk.fiatSandboxAnon.file),
      await readDump<readonly BvnkCurrencyEntry[]>(RAMP_RAIL_DUMPS.bvnk.cryptoSandboxAnon.file)
    );
  }
}
