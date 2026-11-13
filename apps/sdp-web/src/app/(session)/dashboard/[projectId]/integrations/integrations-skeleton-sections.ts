import type { ProjectIntegrationFamily } from "@sdp/types/integrations";
import { COMPLIANCE_PROVIDERS } from "@sdp/types/provider-access";
import { MANAGED_RPC_PROVIDERS } from "@sdp/types/rpc";
import { CUSTODY_PROVIDER_CATALOG } from "@/app/(session)/dashboard/[projectId]/wallets/provider-catalog";
import type { DashboardFlags } from "@/flags/dashboard";
import { rampProvidersInReleaseChannel } from "@/flags/release-channel";
import { integrationTabFamilies } from "./integration-sections";

type IntegrationsSkeletonFlags = Pick<
  DashboardFlags,
  "compliance" | "custody" | "privateChannels" | "ramps" | "releaseChannel"
>;

export interface IntegrationsSkeletonSection {
  family: ProjectIntegrationFamily;
  rows: number;
}

const CUSTODY_ROWS = CUSTODY_PROVIDER_CATALOG.filter((entry) => entry.visible).length;
const RPC_ROWS = MANAGED_RPC_PROVIDERS.filter((provider) => provider !== "default").length;

/**
 * The most rows each family can list, from the same catalogues the read decides over, so the
 * placeholder is never shorter than the page it stands in for.
 */
function familyRowCount(
  family: ProjectIntegrationFamily,
  releaseChannel: DashboardFlags["releaseChannel"]
): number {
  switch (family) {
    case "custody":
      return CUSTODY_ROWS;
    case "rpc":
      return RPC_ROWS;
    case "ramps":
      return rampProvidersInReleaseChannel(releaseChannel).length;
    case "compliance":
      return COMPLIANCE_PROVIDERS.length;
    case "private_channels":
      return 1;
    default: {
      const unhandledFamily: never = family;
      throw new Error(`Unhandled integration family: ${unhandledFamily}`);
    }
  }
}

export function familyRowsHaveChevron(family: ProjectIntegrationFamily): boolean {
  switch (family) {
    case "custody":
    case "private_channels":
      return true;
    case "rpc":
    case "ramps":
    case "compliance":
      return false;
    default: {
      const unhandledFamily: never = family;
      throw new Error(`Unhandled integration family: ${unhandledFamily}`);
    }
  }
}

export function integrationsSkeletonSections(
  flags: IntegrationsSkeletonFlags
): IntegrationsSkeletonSection[] {
  return integrationTabFamilies(flags).map((family) => ({
    family,
    rows: familyRowCount(family, flags.releaseChannel),
  }));
}

/** Custody and RPC run in every release channel, so they are the families safe to draw unflagged. */
export const UNFLAGGED_SECTIONS: IntegrationsSkeletonSection[] = [
  { family: "custody", rows: CUSTODY_ROWS },
  { family: "rpc", rows: RPC_ROWS },
];
