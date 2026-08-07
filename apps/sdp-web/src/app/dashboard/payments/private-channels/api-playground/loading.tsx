import { ApiPlaygroundShellSkeleton } from "@/components/api-playground-shell-skeleton";
import { SkeletonTabs } from "../private-channels-route-skeletons";

export default function PrivateChannelsApiPlaygroundLoading() {
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <SkeletonTabs />
      <div className="flex min-h-0 flex-1 flex-col">
        <ApiPlaygroundShellSkeleton />
      </div>
    </div>
  );
}
