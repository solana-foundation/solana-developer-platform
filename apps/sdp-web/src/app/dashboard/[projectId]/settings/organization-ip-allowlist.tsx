"use client";

import { canonicalizeIpRange, isValidIpRange } from "@sdp/ip/ip-range";
import { Button } from "@sdp/ui/button";
import { cn } from "@sdp/ui/cn";
import { Label } from "@sdp/ui/label";
import { XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { RecordSection } from "@/app/dashboard/[projectId]/payments/payments-record";
import { useTranslations } from "@/i18n/provider";
import { refreshKeepingDashboardUrl } from "@/lib/dashboard-url-state";
import { parseAllowedIps } from "@/lib/ip-allowlist-input";
import { saveOrganizationIpAllowlistAction } from "./organization-access-actions";

const FIELD_ID = "organization-allowed-ips";
const HELPER_ID = "organization-allowed-ips-helper";

// A valid entry is kept in the form the API stores, so the tag shows what it grants.
function withEntries(entries: readonly string[], typed: string): string[] {
  const added = parseAllowedIps(typed).map((entry) => canonicalizeIpRange(entry) ?? entry);
  return [...new Set([...entries, ...added])];
}

export function OrganizationIpAllowlist({ initialAllowedIps }: { initialAllowedIps: string[] }) {
  const t = useTranslations();
  const router = useRouter();
  const [entries, setEntries] = useState(initialAllowedIps);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // One key per edit: a retried save repeats it, a changed list gets a new one.
  const idempotencyKey = useRef<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const replaceEntries = (next: string[]) => {
    setEntries(next);
    idempotencyKey.current = null;
  };

  const commitDraft = () => {
    if (draft.trim() === "") return;
    replaceEntries(withEntries(entries, draft));
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === " " || event.key === ",") {
      event.preventDefault();
      commitDraft();
      return;
    }
    if (event.key === "Backspace" && draft === "" && entries.length > 0) {
      replaceEntries(entries.slice(0, -1));
    }
  };

  const invalidCount = entries.filter((entry) => !isValidIpRange(entry)).length;

  const save = () => {
    const toSave = withEntries(entries, draft);
    if (toSave.some((entry) => !isValidIpRange(entry))) {
      replaceEntries(toSave);
      setDraft("");
      return;
    }
    startTransition(async () => {
      idempotencyKey.current ??= crypto.randomUUID();
      const result = await saveOrganizationIpAllowlistAction(
        toSave.join("\n"),
        idempotencyKey.current
      );
      // The action's response re-renders the route at Next's copy of the URL, which a shallow tab
      // switch never updated; re-reading at the live URL keeps the Security tab.
      refreshKeepingDashboardUrl(router);
      if (!result.ok) {
        toast.error(t("Shared.organizationAccess.saveFailed", { error: result.error }));
        return;
      }
      // The list as the API stored it: each entry in canonical form.
      setEntries(result.allowedIps);
      setDraft("");
      idempotencyKey.current = null;
      toast.success(t("Shared.organizationAccess.saved"));
    });
  };

  return (
    <RecordSection id="api-access" title={t("Shared.organizationAccess.title")}>
      <p className="max-w-prose text-meta text-secondary">
        {t("Shared.organizationAccess.description")}
      </p>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={FIELD_ID}>{t("Shared.organizationAccess.allowedIpsLabel")}</Label>
          {/* Clicking the field's padding puts the caret in the input, as in a textarea. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: the input inside is the control; this only forwards focus */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users land on the input directly */}
          <div
            className="flex min-h-24 w-full cursor-text flex-wrap content-start items-center gap-1.5 rounded-xl border border-border-default bg-surface px-3 py-2.5 transition-colors focus-within:border-border-strong"
            onClick={() => inputRef.current?.focus()}
          >
            {entries.map((entry) => {
              const isValid = isValidIpRange(entry);
              return (
                <span
                  key={entry}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md py-0.5 ps-2 pe-1 text-meta font-medium tabular-nums",
                    isValid ? "bg-fill-strong text-primary" : "bg-error/12 text-error"
                  )}
                >
                  {entry}
                  {isValid ? null : (
                    <span className="sr-only">{t("Shared.organizationAccess.invalidEntry")}</span>
                  )}
                  <button
                    type="button"
                    aria-label={t("Shared.organizationAccess.removeEntry", { entry })}
                    disabled={isPending}
                    className="inline-grid size-4 place-items-center rounded-sm text-secondary transition-colors hover:text-primary"
                    onClick={(event) => {
                      event.stopPropagation();
                      replaceEntries(entries.filter((candidate) => candidate !== entry));
                    }}
                  >
                    <XIcon aria-hidden="true" className="size-3" />
                  </button>
                </span>
              );
            })}
            <input
              ref={inputRef}
              id={FIELD_ID}
              value={draft}
              onChange={(event) => {
                const typed = event.currentTarget.value;
                const lastSeparator = Math.max(typed.lastIndexOf(" "), typed.lastIndexOf(","));
                if (lastSeparator === -1) {
                  setDraft(typed);
                  return;
                }
                replaceEntries(withEntries(entries, typed.slice(0, lastSeparator)));
                setDraft(typed.slice(lastSeparator + 1));
              }}
              onKeyDown={onKeyDown}
              onBlur={commitDraft}
              placeholder={entries.length === 0 ? "203.0.113.10, 198.51.100.0/24" : undefined}
              aria-describedby={HELPER_ID}
              spellCheck={false}
              autoComplete="off"
              disabled={isPending}
              className="min-w-40 flex-1 bg-transparent py-0.5 text-body text-primary tabular-nums outline-none placeholder:text-tertiary"
            />
          </div>
          {invalidCount > 0 ? (
            <p id={HELPER_ID} role="alert" className="text-meta text-error">
              {t("Shared.organizationAccess.invalidEntries")}
            </p>
          ) : (
            <p id={HELPER_ID} className="text-meta text-secondary">
              {t("Shared.organizationAccess.allowedIpsHelper")}
            </p>
          )}
        </div>
        <Button
          type="submit"
          size="sm"
          className="self-start"
          loading={isPending}
          disabled={invalidCount > 0}
        >
          {t("Shared.organizationAccess.save")}
        </Button>
      </form>
    </RecordSection>
  );
}
