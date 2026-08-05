"use client";

import type { WalletControlProfileRevisionHistory } from "@sdp/types";
import { History, X } from "lucide-react";
import { type CSSProperties, type ReactElement, useEffect, useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { useTranslations } from "@/i18n/provider";
import { replaceDashboardSearchParams } from "@/lib/dashboard-url-state";
import { PolicyRevisionExplorer } from "./policy-revision-explorer";
import { fetchWalletRevisionHistoryAction } from "./revision-history.actions";

/**
 * "Revision history" trigger that opens the revision explorer in a right-side
 * drawer instead of navigating to the full revisions page. History loads
 * lazily on first open so the trigger costs nothing on pages that never use
 * it; pages that already fetched the history server-side pass it as
 * `preloaded` so opening the drawer never refetches it.
 *
 * @param props.walletId - The wallet whose revision history the drawer shows.
 * @param props.initialRevisionId - Deep-linked `?revision=` value; opens the drawer on mount.
 * @param props.defaultRevisionId - Revision to preselect when the drawer is opened manually; does not open it on mount.
 * @param props.preloaded - Server-fetched history + member labels, when the page already has them.
 * @param props.trigger - Replaces the default "Revision history" trigger button.
 * @returns The trigger button with its drawer.
 */
/**
 * Coarse placeholder mirroring the explorer's two-pane geometry — revision
 * rows on the left, snapshot header and rule cards on the right — so the
 * drawer doesn't reflow when history arrives.
 *
 * @returns The loading layout.
 */
function RevisionHistorySkeleton() {
  return (
    <div
      aria-busy="true"
      className="grid h-full min-h-0 grid-rows-[minmax(0,2fr)_minmax(0,3fr)] bg-surface-raised lg:grid-cols-[320px_minmax(0,1fr)] lg:grid-rows-1"
    >
      <div className="flex min-h-0 flex-col overflow-hidden border-b border-border-default lg:border-r lg:border-b-0">
        <div className="shrink-0 border-b border-border-default px-4 py-3">
          <SkeletonBlock className="h-6 w-24" />
        </div>
        <div className="divide-y divide-border-default">
          {[0, 1, 2].map((row) => (
            <div key={row} className="space-y-3 px-4 py-4">
              <SkeletonBlock className="h-4 w-40 max-w-full" />
              <div className="flex items-center gap-2">
                <SkeletonBlock className="size-6 rounded-full" />
                <SkeletonBlock className="h-4 w-32" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="min-h-0 space-y-5 overflow-hidden p-5 sm:p-6">
        <div className="space-y-3 border-b border-border-default pb-5">
          <SkeletonBlock className="h-8 w-44 max-w-full" />
          <SkeletonBlock className="h-4 w-72 max-w-full" />
        </div>
        {[0, 1, 2].map((card) => (
          <SkeletonBlock key={card} className="h-24 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}

export function RevisionHistoryDrawer({
  walletId,
  initialRevisionId,
  defaultRevisionId,
  preloaded,
  trigger,
}: {
  walletId: string;
  initialRevisionId?: string;
  defaultRevisionId?: string;
  preloaded?: {
    history: WalletControlProfileRevisionHistory;
    userNames: Record<string, string>;
  };
  trigger?: ReactElement;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(Boolean(initialRevisionId));
  const [selectedRevisionId, setSelectedRevisionId] = useState(
    initialRevisionId && initialRevisionId !== "latest" ? initialRevisionId : defaultRevisionId
  );
  const { data } = useSWR(
    open && !preloaded ? `wallet-policy-revisions-${walletId}` : null,
    () => fetchWalletRevisionHistoryAction(walletId),
    { revalidateOnFocus: false, revalidateIfStale: false, revalidateOnReconnect: false }
  );
  const result = preloaded ? ({ ok: true, ...preloaded } as const) : data;

  useEffect(() => {
    if (!open || !result?.ok) return;
    const resolvedRevisionId =
      result.history.revisions.find((revision) => revision.id === selectedRevisionId)?.id ??
      result.history.revisions[0]?.id;
    if (!resolvedRevisionId || resolvedRevisionId === selectedRevisionId) return;
    setSelectedRevisionId(resolvedRevisionId);
    replaceDashboardSearchParams({ revision: resolvedRevisionId });
  }, [result, open, selectedRevisionId]);

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    replaceDashboardSearchParams({
      revision: nextOpen ? (selectedRevisionId ?? "latest") : null,
    });
  }

  return (
    <Drawer open={open} onOpenChange={handleOpenChange} swipeDirection="right">
      <DrawerTrigger
        render={
          trigger ? (
            trigger
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              iconLeft={<History className="size-4" />}
            >
              {t("DashboardCustody.policyAuditRevisionHistory")}
            </Button>
          )
        }
      />
      <DrawerContent
        style={
          {
            "--drawer-content-width": "min(80rem, calc(100vw - 1rem))",
          } as CSSProperties
        }
      >
        <DrawerTitle className="sr-only">
          {t("DashboardCustody.policyAuditRevisionHistory")}
        </DrawerTitle>
        <DrawerClose
          type="button"
          aria-label={t("Shared.SharedComponents.close")}
          className="absolute top-4 right-4 z-30 inline-flex size-8 items-center justify-center bg-transparent text-tertiary transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <X aria-hidden="true" className="size-4" />
        </DrawerClose>
        <div className="min-h-0 flex-1 overflow-hidden">
          {!result ? (
            <RevisionHistorySkeleton />
          ) : result.ok ? (
            <PolicyRevisionExplorer
              history={result.history}
              initialRevisionId={selectedRevisionId}
              userNames={result.userNames}
              onRevisionSelect={setSelectedRevisionId}
              flush
            />
          ) : (
            <p className="p-4 text-sm text-error">{result.error}</p>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
