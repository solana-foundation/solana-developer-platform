"use client";

import { Check, Loader2Icon, Plus, Search, ShieldAlertIcon, X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { ScreeningProgress } from "@/app/dashboard/payments/counterparty/screening-progress";
import { shortenAddress } from "@/app/dashboard/payments/payments-overview.utils";
import { Button } from "@/components/ui/button";
import { HoldButton } from "@/components/ui/hold-button";
import { Input } from "@/components/ui/input";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { useDestinationEditor } from "./use-destination-editor";
import { DESTINATION_MODES, type PolicyAuthoringState } from "./wallet-policy-authoring";
import { FormSection } from "./wallet-policy-flow.shared";

export function DestinationEditor({
  state,
  setPolicyState,
  complianceScreeningEnabled,
}: {
  state: PolicyAuthoringState;
  setPolicyState: (update: (current: PolicyAuthoringState) => PolicyAuthoringState) => void;
  complianceScreeningEnabled: boolean;
}) {
  const t = useTranslations();
  const editor = useDestinationEditor(state, setPolicyState, complianceScreeningEnabled);

  return (
    <FormSection
      title={t("DashboardCustody.policyDestinationControls")}
      description={t(
        state.destinationMode === "allowlist"
          ? "DashboardCustody.policyDestinationAllowlistDescription"
          : "DashboardCustody.policyDestinationBlocklistDescription"
      )}
      trailing={
        <div className="grid shrink-0 grid-cols-2 rounded-full bg-fill p-0.5">
          {DESTINATION_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={state.destinationMode === mode}
              className={cn(
                "h-7 rounded-full px-3 text-xs font-semibold transition-colors",
                state.destinationMode === mode
                  ? "bg-surface-raised text-primary shadow-sm"
                  : "text-secondary hover:text-primary"
              )}
              onClick={() => setPolicyState((current) => ({ ...current, destinationMode: mode }))}
            >
              {t(
                mode === "allowlist"
                  ? "DashboardCustody.policyAllowList"
                  : "DashboardCustody.policyBlockList"
              )}
            </button>
          ))}
        </div>
      }
    >
      <fieldset
        className="relative min-w-0"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            editor.setOpen(false);
          }
        }}
      >
        <legend className="sr-only">{t("DashboardCustody.policyWalletAddresses")}</legend>
        <Input
          value={editor.query}
          iconLeft={<Search />}
          disabled={editor.busy}
          placeholder={t("DashboardCustody.policyDestinationSearchPlaceholder")}
          role="combobox"
          aria-expanded={editor.open}
          aria-controls="policy-destination-options"
          action={
            editor.busy ? <Loader2Icon className="size-4 animate-spin text-muted" /> : undefined
          }
          onFocus={() => editor.setOpen(true)}
          onChange={(event) => editor.handleQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              editor.submitSearch();
            }
            if (event.key === "Escape") editor.setOpen(false);
          }}
        />

        {editor.open &&
        (editor.matchingAccounts.length > 0 ||
          editor.canAddExternal ||
          Boolean(editor.trimmedQuery)) ? (
          <div
            id="policy-destination-options"
            role="listbox"
            aria-multiselectable="true"
            className="absolute z-20 mt-2 w-full overflow-hidden rounded-lg border border-border-default bg-surface-raised shadow-lg"
          >
            {editor.matchingAccounts.length > 0 ? (
              <div className="max-h-72 overflow-y-auto">
                <p className="sticky top-0 z-10 bg-surface-raised px-3 pt-2.5 pb-1 font-medium text-[11px] text-muted uppercase tracking-wide">
                  {t("DashboardCustody.policyDestinationCounterparties")}
                </p>
                {editor.matchingAccounts.map((account) => {
                  const selected = editor.parsed.valid.includes(account.address);
                  return (
                    <button
                      key={account.counterpartyAccountId}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-sunken"
                      onClick={() => editor.toggleAccount(account.address)}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-primary text-base font-medium">
                          {account.name}
                          {account.label ? (
                            <span className="text-muted text-sm font-normal">
                              {" "}
                              · {account.label}
                            </span>
                          ) : null}
                        </span>
                        <span className="block truncate text-muted text-sm">
                          {shortenAddress(account.address)}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "flex size-5 shrink-0 items-center justify-center rounded border",
                          selected
                            ? "border-primary bg-primary text-on-primary"
                            : "border-border-strong bg-surface-raised text-transparent"
                        )}
                      >
                        <Check className="size-3.5" />
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : editor.trimmedQuery && !editor.canAddExternal ? (
              <p className="px-3 py-4 text-sm text-muted">
                {t("DashboardCustody.policyNoMatchingDestinations")}
              </p>
            ) : null}
            {editor.canAddExternal ? (
              <button
                type="button"
                className="flex w-full items-center gap-2 border-t border-border-default px-3 py-2.5 text-left text-sm font-medium text-primary hover:bg-surface-sunken first:border-t-0"
                onClick={() => void editor.requestAdd(editor.trimmedQuery)}
              >
                <Plus className="size-4" />
                <span className="min-w-0 flex-1">
                  <span className="block">
                    {t("DashboardCustody.policyDestinationAddExternal")}
                  </span>
                  <span className="block truncate text-xs font-normal text-muted">
                    {editor.trimmedQuery}
                  </span>
                </span>
              </button>
            ) : null}
          </div>
        ) : null}
      </fieldset>
      {editor.inputError ? (
        <p className="mt-2 text-sm text-error">
          {t(
            editor.inputError === "duplicate"
              ? "DashboardCustody.policyDuplicateDestination"
              : "DashboardCustody.policyDestinationInvalid"
          )}
        </p>
      ) : null}

      <AnimatePresence>
        {editor.snapshot && editor.phase !== "idle" ? (
          <div className="mt-4">
            <ScreeningProgress
              key="screening"
              results={editor.snapshot.providers}
              onComplete={editor.onScreeningComplete}
            />
          </div>
        ) : null}
      </AnimatePresence>

      {editor.phase === "risk" ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-error">
            {editor.screenUnavailable
              ? t("DashboardPayments.counterparty.screeningUnavailable")
              : t("DashboardPayments.counterparty.screeningWarning")}
          </p>
          <HoldButton
            iconLeft={<ShieldAlertIcon className="size-3.5" />}
            onHoldComplete={editor.commitPending}
          >
            {t("DashboardPayments.counterparty.holdToAddAnyway")}
          </HoldButton>
        </div>
      ) : null}

      {editor.flagged.length > 0 ? (
        <div className="mt-4 space-y-2">
          {editor.flagged.map((item) => (
            <div
              key={item.address}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-error-border bg-error-bg px-3 py-2"
            >
              <span className="min-w-0">
                <span
                  className="block truncate text-sm font-medium text-primary"
                  title={item.address}
                >
                  {shortenAddress(item.address)}
                </span>
                <span className="block text-xs text-error">
                  {item.unavailable
                    ? t("DashboardPayments.counterparty.screeningUnavailable")
                    : t("DashboardPayments.counterparty.screeningWarning")}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <HoldButton
                  iconLeft={<ShieldAlertIcon className="size-3.5" />}
                  onHoldComplete={() => editor.commitFlagged(item.address)}
                >
                  {t("DashboardPayments.counterparty.holdToAddAnyway")}
                </HoldButton>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("DashboardCustody.policyRemoveDestination", {
                    address: item.address,
                  })}
                  onClick={() => editor.dismissFlagged(item.address)}
                >
                  <X className="size-4" />
                </Button>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {editor.parsed.valid.length > 0 ? (
        <div className="mt-5 divide-y divide-border-default border-t border-border-default">
          {editor.parsed.valid.map((entry) => {
            const display = editor.destinationDisplay(entry);
            return (
              <div key={entry} className="flex min-h-14 items-center gap-3 py-2.5 last:pb-0">
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block truncate text-base font-medium",
                      display.known ? "text-primary" : "text-secondary"
                    )}
                  >
                    {display.name}
                  </span>
                  <span className="block truncate text-sm text-muted" title={entry}>
                    {shortenAddress(entry)}
                  </span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("DashboardCustody.policyRemoveDestination", { address: entry })}
                  onClick={() => editor.removeDestination(entry)}
                >
                  <X className="size-4" />
                </Button>
              </div>
            );
          })}
        </div>
      ) : null}
    </FormSection>
  );
}
