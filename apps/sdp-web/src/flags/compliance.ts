import { isModuleInReleaseChannel, type SdpReleaseChannel } from "@sdp/types";
import { policies } from "@/flags";
import { deploymentReleaseChannel } from "./release-channel";

type FlagRead = () => Promise<boolean>;

/**
 * Whether Compliance integrations show. Compliance has no flag of its own; they show
 * when its module is in the release channel and the `policies` flag is on, as before
 * release channels. Under `stable` (no Policies) they stay hidden until Compliance
 * gets its own visibility rule.
 */
export async function resolveComplianceEnabled(input: {
  releaseChannel: SdpReleaseChannel;
  policies: FlagRead;
}): Promise<boolean> {
  if (!isModuleInReleaseChannel(input.releaseChannel, "compliance")) {
    return false;
  }
  return input.policies();
}

/** Whether Compliance integrations show for the current request. */
export function isComplianceEnabled(): Promise<boolean> {
  return resolveComplianceEnabled({ releaseChannel: deploymentReleaseChannel(), policies });
}
