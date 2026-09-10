"use client";

import { ArrowUpRight, ChevronDown, ChevronUp, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Dialog } from "radix-ui";
import { useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import {
  quickStartKey,
  quickStartLayout,
  readQuickStart,
  readQuickStartPlacement,
  setQuickStart,
  setQuickStartPlacement,
  subscribeQuickStart,
} from "@/lib/dashboard-quick-start";
import styles from "./dashboard-quick-start.module.css";

const serverSnapshot = () => null;
const stepCopy = {
  "api-key": {
    number: 1,
    next: "wallet",
    href: "/dashboard/api-keys/new",
    action: "Shared.quickStart.apiKeyTitle",
    skip: "Shared.quickStart.haveApiKey",
    title: "Shared.quickStart.apiKeyTitle",
    description: "Shared.quickStart.apiKeyDescription",
  },
  wallet: {
    number: 2,
    next: "faucet",
    href: "/dashboard/wallets/setup",
    action: "Shared.quickStart.walletTitle",
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

export function DashboardQuickStart({ docked = false }: { docked?: boolean }) {
  const t = useTranslations();
  const workspace = useDashboardWorkspace();
  const { dashboardCacheScope, dashboardAccess, flags, initialQuickStartStep } = workspace;
  const eligible = isQuickStartEligible(workspace);
  const pathname = usePathname();
  const storageKey = quickStartKey(dashboardCacheScope);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const step = useSyncExternalStore(
    subscribeQuickStart,
    () => readQuickStart(storageKey, initialQuickStartStep),
    serverSnapshot
  );
  const placement = useSyncExternalStore(
    subscribeQuickStart,
    () => readQuickStartPlacement(storageKey),
    serverSnapshot
  );
  if (!eligible || !step || step === "done") return null;

  const current = stepCopy[step];
  const stepNumber = current.number;
  const { isModal, isRight, isCollapsed } = quickStartLayout(
    placement,
    pathname,
    docked,
    expandedKey === storageKey
  );
  const position = isRight ? "right-4" : "left-4";
  const minimize = () => {
    setQuickStartPlacement(storageKey, isRight ? "right-collapsed" : "left");
    setExpandedKey(null);
  };
  const followAction = () => {
    setQuickStartPlacement(storageKey, "right");
    setExpandedKey(null);
  };
  const launcher = (
    <aside
      aria-label={t("Shared.quickStart.title")}
      data-quick-start-docked={docked || undefined}
      className={
        docked
          ? "flex shrink-0 justify-end border-t border-border-subtle px-4 py-2 md:px-6"
          : `${styles.enter} ${position} fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] z-30 flex max-w-[calc(100vw-2rem)] items-center rounded-full border border-border-default bg-surface-raised p-1 text-primary shadow-sm md:bottom-4`
      }
    >
      <button
        type="button"
        aria-expanded={isModal}
        ref={launcherRef}
        onClick={() => setExpandedKey(storageKey)}
        className="flex min-h-9 items-center gap-2 rounded-full px-3 text-sm hover:bg-fill focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {t("Shared.quickStart.title")} <span className="text-xs text-tertiary">{stepNumber}/3</span>
        <ChevronUp className="size-4 text-tertiary" aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => setQuickStart(storageKey, "done")}
        aria-label={t("Shared.quickStart.skip")}
        className="flex size-9 items-center justify-center rounded-full text-tertiary hover:bg-fill hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <X className="size-4" aria-hidden />
      </button>
    </aside>
  );
  if (!isModal && (docked || isCollapsed)) return launcher;
  const canCreateWallet = flags.custody && dashboardAccess.capabilities.canManageCustody;
  const title = t(current.title);
  const description = t(current.description);

  const content = (
    <>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-tertiary">
          {t("Shared.quickStart.progress", { current: stepNumber, total: 3 })}
          {step === "wallet" ? ` · ${t("Shared.quickStart.optional")}` : null}
        </p>
        <div className="flex items-center">
          <button
            type="button"
            aria-expanded={true}
            aria-label={t("Shared.quickStart.minimize")}
            onClick={minimize}
            className="-mt-2 flex size-9 shrink-0 items-center justify-center rounded-full text-tertiary hover:bg-fill hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <ChevronDown className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setQuickStart(storageKey, "done")}
            aria-label={t("Shared.quickStart.skip")}
            className="-mr-2 -mt-2 flex size-9 shrink-0 items-center justify-center rounded-full text-tertiary hover:bg-fill hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
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
          onFollow={followAction}
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
      {isModal ? (
        <Button variant="ghost" className="mt-2 w-full" onClick={minimize}>
          {t("Shared.quickStart.later")}
        </Button>
      ) : null}
    </>
  );
  if (isModal) {
    return (
      <>
        {docked ? launcher : null}
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
  return (
    <aside
      aria-label={t("Shared.quickStart.title")}
      className={`${styles.enter} ${position} fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] z-30 max-h-[70dvh] w-[320px] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-3xl border border-border-default bg-surface-raised p-5 text-primary shadow-xl md:bottom-4`}
    >
      {content}
    </aside>
  );
}
