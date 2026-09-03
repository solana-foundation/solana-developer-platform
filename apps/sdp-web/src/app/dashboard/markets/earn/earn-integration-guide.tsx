"use client";

import type { EarnStrategy, SolanaCluster } from "@sdp/types";
import { SegmentedControl } from "@solana/design-system/segmented-control";
import {
  ArrowLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  InfoIcon,
  KeyRoundIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CodeBlock } from "@/components/ui/code-block";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { EarnIntegrationGuideSkeleton } from "../markets-route-skeletons";
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
  apiBaseUrl?: string | null;
  configureHref?: string;
  earnHref: string;
  providerAccess: EarnProviderAccess | null;
  strategyCluster?: SolanaCluster;
  strategyId?: string;
};

/** The guide follows the order a partner engineer ships the integration. */
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
  apiBaseUrl,
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
  const [activeSectionId, setActiveSectionId] = useState<keyof EarnIntegrationSections>(
    GUIDE_SECTIONS[0].id
  );

  if (isLoading) return <EarnIntegrationGuideSkeleton />;

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
  const sections = buildEarnIntegrationSections(strategy, apiBaseUrl ?? undefined);
  const activeSectionIndex = GUIDE_SECTIONS.findIndex(({ id }) => id === activeSectionId);
  const activeSection = GUIDE_SECTIONS[activeSectionIndex] ?? GUIDE_SECTIONS[0];
  const previousSection = GUIDE_SECTIONS[activeSectionIndex - 1];
  const nextSection = GUIDE_SECTIONS[activeSectionIndex + 1];

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

        <Card className="gap-4 py-4">
          <CardHeader className="px-5">
            <CardTitle>{t("DashboardMarkets.earnProgram.selectedStrategy")}</CardTitle>
            <CardAction>
              <Button asChild size="sm" variant="ghost">
                <Link href={strategyPickerHref}>
                  {t("DashboardMarkets.earnProgram.changeStrategy")}
                </Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="px-5">
            <EarnStrategyIdentity strategy={strategy} />
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm font-medium text-primary">
              {t("DashboardMarkets.earnProgram.guideNavigationTitle")}
            </p>
            <p className="text-xs text-tertiary">
              {t("DashboardMarkets.earnProgram.guideStepProgress", {
                current: activeSectionIndex + 1,
                total: GUIDE_SECTIONS.length,
              })}
            </p>
          </div>

          <SegmentedControl
            aria-label={t("DashboardMarkets.earnProgram.guideNavigationTitle")}
            items={GUIDE_SECTIONS.map(({ id, navigationKey }) => ({
              value: id,
              label: t(navigationKey),
            }))}
            onValueChange={(value) =>
              value && setActiveSectionId(value as keyof EarnIntegrationSections)
            }
            value={activeSection.id}
          />

          <section
            aria-live="polite"
            className="flex min-w-0 flex-col gap-4"
            id={`earn-guide-panel-${activeSection.id}`}
          >
            <div className="flex flex-col gap-2">
              <h3 className="text-[19px] leading-6 font-medium text-primary">
                {t(activeSection.titleKey)}
              </h3>
              <p className="max-w-3xl text-sm leading-6 text-secondary">
                {t(activeSection.descriptionKey)}
              </p>
              <p className="flex items-center gap-2 text-xs text-tertiary">
                <KeyRoundIcon aria-hidden="true" className="size-4 shrink-0" />
                {t("DashboardMarkets.earnProgram.secretKeyDisclosure")}
              </p>
            </div>

            <CodeBlock
              code={sections[activeSection.id]}
              language="typescript"
              title={t("DashboardMarkets.earnProgram.serverExample")}
              viewportClassName="max-h-[36rem]"
            />

            <div className="flex items-center justify-between">
              <Button
                disabled={!previousSection}
                iconLeft={<ChevronLeftIcon />}
                onClick={() => previousSection && setActiveSectionId(previousSection.id)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {t("DashboardMarkets.earnProgram.previousGuideStep")}
              </Button>
              <Button
                disabled={!nextSection}
                iconRight={<ChevronRightIcon />}
                onClick={() => nextSection && setActiveSectionId(nextSection.id)}
                size="sm"
                type="button"
                variant="secondary"
              >
                {t("DashboardMarkets.earnProgram.nextGuideStep")}
              </Button>
            </div>
          </section>
        </div>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
