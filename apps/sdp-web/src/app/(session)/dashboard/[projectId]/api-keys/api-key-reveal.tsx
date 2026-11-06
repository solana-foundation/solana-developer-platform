"use client";

import { type Action, grantsCoverAction } from "@sdp/types/actions";
import { Button } from "@sdp/ui/button";
import { Modal } from "@sdp/ui/modal";
import { CopyIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
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

/**
 * Holds the page while the secret is unsaved: closing the tab asks the browser's question, and
 * a link inside the dashboard asks ours, since the secret cannot be shown again.
 */
function useLeaveGuard(active: boolean): {
  pendingHref: string | null;
  stay: () => void;
  leave: () => void;
} {
  const router = useRouter();
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
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
      setPendingHref(`${url.pathname}${url.search}${url.hash}`);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [active]);

  return {
    pendingHref,
    stay: () => setPendingHref(null),
    leave: () => {
      const target = pendingHref;
      setPendingHref(null);
      if (target) router.push(target);
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
          <Button variant="outline" size="sm" onClick={onSaved}>
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
        isOpen={guard.pendingHref !== null}
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
