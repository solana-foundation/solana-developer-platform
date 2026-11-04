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
} from "@/app/(session)/dashboard/[projectId]/custody/actions";
import type { CustodyConnectionListItem } from "@/app/(session)/dashboard/[projectId]/custody/connections/connections.data";
import { custodyQueryKeys } from "@/app/(session)/dashboard/[projectId]/custody/custody-query-key";
import {
  type CustodyProviderCatalogEntry,
  getCustodyProviderEntry,
  type KnownCustodyProvider,
} from "@/app/(session)/dashboard/[projectId]/custody/provider-catalog";
import {
  type CustodyProviderAvailability,
  resolveCustodyProviderAvailability,
} from "@/app/(session)/dashboard/[projectId]/custody/provider-display-status";
import { ByokCredentialForm } from "@/app/(session)/dashboard/[projectId]/custody/setup/privy-credential-form";
import { useWalletInventoryRefresh } from "@/app/(session)/dashboard/[projectId]/custody/use-wallet-inventory-refresh";
import { WalletProviderMark } from "@/app/(session)/dashboard/[projectId]/custody/wallet-provider-mark";
import {
  isWalletPurposeOffered,
  type WalletPurposeFlags,
} from "@/app/(session)/dashboard/[projectId]/custody/wallet-purposes";
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

/**
 * The provider list's one-line summaries, shorter than the integrations catalog's. A provider
 * without one shows the catalog's description.
 */
const PROVIDER_SUMMARY_KEYS: Partial<Record<KnownCustodyProvider, MessageKey>> = {
  anchorage: "DashboardCustody.walletSetupProviderSummaries.anchorage",
  coinbase_cdp: "DashboardCustody.walletSetupProviderSummaries.coinbaseCdp",
  dfns: "DashboardCustody.walletSetupProviderSummaries.dfns",
  fireblocks: "DashboardCustody.walletSetupProviderSummaries.fireblocks",
  ibm_haven: "DashboardCustody.walletSetupProviderSummaries.ibmHaven",
  para: "DashboardCustody.walletSetupProviderSummaries.para",
  privy: "DashboardCustody.walletSetupProviderSummaries.privy",
  turnkey: "DashboardCustody.walletSetupProviderSummaries.turnkey",
  utila: "DashboardCustody.walletSetupProviderSummaries.utila",
};

/** How a project's own account of a provider is connected, where the provider has a word for it. */
const OWN_ACCOUNT_DESCRIPTION_KEYS: Partial<Record<ByokCustodyProvider, MessageKey>> = {
  privy: "DashboardCustody.walletSetupModeByokPrivyDescription",
};

/**
 * Providers whose account at SDP takes no wallet policy, so its wallets sign whatever the API
 * asks. The screen says so only for these: another provider's account at SDP may hold one.
 */
const POLICY_FREE_MANAGED_PROVIDERS: ReadonlySet<KnownCustodyProvider> = new Set(["privy"]);

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
  | { kind: "connection"; connectionId: string };

function isSameAccount(a: AccountChoice, b: AccountChoice): boolean {
  if (a.kind === "connection" && b.kind === "connection") {
    return a.connectionId === b.connectionId;
  }
  return a.kind === b.kind;
}

/** The radio value an answer submits under, unique across the list. */
function accountValue(account: AccountChoice): string {
  return account.kind === "connection" ? `connection:${account.connectionId}` : account.kind;
}

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
          description={t(PROVIDER_SUMMARY_KEYS[provider.entry.id] ?? provider.entry.descriptionKey)}
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

/**
 * A connection that cannot take a wallet yet, in the account list: what it needs, and a link to
 * its page, where it is fixed.
 */
function ConnectionNoticeRow({
  connection,
  first,
  providerLabel,
  t,
}: {
  connection: CustodyConnectionListItem;
  first: boolean;
  providerLabel: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const href = useProjectHref();
  const failed = connection.status === "failed";
  const rejected = failed && connection.lastCheck?.failureCode === "invalid_credentials";
  let note = t("DashboardCustody.walletSetupConnectionUnavailablePending");
  let action = t("DashboardCustody.walletSetupConnectionCheckAgain");
  if (rejected) {
    note = t("DashboardCustody.walletSetupConnectionRejected", { provider: providerLabel });
    action = t("DashboardCustody.walletSetupConnectionReplaceCredentials");
  } else if (failed) {
    note = t("DashboardCustody.walletSetupConnectionUnavailableFailed");
    action = t("DashboardCustody.walletSetupConnectionOpen");
  }
  return (
    <div
      className={cn("flex items-center gap-3 px-4 py-4", !first && "border-t border-border-subtle")}
      data-wallet-account={connection.id}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-nav leading-4.5 text-primary">{connection.label}</span>
        <span className="block text-body leading-4.5 text-secondary">{note}</span>
      </span>
      <Link
        href={href(
          `/dashboard/integrations/${connection.provider}/connections/${encodeURIComponent(connection.id)}`
        )}
        className="shrink-0 text-body text-secondary underline underline-offset-4 hover:text-primary"
      >
        {action}
      </Link>
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
  providerId,
  providerLabel,
  t,
}: {
  account: AccountChoice | null;
  disabled: boolean;
  environment: SdpEnvironment;
  onSelect: (account: AccountChoice) => void;
  options: AccountOptions;
  providerId: KnownCustodyProvider;
  providerLabel: string;
  t: ReturnType<typeof useTranslations>;
}) {
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

  const ownDescriptionKey =
    (isByokCustodyProvider(providerId) ? OWN_ACCOUNT_DESCRIPTION_KEYS[providerId] : undefined) ??
    "DashboardCustody.walletSetupModeByokDescription";
  const rows: AccountRow[] = [
    ...(options.offersManaged
      ? [
          {
            kind: "choice",
            choice: { kind: "managed" },
            title: t("DashboardCustody.walletSetupModeManagedTitle", { provider: providerLabel }),
            description: t(
              POLICY_FREE_MANAGED_PROVIDERS.has(providerId)
                ? "DashboardCustody.walletSetupModeManagedPolicyFreeDescription"
                : "DashboardCustody.walletSetupModeManagedDescription"
            ),
          } satisfies AccountRow,
        ]
      : []),
    ...options.connections.map(
      (connection): AccountRow =>
        isSelectableConnection(connection)
          ? {
              kind: "choice",
              choice: { kind: "connection", connectionId: connection.id },
              title: connection.label,
            }
          : { kind: "notice", connection }
    ),
    ...(options.offersOwn
      ? [
          options.connections.length > 0
            ? ({
                kind: "choice",
                choice: { kind: "own" },
                title: t("DashboardCustody.walletSetupAccountConnectAnother", {
                  provider: providerLabel,
                }),
              } satisfies AccountRow)
            : ({
                kind: "choice",
                choice: { kind: "own" },
                title: t("DashboardCustody.walletSetupModeByokTitle", { provider: providerLabel }),
                description: t(ownDescriptionKey),
              } satisfies AccountRow),
        ]
      : []),
  ];

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
      {rows.map((row, index) => {
        if (row.kind === "notice") {
          return (
            <ConnectionNoticeRow
              key={row.connection.id}
              connection={row.connection}
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
                choice.kind === "connection" ? choice.connectionId : choice.kind,
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

/** Asks before Cancel throws away what was typed: no wallet exists yet, so nothing is kept. */
function LeaveSetupDialog({
  onKeepGoing,
  onLeave,
  open,
  t,
}: {
  onKeepGoing: () => void;
  onLeave: () => void;
  open: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <Modal
      isOpen={open}
      onClose={onKeepGoing}
      ariaLabel={t("DashboardCustody.walletSetupLeaveTitle")}
      size="sm"
    >
      <div className="space-y-6 p-6">
        <div className="space-y-2">
          <p className="text-subheading font-medium text-primary">
            {t("DashboardCustody.walletSetupLeaveTitle")}
          </p>
          <p className="text-body text-secondary">
            {t("DashboardCustody.walletSetupLeaveDescription")}
          </p>
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
  /** The provider's connections the list names: every one but a deactivated one. */
  connections: CustodyConnectionListItem[];
  hasManagedConfig: boolean;
  offersManaged: boolean;
  /** A new account of the project's own can be connected here (a BYOK setup). */
  offersOwn: boolean;
  /** The provider can run in an account of the project's own, so the screen asks whose. */
  asksAccount: boolean;
  /** The question lists its answers: more than one can be picked, or a connection needs care. */
  listsAccounts: boolean;
  /** The answer in effect: the user's while it is still offered, else the only one there is. */
  account: AccountChoice | null;
}

const NO_ACCOUNT_OPTIONS: AccountOptions = {
  connections: [],
  hasManagedConfig: false,
  offersManaged: false,
  offersOwn: false,
  asksAccount: false,
  listsAccounts: false,
  account: null,
};

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
  const offersByok = selectedAvailability.modes.includes("byok");
  const connections = offersByok
    ? input.connections.filter(
        (connection) => connection.provider === providerId && connection.status !== "deactivated"
      )
    : [];
  const offersOwn = offersByok && isByokCustodyProvider(providerId);
  const selectable: AccountChoice[] = [
    ...(offersManaged ? [{ kind: "managed" } as const] : []),
    ...connections
      .filter(isSelectableConnection)
      .map((connection) => ({ kind: "connection", connectionId: connection.id }) as const),
    ...(offersOwn ? [{ kind: "own" } as const] : []),
  ];
  const [onlyAccount, ...otherAccounts] = selectable;
  const chosenIsOffered =
    chosenAccount !== null && selectable.some((option) => isSameAccount(option, chosenAccount));
  let account: AccountChoice | null = null;
  if (chosenIsOffered) {
    account = chosenAccount;
  } else if (onlyAccount !== undefined && otherAccounts.length === 0) {
    account = onlyAccount;
  }
  return {
    connections,
    hasManagedConfig: offersManaged && selectedAvailability.status === "active",
    offersManaged,
    offersOwn,
    asksAccount: offersByok,
    listsAccounts:
      selectable.length > 1 ||
      connections.some((connection) => !isSelectableConnection(connection)),
    account,
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
  if (
    model.options.asksAccount &&
    model.options.account?.kind === "managed" &&
    model.providerEntry !== null &&
    POLICY_FREE_MANAGED_PROVIDERS.has(model.providerEntry.id)
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
 * marks the quick-start step and hands the new wallet to `onCreated`. A refusal lands in
 * `setErrorMessage`.
 */
function useCreateWallet({
  canSubmit,
  formAction,
  onCreated,
  setErrorMessage,
}: {
  canSubmit: boolean;
  formAction: typeof createCustodySetupWalletAction | typeof initializeCustodySetupAction;
  onCreated: (walletId: string) => void;
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
  const byokSetupProvider =
    account?.kind === "own" && providerEntry !== null && isByokCustodyProvider(providerEntry.id)
      ? providerEntry.id
      : null;
  // Fireblocks names no wallet at setup: its vault accounts arrive with their own names.
  const showLabelField = byokSetupProvider !== "fireblocks";
  const canProvisionWallet =
    providerEntry !== null &&
    (createsInExistingAccount ? providerEntry.supportsAdditionalWallets : setsUpManaged);
  return {
    options,
    awaitingAccountChoice: providerEntry !== null && account === null,
    byokSetupProvider,
    canProvisionWallet,
    createsInExistingAccount,
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

type CredentialFormHandlers = Pick<
  ComponentProps<typeof ByokCredentialForm>,
  "onPendingChange" | "onReadyChange" | "onRecoveryChange" | "onRecoveryLockChange"
>;

/** What the summary's Connection line says for the answer in effect, or `null` before one. */
function resolveConnectionSummary(input: {
  model: WalletSetupModel;
  providerLabel: string | null;
  t: ReturnType<typeof useTranslations>;
}): { value: string; muted: boolean; hint: string } | null {
  const { model, providerLabel, t } = input;
  const { account, asksAccount, connections } = model.options;
  if (!asksAccount || account === null || providerLabel === null) {
    return null;
  }
  const hint = t("DashboardCustody.walletSetupConnectionHint", { provider: providerLabel });
  switch (account.kind) {
    case "managed":
      return {
        value: t("DashboardCustody.walletSetupModeManagedTitle", { provider: providerLabel }),
        muted: false,
        hint,
      };
    case "own":
      return {
        value: t("DashboardCustody.walletSetupConnectionYourOwn", { provider: providerLabel }),
        muted: true,
        hint,
      };
    case "connection":
      return {
        value:
          connections.find((connection) => connection.id === account.connectionId)?.label ?? "",
        muted: false,
        hint,
      };
    default: {
      const unhandledAccount: never = account;
      throw new Error(`Unhandled wallet account: ${JSON.stringify(unhandledAccount)}`);
    }
  }
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
  const { account } = model.options;
  const providerLabel = model.providerEntry === null ? null : model.providerEntry.label;
  // What the answers reveal below them fades in, rather than appearing at full strength.
  const answerKey = `${selectedProvider ?? ""}:${account === null ? "" : accountValue(account)}`;
  const credentialRevealRef = useStepFade<HTMLDivElement>(answerKey);
  const detailsRevealRef = useStepFade<HTMLDivElement>(answerKey);
  const byokProvider = model.byokSetupProvider;
  // The details form waits for a provider and its account; BYOK has its own form.
  const detailsProvider =
    byokProvider === null && !model.awaitingAccountChoice ? model.providerEntry : null;
  const connectionId = account?.kind === "connection" ? account.connectionId : null;
  const labelPlaceholder = t(
    selectedProvider === "privy"
      ? "DashboardCustody.walletSetupLabelPlaceholderTreasury"
      : "DashboardCustody.newDesign.walletLabelPlaceholder"
  );
  const purposeHint = t(
    flags.issuance
      ? "DashboardCustody.walletPurposeHintWithIssuance"
      : "DashboardCustody.walletPurposeHint"
  );

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
      {model.options.asksAccount && model.providerEntry !== null && providerLabel !== null ? (
        <AccountQuestion
          account={account}
          disabled={answersLocked}
          environment={environment}
          onSelect={onAccountChange}
          options={model.options}
          providerId={model.providerEntry.id}
          providerLabel={providerLabel}
          t={t}
        />
      ) : null}
      {byokProvider !== null ? (
        // Typing here is input Cancel would throw away, so the flow hears of it.
        <div ref={credentialRevealRef} onInput={onCredentialsTouched}>
          <ByokCredentialForm
            // A failed check's connection belongs to its provider: another starts fresh.
            key={byokProvider}
            {...credentialFormHandlers}
            provider={byokProvider}
            formId={DETAILS_FORM_ID}
            hostsWalletLabel
            showSubmitButton={false}
            onSuccess={() => onConnected(byokProvider)}
          />
        </div>
      ) : null}
      {model.showLabelField ? (
        <section aria-labelledby="wallet-details-title" className="space-y-6">
          <h3 id="wallet-details-title" className={SECTION_TITLE_CLASS}>
            {t("DashboardCustody.walletSetupDetailsTitle")}
          </h3>
          <WalletLabelField
            disabled={answersLocked}
            name={model.createsInExistingAccount ? "label" : "walletLabel"}
            onChange={onWalletLabelChange}
            placeholder={labelPlaceholder}
            t={t}
            value={walletLabel}
          />
          {/* One form owns DETAILS_FORM_ID at a time: the credential form or the details. */}
          {detailsProvider !== null ? (
            <div ref={detailsRevealRef}>
              <WalletDetailsForm
                // A chosen account belongs to its provider: another starts with none chosen.
                key={detailsProvider.id}
                choosePurpose={model.createsInExistingAccount}
                connectionId={connectionId}
                onSubmit={onDetailsSubmit}
                providerId={detailsProvider.id}
                purposeHint={purposeHint}
                purposes={model.purposes}
                t={t}
              />
            </div>
          ) : null}
        </section>
      ) : null}
      <CreatedWithSummary
        connection={resolveConnectionSummary({ model, providerLabel, t })}
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
  const [credentialsTouched, setCredentialsTouched] = useState(false);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
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
    chosenAccount,
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
    formAction: model.createsInExistingAccount
      ? createCustodySetupWalletAction
      : initializeCustodySetupAction,
    onCreated: handleCreated,
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
    setCredentialsTouched(false);
    setErrorMessage(null);
  };

  const leave = () => router.push(href("/dashboard/wallets"));
  // Only what the user put on the screen counts: the provider the flow opened on does not.
  const hasInput =
    walletLabel.trim() !== "" ||
    chosenAccount !== null ||
    credentialsTouched ||
    selectedProvider !== openingProvider;

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
            hint={showPrimary ? setupHint({ model, providerLabel, t }) : null}
            onCancel={() => (hasInput ? setLeaveConfirmOpen(true) : leave())}
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
            credentialFormHandlers={{
              onPendingChange: setByokRequestPending,
              onReadyChange: setFireblocksReady,
              onRecoveryChange: setByokInRecovery,
              onRecoveryLockChange: setByokRecoveryLocked,
            }}
            environment={environment}
            errorMessage={errorMessage}
            flags={flags}
            model={model}
            onAccountChange={(account) => {
              setChosenAccount(account);
              resetAnswerState();
            }}
            onConnected={handleConnected}
            onCredentialsTouched={() => setCredentialsTouched(true)}
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
        open={leaveConfirmOpen}
        onKeepGoing={() => setLeaveConfirmOpen(false)}
        onLeave={() => {
          setLeaveConfirmOpen(false);
          leave();
        }}
        t={t}
      />
    </div>
  );
}
