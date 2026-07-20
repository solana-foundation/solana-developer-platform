import type { ApprovalRequestStatus } from "@sdp/types";
import { cn } from "@/lib/utils";
import { formatApprovalLabel } from "./approval-requests.data";

const STATUS_CLASS_NAMES: Record<ApprovalRequestStatus, string> = {
  pending: "border-warning-border bg-warning-bg text-warning",
  approved: "border-success-border bg-success-bg text-success",
  rejected: "border-error-border bg-error-bg text-error",
  canceled: "border-border-default bg-fill-subtle text-secondary",
  expired: "border-border-default bg-fill-subtle text-secondary",
  failed: "border-error-border bg-error-bg text-error",
};

export function ApprovalStatusBadge({
  status,
  className,
}: {
  status: ApprovalRequestStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-full border px-2.5 text-xs font-medium",
        STATUS_CLASS_NAMES[status],
        className
      )}
    >
      {formatApprovalLabel(status)}
    </span>
  );
}
