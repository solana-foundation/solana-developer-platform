import {
  DashboardPageSkeletonLayout,
  PageHeaderSkeleton,
  TableCardSkeleton,
} from "@/components/dashboard-loading";
import { SkeletonBlock } from "@/components/ui/skeleton-block";

export default function ApiKeysLoading() {
  return (
    <DashboardPageSkeletonLayout
      width="full"
      label="Loading API keys"
      header={<PageHeaderSkeleton variant="wide" titleWidthClassName="w-40" />}
    >
      <TableCardSkeleton
        titleWidthClassName="w-36"
        descriptionWidthClassName="w-64"
        rows={6}
        rowHeightClassName="h-12"
        headerAction={<SkeletonBlock className="h-10 w-28 rounded-[10px]" />}
        cardClassName="rounded-[20px]"
      />
    </DashboardPageSkeletonLayout>
  );
}
