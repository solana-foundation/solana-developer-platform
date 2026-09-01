import type { RampProviderId } from "@sdp/types/provider-access";
import { BvnkRampClient } from "./providers/bvnk/client";
import { CoinbaseRampClient } from "./providers/coinbase/client";
import { LightsparkRampClient } from "./providers/lightspark/client";
import { MoneygramRampClient } from "./providers/moneygram/client";
import { MoonpayRampClient } from "./providers/moonpay/client";
import { MuralRampClient } from "./providers/mural/client";
import { StripeRampClient } from "./providers/stripe/client";
import type { RampProvider } from "./types";

export { BvnkRampClient } from "./providers/bvnk/client";
export { CoinbaseRampClient } from "./providers/coinbase/client";
export { LightsparkRampClient } from "./providers/lightspark/client";
export { MoneygramRampClient } from "./providers/moneygram/client";
export { MoonpayRampClient } from "./providers/moonpay/client";
export { MuralRampClient } from "./providers/mural/client";
export { StripeRampClient } from "./providers/stripe/client";
export type {
  ProviderDeclaredRailSupport,
  ProviderRailSupportDistillation,
  ProviderRailSupportSnapshot,
  RampDiscoveryContext,
  RampDiscoveryResponseDump,
  RampDumpWriter,
  RampFetchJson,
  RampProvider,
  RampRawDumpReader,
  RampSettlementEvent,
} from "./types";
export { providerRailSupportSnapshotSchema } from "./types";

export const RAMP_PROVIDER_CLIENTS = {
  moonpay: new MoonpayRampClient(),
  lightspark: new LightsparkRampClient(),
  bvnk: new BvnkRampClient(),
  moneygram: new MoneygramRampClient(),
  coinbase: new CoinbaseRampClient(),
  mural: new MuralRampClient(),
  stripe: new StripeRampClient(),
} as const satisfies Record<RampProviderId, RampProvider>;
