import type { SdpModule } from "@sdp/types/release-channels";
import { requestProjectEnvironment } from "@/lib/sdp-api";
import { isModuleInEnvironmentReleaseChannel } from "./release-channel";

/**
 * Whether this deployment runs `module` for the request's Project environment, the check
 * the API's project context makes. Server-only: it reads the request's Project.
 *
 * @param module - The module a screen belongs to.
 * @returns True when the release channel runs the module for the Project's environment.
 */
export async function isModuleInProjectReleaseChannel(module: SdpModule): Promise<boolean> {
  return isModuleInEnvironmentReleaseChannel(module, await requestProjectEnvironment());
}
