"use client";

import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { EarnStrategy } from "@sdp/types/earn";
import { SOLANA_CLUSTER_LABELS } from "@sdp/types/well-known-tokens";
import { Button } from "@sdp/ui/button";
import { Callout } from "@sdp/ui/callout";
import { ListEmptyState } from "@sdp/ui/list-empty-state";
import { SegmentedControl } from "@sdp/ui/segmented-control";
import { Select, SelectItem } from "@sdp/ui/select";
import { CheckIcon, CopyIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { EarnIntegrationGuideSkeleton } from "@/app/(session)/dashboard/[projectId]/markets/markets-route-skeletons";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { RecordBlock, RecordStack } from "@/components/refresh-record";
import { CodeBlock } from "@/components/ui/code-block";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { DASHBOARD_SIDE_NAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { useCopy } from "@/lib/use-copy";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { useEarnStrategies } from "./earn-data";
import { earnProviderLabel, earnStrategyLiquidityLabel } from "./earn-format";
import {
  buildEarnIntegrationSections,
  buildEarnServerIntegration,
  type EarnIntegrationSections,
} from "./earn-integration-snippets";
import { formatProviderApy } from "./earn-market-presentation";
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
    navigationKey: "DashboardMarkets.embeddedYield.guideClientNavigation",
    titleKey: "DashboardMarkets.embeddedYield.guideClientTitle",
    descriptionKey: "DashboardMarkets.embeddedYield.guideClientDescription",
  },
  {
    id: "deposit",
    navigationKey: "DashboardMarkets.embeddedYield.guideDepositNavigation",
    titleKey: "DashboardMarkets.embeddedYield.guideDepositTitle",
    descriptionKey: "DashboardMarkets.embeddedYield.guideDepositDescription",
  },
  {
    id: "portfolio",
    navigationKey: "DashboardMarkets.embeddedYield.guidePortfolioNavigation",
    titleKey: "DashboardMarkets.embeddedYield.guidePortfolioTitle",
    descriptionKey: "DashboardMarkets.embeddedYield.guidePortfolioDescription",
  },
  {
    id: "withdraw",
    navigationKey: "DashboardMarkets.embeddedYield.guideWithdrawNavigation",
    titleKey: "DashboardMarkets.embeddedYield.guideWithdrawTitle",
    descriptionKey: "DashboardMarkets.embeddedYield.guideWithdrawDescription",
  },
  {
    id: "asyncWithdraw",
    navigationKey: "DashboardMarkets.embeddedYield.guideAsyncWithdrawNavigation",
    titleKey: "DashboardMarkets.embeddedYield.guideAsyncWithdrawTitle",
    descriptionKey: "DashboardMarkets.embeddedYield.guideAsyncWithdrawDescription",
  },
] as const satisfies ReadonlyArray<{
  id: keyof EarnIntegrationSections;
  navigationKey: MessageKey;
  titleKey: MessageKey;
  descriptionKey: MessageKey;
}>;

/** Why this project cannot fund a strategy, said under the picker while its code stays shown. */
const UNAVAILABLE_DESCRIPTIONS = {
  cluster_unavailable: "DashboardMarkets.embeddedYield.unavailableClusterDescription",
  strategy_unavailable: "DashboardMarkets.embeddedYield.unavailableStrategyDescription",
  environment_unavailable: "DashboardMarkets.embeddedYield.unavailableEnvironmentDescription",
  access_unavailable: "DashboardMarkets.embeddedYield.unavailableAccessDescription",
  provider_not_entitled: "DashboardMarkets.embeddedYield.unavailableNotOnPlanDescription",
  provider_not_configured: "DashboardMarkets.embeddedYield.unavailableNotConfiguredDescription",
  provider_disabled: "DashboardMarkets.embeddedYield.unavailableStrategyDescription",
} as const satisfies Record<Exclude<EarnVaultDepositAvailability, "available">, MessageKey>;

function unavailableDescriptionKey(
  availability: Exclude<EarnVaultDepositAvailability, "available">,
  provider: string
): MessageKey {
  return availability === "environment_unavailable" &&
    earnVaultDepositOnlyEnvironment(provider) === "production"
    ? "DashboardMarkets.embeddedYield.unavailableEnvironmentProductionDescription"
    : UNAVAILABLE_DESCRIPTIONS[availability];
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

  const options = (strategies ?? []).map((strategy) => ({
    availability: earnVaultDepositAvailability(strategy, sdpEnvironment, providerAccess),
    strategy,
  }));
  const requestedStrategy = options.find(({ strategy }) => strategy.id === selectedStrategyId);
  // With no choice made, open on the first strategy this project can fund, else the first listed.
  const selectedOption =
    requestedStrategy ??
    (selectedStrategyId === null
      ? (options.find(({ availability }) => availability === "available") ?? options.at(0))
      : undefined);
  const initialStrategyMissing = Boolean(initialStrategyId && !requestedStrategy);

  // The way back and the title are the shell's; the page opens with what the integration does.
  return (
    <DashboardWorkspaceOverviewPanel>
      <div className="flex min-w-0 flex-col gap-8">
        <p className="text-body text-pretty text-secondary">
          {t("DashboardMarkets.embeddedYield.guideIntro")}
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
        />
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}

type StrategyOption = {
  availability: EarnVaultDepositAvailability;
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
}) {
  const t = useTranslations();
  if (catalogueError) {
    return (
      <ListEmptyState
        description={t("DashboardMarkets.embeddedYield.catalogueErrorDescription")}
        message={t("DashboardMarkets.embeddedYield.catalogueErrorTitle")}
      />
    );
  }
  if (options.length === 0) {
    return (
      <ListEmptyState
        description={t("DashboardMarkets.embeddedYield.catalogueEmptyDescription")}
        message={t("DashboardMarkets.embeddedYield.catalogueEmptyTitle")}
      />
    );
  }

  return (
    <RecordStack>
      <RecordBlock title={t("DashboardMarkets.embeddedYield.stepChooseStrategy")}>
        <StrategyPicker
          locale={locale}
          onStrategyChange={onStrategyChange}
          options={options}
          selectedOption={selectedOption}
        />
        {selectedOption ? (
          <>
            {selectedOption.availability === "available" ? null : (
              <Callout variant="neutral">
                {t(
                  unavailableDescriptionKey(
                    selectedOption.availability,
                    selectedOption.strategy.provider
                  ),
                  {
                    cluster: SOLANA_CLUSTER_LABELS[selectedOption.strategy.hostCluster],
                    provider: earnProviderLabel(selectedOption.strategy.provider),
                  }
                )}
              </Callout>
            )}
            <StrategyDetails locale={locale} strategy={selectedOption.strategy} />
          </>
        ) : (
          <StrategySelectionEmptyState initialStrategyMissing={initialStrategyMissing} />
        )}
      </RecordBlock>

      {selectedOption ? (
        <IntegrationReference
          activeSectionId={activeSectionId}
          apiBaseUrl={apiBaseUrl}
          onSectionChange={onSectionChange}
          strategy={selectedOption.strategy}
        />
      ) : null}
    </RecordStack>
  );
}

/**
 * Every strategy the catalogue lists, each selectable so its integration can be read. Whether
 * this project can fund it is said under the picker, never inside the list.
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
      ariaLabel={t("DashboardMarkets.embeddedYield.selectTitle")}
      onValueChange={onStrategyChange}
      placeholder={t("DashboardMarkets.embeddedYield.selectTitle")}
      value={selectedOption?.strategy.id ?? null}
    >
      {options.map(({ strategy }) => {
        const apy = formatProviderApy(strategy.currentApy, locale);
        return (
          <SelectItem key={strategy.id} value={strategy.id}>
            <span className="flex min-w-0 flex-1 items-center justify-between gap-4">
              <span className="truncate">{strategy.name}</span>
              {apy === "—" ? null : (
                <span className="shrink-0 text-tertiary tabular-nums">{apy}</span>
              )}
            </span>
          </SelectItem>
        );
      })}
    </Select>
  );
}

function StrategySelectionEmptyState({
  initialStrategyMissing,
}: {
  initialStrategyMissing: boolean;
}) {
  const t = useTranslations();
  return initialStrategyMissing ? (
    <ListEmptyState
      description={t("DashboardMarkets.embeddedYield.unknownStrategyDescription")}
      message={t("DashboardMarkets.embeddedYield.unknownStrategyTitle")}
    />
  ) : (
    <ListEmptyState
      description={t("DashboardMarkets.embeddedYield.missingStrategyDescription")}
      message={t("DashboardMarkets.embeddedYield.missingStrategyTitle")}
    />
  );
}

/**
 * One plain line under the dropdown ("Kamino · Instant liquidity · 6.2% APY"), then the
 * strategy ID as a copyable code surface. Reference, not a dashboard: no field labels, no big
 * numbers, and no APY when it is unknown. Whether the project can fund the strategy is the
 * note above it, so no availability is restated here.
 */
function StrategyDetails({ locale, strategy }: { locale: string; strategy: EarnStrategy }) {
  const t = useTranslations();
  const liquidity = earnStrategyLiquidityLabel(strategy, t);
  const apy = formatProviderApy(strategy.currentApy, locale);
  const facts = [
    earnProviderLabel(strategy.provider),
    liquidity ? t("DashboardMarkets.embeddedYield.liquidityFact", { liquidity }) : undefined,
    apy === "—" ? undefined : t("DashboardMarkets.embeddedYield.apyFact", { apy }),
  ].filter((fact): fact is string => Boolean(fact));

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-meta text-secondary tabular-nums">{facts.join(" · ")}</p>
      <CodeBlock code={strategy.id} title={t("DashboardMarkets.embeddedYield.strategyId")} />
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
            copied ? "Shared.SharedComponents.copied" : "DashboardMarkets.embeddedYield.copyAllCode"
          )}
        </Button>
      }
      title={t("DashboardMarkets.embeddedYield.stepServerCode")}
    >
      {/* The one thing the copied module needs that this page cannot generate: a key.
          Informational rather than a warning, and it links to where the key is made, because a
          warning with no way to act on it only says "no". The sentence is split around the link
          since the catalog has no rich-text helper. */}
      <Callout variant="info">
        {t("DashboardMarkets.embeddedYield.apiKeyCalloutBefore")}{" "}
        <Link
          className="font-medium underline underline-offset-2"
          href={href(DASHBOARD_SIDE_NAV_HREFS.apiKeys)}
        >
          {t("DashboardMarkets.embeddedYield.apiKeyCalloutLink")}
        </Link>{" "}
        {t("DashboardMarkets.embeddedYield.apiKeyCalloutAfter")}
      </Callout>

      {/* Five reference sections, not wizard steps: on a phone the segments tighten so all five
          stay on one row. */}
      <SegmentedControl
        ariaLabel={t("DashboardMarkets.embeddedYield.guideNavigationTitle")}
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
          title={t("DashboardMarkets.embeddedYield.serverExample")}
          viewportClassName="max-h-[36rem]"
        />
      </div>
    </RecordBlock>
  );
}
