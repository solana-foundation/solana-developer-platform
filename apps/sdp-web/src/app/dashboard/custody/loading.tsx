import {
  DashboardPageSkeletonLayout,
  PageHeaderSkeleton,
} from "@/components/dashboard-loading";
import { WalletsPageSkeleton } from "../wallets/wallets-page-skeleton";

export default function CustodyLoading() {
  return (
    <DashboardPageSkeletonLayout
      width="full"
      label="Loading wallets"
      header={<PageHeaderSkeleton variant="wide" titleWidthClassName="w-32" />}
    >
      <WalletsPageSkeleton />
    </DashboardPageSkeletonLayout>
  );
}
