"use client";

import { DEFAULT_SDP_API_URL, type EarnStrategy } from "@sdp/types";
import {
  ArrowLeftIcon,
  CheckIcon,
  Code2Icon,
  InfoIcon,
  MonitorIcon,
  SmartphoneIcon,
} from "lucide-react";
import Link from "next/link";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
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
import { CodeBlock } from "@/components/ui/code-block";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { EarnProgramSkeleton } from "../markets-route-skeletons";
import { type EarnButtonStyle, EarnDepositButtonPreview } from "./earn-button-preview";
import { EarnStrategyIdentity, formatProviderApy } from "./earn-market-presentation";
import { useEarnStrategies } from "./earn-program-data";
import { type EarnProviderAccess, earnVaultDepositAvailability } from "./earn-surfacing";

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

function buildServerIntegration(strategy: EarnStrategy): string {
  return `const SDP_API_URL = ${JSON.stringify(DEFAULT_SDP_API_URL)};

export async function depositIntoEarnVault({
  custodyWalletId,
  amount,
  idempotencyKey,
}: {
  custodyWalletId: string;
  amount: string;
  idempotencyKey: string;
}) {
  const apiKey = process.env.SDP_API_KEY;
  if (!apiKey) throw new Error("SDP_API_KEY is required");

  const response = await fetch(\`\${SDP_API_URL}/v1/earn/vault-deposits\`, {
    method: "POST",
    headers: {
      Authorization: \`Bearer \${apiKey}\`,
      "Content-Type": "application/json",
      // Reuse this caller-owned key when retrying the same logical deposit.
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      strategyId: ${JSON.stringify(strategy.id)},
      custodyWalletId,
      amount,
    }),
  });

  const result = await response.json();
  if (response.status === 202) {
    return { kind: "approval_pending", result };
  }
  if (!response.ok) {
    throw new Error(result?.error?.message ?? "Vault deposit failed");
  }
  return { kind: "submitted", deposit: result.data };
}`;
}

function PreviewContent({ strategy, style }: { strategy: EarnStrategy; style: EarnButtonStyle }) {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <div className="flex h-full flex-col">
      <div>
        <p className="text-xs text-tertiary">{t("DashboardMarkets.earnProgram.previewStrategy")}</p>
        <p className="mt-1 line-clamp-2 text-lg font-medium tracking-tight text-primary">
          {strategy.name}
        </p>
        <p className="mt-2 text-sm text-secondary tabular-nums">
          {t("DashboardMarkets.earnProgram.previewRate", {
            apy: formatProviderApy(strategy.currentApy, locale),
          })}
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

function IosButtonPreview({ strategy, style }: { strategy: EarnStrategy; style: EarnButtonStyle }) {
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
            {t("DashboardMarkets.earnProgram.previewProduct")}
          </p>
          <div className="min-h-0 flex-1 pt-6">
            <PreviewContent strategy={strategy} style={style} />
          </div>
        </div>
      </div>
    </figure>
  );
}

function WebButtonPreview({ strategy, style }: { strategy: EarnStrategy; style: EarnButtonStyle }) {
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
          <span className="text-[11px] text-tertiary">
            {t("DashboardMarkets.earnProgram.previewProduct")}
          </span>
        </div>
        <div className="min-h-[22rem] px-7 py-6">
          <div className="h-[17rem] max-w-sm">
            <PreviewContent strategy={strategy} style={style} />
          </div>
        </div>
      </div>
    </figure>
  );
}

export function EarnButtonBuilder({
  earnHref,
  providerAccess,
  strategyId,
}: {
  earnHref: string;
  providerAccess: EarnProviderAccess | null;
  strategyId?: string;
}) {
  const t = useTranslations();
  const { sdpEnvironment } = useDashboardWorkspace();
  const { strategies, error, isLoading } = useEarnStrategies();
  // SDP has no button-configuration resource or client-component export yet.
  // Keep the new layout visible, but lock the preview to a non-persisted style
  // instead of pretending these controls save or generate a real button.
  const style: EarnButtonStyle = "ink";

  if (isLoading) return <EarnProgramSkeleton />;

  const strategy = strategies?.find((entry) => entry.id === strategyId);
  const availability = strategy
    ? earnVaultDepositAvailability(strategy, sdpEnvironment, providerAccess)
    : undefined;
  if (error || !strategy || availability !== "available") {
    const unavailable = Boolean(strategy && !error);
    return (
      <DashboardWorkspaceOverviewPanel>
        <ListEmptyState
          action={
            <Button asChild variant="secondary">
              <Link href={earnHref}>{t("DashboardMarkets.earnProgram.returnToEarn")}</Link>
            </Button>
          }
          description={t(
            error
              ? "DashboardMarkets.earnProgram.catalogueErrorDescription"
              : unavailable
                ? "DashboardMarkets.earnProgram.unavailableStrategyDescription"
                : "DashboardMarkets.earnProgram.missingStrategyDescription"
          )}
          icon={<InfoIcon aria-hidden="true" className="size-5" />}
          message={t(
            error
              ? "DashboardMarkets.earnProgram.catalogueErrorTitle"
              : unavailable
                ? "DashboardMarkets.earnProgram.unavailableStrategyTitle"
                : "DashboardMarkets.earnProgram.missingStrategyTitle"
          )}
        />
      </DashboardWorkspaceOverviewPanel>
    );
  }

  const integrationCode = buildServerIntegration(strategy);

  return (
    <DashboardWorkspaceOverviewPanel>
      <div className="mx-auto w-full max-w-6xl space-y-5">
        <Button asChild iconLeft={<ArrowLeftIcon />} size="sm" variant="secondary">
          <Link href={earnHref}>{t("DashboardMarkets.earnProgram.back")}</Link>
        </Button>

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

        <Card>
          <CardHeader>
            <CardTitle>{t("DashboardMarkets.earnProgram.selectedStrategy")}</CardTitle>
            <CardDescription>{strategy.provider}</CardDescription>
            <CardAction>
              <Button asChild size="sm" variant="ghost">
                <Link href={earnHref}>{t("DashboardMarkets.earnProgram.changeStrategy")}</Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <div className="rounded-xl border border-border-default px-4 py-4">
              <EarnStrategyIdentity strategy={strategy} />
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
                        "relative cursor-not-allowed rounded-xl border px-4 py-4 opacity-60",
                        selected
                          ? "border-primary bg-fill-subtle"
                          : "border-border-default bg-surface-raised"
                      )}
                      key={option.value}
                    >
                      <input
                        checked={selected}
                        className="sr-only"
                        disabled
                        name="earn-button-style"
                        readOnly
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

            <div className="flex items-start gap-2 rounded-xl border border-border-default bg-fill-subtle px-4 py-3 text-xs leading-5 text-secondary">
              <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <p>{t("DashboardMarkets.earnProgram.appearanceUnavailable")}</p>
            </div>

            <div className="grid gap-6 border-t border-border-subtle pt-6 lg:grid-cols-[0.82fr_1.18fr]">
              <IosButtonPreview strategy={strategy} style={style} />
              <WebButtonPreview strategy={strategy} style={style} />
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
            <CardAction>
              <Badge variant="outline">{t("DashboardMarkets.earnProgram.serverOnly")}</Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-3">
            <CodeBlock
              code={integrationCode}
              language="typescript"
              title={t("DashboardMarkets.earnProgram.serverExample")}
              viewportClassName="max-h-[32rem]"
            />
            <div className="flex items-start gap-2 text-xs leading-5 text-tertiary">
              <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <p>{t("DashboardMarkets.earnProgram.secretKeyDisclosure")}</p>
            </div>
          </CardContent>
          <CardFooter className="justify-end border-t border-border-default">
            <Button asChild>
              <Link href={earnHref}>{t("DashboardMarkets.earnProgram.done")}</Link>
            </Button>
          </CardFooter>
        </Card>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
