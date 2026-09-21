"use client";

import type { EarnVaultPosition, EarnVaultWithdrawal, SdpEnvironment } from "@sdp/types";
import { ArrowRightIcon, Clock3Icon, Loader2Icon, type LucideIcon, ZapIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useLocale, useTranslations } from "@/i18n/provider";
import { formatDurationSeconds, shortenMarketAddress } from "./earn-format";
import { fetchEarnVaultWithdrawalOptions } from "./earn-program-data";
import { EarnVaultAsyncWithdrawModal } from "./earn-vault-async-withdraw-modal";
import {
  type EarnVaultAsyncWithdrawalEvent,
  earnVaultAsyncWithdrawalRoute,
} from "./earn-vault-async-withdrawal";
import { EarnVaultWithdrawModal } from "./earn-vault-withdraw-modal";

interface EarnVaultExitModalProps {
  environment: SdpEnvironment;
  onClose: () => void;
  onMovementUpdated?: (withdrawal: EarnVaultWithdrawal) => void;
  onAsyncRequest?: (event: EarnVaultAsyncWithdrawalEvent) => void;
  onAsyncRequestSettled?: (event: EarnVaultAsyncWithdrawalEvent) => void;
  onWithdrawn?: (
    withdrawal: EarnVaultWithdrawal,
    intent: { amount: string; projectBalance: boolean }
  ) => void;
  position: EarnVaultPosition;
  projectId: string | null;
}

type RouteChoice = "instant" | "async";

type ExitOptions = Awaited<ReturnType<typeof fetchEarnVaultWithdrawalOptions>> | undefined;

type ExitOptionsValue = Extract<NonNullable<ExitOptions>, { kind: "ready" }>["value"];

/**
 * A single-route position never shows the chooser: derive the forced choice
 * during render instead of adjusting state after the options prop changes.
 */
function autoRouteChoice(
  asyncRoute: ReturnType<typeof earnVaultAsyncWithdrawalRoute>,
  ready: ExitOptionsValue | null
): RouteChoice | null {
  if (!ready) return null;
  if (ready.instant && !asyncRoute) return "instant";
  if (!ready.instant && asyncRoute) return "async";
  return null;
}

/**
 * Reads provider withdrawal capabilities once per position, with manual retry.
 * A retry reruns this same effect instead of issuing its own unguarded fetch,
 * so every attempt — initial or retried — owns one AbortController: the
 * cleanup aborts the attempt a retry or unmount supersedes, and the abort
 * guard discards its late answer rather than letting it win by outliving
 * newer state.
 */
function useEarnVaultExitOptions(positionId: string) {
  const [options, setOptions] = useState<ExitOptions>(undefined);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is a trigger-only dep — a retry bumps it to re-run this effect, whose cleanup aborts the attempt it supersedes.
  useEffect(() => {
    const controller = new AbortController();
    void fetchEarnVaultWithdrawalOptions(positionId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setOptions(result);
    });
    return () => controller.abort();
  }, [positionId, attempt]);

  const retry = () => {
    setOptions(undefined);
    setAttempt((current) => current + 1);
  };

  return { options, retry };
}

function RouteOption({
  description,
  icon: Icon,
  onClick,
  title,
}: {
  description: string;
  icon: LucideIcon;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      className="group w-full rounded-2xl border border-border-default bg-surface-raised px-5 py-4 text-left transition-colors hover:border-border-strong hover:bg-fill-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      onClick={onClick}
      type="button"
    >
      <span className="flex items-center gap-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-fill-subtle text-primary transition-colors group-hover:bg-fill-strong">
          <Icon aria-hidden="true" className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-primary">{title}</span>
          <span className="mt-0.5 block text-sm leading-5 text-secondary">{description}</span>
        </span>
        <ArrowRightIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-tertiary transition-transform group-hover:translate-x-0.5"
        />
      </span>
    </button>
  );
}

function ExitRouteOptions({
  asyncRoute,
  onChoose,
  ready,
}: {
  asyncRoute: ReturnType<typeof earnVaultAsyncWithdrawalRoute>;
  onChoose: (choice: RouteChoice) => void;
  ready: ExitOptionsValue | null;
}) {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <>
      <p className="mt-2 text-sm leading-5 text-secondary">
        {t("DashboardEarn.exitRoute.description")}
      </p>
      <div className="mt-5 grid gap-3">
        {ready?.instant ? (
          <RouteOption
            description={t("DashboardEarn.exitRoute.instantDescription")}
            icon={ZapIcon}
            onClick={() => onChoose("instant")}
            title={t("DashboardEarn.exitRoute.instantTitle")}
          />
        ) : null}
        {asyncRoute ? (
          <RouteOption
            description={t(
              asyncRoute.summary.messageKey,
              asyncRoute.kind === "queue"
                ? {
                    duration:
                      formatDurationSeconds(asyncRoute.waitSeconds, locale) ??
                      t("DashboardEarn.unavailable"),
                  }
                : asyncRoute.summary.values
            )}
            icon={Clock3Icon}
            onClick={() => onChoose("async")}
            title={t(asyncRoute.summary.titleKey)}
          />
        ) : null}
      </div>
    </>
  );
}

function ExitRouteChooser({
  asyncRoute,
  onClose,
  onChoose,
  options,
  position,
  retry,
}: {
  asyncRoute: ReturnType<typeof earnVaultAsyncWithdrawalRoute>;
  onClose: () => void;
  onChoose: (choice: RouteChoice) => void;
  options: ExitOptions;
  position: EarnVaultPosition;
  retry: () => void;
}) {
  const t = useTranslations();
  const ready = options?.kind === "ready" ? options.value : null;
  const positionName = position.label || shortenMarketAddress(position.providerReference);
  const modalLabel = t("DashboardEarn.exitRoute.title", { position: positionName });

  let body: ReactNode;
  if (!options) {
    body = (
      <div className="mt-5 flex items-center gap-2 text-sm text-secondary" role="status">
        <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
        {t("DashboardEarn.exitRoute.loading")}
      </div>
    );
  } else if (options.kind === "unavailable") {
    body = (
      <div className="mt-5 rounded-xl border border-warning-border bg-warning-bg p-4">
        <p className="text-sm text-warning">{t("DashboardEarn.exitRoute.unavailable")}</p>
        <Button className="mt-3" onClick={retry} size="sm" variant="outline">
          {t("DashboardEarn.exitRoute.retry")}
        </Button>
      </div>
    );
  } else if (!ready?.instant && !asyncRoute) {
    body = <p className="mt-5 text-sm text-warning">{t("DashboardEarn.exitRoute.none")}</p>;
  } else {
    body = <ExitRouteOptions asyncRoute={asyncRoute} onChoose={onChoose} ready={ready} />;
  }

  return (
    <Modal isOpen ariaLabel={modalLabel} onClose={onClose} size="md">
      <div className="p-6">
        <h2
          className="pr-8 text-lg font-medium leading-6 text-primary outline-none"
          data-modal-focus-target
          tabIndex={-1}
        >
          {modalLabel}
        </h2>
        {body}
      </div>
    </Modal>
  );
}

/**
 * Resolves provider capabilities first and makes the user choose when multiple
 * routes exist. Atomic payout, provider-settled redemption, and a long-lived
 * queue request are never interchangeable outcomes, so this component never
 * applies a preference or fallback. Mechanism dispatch stays provider-neutral.
 */
export function EarnVaultExitModal(props: EarnVaultExitModalProps) {
  const { position } = props;
  const { options, retry } = useEarnVaultExitOptions(position.id);
  const [choice, setChoice] = useState<RouteChoice | null>(null);
  const ready = options?.kind === "ready" ? options.value : null;
  const asyncRoute = ready ? earnVaultAsyncWithdrawalRoute(ready) : null;
  const activeChoice = choice ?? autoRouteChoice(asyncRoute, ready);

  if (activeChoice === "instant") {
    return (
      <EarnVaultWithdrawModal
        environment={props.environment}
        onClose={props.onClose}
        onMovementUpdated={props.onMovementUpdated}
        onWithdrawn={props.onWithdrawn}
        position={position}
        projectId={props.projectId}
      />
    );
  }

  if (activeChoice === "async" && asyncRoute) {
    return (
      <EarnVaultAsyncWithdrawModal
        environment={props.environment}
        onClose={props.onClose}
        onMovementUpdated={props.onMovementUpdated}
        onRequested={props.onAsyncRequest}
        onSettled={props.onAsyncRequestSettled}
        onWithdrawn={props.onWithdrawn}
        position={position}
        projectId={props.projectId}
        route={asyncRoute}
      />
    );
  }

  return (
    <ExitRouteChooser
      asyncRoute={asyncRoute}
      onClose={props.onClose}
      onChoose={setChoice}
      options={options}
      position={position}
      retry={retry}
    />
  );
}
