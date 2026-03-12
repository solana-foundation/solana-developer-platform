import {
  DashboardPageSkeletonLayout,
  FormCardSkeleton,
  PageHeaderSkeleton,
} from "@/components/dashboard-loading";

export default function CustodySetupLoading() {
  return (
    <DashboardPageSkeletonLayout
      width="narrow"
      label="Loading wallet setup"
      header={
        <PageHeaderSkeleton
          variant="narrow"
          titleWidthClassName="w-44"
          backLink
        />
      }
    >
      <FormCardSkeleton titleWidthClassName="w-44" descriptionWidthClassName="w-[70%]" fields={4} />
    </DashboardPageSkeletonLayout>
  );
}
