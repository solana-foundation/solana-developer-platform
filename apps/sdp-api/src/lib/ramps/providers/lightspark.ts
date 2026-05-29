import { parseFiatCurrency } from "@sdp/types/payment-rails";
import {
  basicAuthHeader,
  createProviderRampSupport,
  isSolanaCryptoAsset,
  requireEnv,
  SOLANA_ASSET_TO_RAIL,
} from "../common";
import { RAMP_RAIL_DUMPS } from "../constants";
import type { ProviderRampSupport, RampDumpReader, RampProviderClient } from "../types";

interface LightsparkSupportedCurrency {
  currencyCode?: string;
  enabledTransactionTypes?: string[];
}

interface LightsparkConfigDump {
  embeddedWalletConfig?: { appName?: string };
  supportedCurrencies?: readonly LightsparkSupportedCurrency[];
}

function extractSupport(config: LightsparkConfigDump): ProviderRampSupport {
  const support = createProviderRampSupport();
  const platformIsSolana = config.embeddedWalletConfig?.appName === "Solana";

  for (const entry of config.supportedCurrencies ?? []) {
    const code = entry.currencyCode;
    if (!code) continue;
    const upper = code.toUpperCase();
    const enabled = entry.enabledTransactionTypes ?? [];

    if (isSolanaCryptoAsset(upper)) {
      if (platformIsSolana && enabled.includes("OUTGOING")) {
        support.onrampCryptos.add(SOLANA_ASSET_TO_RAIL[upper]);
        support.offrampCryptos.add(SOLANA_ASSET_TO_RAIL[upper]);
      }
      continue;
    }

    const parsed = parseFiatCurrency(upper);
    if (!parsed) continue;
    if (enabled.includes("INCOMING")) support.onrampFiats.add(parsed);
    if (enabled.includes("OUTGOING")) support.offrampFiats.add(parsed);
  }

  return support;
}

export class LightsparkRampClient implements RampProviderClient {
  readonly id = "lightspark";

  async _discoverRails({
    env,
    fetchJson,
    writeDump,
  }: Parameters<RampProviderClient["_discoverRails"]>[0]) {
    const clientId = requireEnv(env, "LIGHTSPARK_GRID_SANDBOX_CLIENT_ID");
    const clientSecret = requireEnv(env, "LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET");
    const base =
      env.LIGHTSPARK_GRID_API_BASE_URL?.trim() || "https://api.lightspark.com/grid/2025-10-13";
    const headers = {
      Authorization: basicAuthHeader(clientId, clientSecret),
    };

    await writeDump(
      RAMP_RAIL_DUMPS.lightspark.config.name,
      await fetchJson(this.id, "GET /config", `${base}/config`, { headers })
    );
  }

  async readRailSupport(readDump: RampDumpReader): Promise<ProviderRampSupport> {
    return extractSupport(
      await readDump<LightsparkConfigDump>(RAMP_RAIL_DUMPS.lightspark.config.file)
    );
  }
}
