"use client";

import { type Action, grantsCoverAction } from "@sdp/types/actions";
import { Button } from "@sdp/ui/button";
import { Modal } from "@sdp/ui/modal";
import { CopyIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { RecordBlock } from "@/components/refresh-record";
import { useTranslations } from "@/i18n/provider";

const API_KEY_ENV_NAME = "SDP_API_KEY";

/** A read the key may make, so the first call it is tried with answers rather than 403s. */
function tryPath(grants: readonly Action[]): string | null {
  if (grantsCoverAction(grants, "wallets.read")) return "/v1/wallets";
  if (grantsCoverAction(grants, "counterparties.read")) return "/v1/counterparties?limit=1";
  return null;
}

function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return [
    copied,
    (text: string) => {
      void navigator.clipboard.writeText(text).then(
        () => setCopied(true),
        () => setCopied(false)
      );
    },
  ];
}

/** Where the person was headed when the guard stopped them: a dashboard link, or Back. */
type LeaveAttempt = { kind: "link"; href: string } | { kind: "back" };

/**
 * Holds the page while the secret is unsaved, since it cannot be shown again: closing the tab
 * asks the browser's question, and a link inside the page or the browser's Back asks ours. The
 * shell's own navigation is locked by the page. Back is caught by an extra history entry for
 * this page, put back each time Back takes it; every way out of the guard takes that entry with
 * it, so Back afterwards goes where it went before the secret showed.
 */
function useLeaveGuard(active: boolean) {
  const router = useRouter();
  const [attempt, setAttempt] = useState<LeaveAttempt | null>(null);
  const leaving = useRef(false);
  // Survives a remount of the same guard, so the extra entry is added once.
  const entryAdded = useRef(false);

  useEffect(() => {
    if (!active) return;
    if (!entryAdded.current) {
      entryAdded.current = true;
      window.history.pushState(window.history.state, "", window.location.href);
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    const onPopState = () => {
      if (leaving.current) return;
      window.history.pushState(window.history.state, "", window.location.href);
      setAttempt({ kind: "back" });
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank") return;
      const url = new URL(anchor.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname)
        return;
      event.preventDefault();
      event.stopPropagation();
      setAttempt({ kind: "link", href: `${url.pathname}${url.search}${url.hash}` });
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("popstate", onPopState);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("popstate", onPopState);
      document.removeEventListener("click", onClick, true);
    };
  }, [active]);

  return {
    open: attempt !== null,
    stay: () => setAttempt(null),
    leave: () => {
      const target = attempt;
      setAttempt(null);
      if (target === null) return;
      leaving.current = true;
      if (target.kind === "link") {
        // The link takes the guard's entry's place.
        router.replace(target.href);
        return;
      }
      // The guard's own entry, then the page's: two steps back to where Back was going.
      window.history.go(-2);
    },
    /** The secret is put away: the guard's entry goes, leaving the person on the page. */
    release: () => {
      leaving.current = true;
      window.history.back();
    },
  };
}

/**
 * The secret, once: where it goes, a copy button and the one way to put it away. Under it, a
 * call to try the key with, when the key holds a read it can make.
 */
export function ApiKeyReveal({
  secret,
  grants,
  apiBaseUrl,
  onSaved,
}: {
  secret: string;
  grants: readonly Action[];
  /** The API's public address; null leaves the try-it call out. */
  apiBaseUrl: string | null;
  onSaved: () => void;
}) {
  const t = useTranslations();
  const [keyCopied, copyKey] = useCopied();
  const [commandCopied, copyCommand] = useCopied();
  const guard = useLeaveGuard(true);
  const path = tryPath(grants);
  const command =
    path && apiBaseUrl
      ? `curl ${apiBaseUrl}${path} \\\n  -H "Authorization: Bearer $${API_KEY_ENV_NAME}"`
      : null;

  return (
    <>
      <div className="flex flex-col gap-3" data-api-key-reveal>
        <div className="flex items-center gap-4 rounded-card bg-surface-tile px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-meta text-secondary">{API_KEY_ENV_NAME}</p>
            <p className="mt-1 break-all font-mono text-field text-primary" data-api-key-secret>
              {secret}
            </p>
          </div>
          <Button onClick={() => copyKey(secret)} iconLeft={<CopyIcon className="size-4" />}>
            {keyCopied ? t("DashboardCustody.copied") : t("DashboardCustody.copyValue")}
          </Button>
        </div>
        <p className="text-meta text-secondary">
          <span className="font-medium text-primary">
            {t("DashboardCustody.apiKeyPage.shownOnce")}
          </span>{" "}
          {t("DashboardCustody.apiKeyPage.hashOnly")}
        </p>
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              guard.release();
              onSaved();
            }}
          >
            {t("DashboardCustody.apiKeyPage.savedKey")}
          </Button>
        </div>
      </div>

      {command ? (
        <RecordBlock
          title={t("DashboardCustody.apiKeyPage.tryKey")}
          hint={t("DashboardCustody.apiKeyPage.tryKeyHint")}
        >
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-meta text-secondary">
                {t("DashboardCustody.apiKeyPage.terminal")}
              </span>
              <button
                type="button"
                onClick={() => copyCommand(command)}
                className="inline-flex items-center gap-1.5 text-body text-primary"
              >
                <CopyIcon aria-hidden className="size-4" />
                {commandCopied
                  ? t("DashboardCustody.copied")
                  : t("DashboardCustody.apiKeyPage.copyCommand")}
              </button>
            </div>
            <pre className="overflow-x-auto font-mono text-meta leading-6 text-primary">
              {command}
            </pre>
          </div>
        </RecordBlock>
      ) : null}

      <Modal
        isOpen={guard.open}
        onClose={guard.stay}
        size="sm"
        ariaLabel={t("DashboardCustody.apiKeyPage.leaveTitle")}
      >
        <div className="space-y-4 p-6">
          <h2 className="text-lg font-medium text-primary">
            {t("DashboardCustody.apiKeyPage.leaveTitle")}
          </h2>
          <p className="text-sm leading-6 text-secondary">
            {t("DashboardCustody.apiKeyPage.leaveBody")}
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={guard.leave}>
              {t("DashboardCustody.apiKeyPage.leaveConfirm")}
            </Button>
            <Button onClick={guard.stay}>{t("DashboardCustody.apiKeyPage.stay")}</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
