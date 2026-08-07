"use client";

import type { PaymentWalletPolicy } from "@sdp/types";
import { X } from "lucide-react";
import { type CSSProperties, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import {
  buildPolicyFieldLabels,
  groupPolicyChanges,
  type PolicyChangeRow,
  summarizePolicyChanges,
} from "./policy-change-summary";
import {
  buildPolicyPayload,
  createPolicyAuthoringState,
  type PolicyAuthoringState,
} from "./wallet-policy-authoring";

const ROW_MARKERS = {
  added: "+",
  removed: "−",
  result: "",
} as const satisfies Record<PolicyChangeRow["direction"], string>;

/**
 * Right-side drawer shown before activating wallet controls: a semantic
 * change summary of the pending payload against the active policy — one
 * highlighted row per removed/added value, with a neutral result row when a
 * list ends up empty — and a commit message field describing the change.
 *
 * @param props.open - Whether the drawer is open.
 * @param props.onOpenChange - Called when the drawer requests an open-state change.
 * @param props.walletId - The wallet whose policy is being changed.
 * @param props.activePolicy - The currently active policy.
 * @param props.pendingState - The authoring state about to be activated.
 * @param props.commitMessage - Controlled commit message value.
 * @param props.onCommitMessageChange - Called with the new commit message on input.
 * @param props.onConfirm - Called when the user confirms activation.
 * @param props.isSubmitting - Whether activation is in flight.
 * @returns The review drawer.
 */
export function PolicyCommitDrawer({
  open,
  onOpenChange,
  walletId,
  activePolicy,
  pendingState,
  commitMessage,
  onCommitMessageChange,
  onConfirm,
  isSubmitting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  walletId: string;
  activePolicy: PaymentWalletPolicy;
  pendingState: PolicyAuthoringState;
  commitMessage: string;
  onCommitMessageChange: (value: string) => void;
  onConfirm: () => void;
  isSubmitting: boolean;
}) {
  const t = useTranslations();
  const groups = useMemo(
    () =>
      open
        ? groupPolicyChanges(
            summarizePolicyChanges(
              buildPolicyPayload(walletId, createPolicyAuthoringState(activePolicy)),
              buildPolicyPayload(walletId, pendingState),
              buildPolicyFieldLabels(t)
            )
          )
        : [],
    [open, walletId, activePolicy, pendingState, t]
  );

  return (
    <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="right">
      <DrawerContent
        style={
          {
            "--drawer-content-width": "min(36rem, calc(100vw - 1rem))",
          } as CSSProperties
        }
      >
        <div className="flex items-center justify-between border-b border-border-default px-6 py-4">
          <DrawerTitle className="text-lg font-medium text-primary">
            {t("DashboardCustody.policyCommitDrawerTitle")}
          </DrawerTitle>
          <DrawerClose
            type="button"
            aria-label={t("Shared.SharedComponents.close")}
            className="inline-flex size-8 items-center justify-center bg-transparent text-tertiary transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <X aria-hidden="true" className="size-4" />
          </DrawerClose>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
          {groups.length === 0 ? (
            <p className="text-sm text-secondary italic">
              {t("DashboardCustody.policyCommitNoChanges")}
            </p>
          ) : null}
          {groups.map(({ label, rows: groupRows }) => (
            <div key={groupRows[0].group}>
              <p className="mb-2 text-sm font-medium text-primary">{label}</p>
              <div className="space-y-1">
                {groupRows.map((row) => (
                  <div
                    key={`${row.direction}-${row.value}`}
                    className={cn(
                      "flex items-start gap-2 rounded-r-md border-l-4 px-3 py-2 text-sm",
                      row.direction === "added" &&
                        "border-l-success-border bg-success-bg text-success",
                      row.direction === "removed" && "border-l-error-border bg-error-bg text-error",
                      row.direction === "result" &&
                        "border-l-border-default bg-fill-subtle text-secondary"
                    )}
                  >
                    <span aria-hidden="true" className="w-3 shrink-0 text-center">
                      {ROW_MARKERS[row.direction]}
                    </span>
                    <span
                      className={cn(
                        "min-w-0 break-words",
                        row.direction === "result" ? "italic" : "font-semibold"
                      )}
                    >
                      {row.direction === "result"
                        ? t("DashboardCustody.policyCommitEmpty", { label })
                        : row.value === ""
                          ? label
                          : row.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="space-y-4 border-t border-border-default px-6 py-4">
          <label htmlFor="policy-commit-message" className="block">
            <span className="mb-2 block text-sm font-medium text-primary">
              {t("DashboardCustody.policyCommitMessage")}
            </span>
            <textarea
              id="policy-commit-message"
              value={commitMessage}
              maxLength={500}
              placeholder={t("DashboardCustody.policyCommitMessagePlaceholder")}
              onChange={(event) => onCommitMessageChange(event.currentTarget.value)}
              className="min-h-24 w-full rounded-lg border border-border-default bg-[var(--input-bg-idle)] px-3 py-2 text-sm text-primary outline-none hover:bg-[var(--input-bg-hover)] focus:border-[var(--input-border-focus)]"
            />
            <span className="mt-2 block text-sm text-tertiary">
              {t("DashboardCustody.policyCommitMessageHelp")}
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              {t("DashboardCustody.policyCancel")}
            </Button>
            <Button type="button" onClick={onConfirm} disabled={isSubmitting}>
              {isSubmitting
                ? t("DashboardCustody.policyActivating")
                : t("DashboardCustody.policyActivateControls")}
            </Button>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
