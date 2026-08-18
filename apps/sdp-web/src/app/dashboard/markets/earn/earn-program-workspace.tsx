"use client";

import { WELL_KNOWN_TOKENS } from "@sdp/types";
import {
  CheckIcon,
  Code2Icon,
  InfoIcon,
  ListChecksIcon,
  PanelsTopLeftIcon,
  PlusIcon,
  SparklesIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { TokenMark } from "@/components/token-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { EarnProgramSkeleton } from "../markets-route-skeletons";
import { type StrategyAsset, USDC_MICROS } from "../treasury-solutions/treasury-solutions-model";
import { EarnDepositButtonPreview } from "./earn-button-preview";
import {
  type AcceptedEarnButton,
  EARN_PROGRAM_STORAGE_KEY,
  EARN_STRATEGIES,
  type EarnButtonStyle,
  type EarnStrategy,
  readAcceptedEarnButtons,
  totalEarnDepositsMicros,
} from "./earn-program-model";

const MINT_BY_ASSET = {
  PYUSD: WELL_KNOWN_TOKENS.PYUSD.mints["mainnet-beta"].address,
  USDC: WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"].address,
  USDG: WELL_KNOWN_TOKENS.USDG.mints["mainnet-beta"].address,
} satisfies Record<StrategyAsset, string>;

const STYLE_LABEL_KEYS: Record<EarnButtonStyle, MessageKey> = {
  ink: "DashboardMarkets.earnProgram.styleInk",
  light: "DashboardMarkets.earnProgram.styleLight",
  accent: "DashboardMarkets.earnProgram.styleAccent",
};

const FLOW_STEPS = [
  { icon: ListChecksIcon, key: "DashboardMarkets.earnProgram.flowSelect" },
  { icon: PanelsTopLeftIcon, key: "DashboardMarkets.earnProgram.flowStyle" },
  { icon: Code2Icon, key: "DashboardMarkets.earnProgram.flowIntegrate" },
] as const satisfies ReadonlyArray<{ icon: typeof ListChecksIcon; key: MessageKey }>;

function useEarnFormatters() {
  const locale = useLocale();
  return useMemo(() => {
    const integer = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
    const usd = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const apy = new Intl.NumberFormat(locale, {
      style: "percent",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return {
      integer: (value: number) => integer.format(value),
      usdMicros: (value: number) => usd.format(value / USDC_MICROS),
      apy: (value: number) => apy.format(value / 100),
    };
  }, [locale]);
}

function StrategyIdentity({ strategy }: { strategy: EarnStrategy }) {
  const t = useTranslations();
  return (
    <div className="flex min-w-0 items-center gap-3">
      <TokenMark mint={MINT_BY_ASSET[strategy.asset]} size="md" symbol={strategy.asset} />
      <div className="min-w-0">
        <p className="truncate text-sm text-primary">{strategy.name}</p>
        <p className="mt-0.5 text-xs text-tertiary">
          {strategy.asset} · {t("DashboardMarkets.earnProgram.variableRate")}
        </p>
      </div>
    </div>
  );
}

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
        <CardAction>
          <Badge variant="outline">{t("DashboardMarkets.earnProgram.mockData")}</Badge>
        </CardAction>
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

function StrategySelection({ builderHref }: { builderHref: string }) {
  const t = useTranslations();
  const router = useRouter();
  const format = useEarnFormatters();
  const [selectedStrategyId, setSelectedStrategyId] = useState<string | null>(null);

  const continueToBuilder = () => {
    if (!selectedStrategyId) return;
    router.push(`${builderHref}?strategy=${encodeURIComponent(selectedStrategyId)}`);
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
            <div className="overflow-x-auto border-y border-border-subtle">
              <Table className="table-fixed" style={{ minWidth: "50rem" }}>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[38%]">
                      {t("DashboardMarkets.earnProgram.strategy")}
                    </TableHead>
                    <TableHead className="w-[16%]">
                      {t("DashboardMarkets.earnProgram.asset")}
                    </TableHead>
                    <TableHead className="w-[18%]">
                      {t("DashboardMarkets.earnProgram.apy")}
                    </TableHead>
                    <TableHead className="w-[14%]">
                      {t("DashboardMarkets.earnProgram.platforms")}
                    </TableHead>
                    <TableHead align="right" className="w-[14%]">
                      <span className="sr-only">{t("DashboardMarkets.earnProgram.select")}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {EARN_STRATEGIES.map((strategy) => {
                    const selected = selectedStrategyId === strategy.id;
                    return (
                      <TableRow className={cn(selected && "bg-fill-subtle")} key={strategy.id}>
                        <TableCell>
                          <StrategyIdentity strategy={strategy} />
                        </TableCell>
                        <TableCell className="text-sm text-secondary">{strategy.asset}</TableCell>
                        <TableCell>
                          <p className="text-xl font-medium tracking-tight text-primary tabular-nums">
                            {format.apy(strategy.apyPercent)}
                          </p>
                        </TableCell>
                        <TableCell className="text-sm text-secondary">
                          {t("DashboardMarkets.earnProgram.iosAndWeb")}
                        </TableCell>
                        <TableCell align="right">
                          <Button
                            aria-pressed={selected}
                            iconLeft={selected ? <CheckIcon /> : undefined}
                            onClick={() => setSelectedStrategyId(strategy.id)}
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
                  })}
                </TableBody>
              </Table>
            </div>

            <div className="flex flex-col gap-4 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex max-w-2xl items-start gap-2 text-xs leading-5 text-tertiary">
                <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <p>{t("DashboardMarkets.earnProgram.rateDisclosure")}</p>
              </div>
              <Button disabled={!selectedStrategyId} onClick={continueToBuilder} type="button">
                {t("DashboardMarkets.earnProgram.continue")}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}

function StatCard({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <Card className="gap-2 px-6 py-5">
      <p className="text-xs text-secondary">{label}</p>
      <p className="text-2xl font-medium tracking-tight text-primary tabular-nums">{value}</p>
    </Card>
  );
}

function EarnProgramOverview({
  buttons,
  onCreate,
}: {
  buttons: AcceptedEarnButton[];
  onCreate: () => void;
}) {
  const t = useTranslations();
  const format = useEarnFormatters();
  const totalDeposits = totalEarnDepositsMicros(buttons);
  const apys = buttons.map((button) => button.apyPercent);
  const minApy = Math.min(...apys);
  const maxApy = Math.max(...apys);
  const formattedApyRange =
    minApy === maxApy
      ? format.apy(minApy)
      : t("DashboardMarkets.earnProgram.apyRangeValue", {
          min: format.apy(minApy),
          max: format.apy(maxApy),
        });

  return (
    <DashboardWorkspaceOverviewPanel>
      <div className="mx-auto w-full max-w-7xl space-y-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-2xl">
            <p className="text-xs font-medium uppercase tracking-wide text-tertiary">
              {t("DashboardMarkets.earnProgram.overviewEyebrow")}
            </p>
            <h2 className="mt-2 text-2xl font-medium tracking-tight text-primary">
              {t("DashboardMarkets.earnProgram.overviewTitle")}
            </h2>
            <p className="mt-2 text-sm leading-6 text-secondary">
              {t("DashboardMarkets.earnProgram.overviewDescription")}
            </p>
          </div>
          <Button iconLeft={<PlusIcon />} onClick={onCreate} type="button">
            {t("DashboardMarkets.earnProgram.addButton")}
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <StatCard
            label={t("DashboardMarkets.earnProgram.configuredButtons")}
            value={format.integer(buttons.length)}
          />
          <StatCard
            label={t("DashboardMarkets.earnProgram.totalDeposits")}
            value={format.usdMicros(totalDeposits)}
          />
          <StatCard label={t("DashboardMarkets.earnProgram.apyRange")} value={formattedApyRange} />
        </div>

        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>{t("DashboardMarkets.earnProgram.overviewTitle")}</CardTitle>
            <CardDescription>{t("DashboardMarkets.earnProgram.storageDisclosure")}</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <div className="overflow-x-auto border-y border-border-subtle">
              <Table className="table-fixed" style={{ minWidth: "54rem" }}>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[24%]">
                      {t("DashboardMarkets.earnProgram.button")}
                    </TableHead>
                    <TableHead className="w-[24%]">
                      {t("DashboardMarkets.earnProgram.strategy")}
                    </TableHead>
                    <TableHead className="w-[13%]">
                      {t("DashboardMarkets.earnProgram.platforms")}
                    </TableHead>
                    <TableHead className="w-[13%]">
                      {t("DashboardMarkets.earnProgram.apy")}
                    </TableHead>
                    <TableHead className="w-[17%]">
                      {t("DashboardMarkets.earnProgram.deposits")}
                    </TableHead>
                    <TableHead className="w-[9%]">
                      {t("DashboardMarkets.earnProgram.status")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {buttons.map((button) => (
                    <TableRow key={button.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <EarnDepositButtonPreview compact style={button.style} />
                          <div className="min-w-0">
                            <p className="truncate text-sm text-primary">
                              {t("DashboardMarkets.earnProgram.buttonName", {
                                number: button.sequence,
                              })}
                            </p>
                            <p className="mt-0.5 text-xs text-tertiary">
                              {t(STYLE_LABEL_KEYS[button.style])}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <StrategyIdentity strategy={button} />
                      </TableCell>
                      <TableCell className="text-sm text-secondary">
                        {t("DashboardMarkets.earnProgram.iosAndWeb")}
                      </TableCell>
                      <TableCell>
                        <p className="text-xl font-medium tracking-tight text-primary tabular-nums">
                          {format.apy(button.apyPercent)}
                        </p>
                      </TableCell>
                      <TableCell className="text-sm text-primary tabular-nums">
                        {format.usdMicros(button.mockDepositMicros)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="success">{t("DashboardMarkets.earnProgram.active")}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-start gap-2 px-6 py-4 text-xs leading-5 text-tertiary">
              <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <p>{t("DashboardMarkets.earnProgram.storageDisclosure")}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}

export function EarnProgramWorkspace({
  builderHref,
  startInCreateMode = false,
}: {
  builderHref: string;
  startInCreateMode?: boolean;
}) {
  const [buttons, setButtons] = useState<AcceptedEarnButton[] | null>(null);
  const [creating, setCreating] = useState(startInCreateMode);

  useEffect(() => {
    const readStoredButtons = () => {
      setButtons(readAcceptedEarnButtons(window.localStorage.getItem(EARN_PROGRAM_STORAGE_KEY)));
    };
    readStoredButtons();
    window.addEventListener("storage", readStoredButtons);
    return () => window.removeEventListener("storage", readStoredButtons);
  }, []);

  if (!buttons) return <EarnProgramSkeleton />;
  if (creating || buttons.length === 0) return <StrategySelection builderHref={builderHref} />;

  return <EarnProgramOverview buttons={buttons} onCreate={() => setCreating(true)} />;
}
