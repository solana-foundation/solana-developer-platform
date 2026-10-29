"use client";
import { Button } from "@sdp/ui/button";
import { toast } from "sonner";
import { useTranslations } from "@/i18n/provider";
import { useFireblocksWarning } from "@/lib/use-fireblocks-warning";

/** Fireblocks Editors cannot read policies. Keep guidance local and dismissible. */
export function FireblocksTransferPolicy({ enabled }: { enabled: boolean }) {
  const t = useTranslations();
  const { suppressed, suppress, canSuppress } = useFireblocksWarning("policy");
  if (suppressed || !enabled) return null;
  return (
    <div className="space-y-3 border-t border-border-default pt-4">
      <p className="text-sm text-secondary" role="status">
        {t("DashboardPayments.fireblocksPolicy.configure")}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <a
          href="https://console.fireblocks.io"
          target="_blank"
          rel="noreferrer"
          className="text-sm underline underline-offset-4"
        >
          {t("DashboardPayments.fireblocksPolicy.openFireblocks")}
        </a>
        {canSuppress ? (
          <Button
            type="button"
            variant="ghost"
            title={t("DashboardPayments.fireblocksWarnings.scope")}
            onClick={() => {
              if (!suppress()) toast.error(t("DashboardPayments.fireblocksWarnings.saveFailed"));
            }}
          >
            {t("DashboardPayments.fireblocksWarnings.suppress")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
