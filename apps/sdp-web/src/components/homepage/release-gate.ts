import type { SdpModule } from "@sdp/types/release-channels";
import { isModuleInDeploymentReleaseChannel } from "@/flags/release-channel";

/**
 * The module that decides each homepage surface a release channel can hold back. Privacy follows
 * private channels; markets follows its derived module, in when Earn or DvP is.
 */
const GATED_SURFACE_MODULES = {
  issuance: "issuance",
  markets: "markets",
  privacy: "private_channels",
  compliance: "compliance",
  ramps: "ramps",
} as const satisfies Record<string, SdpModule>;

export type GatedSurface = keyof typeof GATED_SURFACE_MODULES;

/**
 * Whether the deployment's release channel holds `surface` back, so the homepage marks it
 * "Coming soon" instead of presenting it as live.
 *
 * @param surface - The homepage surface.
 * @returns True when the surface's module is outside the deployment's release channel.
 */
export function isComingSoon(surface: GatedSurface): boolean {
  return !isModuleInDeploymentReleaseChannel(GATED_SURFACE_MODULES[surface]);
}
