import {
  DashboardPageSkeletonLayout,
  PageHeaderSkeleton,
} from "@/components/dashboard-loading";
import { PaymentsPageSkeleton } from "./payments-page-skeleton";

export default function PaymentsLoading() {
  return (
    <DashboardPageSkeletonLayout
      width="full"
      label="Loading payments"
      header={<PageHeaderSkeleton variant="wide" titleWidthClassName="w-44" tabs />}
    >
      <PaymentsPageSkeleton />
    </DashboardPageSkeletonLayout>
  );
}
