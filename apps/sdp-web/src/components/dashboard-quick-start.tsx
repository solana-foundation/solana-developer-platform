"use client";

import { ArrowUpRight, ListChecks, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Dialog } from "radix-ui";
import { useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import {
  quickStartKey,
  readQuickStart,
  setQuickStart,
  subscribeQuickStart,
} from "@/lib/dashboard-quick-start";
import styles from "./dashboard-quick-start.module.css";

const serverSnapshot = () => null;
const stepCopy = {
  "api-key": {
    number: 1,
    next: "wallet",
    href: "/dashboard/api-keys/new",
    action: "Shared.quickStart.apiKeyAction",
    skip: "Shared.quickStart.haveApiKey",
    title: "Shared.quickStart.apiKeyTitle",
    description: "Shared.quickStart.apiKeyDescription",
  },
  wallet: {
    number: 2,
    next: "faucet",
    href: "/dashboard/wallets/setup",
    action: "Shared.quickStart.walletAction",
    skip: "Shared.quickStart.skipWallet",
    title: "Shared.quickStart.walletTitle",
    description: "Shared.quickStart.walletDescription",
  },
  faucet: {
    number: 3,
    next: "done",
    href: "https://faucet.circle.com/",
    action: "Shared.quickStart.openFaucet",
    skip: "Shared.quickStart.finish",
    title: "Shared.quickStart.faucetTitle",
    description: "Shared.quickStart.faucetDescription",
  },
} as const;

function StepAction({
  step,
  onFollow,
  onBack,
  canCreateWallet,
}: {
  step: keyof typeof stepCopy;
  onFollow: () => void;
  onBack: () => void;
  canCreateWallet: boolean;
}) {
  const t = useTranslations();
  const pathname = usePathname();
  const current = stepCopy[step];
  if (pathname === current.href) {
    return (
      <Button className="w-full rounded-full" onClick={onBack}>
        {t("Shared.quickStart.backToForm")}
      </Button>
    );
  }
  if (step === "wallet" && !canCreateWallet) return null;
  return (
    <Button asChild className="w-full rounded-full">
      <Link
        onClick={onFollow}
        href={current.href}
        target={step === "faucet" ? "_blank" : undefined}
        rel={step === "faucet" ? "noopener noreferrer" : undefined}
      >
        {t(current.action)}
        {step === "faucet" ? <ArrowUpRight className="size-4" aria-hidden /> : null}
      </Link>
    </Button>
  );
}

function isQuickStartEligible(workspace: ReturnType<typeof useDashboardWorkspace>) {
  return Boolean(
    workspace.initialQuickStartStep &&
      workspace.initialQuickStartStep !== "done" &&
      workspace.dashboardCacheScope.orgId &&
      workspace.selectedProjectId &&
      workspace.sdpEnvironment === "sandbox" &&
      workspace.dashboardAccess.capabilities.canManageApiKeys
  );
}

export function DashboardQuickStart({ collapsed = false }: { collapsed?: boolean }) {
  const t = useTranslations();
  const workspace = useDashboardWorkspace();
  const { dashboardCacheScope, dashboardAccess, flags, initialQuickStartStep } = workspace;
  const eligible = isQuickStartEligible(workspace);
  const storageKey = quickStartKey(dashboardCacheScope);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const step = useSyncExternalStore(
    subscribeQuickStart,
    () => readQuickStart(storageKey, initialQuickStartStep),
    serverSnapshot
  );
  if (!eligible || !step || step === "done") return null;

  const current = stepCopy[step];
  const stepNumber = current.number;
  const isModal = expandedKey === storageKey;
  const minimize = () => setExpandedKey(null);
  const canCreateWallet = flags.custody && dashboardAccess.capabilities.canManageCustody;
  const title = t(current.title);
  const description = t(current.description);
  const launcherLabel = `${t("Shared.quickStart.title")} · ${stepNumber}/3`;
  const launcher = (
    <aside
      aria-label={t("Shared.quickStart.title")}
      data-quick-start-sidebar
      className="relative shrink-0 rounded-xl border border-border-default bg-fill-subtle text-primary"
    >
      <button
        type="button"
        aria-label={launcherLabel}
        aria-haspopup="dialog"
        aria-expanded={isModal}
        title={collapsed ? launcherLabel : undefined}
        ref={launcherRef}
        onClick={() => setExpandedKey(storageKey)}
        className={
          collapsed
            ? "flex h-10 w-full items-center justify-center rounded-xl hover:bg-fill focus-visible:outline-2 focus-visible:outline-offset-2"
            : "block w-full rounded-xl p-3 text-left hover:bg-fill focus-visible:outline-2 focus-visible:outline-offset-2"
        }
      >
        {collapsed ? (
          <ListChecks className="size-4 text-secondary" aria-hidden />
        ) : (
          <>
            <span className="block pr-6 text-sm font-medium">{t("Shared.quickStart.title")}</span>
            <span className="mt-3 flex items-center justify-between gap-3 text-xs text-secondary">
              <span className="truncate">{title}</span>
              <span className="shrink-0 text-tertiary">{stepNumber}/3</span>
            </span>
            <span
              className="mt-2 block h-1 overflow-hidden rounded-full bg-fill-strong"
              aria-hidden
            >
              <span
                className="block h-full rounded-full bg-primary transition-[width] duration-200 motion-reduce:transition-none"
                style={{ width: `${(stepNumber / 3) * 100}%` }}
              />
            </span>
          </>
        )}
      </button>
      {collapsed ? null : (
        <button
          type="button"
          onClick={() => setQuickStart(storageKey, "done")}
          aria-label={t("Shared.quickStart.skip")}
          title={t("Shared.quickStart.skip")}
          className="absolute right-1 top-1 flex size-8 items-center justify-center rounded-lg text-tertiary hover:bg-fill hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </aside>
  );
  if (!isModal) return launcher;

  const content = (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium text-secondary">{t("Shared.quickStart.title")}</p>
          <p className="text-xs text-tertiary">
            {t("Shared.quickStart.progress", { current: stepNumber, total: 3 })}
            {step === "wallet" ? ` · ${t("Shared.quickStart.optional")}` : null}
          </p>
        </div>
        <button
          type="button"
          onClick={minimize}
          aria-label={t("Shared.quickStart.minimize")}
          title={t("Shared.quickStart.minimize")}
          className="-mr-2 -mt-2 flex size-9 shrink-0 items-center justify-center rounded-full text-tertiary hover:bg-fill hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <h2 className="mt-1 text-base font-medium" aria-live="polite">
        {title}
      </h2>
      <p className="mt-2 text-sm leading-5 text-secondary">{description}</p>
      <div
        role="progressbar"
        aria-label={t("Shared.quickStart.title")}
        aria-valuemin={1}
        aria-valuemax={3}
        aria-valuenow={stepNumber}
        aria-valuetext={t("Shared.quickStart.progress", { current: stepNumber, total: 3 })}
        className="mt-5 h-1.5 overflow-hidden rounded-full bg-fill"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-200 motion-reduce:transition-none"
          style={{ width: `${(stepNumber / 3) * 100}%` }}
        />
      </div>
      <div className="mt-4">
        <StepAction
          step={step}
          onFollow={minimize}
          onBack={minimize}
          canCreateWallet={canCreateWallet}
        />
        <button
          type="button"
          onClick={() => setQuickStart(storageKey, current.next)}
          className="mt-2 min-h-9 w-full rounded-full text-xs text-tertiary hover:bg-fill hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {t(current.skip)}
        </button>
      </div>
      <Button variant="ghost" className="mt-2 w-full" onClick={minimize}>
        {t("Shared.quickStart.later")}
      </Button>
    </>
  );
  return (
    <>
      {launcher}
      <Dialog.Root
        open
        onOpenChange={(open) => {
          if (!open) minimize();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <Dialog.Content
            onCloseAutoFocus={(event) => {
              if (launcherRef.current) {
                event.preventDefault();
                launcherRef.current.focus();
              }
            }}
            aria-describedby={undefined}
            className={`${styles.enter} fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[420px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl border border-border-default bg-surface-raised p-6 text-primary shadow-xl`}
          >
            <Dialog.Title className="sr-only">{t("Shared.quickStart.title")}</Dialog.Title>
            {content}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
