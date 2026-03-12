import {
  DashboardPageSkeletonLayout,
  PageHeaderSkeleton,
  SimpleCardSkeleton,
} from "@/components/dashboard-loading";

export default function AllowlistLoading() {
  return (
    <DashboardPageSkeletonLayout
      width="default"
      label="Loading allowlist"
      header={<PageHeaderSkeleton variant="narrow" titleWidthClassName="w-36" />}
    >
      <SimpleCardSkeleton titleWidthClassName="w-32" lines={2} />
    </DashboardPageSkeletonLayout>
  );
}
