"use client";

import { ArrowUpRight, ListChecks, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertDialog, Dialog } from "radix-ui";
import { type RefObject, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { WizardStepProgress } from "@/components/ui/wizard-step-progress";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import {
  dismissQuickStart,
  isQuickStartDismissed,
  type QuickStartStep,
  quickStartKey,
  readQuickStart,
  resumeQuickStart,
  setQuickStart,
  subscribeQuickStart,
} from "@/lib/dashboard-quick-start";
import styles from "./dashboard-quick-start.module.css";

const serverSnapshot = () => null;
const dialogClassName = `${styles.enter} fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[420px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl border border-border-default bg-surface-raised p-6 text-primary shadow-xl`;
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

function QuickStartSettingsLauncher({
  step,
  expanded,
  launcherRef,
  onResume,
}: {
  step: QuickStartStep | null;
  expanded: boolean;
  launcherRef: RefObject<HTMLButtonElement | null>;
  onResume: () => void;
}) {
  const t = useTranslations();
  const workspace = useDashboardWorkspace();
  const eligible = isQuickStartEligible(workspace);
  let description: string;
  if (workspace.initialQuickStartStep === "done") {
    description = t("Shared.quickStart.settingsComplete");
  } else if (workspace.sdpEnvironment !== "sandbox") {
    description = t("Shared.quickStart.settingsSandbox");
  } else if (!eligible) {
    description = t("Shared.quickStart.settingsUnavailable");
  } else if (!step) {
    description = t("Shared.quickStart.settingsLoading");
  } else if (step === "done") {
    description = t("Shared.quickStart.settingsRestartDescription");
  } else {
    const current = stepCopy[step];
    description = `${t("Shared.quickStart.progress", { current: current.number, total: 3 })} · ${t(current.title)}`;
  }
  return (
    <Card id="onboarding" className="scroll-mt-6">
      <CardHeader>
        <CardTitle>
          <h2>{t("Shared.quickStart.settingsTitle")}</h2>
        </CardTitle>
        <CardDescription>{t("Shared.quickStart.settingsDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-medium">{t("Shared.quickStart.title")}</h3>
          <p className="text-sm text-secondary">{description}</p>
        </div>
        {eligible && step ? (
          <Button variant="secondary" asChild>
            <button
              type="button"
              ref={launcherRef}
              aria-haspopup="dialog"
              aria-expanded={expanded}
              onClick={onResume}
            >
              {t(
                step === "done"
                  ? "Shared.quickStart.settingsRestart"
                  : "Shared.quickStart.settingsContinue"
              )}
            </button>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function DashboardQuickStart({
  collapsed = false,
  variant = "sidebar",
}: {
  collapsed?: boolean;
  variant?: "sidebar" | "settings";
}) {
  const t = useTranslations();
  const workspace = useDashboardWorkspace();
  const { dashboardCacheScope, dashboardAccess, flags, initialQuickStartStep } = workspace;
  const eligible = isQuickStartEligible(workspace);
  const storageKey = quickStartKey(dashboardCacheScope);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [dismissKey, setDismissKey] = useState<string | null>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const step = useSyncExternalStore(
    subscribeQuickStart,
    () => readQuickStart(storageKey, initialQuickStartStep),
    serverSnapshot
  );
  const dismissed = useSyncExternalStore(
    subscribeQuickStart,
    () => isQuickStartDismissed(storageKey),
    () => false
  );
  const canShowGuide = eligible && step && step !== "done" && !dismissed;
  if (variant === "sidebar" && !canShowGuide) return null;

  const activeStep = step && step !== "done" ? step : "api-key";
  const current = stepCopy[activeStep];
  const stepNumber = current.number;
  const isModal = canShowGuide && expandedKey === storageKey;
  const minimize = () => setExpandedKey(null);
  const canCreateWallet = flags.custody && dashboardAccess.capabilities.canManageCustody;
  const title = t(current.title);
  const description = t(current.description);
  const launcherLabel = `${t("Shared.quickStart.title")} · ${stepNumber}/3`;
  const launcher =
    variant === "settings" ? (
      <QuickStartSettingsLauncher
        step={step}
        expanded={Boolean(isModal)}
        launcherRef={launcherRef}
        onResume={() => {
          resumeQuickStart(storageKey);
          setExpandedKey(storageKey);
        }}
      />
    ) : (
      <aside
        aria-label={t("Shared.quickStart.title")}
        data-quick-start-sidebar
        className="relative shrink-0 rounded-xl border border-border-default bg-fill-subtle text-primary"
      >
        <button
          type="button"
          aria-label={launcherLabel}
          aria-haspopup="dialog"
          aria-expanded={Boolean(isModal)}
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
          <AlertDialog.Root
            open={dismissKey === storageKey}
            onOpenChange={(open) => setDismissKey(open ? storageKey : null)}
          >
            <AlertDialog.Trigger asChild>
              <button
                type="button"
                aria-label={t("Shared.quickStart.skip")}
                title={t("Shared.quickStart.skip")}
                className="absolute right-1 top-1 flex size-8 items-center justify-center rounded-lg text-tertiary hover:bg-fill hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </AlertDialog.Trigger>
            <AlertDialog.Portal>
              <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
              <AlertDialog.Content className={dialogClassName}>
                <AlertDialog.Title className="text-base font-medium">
                  {t("Shared.quickStart.dismissTitle")}
                </AlertDialog.Title>
                <AlertDialog.Description className="mt-2 text-sm leading-5 text-secondary">
                  {t("Shared.quickStart.dismissDescription")}
                </AlertDialog.Description>
                <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <AlertDialog.Cancel asChild>
                    <Button variant="secondary">{t("Shared.quickStart.dismissCancel")}</Button>
                  </AlertDialog.Cancel>
                  <AlertDialog.Action asChild>
                    <Button onClick={() => dismissQuickStart(storageKey)}>
                      {t("Shared.quickStart.dismissConfirm")}
                    </Button>
                  </AlertDialog.Action>
                </div>
              </AlertDialog.Content>
            </AlertDialog.Portal>
          </AlertDialog.Root>
        )}
      </aside>
    );
  if (!isModal) return launcher;

  const content = (
    <>
      <div className="flex items-center justify-between gap-3">
        <WizardStepProgress
          currentStep={stepNumber - 1}
          progressLabel={`${t("Shared.quickStart.progress", { current: stepNumber, total: 3 })}${step === "wallet" ? ` · ${t("Shared.quickStart.optional")}` : ""}`}
          steps={Object.values(stepCopy).map((step) => t(step.title))}
          className="min-w-0 shrink flex-wrap gap-x-3 gap-y-2"
        />
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
      <h2 className="mt-4 text-base font-medium" aria-live="polite">
        {title}
      </h2>
      <p className="mt-2 text-sm leading-5 text-secondary">{description}</p>
      <div className="mt-4">
        <StepAction
          step={activeStep}
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
      <div className="mt-4 flex justify-end">
        <Button onClick={minimize}>{t("Shared.quickStart.later")}</Button>
      </div>
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
            className={dialogClassName}
          >
            <Dialog.Title className="sr-only">{t("Shared.quickStart.title")}</Dialog.Title>
            {content}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
