"use client";

import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  type Counterparty,
  type CounterpartyAccount,
  type PaymentRequest,
  type PaymentsDashboardWallet,
} from "@sdp/types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { paymentsQueryKeys } from "@/app/dashboard/payments/payments-query-key";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { InfoHint } from "@/components/ui/info-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { WizardFrame } from "@/components/wizard-frame";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { PAYMENT_REQUESTS_HREF, paymentRequestHref } from "@/lib/payments-routes";
import { cn } from "@/lib/utils";
import { NewSolanaAddressForm } from "../counterparty/new-solana-address-form";
import { shortenAddress } from "../payments-overview.utils";
import { formatDateTime, formatDecimalAmount } from "../payments-presentation";
import { fetchCounterpartyAccounts } from "../payments-workspace.data";
import { deriveTokenOptions } from "./payment-requests-page.data";

const EXPIRY_OPTIONS = [
  { id: "none", hours: null, labelKey: "DashboardPayments.requests.noExpiry" },
  { id: "oneHour", hours: 1, labelKey: "DashboardPayments.requests.oneHour" },
  { id: "twentyFourHours", hours: 24, labelKey: "DashboardPayments.requests.twentyFourHours" },
  { id: "sevenDays", hours: 168, labelKey: "DashboardPayments.requests.sevenDays" },
  { id: "thirtyDays", hours: 720, labelKey: "DashboardPayments.requests.thirtyDays" },
] as const satisfies readonly { id: string; hours: number | null; labelKey: MessageKey }[];

/** The form's "from anyone" choice; a sentinel value, never shown. */
const ANYONE = "anyone";

const EMPTY_STEP = [{ label: "", title: "" }];

/** The token a new request starts on, as the design's does. */
const DEFAULT_TOKEN_SYMBOL = "USDC";

/** Past this many contacts the From list opens with a search box; a short list reads at a glance. */
const FROM_SEARCH_THRESHOLD = 6;

/**
 * Resolves the absolute expiry instant from a preset. Computed from the browser clock; callers
 * `.toISOString()` it to UTC before sending.
 */
function resolveExpiryDate(expiryId: string): Date | null {
  const option = EXPIRY_OPTIONS.find((entry) => entry.id === expiryId);
  if (!option || option.hours === null) {
    return null;
  }
  return new Date(Date.now() + option.hours * 3_600_000);
}

/** Decimal only (no exponent, no Infinity), as the API's check is, and more than zero. */
function isValidAmount(value: string): boolean {
  const trimmed = value.trim();
  return /^\d+(\.\d+)?$/.test(trimmed) && Number(trimmed) > 0;
}

function hasCryptoAddress(accounts: readonly CounterpartyAccount[] | undefined): boolean {
  return (accounts ?? []).some(
    (account) => account.accountKind === "crypto_wallet" && account.status === "active"
  );
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Puts nodes where a translated sentence has its `{from}`, `{amount}` and `{wallet}` slots, so
 * each part can carry its own ink while the word order stays the catalog's.
 */
function fillSentence(template: string, parts: Record<string, ReactNode>): ReactNode[] {
  return template.split(/\{(\w+)\}/).map((segment, index) =>
    index % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the template's slots are fixed and ordered.
      <span key={index}>{parts[segment]}</span>
    ) : (
      segment
    )
  );
}

function FieldHint({ children }: { children: ReactNode }) {
  return <p className="text-meta text-tertiary">{children}</p>;
}

/** The request put in words: who pays what into where, with what is still unset in faint ink. */
function ReadsAs({
  from,
  amount,
  wallet,
}: {
  from: string | null;
  amount: string | null;
  wallet: string | null;
}) {
  const t = useTranslations();
  const sentence = t("DashboardPayments.requests.readsAsSentence", {
    from: "{from}",
    amount: "{amount}",
    wallet: "{wallet}",
  });
  return (
    <div className="flex flex-col gap-2 pt-2">
      <span className="text-meta text-secondary">{t("DashboardPayments.requests.readsAs")}</span>
      <p className="max-w-[36em] text-body text-secondary">
        {fillSentence(sentence, {
          from: from ? (
            <b className="font-medium text-primary">{from}</b>
          ) : (
            t("DashboardPayments.requests.anyoneWithLink")
          ),
          amount: amount ? (
            <b className="font-medium text-primary tabular-nums">{amount}</b>
          ) : (
            <span className="text-tertiary">{t("DashboardPayments.requests.anAmount")}</span>
          ),
          wallet: wallet ? (
            <b className="font-medium text-primary">{wallet}</b>
          ) : (
            <span className="text-tertiary">{t("DashboardPayments.requests.aWallet")}</span>
          ),
        })}
      </p>
    </div>
  );
}

interface PaymentRequestCreateWorkspaceProps {
  wallets: PaymentsDashboardWallet[];
  /** Why the wallets could not be read, when they could not. */
  walletsError: string | null;
  counterparties: Counterparty[];
}

/**
 * New request, as its own page: the amount and token, the wallet it lands in, who pays it, when
 * the link stops working, and the request read back as a sentence. Creating it copies the link
 * and opens the request in the list.
 *
 * The API matches a payment to its request by the link's reference, not by who sent it, so
 * naming a contact records who is expected to pay; it does not stop anyone else paying the link.
 */
export function PaymentRequestCreateWorkspace({
  wallets,
  walletsError,
  counterparties,
}: PaymentRequestCreateWorkspaceProps) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { sdpEnvironment } = useDashboardWorkspace();
  const tokens = useMemo(
    () => deriveTokenOptions(CLUSTER_BY_SDP_ENVIRONMENT[sdpEnvironment]),
    [sdpEnvironment]
  );
  const contacts = useMemo(
    () => counterparties.filter((counterparty) => counterparty.status === "active"),
    [counterparties]
  );

  const [amount, setAmount] = useState("");
  const [pickedToken, setPickedToken] = useState("");
  const [pickedWallet, setPickedWallet] = useState("");
  const [pickedFrom, setPickedFrom] = useState(ANYONE);
  const [expiry, setExpiry] = useState<string>("none");
  const [addingAddress, setAddingAddress] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // A pick that is no longer on offer (another cluster's mint, another project's wallet) falls
  // back rather than being sent.
  const defaultToken =
    tokens.find((token) => token.symbol === DEFAULT_TOKEN_SYMBOL) ?? tokens.at(0) ?? null;
  const token = tokens.find((option) => option.mintAddress === pickedToken) ?? defaultToken;
  const wallet = wallets.find((option) => option.walletId === pickedWallet) ?? null;
  const contact = contacts.find((option) => option.id === pickedFrom) ?? null;

  const {
    data: contactAccounts,
    isLoading: accountsLoading,
    mutate: mutateAccounts,
  } = useSWR(
    contact
      ? paymentsQueryKeys.paymentRequestCounterpartyAccounts({ counterpartyId: contact.id })
      : null,
    ([, id]: readonly [string, string]) => fetchCounterpartyAccounts(id, t),
    { revalidateOnFocus: false }
  );
  const contactHasNoAddress =
    contact !== null &&
    !accountsLoading &&
    contactAccounts !== undefined &&
    !hasCryptoAddress(contactAccounts);

  const amountValid = isValidAmount(amount);
  const canCreate = amountValid && token !== null && wallet !== null && !submitting;
  const expiresAt = resolveExpiryDate(expiry);
  const walletName = wallet ? (wallet.label ?? shortenAddress(wallet.publicKey)) : null;

  async function create() {
    if (!canCreate || token === null || wallet === null) {
      return;
    }
    setSubmitting(true);
    const expiresAtOnSubmit = resolveExpiryDate(expiry);
    const res = await dashboardFetch<{ data: PaymentRequest }>("/api/dashboard/payments/requests", {
      method: "POST",
      body: {
        walletId: wallet.walletId,
        token: token.mintAddress,
        amount: amount.trim(),
        counterpartyId: contact ? contact.id : null,
        expiresAt: expiresAtOnSubmit ? expiresAtOnSubmit.toISOString() : null,
      },
    });
    if (!res.ok) {
      setSubmitting(false);
      toast.error(res.error);
      return;
    }
    // The page stays busy from here: it is on its way to the list, and a second press must not
    // make a second link.
    const created = res.data?.data;
    const copied = created?.publicToken
      ? await copyToClipboard(`${window.location.origin}/pay/${created.publicToken}`)
      : false;
    toast.success(t("DashboardPayments.requests.requestCreated"), {
      id: "payment-request-created",
      description: copied
        ? t("DashboardPayments.requests.linkOnClipboard")
        : t("DashboardPayments.requests.copyLinkFromRequest"),
    });
    router.push(created?.id ? paymentRequestHref(created.id) : PAYMENT_REQUESTS_HREF);
  }

  if (!walletsError && wallets.length === 0) {
    return (
      <WizardFrame steps={EMPTY_STEP} currentStep={0} progressLabel="" hideProgress>
        <ListEmptyState
          message={t("DashboardPayments.requests.noWalletTitle")}
          description={t("DashboardPayments.requests.noWalletDescription")}
          action={
            <Button asChild variant="outline">
              <Link href="/dashboard/wallets">{t("DashboardPayments.requests.openWallets")}</Link>
            </Button>
          }
        />
      </WizardFrame>
    );
  }

  return (
    <WizardFrame
      steps={EMPTY_STEP}
      currentStep={0}
      progressLabel=""
      hideProgress
      footer={
        // The design's footer buttons take a 16px inset; a create that cannot run yet is an
        // outline on the control wash with its label in the tertiary ink, at full opacity.
        <div className="flex items-center justify-end gap-4 [--button-padding-x-lg:1rem]">
          <Button type="button" variant="ghost" onClick={() => router.push(PAYMENT_REQUESTS_HREF)}>
            {t("DashboardPayments.requests.cancel")}
          </Button>
          <Button
            type="button"
            variant={canCreate ? "default" : "outline"}
            disabled={!canCreate}
            className={cn(!canCreate && "opacity-100 text-tertiary refresh:bg-fill")}
            onClick={() => void create()}
          >
            {submitting
              ? t("DashboardPayments.requests.creating")
              : t("DashboardPayments.requests.createAndCopyLink")}
          </Button>
        </div>
      }
    >
      {/* The design sets a single-page form 3px nearer the title than the frame's stepped
          flows sit. */}
      <form
        className="-mt-0.75 flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        {walletsError ? (
          <p role="alert" className="text-body text-error">
            {walletsError}
          </p>
        ) : null}
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="payment-request-amount">{t("DashboardPayments.requests.amount")}</Label>
            <Input
              id="payment-request-amount"
              size="xl"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              className="tabular-nums"
              value={amount}
              onChange={(event) => setAmount(event.currentTarget.value)}
            />
            {amount.trim() && !amountValid ? (
              <p className="text-meta text-error">
                {t("DashboardPayments.requests.invalidAmount")}
              </p>
            ) : null}
          </div>
          <Combobox
            label={t("DashboardPayments.requests.token")}
            value={token ? token.mintAddress : null}
            onChange={setPickedToken}
            options={tokens.map((option) => ({
              value: option.mintAddress,
              label: option.symbol,
            }))}
            placeholder={t("DashboardPayments.requests.selectToken")}
            searchable={false}
          />
        </div>

        <Combobox
          label={t("DashboardPayments.requests.destinationWallet")}
          labelAccessory={
            <InfoHint
              text={t("DashboardPayments.requests.destinationWalletHelp")}
              className="-my-px text-secondary"
            />
          }
          value={wallet ? wallet.walletId : null}
          onChange={setPickedWallet}
          options={wallets.map((option) => ({
            value: option.walletId,
            label: option.label ?? shortenAddress(option.publicKey),
            description: shortenAddress(option.publicKey),
          }))}
          placeholder={t("DashboardPayments.requests.selectWallet")}
          searchPlaceholder={t("DashboardPayments.onchainSend.searchWallets")}
          disabled={wallets.length === 0}
        />

        <div className="flex flex-col gap-1.5">
          <Combobox
            label={t("DashboardPayments.requests.from")}
            value={contact ? contact.id : ANYONE}
            onChange={(next) => {
              setPickedFrom(next);
              setAddingAddress(false);
            }}
            options={[
              { value: ANYONE, label: t("DashboardPayments.requests.anyoneWithLink") },
              ...contacts.map((option) => ({ value: option.id, label: option.displayName })),
            ]}
            searchable={contacts.length > FROM_SEARCH_THRESHOLD}
            searchPlaceholder={t("DashboardPayments.payForm.searchContacts")}
          />
          {contact && contactHasNoAddress && !addingAddress ? (
            <FieldHint>
              {t("DashboardPayments.requests.noAddressOnFile", { contact: contact.displayName })}{" "}
              <button
                type="button"
                onClick={() => setAddingAddress(true)}
                className="inline-flex min-h-6 items-center rounded-sm text-primary underline underline-offset-4 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                {t("DashboardPayments.requests.addAnAddress")}
              </button>
            </FieldHint>
          ) : null}
          {contact && addingAddress ? (
            // Opens under From, as the design does, in place of the hint that offered it.
            <NewSolanaAddressForm
              key={contact.id}
              className="mt-2.5"
              counterpartyId={contact.id}
              idPrefix="request-add"
              onAdded={() => {
                setAddingAddress(false);
                void mutateAccounts();
              }}
              onCancel={() => setAddingAddress(false)}
            />
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <Combobox
            label={t("DashboardPayments.requests.linkExpires")}
            value={expiry}
            onChange={setExpiry}
            options={EXPIRY_OPTIONS.map((option) => ({
              value: option.id,
              label: t(option.labelKey),
            }))}
            searchable={false}
          />
          <FieldHint>
            {expiresAt
              ? t("DashboardPayments.requests.linkStopsWorking", {
                  date: formatDateTime(expiresAt.toISOString(), locale) ?? "",
                })
              : t("DashboardPayments.requests.linkStaysLive")}
          </FieldHint>
        </div>

        <ReadsAs
          from={contact ? contact.displayName : null}
          amount={
            amountValid && token
              ? `${formatDecimalAmount(amount.trim(), locale)} ${token.symbol}`
              : null
          }
          wallet={walletName}
        />
      </form>
    </WizardFrame>
  );
}
