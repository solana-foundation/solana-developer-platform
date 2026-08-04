"use client";

import type { WalletControlProfileRevisionHistory } from "@sdp/types";
import { History, X } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
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
 * @param props.preloaded - Server-fetched history + member labels, when the page already has them.
 * @returns The trigger button with its drawer.
 */
export function RevisionHistoryDrawer({
  walletId,
  initialRevisionId,
  preloaded,
}: {
  walletId: string;
  initialRevisionId?: string;
  preloaded?: {
    history: WalletControlProfileRevisionHistory;
    userNames: Record<string, string>;
  };
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(Boolean(initialRevisionId));
  const [selectedRevisionId, setSelectedRevisionId] = useState(
    initialRevisionId === "latest" ? undefined : initialRevisionId
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            iconLeft={<History className="size-4" />}
          >
            {t("DashboardCustody.policyAuditRevisionHistory")}
          </Button>
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
            <div className="p-4">
              <SkeletonBlock className="h-72 w-full" />
            </div>
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
