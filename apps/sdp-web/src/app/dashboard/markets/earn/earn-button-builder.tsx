"use client";

import {
  DEFAULT_EARN_BUTTON_ACCENT_COLOR,
  type EarnButtonConfiguration,
  type EarnStrategy,
} from "@sdp/types";
import {
  ArrowLeftIcon,
  BatteryFullIcon,
  CheckIcon,
  Code2Icon,
  CopyIcon,
  ExternalLinkIcon,
  InfoIcon,
  Loader2Icon,
  LockKeyholeIcon,
  MonitorIcon,
  PaletteIcon,
  SignalHighIcon,
  SmartphoneIcon,
  WifiHighIcon,
} from "lucide-react";
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
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CodeBlock } from "@/components/ui/code-block";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useCopy } from "@/lib/use-copy";
import { cn } from "@/lib/utils";
import { EarnProgramSkeleton } from "../markets-route-skeletons";
import { saveEarnButtonConfiguration } from "./earn-button-configuration-data";
import { buildEarnServerIntegration, earnButtonIntegrationPath } from "./earn-button-integration";
import {
  EARN_BUTTON_STYLES,
  type EarnButtonStyle,
  EarnDepositButtonPreview,
} from "./earn-button-preview";
import { EarnStrategyIdentity, formatProviderApy } from "./earn-market-presentation";
import { useEarnStrategies } from "./earn-program-data";
import {
  type EarnProviderAccess,
  type EarnVaultDepositAvailability,
  earnVaultDepositAvailability,
} from "./earn-surfacing";

type EarnButtonConfigurationLoad =
  | { kind: "ready"; configuration: EarnButtonConfiguration | null }
  | { kind: "error" };

type EarnButtonBuilderProps = {
  configurationLoad: EarnButtonConfigurationLoad;
  earnHref: string;
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

function createBuilderState(
  configurationLoad: EarnButtonConfigurationLoad
): EarnButtonBuilderState {
  const configuration = configurationLoad.kind === "ready" ? configurationLoad.configuration : null;
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
      return {
        ...state,
        savedConfiguration: action.configuration,
        style: action.configuration.style,
        accentColor: action.configuration.accentColor,
        saveError: null,
      };
    case "saveFailed":
      return { ...state, saveError: action.error };
    case "saveFinished":
      return { ...state, isSaving: false };
  }
}

function configurationStateKey(configurationLoad: EarnButtonConfigurationLoad): string {
  if (configurationLoad.kind === "error") return "error";
  const configuration = configurationLoad.configuration;
  return configuration ? `${configuration.id}:${configuration.updatedAt}` : "empty";
}

const STYLE_OPTIONS = [
  {
    value: "ink",
    labelKey: "DashboardMarkets.earnProgram.styleInk",
  },
  {
    value: "light",
    labelKey: "DashboardMarkets.earnProgram.styleLight",
  },
  {
    value: "accent",
    labelKey: "DashboardMarkets.earnProgram.styleAccent",
  },
] as const satisfies ReadonlyArray<{
  value: EarnButtonStyle;
  labelKey: MessageKey;
}>;

const ACCENT_COLOR_OPTIONS = [
  {
    color: DEFAULT_EARN_BUTTON_ACCENT_COLOR,
    labelKey: "DashboardMarkets.earnProgram.accentSolana",
  },
  { color: "#9945FF", labelKey: "DashboardMarkets.earnProgram.accentPurple" },
  { color: "#4C6FFF", labelKey: "DashboardMarkets.earnProgram.accentBlue" },
  { color: "#FF6B6B", labelKey: "DashboardMarkets.earnProgram.accentCoral" },
  { color: "#F5B942", labelKey: "DashboardMarkets.earnProgram.accentGold" },
] as const satisfies ReadonlyArray<{ color: string; labelKey: MessageKey }>;

const styleOptionValues = new Set(STYLE_OPTIONS.map((option) => option.value));
if (
  styleOptionValues.size !== EARN_BUTTON_STYLES.length ||
  !EARN_BUTTON_STYLES.every((style) => styleOptionValues.has(style))
) {
  throw new Error("Earn button style options do not match the preview renderer");
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
  if (input.configurationError) {
    return {
      messageKey: "DashboardMarkets.earnProgram.configurationErrorTitle",
      descriptionKey: "DashboardMarkets.earnProgram.configurationErrorDescription",
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
  if (input.availability !== "available") {
    return {
      messageKey: "DashboardMarkets.earnProgram.unavailableStrategyTitle",
      descriptionKey: unavailableDescriptionKey(input.availability),
    };
  }
  return null;
}

function PreviewDetails({ strategy }: { strategy: EarnStrategy }) {
  const t = useTranslations();
  const locale = useLocale();
  return (
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
  );
}

function IosButtonPreview({
  accentColor,
  strategy,
  style,
}: {
  accentColor: string;
  strategy: EarnStrategy;
  style: EarnButtonStyle;
}) {
  const t = useTranslations();
  return (
    <figure aria-label={t("DashboardMarkets.earnProgram.iosPreview")} className="w-full">
      <figcaption className="sr-only">{t("DashboardMarkets.earnProgram.iosPreview")}</figcaption>
      <div className="mx-auto w-full max-w-[16.5rem] rounded-[3.15rem] bg-[#171719] p-[0.42rem] shadow-[0_24px_60px_rgba(0,0,0,0.24)] ring-1 ring-white/10">
        <div className="relative aspect-[390/844] overflow-hidden rounded-[2.75rem] bg-surface-raised">
          <div className="relative flex h-8 items-center justify-between px-5 pt-1 text-[9px] font-semibold text-primary">
            <span aria-hidden="true">9:41</span>
            <div
              aria-hidden="true"
              className="absolute top-1 left-1/2 h-5 w-[4.8rem] -translate-x-1/2 rounded-full bg-[#0d0d0e]"
            />
            <span aria-hidden="true" className="flex items-center gap-1">
              <SignalHighIcon className="size-2.5" />
              <WifiHighIcon className="size-2.5" />
              <BatteryFullIcon className="size-3" />
            </span>
          </div>

          <div className="flex h-[calc(100%-2rem)] flex-col px-4 pb-5">
            <div className="flex items-center justify-between border-b border-border-subtle py-3">
              <p className="text-sm font-medium text-primary">
                {t("DashboardMarkets.earnProgram.previewProduct")}
              </p>
              <span aria-hidden="true" className="size-7 rounded-full bg-fill-strong" />
            </div>

            <div className="flex flex-1 flex-col pt-5 pb-4">
              <div className="rounded-2xl border border-border-default bg-fill-subtle p-4 shadow-sm">
                <PreviewDetails strategy={strategy} />
                <div className="mt-6">
                  <EarnDepositButtonPreview
                    accentColor={accentColor}
                    className="w-full"
                    style={style}
                  />
                  <p className="mt-2 text-center text-[10px] text-tertiary">
                    {t("DashboardMarkets.earnProgram.poweredBy")}
                  </p>
                </div>
              </div>
              <div className="mt-4 space-y-2" aria-hidden="true">
                <div className="h-3 w-3/4 rounded-full bg-fill-subtle" />
                <div className="h-3 w-1/2 rounded-full bg-fill-subtle" />
              </div>
            </div>

            <div aria-hidden="true" className="mx-auto h-1 w-24 rounded-full bg-primary/80" />
          </div>
        </div>
      </div>
    </figure>
  );
}

function WebButtonPreview({
  accentColor,
  strategy,
  style,
}: {
  accentColor: string;
  strategy: EarnStrategy;
  style: EarnButtonStyle;
}) {
  const t = useTranslations();
  return (
    <figure aria-label={t("DashboardMarkets.earnProgram.webPreview")} className="w-full">
      <figcaption className="sr-only">{t("DashboardMarkets.earnProgram.webPreview")}</figcaption>
      <div className="mx-auto w-full max-w-4xl overflow-hidden rounded-xl border border-border-default bg-surface-raised shadow-[0_24px_60px_rgba(0,0,0,0.16)]">
        <div className="grid h-11 grid-cols-[1fr_minmax(10rem,22rem)_1fr] items-center gap-4 border-b border-border-subtle bg-fill-subtle px-4">
          <span aria-hidden="true" className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-fill-strong" />
            <span className="size-2.5 rounded-full bg-fill-strong" />
            <span className="size-2.5 rounded-full bg-fill-strong" />
          </span>
          <div className="flex min-w-0 items-center justify-center gap-1.5 rounded-md border border-border-subtle bg-surface-raised px-3 py-1.5 text-[10px] text-tertiary">
            <LockKeyholeIcon aria-hidden="true" className="size-2.5 shrink-0" />
            <span className="truncate">{t("DashboardMarkets.earnProgram.previewUrl")}</span>
          </div>
          <span />
        </div>

        <div className="flex min-h-[25rem] flex-col bg-surface-raised">
          <div className="flex h-12 items-center justify-between border-b border-border-subtle px-5">
            <p className="text-xs font-medium text-primary">
              {t("DashboardMarkets.earnProgram.previewProduct")}
            </p>
            <span aria-hidden="true" className="size-7 rounded-full bg-fill-strong" />
          </div>
          <div className="grid flex-1 place-items-center bg-fill-subtle p-6 sm:p-8">
            <div className="w-full max-w-md rounded-2xl border border-border-default bg-surface-raised p-6 shadow-sm">
              <PreviewDetails strategy={strategy} />
              <div className="mt-8">
                <EarnDepositButtonPreview
                  accentColor={accentColor}
                  className="w-full"
                  style={style}
                />
                <p className="mt-2 text-center text-[11px] text-tertiary">
                  {t("DashboardMarkets.earnProgram.poweredBy")}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </figure>
  );
}

type PreviewDevice = "ios" | "web";

function DevicePreview({
  accentColor,
  strategy,
  style,
}: {
  accentColor: string;
  strategy: EarnStrategy;
  style: EarnButtonStyle;
}) {
  const t = useTranslations();
  const [device, setDevice] = useState<PreviewDevice>("ios");
  const options = [
    {
      value: "ios" as const,
      label: t("DashboardMarkets.earnProgram.previewIos"),
      icon: SmartphoneIcon,
    },
    {
      value: "web" as const,
      label: t("DashboardMarkets.earnProgram.previewWeb"),
      icon: MonitorIcon,
    },
  ];

  return (
    <section className="border-t border-border-subtle pt-6">
      <fieldset className="mx-auto grid w-full max-w-xs grid-cols-2 gap-1 rounded-full bg-fill-subtle p-1">
        <legend className="sr-only">{t("DashboardMarkets.earnProgram.previewDevice")}</legend>
        {options.map((option) => {
          const selected = option.value === device;
          const Icon = option.icon;
          return (
            <button
              aria-pressed={selected}
              className={cn(
                "flex h-9 items-center justify-center gap-2 rounded-full px-4 text-xs font-medium transition-colors",
                selected
                  ? "bg-surface-raised text-primary shadow-sm"
                  : "text-secondary hover:text-primary"
              )}
              key={option.value}
              onClick={() => setDevice(option.value)}
              type="button"
            >
              <Icon aria-hidden="true" className="size-3.5" />
              {option.label}
            </button>
          );
        })}
      </fieldset>

      <div className="mt-5 flex min-h-[36rem] items-center justify-center overflow-hidden rounded-2xl border border-border-default bg-fill-subtle px-4 py-6 sm:px-8">
        {device === "ios" ? (
          <IosButtonPreview accentColor={accentColor} strategy={strategy} style={style} />
        ) : (
          <WebButtonPreview accentColor={accentColor} strategy={strategy} style={style} />
        )}
      </div>
    </section>
  );
}

function AppearanceStyleControls({
  accentColor,
  onAccentColorChange,
  onStyleChange,
  style,
}: {
  accentColor: string;
  onAccentColorChange: (accentColor: string) => void;
  onStyleChange: (style: EarnButtonStyle) => void;
  style: EarnButtonStyle;
}) {
  const t = useTranslations();
  const isPresetColor = ACCENT_COLOR_OPTIONS.some((option) => option.color === accentColor);
  return (
    <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
      <fieldset className="min-w-0">
        <legend className="mb-2 text-xs font-medium text-secondary">
          {t("DashboardMarkets.earnProgram.styleTitle")}
        </legend>
        <div className="grid w-full min-w-64 grid-cols-3 gap-1 rounded-full bg-fill-subtle p-1 sm:w-auto">
          {STYLE_OPTIONS.map((option) => {
            const selected = style === option.value;
            return (
              <label
                className={cn(
                  "flex h-9 cursor-pointer items-center justify-center rounded-full px-5 text-xs font-medium transition-colors",
                  selected
                    ? "bg-surface-raised text-primary shadow-sm"
                    : "text-secondary hover:text-primary"
                )}
                key={option.value}
              >
                <input
                  checked={selected}
                  className="sr-only"
                  name="earn-button-style"
                  onChange={() => onStyleChange(option.value)}
                  type="radio"
                  value={option.value}
                />
                {t(option.labelKey)}
              </label>
            );
          })}
        </div>
      </fieldset>

      {style === "accent" ? (
        <fieldset className="min-w-0">
          <legend className="mb-2 text-xs font-medium text-secondary">
            {t("DashboardMarkets.earnProgram.accentColor")}
          </legend>
          <div className="flex h-11 items-center gap-2 rounded-full border border-border-default bg-surface-raised px-2 shadow-sm">
            {ACCENT_COLOR_OPTIONS.map((option) => {
              const selected = accentColor === option.color;
              return (
                <button
                  aria-label={t(option.labelKey)}
                  aria-pressed={selected}
                  className={cn(
                    "size-7 rounded-full border border-black/10 transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2",
                    selected && "ring-2 ring-primary ring-offset-2 ring-offset-surface-raised"
                  )}
                  key={option.color}
                  onClick={() => onAccentColorChange(option.color)}
                  style={{ backgroundColor: option.color }}
                  type="button"
                />
              );
            })}
            <label
              className={cn(
                "relative flex size-7 cursor-pointer items-center justify-center rounded-full border border-border-default text-primary focus-within:outline-2 focus-within:outline-offset-2",
                !isPresetColor && "ring-2 ring-primary ring-offset-2 ring-offset-surface-raised"
              )}
              style={{ backgroundColor: accentColor }}
            >
              <PaletteIcon aria-hidden="true" className="size-3.5 text-white drop-shadow-sm" />
              <span className="sr-only">{t("DashboardMarkets.earnProgram.customAccentColor")}</span>
              <input
                aria-label={t("DashboardMarkets.earnProgram.customAccentColor")}
                className="absolute inset-0 cursor-pointer opacity-0"
                onChange={(event) => onAccentColorChange(event.currentTarget.value.toUpperCase())}
                type="color"
                value={accentColor}
              />
            </label>
            <span className="min-w-[4.5rem] text-center text-xs text-secondary tabular-nums">
              {accentColor}
            </span>
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}

function EngineeringHandoff({
  shareLink,
  sharePath,
}: {
  shareLink: string | null;
  sharePath: string | null;
}) {
  const t = useTranslations();
  const { copied, copy } = useCopy(1200);
  const hasShareLink = Boolean(shareLink && sharePath);

  return (
    <section className="rounded-xl border border-border-default bg-fill-subtle px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-primary">
              {t("DashboardMarkets.earnProgram.shareTitle")}
            </h3>
            <Badge variant="outline">{t("DashboardMarkets.earnProgram.handoffPublic")}</Badge>
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-secondary">
            {t("DashboardMarkets.earnProgram.shareDescription")}
          </p>
        </div>
      </div>

      {hasShareLink ? (
        <div className="mt-4 flex flex-col gap-3 rounded-lg border border-border-default bg-surface-raised px-3 py-3 sm:flex-row sm:items-center">
          <a
            className="min-w-0 flex-1 truncate text-sm text-primary underline-offset-4 hover:underline"
            href={sharePath ?? undefined}
            rel="noreferrer"
            target="_blank"
          >
            {shareLink}
          </a>
          <div className="flex shrink-0 gap-2">
            <Button
              iconLeft={copied ? <CheckIcon /> : <CopyIcon />}
              onClick={() => void copy(shareLink ?? "")}
              size="sm"
              variant="secondary"
            >
              {t(
                copied
                  ? "DashboardMarkets.earnProgram.copiedLink"
                  : "DashboardMarkets.earnProgram.copyLink"
              )}
            </Button>
            <Button asChild iconRight={<ExternalLinkIcon />} size="sm" variant="ghost">
              <a href={sharePath ?? undefined} rel="noreferrer" target="_blank">
                {t("DashboardMarkets.earnProgram.openLink")}
              </a>
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-4 text-xs font-medium text-secondary">
          {t("DashboardMarkets.earnProgram.unsavedHandoff")}
        </p>
      )}
    </section>
  );
}

function BuilderFooter({
  earnHref,
  hasUnsavedChanges,
  isSaving,
  onSave,
  saveError,
}: {
  earnHref: string;
  hasUnsavedChanges: boolean;
  isSaving: boolean;
  onSave: () => void;
  saveError: string | null;
}) {
  const t = useTranslations();
  return (
    <CardFooter className="flex-wrap gap-3 border-t border-border-default">
      <div className="min-w-0 flex-1">
        {saveError ? (
          <p className="text-xs text-error" role="alert">
            {t("DashboardMarkets.earnProgram.saveError", { error: saveError })}
          </p>
        ) : !hasUnsavedChanges ? (
          <p className="text-xs text-secondary">
            {t("DashboardMarkets.earnProgram.savedConfiguration")}
          </p>
        ) : null}
      </div>
      <Button asChild variant="secondary">
        <Link href={earnHref}>{t("DashboardMarkets.earnProgram.done")}</Link>
      </Button>
      <Button
        disabled={!hasUnsavedChanges || isSaving}
        iconLeft={isSaving ? <Loader2Icon className="animate-spin" /> : undefined}
        onClick={onSave}
      >
        {t(
          isSaving
            ? "DashboardMarkets.earnProgram.savingConfiguration"
            : "DashboardMarkets.earnProgram.saveConfiguration"
        )}
      </Button>
    </CardFooter>
  );
}

function EarnButtonBuilderSession({
  configurationLoad,
  earnHref,
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

  const selectedStrategyId = strategyId ?? savedConfiguration?.strategyId;
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

  // builderEmptyState has already rendered the named missing-strategy path.
  // This explicit invariant preserves that UX while narrowing for callbacks.
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
      const result = await saveEarnButtonConfiguration({
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
            <AppearanceStyleControls
              accentColor={accentColor}
              onAccentColorChange={(nextAccentColor) => {
                dispatch({ type: "accentColorChanged", accentColor: nextAccentColor });
              }}
              onStyleChange={(nextStyle) => {
                dispatch({ type: "styleChanged", style: nextStyle });
              }}
              style={style}
            />

            <DevicePreview accentColor={accentColor} strategy={availableStrategy} style={style} />
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
            <EngineeringHandoff shareLink={shareLink} sharePath={sharePath} />

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
          <BuilderFooter
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

export function EarnButtonBuilder(props: EarnButtonBuilderProps) {
  return (
    <EarnButtonBuilderSession {...props} key={configurationStateKey(props.configurationLoad)} />
  );
}
