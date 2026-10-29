import {
  isModuleInReleaseChannel,
  SDP_RAMP_PROVIDER_MATURITY,
  type SdpModule,
  type SdpReleaseChannel,
} from "@sdp/types/release-channels";
import type { DashboardFlags } from "@/flags/dashboard";
import { rampProvidersInReleaseChannel } from "@/flags/release-channel";

function inChannel(releaseChannel: SdpReleaseChannel, module: SdpModule): boolean {
  return isModuleInReleaseChannel(releaseChannel, module, SDP_RAMP_PROVIDER_MATURITY);
}

/**
 * The dashboard's flag snapshot on `releaseChannel` when Vercel serves every flag on, so the
 * release channel is the only thing that turns a module off. Derived from the module and ramp
 * provider maturity tables, so promoting a module moves every test built on it.
 *
 * @param releaseChannel - The deployment's release channel.
 * @returns The flags the dashboard shell hands its pages.
 */
export function dashboardFlagsAt(releaseChannel: SdpReleaseChannel): DashboardFlags {
  const payments = inChannel(releaseChannel, "payments");
  const issuance = inChannel(releaseChannel, "issuance");
  return {
    assetProfiles: issuance,
    compliance: inChannel(releaseChannel, "compliance"),
    custody: inChannel(releaseChannel, "custody"),
    dvp: inChannel(releaseChannel, "dvp"),
    earn: inChannel(releaseChannel, "earn"),
    heliusRings: inChannel(releaseChannel, "helius_rings"),
    issuance,
    markets: inChannel(releaseChannel, "markets"),
    payments,
    paymentsDemoMode: false,
    privateChannels: inChannel(releaseChannel, "private_channels"),
    // `isRampsEnabled`: Payments is on and the channel runs at least one provider.
    ramps: payments && rampProvidersInReleaseChannel(releaseChannel).length > 0,
    releaseChannel,
  };
}
