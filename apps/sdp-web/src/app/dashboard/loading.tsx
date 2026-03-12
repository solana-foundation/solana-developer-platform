import {
  DashboardPageSkeletonLayout,
  HeaderActionPairSkeleton,
  MetricCardsSkeleton,
  PageHeaderSkeleton,
  TableCardSkeleton,
} from "@/components/dashboard-loading";
import { SkeletonBlock } from "@/components/ui/skeleton-block";

export default function DashboardLoading() {
  return (
    <DashboardPageSkeletonLayout
      width="default"
      label="Loading home"
      className="space-y-8 py-2"
      header={
        <PageHeaderSkeleton
          variant="display"
          titleWidthClassName="w-32"
          action={<HeaderActionPairSkeleton />}
        />
      }
    >
      <MetricCardsSkeleton />
      <TableCardSkeleton
        titleWidthClassName="w-56"
        descriptionWidthClassName="w-72"
        rows={6}
        headerAction={<SkeletonBlock className="h-9 w-24 rounded-[10px]" />}
      />
    </DashboardPageSkeletonLayout>
  );
}
