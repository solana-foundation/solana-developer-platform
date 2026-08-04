"use client";

import {
  type EarnPortfolioDeposit,
  type EarnPortfolioToken,
  type EarnPortfolioWalletStatus,
  type EarnStrategy,
  earnCuratorLabel,
} from "@sdp/types";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  LandmarkIcon,
  Loader2Icon,
  PieChartIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ChangeEvent, type ReactNode, useId, useLayoutEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { WizardFrame } from "@/components/wizard-frame";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useDashboardRouter } from "@/lib/use-dashboard-router";
import { cn } from "@/lib/utils";
import { formatApy, formatUsd, tokenSymbol } from "../earn-format";
import {
  EARN_PORTFOLIO_PROVIDER,
  upsertEarnProgram,
  useEarnProgram,
  useEarnProgramDeposits,
  useEarnStrategies,
} from "../earn-program-data";
import {
  buildCuratorPrograms,
  curatorApyRange,
  curatorMonogram,
  curatorProfileKey,
  type EarnCuratorProgram,
  programAssets,
  strategyCurator,
  strategyRiskTier,
  useLiquidityLabel,
} from "../earn-program-presentation";
import {
  buildAllocationInput,
  type CuratorTokenGroup,
  curatorTokenGroups,
  defaultWeightInputs,
  type ParsedAllocation,
  parseAllocation,
  type WeightInputs,
  weightedApy,
} from "./earn-setup-model";

type SetupStep = "curator" | "allocation" | "review";

const STEP_ORDER: readonly SetupStep[] = ["curator", "allocation", "review"];

const STEP_META: Record<SetupStep, { title: MessageKey; description: MessageKey }> = {
  curator: {
    title: "DashboardEarn.setup.curatorsTitle",
    description: "DashboardEarn.setup.curatorsDescription",
  },
  allocation: {
    title: "DashboardEarn.setup.allocationTitle",
    description: "DashboardEarn.setup.allocationDescription",
  },
  review: {
    title: "DashboardEarn.setup.reviewTitle",
    description: "DashboardEarn.setup.reviewDescription",
  },
};

type WeightsByToken = Partial<Record<EarnPortfolioToken, WeightInputs>>;
type ParsedByToken = Partial<Record<EarnPortfolioToken, ParsedAllocation>>;

const DEPOSIT_STATUS_BADGES: Record<
  EarnPortfolioDeposit["status"],
  { variant: "success" | "warning" | "danger"; key: MessageKey }
> = {
  processing: { variant: "warning", key: "DashboardEarn.setup.depositStatusProcessing" },
  completed: { variant: "success", key: "DashboardEarn.setup.depositStatusCompleted" },
  failed: { variant: "danger", key: "DashboardEarn.setup.depositStatusFailed" },
};

const WALLET_STATUS_BADGES: Record<
  EarnPortfolioWalletStatus,
  { variant: "success" | "warning" | "danger"; key: MessageKey }
> = {
  creating: { variant: "warning", key: "DashboardEarn.setup.walletStatus.creating" },
  ready: { variant: "success", key: "DashboardEarn.setup.walletStatus.ready" },
  busy: { variant: "warning", key: "DashboardEarn.setup.walletStatus.busy" },
  failed: { variant: "danger", key: "DashboardEarn.setup.walletStatus.failed" },
};

const SKELETON_ITEM_IDS = ["one", "two", "three"];

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

function SelectionMark({ selected }: { selected: boolean }) {
  return (
    <span
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
        selected
          ? "border-primary bg-primary text-on-primary"
          : "border-border-strong bg-surface-raised text-transparent"
      )}
      aria-hidden="true"
    >
      <CheckIcon className="size-3" />
    </span>
  );
}

function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border-subtle py-2.5 text-sm last:border-b-0">
      {/* Label wraps before the value does, so short values like an APY range
          never split across lines at their separator. */}
      <span className="min-w-0 text-secondary">{label}</span>
      <span className="shrink-0 whitespace-nowrap text-right text-primary">{value}</span>
    </div>
  );
}

function CuratorFact({ label, value }: { label: string; value: string }) {
  return (
    <span className="min-w-0 rounded-xl bg-fill-subtle px-3 py-2.5">
      <span className="block text-[11px] font-medium tracking-[0.04em] text-tertiary uppercase">
        {label}
      </span>
      <span className="mt-1 block text-[13px] leading-5 font-medium text-primary">{value}</span>
    </span>
  );
}

function UnderlyingHoldings({ strategies }: { strategies: readonly EarnStrategy[] }) {
  const t = useTranslations();
  const liquidityLabel = useLiquidityLabel();

  return (
    <div className="divide-y divide-border-subtle">
      {strategies.map((strategy) => {
        const tier = strategyRiskTier(strategy);
        return (
          <div
            key={strategy.id}
            className="grid gap-3 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-primary">{strategy.name}</p>
              <p className="mt-1 text-xs leading-5 text-tertiary">
                {[
                  t(`DashboardEarn.source.${strategy.sourceKind}`),
                  tier ? t(`DashboardEarn.risk.${tier}`) : null,
                  liquidityLabel(strategy),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {strategy.depositMints.map((mint) => (
                  <span
                    key={mint}
                    className="rounded-md bg-fill px-2 py-1 text-[11px] font-medium text-secondary"
                  >
                    {tokenSymbol(mint)}
                  </span>
                ))}
              </div>
            </div>
            <p className="text-left text-sm font-medium text-primary sm:text-right">
              {formatApy(strategy.currentApy)}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function PortfolioDisclosure({ strategies }: { strategies: readonly EarnStrategy[] }) {
  const t = useTranslations();
  const reduceMotion = useReducedMotion();
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((current) => !current)}
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-1 py-2 text-left text-[13px] font-medium text-secondary transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
      >
        <span>
          {t(
            expanded
              ? "DashboardEarn.setup.hideAvailableOpportunities"
              : "DashboardEarn.setup.viewAvailableOpportunities"
          )}
        </span>
        <ChevronDownIcon
          className={cn(
            "size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none",
            expanded && "rotate-180"
          )}
        />
      </button>
      <div id={contentId}>
        <AnimatePresence initial={false}>
          {expanded ? (
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.18, ease: "easeOut" }}
              className="overflow-hidden"
            >
              <div className="border-t border-border-subtle pt-3 pb-1">
                <p className="mb-3 text-xs leading-5 text-tertiary">
                  {t("DashboardEarn.setup.opportunityTransparency")}
                </p>
                <UnderlyingHoldings strategies={strategies} />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}

function CuratorCard({
  program,
  selected,
  onSelect,
}: {
  program: EarnCuratorProgram;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useTranslations();
  const inputId = `earn-curator-${program.id}`;
  const nameId = `${inputId}-name`;
  const headlineId = `${inputId}-headline`;
  const descriptionId = `${inputId}-description`;
  const curatorName = earnCuratorLabel(program.id);

  return (
    <article
      className={cn(
        "rounded-2xl border bg-surface-raised transition-[border-color,background-color,box-shadow] duration-200 ease-out motion-reduce:transition-none",
        selected
          ? "border-primary bg-fill-subtle shadow-sm"
          : "border-border-default hover:border-border-strong"
      )}
    >
      <input
        id={inputId}
        className="peer sr-only"
        type="radio"
        name="earn-curator"
        value={program.id}
        checked={selected}
        aria-labelledby={`${nameId} ${headlineId}`}
        aria-describedby={descriptionId}
        onChange={onSelect}
      />
      <label
        htmlFor={inputId}
        className="block cursor-pointer rounded-2xl p-4 focus-within:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40 sm:p-5"
      >
        <span className="flex items-start gap-3.5">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border-subtle bg-fill text-sm font-semibold text-primary">
            {curatorMonogram(program.id)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-start justify-between gap-3">
              <span>
                <span
                  id={nameId}
                  className="block text-base font-medium tracking-tight text-primary"
                >
                  {curatorName}
                </span>
                <span id={headlineId} className="mt-1 block text-sm font-medium text-secondary">
                  {t(curatorProfileKey(program.id, "headline"))}
                </span>
              </span>
              <SelectionMark selected={selected} />
            </span>
            <span
              id={descriptionId}
              className="mt-3 block max-w-2xl text-[13px] leading-5 text-secondary"
            >
              {t(curatorProfileKey(program.id, "description"))}
            </span>
            <span className="mt-2 block text-[13px] leading-5 text-primary">
              <span className="font-medium">{t("DashboardEarn.setup.bestFor")}</span>{" "}
              {t(curatorProfileKey(program.id, "bestFor"))}
            </span>
          </span>
        </span>

        <span className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
          <CuratorFact
            label={t("DashboardEarn.setup.indicativeApyRange")}
            value={curatorApyRange(program)}
          />
          <CuratorFact
            label={t("DashboardEarn.setup.riskRange")}
            value={t(curatorProfileKey(program.id, "risk"))}
          />
          <CuratorFact
            label={t("DashboardEarn.setup.liquidity")}
            value={t(curatorProfileKey(program.id, "liquidity"))}
          />
          <CuratorFact
            label={t("DashboardEarn.setup.fundingAssets")}
            value={programAssets(program.strategies).join(", ")}
          />
        </span>
      </label>
      <div className="border-t border-border-subtle px-4 sm:px-5">
        <PortfolioDisclosure strategies={program.strategies} />
      </div>
    </article>
  );
}

function CuratorStep({
  programs,
  isLoading,
  hasError,
  selectedCuratorId,
  onCuratorChange,
}: {
  programs: readonly EarnCuratorProgram[];
  isLoading: boolean;
  hasError: boolean;
  selectedCuratorId: string | null;
  onCuratorChange: (curatorId: string) => void;
}) {
  const t = useTranslations();

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-2xl border border-border-default bg-fill-subtle p-4">
        <ShieldCheckIcon className="mt-0.5 size-5 shrink-0 text-secondary" />
        <div>
          <p className="text-sm font-medium text-primary">
            {t("DashboardEarn.setup.whatCuratorDoesTitle")}
          </p>
          <p className="mt-1 text-[13px] leading-5 text-secondary">
            {t("DashboardEarn.setup.whatCuratorDoesDescription")}
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-3" aria-busy="true">
          {SKELETON_ITEM_IDS.map((id) => (
            <SkeletonBlock key={id} className="h-52 w-full rounded-2xl" />
          ))}
        </div>
      ) : null}

      {hasError ? (
        <p className="rounded-xl border border-border-subtle bg-fill-subtle px-3.5 py-3 text-[13px] leading-5 text-secondary">
          {t("DashboardEarn.overview.curatorsLoadError")}
        </p>
      ) : null}

      {!isLoading && !hasError && programs.length === 0 ? (
        <p className="rounded-xl border border-border-subtle bg-fill-subtle px-3.5 py-3 text-[13px] leading-5 text-secondary">
          {t("DashboardEarn.overview.curatorsEmpty")}
        </p>
      ) : null}

      {programs.length > 0 ? (
        <fieldset className="space-y-3">
          <legend className="sr-only">{t("DashboardEarn.setup.curatorsTitle")}</legend>
          {programs.map((program) => (
            <CuratorCard
              key={program.id}
              program={program}
              selected={program.id === selectedCuratorId}
              onSelect={() => onCuratorChange(program.id)}
            />
          ))}
        </fieldset>
      ) : null}

      <p className="sr-only" role="status" aria-live="polite">
        {selectedCuratorId
          ? t("DashboardEarn.setup.selectedCuratorAnnouncement", {
              curator: earnCuratorLabel(selectedCuratorId),
            })
          : ""}
      </p>
    </div>
  );
}

function AllocationGroupCard({
  group,
  inputs,
  parsed,
  onWeightChange,
  onSplitEvenly,
}: {
  group: CuratorTokenGroup;
  inputs: WeightInputs;
  parsed: ParsedAllocation;
  onWeightChange: (strategyId: string, value: string) => void;
  onSplitEvenly: () => void;
}) {
  const t = useTranslations();
  const liquidityLabel = useLiquidityLabel();
  const errorId = useId();
  const blendedApy =
    parsed.issue === undefined ? weightedApy(group.strategies, parsed.weights) : undefined;

  return (
    <section className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle bg-fill-subtle px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-primary">
            {t("DashboardEarn.setup.allocationGroupTitle", { token: group.token.toUpperCase() })}
          </h3>
          <p className="mt-0.5 text-xs text-tertiary">
            {t("DashboardEarn.setup.percentAllocated", { percent: parsed.totalPct })}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onSplitEvenly}>
          {t("DashboardEarn.setup.splitEvenly")}
        </Button>
      </div>

      <div className="divide-y divide-border-subtle px-4">
        {group.strategies.map((strategy) => (
          <div
            key={strategy.id}
            className="grid gap-3 py-3.5 sm:grid-cols-[minmax(0,1fr)_8.5rem] sm:items-center"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-primary">{strategy.name}</p>
              <p className="mt-0.5 text-xs leading-5 text-tertiary">
                {formatApy(strategy.currentApy)} · {liquidityLabel(strategy)}
              </p>
            </div>
            <Input
              type="number"
              min="0"
              max="100"
              step="0.1"
              inputMode="decimal"
              placeholder="0"
              aria-label={t("DashboardEarn.setup.allocationPercentageLabel", {
                strategy: strategy.name,
              })}
              aria-invalid={parsed.issue !== undefined}
              aria-describedby={parsed.issue !== undefined ? errorId : undefined}
              value={inputs[strategy.id] ?? ""}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                onWeightChange(strategy.id, event.target.value)
              }
              iconRight={<span className="text-xs font-medium">%</span>}
            />
          </div>
        ))}
      </div>

      <div className="flex min-h-11 items-center justify-between gap-4 border-t border-border-subtle px-4 py-2.5">
        {parsed.issue !== undefined ? (
          <p id={errorId} className="text-xs text-error" role="alert">
            {parsed.issue === "malformed"
              ? t("DashboardEarn.setup.allocationWeightsInvalid")
              : t("DashboardEarn.setup.allocationWeightsMustTotal")}
          </p>
        ) : (
          <p className="text-xs text-tertiary">
            {t("DashboardEarn.setup.allocationBlendedApy", {
              apy: formatApy(String(blendedApy ?? 0)),
            })}
          </p>
        )}
      </div>
    </section>
  );
}

function AllocationStep({
  curatorName,
  groups,
  weights,
  parsedByToken,
  onWeightChange,
  onSplitEvenly,
}: {
  curatorName: string;
  groups: readonly CuratorTokenGroup[];
  weights: WeightsByToken;
  parsedByToken: ParsedByToken;
  onWeightChange: (token: EarnPortfolioToken, strategyId: string, value: string) => void;
  onSplitEvenly: (token: EarnPortfolioToken) => void;
}) {
  const t = useTranslations();

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-2xl border border-border-default bg-fill-subtle p-4">
        <PieChartIcon className="mt-0.5 size-5 shrink-0 text-secondary" />
        <p className="text-[13px] leading-5 text-secondary">
          {t("DashboardEarn.setup.allocationHint", { curator: curatorName })}
        </p>
      </div>

      {groups.map((group) => (
        <AllocationGroupCard
          key={group.token}
          group={group}
          inputs={weights[group.token] ?? {}}
          parsed={parsedByToken[group.token] ?? parseAllocation({})}
          onWeightChange={(strategyId, value) => onWeightChange(group.token, strategyId, value)}
          onSplitEvenly={() => onSplitEvenly(group.token)}
        />
      ))}
    </div>
  );
}

function ReviewSection({
  icon,
  title,
  onEdit,
  children,
}: {
  icon: ReactNode;
  title: string;
  onEdit: () => void;
  children: ReactNode;
}) {
  const t = useTranslations();
  return (
    <section className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle bg-fill-subtle px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="text-secondary">{icon}</span>
          <h3 className="text-sm font-medium text-primary">{title}</h3>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t("DashboardEarn.setup.editSection", { section: title })}
          onClick={onEdit}
        >
          {t("DashboardEarn.setup.edit")}
        </Button>
      </div>
      <div className="px-4 py-2">{children}</div>
    </section>
  );
}

function ReviewStep({
  program,
  groups,
  parsedByToken,
  programExists,
  providerUnconfigured,
  submitError,
  onEdit,
}: {
  program: EarnCuratorProgram;
  groups: readonly CuratorTokenGroup[];
  parsedByToken: ParsedByToken;
  programExists: boolean;
  providerUnconfigured: boolean;
  submitError: string | null;
  onEdit: (step: SetupStep) => void;
}) {
  const t = useTranslations();
  const curatorName = earnCuratorLabel(program.id);

  return (
    <div className="space-y-4">
      <ReviewSection
        icon={<ShieldCheckIcon className="size-4" />}
        title={t("DashboardEarn.setup.reviewCurator")}
        onEdit={() => onEdit("curator")}
      >
        <SummaryRow label={t("DashboardEarn.setup.curator")} value={curatorName} />
        <SummaryRow
          label={t("DashboardEarn.setup.managedProgram")}
          value={t(curatorProfileKey(program.id, "headline"))}
        />
        <SummaryRow
          label={t("DashboardEarn.setup.indicativeApyRange")}
          value={curatorApyRange(program)}
        />
        <SummaryRow
          label={t("DashboardEarn.setup.riskRange")}
          value={t(curatorProfileKey(program.id, "risk"))}
        />
        <SummaryRow
          label={t("DashboardEarn.setup.fundingAssets")}
          value={programAssets(program.strategies).join(", ")}
        />
        <div className="border-t border-border-subtle">
          <PortfolioDisclosure strategies={program.strategies} />
        </div>
      </ReviewSection>

      <ReviewSection
        icon={<PieChartIcon className="size-4" />}
        title={t("DashboardEarn.setup.targetAllocation")}
        onEdit={() => onEdit("allocation")}
      >
        {groups.map((group) => {
          const parsed = parsedByToken[group.token];
          return (
            <div key={group.token} className="py-2">
              <p className="text-[11px] font-medium tracking-[0.04em] text-tertiary uppercase">
                {group.token.toUpperCase()}
              </p>
              {group.strategies
                .filter((strategy) => (parsed?.weights[strategy.id] ?? 0) > 0)
                .map((strategy) => (
                  <SummaryRow
                    key={strategy.id}
                    label={strategy.name}
                    value={t("DashboardEarn.setup.targetWeight", {
                      percent: parsed?.weights[strategy.id] ?? 0,
                    })}
                  />
                ))}
              <SummaryRow
                label={t("DashboardEarn.setup.estimatedApy")}
                value={formatApy(String(weightedApy(group.strategies, parsed?.weights ?? {})))}
              />
            </div>
          );
        })}
      </ReviewSection>

      {providerUnconfigured ? (
        <p className="rounded-xl border border-border-subtle bg-fill-subtle px-3.5 py-3 text-[13px] leading-5 text-secondary">
          {t("DashboardEarn.overview.providerNotConfigured")}
        </p>
      ) : (
        <div className="flex items-start gap-3 rounded-2xl border border-border-default bg-fill-subtle p-4">
          <LandmarkIcon className="mt-0.5 size-5 shrink-0 text-secondary" />
          <div>
            <p className="text-sm font-medium text-primary">
              {t(
                programExists
                  ? "DashboardEarn.setup.sharedWalletUpdateTitle"
                  : "DashboardEarn.setup.sharedWalletCreateTitle"
              )}
            </p>
            <p className="mt-1 text-[13px] leading-5 text-secondary">
              {t(
                programExists
                  ? "DashboardEarn.setup.sharedWalletUpdateBody"
                  : "DashboardEarn.setup.sharedWalletCreateBody",
                { curator: curatorName }
              )}
            </p>
          </div>
        </div>
      )}

      {submitError ? (
        <p className="text-sm text-error" role="alert">
          {submitError}
        </p>
      ) : null}

      <p className="text-xs leading-5 text-tertiary">
        {t("DashboardEarn.setup.variableRateDisclosure")}
      </p>
    </div>
  );
}

function ProgramSummaryRail({
  program,
  groups,
  parsedByToken,
  ready,
}: {
  program: EarnCuratorProgram | undefined;
  groups: readonly CuratorTokenGroup[];
  parsedByToken: ParsedByToken;
  ready: boolean;
}) {
  const t = useTranslations();
  return (
    <aside className="hidden lg:block">
      <div className="sticky top-2 overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
        <div className="border-b border-border-subtle bg-fill-subtle px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-primary">
              {t("DashboardEarn.setup.summaryTitle")}
            </h3>
            <Badge variant={ready ? "success" : "default"}>
              {ready ? t("DashboardEarn.setup.ready") : t("DashboardEarn.setup.inProgress")}
            </Badge>
          </div>
        </div>
        <div className="px-4 py-2">
          <SummaryRow
            label={t("DashboardEarn.setup.curator")}
            value={program ? earnCuratorLabel(program.id) : "—"}
          />
          <SummaryRow
            label={t("DashboardEarn.setup.indicativeApyRange")}
            value={curatorApyRange(program)}
          />
          <SummaryRow
            label={t("DashboardEarn.setup.fundingAssets")}
            value={program ? programAssets(program.strategies).join(", ") : "—"}
          />
          {groups.map((group) => (
            <SummaryRow
              key={group.token}
              label={t("DashboardEarn.setup.allocationGroupTitle", {
                token: group.token.toUpperCase(),
              })}
              value={t("DashboardEarn.setup.percentAllocated", {
                percent: parsedByToken[group.token]?.totalPct ?? 0,
              })}
            />
          ))}
        </div>
      </div>
    </aside>
  );
}

function PostSetupFrame({
  eyebrow,
  title,
  description,
  children,
  footer,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-surface-raised">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6" data-earn-post-setup-scroll>
        <div className="mx-auto w-full max-w-5xl py-8">
          <div className="mb-7 min-w-0">
            <p className="text-xs font-semibold tracking-[0.08em] text-tertiary uppercase">
              {eyebrow}
            </p>
            <h2 className="mt-2 text-2xl font-medium tracking-tight text-primary">{title}</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-secondary">{description}</p>
          </div>
          {children}
        </div>
      </div>
      {footer ? (
        <footer className="shrink-0 border-t border-border-default bg-surface-raised/95 px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:px-6">
          <div className="mx-auto w-full max-w-5xl">{footer}</div>
        </footer>
      ) : null}
    </div>
  );
}

function DepositAddressCard({ address }: { address: string }) {
  const t = useTranslations();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="rounded-2xl border border-border-default bg-surface-raised p-5">
      <h3 className="text-sm font-medium text-primary">
        {t("DashboardEarn.setup.depositAddressTitle")}
      </h3>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 break-all rounded-xl border border-border-subtle bg-fill-subtle px-3.5 py-3 text-sm leading-6 text-primary">
          {address}
        </p>
        <Button
          type="button"
          variant="secondary"
          className="shrink-0 self-start sm:self-auto"
          iconLeft={copied ? <CheckIcon /> : <CopyIcon />}
          onClick={copy}
        >
          {copied ? t("DashboardEarn.setup.copied") : t("DashboardEarn.setup.copy")}
        </Button>
      </div>
      <p className="mt-3 text-[13px] leading-5 text-secondary">
        {t("DashboardEarn.setup.depositAddressExplainer")}
      </p>
    </section>
  );
}

function RecentDepositsCard() {
  const t = useTranslations();
  const locale = useLocale();
  const { page, error, isLoading } = useEarnProgramDeposits();
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale]
  );

  return (
    <section className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
      <div className="border-b border-border-subtle bg-fill-subtle px-4 py-3">
        <h3 className="text-sm font-medium text-primary">
          {t("DashboardEarn.setup.recentDepositsTitle")}
        </h3>
      </div>

      {isLoading ? (
        <div className="grid gap-3 p-4" aria-busy="true">
          {SKELETON_ITEM_IDS.map((id) => (
            <SkeletonBlock key={id} className="h-10 w-full rounded-lg" />
          ))}
        </div>
      ) : null}

      {error ? (
        <p className="px-4 py-3 text-[13px] leading-5 text-secondary">
          {t("DashboardEarn.setup.depositsLoadError")}
        </p>
      ) : null}

      {!isLoading && !error && page?.deposits.length === 0 ? (
        <p className="px-4 py-3 text-[13px] leading-5 text-secondary">
          {t("DashboardEarn.setup.depositsEmpty")}
        </p>
      ) : null}

      {page && page.deposits.length > 0 ? (
        <ul className="divide-y divide-border-subtle">
          {page.deposits.map((deposit) => {
            const badge = DEPOSIT_STATUS_BADGES[deposit.status];
            return (
              <li
                key={deposit.id}
                className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <p className="text-sm text-primary tabular-nums">
                    {formatUsd(deposit.amountUsd)} · {deposit.token.toUpperCase()}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-tertiary">
                    {[
                      dateFormatter.format(new Date(deposit.createdAt)),
                      deposit.fromAddress
                        ? t("DashboardEarn.setup.depositFrom", {
                            address: shortenAddress(deposit.fromAddress),
                          })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <Badge variant={badge.variant}>{t(badge.key)}</Badge>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * Post-setup funding screen: the program strategy is set, so all that remains
 * is moving stablecoins to the shared wallet's Solana deposit address. Polls
 * the program while the wallet is still provisioning, then surfaces the
 * address and the live deposits feed.
 */
function FundingScreen({
  curatorName,
  created,
  onDashboard,
}: {
  curatorName: string;
  created: boolean;
  onDashboard: () => void;
}) {
  const t = useTranslations();
  const { state } = useEarnProgram({ refreshWhileCreating: true });
  const program = state?.kind === "active" ? state.program : undefined;
  const wallet = program?.wallet;
  const address = wallet?.solanaDepositAddress;
  const statusBadge = wallet ? WALLET_STATUS_BADGES[wallet.status] : undefined;

  return (
    <PostSetupFrame
      eyebrow={t("DashboardEarn.setup.fundingEyebrow")}
      title={t("DashboardEarn.setup.fundingTitle")}
      description={t("DashboardEarn.setup.fundingDescription", { curator: curatorName })}
      footer={
        <div className="flex justify-end">
          <Button type="button" onClick={onDashboard}>
            {t("DashboardEarn.setup.viewEarnDashboard")}
          </Button>
        </div>
      }
    >
      {!created ? (
        <div
          className="mb-5 flex items-start gap-3 rounded-2xl border border-success-border bg-success-bg p-4 text-success"
          role="status"
        >
          <CheckCircle2Icon className="size-5 shrink-0" />
          <p className="text-sm leading-6">
            {t("DashboardEarn.setup.allocationApplied", { curator: curatorName })}
          </p>
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="space-y-5">
          {wallet?.status === "failed" ? (
            <p
              className="rounded-2xl border border-error-border bg-error-bg p-4 text-sm leading-6 text-error"
              role="alert"
            >
              {t("DashboardEarn.setup.walletFailed")}
            </p>
          ) : address ? (
            <DepositAddressCard address={address} />
          ) : (
            <section
              className="flex items-start gap-3 rounded-2xl border border-border-default bg-surface-raised p-5"
              aria-busy="true"
            >
              <Loader2Icon className="mt-0.5 size-5 shrink-0 animate-spin text-secondary motion-reduce:animate-none" />
              <div>
                <p className="text-sm font-medium text-primary">
                  {t("DashboardEarn.setup.walletCreatingTitle")}
                </p>
                <p className="mt-1 text-[13px] leading-5 text-secondary">
                  {t("DashboardEarn.setup.walletCreatingDescription")}
                </p>
              </div>
            </section>
          )}

          {address ? <RecentDepositsCard /> : null}
        </div>

        <aside className="h-fit overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
          <div className="border-b border-border-subtle bg-fill-subtle px-4 py-3">
            <h3 className="text-sm font-medium text-primary">
              {t("DashboardEarn.setup.fundingSummaryTitle")}
            </h3>
          </div>
          <div className="px-4 py-2">
            <SummaryRow label={t("DashboardEarn.setup.curator")} value={curatorName} />
            <SummaryRow
              label={t("DashboardEarn.setup.fundingStatus")}
              value={
                statusBadge ? (
                  <Badge variant={statusBadge.variant}>{t(statusBadge.key)}</Badge>
                ) : (
                  "—"
                )
              }
            />
            <SummaryRow
              label={t("DashboardEarn.setup.fundingTotalBalance")}
              value={wallet ? formatUsd(wallet.balance.totalUsd) : "—"}
            />
          </div>
        </aside>
      </div>
    </PostSetupFrame>
  );
}

interface EarnDepositWizardProps {
  /** Preselects the curator that owns this catalogue strategy. */
  initialStrategyId?: string;
  initialCuratorId?: string;
}

function primaryActionLabel(
  step: SetupStep,
  selectedCuratorId: string | null,
  programExists: boolean,
  submitting: boolean,
  editingFromReview: boolean,
  t: ReturnType<typeof useTranslations>
): string {
  if (submitting) return t("DashboardEarn.setup.confirming");
  if (editingFromReview) return t("DashboardEarn.setup.saveChanges");
  if (step === "curator") {
    return selectedCuratorId
      ? t("DashboardEarn.setup.continueWithCurator", {
          curator: earnCuratorLabel(selectedCuratorId),
        })
      : t("DashboardEarn.setup.selectCurator");
  }
  if (step === "allocation") return t("DashboardEarn.setup.reviewSetup");
  return programExists
    ? t("DashboardEarn.setup.confirmUpdate")
    : t("DashboardEarn.setup.confirmCreate");
}

export function EarnDepositWizard({ initialStrategyId, initialCuratorId }: EarnDepositWizardProps) {
  const t = useTranslations();
  const router = useDashboardRouter();
  const {
    strategies: catalogue,
    error: catalogueError,
    isLoading: catalogueLoading,
  } = useEarnStrategies();
  const { state: programState, refresh: refreshProgram } = useEarnProgram();

  // The PUT validates yield sources against the pinned provider's active
  // catalogue, so the wizard only ever offers those rows.
  const liveStrategies = useMemo(
    () =>
      (catalogue ?? []).filter(
        (strategy) => strategy.provider === EARN_PORTFOLIO_PROVIDER && strategy.status === "active"
      ),
    [catalogue]
  );
  const programs = useMemo(() => buildCuratorPrograms(liveStrategies), [liveStrategies]);

  const defaultCuratorId = useMemo(() => {
    if (initialCuratorId && programs.some((program) => program.id === initialCuratorId)) {
      return initialCuratorId;
    }
    const initialStrategy = initialStrategyId
      ? liveStrategies.find((strategy) => strategy.id === initialStrategyId)
      : undefined;
    return initialStrategy ? strategyCurator(initialStrategy) : null;
  }, [initialCuratorId, initialStrategyId, liveStrategies, programs]);

  const [step, setStep] = useState<SetupStep>("curator");
  const [editingFromReview, setEditingFromReview] = useState(false);
  const [curatorOverride, setCuratorOverride] = useState<string | null>(null);
  const selectedCuratorId = curatorOverride ?? defaultCuratorId;
  const selectedProgram = programs.find((program) => program.id === selectedCuratorId);

  const tokenGroups = useMemo(
    () => curatorTokenGroups(selectedProgram?.strategies ?? []),
    [selectedProgram]
  );
  const defaultWeights = useMemo(() => defaultWeightInputs(tokenGroups), [tokenGroups]);
  // Weight edits stay pinned to the curator they were made for; switching
  // curators falls back to that curator's even default split.
  const [weightOverride, setWeightOverride] = useState<{
    curatorId: string;
    weights: WeightsByToken;
  } | null>(null);
  const weights =
    weightOverride && weightOverride.curatorId === selectedCuratorId
      ? weightOverride.weights
      : defaultWeights;

  const parsedByToken = useMemo<ParsedByToken>(
    () =>
      Object.fromEntries(
        tokenGroups.map((group) => [group.token, parseAllocation(weights[group.token] ?? {})])
      ),
    [tokenGroups, weights]
  );
  const allocationReady =
    tokenGroups.length > 0 &&
    tokenGroups.every((group) => parsedByToken[group.token]?.issue === undefined);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [completed, setCompleted] = useState<{ created: boolean } | null>(null);

  const programExists = programState?.kind === "active";
  const providerUnconfigured = programState?.kind === "unconfigured";

  const stepReady: Record<SetupStep, boolean> = {
    curator: Boolean(selectedProgram) && tokenGroups.length > 0,
    allocation: allocationReady,
    review: allocationReady && !providerUnconfigured && !submitting,
  };

  const setWeight = (token: EarnPortfolioToken, strategyId: string, value: string) => {
    if (!selectedCuratorId) return;
    setWeightOverride({
      curatorId: selectedCuratorId,
      weights: { ...weights, [token]: { ...(weights[token] ?? {}), [strategyId]: value } },
    });
  };

  const splitEvenly = (token: EarnPortfolioToken) => {
    if (!selectedCuratorId) return;
    setWeightOverride({
      curatorId: selectedCuratorId,
      weights: { ...weights, [token]: defaultWeights[token] ?? {} },
    });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: Every wizard step transition must land already scrolled to the top with its heading announced.
  useLayoutEffect(() => {
    // Pre-paint so the new step's first frame is already at the top — no visible
    // jump or smooth-scroll drift after the content appears.
    const scrollRegion = document.querySelector<HTMLElement>(
      completed ? "[data-earn-post-setup-scroll]" : "[data-wizard-scroll-region]"
    );
    if (!scrollRegion) return;

    scrollRegion.scrollTo({ top: 0, behavior: "instant" });
    const heading = scrollRegion.querySelector<HTMLHeadingElement>("h2");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [step, completed]);

  const confirmSetup = async () => {
    if (!selectedProgram || !stepReady.review) return;
    setSubmitting(true);
    setSubmitError(null);
    const result = await upsertEarnProgram({
      allocations: buildAllocationInput(
        tokenGroups,
        Object.fromEntries(
          tokenGroups.map((group) => [group.token, parsedByToken[group.token]?.weights ?? {}])
        )
      ),
    });
    setSubmitting(false);
    if (!result.ok) {
      setSubmitError(result.error);
      return;
    }
    refreshProgram();
    setCompleted({ created: result.data.data.created });
  };

  const goNext = () => {
    if (step === "review") {
      void confirmSetup();
      return;
    }
    if (!stepReady[step]) return;
    if (editingFromReview) {
      setEditingFromReview(false);
      setStep("review");
      return;
    }
    setStep(step === "curator" ? "allocation" : "review");
  };

  const goBack = () => {
    if (editingFromReview) {
      setEditingFromReview(false);
      setStep("review");
      return;
    }
    if (step === "curator") {
      router.push("/dashboard/markets/earn");
      return;
    }
    setStep(step === "review" ? "allocation" : "curator");
  };

  if (completed && selectedProgram) {
    return (
      <FundingScreen
        curatorName={earnCuratorLabel(selectedProgram.id)}
        created={completed.created}
        onDashboard={() => router.push("/dashboard/markets/earn")}
      />
    );
  }

  const progressStep = STEP_ORDER.indexOf(step);
  const showSummaryRail = step !== "curator";
  const primaryLabel = primaryActionLabel(
    step,
    selectedCuratorId,
    programExists,
    submitting,
    editingFromReview,
    t
  );

  return (
    <WizardFrame
      steps={STEP_ORDER.map((progress) => ({
        label: t(`DashboardEarn.setup.progress.${progress}` as MessageKey),
        title: t(STEP_META[progress].title),
      }))}
      currentStep={progressStep}
      progressLabel={t("DashboardEarn.setup.stepProgress", {
        current: progressStep + 1,
        total: STEP_ORDER.length,
      })}
      description={t(STEP_META[step].description)}
      maxWidthClassName="max-w-4xl"
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between [&>button]:w-full sm:[&>button]:w-auto">
          <Button
            type="button"
            variant="secondary"
            disabled={submitting}
            onClick={goBack}
            iconLeft={step === "curator" && !editingFromReview ? undefined : <ArrowLeftIcon />}
          >
            {editingFromReview
              ? t("DashboardEarn.setup.backToReview")
              : step === "curator"
                ? t("DashboardEarn.setup.cancel")
                : t("DashboardEarn.setup.back")}
          </Button>
          <Button
            type="button"
            disabled={!stepReady[step]}
            onClick={goNext}
            iconLeft={
              submitting ? (
                <Loader2Icon className="animate-spin motion-reduce:animate-none" />
              ) : undefined
            }
            iconRight={step === "review" || submitting ? undefined : <ArrowRightIcon />}
          >
            {primaryLabel}
          </Button>
        </div>
      }
    >
      <div className={cn("grid gap-6", showSummaryRail && "lg:grid-cols-[minmax(0,1fr)_17rem]")}>
        {/* Step content swaps instantly: wizard steps must land pre-scrolled to the
            top with no transition (see the useLayoutEffect scroll reset above). */}
        <div className="relative min-h-[22rem]">
          {step === "curator" ? (
            <CuratorStep
              programs={programs}
              isLoading={catalogueLoading}
              hasError={Boolean(catalogueError)}
              selectedCuratorId={selectedCuratorId}
              onCuratorChange={setCuratorOverride}
            />
          ) : null}
          {step === "allocation" && selectedProgram ? (
            <AllocationStep
              curatorName={earnCuratorLabel(selectedProgram.id)}
              groups={tokenGroups}
              weights={weights}
              parsedByToken={parsedByToken}
              onWeightChange={setWeight}
              onSplitEvenly={splitEvenly}
            />
          ) : null}
          {step === "review" && selectedProgram ? (
            <ReviewStep
              program={selectedProgram}
              groups={tokenGroups}
              parsedByToken={parsedByToken}
              programExists={programExists}
              providerUnconfigured={providerUnconfigured}
              submitError={submitError}
              onEdit={(target) => {
                setEditingFromReview(true);
                setStep(target);
              }}
            />
          ) : null}
        </div>

        {showSummaryRail ? (
          <ProgramSummaryRail
            program={selectedProgram}
            groups={tokenGroups}
            parsedByToken={parsedByToken}
            ready={stepReady.allocation && Boolean(selectedProgram)}
          />
        ) : null}
      </div>
    </WizardFrame>
  );
}
