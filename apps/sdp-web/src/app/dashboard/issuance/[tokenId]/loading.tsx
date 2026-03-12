import {
  DashboardPageSkeletonLayout,
  PageHeaderSkeleton,
  TableCardSkeleton,
  TokenManagementHeroSkeleton,
} from "@/components/dashboard-loading";

export default function TokenDetailLoading() {
  return (
    <DashboardPageSkeletonLayout
      width="full"
      label="Loading token details"
      header={<PageHeaderSkeleton variant="narrow" backLink showTitleRow={false} />}
    >
      <TokenManagementHeroSkeleton />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]">
        <TableCardSkeleton
          titleWidthClassName="w-32"
          descriptionWidthClassName="w-[54%]"
          rows={5}
          rowHeightClassName="h-12"
        />
        <TableCardSkeleton
          titleWidthClassName="w-36"
          descriptionWidthClassName="w-[62%]"
          rows={4}
          rowHeightClassName="h-12"
        />
      </div>
      <TableCardSkeleton
        titleWidthClassName="w-36"
        descriptionWidthClassName="w-[38%]"
        rows={5}
        rowHeightClassName="h-12"
      />
    </DashboardPageSkeletonLayout>
  );
}
