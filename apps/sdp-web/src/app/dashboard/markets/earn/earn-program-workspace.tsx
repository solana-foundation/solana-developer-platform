"use client";

import { isVaultDirectDepositEnabled } from "@sdp/types";
import {
  CheckIcon,
  Code2Icon,
  InfoIcon,
  ListChecksIcon,
  PanelsTopLeftIcon,
  SparklesIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { EarnProgramSkeleton } from "../markets-route-skeletons";
import {
  EarnStrategyIdentity,
  earnStrategyAsset,
  formatProviderApy,
} from "./earn-market-presentation";
import { useEarnStrategies } from "./earn-program-data";
import { type EarnProviderAccess, earnVaultDepositAvailability } from "./earn-surfacing";

const FLOW_STEPS = [
  { icon: ListChecksIcon, key: "DashboardMarkets.earnProgram.flowSelect" },
  { icon: PanelsTopLeftIcon, key: "DashboardMarkets.earnProgram.flowStyle" },
  { icon: Code2Icon, key: "DashboardMarkets.earnProgram.flowIntegrate" },
] as const satisfies ReadonlyArray<{ icon: typeof ListChecksIcon; key: MessageKey }>;

function ProgramIntro() {
  const t = useTranslations();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SparklesIcon aria-hidden="true" className="size-5 text-secondary" />
          {t("DashboardMarkets.earnProgram.introTitle")}
        </CardTitle>
        <CardDescription className="max-w-3xl leading-6">
          {t("DashboardMarkets.earnProgram.introDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="grid overflow-hidden rounded-xl border border-border-default md:grid-cols-3">
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

function availabilityMessageKey(
  availability: ReturnType<typeof earnVaultDepositAvailability>
): MessageKey {
  switch (availability) {
    case "available":
      return "DashboardMarkets.earnProgram.sandboxReady";
    case "environment_unavailable":
      return "DashboardMarkets.earnProgram.productionUnavailable";
    case "access_unavailable":
      return "DashboardMarkets.earnProgram.accessUnavailable";
    case "provider_unavailable":
      return "DashboardMarkets.earnProgram.providerUnavailable";
    default:
      return "DashboardMarkets.earnProgram.unavailable";
  }
}

function StrategyRow({
  locale,
  onSelect,
  providerAccess,
  sdpEnvironment,
  selected,
  strategy,
}: {
  locale: string;
  onSelect: (strategyId: string) => void;
  providerAccess: EarnProviderAccess | null;
  sdpEnvironment: Parameters<typeof earnVaultDepositAvailability>[1];
  selected: boolean;
  strategy: Parameters<typeof earnVaultDepositAvailability>[0];
}) {
  const t = useTranslations();
  const availability = earnVaultDepositAvailability(strategy, sdpEnvironment, providerAccess);
  const supported = availability === "available";
  const asset = earnStrategyAsset(strategy);

  return (
    <TableRow className={cn(selected && "bg-fill-subtle")}>
      <TableCell>
        <EarnStrategyIdentity strategy={strategy} />
      </TableCell>
      <TableCell className="text-sm text-secondary">{asset?.symbol ?? "—"}</TableCell>
      <TableCell className="text-lg font-medium tracking-tight text-primary tabular-nums">
        {formatProviderApy(strategy.currentApy, locale)}
      </TableCell>
      <TableCell>
        <Badge variant={supported ? "default" : "outline"}>
          {t(availabilityMessageKey(availability))}
        </Badge>
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

export function EarnProgramWorkspace({
  builderHref,
  providerAccess,
}: {
  builderHref: string;
  providerAccess: EarnProviderAccess | null;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { sdpEnvironment } = useDashboardWorkspace();
  const { strategies, error, isLoading } = useEarnStrategies();
  const [selectedStrategyId, setSelectedStrategyId] = useState<string | null>(null);

  if (isLoading) return <EarnProgramSkeleton />;

  const rows = strategies ?? [];
  const selectedStrategy = rows.find((strategy) => strategy.id === selectedStrategyId);
  const depositsEnabled = isVaultDirectDepositEnabled(sdpEnvironment);

  const continueToBuilder = () => {
    if (!selectedStrategy) return;
    router.push(`${builderHref}?strategy=${encodeURIComponent(selectedStrategy.id)}`);
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
            <CardDescription>{t("DashboardMarkets.earnProgram.selectDescription")}</CardDescription>
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
              <div className="overflow-x-auto border-y border-border-subtle">
                <Table className="table-fixed" style={{ minWidth: "52rem" }}>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[38%]">
                        {t("DashboardMarkets.earnProgram.strategy")}
                      </TableHead>
                      <TableHead className="w-[14%]">
                        {t("DashboardMarkets.earnProgram.asset")}
                      </TableHead>
                      <TableHead className="w-[16%]">
                        {t("DashboardMarkets.earnProgram.apy")}
                      </TableHead>
                      <TableHead className="w-[18%]">
                        {t("DashboardMarkets.earnProgram.availability")}
                      </TableHead>
                      <TableHead align="right" className="w-[14%]">
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
              <Button disabled={!selectedStrategy} onClick={continueToBuilder} type="button">
                {t("DashboardMarkets.earnProgram.continue")}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
