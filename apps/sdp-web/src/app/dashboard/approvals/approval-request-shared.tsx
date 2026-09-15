import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { type ApprovalBadgeStatus, formatApprovalLabel } from "./approval-requests.data";

const STATUS_CLASS_NAMES: Record<ApprovalBadgeStatus, string> = {
  pending: "border-warning-border bg-warning-bg text-warning",
  approved: "border-success-border bg-success-bg text-success",
  rejected: "border-error-border bg-error-bg text-error",
  canceled: "border-border-default bg-fill-subtle text-secondary",
  expired: "border-border-default bg-fill-subtle text-secondary",
  failed: "border-error-border bg-error-bg text-error",
  execution_failed: "border-error-border bg-error-bg text-error",
};

export function ApprovalStatusBadge({
  status,
  className,
}: {
  status: ApprovalBadgeStatus;
  className?: string;
}) {
  const t = useTranslations();
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-full border px-2.5 text-xs font-medium whitespace-nowrap",
        STATUS_CLASS_NAMES[status],
        className
      )}
    >
      {status === "execution_failed"
        ? t("DashboardApprovals.executionFailedStatus")
        : formatApprovalLabel(status)}
    </span>
  );
}
