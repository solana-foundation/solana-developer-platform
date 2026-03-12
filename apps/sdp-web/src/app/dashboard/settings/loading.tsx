import {
  DashboardPageSkeletonLayout,
  FormCardSkeleton,
  PageHeaderSkeleton,
} from "@/components/dashboard-loading";

export default function SettingsLoading() {
  return (
    <DashboardPageSkeletonLayout
      width="narrow"
      label="Loading settings"
      header={<PageHeaderSkeleton variant="narrow" titleWidthClassName="w-36" />}
    >
      <FormCardSkeleton titleWidthClassName="w-48" descriptionWidthClassName="w-[64%]" fields={3} />
    </DashboardPageSkeletonLayout>
  );
}
