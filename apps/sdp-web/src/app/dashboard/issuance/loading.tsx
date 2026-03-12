import {
  DashboardPageSkeletonLayout,
  PageHeaderSkeleton,
} from "@/components/dashboard-loading";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { IssuancePageSkeleton } from "./issuance-page-skeleton";

export default function IssuanceLoading() {
  return (
    <DashboardPageSkeletonLayout
      width="full"
      label="Loading issuance"
      header={
        <PageHeaderSkeleton
          variant="wide"
          titleWidthClassName="w-40"
          tabs
          action={<SkeletonBlock className="h-10 w-36 rounded-[10px]" />}
        />
      }
    >
      <IssuancePageSkeleton />
    </DashboardPageSkeletonLayout>
  );
}
