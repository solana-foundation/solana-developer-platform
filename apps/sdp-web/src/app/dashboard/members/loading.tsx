import {
  DashboardPageSkeletonLayout,
  PageHeaderSkeleton,
  SimpleCardSkeleton,
} from "@/components/dashboard-loading";

export default function MembersLoading() {
  return (
    <DashboardPageSkeletonLayout
      width="default"
      label="Loading members"
      header={<PageHeaderSkeleton variant="narrow" titleWidthClassName="w-32" />}
    >
      <SimpleCardSkeleton titleWidthClassName="w-32" lines={2} />
    </DashboardPageSkeletonLayout>
  );
}
