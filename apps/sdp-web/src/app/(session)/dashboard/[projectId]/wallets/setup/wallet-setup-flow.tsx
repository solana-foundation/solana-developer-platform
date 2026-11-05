"use client";

import type { SdpEnvironment } from "@sdp/types/api-keys";
import {
  type ByokCustodyProvider,
  type CustodyWalletPurpose,
  isByokCustodyProvider,
} from "@sdp/types/custody";
import { Button } from "@sdp/ui/button";
import { cn } from "@sdp/ui/cn";
import { InfoHint } from "@sdp/ui/info-hint";
import { Input } from "@sdp/ui/input";
import { Label } from "@sdp/ui/label";
import { Modal } from "@sdp/ui/modal";
import { Select, SelectItem } from "@sdp/ui/select";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type ComponentProps,
  type FormEvent,
  type ReactNode,
  useCallback,
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
} from "@/app/(session)/dashboard/[projectId]/wallets/actions";
import type { CustodyConnectionListItem } from "@/app/(session)/dashboard/[projectId]/wallets/connections/connections.data";
import { custodyQueryKeys } from "@/app/(session)/dashboard/[projectId]/wallets/custody-query-key";
import {
  type CustodyProviderCatalogEntry,
  getCustodyProviderEntry,
  type KnownCustodyProvider,
} from "@/app/(session)/dashboard/[projectId]/wallets/provider-catalog";
import {
  type CustodyProviderAvailability,
  resolveCustodyProviderAvailability,
} from "@/app/(session)/dashboard/[projectId]/wallets/provider-display-status";
import { ByokCredentialForm } from "@/app/(session)/dashboard/[projectId]/wallets/setup/privy-credential-form";
import { useWalletInventoryRefresh } from "@/app/(session)/dashboard/[projectId]/wallets/use-wallet-inventory-refresh";
import { WalletProviderMark } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-provider-mark";
import {
  isWalletPurposeOffered,
  type WalletPurposeFlags,
} from "@/app/(session)/dashboard/[projectId]/wallets/wallet-purposes";
import { WizardFrame } from "@/components/wizard-frame";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { invalidateQuickStartStatus } from "@/lib/dashboard-quick-start";
import type { ProjectCustodyAvailability } from "@/lib/provider-availability";
import { useActionIdempotencyKey } from "@/lib/use-action-idempotency-key";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { useStepFade } from "@/lib/use-step-fade";

const DETAILS_FORM_ID = "wallet-details-form";
const FOOTER_HINT_ID = "wallet-setup-footer-hint";
const ENVIRONMENT_LABEL_KEYS = {
  sandbox: "DashboardCustody.sandbox",
  production: "DashboardCustody.production",
} as const satisfies Record<SdpEnvironment, MessageKey>;
/** The questions and the wallet's details share one title size, as the design sets them. */
const SECTION_TITLE_CLASS = "text-subheading font-medium text-primary";

/** The provider list's one-line summaries, shorter than the integrations catalog's. */
const PROVIDER_SUMMARY_KEYS = {
  local: "DashboardCustody.walletSetupProviderSummaries.local",
  fireblocks: "DashboardCustody.walletSetupProviderSummaries.fireblocks",
  privy: "DashboardCustody.walletSetupProviderSummaries.privy",
  coinbase_cdp: "DashboardCustody.walletSetupProviderSummaries.coinbaseCdp",
  para: "DashboardCustody.walletSetupProviderSummaries.para",
  turnkey: "DashboardCustody.walletSetupProviderSummaries.turnkey",
  dfns: "DashboardCustody.walletSetupProviderSummaries.dfns",
  ibm_haven: "DashboardCustody.walletSetupProviderSummaries.ibmHaven",
  anchorage: "DashboardCustody.walletSetupProviderSummaries.anchorage",
  utila: "DashboardCustody.walletSetupProviderSummaries.utila",
} as const satisfies Record<KnownCustodyProvider, MessageKey>;

/** How a project connects its own account of a provider, in that provider's words. */
const OWN_ACCOUNT_DESCRIPTION_KEYS = {
  privy: "DashboardCustody.walletSetupModeByokPrivyDescription",
  fireblocks: "DashboardCustody.walletSetupModeByokDescription",
} as const satisfies Record<ByokCustodyProvider, MessageKey>;

/**
 * What a provider's account at SDP gives its wallets. Privy's takes no wallet policy, so its
 * wallets sign whatever the API asks and the screen says so; Fireblocks' may hold one, so it
 * claims nothing.
 */
const MANAGED_ACCOUNT_COPY = {
  privy: {
    descriptionKey: "DashboardCustody.walletSetupModeManagedPolicyFreeDescription",
    policyFree: true,
  },
  fireblocks: {
    descriptionKey: "DashboardCustody.walletSetupModeManagedDescription",
    policyFree: false,
  },
} as const satisfies Record<
  ByokCustodyProvider,
  { descriptionKey: MessageKey; policyFree: boolean }
>;

const TRANSFER_PURPOSE = { value: "transfer", labelKey: "DashboardCustody.transfers" } as const;

/**
 * The purposes the create endpoint accepts, in the order the design lists them: Payments', then
 * Issuance's, then transfers. The picker offers only those whose module runs here
 * (`isWalletPurposeOffered`) and starts on transfers.
 */
const WALLET_PURPOSES = [
  { value: "fee_payer", labelKey: "DashboardCustody.feePayer" },
  { value: "mint_authority", labelKey: "DashboardCustody.mintAuthority" },
  { value: "freeze_authority", labelKey: "DashboardCustody.freezeAuthority" },
  TRANSFER_PURPOSE,
] as const satisfies readonly { value: CustodyWalletPurpose; labelKey: MessageKey }[];

type WalletPurposeOption = (typeof WALLET_PURPOSES)[number];

/** Data attributes the flow's tests and the e2e suite key off. */
type DataAttributes = { [attribute: `data-${string}`]: string };

/**
 * Where the new wallet's keys live: SDP's account of the provider (Managed), a new account of
 * the project's own (a BYOK setup), or a connection the project already holds.
 */
type AccountChoice =
  | { kind: "managed" }
  | { kind: "own" }
  | { kind: "connection"; connection: CustodyConnectionListItem };

function isSameAccount(a: AccountChoice, b: AccountChoice): boolean {
  if (a.kind === "connection" && b.kind === "connection") {
    return a.connection.id === b.connection.id;
  }
  return a.kind === b.kind;
}

/** The radio value an answer submits under, unique across the list. */
function accountValue(account: AccountChoice): string {
  return account.kind === "connection" ? `connection:${account.connection.id}` : account.kind;
}

/** What Cancel's question says: whether a request went out that may have made the wallet. */
type LeavePrompt = "unsent" | "sent";

const LEAVE_PROMPT_COPY = {
  unsent: {
    titleKey: "DashboardCustody.walletSetupLeaveTitle",
    descriptionKey: "DashboardCustody.walletSetupLeaveDescription",
  },
  sent: {
    titleKey: "DashboardCustody.walletSetupLeaveAfterSendTitle",
    descriptionKey: "DashboardCustody.walletSetupLeaveAfterSendDescription",
  },
} as const satisfies Record<LeavePrompt, { titleKey: MessageKey; descriptionKey: MessageKey }>;

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

/** Only an active connection holds verified credentials, so only it can take a wallet. */
function isSelectableConnection(connection: CustodyConnectionListItem): boolean {
  return connection.status === "active";
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
 * One answer in a choice list: a radio row with its title, an optional line of description and
 * the ring. Rows are locked while a setup request is in flight: switching the answer would
 * unmount the credential form that holds the request's only way to recover.
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
  description?: string;
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
        "flex items-center gap-3 px-4 py-4",
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
        aria-describedby={description ? descriptionId : undefined}
      />
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block text-nav leading-4.5 text-primary">{title}</span>
        {description ? (
          <span id={descriptionId} className="block text-body leading-4.5 text-secondary">
            {description}
          </span>
        ) : null}
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
      <legend className={SECTION_TITLE_CLASS}>{legend}</legend>
      {description ? <p className="mt-1 text-body text-secondary">{description}</p> : null}
      <div
        className="mt-4 overflow-hidden rounded-card border border-border-default bg-surface-tile"
        {...listAttributes}
      >
        {children}
      </div>
    </fieldset>
  );
}

/** The usable providers, by name; asked only when there is more than one. */
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
          description={t(PROVIDER_SUMMARY_KEYS[provider.entry.id])}
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
          value={provider.entry.id}
        />
      ))}
    </ChoiceList>
  );
}

/** What a connection that cannot take a wallet yet needs, and the link that gets it done. */
function connectionNotice(
  connection: CustodyConnectionListItem,
  providerLabel: string,
  t: ReturnType<typeof useTranslations>
): { note: string; action: string } {
  if (connection.status !== "failed") {
    return {
      note: t("DashboardCustody.walletSetupConnectionUnavailablePending"),
      action: t("DashboardCustody.walletSetupConnectionCheckAgain"),
    };
  }
  if (connection.lastCheck?.failureCode === "invalid_credentials") {
    return {
      note: t("DashboardCustody.walletSetupConnectionRejected", { provider: providerLabel }),
      action: t("DashboardCustody.walletSetupConnectionReplaceCredentials"),
    };
  }
  return {
    note: t("DashboardCustody.walletSetupConnectionUnavailableFailed"),
    action: t("DashboardCustody.walletSetupConnectionOpen"),
  };
}

/**
 * A connection that cannot take a wallet yet, in the account list: what it needs, and a link to
 * its page, where it is fixed. The link is locked while a setup request is in flight, like every
 * answer above it: leaving would drop the request's saved retry.
 */
function ConnectionNoticeRow({
  connection,
  disabled,
  first,
  providerLabel,
  t,
}: {
  connection: CustodyConnectionListItem;
  disabled: boolean;
  first: boolean;
  providerLabel: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const href = useProjectHref();
  const { note, action } = connectionNotice(connection, providerLabel, t);
  const actionClassName = "shrink-0 text-body underline underline-offset-4";
  return (
    <div
      className={cn("flex items-center gap-3 px-4 py-4", !first && "border-t border-border-subtle")}
      data-wallet-account={connection.id}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-nav leading-4.5 text-primary">{connection.label}</span>
        <span className="block text-body leading-4.5 text-secondary">{note}</span>
      </span>
      {disabled ? (
        // Locked, it is no way out at all: plain text, out of the tab order and the link list.
        <span className={cn(actionClassName, "cursor-not-allowed text-tertiary")}>{action}</span>
      ) : (
        <Link
          href={href(
            `/dashboard/integrations/${connection.provider}/connections/${encodeURIComponent(connection.id)}`
          )}
          className={cn(actionClassName, "text-secondary hover:text-primary")}
        >
          {action}
        </Link>
      )}
    </div>
  );
}

type AccountRow =
  | {
      kind: "choice";
      choice: AccountChoice;
      description?: string;
      title: string;
    }
  | { kind: "notice"; connection: CustodyConnectionListItem };

/**
 * The account list's rows, in the design's order: SDP's account where it is offered, each
 * connection the project holds, then a new account of its own.
 */
function accountRows(input: {
  options: AccountOptions;
  provider: ByokCustodyProvider;
  providerLabel: string;
  t: ReturnType<typeof useTranslations>;
}): AccountRow[] {
  const { options, provider, providerLabel, t } = input;
  const managed: AccountRow[] = options.offersManaged
    ? [
        {
          kind: "choice",
          choice: { kind: "managed" },
          title: t("DashboardCustody.walletSetupModeManagedTitle", { provider: providerLabel }),
          description: t(MANAGED_ACCOUNT_COPY[provider].descriptionKey),
        },
      ]
    : [];
  const connections = options.connections.map(
    (connection): AccountRow =>
      isSelectableConnection(connection)
        ? { kind: "choice", choice: { kind: "connection", connection }, title: connection.label }
        : { kind: "notice", connection }
  );
  const own: AccountRow =
    options.connections.length > 0
      ? {
          kind: "choice",
          choice: { kind: "own" },
          title: t("DashboardCustody.walletSetupAccountConnectAnother", {
            provider: providerLabel,
          }),
        }
      : {
          kind: "choice",
          choice: { kind: "own" },
          title: t("DashboardCustody.walletSetupModeByokTitle", { provider: providerLabel }),
          description: t(OWN_ACCOUNT_DESCRIPTION_KEYS[provider]),
        };
  return [...managed, ...connections, own];
}

/**
 * Asks whose account holds the keys, for a provider the project can connect its own account
 * for: SDP's account where it is offered, each connection the project holds, and a new account
 * of its own. Nothing is preselected unless only one answer can be picked; with only one and no
 * connection to show, there is no list, just the line under the question.
 *
 * A connection that cannot take a wallet stays on the list with what it needs, rather than being
 * filtered out: a user who came here to add a wallet to it needs to see that it is there but
 * not ready yet, not to find it missing.
 */
function AccountQuestion({
  account,
  disabled,
  environment,
  onSelect,
  options,
  provider,
  t,
}: {
  account: AccountChoice | null;
  disabled: boolean;
  environment: SdpEnvironment;
  onSelect: (account: AccountChoice) => void;
  options: AccountOptions;
  provider: ByokCustodyProvider;
  t: ReturnType<typeof useTranslations>;
}) {
  const providerLabel = getCustodyProviderEntry(provider).label;
  const legend = t("DashboardCustody.walletSetupModeQuestion", { provider: providerLabel });
  if (!options.listsAccounts) {
    return (
      <section aria-labelledby="wallet-account-question">
        <h3 id="wallet-account-question" className={SECTION_TITLE_CLASS}>
          {legend}
        </h3>
        {environment === "production" && account?.kind === "own" ? (
          <p className="mt-1 text-body text-secondary">
            {t("DashboardCustody.walletSetupAccountOwnOnlyProduction")}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <ChoiceList
      legend={legend}
      description={t(
        environment === "production"
          ? "DashboardCustody.walletSetupAccountDescriptionProduction"
          : "DashboardCustody.walletSetupAccountDescription"
      )}
      listAttributes={{ "data-wallet-account-list": "" }}
    >
      {accountRows({ options, provider, providerLabel, t }).map((row, index) => {
        if (row.kind === "notice") {
          return (
            <ConnectionNoticeRow
              key={row.connection.id}
              connection={row.connection}
              disabled={disabled}
              first={index === 0}
              providerLabel={providerLabel}
              t={t}
            />
          );
        }
        const value = accountValue(row.choice);
        const choice = row.choice;
        return (
          <ChoiceRow
            key={value}
            attributes={{
              "data-wallet-account":
                choice.kind === "connection" ? choice.connection.id : choice.kind,
            }}
            checked={account !== null && isSameAccount(account, choice)}
            description={row.description}
            disabled={disabled}
            first={index === 0}
            id={`wallet-account-${value.replace(":", "-")}`}
            name="walletAccount"
            onSelect={() => onSelect(choice)}
            title={row.title}
            value={value}
          />
        );
      })}
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
  placeholder,
  t,
  value,
}: {
  disabled: boolean;
  name: "label" | "walletLabel";
  onChange: (value: string) => void;
  placeholder: string;
  t: ReturnType<typeof useTranslations>;
  value: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor="wallet-label">{t("DashboardCustody.walletLabel")}</Label>
      <Input
        id="wallet-label"
        form={DETAILS_FORM_ID}
        name={name}
        size="xl"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
        maxLength={100}
        required
        disabled={disabled}
      />
    </div>
  );
}

/**
 * The form a Managed setup or another wallet submits: the provider, the connection it goes into
 * when there is one, and the purpose when there is one to choose. The label joins it from
 * outside (`WalletLabelField`).
 */
function WalletDetailsForm({
  choosePurpose,
  connectionId,
  onSubmit,
  providerId,
  purposeHint,
  purposes,
  t,
}: {
  choosePurpose: boolean;
  connectionId: string | null;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  providerId: KnownCustodyProvider;
  purposeHint: string;
  purposes: readonly WalletPurposeOption[];
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <form id={DETAILS_FORM_ID} onSubmit={onSubmit} className="space-y-6">
      <input type="hidden" name="provider" value={providerId} />
      {connectionId === null ? null : (
        <input type="hidden" name="connectionId" value={connectionId} />
      )}
      {choosePurpose ? (
        <div className="space-y-2">
          <FieldLabel label={t("DashboardCustody.purpose")} hint={purposeHint} />
          <Select
            name="purpose"
            ariaLabel={t("DashboardCustody.purpose")}
            defaultValue={TRANSFER_PURPOSE.value}
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
    </form>
  );
}

/** One line of the summary: what it names, with a hint when the name needs one, and its value. */
function CreatedWithRow({
  hint,
  label,
  muted = false,
  value,
}: {
  hint?: string;
  label: string;
  muted?: boolean;
  value: string;
}) {
  return (
    <div className="flex h-12 items-center gap-4 border-b border-border-subtle last:border-b-0">
      <dt className="flex w-36 shrink-0 items-center gap-1.5 text-body text-secondary">
        {label}
        {hint ? <InfoHint text={hint} /> : null}
      </dt>
      <dd
        className={cn(
          "min-w-0 flex-1 truncate text-body",
          muted ? "text-tertiary" : "text-primary"
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * What the wallet is created with: the provider once one is chosen, the account it goes into,
 * a purpose that is not a choice, and where it lives.
 */
function CreatedWithSummary({
  connection,
  environment,
  fixedPurposeLabel,
  providerLabel,
  t,
}: {
  connection: { value: string; muted: boolean; hint: string } | null;
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

  return (
    <section aria-labelledby="wallet-created-with">
      <h3 id="wallet-created-with" className="text-nav font-medium text-primary">
        {t("DashboardCustody.walletSetupCreatedWith")}
      </h3>
      <dl className="mt-2">
        {providerLabel ? (
          <CreatedWithRow label={t("DashboardCustody.walletSetupProvider")} value={providerLabel} />
        ) : null}
        {connection ? (
          <CreatedWithRow
            label={t("DashboardCustody.walletSetupConnection")}
            hint={connection.hint}
            muted={connection.muted}
            value={connection.value}
          />
        ) : null}
        {fixedPurposeLabel ? (
          <CreatedWithRow label={t("DashboardCustody.purpose")} value={fixedPurposeLabel} />
        ) : null}
        <CreatedWithRow
          label={t("DashboardCustody.project")}
          hint={t("DashboardCustody.walletSetupProjectHint")}
          value={projectName}
        />
        <CreatedWithRow
          label={t("DashboardCustody.environment")}
          hint={t("DashboardCustody.walletSetupEnvironmentHint")}
          value={environmentLabel}
        />
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
 * Asks before Cancel throws away what was typed. Until a request goes out no wallet exists; once
 * one has, the wallet may, so the question sends the user to check Wallets instead.
 */
function LeaveSetupDialog({
  onKeepGoing,
  onLeave,
  open,
  prompt,
  t,
}: {
  onKeepGoing: () => void;
  onLeave: () => void;
  open: boolean;
  prompt: LeavePrompt;
  t: ReturnType<typeof useTranslations>;
}) {
  const copy = LEAVE_PROMPT_COPY[prompt];
  return (
    <Modal isOpen={open} onClose={onKeepGoing} ariaLabel={t(copy.titleKey)} size="sm">
      <div className="space-y-6 p-6">
        <div className="space-y-2">
          <p className="text-subheading font-medium text-primary">{t(copy.titleKey)}</p>
          <p className="text-body text-secondary">{t(copy.descriptionKey)}</p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onKeepGoing}>
            {t("DashboardCustody.walletSetupLeaveKeepGoing")}
          </Button>
          <Button type="button" variant="destructive" onClick={onLeave}>
            {t("DashboardCustody.walletSetupLeaveConfirm")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Cancel's guard: it leaves at once when nothing was put on the screen, and asks first when
 * something was. What the user typed into the credential form and whether a request went out
 * are only read when Cancel is pressed, so they live in refs. Their setters keep one identity
 * for the flow's life: they reach the credential form, whose effects depend on what it is given.
 *
 * @param onLeave - Leaves the flow for the wallet list.
 * @returns The dialog's state and the handlers that feed it.
 */
function useLeaveGuard(onLeave: () => void) {
  const [dialog, setDialog] = useState<{ open: boolean; prompt: LeavePrompt }>({
    open: false,
    prompt: "unsent",
  });
  const credentialsTouchedRef = useRef(false);
  const requestSentRef = useRef(false);
  const markCredentialsTouched = useCallback(() => {
    credentialsTouchedRef.current = true;
  }, []);
  const clearCredentialsTouched = useCallback(() => {
    credentialsTouchedRef.current = false;
  }, []);
  const markRequestSent = useCallback(() => {
    requestSentRef.current = true;
  }, []);
  return {
    dialog,
    markCredentialsTouched,
    clearCredentialsTouched,
    markRequestSent,
    /** Cancel: `hasInput` is what the flow's own state shows was put on the screen. */
    requestLeave: (hasInput: boolean) => {
      if (requestSentRef.current) {
        setDialog({ open: true, prompt: "sent" });
      } else if (hasInput || credentialsTouchedRef.current) {
        setDialog({ open: true, prompt: "unsent" });
      } else {
        onLeave();
      }
    },
    keepGoing: () => setDialog((current) => ({ ...current, open: false })),
    confirmLeave: () => {
      setDialog((current) => ({ ...current, open: false }));
      onLeave();
    },
  };
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

interface AccountOptions {
  /**
   * The provider whose account the screen asks about: one the project can connect its own
   * account for. `null` asks nothing, and the wallet goes into SDP's account.
   */
  accountProvider: ByokCustodyProvider | null;
  /** The provider's connections the list names: every one but a deactivated one. */
  connections: CustodyConnectionListItem[];
  hasManagedConfig: boolean;
  offersManaged: boolean;
  /** The question lists its answers: more than one can be picked, or a connection needs care. */
  listsAccounts: boolean;
  /** The answer in effect: the user's while it is still offered, else the only one there is. */
  account: AccountChoice | null;
}

const NO_ACCOUNT_OPTIONS: AccountOptions = {
  accountProvider: null,
  connections: [],
  hasManagedConfig: false,
  offersManaged: false,
  listsAccounts: false,
  account: null,
};

/**
 * The answer in effect among what can be picked: the user's, while the provider still offers it,
 * or the only answer there is. The offered row is returned rather than the stored answer, so a
 * connection carries the list's current data.
 */
function effectiveAccount(
  chosen: AccountChoice | null,
  selectable: AccountChoice[]
): AccountChoice | null {
  const offered =
    chosen === null ? undefined : selectable.find((option) => isSameAccount(option, chosen));
  if (offered !== undefined) {
    return offered;
  }
  const [onlyAccount, ...otherAccounts] = selectable;
  return onlyAccount !== undefined && otherAccounts.length === 0 ? onlyAccount : null;
}

/**
 * Which accounts the selected provider's wallet can go into, from its modes, its Managed config
 * and the project's connections. Managed is offered only where the modes include `managed`;
 * connections are BYOK custody, so a provider whose modes leave out `byok` offers none and asks
 * nothing: its wallet goes into SDP's account.
 *
 * Switching provider must not carry the previous provider's connections along, so the list is
 * narrowed here rather than trusted as delivered, and an answer counts only while this provider
 * still offers it.
 */
function resolveAccountOptions(input: {
  selectedAvailability: CustodyProviderAvailability | null;
  connections: CustodyConnectionListItem[];
  chosenAccount: AccountChoice | null;
}): AccountOptions {
  const { selectedAvailability, chosenAccount } = input;
  if (selectedAvailability === null) {
    return NO_ACCOUNT_OPTIONS;
  }
  const providerId = selectedAvailability.entry.id;
  const offersManaged = selectedAvailability.modes.includes("managed");
  const accountProvider =
    selectedAvailability.modes.includes("byok") && isByokCustodyProvider(providerId)
      ? providerId
      : null;
  const connections =
    accountProvider === null
      ? []
      : input.connections.filter(
          (connection) =>
            connection.provider === accountProvider && connection.status !== "deactivated"
        );
  const selectable: AccountChoice[] = [
    ...(offersManaged ? [{ kind: "managed" } as const] : []),
    ...connections
      .filter(isSelectableConnection)
      .map((connection) => ({ kind: "connection", connection }) as const),
    ...(accountProvider === null ? [] : [{ kind: "own" } as const]),
  ];
  return {
    accountProvider,
    connections,
    hasManagedConfig: offersManaged && selectedAvailability.status === "active",
    offersManaged,
    listsAccounts:
      selectable.length > 1 ||
      connections.some((connection) => !isSelectableConnection(connection)),
    account: effectiveAccount(chosenAccount, selectable),
  };
}

/**
 * The line beside the primary: what is still missing, in the order the page asks for it, or
 * what confirming does once nothing is.
 */
function setupHint(input: {
  model: WalletSetupModel;
  providerLabel: string | null;
  t: ReturnType<typeof useTranslations>;
}): string {
  const { model, providerLabel, t } = input;
  if (providerLabel === null) {
    return t("DashboardCustody.chooseEnabledProvider");
  }
  if (model.awaitingAccountChoice) {
    return t("DashboardCustody.walletSetupModeRequired", { provider: providerLabel });
  }
  if (!(model.isByokDetails || model.canProvisionWallet)) {
    return t("DashboardCustody.connectedProviderDescription", { provider: providerLabel });
  }
  if (model.labelMissing) {
    return t("DashboardCustody.walletSetupLabelRequired");
  }
  if (model.isByokDetails) {
    return t("DashboardCustody.walletSetupByokHint", { provider: providerLabel });
  }
  // Only where the screen asked whose account, and only for an account at SDP known to take no
  // wallet policy.
  const { accountProvider, account } = model.options;
  if (
    accountProvider !== null &&
    account?.kind === "managed" &&
    MANAGED_ACCOUNT_COPY[accountProvider].policyFree
  ) {
    return t("DashboardCustody.walletSetupManagedHint", { provider: providerLabel });
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
 * Submits the details form: checks it, runs the create or initialize action, and on success
 * marks the quick-start step and hands the new wallet to `onCreated`. `onSend` hears the moment
 * a request goes out; a refusal lands in `setErrorMessage`.
 */
function useCreateWallet({
  canSubmit,
  formAction,
  onCreated,
  onSend,
  setErrorMessage,
}: {
  canSubmit: boolean;
  formAction: typeof createCustodySetupWalletAction | typeof initializeCustodySetupAction;
  onCreated: (walletId: string) => void;
  onSend: () => void;
  setErrorMessage: (message: string | null) => void;
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
    onSend();

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
        // The wallet reads were invalidated above, so the flow leaves without refreshing
        // itself: a refresh would only re-run this page's reads on the way out.
        onCreated(result.walletId);
      } finally {
        submissionInFlightRef.current = false;
      }
    });
  };

  return { createWallet, isPending };
}

interface WalletSetupModel {
  options: AccountOptions;
  awaitingAccountChoice: boolean;
  /** The BYOK provider whose credential form the flow shows, or `null` when it shows none. */
  byokSetupProvider: ByokCustodyProvider | null;
  canProvisionWallet: boolean;
  /**
   * The wallet goes into an account the project already has, a connection or the Managed
   * config: the create action runs and the purpose is a choice. A first wallet's is fixed.
   */
  createsInExistingAccount: boolean;
  /** The provider the details form submits for; `null` while BYOK or the account is open. */
  detailsProvider: CustodyProviderCatalogEntry | null;
  /** The purpose the summary names because it is not a choice; `null` while it is or is unknown. */
  fixedPurpose: WalletPurposeOption | null;
  isByokDetails: boolean;
  labelMissing: boolean;
  providerEntry: CustodyProviderCatalogEntry | null;
  purposes: readonly WalletPurposeOption[];
  showLabelField: boolean;
}

/**
 * Everything the screen derives from its answers: what the selected provider offers, which
 * question is still open, what the form sends and what the summary names.
 */
function resolveWalletSetupModel(input: {
  availability: CustodyProviderAvailability[];
  chosenAccount: AccountChoice | null;
  connections: CustodyConnectionListItem[];
  flags: WalletPurposeFlags;
  selectedProvider: KnownCustodyProvider | null;
  walletLabel: string;
}): WalletSetupModel {
  const selectedAvailability =
    input.availability.find((provider) => provider.entry.id === input.selectedProvider) ?? null;
  const options = resolveAccountOptions({
    selectedAvailability,
    connections: input.connections,
    chosenAccount: input.chosenAccount,
  });
  const providerEntry = selectedAvailability === null ? null : selectedAvailability.entry;
  const { account } = options;
  const createsInExistingAccount =
    account !== null &&
    (account.kind === "connection" || (account.kind === "managed" && options.hasManagedConfig));
  const setsUpManaged = account?.kind === "managed" && !options.hasManagedConfig;
  const byokSetupProvider = account?.kind === "own" ? options.accountProvider : null;
  // Fireblocks names no wallet at setup: its vault accounts arrive with their own names.
  const showLabelField = byokSetupProvider !== "fireblocks";
  const awaitingAccountChoice = providerEntry !== null && account === null;
  const canProvisionWallet =
    providerEntry !== null &&
    (createsInExistingAccount ? providerEntry.supportsAdditionalWallets : setsUpManaged);
  return {
    options,
    awaitingAccountChoice,
    byokSetupProvider,
    canProvisionWallet,
    createsInExistingAccount,
    // The details form waits for a provider and its account; BYOK has its own form.
    detailsProvider: byokSetupProvider === null && !awaitingAccountChoice ? providerEntry : null,
    fixedPurpose: setsUpManaged || byokSetupProvider !== null ? TRANSFER_PURPOSE : null,
    isByokDetails: byokSetupProvider !== null,
    labelMissing: showLabelField && input.walletLabel.trim().length === 0,
    providerEntry,
    purposes: WALLET_PURPOSES.filter((purpose) =>
      isWalletPurposeOffered(purpose.value, input.flags)
    ),
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
        {t("DashboardCustody.walletSetupConnectAndCreate")}
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

/**
 * The footer for the answers on screen: the hint and the primary they call for, or neither
 * while a recovery panel, which carries its own way forward, replaces the credential form.
 */
function WalletSetupFooter({
  byok,
  cancelDisabled,
  hasProviders,
  isPending,
  model,
  onCancel,
  showCancel,
  t,
}: {
  byok: { fireblocksReady: boolean; inRecovery: boolean; pending: boolean };
  cancelDisabled: boolean;
  hasProviders: boolean;
  isPending: boolean;
  model: WalletSetupModel;
  onCancel: () => void;
  showCancel: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const showPrimary = hasProviders && !(model.isByokDetails && byok.inRecovery);
  const providerLabel = model.providerEntry === null ? null : model.providerEntry.label;
  return (
    <SetupFooter
      cancelDisabled={cancelDisabled}
      hint={showPrimary ? setupHint({ model, providerLabel, t }) : null}
      onCancel={onCancel}
      primary={
        showPrimary ? (
          <SetupPrimary
            byokPending={byok.pending}
            canConnect={
              (model.byokSetupProvider !== "fireblocks" || byok.fireblocksReady) &&
              !model.labelMissing
            }
            canCreate={model.canProvisionWallet && !model.labelMissing}
            isByokDetails={model.isByokDetails}
            isPending={isPending}
            t={t}
          />
        ) : null
      }
      showCancel={showCancel}
      t={t}
    />
  );
}

type CredentialFormHandlers = Pick<
  ComponentProps<typeof ByokCredentialForm>,
  "onPendingChange" | "onReadyChange" | "onRecoveryChange" | "onRecoveryLockChange"
>;

/** What the summary's Connection line says for the answer in effect, or `null` before one. */
function resolveConnectionSummary(input: {
  model: WalletSetupModel;
  t: ReturnType<typeof useTranslations>;
}): { value: string; muted: boolean; hint: string } | null {
  const { model, t } = input;
  const { account, accountProvider } = model.options;
  if (accountProvider === null || account === null) {
    return null;
  }
  const provider = getCustodyProviderEntry(accountProvider).label;
  const hint = t("DashboardCustody.walletSetupConnectionHint", { provider });
  switch (account.kind) {
    case "managed":
      return {
        value: t("DashboardCustody.walletSetupModeManagedTitle", { provider }),
        muted: false,
        hint,
      };
    case "own":
      return {
        value: t("DashboardCustody.walletSetupConnectionYourOwn", { provider }),
        muted: true,
        hint,
      };
    case "connection":
      return { value: account.connection.label, muted: false, hint };
    default: {
      const unhandledAccount: never = account;
      throw new Error(`Unhandled wallet account: ${JSON.stringify(unhandledAccount)}`);
    }
  }
}

/** The credential form a new account of the project's own needs, right under the question. */
function CredentialSection({
  answerKey,
  credentialFormHandlers,
  onConnected,
  onCredentialsTouched,
  provider,
}: {
  answerKey: string;
  credentialFormHandlers: CredentialFormHandlers;
  onConnected: (provider: ByokCustodyProvider) => void;
  onCredentialsTouched: () => void;
  provider: ByokCustodyProvider;
}) {
  // What the answers reveal fades in, rather than appearing at full strength.
  const revealRef = useStepFade<HTMLDivElement>(answerKey);
  return (
    // Typing here is input Cancel would throw away, so the flow hears of it.
    <div ref={revealRef} onInput={onCredentialsTouched}>
      <ByokCredentialForm
        // A failed check's connection belongs to its provider: another starts fresh.
        key={provider}
        {...credentialFormHandlers}
        provider={provider}
        formId={DETAILS_FORM_ID}
        hostsWalletLabel
        showSubmitButton={false}
        onSuccess={() => onConnected(provider)}
      />
    </div>
  );
}

/**
 * The wallet's own details: its label from the start, then the details form once the answers
 * call for one (with the purpose when there is one to choose).
 */
function WalletDetailsSection({
  answerKey,
  disabled,
  flags,
  model,
  onDetailsSubmit,
  onWalletLabelChange,
  t,
  walletLabel,
}: {
  answerKey: string;
  disabled: boolean;
  flags: WalletPurposeFlags;
  model: WalletSetupModel;
  onDetailsSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onWalletLabelChange: (value: string) => void;
  t: ReturnType<typeof useTranslations>;
  walletLabel: string;
}) {
  const revealRef = useStepFade<HTMLDivElement>(answerKey);
  const { account } = model.options;
  const { detailsProvider } = model;
  return (
    <section aria-labelledby="wallet-details-title" className="space-y-6">
      <h3 id="wallet-details-title" className={SECTION_TITLE_CLASS}>
        {t("DashboardCustody.walletSetupDetailsTitle")}
      </h3>
      <WalletLabelField
        disabled={disabled}
        name={model.createsInExistingAccount ? "label" : "walletLabel"}
        onChange={onWalletLabelChange}
        placeholder={t(
          model.providerEntry?.id === "privy"
            ? "DashboardCustody.walletSetupLabelPlaceholderTreasury"
            : "DashboardCustody.newDesign.walletLabelPlaceholder"
        )}
        t={t}
        value={walletLabel}
      />
      {/* One form owns DETAILS_FORM_ID at a time: the credential form or the details. */}
      {detailsProvider === null ? null : (
        <div ref={revealRef}>
          <WalletDetailsForm
            // A chosen account belongs to its provider: another starts with none chosen.
            key={detailsProvider.id}
            choosePurpose={model.createsInExistingAccount}
            connectionId={account?.kind === "connection" ? account.connection.id : null}
            onSubmit={onDetailsSubmit}
            providerId={detailsProvider.id}
            purposeHint={t(
              flags.issuance
                ? "DashboardCustody.walletPurposeHintWithIssuance"
                : "DashboardCustody.walletPurposeHint"
            )}
            purposes={model.purposes}
            t={t}
          />
        </div>
      )}
    </section>
  );
}

/**
 * The screen under the title: the provider question and whose account when they are open, the
 * credential form a new account of the project's own needs, the wallet's details, what it is
 * created with, and a refusal.
 */
function WalletSetupBody({
  answersLocked,
  credentialFormHandlers,
  environment,
  errorMessage,
  flags,
  model,
  onAccountChange,
  onConnected,
  onCredentialsTouched,
  onDetailsSubmit,
  onProviderChange,
  onWalletLabelChange,
  providerChoices,
  selectedProvider,
  t,
  walletLabel,
}: {
  answersLocked: boolean;
  credentialFormHandlers: CredentialFormHandlers;
  environment: SdpEnvironment;
  errorMessage: string | null;
  flags: WalletPurposeFlags;
  model: WalletSetupModel;
  onAccountChange: (account: AccountChoice) => void;
  /** A BYOK setup settled: the credentials check passed and the provider is connected. */
  onConnected: (provider: ByokCustodyProvider) => void;
  onCredentialsTouched: () => void;
  onDetailsSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onProviderChange: (provider: KnownCustodyProvider) => void;
  onWalletLabelChange: (value: string) => void;
  providerChoices: CustodyProviderAvailability[];
  selectedProvider: KnownCustodyProvider | null;
  t: ReturnType<typeof useTranslations>;
  walletLabel: string;
}) {
  const { account, accountProvider } = model.options;
  const answerKey = `${selectedProvider ?? ""}:${account === null ? "" : accountValue(account)}`;
  return (
    <div className="space-y-10">
      {providerChoices.length > 1 ? (
        <ProviderChoice
          choices={providerChoices}
          disabled={answersLocked}
          onSelect={onProviderChange}
          selectedProvider={selectedProvider}
          t={t}
        />
      ) : null}
      {accountProvider === null ? null : (
        <AccountQuestion
          account={account}
          disabled={answersLocked}
          environment={environment}
          onSelect={onAccountChange}
          options={model.options}
          provider={accountProvider}
          t={t}
        />
      )}
      {model.byokSetupProvider === null ? null : (
        <CredentialSection
          answerKey={answerKey}
          credentialFormHandlers={credentialFormHandlers}
          onConnected={onConnected}
          onCredentialsTouched={onCredentialsTouched}
          provider={model.byokSetupProvider}
        />
      )}
      {model.showLabelField ? (
        <WalletDetailsSection
          answerKey={answerKey}
          disabled={answersLocked}
          flags={flags}
          model={model}
          onDetailsSubmit={onDetailsSubmit}
          onWalletLabelChange={onWalletLabelChange}
          t={t}
          walletLabel={walletLabel}
        />
      ) : null}
      <CreatedWithSummary
        connection={resolveConnectionSummary({ model, t })}
        environment={environment}
        fixedPurposeLabel={model.fixedPurpose ? t(model.fixedPurpose.labelKey) : null}
        providerLabel={model.providerEntry === null ? null : model.providerEntry.label}
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

/** The toast a finished BYOK setup shows: the new wallet by its label, else the provider. */
function connectedToastMessage(input: {
  provider: ByokCustodyProvider;
  showLabelField: boolean;
  t: ReturnType<typeof useTranslations>;
  walletLabel: string;
}): string {
  const label = input.walletLabel.trim();
  return input.showLabelField && label
    ? input.t("DashboardCustody.walletCreatedToast", { label })
    : input.t("DashboardCustody.walletSetupConnectedToast", {
        provider: getCustodyProviderEntry(input.provider).label,
      });
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
  // shown disabled), by name.
  const providerChoices = useMemo(
    () => [...availability].sort((a, b) => a.entry.label.localeCompare(b.entry.label)),
    [availability]
  );
  const [openingProvider] = useState<KnownCustodyProvider | null>(() =>
    resolveInitialProvider({ availability, initialProvider })
  );
  const [selectedProvider, setSelectedProvider] = useState(openingProvider);
  const [walletLabel, setWalletLabel] = useState("");
  const [chosenAccount, setChosenAccount] = useState<AccountChoice | null>(null);
  // While a BYOK submission is in an unknown state, changing an answer would
  // unmount the frozen payload and key that are the only path to recovery.
  const [byokRecoveryLocked, setByokRecoveryLocked] = useState(false);
  const [byokRequestPending, setByokRequestPending] = useState(false);
  // A recovery panel replaces the credential form, and the footer's primary goes with it.
  const [byokInRecovery, setByokInRecovery] = useState(false);
  const [fireblocksReady, setFireblocksReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const leaveGuard = useLeaveGuard(() => router.push(href("/dashboard/wallets")));
  const { markRequestSent } = leaveGuard;
  // The credential form raises its recovery lock the moment a credential submission leaves, so
  // the lock's rise is the BYOK sign that a request went out. Its pending signal is not: the
  // Fireblocks fields raise that for their CSR read too. Stable, like every handler the form
  // gets, since its effects depend on them.
  const handleRecoveryLockChange = useCallback(
    (locked: boolean) => {
      setByokRecoveryLocked(locked);
      if (locked) {
        markRequestSent();
      }
    },
    [markRequestSent]
  );
  const model = resolveWalletSetupModel({
    availability,
    chosenAccount,
    connections,
    flags,
    selectedProvider,
    walletLabel,
  });

  const { createWallet, isPending } = useCreateWallet({
    canSubmit: model.canProvisionWallet,
    formAction: model.createsInExistingAccount
      ? createCustodySetupWalletAction
      : initializeCustodySetupAction,
    onCreated: (walletId) => {
      toast.success(t("DashboardCustody.walletCreatedToast", { label: walletLabel.trim() }));
      router.push(href(`/dashboard/wallets/${encodeURIComponent(walletId)}`));
    },
    onSend: markRequestSent,
    setErrorMessage,
  });
  // Every setup request, Managed or BYOK, holds the answers above: a BYOK request settling
  // after its form unmounted could lock recovery with no form left to recover from.
  const setupRequestInFlight = isPending || byokRequestPending;

  useEnterSubmitsForm();

  // A changed answer unmounts the credential form, and a recovery panel goes with it: the next
  // form starts at its fields, with the footer's primary back.
  const resetAnswerState = () => {
    setByokInRecovery(false);
    setFireblocksReady(false);
    leaveGuard.clearCredentialsTouched();
    setErrorMessage(null);
  };
  // Only what the user put on the screen counts: the provider the flow opened on does not.
  const hasInput =
    walletLabel.trim() !== "" || chosenAccount !== null || selectedProvider !== openingProvider;
  const hasProviders = availability.length > 0;
  const title = t("Shared.dashboardShell.createWallet");

  return (
    <div className="h-full min-h-0" data-wallet-setup-flow="true">
      <WizardFrame
        steps={[{ label: title, title }]}
        currentStep={0}
        hideProgress
        progressLabel={title}
        footer={
          <WalletSetupFooter
            byok={{
              fireblocksReady,
              inRecovery: byokInRecovery,
              pending: byokRequestPending,
            }}
            cancelDisabled={setupRequestInFlight}
            hasProviders={hasProviders}
            isPending={isPending}
            model={model}
            onCancel={() => leaveGuard.requestLeave(hasInput)}
            showCancel={!byokRecoveryLocked}
            t={t}
          />
        }
      >
        {hasProviders ? (
          <WalletSetupBody
            answersLocked={setupRequestInFlight || byokRecoveryLocked}
            credentialFormHandlers={{
              onPendingChange: setByokRequestPending,
              onReadyChange: setFireblocksReady,
              onRecoveryChange: setByokInRecovery,
              onRecoveryLockChange: handleRecoveryLockChange,
            }}
            environment={environment}
            errorMessage={errorMessage}
            flags={flags}
            model={model}
            onAccountChange={(account) => {
              setChosenAccount(account);
              resetAnswerState();
            }}
            onConnected={(provider) => {
              toast.success(
                connectedToastMessage({
                  provider,
                  showLabelField: model.showLabelField,
                  t,
                  walletLabel,
                })
              );
              // The credential form settles without a wallet id, so a BYOK setup lands on the list.
              router.push(href("/dashboard/wallets"));
            }}
            onCredentialsTouched={leaveGuard.markCredentialsTouched}
            onDetailsSubmit={(event) => {
              event.preventDefault();
              createWallet(event.currentTarget);
            }}
            onProviderChange={(provider) => {
              setSelectedProvider(provider);
              setChosenAccount(null);
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
      <LeaveSetupDialog
        open={leaveGuard.dialog.open}
        prompt={leaveGuard.dialog.prompt}
        onKeepGoing={leaveGuard.keepGoing}
        onLeave={leaveGuard.confirmLeave}
        t={t}
      />
    </div>
  );
}
