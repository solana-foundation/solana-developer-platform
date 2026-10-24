import {
  isModuleInReleaseChannel,
  SDP_RAMP_PROVIDER_MATURITY,
  type SdpModule,
  type SdpReleaseChannel,
} from "@sdp/types/release-channels";
import type { DashboardFlags } from "@/flags/dashboard";
import { rampProvidersInReleaseChannel } from "@/flags/release-channel";
import type { DesignModule } from "@/lib/design-modules";

export type DashboardDesign = "legacy" | "redesign";

export const DASHBOARD_DESIGNS = ["legacy", "redesign"] as const satisfies DashboardDesign[];

function inChannel(releaseChannel: SdpReleaseChannel, module: SdpModule): boolean {
  return isModuleInReleaseChannel(releaseChannel, module, SDP_RAMP_PROVIDER_MATURITY);
}

/**
 * The dashboard's flag snapshot on `releaseChannel` when Vercel serves every flag on, so the
 * release channel is the only thing that turns a module off. Derived from the module and ramp
 * provider maturity tables, so promoting a module moves every test built on it.
 *
 * @param releaseChannel - The deployment's release channel.
 * @param design - Which design the snapshot picks; `redesign` turns on every design module too.
 * @returns The flags the dashboard shell hands its pages.
 */
export function dashboardFlagsAt(
  releaseChannel: SdpReleaseChannel,
  design: DashboardDesign = "legacy"
): DashboardFlags {
  const newDesign = design === "redesign";
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
    newDesign,
    newDesignModules: {
      overview: newDesign,
      wallets: newDesign,
      issuance: newDesign,
      contacts: newDesign,
      payDeposit: newDesign,
      activity: newDesign,
    } satisfies Record<DesignModule, boolean>,
    payments,
    paymentsDemoMode: false,
    privateChannels: inChannel(releaseChannel, "private_channels"),
    // `isRampsEnabled`: Payments is on and the channel runs at least one provider.
    ramps: payments && rampProvidersInReleaseChannel(releaseChannel).length > 0,
    releaseChannel,
  };
}
