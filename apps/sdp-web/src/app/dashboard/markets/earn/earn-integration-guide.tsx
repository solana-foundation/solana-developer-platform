"use client";

import type { EarnStrategy, SolanaCluster } from "@sdp/types";
import { ArrowLeftIcon, InfoIcon, KeyRoundIcon } from "lucide-react";
import Link from "next/link";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Badge } from "@/components/ui/badge";
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
import { CodeBlock } from "@/components/ui/code-block";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { EarnProgramSkeleton } from "../markets-route-skeletons";
import {
  buildEarnIntegrationSections,
  type EarnIntegrationSections,
} from "./earn-integration-snippets";
import { EarnStrategyIdentity } from "./earn-market-presentation";
import { useEarnStrategies } from "./earn-program-data";
import {
  type EarnProviderAccess,
  type EarnVaultDepositAvailability,
  earnVaultDepositAvailability,
} from "./earn-surfacing";

type EarnIntegrationGuideProps = {
  configureHref?: string;
  earnHref: string;
  providerAccess: EarnProviderAccess | null;
  strategyCluster?: SolanaCluster;
  strategyId?: string;
};

/**
 * The guide reads top to bottom in the order a partner engineer ships it:
 * client setup, money in, reads, money out. Each section is one card with a
 * short description and its slice of the single server module.
 */
const GUIDE_SECTIONS = [
  {
    id: "client",
    titleKey: "DashboardMarkets.earnProgram.guideClientTitle",
    descriptionKey: "DashboardMarkets.earnProgram.guideClientDescription",
  },
  {
    id: "deposit",
    titleKey: "DashboardMarkets.earnProgram.guideDepositTitle",
    descriptionKey: "DashboardMarkets.earnProgram.guideDepositDescription",
  },
  {
    id: "portfolio",
    titleKey: "DashboardMarkets.earnProgram.guidePortfolioTitle",
    descriptionKey: "DashboardMarkets.earnProgram.guidePortfolioDescription",
  },
  {
    id: "withdraw",
    titleKey: "DashboardMarkets.earnProgram.guideWithdrawTitle",
    descriptionKey: "DashboardMarkets.earnProgram.guideWithdrawDescription",
  },
] as const satisfies ReadonlyArray<{
  id: keyof EarnIntegrationSections;
  titleKey: MessageKey;
  descriptionKey: MessageKey;
}>;

function unavailableDescriptionKey(
  availability: EarnVaultDepositAvailability | undefined
): MessageKey {
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

function guideEmptyState(input: {
  catalogueError: unknown;
  selectedStrategyId: string | undefined;
  strategy: EarnStrategy | undefined;
  availability: EarnVaultDepositAvailability | undefined;
  previewOnly: boolean;
}): { messageKey: MessageKey; descriptionKey: MessageKey } | null {
  if (input.catalogueError) {
    return {
      messageKey: "DashboardMarkets.earnProgram.catalogueErrorTitle",
      descriptionKey: "DashboardMarkets.earnProgram.catalogueErrorDescription",
    };
  }
  if (!input.strategy) {
    if (input.selectedStrategyId) {
      return {
        messageKey: "DashboardMarkets.earnProgram.unknownStrategyTitle",
        descriptionKey: "DashboardMarkets.earnProgram.unknownStrategyDescription",
      };
    }
    return {
      messageKey: "DashboardMarkets.earnProgram.missingStrategyTitle",
      descriptionKey: "DashboardMarkets.earnProgram.missingStrategyDescription",
    };
  }
  const previewSelectable = input.previewOnly && input.availability === "cluster_unavailable";
  if (input.availability !== "available" && !previewSelectable) {
    return {
      messageKey: "DashboardMarkets.earnProgram.unavailableStrategyTitle",
      descriptionKey: unavailableDescriptionKey(input.availability),
    };
  }
  return null;
}

export function EarnIntegrationGuide({
  configureHref,
  earnHref,
  providerAccess,
  strategyCluster,
  strategyId,
}: EarnIntegrationGuideProps) {
  const strategyPickerHref =
    configureHref && strategyCluster
      ? `${configureHref}?cluster=${encodeURIComponent(strategyCluster)}`
      : (configureHref ?? earnHref);
  const t = useTranslations();
  const { sdpEnvironment } = useDashboardWorkspace();
  const { strategies, error, isLoading } = useEarnStrategies({ cluster: strategyCluster });

  if (isLoading) return <EarnProgramSkeleton />;

  const strategy = strategies?.find((entry) => entry.id === strategyId);
  const availability = strategy
    ? earnVaultDepositAvailability(strategy, sdpEnvironment, providerAccess)
    : undefined;
  const isMainnetPreview =
    sdpEnvironment === "sandbox" &&
    strategyCluster === "mainnet-beta" &&
    strategy?.hostCluster === "mainnet-beta";
  const emptyState = guideEmptyState({
    catalogueError: error,
    selectedStrategyId: strategyId,
    strategy,
    availability,
    previewOnly: isMainnetPreview,
  });
  if (emptyState) {
    return (
      <DashboardWorkspaceOverviewPanel>
        <ListEmptyState
          action={
            <Button asChild variant="secondary">
              <Link href={strategyPickerHref}>
                {t("DashboardMarkets.earnProgram.returnToEarn")}
              </Link>
            </Button>
          }
          description={t(emptyState.descriptionKey)}
          icon={<InfoIcon aria-hidden="true" className="size-5" />}
          message={t(emptyState.messageKey)}
        />
      </DashboardWorkspaceOverviewPanel>
    );
  }

  if (!strategy) throw new Error("Earn integration strategy invariant failed");
  const sections = buildEarnIntegrationSections(strategy);

  return (
    <DashboardWorkspaceOverviewPanel>
      <div className="mx-auto w-full max-w-5xl space-y-5">
        <Button asChild iconLeft={<ArrowLeftIcon />} size="sm" variant="secondary">
          <Link href={strategyPickerHref}>{t("DashboardMarkets.earnProgram.back")}</Link>
        </Button>

        <div className="max-w-3xl">
          <p className="text-xs font-medium uppercase tracking-wide text-tertiary">
            {t("DashboardMarkets.earnProgram.integrateEyebrow")}
          </p>
          <h2 className="mt-2 text-2xl font-medium tracking-tight text-primary">
            {t("DashboardMarkets.earnProgram.integrateTitle")}
          </h2>
          <p className="mt-2 text-sm leading-6 text-secondary">
            {t("DashboardMarkets.earnProgram.integrateDescription")}
          </p>
        </div>

        {isMainnetPreview ? (
          <Callout title={t("DashboardMarkets.earnProgram.mainnetPreviewTitle")} variant="warning">
            {t("DashboardMarkets.earnProgram.mainnetPreviewDescription")}
          </Callout>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>{t("DashboardMarkets.earnProgram.selectedStrategy")}</CardTitle>
            <CardDescription>{strategy.provider}</CardDescription>
            <CardAction>
              <Button asChild size="sm" variant="ghost">
                <Link href={strategyPickerHref}>
                  {t("DashboardMarkets.earnProgram.changeStrategy")}
                </Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <div className="rounded-xl border border-border-default px-4 py-4">
              <EarnStrategyIdentity strategy={strategy} />
            </div>
          </CardContent>
        </Card>

        <div className="flex items-start gap-3 rounded-xl border border-border-default bg-fill-subtle px-4 py-4">
          <KeyRoundIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-secondary" />
          <div>
            <p className="text-sm font-medium text-primary">
              {t("DashboardMarkets.earnProgram.apiKeyNoteTitle")}
            </p>
            <p className="mt-1 text-xs leading-5 text-secondary">
              {t("DashboardMarkets.earnProgram.secretKeyDisclosure")}
            </p>
          </div>
        </div>

        {GUIDE_SECTIONS.map(({ id, titleKey, descriptionKey }) => (
          <Card key={id}>
            <CardHeader>
              <CardTitle>{t(titleKey)}</CardTitle>
              <CardDescription className="max-w-3xl leading-6">{t(descriptionKey)}</CardDescription>
              <CardAction>
                <Badge variant="outline">{t("DashboardMarkets.earnProgram.serverOnly")}</Badge>
              </CardAction>
            </CardHeader>
            <CardContent>
              <CodeBlock
                code={sections[id]}
                language="typescript"
                title={t("DashboardMarkets.earnProgram.serverExample")}
                viewportClassName="max-h-[28rem]"
              />
            </CardContent>
          </Card>
        ))}
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
