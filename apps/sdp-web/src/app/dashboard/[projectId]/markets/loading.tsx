import { isModuleInDeploymentReleaseChannel } from "@/flags/release-channel";
import { MarketsLandingSkeleton } from "./markets-route-skeletons";

/** Follows the release channel alone, a plain env read, so it never waits on flags. */
export default function MarketsLoading() {
  return (
    <MarketsLandingSkeleton
      earn={isModuleInDeploymentReleaseChannel("earn")}
      dvp={isModuleInDeploymentReleaseChannel("dvp")}
    />
  );
}
