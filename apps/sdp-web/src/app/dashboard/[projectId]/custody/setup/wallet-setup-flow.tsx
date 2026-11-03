"use client";

import type { SdpEnvironment } from "@sdp/types/api-keys";
import {
  type ByokCustodyProvider,
  type CustodyMode,
  type CustodyWalletPurpose,
  isByokCustodyProvider,
} from "@sdp/types/custody";
import { Button } from "@sdp/ui/button";
import { cn } from "@sdp/ui/cn";
import { InfoHint } from "@sdp/ui/info-hint";
import { Input } from "@sdp/ui/input";
import { Label } from "@sdp/ui/label";
import { Select, SelectItem } from "@sdp/ui/select";
import { useRouter } from "next/navigation";
import {
  type ComponentProps,
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";
import {
  createCustodySetupWalletAction,
  initializeCustodySetupAction,
} from "@/app/dashboard/[projectId]/custody/actions";
import type { CustodyConnectionListItem } from "@/app/dashboard/[projectId]/custody/connections/connections.data";
import { custodyQueryKeys } from "@/app/dashboard/[projectId]/custody/custody-query-key";
import {
  type CustodyProviderCatalogEntry,
  getCustodyProviderEntry,
  type KnownCustodyProvider,
} from "@/app/dashboard/[projectId]/custody/provider-catalog";
import {
  type CustodyProviderAvailability,
  resolveCustodyProviderAvailability,
} from "@/app/dashboard/[projectId]/custody/provider-display-status";
import { ByokCredentialForm } from "@/app/dashboard/[projectId]/custody/setup/privy-credential-form";
import { useWalletInventoryRefresh } from "@/app/dashboard/[projectId]/custody/use-wallet-inventory-refresh";
import { WalletProviderMark } from "@/app/dashboard/[projectId]/custody/wallet-provider-mark";
import {
  isWalletPurposeOffered,
  type WalletPurposeFlags,
} from "@/app/dashboard/[projectId]/custody/wallet-purposes";
import { WizardFrame } from "@/components/wizard-frame";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { invalidateQuickStartStatus } from "@/lib/dashboard-quick-start";
import type {
  AvailableCustodyModes,
  ProjectCustodyAvailability,
} from "@/lib/provider-availability";
import { useActionIdempotencyKey } from "@/lib/use-action-idempotency-key";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { useStepFade } from "@/lib/use-step-fade";

const DETAILS_FORM_ID = "wallet-details-form";
const FOOTER_HINT_ID = "wallet-setup-footer-hint";
const WALLET_TARGET_FIELD = "walletTarget";
const MANAGED_WALLET_TARGET = "managed";
const ENVIRONMENT_LABEL_KEYS = {
  sandbox: "DashboardCustody.sandbox",
  production: "DashboardCustody.production",
} as const satisfies Record<SdpEnvironment, MessageKey>;
const CUSTODY_MODE_CHOICES = {
  managed: {
    titleKey: "DashboardCustody.walletSetupModeManagedTitle",
    descriptionKey: "DashboardCustody.walletSetupModeManagedDescription",
  },
  byok: {
    titleKey: "DashboardCustody.walletSetupModeByokTitle",
    descriptionKey: "DashboardCustody.walletSetupModeByokDescription",
  },
} as const satisfies Record<CustodyMode, { titleKey: MessageKey; descriptionKey: MessageKey }>;

/**
 * The purposes the create endpoint accepts, in the order the picker lists them. The picker
 * offers only those whose module runs here (`isWalletPurposeOffered`).
 */
const WALLET_PURPOSES = [
  { value: "transfer", labelKey: "DashboardCustody.transfers" },
  { value: "mint_authority", labelKey: "DashboardCustody.mintAuthority" },
  { value: "freeze_authority", labelKey: "DashboardCustody.freezeAuthority" },
  { value: "fee_payer", labelKey: "DashboardCustody.feePayer" },
] as const satisfies readonly { value: CustodyWalletPurpose; labelKey: MessageKey }[];

type WalletPurposeOption = (typeof WALLET_PURPOSES)[number];

/** `choose` lists the purposes, `fixed` sends the only one, `none` sends none (a first wallet). */
type PurposeField = "choose" | "fixed" | "none";

/**
 * How the details form handles the purpose. A provider's first wallet is always a transfer
 * wallet; after it, a purpose is a choice only when more than one is offered.
 */
function resolvePurposeField(isConnected: boolean, offeredCount: number): PurposeField {
  if (!isConnected) {
    return "none";
  }
  return offeredCount > 1 ? "choose" : "fixed";
}

/** The purpose the wallet gets without a choice, which the summary names; `null` when chosen. */
function resolveFixedPurpose(
  field: PurposeField,
  offered: readonly WalletPurposeOption[]
): WalletPurposeOption | null {
  if (field === "choose") {
    return null;
  }
  if (field === "fixed") {
    return offered[0] ?? null;
  }
  return WALLET_PURPOSES[0];
}

/** Data attributes the flow's tests and the e2e suite key off. */
type DataAttributes = { [attribute: `data-${string}`]: string };

// Keep Enter available to controls that own it (newlines, option selection,
// navigation, and action buttons), and off the choice lists: picking an answer
// is not confirming the wallet.
function ignoresEnterToSubmit(target: HTMLElement): boolean {
  if (target.isContentEditable) {
    return true;
  }
  if (target instanceof HTMLInputElement && target.type === "radio") {
    return true;
  }
  const tagName = target.tagName;
  if (
    tagName === "TEXTAREA" ||
    tagName === "SELECT" ||
    tagName === "A" ||
    tagName === "SUMMARY" ||
    tagName === "BUTTON"
  ) {
    return true;
  }
  const role = target.getAttribute("role");
  if (
    role === "button" ||
    role === "combobox" ||
    role === "listbox" ||
    role === "option" ||
    role === "menu" ||
    role === "menuitem"
  ) {
    return true;
  }
  return target.getAttribute("aria-haspopup") !== null;
}

interface WalletSetupFlowProps {
  connectedProviders: KnownCustodyProvider[];
  /** The custody providers the project can use, each with the modes it may be set up in. */
  custodyAvailability: ProjectCustodyAvailability[];
  environment: SdpEnvironment;
  initialProvider: KnownCustodyProvider | null;
  /**
   * Connections the wallet can be created in. Offered only for a provider whose
   * modes include `byok`, and empty whenever the project has none or the reader
   * lacks `custody:admin`; in each case the flow keeps its Managed shape.
   */
  connections: CustodyConnectionListItem[];
}

/**
 * The mode a provider that is not set up yet gets set up in: its only mode, or the user's
 * choice when it offers more than one.
 *
 * @param input - What the selected provider offers and what the user chose.
 * @returns The setup mode, or `null` while the user still has to choose.
 */
function resolveSetupMode(input: {
  modes: AvailableCustodyModes;
  chosenMode: CustodyMode | null;
}): CustodyMode | null {
  const [firstMode, ...otherModes] = input.modes;
  return otherModes.length === 0 ? firstMode : input.chosenMode;
}

/** Only an active connection holds verified credentials, so only it can take a wallet. */
function isSelectableConnection(connection: CustodyConnectionListItem): boolean {
  return connection.status === "active";
}

/**
 * Moves the picker's choice onto the field the create action reads: a connection id as
 * `connectionId`, and Managed as no connection at all, so the action names the provider's
 * Managed config.
 *
 * @param formData - The submitted details form, edited in place.
 * @returns False when the user has not picked where the wallet lives.
 */
function applyWalletTarget(formData: FormData): boolean {
  const walletTarget = formData.get(WALLET_TARGET_FIELD);
  formData.delete(WALLET_TARGET_FIELD);
  if (typeof walletTarget !== "string" || walletTarget === "") {
    return false;
  }
  if (walletTarget !== MANAGED_WALLET_TARGET) {
    formData.set("connectionId", walletTarget);
  }
  return true;
}

/** A field label with its info hint, as the design sets every question. */
function FieldLabel({ htmlFor, label, hint }: { htmlFor?: string; label: string; hint: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      <InfoHint text={hint} />
    </div>
  );
}

/**
 * One answer in a choice list: a radio row with its title, a line of description and the
 * ring. Rows are locked while a setup request is in flight: switching the answer would unmount
 * the credential form that holds the request's only way to recover.
 */
function ChoiceRow({
  attributes,
  checked,
  description,
  disabled,
  first,
  id,
  leading,
  name,
  onSelect,
  title,
  trailing,
  value,
}: {
  attributes: DataAttributes;
  checked: boolean;
  description: string;
  disabled: boolean;
  first: boolean;
  id: string;
  leading?: ReactNode;
  name: string;
  onSelect: () => void;
  title: string;
  trailing?: ReactNode;
  value: string;
}) {
  const descriptionId = `${id}-description`;
  return (
    <label
      className={cn(
        "flex items-center gap-3 px-4 py-3",
        !first && "border-t border-border-subtle",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
      )}
      {...attributes}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        className="peer sr-only"
        aria-describedby={descriptionId}
      />
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block text-nav leading-4.5 text-primary">{title}</span>
        <span id={descriptionId} className="block text-body leading-4.5 text-secondary">
          {description}
        </span>
      </span>
      {trailing}
      {/* The visible radio: a ring, filled to a thick ink ring when chosen. */}
      <span
        aria-hidden="true"
        className={cn(
          "size-4 shrink-0 rounded-full border border-border-strong transition-[border-width] motion-reduce:transition-none",
          "peer-checked:border-[5px] peer-checked:border-primary",
          "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary"
        )}
      />
    </label>
  );
}

/** A question answered by one of its rows: the question, an optional line under it, the rows. */
function ChoiceList({
  children,
  description,
  legend,
  listAttributes,
}: {
  children: ReactNode;
  description?: string;
  legend: string;
  listAttributes: DataAttributes;
}) {
  return (
    <fieldset>
      <legend className="text-nav font-medium text-primary">{legend}</legend>
      {description ? <p className="mt-1 text-body text-secondary">{description}</p> : null}
      <div
        className="mt-3 overflow-hidden rounded-card border border-border-default bg-surface-tile"
        {...listAttributes}
      >
        {children}
      </div>
    </fieldset>
  );
}

/** The usable providers, connected first; asked only when there is more than one. */
function ProviderChoice({
  choices,
  disabled,
  onSelect,
  selectedProvider,
  t,
}: {
  choices: CustodyProviderAvailability[];
  disabled: boolean;
  onSelect: (provider: KnownCustodyProvider) => void;
  selectedProvider: KnownCustodyProvider | null;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <ChoiceList
      legend={t("DashboardCustody.walletSetupProviderTitle")}
      description={t("DashboardCustody.walletSetupProviderDescription")}
      listAttributes={{ "data-wallet-provider-list": "" }}
    >
      {choices.map((provider, index) => (
        <ChoiceRow
          key={provider.entry.id}
          attributes={{ "data-wallet-provider": provider.entry.id }}
          checked={selectedProvider === provider.entry.id}
          description={t(provider.entry.descriptionKey)}
          disabled={disabled}
          first={index === 0}
          id={`wallet-provider-${provider.entry.id}`}
          leading={
            <span className="inline-flex">
              <WalletProviderMark provider={provider.entry.id} size="row" />
            </span>
          }
          name="provider"
          onSelect={() => onSelect(provider.entry.id)}
          title={provider.entry.label}
          trailing={
            provider.status === "active" ? (
              <span className="shrink-0 text-body text-tertiary">
                {t("DashboardCustody.active")}
              </span>
            ) : null
          }
          value={provider.entry.id}
        />
      ))}
    </ChoiceList>
  );
}

/**
 * Asks whose account holds the keys, for a provider the project may set up either way: SDP's
 * account (Managed) or the project's own (BYOK). Nothing is preselected.
 */
function CustodyModeChoice({
  disabled,
  mode,
  modes,
  onModeChange,
  providerLabel,
  t,
}: {
  disabled: boolean;
  mode: CustodyMode | null;
  modes: AvailableCustodyModes;
  onModeChange: (mode: CustodyMode) => void;
  providerLabel: string;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <ChoiceList
      legend={t("DashboardCustody.walletSetupModeQuestion", { provider: providerLabel })}
      listAttributes={{ "data-wallet-mode-list": "" }}
    >
      {modes.map((option, index) => (
        <ChoiceRow
          key={option}
          attributes={{ "data-wallet-mode": option }}
          checked={mode === option}
          description={t(CUSTODY_MODE_CHOICES[option].descriptionKey)}
          disabled={disabled}
          first={index === 0}
          id={`wallet-mode-${option}`}
          name="custodyMode"
          onSelect={() => onModeChange(option)}
          title={t(CUSTODY_MODE_CHOICES[option].titleKey, { provider: providerLabel })}
          value={option}
        />
      ))}
    </ChoiceList>
  );
}

/**
 * The wallet's label. It sits outside the form it submits with (`form`), so it stays put while
 * the answers above it change which form that is: the details form, or the credential form.
 */
function WalletLabelField({
  disabled,
  name,
  onChange,
  t,
  value,
}: {
  disabled: boolean;
  name: "label" | "walletLabel";
  onChange: (value: string) => void;
  t: ReturnType<typeof useTranslations>;
  value: string;
}) {
  return (
    <div className="space-y-2">
      <FieldLabel
        htmlFor="wallet-label"
        label={t("DashboardCustody.walletLabel")}
        hint={t("DashboardCustody.walletLabelHint")}
      />
      <Input
        id="wallet-label"
        form={DETAILS_FORM_ID}
        name={name}
        size="xl"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={t("DashboardCustody.newDesign.walletLabelPlaceholder")}
        maxLength={100}
        required
        disabled={disabled}
      />
    </div>
  );
}

/**
 * Picks the provider account a new wallet is created in: the provider's Managed config, when
 * the project has one, or one of its connections.
 *
 * Nothing is preselected. There is no default custody, so the user names the account every
 * time, even when only one is selectable.
 *
 * Unusable connections stay on the list, disabled and annotated, rather than
 * being filtered out: a user who came here to add a wallet to the connection
 * they just set up needs to see that it is there but not ready yet, not to
 * find it missing.
 */
function WalletConnectionField({
  connections,
  hasManagedConfig,
  t,
}: {
  connections: CustodyConnectionListItem[];
  hasManagedConfig: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const annotate = (connection: CustodyConnectionListItem): string | null => {
    if (isSelectableConnection(connection)) {
      return null;
    }
    return connection.status === "failed"
      ? t("DashboardCustody.walletSetupConnectionUnavailableFailed")
      : t("DashboardCustody.walletSetupConnectionUnavailablePending");
  };

  return (
    <div className="space-y-2">
      <FieldLabel
        label={t("DashboardCustody.walletSetupConnection")}
        hint={t("DashboardCustody.walletSetupConnectionHint")}
      />
      <Select
        name={WALLET_TARGET_FIELD}
        ariaLabel={t("DashboardCustody.walletSetupConnection")}
        placeholder={t("DashboardCustody.walletSetupConnectionPlaceholder")}
        size="xl"
      >
        {hasManagedConfig ? (
          <SelectItem value={MANAGED_WALLET_TARGET}>
            {t("DashboardCustody.walletSetupConnectionManaged")}
          </SelectItem>
        ) : null}
        {connections.map((connection) => {
          const annotation = annotate(connection);
          return (
            <SelectItem
              key={connection.id}
              value={connection.id}
              disabled={!isSelectableConnection(connection)}
            >
              {annotation ? `${connection.label} · ${annotation}` : connection.label}
            </SelectItem>
          );
        })}
      </Select>
    </div>
  );
}

/**
 * The form a Managed setup or another wallet submits: the provider, the purpose when there is
 * one to choose (or the only one offered), and the account when there is one to choose. The
 * label joins it from outside (`WalletLabelField`).
 */
function WalletDetailsForm({
  connectionOptions,
  hasManagedConfig,
  onSubmit,
  providerId,
  purposeField,
  purposes,
  showConnectionPicker,
  t,
}: {
  connectionOptions: CustodyConnectionListItem[];
  hasManagedConfig: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  providerId: KnownCustodyProvider;
  purposeField: PurposeField;
  purposes: readonly WalletPurposeOption[];
  showConnectionPicker: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const [onlyPurpose] = purposes;
  return (
    <form id={DETAILS_FORM_ID} onSubmit={onSubmit} className="space-y-6">
      <input type="hidden" name="provider" value={providerId} />
      {purposeField === "fixed" && onlyPurpose ? (
        <input type="hidden" name="purpose" value={onlyPurpose.value} />
      ) : null}
      {purposeField === "choose" ? (
        <div className="space-y-2">
          <FieldLabel
            label={t("DashboardCustody.purpose")}
            hint={t("DashboardCustody.walletPurposeHint")}
          />
          <Select
            name="purpose"
            ariaLabel={t("DashboardCustody.purpose")}
            defaultValue="transfer"
            size="xl"
          >
            {purposes.map((purpose) => (
              <SelectItem key={purpose.value} value={purpose.value}>
                {t(purpose.labelKey)}
              </SelectItem>
            ))}
          </Select>
        </div>
      ) : null}
      {showConnectionPicker ? (
        <WalletConnectionField
          connections={connectionOptions}
          hasManagedConfig={hasManagedConfig}
          t={t}
        />
      ) : null}
    </form>
  );
}

/** What the wallet is created with: the provider, a purpose that is not a choice, where it lives. */
function CreatedWithSummary({
  environment,
  fixedPurposeLabel,
  providerLabel,
  t,
}: {
  environment: SdpEnvironment;
  fixedPurposeLabel: string | null;
  providerLabel: string | null;
  t: ReturnType<typeof useTranslations>;
}) {
  const { projects, selectedProjectId } = useDashboardWorkspace();
  const cluster = useSolanaCluster();
  const projectName =
    projects.find((project) => project.id === selectedProjectId)?.name ??
    t("DashboardCustody.projectValue");
  const environmentLabel = `${t(ENVIRONMENT_LABEL_KEYS[environment])} · ${
    cluster === "mainnet-beta" ? "mainnet" : cluster
  }`;
  const rowClassName =
    "flex h-12 items-center justify-between gap-4 border-b border-border-subtle last:border-b-0";

  return (
    <section aria-labelledby="wallet-created-with">
      <h3 id="wallet-created-with" className="text-nav font-medium text-primary">
        {t("DashboardCustody.walletSetupCreatedWith")}
      </h3>
      <dl className="mt-2">
        <div className={rowClassName}>
          <dt className="text-body text-secondary">{t("DashboardCustody.walletSetupProvider")}</dt>
          <dd className={cn("text-body", providerLabel ? "text-primary" : "text-tertiary")}>
            {providerLabel ?? t("DashboardCustody.walletSetupProviderNotChosen")}
          </dd>
        </div>
        {fixedPurposeLabel ? (
          <div className={rowClassName}>
            <dt className="text-body text-secondary">{t("DashboardCustody.purpose")}</dt>
            <dd className="text-body text-primary">{fixedPurposeLabel}</dd>
          </div>
        ) : null}
        <div className={rowClassName}>
          <dt className="flex items-center gap-1.5 text-body text-secondary">
            {t("DashboardCustody.project")}
            <InfoHint text={t("DashboardCustody.walletSetupProjectHint")} />
          </dt>
          <dd className="min-w-0 truncate text-body text-primary">{projectName}</dd>
        </div>
        <div className={rowClassName}>
          <dt className="flex items-center gap-1.5 text-body text-secondary">
            {t("DashboardCustody.environment")}
            <InfoHint text={t("DashboardCustody.walletSetupEnvironmentHint")} />
          </dt>
          <dd className="text-body text-primary">{environmentLabel}</dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * The footer band: what confirming does, or what is still missing, then Cancel and the primary.
 * A primary that cannot run yet is outlined, as the design draws it; the line beside it names
 * the reason.
 */
function SetupFooter({
  cancelDisabled,
  hint,
  onCancel,
  primary,
  showCancel,
  t,
}: {
  cancelDisabled: boolean;
  hint: string | null;
  onCancel: () => void;
  primary: ReactNode;
  showCancel: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
      {hint ? (
        <p id={FOOTER_HINT_ID} className="min-w-0 text-body text-secondary sm:flex-1">
          {hint}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-4 sm:ml-auto">
        {showCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={cancelDisabled}>
            {t("DashboardCustody.cancel")}
          </Button>
        ) : null}
        {primary}
      </div>
    </div>
  );
}

/**
 * The provider the flow opens on: the requested one when the project can use it, else the
 * only one there is. With several and no request, the user picks.
 */
function resolveInitialProvider(input: {
  availability: CustodyProviderAvailability[];
  initialProvider: KnownCustodyProvider | null;
}): KnownCustodyProvider | null {
  const { availability, initialProvider } = input;
  const requested = availability.find((provider) => provider.entry.id === initialProvider);
  if (requested) {
    return requested.entry.id;
  }
  const [onlyProvider, ...others] = availability;
  return onlyProvider !== undefined && others.length === 0 ? onlyProvider.entry.id : null;
}

interface SetupOptions {
  /** The BYOK provider whose credential form the flow shows, or `null` when it shows none. */
  byokSetupProvider: ByokCustodyProvider | null;
  connectionOptions: CustodyConnectionListItem[];
  hasManagedConfig: boolean;
  isConnected: boolean;
  setupMode: CustodyMode | null;
  /** The modes the user picks between, or `null` when the flow picks the mode itself. */
  modeChoices: AvailableCustodyModes | null;
}

/**
 * What the flow offers for the selected provider, from its modes, its Managed config and the
 * project's connections. Managed is offered only where the modes include `managed`; connections
 * are BYOK custody, so a provider whose modes leave out `byok` offers none.
 *
 * Switching provider must not carry the previous provider's connections along, so the list is
 * narrowed here rather than trusted as delivered. The availability status comes from Managed
 * configs; a BYOK-only project has none, so an active connection also shows the provider is
 * installed. Without either, the flow sets the provider up first.
 */
function resolveSetupOptions(input: {
  selectedAvailability: CustodyProviderAvailability | null;
  connections: CustodyConnectionListItem[];
  chosenMode: CustodyMode | null;
}): SetupOptions {
  const { selectedAvailability, connections, chosenMode } = input;
  if (selectedAvailability === null) {
    return {
      byokSetupProvider: null,
      connectionOptions: [],
      hasManagedConfig: false,
      isConnected: false,
      setupMode: null,
      modeChoices: null,
    };
  }
  const offersManaged = selectedAvailability.modes.includes("managed");
  const offersByok = selectedAvailability.modes.includes("byok");
  const connectionOptions = offersByok
    ? connections.filter((connection) => connection.provider === selectedAvailability.entry.id)
    : [];
  const hasManagedConfig = offersManaged && selectedAvailability.status === "active";
  const isConnected = hasManagedConfig || connectionOptions.some(isSelectableConnection);
  const setupMode = resolveSetupMode({ modes: selectedAvailability.modes, chosenMode });
  const providerId = selectedAvailability.entry.id;
  return {
    byokSetupProvider:
      !isConnected && setupMode === "byok" && isByokCustodyProvider(providerId) ? providerId : null,
    connectionOptions,
    hasManagedConfig,
    isConnected,
    setupMode,
    modeChoices: !isConnected && offersManaged && offersByok ? selectedAvailability.modes : null,
  };
}

/**
 * The line beside the primary: what is still missing, in the order the page asks for it, or
 * what confirming does once nothing is.
 */
function setupHint(input: {
  awaitingModeChoice: boolean;
  canProvisionWallet: boolean;
  isByokDetails: boolean;
  labelMissing: boolean;
  providerLabel: string | null;
  t: ReturnType<typeof useTranslations>;
}): string {
  const { awaitingModeChoice, canProvisionWallet, isByokDetails, labelMissing, providerLabel, t } =
    input;
  if (providerLabel === null) {
    return t("DashboardCustody.chooseEnabledProvider");
  }
  if (awaitingModeChoice) {
    return t("DashboardCustody.walletSetupModeRequired", { provider: providerLabel });
  }
  if (!(isByokDetails || canProvisionWallet)) {
    return t("DashboardCustody.connectedProviderDescription", { provider: providerLabel });
  }
  if (labelMissing) {
    return t("DashboardCustody.walletSetupLabelRequired");
  }
  return t("DashboardCustody.walletSetupConfirmHint", { provider: providerLabel });
}

/**
 * Enter anywhere in the flow submits its form, as the primary would, except where Enter
 * already means something (a textarea, a button, a link, a choice).
 */
function useEnterSubmitsForm() {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.key !== "Enter" ||
        event.repeat ||
        event.shiftKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.isComposing ||
        event.defaultPrevented
      ) {
        return;
      }
      const target = event.target;
      if (
        !(target instanceof HTMLElement) ||
        !target.closest("[data-wallet-setup-flow]") ||
        ignoresEnterToSubmit(target)
      ) {
        return;
      }

      event.preventDefault();
      const form = document.getElementById(DETAILS_FORM_ID);
      if (form instanceof HTMLFormElement) {
        form.requestSubmit();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}

/**
 * Submits the details form: checks it, names where the wallet lives, runs the create or initialize
 * action, and on success marks the quick-start step and hands the new wallet to `onCreated`.
 * A refusal lands in `setErrorMessage`.
 */
function useCreateWallet({
  canSubmit,
  formAction,
  onCreated,
  setErrorMessage,
  showConnectionPicker,
}: {
  canSubmit: boolean;
  formAction: typeof createCustodySetupWalletAction | typeof initializeCustodySetupAction;
  onCreated: (walletId: string) => void;
  setErrorMessage: (message: string | null) => void;
  showConnectionPicker: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const refreshWalletInventory = useWalletInventoryRefresh();
  const { selectedProjectId } = useDashboardWorkspace();
  const [isPending, startTransition] = useTransition();
  const submissionInFlightRef = useRef(false);
  const setupKey = useActionIdempotencyKey(custodyQueryKeys.isWalletInventoryKey);

  const createWallet = (form: HTMLFormElement) => {
    if (submissionInFlightRef.current || !form.reportValidity() || !canSubmit || isPending) {
      return;
    }

    const formData = new FormData(form);
    if (showConnectionPicker && !applyWalletTarget(formData)) {
      setErrorMessage(t("DashboardCustody.walletSetupConnectionRequired"));
      return;
    }

    submissionInFlightRef.current = true;
    setErrorMessage(null);
    // One key per submitted setup: the same details keep it across retries.
    // The project is part of it: a setup's key is the API's per project, so a
    // lost answer in one project is never settled by the same form in another.
    const input = JSON.stringify([
      selectedProjectId,
      formAction === initializeCustodySetupAction,
      [...formData.entries()].map(([k, v]) => [k, String(v)]),
    ]);
    const key = setupKey.keyFor(input);
    formData.set("idempotencyKey", key);

    startTransition(async () => {
      try {
        let result: Awaited<ReturnType<typeof formAction>>;
        try {
          result = await formAction(formData);
        } catch {
          // No answer: the call may have reached the server. The key stays and the form stays,
          // so Create wallet again resends the same request under the same key.
          setupKey.settled(input, key, { status: "error" });
          // The wallet may exist: the inventory is refreshed so the list shows it.
          refreshWalletInventory();
          setErrorMessage(t("DashboardCustody.walletSetupOutcomeUnknown"));
          return;
        }
        setupKey.settled(input, key, result);

        switch (result.status) {
          case "error":
            // A refusal may follow an earlier attempt that did create the
            // wallet, so the inventory is refreshed before the user retries.
            refreshWalletInventory();
            setErrorMessage(result.message);
            return;
          case "provider_already_set_up":
            setErrorMessage(t("DashboardCustody.walletSetupProviderAlreadySetUp"));
            router.refresh();
            return;
          case "success":
            break;
          default: {
            const unhandledResult: never = result;
            throw new Error(`Unhandled wallet setup result: ${JSON.stringify(unhandledResult)}`);
          }
        }

        if (selectedProjectId) {
          invalidateQuickStartStatus();
        }
        refreshWalletInventory();
        // The action revalidated the wallet pages, so the flow leaves without refreshing
        // itself: a refresh would only re-run this page's reads on the way out.
        onCreated(result.walletId);
      } finally {
        submissionInFlightRef.current = false;
      }
    });
  };

  return { createWallet, isPending };
}

interface WalletSetupModel extends SetupOptions {
  awaitingModeChoice: boolean;
  canProvisionWallet: boolean;
  /** The purpose the summary names because it is not a choice; `null` while it is. */
  fixedPurpose: WalletPurposeOption | null;
  isByokDetails: boolean;
  labelMissing: boolean;
  providerEntry: CustodyProviderCatalogEntry | null;
  purposeField: PurposeField;
  purposes: readonly WalletPurposeOption[];
  showConnectionPicker: boolean;
  showLabelField: boolean;
}

/**
 * Everything the screen derives from its answers: what the selected provider offers, which
 * question is still open, what the form sends and what the summary names.
 */
function resolveWalletSetupModel(input: {
  availability: CustodyProviderAvailability[];
  chosenMode: CustodyMode | null;
  connections: CustodyConnectionListItem[];
  flags: WalletPurposeFlags;
  selectedProvider: KnownCustodyProvider | null;
  walletLabel: string;
}): WalletSetupModel {
  const selectedAvailability =
    input.availability.find((provider) => provider.entry.id === input.selectedProvider) ?? null;
  const options = resolveSetupOptions({
    selectedAvailability,
    connections: input.connections,
    chosenMode: input.chosenMode,
  });
  const providerEntry = selectedAvailability === null ? null : selectedAvailability.entry;
  const purposes = WALLET_PURPOSES.filter((purpose) =>
    isWalletPurposeOffered(purpose.value, input.flags)
  );
  const purposeField = resolvePurposeField(options.isConnected, purposes.length);
  // Fireblocks names no wallet at setup: its vault accounts arrive with their own names.
  const showLabelField = options.byokSetupProvider !== "fireblocks";
  const canProvisionWallet =
    providerEntry !== null &&
    (options.isConnected
      ? providerEntry.supportsAdditionalWallets
      : options.setupMode === "managed");
  return {
    ...options,
    awaitingModeChoice: options.modeChoices !== null && options.setupMode === null,
    canProvisionWallet,
    fixedPurpose: providerEntry === null ? null : resolveFixedPurpose(purposeField, purposes),
    isByokDetails: options.byokSetupProvider !== null,
    labelMissing: showLabelField && input.walletLabel.trim().length === 0,
    providerEntry,
    purposeField,
    purposes,
    showConnectionPicker:
      options.isConnected && options.connectionOptions.some(isSelectableConnection),
    showLabelField,
  };
}

/** The footer's primary: the credential check for a BYOK setup, Create wallet otherwise. */
function SetupPrimary({
  byokPending,
  canConnect,
  canCreate,
  isByokDetails,
  isPending,
  t,
}: {
  byokPending: boolean;
  canConnect: boolean;
  canCreate: boolean;
  isByokDetails: boolean;
  isPending: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  if (isByokDetails) {
    return (
      <Button
        type="submit"
        form={DETAILS_FORM_ID}
        variant={canConnect ? "default" : "outline"}
        disabled={!canConnect}
        loading={byokPending}
        aria-describedby={FOOTER_HINT_ID}
      >
        {t("DashboardCustody.byokConnect")}
      </Button>
    );
  }
  return (
    <Button
      type="submit"
      form={DETAILS_FORM_ID}
      variant={canCreate ? "default" : "outline"}
      disabled={!canCreate}
      loading={isPending}
      aria-describedby={FOOTER_HINT_ID}
    >
      {t("DashboardCustody.createWallet")}
    </Button>
  );
}

type CredentialFormHandlers = Pick<
  ComponentProps<typeof ByokCredentialForm>,
  "onPendingChange" | "onReadyChange" | "onRecoveryChange" | "onRecoveryLockChange"
>;

/**
 * The screen under the title: the provider and custody questions when they are open, the label,
 * the form the answers call for, what the wallet is created with, and a refusal.
 */
function WalletSetupBody({
  answersLocked,
  chosenMode,
  credentialFormHandlers,
  environment,
  errorMessage,
  model,
  onConnected,
  onDetailsSubmit,
  onModeChange,
  onProviderChange,
  onWalletLabelChange,
  providerChoices,
  selectedProvider,
  t,
  walletLabel,
}: {
  answersLocked: boolean;
  chosenMode: CustodyMode | null;
  credentialFormHandlers: CredentialFormHandlers;
  environment: SdpEnvironment;
  errorMessage: string | null;
  model: WalletSetupModel;
  /** A BYOK setup settled: the credentials check passed and the provider is connected. */
  onConnected: (provider: ByokCustodyProvider) => void;
  onDetailsSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onModeChange: (mode: CustodyMode) => void;
  onProviderChange: (provider: KnownCustodyProvider) => void;
  onWalletLabelChange: (value: string) => void;
  providerChoices: CustodyProviderAvailability[];
  selectedProvider: KnownCustodyProvider | null;
  t: ReturnType<typeof useTranslations>;
  walletLabel: string;
}) {
  const providerLabel = model.providerEntry === null ? null : model.providerEntry.label;
  // What the answers reveal below them fades in, rather than appearing at full strength.
  const revealRef = useStepFade<HTMLDivElement>(
    `${selectedProvider ?? ""}:${model.setupMode ?? ""}`
  );
  const byokProvider = model.byokSetupProvider;
  // The details form waits for a provider and its custody answer; BYOK has its own form.
  const detailsProvider =
    byokProvider === null && !model.awaitingModeChoice ? model.providerEntry : null;

  return (
    <div className="space-y-8">
      {providerChoices.length > 1 ? (
        <ProviderChoice
          choices={providerChoices}
          disabled={answersLocked}
          onSelect={onProviderChange}
          selectedProvider={selectedProvider}
          t={t}
        />
      ) : null}
      {model.modeChoices !== null && providerLabel !== null ? (
        <CustodyModeChoice
          disabled={answersLocked}
          mode={chosenMode}
          modes={model.modeChoices}
          onModeChange={onModeChange}
          providerLabel={providerLabel}
          t={t}
        />
      ) : null}
      <div className="space-y-6">
        {model.showLabelField ? (
          <WalletLabelField
            disabled={answersLocked}
            name={model.isConnected ? "label" : "walletLabel"}
            onChange={onWalletLabelChange}
            t={t}
            value={walletLabel}
          />
        ) : null}
        {/* One form owns DETAILS_FORM_ID at a time: the credential form or the details. */}
        <div ref={revealRef}>
          {byokProvider !== null ? (
            <ByokCredentialForm
              {...credentialFormHandlers}
              provider={byokProvider}
              formId={DETAILS_FORM_ID}
              hostsWalletLabel
              showSubmitButton={false}
              onSuccess={() => onConnected(byokProvider)}
            />
          ) : null}
          {detailsProvider !== null ? (
            <WalletDetailsForm
              connectionOptions={model.connectionOptions}
              hasManagedConfig={model.hasManagedConfig}
              onSubmit={onDetailsSubmit}
              providerId={detailsProvider.id}
              purposeField={model.purposeField}
              purposes={model.purposes}
              showConnectionPicker={model.showConnectionPicker}
              t={t}
            />
          ) : null}
        </div>
      </div>
      <CreatedWithSummary
        environment={environment}
        fixedPurposeLabel={model.fixedPurpose ? t(model.fixedPurpose.labelKey) : null}
        providerLabel={providerLabel}
        t={t}
      />
      {errorMessage ? (
        <p role="alert" className="text-body text-error">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}

export function WalletSetupFlow({
  connectedProviders,
  custodyAvailability,
  environment,
  initialProvider,
  connections,
}: WalletSetupFlowProps) {
  const t = useTranslations();
  const router = useRouter();
  const href = useProjectHref();
  const { flags } = useDashboardWorkspace();
  const availability = useMemo(
    () => resolveCustodyProviderAvailability({ connectedProviders, custodyAvailability }),
    [connectedProviders, custodyAvailability]
  );
  // The list holds only the providers the project can use (an unavailable one is hidden, not
  // shown disabled). Connected providers lead; the catalog's order holds within each group.
  const providerChoices = useMemo(
    () =>
      [...availability].sort(
        (a, b) => Number(b.status === "active") - Number(a.status === "active")
      ),
    [availability]
  );
  const [selectedProvider, setSelectedProvider] = useState<KnownCustodyProvider | null>(() =>
    resolveInitialProvider({ availability, initialProvider })
  );
  const [walletLabel, setWalletLabel] = useState("");
  const [chosenMode, setChosenMode] = useState<CustodyMode | null>(null);
  // While a BYOK submission is in an unknown state, changing an answer would
  // unmount the frozen payload and key that are the only path to recovery.
  const [byokRecoveryLocked, setByokRecoveryLocked] = useState(false);
  const [byokRequestPending, setByokRequestPending] = useState(false);
  // A recovery panel replaces the credential form, and the footer's primary goes with it.
  const [byokInRecovery, setByokInRecovery] = useState(false);
  const [fireblocksReady, setFireblocksReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const model = resolveWalletSetupModel({
    availability,
    chosenMode,
    connections,
    flags,
    selectedProvider,
    walletLabel,
  });
  const providerLabel = model.providerEntry === null ? null : model.providerEntry.label;

  const handleCreated = (walletId: string) => {
    toast.success(t("DashboardCustody.walletCreatedToast", { label: walletLabel.trim() }));
    router.push(href(`/dashboard/wallets/${encodeURIComponent(walletId)}`));
  };

  // The credential form settles without a wallet id, so a BYOK setup lands on the list.
  const handleConnected = (provider: ByokCustodyProvider) => {
    const label = walletLabel.trim();
    toast.success(
      model.showLabelField && label
        ? t("DashboardCustody.walletCreatedToast", { label })
        : t("DashboardCustody.walletSetupConnectedToast", {
            provider: getCustodyProviderEntry(provider).label,
          })
    );
    router.push(href("/dashboard/wallets"));
  };

  const { createWallet, isPending } = useCreateWallet({
    canSubmit: model.canProvisionWallet,
    formAction: model.isConnected ? createCustodySetupWalletAction : initializeCustodySetupAction,
    onCreated: handleCreated,
    setErrorMessage,
    showConnectionPicker: model.showConnectionPicker,
  });
  // Every setup request, Managed or BYOK, holds the answers above: a BYOK request settling
  // after its form unmounted could lock recovery with no form left to recover from.
  const setupRequestInFlight = isPending || byokRequestPending;

  useEnterSubmitsForm();

  const resetAnswerState = () => {
    setFireblocksReady(false);
    setErrorMessage(null);
  };

  const hasProviders = availability.length > 0;
  // A recovery panel carries its own way forward.
  const showPrimary = hasProviders && !(model.isByokDetails && byokInRecovery);
  const title = t("Shared.dashboardShell.createWallet");

  return (
    <div className="h-full min-h-0" data-wallet-setup-flow="true">
      <WizardFrame
        steps={[{ label: title, title }]}
        currentStep={0}
        hideProgress
        progressLabel={title}
        footer={
          <SetupFooter
            cancelDisabled={setupRequestInFlight}
            hint={
              showPrimary
                ? setupHint({
                    awaitingModeChoice: model.awaitingModeChoice,
                    canProvisionWallet: model.canProvisionWallet,
                    isByokDetails: model.isByokDetails,
                    labelMissing: model.labelMissing,
                    providerLabel,
                    t,
                  })
                : null
            }
            onCancel={() => router.push(href("/dashboard/wallets"))}
            primary={
              showPrimary ? (
                <SetupPrimary
                  byokPending={byokRequestPending}
                  canConnect={
                    (model.byokSetupProvider !== "fireblocks" || fireblocksReady) &&
                    !model.labelMissing
                  }
                  canCreate={model.canProvisionWallet && !model.labelMissing}
                  isByokDetails={model.isByokDetails}
                  isPending={isPending}
                  t={t}
                />
              ) : null
            }
            showCancel={!byokRecoveryLocked}
            t={t}
          />
        }
      >
        {hasProviders ? (
          <WalletSetupBody
            answersLocked={setupRequestInFlight || byokRecoveryLocked}
            chosenMode={chosenMode}
            credentialFormHandlers={{
              onPendingChange: setByokRequestPending,
              onReadyChange: setFireblocksReady,
              onRecoveryChange: setByokInRecovery,
              onRecoveryLockChange: setByokRecoveryLocked,
            }}
            environment={environment}
            errorMessage={errorMessage}
            model={model}
            onConnected={handleConnected}
            onDetailsSubmit={(event) => {
              event.preventDefault();
              createWallet(event.currentTarget);
            }}
            onModeChange={(mode) => {
              setChosenMode(mode);
              resetAnswerState();
            }}
            onProviderChange={(provider) => {
              setSelectedProvider(provider);
              setChosenMode(null);
              resetAnswerState();
            }}
            onWalletLabelChange={setWalletLabel}
            providerChoices={providerChoices}
            selectedProvider={selectedProvider}
            t={t}
            walletLabel={walletLabel}
          />
        ) : (
          <p role="status" className="text-body text-secondary">
            {t("DashboardCustody.walletCreationAvailable")}
          </p>
        )}
      </WizardFrame>
    </div>
  );
}
