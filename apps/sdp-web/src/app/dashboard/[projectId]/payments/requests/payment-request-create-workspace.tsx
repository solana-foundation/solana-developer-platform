"use client";

import type { CreatedPaymentRequest, PaymentsDashboardWallet } from "@sdp/types/payments";
import { CLUSTER_BY_SDP_ENVIRONMENT } from "@sdp/types/well-known-tokens";
import { Button } from "@sdp/ui/button";
import { cn } from "@sdp/ui/cn";
import { Combobox } from "@sdp/ui/combobox";
import { InfoHint } from "@sdp/ui/info-hint";
import { Input } from "@sdp/ui/input";
import { Label } from "@sdp/ui/label";
import { ListEmptyState } from "@sdp/ui/list-empty-state";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { shortenAddress } from "@/app/dashboard/[projectId]/payments/payments-overview.utils";
import {
  formatDateTime,
  formatDecimalAmount,
} from "@/app/dashboard/[projectId]/payments/payments-presentation";
import {
  AmountUnitToggle,
  TokenAmountQuotePreview,
} from "@/app/dashboard/[projectId]/payments/token-amount-entry-controls";
import {
  displayAmountSchema,
  type TokenAmountFields,
  tokenAmountFieldsSchema,
} from "@/app/dashboard/[projectId]/payments/token-amount-fields";
import {
  type TokenAmountEntry,
  useTokenAmountEntry,
} from "@/app/dashboard/[projectId]/payments/use-token-amount-entry";
import { WizardFrame } from "@/components/wizard-frame";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { fetchResultAnswer } from "@/lib/idempotency";
import { DEMO_PREFILL_AMOUNTS } from "@/lib/payments-demo/demo-prefill";
import { usePaymentsDemo } from "@/lib/payments-demo/payments-demo-context";
import { PAYMENT_REQUESTS_HREF, paymentRequestHref } from "@/lib/payments-routes";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { useOutcomeUnknownNotice } from "@/lib/use-outcome-unknown";
import { useZodForm } from "@/lib/use-zod-form";
import { expiresAtForAction, settleExpiresAt } from "./payment-request-expiry";
import { deriveTokenOptions, type PaymentRequestTokenOption } from "./payment-requests-page.data";

const EXPIRY_OPTIONS = [
  { id: "none", hours: null, labelKey: "DashboardPayments.requests.noExpiry" },
  { id: "oneHour", hours: 1, labelKey: "DashboardPayments.requests.oneHour" },
  { id: "twentyFourHours", hours: 24, labelKey: "DashboardPayments.requests.twentyFourHours" },
  { id: "sevenDays", hours: 168, labelKey: "DashboardPayments.requests.sevenDays" },
  { id: "thirtyDays", hours: 720, labelKey: "DashboardPayments.requests.thirtyDays" },
] as const satisfies readonly { id: string; hours: number | null; labelKey: MessageKey }[];

const EMPTY_STEP = [{ label: "", title: "" }];

/** The token a new request starts on, as the design's does. */
const DEFAULT_TOKEN_SYMBOL = "USDC";

/** The new request's fields, as the user edits them. */
const paymentRequestFormSchema = z.object({
  ...tokenAmountFieldsSchema.shape,
  /** The picked token's mint; "" until one is picked. */
  token: z.string(),
  /** The picked wallet's id; "" until one is picked. */
  wallet: z.string(),
  /** The picked `EXPIRY_OPTIONS` id. */
  expiry: z.string(),
});

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

/**
 * Whether the amount input holds one the request can be made from: a token
 * amount the API takes, or a display amount the quote route prices.
 */
function isValidTypedAmount(unit: TokenAmountFields["amountUnit"], typed: string): boolean {
  switch (unit) {
    case "token":
      return isValidAmount(typed);
    case "display":
      return displayAmountSchema.safeParse(typed).success;
    default: {
      const unreachable: never = unit;
      throw new Error(`Unknown amount entry unit: ${String(unreachable)}`);
    }
  }
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
 * Puts nodes where a translated sentence has its `{amount}` and `{wallet}` slots, so
 * each part can carry its own ink while the word order stays the catalog's.
 */
function fillSentence(template: string, parts: Record<string, ReactNode>): ReactNode[] {
  return template.split(/\{(\w+)\}/).map((segment, index) =>
    index % 2 === 1 ? (
      // Each slot is named once in the sentence, so its name keys it.
      <span key={segment}>{parts[segment]}</span>
    ) : (
      segment
    )
  );
}

function FieldHint({ children }: { children: ReactNode }) {
  return <p className="text-meta text-tertiary">{children}</p>;
}

/** The request put in words: what is paid into where, with what is still unset in faint ink. */
function ReadsAs({ amount, wallet }: { amount: string | null; wallet: string | null }) {
  const t = useTranslations();
  const sentence = t("DashboardPayments.requests.anyoneCanPaySentence", {
    amount: "{amount}",
    wallet: "{wallet}",
  });
  return (
    <div className="flex flex-col gap-2 pt-2">
      <span className="text-meta text-secondary">{t("DashboardPayments.requests.readsAs")}</span>
      <p className="max-w-[36em] text-body text-secondary">
        {fillSentence(sentence, {
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

/** A wallet as the form names it: its label, else its shortened address. */
function walletDisplayName(wallet: PaymentsDashboardWallet | null): string | null {
  return wallet ? (wallet.label ?? shortenAddress(wallet.publicKey)) : null;
}

/** The amount as the sentence reads it ("25.00 USDC"), once it is valid and a token is set. */
function readsAsAmount(
  amount: string,
  token: PaymentRequestTokenOption | null,
  locale: string
): string | null {
  return isValidAmount(amount) && token
    ? `${formatDecimalAmount(amount.trim(), locale)} ${token.symbol}`
    : null;
}

/** The page when the project has no wallet: nowhere to be paid into, and the way to Wallets. */
function NoWalletState() {
  const t = useTranslations();
  const projectHref = useProjectHref();
  return (
    <WizardFrame steps={EMPTY_STEP} currentStep={0} progressLabel="" hideProgress>
      <ListEmptyState
        message={t("DashboardPayments.requests.noWalletTitle")}
        description={t("DashboardPayments.requests.noWalletDescription")}
        action={
          <Button asChild variant="outline">
            <Link href={projectHref("/dashboard/wallets")}>
              {t("DashboardPayments.requests.openWallets")}
            </Link>
          </Button>
        }
      />
    </WizardFrame>
  );
}

/** The footer: cancel back to the list, and create once the request has what it needs. */
function CreateFooter({
  canCreate,
  submitting,
  onCreate,
}: {
  canCreate: boolean;
  submitting: boolean;
  onCreate: () => void;
}) {
  const t = useTranslations();
  const router = useRouter();
  const projectHref = useProjectHref();
  return (
    // The design's footer buttons take a 16px inset; a create that cannot run yet is an
    // outline on the control wash with its label in the tertiary ink, at full opacity.
    <div className="flex items-center justify-end gap-4 [--button-padding-x-lg:1rem]">
      <Button
        type="button"
        variant="ghost"
        onClick={() => router.push(projectHref(PAYMENT_REQUESTS_HREF))}
      >
        {t("DashboardPayments.requests.cancel")}
      </Button>
      <Button
        type="button"
        variant={canCreate ? "default" : "outline"}
        disabled={!canCreate}
        className={cn(!canCreate && "opacity-100 text-tertiary refresh:bg-fill")}
        onClick={onCreate}
      >
        {submitting
          ? t("DashboardPayments.requests.creating")
          : t("DashboardPayments.requests.createAndCopyLink")}
      </Button>
    </div>
  );
}

/**
 * The amount asked, with a note under it while it is not one the API would take. For a mint
 * with a display rule it may be typed as wallets show it; the quote's credit is what is asked.
 */
function AmountField({
  fields,
  setField,
  entry,
  symbol,
  busy,
}: {
  fields: TokenAmountFields;
  setField: (key: "amount" | "displayAmount", value: string) => void;
  entry: TokenAmountEntry;
  symbol: string;
  /** True while the request is being created. */
  busy: boolean;
}) {
  const t = useTranslations();
  const displayEntry = entry.unit === "display";
  const typed = displayEntry ? fields.displayAmount : fields.amount;
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="payment-request-amount">
        {displayEntry
          ? t("DashboardPayments.tokenAmount.displayAmountLabel")
          : t("DashboardPayments.requests.amount")}
      </Label>
      <Input
        id="payment-request-amount"
        size="xl"
        inputMode="decimal"
        autoComplete="off"
        placeholder="0.00"
        className="tabular-nums"
        value={typed}
        onChange={(event) =>
          setField(displayEntry ? "displayAmount" : "amount", event.currentTarget.value)
        }
      />
      {typed.trim() && !isValidTypedAmount(entry.unit, typed) ? (
        <p className="text-meta text-error">{t("DashboardPayments.requests.invalidAmount")}</p>
      ) : null}
      <AmountUnitToggle entry={entry} busy={busy} />
      <TokenAmountQuotePreview entry={entry} symbol={symbol} />
    </div>
  );
}

/** When the link stops working, with the instant that comes to read from the browser clock. */
function ExpiryField({ expiry, onChange }: { expiry: string; onChange: (next: string) => void }) {
  const t = useTranslations();
  const locale = useLocale();
  const expiresAt = resolveExpiryDate(expiry);
  return (
    <div className="flex flex-col gap-1.5">
      <Combobox
        label={t("DashboardPayments.requests.linkExpires")}
        value={expiry}
        onChange={onChange}
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
  );
}

interface PaymentRequestCreateWorkspaceProps {
  wallets: PaymentsDashboardWallet[];
  /** Why the wallets could not be read, when they could not. */
  walletsError: string | null;
}

/**
 * New request, as its own page: the amount and token, the wallet it lands in, when the link stops
 * working, and the request read back as a sentence. Creating it copies the link and opens the
 * request in the list.
 *
 * The API matches a payment to its request by the link's reference, not by who sent it, so a
 * request names no payer: anyone holding the link can pay it.
 */
export function PaymentRequestCreateWorkspace({
  wallets,
  walletsError,
}: PaymentRequestCreateWorkspaceProps) {
  if (!walletsError && wallets.length === 0) {
    return <NoWalletState />;
  }
  return <PaymentRequestCreateForm wallets={wallets} walletsError={walletsError} />;
}

/** The new request's form and its create, once there is a wallet to be paid into. */
function PaymentRequestCreateForm({ wallets, walletsError }: PaymentRequestCreateWorkspaceProps) {
  const t = useTranslations();
  const notice = useOutcomeUnknownNotice(null);
  const locale = useLocale();
  const router = useRouter();
  const projectHref = useProjectHref();
  const { sdpEnvironment } = useDashboardWorkspace();
  const tokens = useMemo(
    () => deriveTokenOptions(CLUSTER_BY_SDP_ENVIRONMENT[sdpEnvironment]),
    [sdpEnvironment]
  );

  const demo = usePaymentsDemo();
  const {
    values: fields,
    setField,
    setFields,
  } = useZodForm(paymentRequestFormSchema, {
    amountUnit: "token",
    amount: demo ? DEMO_PREFILL_AMOUNTS.request : "",
    displayAmount: "",
    token: "",
    wallet: "",
    expiry: "none",
  });
  const { expiry } = fields;
  const [submitting, setSubmitting] = useState(false);
  // Once the link exists the page stays busy: it is on its way to the request, and a second
  // press must not make a second link.
  const [linkCreated, setLinkCreated] = useState(false);
  const busy = submitting || linkCreated;

  // A pick that is no longer on offer (another cluster's mint, another project's wallet) falls
  // back rather than being sent.
  const defaultToken =
    tokens.find((token) => token.symbol === DEFAULT_TOKEN_SYMBOL) ?? tokens.at(0) ?? null;
  const token = tokens.find((option) => option.mintAddress === fields.token) ?? defaultToken;
  const wallet = wallets.find((option) => option.walletId === fields.wallet) ?? null;

  // A request's amount is what the recipient receives, so it is quoted as a credit.
  const amountEntry = useTokenAmountEntry({
    mint: token === null ? null : token.mintAddress,
    basis: "credit",
    fields,
    setFields,
  });
  const requestAmount = amountEntry.tokenAmount.trim();

  const canCreate =
    isValidAmount(requestAmount) &&
    token !== null &&
    wallet !== null &&
    !busy &&
    !amountEntry.quoteInFlight;

  async function create() {
    if (!canCreate || token === null || wallet === null) {
      return;
    }
    // A display amount's credit holds only until its quote expires.
    if (!amountEntry.canSubmitAt(Date.now())) {
      amountEntry.refreshQuote();
      toast.error(t("DashboardPayments.tokenAmount.quoteExpired"));
      return;
    }
    setSubmitting(true);
    let created: CreatedPaymentRequest | undefined;
    try {
      const input = JSON.stringify([wallet.walletId, token.mintAddress, requestAmount, expiry]);
      // Read from the clock once per action, so a retry resends the same body
      // under the first attempt's key.
      const expiresAt = expiresAtForAction(input, () => resolveExpiryDate(expiry));
      if (expiresAt === undefined) {
        // The retry's frozen expiry has passed: not sent. Show the list to check.
        toast.error(t("DashboardPayments.requests.staleRetryCheckList"));
        router.push(projectHref(PAYMENT_REQUESTS_HREF));
        return;
      }
      const res = await dashboardFetch<{ data: CreatedPaymentRequest }>(
        "/api/dashboard/payments/requests",
        {
          method: "POST",
          body: {
            walletId: wallet.walletId,
            token: token.mintAddress,
            amount: requestAmount,
            expiresAt,
          },
        }
      );
      settleExpiresAt(input, expiresAt, res);
      if (!res.ok) {
        // The earlier attempt may have created it: show the list to check.
        if (notice(fetchResultAnswer(res))) {
          router.push(projectHref(PAYMENT_REQUESTS_HREF));
          return;
        }
        toast.error(res.error);
        return;
      }
      setLinkCreated(true);
      created = res.data?.data;
    } finally {
      setSubmitting(false);
    }
    // A demo request lives in this browser only, so the public pay page can't open its link.
    const copied =
      !demo && created?.publicToken
        ? await copyToClipboard(`${window.location.origin}/pay/${created.publicToken}`)
        : false;
    toast.success(t("DashboardPayments.requests.requestCreated"), {
      id: "payment-request-created",
      description: demo
        ? t("DashboardPayments.demo.noPayLink")
        : copied
          ? t("DashboardPayments.requests.linkOnClipboard")
          : t("DashboardPayments.requests.copyLinkFromRequest"),
    });
    router.push(projectHref(created?.id ? paymentRequestHref(created.id) : PAYMENT_REQUESTS_HREF));
  }

  return (
    <WizardFrame
      steps={EMPTY_STEP}
      currentStep={0}
      progressLabel=""
      hideProgress
      footer={
        <CreateFooter canCreate={canCreate} submitting={busy} onCreate={() => void create()} />
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
          <AmountField
            fields={fields}
            setField={setField}
            entry={amountEntry}
            symbol={token === null ? "" : token.symbol}
            busy={busy}
          />
          <Combobox
            label={t("DashboardPayments.requests.token")}
            value={token ? token.mintAddress : null}
            onChange={(next) => setField("token", next)}
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
          onChange={(next) => setField("wallet", next)}
          options={wallets.map((option) => ({
            value: option.walletId,
            label: option.label ?? shortenAddress(option.publicKey),
            description: shortenAddress(option.publicKey),
          }))}
          placeholder={t("DashboardPayments.requests.selectWallet")}
          searchPlaceholder={t("DashboardPayments.onchainSend.searchWallets")}
          disabled={wallets.length === 0}
        />

        <ExpiryField expiry={expiry} onChange={(next) => setField("expiry", next)} />

        <ReadsAs
          amount={readsAsAmount(requestAmount, token, locale)}
          wallet={walletDisplayName(wallet)}
        />
      </form>
    </WizardFrame>
  );
}
