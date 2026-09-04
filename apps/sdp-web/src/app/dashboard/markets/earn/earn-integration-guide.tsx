"use client";

import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  type EarnStrategy,
  type SdpEnvironment,
  SOLANA_CLUSTER_LABELS,
  SOLANA_CLUSTERS,
  type SolanaCluster,
} from "@sdp/types";
import { SegmentedControl } from "@solana/design-system/segmented-control";
import { ArrowLeftIcon, CheckIcon, CopyIcon, InfoIcon, KeyRoundIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CodeBlock } from "@/components/ui/code-block";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { Select, SelectItem } from "@/components/ui/select";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useCopy } from "@/lib/use-copy";
import { EarnIntegrationGuideSkeleton } from "../markets-route-skeletons";
import { earnProviderLabel, earnStrategyLiquidityLabel } from "./earn-format";
import {
  buildEarnIntegrationSections,
  type EarnIntegrationSections,
} from "./earn-integration-snippets";
import { EarnDepositAvailabilityBadge, formatProviderApy } from "./earn-market-presentation";
import { useEarnStrategies } from "./earn-program-data";
import {
  type EarnProviderAccess,
  type EarnVaultDepositAvailability,
  earnVaultDepositAvailability,
} from "./earn-surfacing";

type EarnIntegrationGuideProps = {
  apiBaseUrl?: string | null;
  earnHref: string;
  providerAccess: EarnProviderAccess | null;
  strategyCluster?: SolanaCluster;
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
} as const satisfies Readonly<Record<EarnVaultDepositAvailability, MessageKey>>;

function unavailableDescriptionKey(availability: EarnVaultDepositAvailability): MessageKey {
  switch (availability) {
    case "environment_unavailable":
      return "DashboardMarkets.earnProgram.unavailableEnvironmentDescription";
    case "access_unavailable":
      return "DashboardMarkets.earnProgram.unavailableAccessDescription";
    case "provider_unavailable":
      return "DashboardMarkets.earnProgram.unavailableProviderDescription";
    default:
      return "DashboardMarkets.earnProgram.unavailableStrategyDescription";
  }
}

function strategyOptionState(
  strategy: EarnStrategy,
  sdpEnvironment: SdpEnvironment,
  providerAccess: EarnProviderAccess | null,
  previewingMainnet: boolean
): { availability: EarnVaultDepositAvailability; selectable: boolean } {
  const availability = earnVaultDepositAvailability(strategy, sdpEnvironment, providerAccess);
  const isMainnetPreview =
    previewingMainnet &&
    availability === "cluster_unavailable" &&
    strategy.hostCluster === "mainnet-beta";

  if (!isMainnetPreview) {
    return { availability, selectable: availability === "available" };
  }

  // Preview ignores only the cluster mismatch. Re-run the canonical checks so
  // strategy status, deposit style, environment, and provider access still fail closed.
  const previewAvailability = earnVaultDepositAvailability(
    { ...strategy, fundable: true },
    sdpEnvironment,
    providerAccess
  );

  return {
    availability: previewAvailability === "available" ? availability : previewAvailability,
    selectable: previewAvailability === "available",
  };
}

export function EarnIntegrationGuide({
  apiBaseUrl,
  earnHref,
  providerAccess,
  strategyCluster: initialCluster,
  strategyId: initialStrategyId,
}: EarnIntegrationGuideProps) {
  const t = useTranslations();
  const locale = useLocale();
  const { sdpEnvironment } = useDashboardWorkspace();
  const environmentCluster = CLUSTER_BY_SDP_ENVIRONMENT[sdpEnvironment];
  const [catalogueCluster, setCatalogueCluster] = useState<SolanaCluster | undefined>(() =>
    initialCluster === environmentCluster ? undefined : initialCluster
  );
  const strategiesCluster = sdpEnvironment === "sandbox" ? catalogueCluster : undefined;
  const activeCluster = strategiesCluster ?? environmentCluster;
  const previewingMainnet = sdpEnvironment === "sandbox" && activeCluster === "mainnet-beta";
  const { strategies, error, isLoading } = useEarnStrategies({ cluster: strategiesCluster });
  const [selectedStrategyId, setSelectedStrategyId] = useState<string | null>(
    initialStrategyId ?? null
  );
  const [activeSectionId, setActiveSectionId] = useState<keyof EarnIntegrationSections>(
    GUIDE_SECTIONS[0].id
  );
  if (isLoading) return <EarnIntegrationGuideSkeleton />;

  const rows = strategies ?? [];
  const options = rows.map((strategy) => {
    const { availability, selectable } = strategyOptionState(
      strategy,
      sdpEnvironment,
      providerAccess,
      previewingMainnet
    );
    return {
      availability,
      selectable,
      strategy,
    };
  });
  const requestedStrategy = options.find(({ strategy }) => strategy.id === selectedStrategyId);
  const selectedOption =
    requestedStrategy ??
    (selectedStrategyId === null ? options.find(({ selectable }) => selectable) : undefined);
  const selectionIssue =
    selectedOption && !selectedOption.selectable
      ? unavailableDescriptionKey(selectedOption.availability)
      : undefined;
  const initialStrategyMissing = Boolean(initialStrategyId && !requestedStrategy);

  const changeCluster = (cluster: SolanaCluster) => {
    setSelectedStrategyId(null);
    setCatalogueCluster(cluster === environmentCluster ? undefined : cluster);
  };

  return (
    <DashboardWorkspaceOverviewPanel>
      <div className="mx-auto w-full max-w-5xl space-y-8">
        <Button asChild className="-ml-2" iconLeft={<ArrowLeftIcon />} size="sm" variant="ghost">
          <Link href={earnHref}>{t("DashboardMarkets.earnProgram.back")}</Link>
        </Button>

        <CatalogueContent
          activeCluster={activeCluster}
          activeSectionId={activeSectionId}
          apiBaseUrl={apiBaseUrl}
          catalogueError={error}
          initialStrategyMissing={initialStrategyMissing}
          locale={locale}
          onClusterChange={changeCluster}
          onSectionChange={setActiveSectionId}
          onStrategyChange={setSelectedStrategyId}
          options={options}
          previewingMainnet={previewingMainnet}
          sdpEnvironment={sdpEnvironment}
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
  activeCluster,
  activeSectionId,
  apiBaseUrl,
  catalogueError,
  initialStrategyMissing,
  locale,
  onClusterChange,
  onSectionChange,
  onStrategyChange,
  options,
  previewingMainnet,
  sdpEnvironment,
  selectedOption,
  selectionIssue,
}: {
  activeCluster: SolanaCluster;
  activeSectionId: keyof EarnIntegrationSections;
  apiBaseUrl?: string | null;
  catalogueError: unknown;
  initialStrategyMissing: boolean;
  locale: string;
  onClusterChange: (cluster: SolanaCluster) => void;
  onSectionChange: (section: keyof EarnIntegrationSections) => void;
  onStrategyChange: (strategyId: string | null) => void;
  options: StrategyOption[];
  previewingMainnet: boolean;
  sdpEnvironment: SdpEnvironment;
  selectedOption: StrategyOption | undefined;
  selectionIssue: MessageKey | undefined;
}) {
  const t = useTranslations();
  if (catalogueError) {
    return (
      <ListEmptyState
        description={t("DashboardMarkets.earnProgram.catalogueErrorDescription")}
        icon={<InfoIcon aria-hidden="true" className="size-5" />}
        message={t("DashboardMarkets.earnProgram.catalogueErrorTitle")}
      />
    );
  }
  if (options.length === 0) {
    return (
      <ListEmptyState
        description={t("DashboardMarkets.earnProgram.catalogueEmptyDescription")}
        icon={<InfoIcon aria-hidden="true" className="size-5" />}
        message={t("DashboardMarkets.earnProgram.catalogueEmptyTitle")}
      />
    );
  }

  const selectedStrategy = selectedOption?.strategy;
  const showIntegration = Boolean(selectedStrategy && selectedOption?.selectable);

  return (
    <>
      {previewingMainnet && showIntegration ? (
        <Callout title={t("DashboardMarkets.earnProgram.mainnetPreviewTitle")} variant="warning">
          {t("DashboardMarkets.earnProgram.mainnetPreviewDescription")}
        </Callout>
      ) : null}

      <StrategyPickerCard
        activeCluster={activeCluster}
        initialStrategyMissing={initialStrategyMissing}
        locale={locale}
        onClusterChange={onClusterChange}
        onStrategyChange={onStrategyChange}
        options={options}
        previewingMainnet={previewingMainnet}
        sdpEnvironment={sdpEnvironment}
        selectedOption={selectedOption}
        selectionIssue={selectionIssue}
      />

      {showIntegration && selectedStrategy ? (
        <IntegrationReference
          activeSectionId={activeSectionId}
          apiBaseUrl={apiBaseUrl}
          onSectionChange={onSectionChange}
          strategy={selectedStrategy}
        />
      ) : null}
    </>
  );
}

function StrategyPickerCard({
  activeCluster,
  initialStrategyMissing,
  locale,
  onClusterChange,
  onStrategyChange,
  options,
  previewingMainnet,
  sdpEnvironment,
  selectedOption,
  selectionIssue,
}: {
  activeCluster: SolanaCluster;
  initialStrategyMissing: boolean;
  locale: string;
  onClusterChange: (cluster: SolanaCluster) => void;
  onStrategyChange: (strategyId: string | null) => void;
  options: StrategyOption[];
  previewingMainnet: boolean;
  sdpEnvironment: SdpEnvironment;
  selectedOption: StrategyOption | undefined;
  selectionIssue: MessageKey | undefined;
}) {
  const t = useTranslations();
  const selectedStrategy = selectedOption?.strategy;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("DashboardMarkets.earnProgram.strategy")}</CardTitle>
        {sdpEnvironment === "sandbox" ? (
          <CardAction>
            <SegmentedControl
              aria-label={t("DashboardMarkets.earnProgram.clusterToggleLabel")}
              items={SOLANA_CLUSTERS.map((cluster) => ({
                value: cluster,
                label: SOLANA_CLUSTER_LABELS[cluster],
              }))}
              onValueChange={(value) => value && onClusterChange(value as SolanaCluster)}
              value={activeCluster}
            />
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-6">
        {previewingMainnet ? (
          <p className="max-w-2xl text-sm leading-6 text-secondary">
            {t("DashboardMarkets.earnProgram.mainnetCatalogueDescription")}
          </p>
        ) : null}

        <Select
          ariaLabel={t("DashboardMarkets.earnProgram.selectTitle")}
          onValueChange={onStrategyChange}
          placeholder={t("DashboardMarkets.earnProgram.selectTitle")}
          size="xl"
          value={selectedStrategy?.id ?? null}
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
                      {availability === "cluster_unavailable"
                        ? t(PROGRAM_AVAILABILITY_LABELS.cluster_unavailable, {
                            cluster: SOLANA_CLUSTER_LABELS[strategy.hostCluster],
                          })
                        : t(PROGRAM_AVAILABILITY_LABELS[availability])}
                    </>
                  ) : null}
                </span>
              </span>
            </SelectItem>
          ))}
        </Select>

        {selectedStrategy && selectedOption?.selectable ? (
          <StrategyDetails locale={locale} option={selectedOption} />
        ) : (
          <StrategySelectionEmptyState
            initialStrategyMissing={initialStrategyMissing}
            selectionIssue={selectionIssue}
          />
        )}
      </CardContent>
    </Card>
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
  return (
    <ListEmptyState
      description={t(descriptionKey)}
      icon={<InfoIcon aria-hidden="true" className="size-5" />}
      message={t(messageKey)}
    />
  );
}

function StrategyDetails({ locale, option }: { locale: string; option: StrategyOption }) {
  const t = useTranslations();
  const { copied, copy, value: copiedValue } = useCopy(1200);
  const { strategy } = option;
  const strategyIdCopied = copied && copiedValue === strategy.id;

  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-4">
        <div>
          <dt className="text-xs text-tertiary">{t("DashboardMarkets.earnProgram.apy")}</dt>
          <dd className="mt-1 text-lg font-medium tracking-tight text-primary tabular-nums">
            {formatProviderApy(strategy.currentApy, locale)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-tertiary">{t("DashboardMarkets.earnProgram.liquidity")}</dt>
          <dd className="mt-1 text-sm text-primary">
            {earnStrategyLiquidityLabel(strategy, t) ?? "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-tertiary">{t("DashboardMarkets.earnProgram.provider")}</dt>
          <dd className="mt-1 text-sm text-primary">{earnProviderLabel(strategy.provider)}</dd>
        </div>
        <div>
          <dt className="text-xs text-tertiary">
            {t("DashboardMarkets.earnProgram.availability")}
          </dt>
          <dd className="mt-1">
            <EarnDepositAvailabilityBadge
              availability={option.availability}
              labels={PROGRAM_AVAILABILITY_LABELS}
              strategy={strategy}
            />
          </dd>
        </div>
      </dl>

      <div className="flex min-w-0 items-center gap-4 border-t border-border-subtle pt-5">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-tertiary">{t("DashboardMarkets.earnProgram.strategyId")}</p>
          <span className="mt-1 block truncate text-sm text-primary">{strategy.id}</span>
        </div>
        <Button
          aria-label={t("DashboardMarkets.earnProgram.copyStrategyId")}
          iconLeft={strategyIdCopied ? <CheckIcon /> : <CopyIcon />}
          onClick={() => void copy(strategy.id)}
          size="sm"
          type="button"
          variant="secondary"
        >
          {t(strategyIdCopied ? "Shared.SharedComponents.copied" : "Shared.SharedComponents.copy")}
        </Button>
      </div>
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
  const sections = buildEarnIntegrationSections(strategy, apiBaseUrl ?? undefined);
  const activeSection =
    GUIDE_SECTIONS.find(({ id }) => id === activeSectionId) ?? GUIDE_SECTIONS[0];

  return (
    <div className="flex flex-col gap-6 pt-1">
      <SegmentedControl
        aria-label={t("DashboardMarkets.earnProgram.guideNavigationTitle")}
        items={GUIDE_SECTIONS.map(({ id, navigationKey }) => ({
          value: id,
          label: t(navigationKey),
        }))}
        onValueChange={(value) => value && onSectionChange(value as keyof EarnIntegrationSections)}
        value={activeSection.id}
      />

      <section
        aria-live="polite"
        className="flex min-w-0 flex-col gap-5"
        id={`earn-guide-panel-${activeSection.id}`}
      >
        <div className="flex flex-col gap-2">
          <h3 className="text-[19px] leading-6 font-medium text-primary">
            {t(activeSection.titleKey)}
          </h3>
          <p className="max-w-3xl text-sm leading-6 text-secondary">
            {t(activeSection.descriptionKey)}
          </p>
          {activeSection.id === "client" ? (
            <p className="flex items-center gap-2 text-xs text-tertiary">
              <KeyRoundIcon aria-hidden="true" className="size-4 shrink-0" />
              {t("DashboardMarkets.earnProgram.secretKeyDisclosure")}
            </p>
          ) : null}
        </div>

        <CodeBlock
          code={sections[activeSection.id]}
          language="typescript"
          title={t("DashboardMarkets.earnProgram.serverExample")}
          viewportClassName="max-h-[36rem]"
        />
      </section>
    </div>
  );
}
