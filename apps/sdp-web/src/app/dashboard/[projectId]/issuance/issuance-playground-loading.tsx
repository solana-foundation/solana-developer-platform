import { ApiPlaygroundShellSkeleton } from "@/components/api-playground-shell-skeleton";

export function IssuancePlaygroundLoading() {
  return (
    <div className="h-full" data-loading-layout="issuance-playground" aria-busy="true">
      <ApiPlaygroundShellSkeleton />
    </div>
  );
}
