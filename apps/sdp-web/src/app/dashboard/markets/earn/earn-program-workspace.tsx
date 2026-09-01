"use client";

import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  isVaultDirectDepositEnabled,
  SOLANA_CLUSTER_LABELS,
  SOLANA_CLUSTERS,
  type SolanaCluster,
} from "@sdp/types";
import { SegmentedControl } from "@solana/design-system/segmented-control";
import { CheckIcon, Code2Icon, InfoIcon, Layers3Icon, ListChecksIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { EarnProgramConfigureSkeleton } from "../markets-route-skeletons";
import { earnProviderLabel, earnStrategyLiquidityLabel } from "./earn-format";
import {
  EarnDepositAvailabilityBadge,
  EarnStrategyIdentity,
  earnStrategyAsset,
  formatProviderApy,
} from "./earn-market-presentation";
import { useEarnStrategies } from "./earn-program-data";
import {
  type EarnProviderAccess,
  type EarnVaultDepositAvailability,
  earnVaultDepositAvailability,
} from "./earn-surfacing";

const FLOW_STEPS = [
  { icon: ListChecksIcon, key: "DashboardMarkets.earnProgram.flowSelect" },
  { icon: Code2Icon, key: "DashboardMarkets.earnProgram.flowIntegrate" },
] as const satisfies ReadonlyArray<{ icon: typeof ListChecksIcon; key: MessageKey }>;

function ProgramIntro() {
  const t = useTranslations();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Layers3Icon aria-hidden="true" className="size-5 text-secondary" />
          {t("DashboardMarkets.earnProgram.introTitle")}
        </CardTitle>
        <CardDescription className="max-w-3xl leading-6">
          {t("DashboardMarkets.earnProgram.introDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="grid overflow-hidden rounded-xl border border-border-default md:grid-cols-2">
          {FLOW_STEPS.map(({ icon: Icon, key }, index) => (
            <li
              className={cn(
                "flex items-center gap-3 px-4 py-4",
                index < FLOW_STEPS.length - 1 &&
                  "border-b border-border-subtle md:border-r md:border-b-0"
              )}
              key={key}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-fill-subtle text-secondary">
                <Icon aria-hidden="true" className="size-4" />
              </span>
              <span className="text-sm text-primary">{t(key)}</span>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

// Exhaustive by construction (EarnDepositAvailabilityBadge): a new
// availability variant fails this map's compile instead of collapsing to a
// bare "Unavailable".
const PROGRAM_AVAILABILITY_LABELS = {
  available: "DashboardMarkets.earnProgram.sandboxReady",
  cluster_unavailable: "DashboardMarkets.earnProgram.clusterUnavailable",
  strategy_unavailable: "DashboardMarkets.earnProgram.unavailable",
  environment_unavailable: "DashboardMarkets.earnProgram.productionUnavailable",
  access_unavailable: "DashboardMarkets.earnProgram.accessUnavailable",
  provider_unavailable: "DashboardMarkets.earnProgram.providerUnavailable",
} as const satisfies Readonly<Record<EarnVaultDepositAvailability, MessageKey>>;

type StrategyOptionProps = {
  locale: string;
  onSelect: (strategyId: string) => void;
  providerAccess: EarnProviderAccess | null;
  previewSelectable: boolean;
  sdpEnvironment: Parameters<typeof earnVaultDepositAvailability>[1];
  selected: boolean;
  strategy: Parameters<typeof earnVaultDepositAvailability>[0];
};

function strategyOptionState({
  previewSelectable,
  providerAccess,
  sdpEnvironment,
  strategy,
}: Pick<
  StrategyOptionProps,
  "previewSelectable" | "providerAccess" | "sdpEnvironment" | "strategy"
>) {
  const availability = earnVaultDepositAvailability(strategy, sdpEnvironment, providerAccess);
  return {
    asset: earnStrategyAsset(strategy),
    availability,
    supported:
      availability === "available" || (previewSelectable && availability === "cluster_unavailable"),
  };
}

function StrategyRow({
  locale,
  onSelect,
  providerAccess,
  previewSelectable,
  sdpEnvironment,
  selected,
  strategy,
}: StrategyOptionProps) {
  const t = useTranslations();
  const { asset, availability, supported } = strategyOptionState({
    previewSelectable,
    providerAccess,
    sdpEnvironment,
    strategy,
  });
  const liquidity = earnStrategyLiquidityLabel(strategy, t);
  const provider = earnProviderLabel(strategy.provider);

  return (
    <TableRow className={cn(selected && "bg-fill-subtle")}>
      <TableCell>
        <EarnStrategyIdentity strategy={strategy} />
      </TableCell>
      <TableCell className="text-sm text-secondary">{asset?.symbol ?? "—"}</TableCell>
      {/* `cn` has no tailwind-merge, so clamping lives on child spans where
          nothing competes; a long label truncates with the full string on
          `title` instead of overflowing the next column under `table-fixed`. */}
      <TableCell className="text-sm text-secondary">
        <span className="block truncate" title={liquidity}>
          {liquidity ?? "—"}
        </span>
      </TableCell>
      <TableCell className="text-lg font-medium tracking-tight text-primary tabular-nums">
        {formatProviderApy(strategy.currentApy, locale)}
      </TableCell>
      <TableCell className="text-sm text-secondary">
        <span className="block truncate" title={provider}>
          {provider}
        </span>
      </TableCell>
      <TableCell>
        <EarnDepositAvailabilityBadge
          availability={availability}
          labels={PROGRAM_AVAILABILITY_LABELS}
          strategy={strategy}
        />
      </TableCell>
      <TableCell align="right">
        <Button
          aria-pressed={selected}
          disabled={!supported}
          iconLeft={selected ? <CheckIcon /> : undefined}
          onClick={() => onSelect(strategy.id)}
          size="sm"
          type="button"
          variant={selected ? "default" : "secondary"}
        >
          {t(
            selected
              ? "DashboardMarkets.earnProgram.selected"
              : "DashboardMarkets.earnProgram.select"
          )}
        </Button>
      </TableCell>
    </TableRow>
  );
}

function StrategyMobileRow({
  locale,
  onSelect,
  providerAccess,
  previewSelectable,
  sdpEnvironment,
  selected,
  strategy,
}: StrategyOptionProps) {
  const t = useTranslations();
  const { availability, supported } = strategyOptionState({
    previewSelectable,
    providerAccess,
    sdpEnvironment,
    strategy,
  });
  const liquidity = earnStrategyLiquidityLabel(strategy, t);

  return (
    <div className={cn("flex items-center gap-3 px-4 py-3", selected && "bg-fill-subtle")}>
      <div className="min-w-0 flex-1 space-y-2">
        <EarnStrategyIdentity strategy={strategy} />
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium tracking-tight text-primary tabular-nums">
            {formatProviderApy(strategy.currentApy, locale)}
          </span>
          <span className="text-sm text-secondary">{liquidity ?? "—"}</span>
          <EarnDepositAvailabilityBadge
            availability={availability}
            labels={PROGRAM_AVAILABILITY_LABELS}
            strategy={strategy}
          />
        </div>
      </div>
      <Button
        aria-pressed={selected}
        disabled={!supported}
        iconLeft={selected ? <CheckIcon /> : undefined}
        onClick={() => onSelect(strategy.id)}
        size="sm"
        type="button"
        variant={selected ? "default" : "secondary"}
      >
        {t(
          selected ? "DashboardMarkets.earnProgram.selected" : "DashboardMarkets.earnProgram.select"
        )}
      </Button>
    </div>
  );
}

export function EarnProgramWorkspace({
  initialCluster,
  integrateHref,
  providerAccess,
}: {
  initialCluster?: SolanaCluster;
  integrateHref: string;
  providerAccess: EarnProviderAccess | null;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { sdpEnvironment } = useDashboardWorkspace();
  const environmentCluster = CLUSTER_BY_SDP_ENVIRONMENT[sdpEnvironment];
  const [catalogueCluster, setCatalogueCluster] = useState<SolanaCluster | undefined>(() =>
    initialCluster === environmentCluster ? undefined : initialCluster
  );
  const strategiesCluster = sdpEnvironment === "sandbox" ? catalogueCluster : undefined;
  const activeCluster = strategiesCluster ?? environmentCluster;
  const isMainnetPreview = sdpEnvironment === "sandbox" && activeCluster === "mainnet-beta";
  const { strategies, error, isLoading } = useEarnStrategies({ cluster: strategiesCluster });
  const [selectedStrategyId, setSelectedStrategyId] = useState<string | null>(null);

  if (isLoading) return <EarnProgramConfigureSkeleton />;

  const rows = strategies ?? [];
  const selectedStrategy = rows.find((strategy) => strategy.id === selectedStrategyId);
  const depositsEnabled = isVaultDirectDepositEnabled(sdpEnvironment);

  const continueToIntegration = () => {
    if (!selectedStrategy) return;
    const query = new URLSearchParams({ strategy: selectedStrategy.id });
    if (isMainnetPreview) query.set("cluster", "mainnet-beta");
    router.push(`${integrateHref}?${query}`);
  };

  const changeCluster = (cluster: SolanaCluster) => {
    setSelectedStrategyId(null);
    setCatalogueCluster(cluster === environmentCluster ? undefined : cluster);
  };

  return (
    <DashboardWorkspaceOverviewPanel>
      <div className="mx-auto w-full max-w-7xl space-y-5">
        <div className="max-w-3xl">
          <p className="text-xs font-medium uppercase tracking-wide text-tertiary">
            {t("DashboardMarkets.earnProgram.eyebrow")}
          </p>
        </div>

        <ProgramIntro />

        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>{t("DashboardMarkets.earnProgram.selectTitle")}</CardTitle>
            <CardDescription>
              {t(
                isMainnetPreview
                  ? "DashboardMarkets.earnProgram.mainnetCatalogueDescription"
                  : "DashboardMarkets.earnProgram.selectDescription"
              )}
            </CardDescription>
            {sdpEnvironment === "sandbox" ? (
              <CardAction>
                <SegmentedControl
                  aria-label={t("DashboardMarkets.earnProgram.clusterToggleLabel")}
                  items={SOLANA_CLUSTERS.map((cluster) => ({
                    value: cluster,
                    label: SOLANA_CLUSTER_LABELS[cluster],
                  }))}
                  onValueChange={(value) => value && changeCluster(value as SolanaCluster)}
                  value={activeCluster}
                />
              </CardAction>
            ) : null}
          </CardHeader>
          <CardContent className="px-0">
            {error ? (
              <ListEmptyState
                description={t("DashboardMarkets.earnProgram.catalogueErrorDescription")}
                icon={<InfoIcon aria-hidden="true" className="size-5" />}
                message={t("DashboardMarkets.earnProgram.catalogueErrorTitle")}
              />
            ) : rows.length === 0 ? (
              <ListEmptyState
                description={t("DashboardMarkets.earnProgram.catalogueEmptyDescription")}
                icon={<InfoIcon aria-hidden="true" className="size-5" />}
                message={t("DashboardMarkets.earnProgram.catalogueEmptyTitle")}
              />
            ) : (
              <div className="border-y border-border-subtle">
                <div className="divide-y divide-border-default md:hidden">
                  {rows.map((strategy) => (
                    <StrategyMobileRow
                      key={strategy.id}
                      locale={locale}
                      onSelect={setSelectedStrategyId}
                      providerAccess={providerAccess}
                      previewSelectable={isMainnetPreview}
                      sdpEnvironment={sdpEnvironment}
                      selected={selectedStrategyId === strategy.id}
                      strategy={strategy}
                    />
                  ))}
                </div>
                <Table className="hidden md:block [&_table]:min-w-[64rem] [&_table]:table-fixed">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[26%]">
                        {t("DashboardMarkets.earnProgram.strategy")}
                      </TableHead>
                      <TableHead className="w-[10%]">
                        {t("DashboardMarkets.earnProgram.asset")}
                      </TableHead>
                      <TableHead className="w-[13%]">
                        {t("DashboardMarkets.earnProgram.liquidity")}
                      </TableHead>
                      <TableHead className="w-[13%]">
                        {t("DashboardMarkets.earnProgram.apy")}
                      </TableHead>
                      <TableHead className="w-[12%]">
                        {t("DashboardMarkets.earnProgram.provider")}
                      </TableHead>
                      <TableHead className="w-[14%]">
                        {t("DashboardMarkets.earnProgram.availability")}
                      </TableHead>
                      <TableHead align="right" className="w-[12%]">
                        <span className="sr-only">{t("DashboardMarkets.earnProgram.select")}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((strategy) => (
                      <StrategyRow
                        key={strategy.id}
                        locale={locale}
                        onSelect={setSelectedStrategyId}
                        providerAccess={providerAccess}
                        previewSelectable={isMainnetPreview}
                        sdpEnvironment={sdpEnvironment}
                        selected={selectedStrategyId === strategy.id}
                        strategy={strategy}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            <div className="flex flex-col gap-4 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
              {isMainnetPreview && selectedStrategy ? (
                <Callout
                  className="max-w-3xl flex-1"
                  live
                  title={t("DashboardMarkets.earnProgram.mainnetPreviewTitle")}
                  variant="warning"
                >
                  {t("DashboardMarkets.earnProgram.mainnetPreviewDescription")}
                </Callout>
              ) : (
                <div className="flex max-w-2xl items-start gap-2 text-xs leading-5 text-tertiary">
                  <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <p>
                    {t(
                      providerAccess === null
                        ? "DashboardMarkets.earnProgram.accessDisclosure"
                        : depositsEnabled
                          ? "DashboardMarkets.earnProgram.rateDisclosure"
                          : "DashboardMarkets.earnProgram.productionDisclosure"
                    )}
                  </p>
                </div>
              )}
              <Button disabled={!selectedStrategy} onClick={continueToIntegration} type="button">
                {t("DashboardMarkets.earnProgram.continue")}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
