"use client";

import {
  DEFAULT_EARN_BUTTON_ACCENT_COLOR,
  type EarnButtonConfiguration,
  type EarnButtonStyle,
  type EarnStrategy,
} from "@sdp/types";
import { ArrowLeftIcon, Code2Icon, InfoIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useReducer, useState } from "react";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
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
import { CodeBlock } from "@/components/ui/code-block";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { EarnProgramSkeleton } from "../markets-route-skeletons";
import { EarnButtonAppearanceControls } from "./earn-button-appearance-controls";
import { EarnButtonBuilderFooter } from "./earn-button-builder-footer";
import type { EarnButtonConfigurationLoad } from "./earn-button-configuration.server";
import { saveEarnButtonConfiguration } from "./earn-button-configuration-data";
import { EarnButtonDevicePreview } from "./earn-button-device-preview";
import { EarnButtonEngineeringHandoff } from "./earn-button-engineering-handoff";
import { buildEarnServerIntegration, earnButtonIntegrationPath } from "./earn-button-integration";
import { EarnStrategyIdentity } from "./earn-market-presentation";
import { useEarnStrategies } from "./earn-program-data";
import {
  type EarnProviderAccess,
  type EarnVaultDepositAvailability,
  earnVaultDepositAvailability,
} from "./earn-surfacing";

type EarnButtonBuilderProps = {
  configurationLoad: EarnButtonConfigurationLoad;
  earnHref: string;
  projectId: string | null;
  providerAccess: EarnProviderAccess | null;
  strategyId?: string;
};

type EarnButtonBuilderState = {
  savedConfiguration: EarnButtonConfiguration | null;
  style: EarnButtonStyle;
  accentColor: string;
  isSaving: boolean;
  saveError: string | null;
};

type EarnButtonBuilderAction =
  | { type: "styleChanged"; style: EarnButtonStyle }
  | { type: "accentColorChanged"; accentColor: string }
  | { type: "saveStarted" }
  | { type: "saveSucceeded"; configuration: EarnButtonConfiguration }
  | { type: "saveFailed"; error: string }
  | { type: "saveFinished" };

/**
 * The API and DB accept either hex case while the presets are uppercase, so a
 * saved value is normalized on entry — otherwise a config saved as "#9945ff"
 * renders the Purple swatch unselected and flips hasUnsavedChanges for a
 * visually identical color.
 */
function normalizeSavedConfiguration(
  configuration: EarnButtonConfiguration
): EarnButtonConfiguration {
  return { ...configuration, accentColor: configuration.accentColor.toUpperCase() };
}

function createBuilderState(
  configurationLoad: EarnButtonConfigurationLoad
): EarnButtonBuilderState {
  const loaded = configurationLoad.kind === "ready" ? configurationLoad.configuration : null;
  const configuration = loaded ? normalizeSavedConfiguration(loaded) : null;
  return {
    savedConfiguration: configuration,
    style: configuration?.style ?? "ink",
    accentColor: configuration?.accentColor ?? DEFAULT_EARN_BUTTON_ACCENT_COLOR,
    isSaving: false,
    saveError: null,
  };
}

function earnButtonBuilderReducer(
  state: EarnButtonBuilderState,
  action: EarnButtonBuilderAction
): EarnButtonBuilderState {
  switch (action.type) {
    case "styleChanged":
      return { ...state, style: action.style, saveError: null };
    case "accentColorChanged":
      return { ...state, accentColor: action.accentColor, saveError: null };
    case "saveStarted":
      return { ...state, isSaving: true, saveError: null };
    case "saveSucceeded":
      // Only the saved snapshot updates. Local style/accent selections are
      // deliberately NOT reset from the response: an edit made while the PUT
      // was in flight must survive, and hasUnsavedChanges then keeps the
      // footer honest about it instead of claiming the newer edit was saved.
      return {
        ...state,
        savedConfiguration: normalizeSavedConfiguration(action.configuration),
        saveError: null,
      };
    case "saveFailed":
      return { ...state, saveError: action.error };
    case "saveFinished":
      return { ...state, isSaving: false };
  }
}

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

function builderEmptyState(input: {
  catalogueError: unknown;
  configurationError: boolean;
  selectedStrategyId: string | undefined;
  strategy: EarnStrategy | undefined;
  availability: EarnVaultDepositAvailability | undefined;
}): { messageKey: MessageKey; descriptionKey: MessageKey } | null {
  if (input.catalogueError) {
    return {
      messageKey: "DashboardMarkets.earnProgram.catalogueErrorTitle",
      descriptionKey: "DashboardMarkets.earnProgram.catalogueErrorDescription",
    };
  }
  if (!input.strategy) {
    // A failed configuration load dead-ends the page ONLY when it also removes
    // the strategy selection. With ?strategy= present, the previews and the
    // snippet need no saved configuration and keep rendering (with a warning).
    if (input.configurationError && !input.selectedStrategyId) {
      return {
        messageKey: "DashboardMarkets.earnProgram.configurationErrorTitle",
        descriptionKey: "DashboardMarkets.earnProgram.configurationErrorDescription",
      };
    }
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
  if (input.availability !== "available") {
    return {
      messageKey: "DashboardMarkets.earnProgram.unavailableStrategyTitle",
      descriptionKey: unavailableDescriptionKey(input.availability),
    };
  }
  return null;
}

export function EarnButtonBuilder({
  configurationLoad,
  earnHref,
  projectId,
  providerAccess,
  strategyId,
}: EarnButtonBuilderProps) {
  const t = useTranslations();
  const { sdpEnvironment } = useDashboardWorkspace();
  const { strategies, error, isLoading } = useEarnStrategies();
  const [builderState, dispatch] = useReducer(
    earnButtonBuilderReducer,
    configurationLoad,
    createBuilderState
  );
  const [shareOrigin, setShareOrigin] = useState("");
  const { accentColor, isSaving, savedConfiguration, saveError, style } = builderState;

  useEffect(() => setShareOrigin(window.location.origin), []);

  if (isLoading) return <EarnProgramSkeleton />;

  // `||`, not `??`: page.tsx normalizes an empty ?strategy= away, but an empty
  // string arriving here must still fall through to the saved strategy rather
  // than suppressing a configuration that exists.
  const selectedStrategyId = strategyId || savedConfiguration?.strategyId;
  const strategy = strategies?.find((entry) => entry.id === selectedStrategyId);
  const availability = strategy
    ? earnVaultDepositAvailability(strategy, sdpEnvironment, providerAccess)
    : undefined;
  const emptyState = builderEmptyState({
    catalogueError: error,
    configurationError: configurationLoad.kind === "error",
    selectedStrategyId,
    strategy,
    availability,
  });
  if (emptyState) {
    return (
      <DashboardWorkspaceOverviewPanel>
        <ListEmptyState
          action={
            <Button asChild variant="secondary">
              <Link href={earnHref}>{t("DashboardMarkets.earnProgram.returnToEarn")}</Link>
            </Button>
          }
          description={t(emptyState.descriptionKey)}
          icon={<InfoIcon aria-hidden="true" className="size-5" />}
          message={t(emptyState.messageKey)}
        />
      </DashboardWorkspaceOverviewPanel>
    );
  }

  if (!strategy) throw new Error("Earn button strategy invariant failed");
  const availableStrategy = strategy;
  const integrationCode = buildEarnServerIntegration(availableStrategy);
  const hasUnsavedChanges =
    savedConfiguration?.strategyId !== availableStrategy.id ||
    savedConfiguration.style !== style ||
    savedConfiguration.accentColor !== accentColor;
  const sharePath =
    !hasUnsavedChanges && savedConfiguration
      ? earnButtonIntegrationPath(savedConfiguration.publicToken)
      : null;
  const shareLink = sharePath
    ? shareOrigin
      ? new URL(sharePath, shareOrigin).toString()
      : sharePath
    : null;

  async function saveConfiguration() {
    dispatch({ type: "saveStarted" });
    try {
      if (!projectId) {
        dispatch({ type: "saveFailed", error: "Selected project required" });
        return;
      }
      const result = await saveEarnButtonConfiguration({
        projectId,
        strategyId: availableStrategy.id,
        style,
        accentColor,
      });
      if (!result.ok) {
        dispatch({ type: "saveFailed", error: result.error });
        return;
      }
      dispatch({ type: "saveSucceeded", configuration: result.data });
    } catch (error) {
      dispatch({
        type: "saveFailed",
        error: error instanceof Error ? error.message : "Unexpected save failure",
      });
    } finally {
      dispatch({ type: "saveFinished" });
    }
  }

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

        {configurationLoad.kind === "error" ? (
          <div
            className="flex items-start gap-2 rounded-xl border border-border-default bg-fill-subtle px-4 py-3 text-xs leading-5 text-secondary"
            role="alert"
          >
            <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <p>{t("DashboardMarkets.earnProgram.configurationLoadWarning")}</p>
          </div>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>{t("DashboardMarkets.earnProgram.selectedStrategy")}</CardTitle>
            <CardDescription>{availableStrategy.provider}</CardDescription>
            <CardAction>
              <Button asChild size="sm" variant="ghost">
                <Link href={earnHref}>{t("DashboardMarkets.earnProgram.changeStrategy")}</Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <div className="rounded-xl border border-border-default px-4 py-4">
              <EarnStrategyIdentity strategy={availableStrategy} />
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
            <EarnButtonAppearanceControls
              accentColor={accentColor}
              onAccentColorChange={(nextAccentColor) => {
                dispatch({ type: "accentColorChanged", accentColor: nextAccentColor });
              }}
              onStyleChange={(nextStyle) => {
                dispatch({ type: "styleChanged", style: nextStyle });
              }}
              style={style}
            />

            <EarnButtonDevicePreview
              accentColor={accentColor}
              strategy={availableStrategy}
              style={style}
            />
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
          <CardContent className="space-y-5">
            <EarnButtonEngineeringHandoff shareLink={shareLink} sharePath={sharePath} />

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
          <EarnButtonBuilderFooter
            earnHref={earnHref}
            hasUnsavedChanges={hasUnsavedChanges}
            isSaving={isSaving}
            onSave={() => void saveConfiguration()}
            saveError={saveError}
          />
        </Card>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
