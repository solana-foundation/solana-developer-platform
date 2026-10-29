"use client";

import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { EarnStrategy } from "@sdp/types/earn";
import { Button } from "@sdp/ui/button";
import { Callout } from "@sdp/ui/callout";
import { ListEmptyState } from "@sdp/ui/list-empty-state";
import { SegmentedControl } from "@sdp/ui/segmented-control";
import { Select, SelectItem } from "@sdp/ui/select";
import { CheckIcon, CopyIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { EarnIntegrationGuideSkeleton } from "@/app/dashboard/[projectId]/markets/markets-route-skeletons";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { RecordBlock, RecordStack } from "@/components/refresh-record";
import { CodeBlock } from "@/components/ui/code-block";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { DASHBOARD_SIDE_NAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { useCopy } from "@/lib/use-copy";
import { useProjectHref } from "@/lib/use-dashboard-project";
import {
  type EarnDepositAvailabilityLabels,
  earnDepositAvailabilityLabel,
  earnProviderLabel,
  earnStrategyLiquidityLabel,
} from "./earn-format";
import {
  buildEarnIntegrationSections,
  buildEarnServerIntegration,
  type EarnIntegrationSections,
} from "./earn-integration-snippets";
import { formatProviderApy } from "./earn-market-presentation";
import { useEarnStrategies } from "./earn-program-data";
import {
  type EarnProviderAccess,
  type EarnVaultDepositAvailability,
  earnVaultDepositAvailability,
  earnVaultDepositOnlyEnvironment,
} from "./earn-surfacing";

type EarnIntegrationGuideProps = {
  apiBaseUrl?: string | null;
  providerAccess: EarnProviderAccess | null;
  strategyId?: string;
};

/** These are reference tabs, not wizard steps: engineers can jump to any part of the flow. */
const GUIDE_SECTIONS = [
  {
    id: "client",
    navigationKey: "DashboardMarkets.earnProgram.guideClientNavigation",
    titleKey: "DashboardMarkets.earnProgram.guideClientTitle",
    descriptionKey: "DashboardMarkets.earnProgram.guideClientDescription",
  },
  {
    id: "deposit",
    navigationKey: "DashboardMarkets.earnProgram.guideDepositNavigation",
    titleKey: "DashboardMarkets.earnProgram.guideDepositTitle",
    descriptionKey: "DashboardMarkets.earnProgram.guideDepositDescription",
  },
  {
    id: "portfolio",
    navigationKey: "DashboardMarkets.earnProgram.guidePortfolioNavigation",
    titleKey: "DashboardMarkets.earnProgram.guidePortfolioTitle",
    descriptionKey: "DashboardMarkets.earnProgram.guidePortfolioDescription",
  },
  {
    id: "withdraw",
    navigationKey: "DashboardMarkets.earnProgram.guideWithdrawNavigation",
    titleKey: "DashboardMarkets.earnProgram.guideWithdrawTitle",
    descriptionKey: "DashboardMarkets.earnProgram.guideWithdrawDescription",
  },
  {
    id: "asyncWithdraw",
    navigationKey: "DashboardMarkets.earnProgram.guideAsyncWithdrawNavigation",
    titleKey: "DashboardMarkets.earnProgram.guideAsyncWithdrawTitle",
    descriptionKey: "DashboardMarkets.earnProgram.guideAsyncWithdrawDescription",
  },
] as const satisfies ReadonlyArray<{
  id: keyof EarnIntegrationSections;
  navigationKey: MessageKey;
  titleKey: MessageKey;
  descriptionKey: MessageKey;
}>;

const PROGRAM_AVAILABILITY_LABELS = {
  available: "DashboardMarkets.earnProgram.sandboxReady",
  cluster_unavailable: "DashboardMarkets.earnProgram.clusterUnavailable",
  strategy_unavailable: "DashboardMarkets.earnProgram.unavailable",
  environment_unavailable: "DashboardMarkets.earnProgram.productionUnavailable",
  access_unavailable: "DashboardMarkets.earnProgram.accessUnavailable",
  provider_unavailable: "DashboardMarkets.earnProgram.providerUnavailable",
  production_only: "DashboardMarkets.earnProgram.sandboxUnavailable",
} as const satisfies EarnDepositAvailabilityLabels;

function unavailableDescriptionKey(
  availability: EarnVaultDepositAvailability,
  provider: string
): MessageKey {
  switch (availability) {
    case "cluster_unavailable":
      return "DashboardMarkets.earnProgram.unavailableClusterDescription";
    case "environment_unavailable":
      return earnVaultDepositOnlyEnvironment(provider) === "production"
        ? "DashboardMarkets.earnProgram.unavailableEnvironmentProductionDescription"
        : "DashboardMarkets.earnProgram.unavailableEnvironmentDescription";
    case "access_unavailable":
      return "DashboardMarkets.earnProgram.unavailableAccessDescription";
    case "provider_unavailable":
      return "DashboardMarkets.earnProgram.unavailableProviderDescription";
    default:
      return "DashboardMarkets.earnProgram.unavailableStrategyDescription";
  }
}

/**
 * The one list the picker shows. Production lists its own (mainnet) shelf.
 * Sandbox lists the fundable devnet shelf first, then the mirrored mainnet
 * catalogue: those rows stay visible but disabled ("Mainnet only"), the same
 * posture as the Treasury strategy table, so nothing is hidden behind a toggle.
 * The guide stays in its skeleton until BOTH shelves have answered: a mainnet
 * deep link resolved against the devnet rows alone would flash "strategy no
 * longer available" before flipping to the network-mismatch explanation. A
 * failed mainnet read only drops its own rows.
 */
function useIntegrationCatalogue(sdpEnvironment: SdpEnvironment) {
  const sandbox = sdpEnvironment === "sandbox";
  const shelf = useEarnStrategies();
  const mainnet = useEarnStrategies({ cluster: sandbox ? "mainnet-beta" : undefined });
  if (!sandbox) return shelf;

  const devnetRows = shelf.strategies ?? [];
  const mainnetRows = mainnet.error ? [] : (mainnet.strategies ?? []);
  const seen = new Set(devnetRows.map((strategy) => strategy.id));
  return {
    strategies: [...devnetRows, ...mainnetRows.filter((strategy) => !seen.has(strategy.id))],
    error: shelf.error,
    isLoading: shelf.isLoading || mainnet.isLoading,
  };
}

export function EarnIntegrationGuide({
  apiBaseUrl,
  providerAccess,
  strategyId: initialStrategyId,
}: EarnIntegrationGuideProps) {
  const t = useTranslations();
  const locale = useLocale();
  const { sdpEnvironment } = useDashboardWorkspace();
  const { strategies, error, isLoading } = useIntegrationCatalogue(sdpEnvironment);
  const [selectedStrategyId, setSelectedStrategyId] = useState<string | null>(
    initialStrategyId ?? null
  );
  const [activeSectionId, setActiveSectionId] = useState<keyof EarnIntegrationSections>(
    GUIDE_SECTIONS[0].id
  );
  if (isLoading) return <EarnIntegrationGuideSkeleton />;

  const options = (strategies ?? []).map((strategy) => {
    const availability = earnVaultDepositAvailability(strategy, sdpEnvironment, providerAccess);
    return { availability, selectable: availability === "available", strategy };
  });
  const requestedStrategy = options.find(({ strategy }) => strategy.id === selectedStrategyId);
  const selectedOption =
    requestedStrategy ??
    (selectedStrategyId === null ? options.find(({ selectable }) => selectable) : undefined);
  const selectionIssue =
    selectedOption && !selectedOption.selectable
      ? unavailableDescriptionKey(selectedOption.availability, selectedOption.strategy.provider)
      : undefined;
  const initialStrategyMissing = Boolean(initialStrategyId && !requestedStrategy);

  // The way back and the title are the shell's; the page opens with what the integration does.
  return (
    <DashboardWorkspaceOverviewPanel>
      <div className="flex min-w-0 flex-col gap-8">
        <p className="text-body text-pretty text-secondary">
          {t("DashboardMarkets.earnProgram.guideIntro")}
        </p>

        <CatalogueContent
          activeSectionId={activeSectionId}
          apiBaseUrl={apiBaseUrl}
          catalogueError={error}
          initialStrategyMissing={initialStrategyMissing}
          locale={locale}
          onSectionChange={setActiveSectionId}
          onStrategyChange={setSelectedStrategyId}
          options={options}
          selectedOption={selectedOption}
          selectionIssue={selectionIssue}
        />
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}

type StrategyOption = {
  availability: EarnVaultDepositAvailability;
  selectable: boolean;
  strategy: EarnStrategy;
};

function CatalogueContent({
  activeSectionId,
  apiBaseUrl,
  catalogueError,
  initialStrategyMissing,
  locale,
  onSectionChange,
  onStrategyChange,
  options,
  selectedOption,
  selectionIssue,
}: {
  activeSectionId: keyof EarnIntegrationSections;
  apiBaseUrl?: string | null;
  catalogueError: unknown;
  initialStrategyMissing: boolean;
  locale: string;
  onSectionChange: (section: keyof EarnIntegrationSections) => void;
  onStrategyChange: (strategyId: string | null) => void;
  options: StrategyOption[];
  selectedOption: StrategyOption | undefined;
  selectionIssue: MessageKey | undefined;
}) {
  const t = useTranslations();
  if (catalogueError) {
    return (
      <ListEmptyState
        description={t("DashboardMarkets.earnProgram.catalogueErrorDescription")}
        message={t("DashboardMarkets.earnProgram.catalogueErrorTitle")}
      />
    );
  }
  if (options.length === 0) {
    return (
      <ListEmptyState
        description={t("DashboardMarkets.earnProgram.catalogueEmptyDescription")}
        message={t("DashboardMarkets.earnProgram.catalogueEmptyTitle")}
      />
    );
  }

  const selectedStrategy = selectedOption?.strategy;

  return (
    <RecordStack>
      <RecordBlock title={t("DashboardMarkets.earnProgram.stepChooseStrategy")}>
        <StrategyPicker
          locale={locale}
          onStrategyChange={onStrategyChange}
          options={options}
          selectedOption={selectedOption}
        />
        {selectedStrategy && selectedOption?.selectable ? (
          <StrategyDetails locale={locale} strategy={selectedStrategy} />
        ) : (
          <StrategySelectionEmptyState
            initialStrategyMissing={initialStrategyMissing}
            selectionIssue={selectionIssue}
          />
        )}
      </RecordBlock>

      {selectedStrategy && selectedOption?.selectable ? (
        <IntegrationReference
          activeSectionId={activeSectionId}
          apiBaseUrl={apiBaseUrl}
          onSectionChange={onSectionChange}
          strategy={selectedStrategy}
        />
      ) : null}
    </RecordStack>
  );
}

/**
 * Every strategy the catalogue lists, the ones this project cannot fund disabled with the reason
 * beside their APY.
 */
function StrategyPicker({
  locale,
  onStrategyChange,
  options,
  selectedOption,
}: {
  locale: string;
  onStrategyChange: (strategyId: string | null) => void;
  options: StrategyOption[];
  selectedOption: StrategyOption | undefined;
}) {
  const t = useTranslations();
  return (
    <Select
      ariaLabel={t("DashboardMarkets.earnProgram.selectTitle")}
      onValueChange={onStrategyChange}
      placeholder={t("DashboardMarkets.earnProgram.selectTitle")}
      value={selectedOption?.strategy.id ?? null}
    >
      {options.map(({ availability, selectable, strategy }) => (
        <SelectItem disabled={!selectable} key={strategy.id} value={strategy.id}>
          <span className="flex min-w-0 flex-1 items-center justify-between gap-4">
            <span className="truncate">{strategy.name}</span>
            <span className="shrink-0 text-tertiary tabular-nums">
              {formatProviderApy(strategy.currentApy, locale)}
              {!selectable ? (
                <>
                  {" · "}
                  {earnDepositAvailabilityLabel(
                    availability,
                    PROGRAM_AVAILABILITY_LABELS,
                    strategy,
                    t
                  )}
                </>
              ) : null}
            </span>
          </span>
        </SelectItem>
      ))}
    </Select>
  );
}

function StrategySelectionEmptyState({
  initialStrategyMissing,
  selectionIssue,
}: {
  initialStrategyMissing: boolean;
  selectionIssue: MessageKey | undefined;
}) {
  const t = useTranslations();
  let descriptionKey: MessageKey = "DashboardMarkets.earnProgram.missingStrategyDescription";
  let messageKey: MessageKey = "DashboardMarkets.earnProgram.missingStrategyTitle";
  if (initialStrategyMissing) {
    descriptionKey = "DashboardMarkets.earnProgram.unknownStrategyDescription";
    messageKey = "DashboardMarkets.earnProgram.unknownStrategyTitle";
  }
  if (selectionIssue) {
    descriptionKey = selectionIssue;
    messageKey = "DashboardMarkets.earnProgram.unavailableStrategyTitle";
  }
  return <ListEmptyState description={t(descriptionKey)} message={t(messageKey)} />;
}

/**
 * One plain line under the dropdown ("Kamino · Instant liquidity · 6.2% APY"), then the
 * strategy ID as a copyable code surface. Reference, not a dashboard: no field labels, no big
 * numbers, and no APY when it is unknown. Only a strategy this project can fund gets here, so
 * no availability is restated.
 */
function StrategyDetails({ locale, strategy }: { locale: string; strategy: EarnStrategy }) {
  const t = useTranslations();
  const liquidity = earnStrategyLiquidityLabel(strategy, t);
  const apy = formatProviderApy(strategy.currentApy, locale);
  const facts = [
    earnProviderLabel(strategy.provider),
    liquidity ? t("DashboardMarkets.earnProgram.liquidityFact", { liquidity }) : undefined,
    apy === "—" ? undefined : t("DashboardMarkets.earnProgram.apyFact", { apy }),
  ].filter((fact): fact is string => Boolean(fact));

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-meta text-secondary tabular-nums">{facts.join(" · ")}</p>
      <CodeBlock code={strategy.id} title={t("DashboardMarkets.earnProgram.strategyId")} />
    </div>
  );
}

function IntegrationReference({
  activeSectionId,
  apiBaseUrl,
  onSectionChange,
  strategy,
}: {
  activeSectionId: keyof EarnIntegrationSections;
  apiBaseUrl?: string | null;
  onSectionChange: (section: keyof EarnIntegrationSections) => void;
  strategy: EarnStrategy;
}) {
  const t = useTranslations();
  const href = useProjectHref();
  const { copied, copy } = useCopy(1600);
  const sections = buildEarnIntegrationSections(strategy, apiBaseUrl ?? undefined);
  const serverModule = buildEarnServerIntegration(strategy, apiBaseUrl ?? undefined);
  const activeSection =
    GUIDE_SECTIONS.find(({ id }) => id === activeSectionId) ?? GUIDE_SECTIONS[0];

  return (
    <RecordBlock
      aside={
        <Button
          iconLeft={copied ? <CheckIcon /> : <CopyIcon />}
          onClick={() => void copy(serverModule)}
          size="sm"
          type="button"
          variant="outline"
        >
          {t(
            copied ? "Shared.SharedComponents.copied" : "DashboardMarkets.earnProgram.copyAllCode"
          )}
        </Button>
      }
      title={t("DashboardMarkets.earnProgram.stepServerCode")}
    >
      {/* The one thing the copied module needs that this page cannot generate: a key.
          Informational rather than a warning, and it links to where the key is made, because a
          warning with no way to act on it only says "no". The sentence is split around the link
          since the catalog has no rich-text helper. */}
      <Callout variant="info">
        {t("DashboardMarkets.earnProgram.apiKeyCalloutBefore")}{" "}
        <Link
          className="font-medium underline underline-offset-2"
          href={href(DASHBOARD_SIDE_NAV_HREFS.apiKeys)}
        >
          {t("DashboardMarkets.earnProgram.apiKeyCalloutLink")}
        </Link>{" "}
        {t("DashboardMarkets.earnProgram.apiKeyCalloutAfter")}
      </Callout>

      {/* Five reference sections, not wizard steps: on a phone the segments tighten so all five
          stay on one row. */}
      <SegmentedControl
        ariaLabel={t("DashboardMarkets.earnProgram.guideNavigationTitle")}
        className="w-full @2xl:w-fit"
        onChange={(value) => {
          const section = GUIDE_SECTIONS.find(({ id }) => id === value);
          if (section) onSectionChange(section.id);
        }}
        optionClassName="px-2 @2xl:px-3"
        options={GUIDE_SECTIONS.map(({ id, navigationKey }) => ({
          value: id,
          label: t(navigationKey),
        }))}
        value={activeSection.id}
      />

      <div
        aria-live="polite"
        className="flex min-w-0 flex-col gap-3"
        id={`earn-guide-panel-${activeSection.id}`}
      >
        <p className="text-body text-pretty">
          <span className="font-medium text-primary">{t(activeSection.titleKey)}</span>
          <span className="text-secondary">{` · ${t(activeSection.descriptionKey)}`}</span>
        </p>
        <CodeBlock
          code={sections[activeSection.id]}
          language="typescript"
          title={t("DashboardMarkets.earnProgram.serverExample")}
          viewportClassName="max-h-[36rem]"
        />
      </div>
    </RecordBlock>
  );
}
