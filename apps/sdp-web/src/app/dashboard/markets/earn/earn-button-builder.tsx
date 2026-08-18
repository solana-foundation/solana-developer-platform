"use client";

import { WELL_KNOWN_TOKENS } from "@sdp/types";
import {
  ArrowLeftIcon,
  CheckIcon,
  Code2Icon,
  CopyIcon,
  InfoIcon,
  MonitorIcon,
  SmartphoneIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { TokenMark } from "@/components/token-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useCopy } from "@/lib/use-copy";
import { cn } from "@/lib/utils";
import { EarnDepositButtonPreview } from "./earn-button-preview";
import {
  createAcceptedEarnButton,
  EARN_PROGRAM_STORAGE_KEY,
  EARN_STRATEGIES,
  type EarnButtonStyle,
  readAcceptedEarnButtons,
  serializeAcceptedEarnButtons,
} from "./earn-program-model";

const MINT_BY_ASSET = {
  PYUSD: WELL_KNOWN_TOKENS.PYUSD.mints["mainnet-beta"].address,
  USDC: WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"].address,
  USDG: WELL_KNOWN_TOKENS.USDG.mints["mainnet-beta"].address,
};

const STYLE_OPTIONS = [
  {
    value: "ink",
    labelKey: "DashboardMarkets.earnProgram.styleInk",
    descriptionKey: "DashboardMarkets.earnProgram.styleInkDescription",
  },
  {
    value: "light",
    labelKey: "DashboardMarkets.earnProgram.styleLight",
    descriptionKey: "DashboardMarkets.earnProgram.styleLightDescription",
  },
  {
    value: "accent",
    labelKey: "DashboardMarkets.earnProgram.styleAccent",
    descriptionKey: "DashboardMarkets.earnProgram.styleAccentDescription",
  },
] as const satisfies ReadonlyArray<{
  value: EarnButtonStyle;
  labelKey: MessageKey;
  descriptionKey: MessageKey;
}>;

function buildIntegrationLink(strategyId: string, style: EarnButtonStyle): string {
  const url = new URL(`https://developers.solana.com/earn/buttons/${strategyId}`);
  url.searchParams.set("appearance", style);
  return url.toString();
}

function PreviewContent({ style }: { style: EarnButtonStyle }) {
  const t = useTranslations();
  return (
    <div className="flex h-full flex-col">
      <div>
        <p className="text-xs text-tertiary">{t("DashboardMarkets.earnProgram.previewBalance")}</p>
        <p className="mt-1 text-2xl font-medium tracking-tight text-primary tabular-nums">
          {t("DashboardMarkets.earnProgram.previewBalanceValue")}
        </p>
        <p className="mt-3 max-w-xs text-sm leading-5 text-secondary">
          {t("DashboardMarkets.earnProgram.previewPrompt")}
        </p>
      </div>
      <div className="mt-auto pt-8">
        <EarnDepositButtonPreview className="w-full" style={style} />
        <p className="mt-2 text-center text-[11px] text-tertiary">
          {t("DashboardMarkets.earnProgram.poweredBy")}
        </p>
      </div>
    </div>
  );
}

function IosButtonPreview({ style }: { style: EarnButtonStyle }) {
  const t = useTranslations();
  return (
    <figure className="min-w-0">
      <figcaption className="mb-3 flex items-center gap-2 text-sm text-secondary">
        <SmartphoneIcon aria-hidden="true" className="size-4" />
        {t("DashboardMarkets.earnProgram.iosPreview")}
      </figcaption>
      <div className="mx-auto max-w-[19rem] rounded-[2rem] border border-border-default bg-fill-strong p-2 shadow-sm">
        <div className="flex min-h-[22rem] flex-col overflow-hidden rounded-[1.55rem] bg-surface-raised px-5 pt-4 pb-5">
          <div aria-hidden="true" className="mx-auto h-1.5 w-16 rounded-full bg-fill-strong" />
          <p className="mt-5 border-b border-border-subtle pb-3 text-sm font-medium text-primary">
            {t("DashboardMarkets.earnProgram.previewAppName")}
          </p>
          <div className="min-h-0 flex-1 pt-6">
            <PreviewContent style={style} />
          </div>
        </div>
      </div>
    </figure>
  );
}

function WebButtonPreview({ style }: { style: EarnButtonStyle }) {
  const t = useTranslations();
  return (
    <figure className="min-w-0">
      <figcaption className="mb-3 flex items-center gap-2 text-sm text-secondary">
        <MonitorIcon aria-hidden="true" className="size-4" />
        {t("DashboardMarkets.earnProgram.webPreview")}
      </figcaption>
      <div className="overflow-hidden rounded-xl border border-border-default bg-surface-raised shadow-sm">
        <div className="flex items-center gap-3 border-b border-border-subtle bg-fill-subtle px-4 py-3">
          <span aria-hidden="true" className="flex gap-1.5">
            <span className="size-2 rounded-full bg-fill-strong" />
            <span className="size-2 rounded-full bg-fill-strong" />
            <span className="size-2 rounded-full bg-fill-strong" />
          </span>
          <span className="min-w-0 flex-1 truncate rounded-md bg-surface-raised px-3 py-1.5 text-center text-[11px] text-tertiary">
            {t("DashboardMarkets.earnProgram.previewWebUrl")}
          </span>
        </div>
        <div className="min-h-[22rem] px-7 py-6">
          <p className="border-b border-border-subtle pb-3 text-sm font-medium text-primary">
            {t("DashboardMarkets.earnProgram.previewWebName")}
          </p>
          <div className="mt-7 h-[15.5rem] max-w-sm">
            <PreviewContent style={style} />
          </div>
        </div>
      </div>
    </figure>
  );
}

export function EarnButtonBuilder({
  earnHref,
  strategyId,
}: {
  earnHref: string;
  strategyId?: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { copied, copy } = useCopy(1600);
  const [style, setStyle] = useState<EarnButtonStyle>("ink");
  const strategy = EARN_STRATEGIES.find((entry) => entry.id === strategyId);
  const apy = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        style: "percent",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    [locale]
  );

  if (!strategy) {
    return (
      <DashboardWorkspaceOverviewPanel>
        <ListEmptyState
          action={
            <Button asChild variant="secondary">
              <Link href={`${earnHref}?create=1`}>
                {t("DashboardMarkets.earnProgram.returnToEarn")}
              </Link>
            </Button>
          }
          description={t("DashboardMarkets.earnProgram.missingStrategyDescription")}
          icon={<InfoIcon aria-hidden="true" className="size-5" />}
          message={t("DashboardMarkets.earnProgram.missingStrategyTitle")}
        />
      </DashboardWorkspaceOverviewPanel>
    );
  }

  const integrationLink = buildIntegrationLink(strategy.id, style);

  const copyIntegrationLink = async () => {
    try {
      await copy(integrationLink);
      toast.success(t("DashboardMarkets.earnProgram.copied"));
    } catch {
      toast.error(t("DashboardMarkets.earnProgram.copyFailed"));
    }
  };

  const acceptButton = () => {
    try {
      const existing = readAcceptedEarnButtons(
        window.localStorage.getItem(EARN_PROGRAM_STORAGE_KEY)
      );
      const lastSequence = existing
        .filter((button) => button.strategyId === strategy.id)
        .reduce((maximum, button) => Math.max(maximum, button.sequence), 0);
      const accepted = createAcceptedEarnButton({
        strategyId: strategy.id,
        style,
        sequence: lastSequence + 1,
      });
      if (!accepted) throw new Error("invalid mock Earn button");

      window.localStorage.setItem(
        EARN_PROGRAM_STORAGE_KEY,
        serializeAcceptedEarnButtons([...existing, accepted])
      );
      toast.success(t("DashboardMarkets.earnProgram.acceptedSuccess"));
      router.push(earnHref);
    } catch {
      toast.error(t("DashboardMarkets.earnProgram.saveFailed"));
    }
  };

  return (
    <DashboardWorkspaceOverviewPanel>
      <div className="mx-auto w-full max-w-6xl space-y-5">
        <Button asChild iconLeft={<ArrowLeftIcon />} size="sm" variant="secondary">
          <Link href={`${earnHref}?create=1`}>{t("DashboardMarkets.earnProgram.back")}</Link>
        </Button>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-3xl">
            <p className="text-xs font-medium uppercase tracking-wide text-tertiary">
              {t("DashboardMarkets.earnProgram.builderEyebrow")}
            </p>
            <h2 className="mt-2 text-2xl font-medium tracking-tight text-primary">
              {t("DashboardMarkets.earnProgram.builderTitle")}
            </h2>
            <p className="mt-2 text-sm leading-6 text-secondary">
              {t("DashboardMarkets.earnProgram.builderDescription")}
            </p>
          </div>
          <Badge variant="outline">{t("DashboardMarkets.earnProgram.mockData")}</Badge>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{t("DashboardMarkets.earnProgram.selectedStrategy")}</CardTitle>
            <CardDescription>{strategy.name}</CardDescription>
            <CardAction>
              <Button asChild size="sm" variant="ghost">
                <Link href={`${earnHref}?create=1`}>
                  {t("DashboardMarkets.earnProgram.changeStrategy")}
                </Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3 rounded-xl border border-border-default px-4 py-4">
              <TokenMark mint={MINT_BY_ASSET[strategy.asset]} size="md" symbol={strategy.asset} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-primary">{strategy.name}</p>
                <p className="mt-0.5 text-xs text-tertiary">{strategy.asset}</p>
              </div>
              <p className="text-2xl font-medium tracking-tight text-primary tabular-nums">
                {apy.format(strategy.apyPercent / 100)}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("DashboardMarkets.earnProgram.appearanceTitle")}</CardTitle>
            <CardDescription>
              {t("DashboardMarkets.earnProgram.appearanceDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <fieldset>
              <legend className="sr-only">
                {t("DashboardMarkets.earnProgram.appearanceTitle")}
              </legend>
              <div className="grid gap-3 md:grid-cols-3">
                {STYLE_OPTIONS.map((option) => {
                  const selected = style === option.value;
                  return (
                    <label
                      className={cn(
                        "relative cursor-pointer rounded-xl border px-4 py-4 transition-colors focus-within:ring-2 focus-within:ring-border-default focus-within:ring-offset-2",
                        selected
                          ? "border-primary bg-fill-subtle"
                          : "border-border-default bg-surface-raised hover:bg-fill-subtle"
                      )}
                      key={option.value}
                    >
                      <input
                        checked={selected}
                        className="sr-only"
                        name="earn-button-style"
                        onChange={() => setStyle(option.value)}
                        type="radio"
                        value={option.value}
                      />
                      <span className="flex items-start justify-between gap-3">
                        <span>
                          <span className="block text-sm font-medium text-primary">
                            {t(option.labelKey)}
                          </span>
                          <span className="mt-1 block text-xs leading-5 text-secondary">
                            {t(option.descriptionKey)}
                          </span>
                        </span>
                        <span
                          aria-hidden="true"
                          className={cn(
                            "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border",
                            selected
                              ? "border-primary bg-primary text-on-primary"
                              : "border-border-default"
                          )}
                        >
                          {selected ? <CheckIcon className="size-3" /> : null}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className="grid gap-6 border-t border-border-subtle pt-6 lg:grid-cols-[0.82fr_1.18fr]">
              <IosButtonPreview style={style} />
              <WebButtonPreview style={style} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Code2Icon aria-hidden="true" className="size-5 text-secondary" />
              {t("DashboardMarkets.earnProgram.integrationTitle")}
            </CardTitle>
            <CardDescription className="max-w-3xl leading-6">
              {t("DashboardMarkets.earnProgram.integrationDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-xs font-medium text-secondary">
              {t("DashboardMarkets.earnProgram.handoffLabel")}
            </p>
            <div className="mt-2 flex flex-col gap-2 rounded-xl border border-border-default bg-fill-subtle p-2 sm:flex-row sm:items-center">
              <span
                className="min-w-0 flex-1 truncate px-2 text-sm text-primary"
                title={integrationLink}
              >
                {integrationLink}
              </span>
              <Button
                iconLeft={copied ? <CheckIcon /> : <CopyIcon />}
                onClick={() => void copyIntegrationLink()}
                size="sm"
                type="button"
                variant="secondary"
              >
                {t(
                  copied
                    ? "DashboardMarkets.earnProgram.copiedButton"
                    : "DashboardMarkets.earnProgram.copyLink"
                )}
              </Button>
            </div>
            <div className="mt-3 flex items-start gap-2 text-xs leading-5 text-tertiary">
              <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <p>{t("DashboardMarkets.earnProgram.handoffHint")}</p>
            </div>
          </CardContent>
          <CardFooter className="justify-end gap-2 border-t border-border-default">
            <Button asChild variant="secondary">
              <Link href={`${earnHref}?create=1`}>{t("DashboardMarkets.earnProgram.back")}</Link>
            </Button>
            <Button onClick={acceptButton} type="button">
              {t("DashboardMarkets.earnProgram.acceptButton")}
            </Button>
          </CardFooter>
        </Card>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
