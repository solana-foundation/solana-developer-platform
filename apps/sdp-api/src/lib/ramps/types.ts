import type { SdpEnvironment } from "@sdp/types";
import type { CryptoRailId, FiatCurrencyCode } from "@sdp/types/payment-rails";
import type { RampProviderId } from "@sdp/types/provider-access";

export interface ProviderRampSupport {
  onrampFiats: ReadonlySet<FiatCurrencyCode>;
  onrampCryptos: ReadonlySet<CryptoRailId>;
  offrampFiats: ReadonlySet<FiatCurrencyCode>;
  offrampCryptos: ReadonlySet<CryptoRailId>;
}

export interface MutableProviderRampSupport {
  onrampFiats: Set<FiatCurrencyCode>;
  onrampCryptos: Set<CryptoRailId>;
  offrampFiats: Set<FiatCurrencyCode>;
  offrampCryptos: Set<CryptoRailId>;
}

export interface RampDiscoveryResponseDump {
  status: number;
  body: unknown;
}

export type RampFetchJson = (
  provider: RampProviderId,
  label: string,
  url: string,
  init?: RequestInit
) => Promise<RampDiscoveryResponseDump>;

export type RampDumpWriter = (name: string, payload: RampDiscoveryResponseDump) => Promise<void>;
export type RampDumpReader = <T>(relativePath: string) => Promise<T>;

export interface RampDiscoveryContext {
  env: Record<string, string | undefined>;
  fetchJson: RampFetchJson;
  writeDump: RampDumpWriter;
}

export interface RampWebhookValidationContext {
  env: Record<string, string | undefined>;
  environment: SdpEnvironment;
  headers: Headers;
  rawBody: string;
  requestUrl?: string;
}

export interface RampWebhookValidationResult {
  provider: RampProviderId;
  payload: unknown;
}

export interface RampProviderClient {
  id: RampProviderId;
  _discoverRails(context: RampDiscoveryContext): Promise<void>;
  readRailSupport(readDump: RampDumpReader): Promise<ProviderRampSupport>;
  validateWebhook(context: RampWebhookValidationContext): Promise<RampWebhookValidationResult>;
}
