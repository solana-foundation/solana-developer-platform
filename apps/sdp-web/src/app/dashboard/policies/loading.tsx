import { PoliciesOverviewSkeleton } from "./policies-overview";

export default function PoliciesLoading() {
  return (
    <div className="contents" data-loading-layout="policies">
      <PoliciesOverviewSkeleton />
    </div>
  );
}
