"use client";

import type { CustodyConnectionLifecycle, CustodyProvider } from "@sdp/types";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import { formatWalletMeta } from "@/app/dashboard/custody/wallet-format-utils";
import { useTranslations } from "@/i18n/provider";
import type { CustodyCredentialLifecycle } from "./connection-detail.data";
import { statusLabel } from "./connection-status";

/**
 * Every connection these credentials currently sign for, across every project
 * the viewer can see.
 *
 * Rotation and rollback are all-or-nothing over exactly this set — the API acts
 * on `expectedConnectionIds` atomically and refuses a partial selection — so
 * this list is shown before the confirm, not after it.
 *
 * Rows are identified by connection id and distinguished by project. A
 * connection has no name of its own in the data model: the label shown
 * elsewhere belongs to the credential, and every row here shares that one
 * credential, so printing it on each row would suggest a per-connection name
 * that does not exist. The project is what actually differs, so it leads.
 */
export function CredentialImpactList({
  impact,
  provider,
}: {
  impact: CustodyCredentialLifecycle["impact"];
  provider: CustodyProvider;
}) {
  const t = useTranslations();
  const projectNames = new Map(impact.projects.map((project) => [project.id, project.name]));

  return (
    <div>
      <p className="text-sm font-medium text-primary">
        {t("DashboardCustody.impactConnectionsTitle")}
      </p>
      <ul className="mt-2">
        {impact.connections.map((connection) => (
          <li
            key={connection.id}
            data-impact-connection-id={connection.id}
            className="flex items-center justify-between gap-3 border-b border-border-default py-2.5 last:border-b-0"
          >
            <span className="flex min-w-0 items-center gap-2">
              <WalletProviderMark provider={provider} size="xs" />
              <span className="truncate font-mono text-xs text-secondary">
                {formatWalletMeta(connection.id, 10, 6)}
              </span>
            </span>
            <span className="shrink-0 text-xs text-secondary">
              {projectNames.get(connection.projectId) ?? connection.projectId}
              {" · "}
              {statusLabel(connection.status as CustodyConnectionLifecycle, t)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
