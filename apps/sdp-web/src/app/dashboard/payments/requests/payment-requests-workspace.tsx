"use client";

import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  type Counterparty,
  type CounterpartyAccount,
  type PaymentRequest,
  type PaymentRequestStatus,
  type PaymentsDashboardWallet,
} from "@sdp/types";
import {
  BanknoteIcon,
  ChevronRightIcon,
  ClockIcon,
  CoinsIcon,
  CopyIcon,
  PlusIcon,
  ReceiptTextIcon,
  UserIcon,
  WalletIcon,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { z } from "zod";
import { paymentsQueryKeys } from "@/app/dashboard/payments/payments-query-key";
import {
  dashboardWorkspaceOverviewPanelClassName,
  dashboardWorkspacePlaygroundPanelClassName,
} from "@/components/dashboard-workspace-panel";
import { DashboardWorkspaceTabShell } from "@/components/dashboard-workspace-tab-shell";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { Select, SelectItem } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type DashboardPlaygroundApiKeyOption,
  useDashboardWorkspace,
} from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { readApiErrorCode } from "@/lib/api-error";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { useDashboardTab } from "@/lib/dashboard-url-state";
import { RENDER_SCOPE_HEADER_NAME } from "@/lib/project-cookie";
import { useZodForm } from "@/lib/use-zod-form";
import { cn } from "@/lib/utils";
import { AddExternalAccountDialog } from "../counterparty/add-external-account-dialog";
import { CounterpartyPlaygroundLoading } from "../counterparty-menu-loading";
import { formatDisplayAmount, formatTimestamp, shortenAddress } from "../payments-overview.utils";
import { syncPlaygroundApiKeysForActiveTab } from "../payments-playground-api-key-state";
import { fetchCounterpartyAccounts } from "../payments-workspace.data";
import {
  deriveTokenOptions,
  type PaymentRequestsLocalErrorCode,
  type PaymentRequestTokenOption,
} from "./payment-requests-page.data";

const PaymentRequestsPlayground = dynamic(
  () => import("./payment-requests-playground").then((module) => module.PaymentRequestsPlayground),
  { loading: () => <CounterpartyPlaygroundLoading /> }
);

const STATUS_TRANSLATION_KEYS = {
  awaiting_payment: "DashboardPayments.requests.awaitingPayment",
  paid: "DashboardPayments.requests.paid",
  canceled: "DashboardPayments.requests.canceled",
  expired: "DashboardPayments.requests.expired",
} as const satisfies Record<PaymentRequestStatus, MessageKey>;

const EXPIRY_OPTIONS = [
  { id: "none", hours: null, labelKey: "DashboardPayments.requests.noExpiry" },
  { id: "oneHour", hours: 1, labelKey: "DashboardPayments.requests.oneHour" },
  { id: "twentyFourHours", hours: 24, labelKey: "DashboardPayments.requests.twentyFourHours" },
  { id: "sevenDays", hours: 168, labelKey: "DashboardPayments.requests.sevenDays" },
  { id: "thirtyDays", hours: 720, labelKey: "DashboardPayments.requests.thirtyDays" },
] as const satisfies readonly { id: string; hours: number | null; labelKey: MessageKey }[];

/**
 * Error codes the create route sets on its own failures
 * (`api/dashboard/payments/requests`): they map to localized catalog copy,
 * while any other error keeps the server-provided message.
 */
const REQUEST_ERROR_TRANSLATION_KEYS = {
  render_scope_stale: "DashboardPayments.requests.stalePage",
  render_scope_project_mismatch: "DashboardPayments.requests.projectSelectionChanged",
  authentication_required: "DashboardPayments.requests.authenticationRequired",
} as const satisfies Record<string, MessageKey>;

/**
 * Resolves the message for a failed create call: catalog copy localized to the
 * viewer when the route reported one of its known codes, the server-provided
 * message otherwise.
 */
function localizedRequestError(
  result: { error: string; body: unknown },
  t: ReturnType<typeof useTranslations>
): string {
  const code = readApiErrorCode(result.body);
  if (code === null || !(code in REQUEST_ERROR_TRANSLATION_KEYS)) {
    return result.error;
  }
  return t(REQUEST_ERROR_TRANSLATION_KEYS[code as keyof typeof REQUEST_ERROR_TRANSLATION_KEYS]);
}

/**
 * Which render-scope refusal a failed create carried, if any. `stale` means
 * the scope was missing, unreadable, or expired while the current selection
 * still matches the project the form rendered under (the server reclassifies
 * an expired scope as a mismatch when the selection has moved), so re-render
 * recovery is safe. `project_mismatch` means the shared selection moved to
 * another project after render.
 */
function renderScopeRejection(result: { body: unknown }): "stale" | "project_mismatch" | null {
  const code = readApiErrorCode(result.body);
  if (code === "render_scope_stale") {
    return "stale";
  }
  if (code === "render_scope_project_mismatch") {
    return "project_mismatch";
  }
  return null;
}

/**
 * Resolves the absolute expiry instant from a preset label. Computed from the
 * browser clock; callers `.toISOString()` it to UTC before sending.
 */
function resolveExpiryDate(expiryId: string): Date | null {
  const option = EXPIRY_OPTIONS.find((entry) => entry.id === expiryId);
  if (!option || option.hours === null) {
    return null;
  }
  return new Date(Date.now() + option.hours * 3_600_000);
}

/**
 * Formats an expiry instant in the viewer's locale and timezone, e.g.
 * "June 27, 2026 at 2:30 PM GMT+8". The server stores UTC; this is the
 * local-time translation for display only.
 *
 * @param date - Expiry instant (any timezone; rendered in the browser's).
 * @returns Locale-formatted date with time and timezone name.
 */
function formatLocalExpiry(date: Date): string {
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function statusTone(status: PaymentRequestStatus): "success" | "error" | "pending" {
  switch (status) {
    case "paid":
      return "success";
    case "expired":
      return "error";
    case "canceled":
      return "error";
    case "awaiting_payment":
      return "pending";
  }
}

function StatusBadge({ status }: { status: PaymentRequestStatus }) {
  const t = useTranslations();
  const tone = statusTone(status);
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
        tone === "success" && "bg-success-bg text-success",
        tone === "error" && "bg-error-bg text-error",
        tone === "pending" && "bg-fill-strong text-secondary"
      )}
    >
      {t(STATUS_TRANSLATION_KEYS[status])}
    </span>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <span className="shrink-0 text-sm text-secondary">{label}</span>
      <span className="min-w-0 break-all text-right text-sm font-medium text-primary">
        {children}
      </span>
    </div>
  );
}

const ANYONE_OPTION = "anyone";

function resolveAccountAddress(account: CounterpartyAccount): string {
  const address = account.details.address;
  return typeof address === "string" ? address : "";
}

const createRequestSchema = z.object({
  // Decimal-only (no scientific notation / Infinity) to match the API's
  // isDecimalString check, so the modal can't submit an amount the server rejects.
  amount: z
    .string()
    .refine(
      (value) => /^\d+(\.\d+)?$/.test(value.trim()) && Number(value) > 0,
      "Enter a valid amount"
    ),
  token: z.string().min(1, "Select a token"),
  wallet: z.string().min(1, "Select a wallet"),
  counterparty: z.string().min(1),
  expiry: z.string().min(1),
});

/**
 * The counterparty selector and its account wiring: while a concrete
 * counterparty is chosen, the section loads and previews the crypto account
 * the payment would originate from and offers to add one when none exists.
 */
function CounterpartyAccountSection({
  counterparties,
  value,
  onValueChange,
  accountsLoading,
  primaryCryptoAccount,
  onAddAccount,
}: {
  counterparties: Counterparty[];
  value: string;
  onValueChange: (value: string) => void;
  accountsLoading: boolean;
  primaryCryptoAccount: CounterpartyAccount | undefined;
  onAddAccount: () => void;
}) {
  const t = useTranslations();
  const selectedCounterpartyId = value === ANYONE_OPTION ? undefined : value;
  return (
    <div className="space-y-2">
      <Label>{t("DashboardPayments.requests.fromCounterparty")}</Label>
      <Select
        size="xl"
        className="w-full"
        iconLeft={<UserIcon />}
        value={value}
        onValueChange={(next) => onValueChange(next === null ? ANYONE_OPTION : next)}
      >
        <SelectItem value={ANYONE_OPTION}>
          {t("DashboardPayments.requests.anyoneWithLink")}
        </SelectItem>
        {counterparties.map((counterparty) => (
          <SelectItem key={counterparty.id} value={counterparty.id}>
            {counterparty.displayName}
          </SelectItem>
        ))}
      </Select>
      {selectedCounterpartyId && accountsLoading && (
        <p className="text-xs text-tertiary">
          {t("DashboardPayments.requests.loadingCryptoAccount")}
        </p>
      )}
      {selectedCounterpartyId && !accountsLoading && primaryCryptoAccount && (
        <p className="text-xs text-tertiary">
          {t("DashboardPayments.requests.paysFrom")}{" "}
          <span className="font-mono text-secondary">
            {resolveAccountAddress(primaryCryptoAccount)}
          </span>
        </p>
      )}
      {selectedCounterpartyId && !accountsLoading && !primaryCryptoAccount && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-border-strong px-3 py-2">
          <p className="text-xs text-tertiary">{t("DashboardPayments.requests.noCryptoAccount")}</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            iconLeft={<PlusIcon />}
            onClick={onAddAccount}
          >
            {t("DashboardPayments.requests.add")}
          </Button>
        </div>
      )}
    </div>
  );
}

function CreateRequestModal({
  wallets,
  tokens,
  counterparties,
  renderScope,
  onClose,
  onCreated,
}: {
  wallets: PaymentsDashboardWallet[];
  tokens: PaymentRequestTokenOption[];
  counterparties: Counterparty[];
  /**
   * Sealed scope naming the project this page rendered with. Sent back on the
   * create call so the BFF can refuse it when the shared project cookie has
   * moved (APE-706).
   */
  renderScope: string | null;
  onClose: () => void;
  /**
   * Receives the created request so its details can be shown without a round trip,
   * or `null` when the response carried no usable link.
   */
  onCreated: (request: PaymentRequest | null) => void;
}) {
  const t = useTranslations();
  const router = useRouter();
  const form = useZodForm(createRequestSchema, {
    amount: "",
    token: "",
    wallet: "",
    counterparty: ANYONE_OPTION,
    expiry: "none",
  });
  const [submitting, setSubmitting] = useState(false);

  // Option values are the unique id/mint/walletId (not the display label), so
  // wallets or tokens sharing a label/symbol can't collapse onto each other. The
  // DS Select mirrors each item's text in the trigger, so the label still shows.
  const selectedCounterpartyId =
    form.values.counterparty === ANYONE_OPTION ? undefined : form.values.counterparty;
  const {
    data: counterpartyAccounts,
    isLoading: accountsLoading,
    mutate: mutateAccounts,
  } = useSWR(
    selectedCounterpartyId
      ? paymentsQueryKeys.paymentRequestCounterpartyAccounts({
          counterpartyId: selectedCounterpartyId,
        })
      : null,
    ([, id]: readonly [string, string]) => fetchCounterpartyAccounts(id, t),
    { revalidateOnFocus: false }
  );
  const cryptoAccounts = useMemo(
    () =>
      (counterpartyAccounts ? counterpartyAccounts : []).filter(
        (account) => account.accountKind === "crypto_wallet" && account.status === "active"
      ),
    [counterpartyAccounts]
  );
  const primaryCryptoAccount = cryptoAccounts.at(0);
  const [addingAccount, setAddingAccount] = useState(false);

  const expiresAtPreview = resolveExpiryDate(form.values.expiry);

  async function handleSubmit() {
    const result = form.validate();
    if (!result.ok) {
      return;
    }
    const counterpartyId =
      result.data.counterparty === ANYONE_OPTION ? null : result.data.counterparty;
    const expiresAt = resolveExpiryDate(result.data.expiry);

    setSubmitting(true);
    const res = await dashboardFetch<{ data: PaymentRequest }>("/api/dashboard/payments/requests", {
      method: "POST",
      headers: renderScope ? { [RENDER_SCOPE_HEADER_NAME]: renderScope } : undefined,
      body: {
        walletId: result.data.wallet,
        token: result.data.token,
        amount: result.data.amount,
        counterpartyId,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
      },
    });
    setSubmitting(false);
    if (!res.ok) {
      toast.error(localizedRequestError(res, t));
      const scopeRejection = renderScopeRejection(res);
      if (scopeRejection === "stale") {
        // The scope expired or went unreadable while the current selection
        // still matches the project this form rendered under: refresh the
        // server component so a fresh scope — sealed for the same project —
        // replaces the expired one while the still-open form keeps every
        // entered value. The resubmit itself stays manual on purpose:
        // retrying automatically would repeat the submission without the
        // user seeing the error (APE-706).
        router.refresh();
      } else if (scopeRejection === "project_mismatch") {
        // The shared selection moved to another project, so the refreshed
        // page mints its fresh scope for THAT project. The form must not
        // survive the refresh with values entered under the old one — a
        // manual retry would then pass the scope check and silently
        // attribute the request to the new project, whose org-level custody
        // wallet may resolve identically. Close the form, discarding those
        // values, and let the refresh re-render the workspace for the
        // current selection (APE-706).
        onClose();
        router.refresh();
      }
      return;
    }

    toast.success(t("DashboardPayments.requests.paymentLinkCreated"));

    // The create response is the full request, so the details view can open straight
    // away. Without this the link was only reachable by waiting for the table to
    // repopulate and then reopening the row. A response without a `publicToken` still
    // means the request was created, so fall back to closing rather than reporting a
    // failure that did not happen — the row will arrive with the refresh.
    const created = res.data?.data;
    onCreated(created?.publicToken ? created : null);
  }

  return (
    <>
      <Modal
        isOpen
        ariaLabel={t("DashboardPayments.requests.createPaymentRequest")}
        onClose={submitting || addingAccount ? undefined : onClose}
        size="lg"
      >
        <div className="space-y-5 p-6">
          <div className="space-y-1">
            <h2 className="text-xl font-medium tracking-tight text-primary">
              {t("DashboardPayments.requests.createPaymentLink")}
            </h2>
            <p className="text-sm text-secondary">
              {t("DashboardPayments.requests.createPaymentLinkDescription")}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="pr-amount">{t("DashboardPayments.requests.amount")}</Label>
              <Input
                size="xl"
                id="pr-amount"
                type="number"
                inputMode="decimal"
                step="any"
                iconLeft={<BanknoteIcon />}
                placeholder="0.00"
                className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                value={form.values.amount}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  form.setField("amount", event.target.value)
                }
              />
              {form.errors.amount && (
                <p className="mt-1 text-xs text-error">{form.errors.amount}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>{t("DashboardPayments.requests.token")}</Label>
              <Select
                size="xl"
                className="w-full"
                iconLeft={<CoinsIcon />}
                placeholder={t("DashboardPayments.requests.selectToken")}
                value={form.values.token}
                onValueChange={(value) => form.setField("token", value === null ? "" : value)}
              >
                {tokens.map((token) => (
                  <SelectItem key={token.mintAddress} value={token.mintAddress}>
                    {token.symbol}
                  </SelectItem>
                ))}
              </Select>
              {form.errors.token && <p className="mt-1 text-xs text-error">{form.errors.token}</p>}
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t("DashboardPayments.requests.destinationWallet")}</Label>
            <Select
              size="xl"
              className="w-full"
              iconLeft={<WalletIcon />}
              placeholder={t("DashboardPayments.requests.selectWallet")}
              value={form.values.wallet}
              onValueChange={(value) => form.setField("wallet", value === null ? "" : value)}
            >
              {wallets.map((wallet) => {
                const name = wallet.label ? wallet.label : shortenAddress(wallet.publicKey);
                return (
                  <SelectItem key={wallet.walletId} value={wallet.walletId}>
                    {name}
                  </SelectItem>
                );
              })}
            </Select>
            {form.errors.wallet && <p className="mt-1 text-xs text-error">{form.errors.wallet}</p>}
          </div>

          <CounterpartyAccountSection
            counterparties={counterparties}
            value={form.values.counterparty}
            onValueChange={(value) => form.setField("counterparty", value)}
            accountsLoading={accountsLoading}
            primaryCryptoAccount={primaryCryptoAccount}
            onAddAccount={() => setAddingAccount(true)}
          />

          <div className="space-y-2">
            <Label>{t("DashboardPayments.requests.linkExpires")}</Label>
            <Select
              size="xl"
              className="w-full"
              iconLeft={<ClockIcon />}
              trailing={expiresAtPreview ? formatLocalExpiry(expiresAtPreview) : undefined}
              value={form.values.expiry}
              onValueChange={(value) => form.setField("expiry", value === null ? "none" : value)}
            >
              {EXPIRY_OPTIONS.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </Select>
          </div>

          <div className="flex items-center justify-end gap-3">
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              {t("DashboardPayments.requests.cancel")}
            </Button>
            <Button type="button" onClick={() => void handleSubmit()} disabled={submitting}>
              {submitting
                ? t("DashboardPayments.requests.creating")
                : t("DashboardPayments.requests.createLink")}
            </Button>
          </div>
        </div>
      </Modal>
      {selectedCounterpartyId && addingAccount ? (
        <AddExternalAccountDialog
          isOpen
          counterpartyId={selectedCounterpartyId}
          onAdded={() => void mutateAccounts()}
          onClose={() => setAddingAccount(false)}
        />
      ) : null}
    </>
  );
}

/**
 * Display names resolved once for the list and details views: wallet labels,
 * token symbols, and counterparty display names keyed by their API ids, with
 * `fromLabel` falling back to the raw id for counterparties since renamed or
 * removed.
 */
function usePaymentRequestLabels(
  wallets: PaymentsDashboardWallet[],
  tokens: PaymentRequestTokenOption[],
  counterparties: Counterparty[]
) {
  const walletNameById = useMemo(
    () => new Map(wallets.map((wallet) => [wallet.walletId, wallet.label])),
    [wallets]
  );
  const tokenSymbolByMint = useMemo(
    () => new Map(tokens.map((token) => [token.mintAddress, token.symbol])),
    [tokens]
  );
  const counterpartyNameById = useMemo(
    () =>
      new Map(counterparties.map((counterparty) => [counterparty.id, counterparty.displayName])),
    [counterparties]
  );
  const fromLabel = (counterpartyId: string | null): string => {
    if (!counterpartyId) {
      return ANYONE_OPTION;
    }
    const name = counterpartyNameById.get(counterpartyId);
    return name ? name : counterpartyId;
  };
  return { walletNameById, tokenSymbolByMint, fromLabel };
}

/**
 * The overview panel: request list (mobile cards, desktop table), error and
 * empty states, and the create entry point.
 */
function PaymentRequestsOverview({
  requests,
  initialError,
  initialLocalErrorCode,
  tokenSymbolByMint,
  fromLabel,
  onSelect,
  onCreate,
}: {
  requests: PaymentRequest[];
  initialError?: string;
  initialLocalErrorCode?: PaymentRequestsLocalErrorCode;
  tokenSymbolByMint: Map<string, string>;
  fromLabel: (counterpartyId: string | null) => string;
  onSelect: (request: PaymentRequest) => void;
  onCreate: () => void;
}) {
  const t = useTranslations();
  return (
    <Card className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden rounded-lg border border-border-default bg-surface-raised py-0 shadow-none ring-0">
      <CardHeader className="p-4">
        <CardTitle>{t("DashboardPayments.requests.paymentRequests")}</CardTitle>
        <CardDescription>
          {t("DashboardPayments.requests.paymentRequestsDescription")}
        </CardDescription>
        {requests.length > 0 && (
          <CardAction>
            <Button type="button" iconLeft={<PlusIcon />} onClick={onCreate}>
              {t("DashboardPayments.requests.create")}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col px-0">
        {initialError || initialLocalErrorCode ? (
          <p className="text-sm text-error">
            {initialError ?? t("DashboardPayments.requests.loadFailed")}
          </p>
        ) : requests.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16 text-center">
            <ReceiptTextIcon className="h-10 w-10 text-muted" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-primary">
                {t("DashboardPayments.requests.noPaymentRequests")}
              </p>
              <p className="text-sm text-tertiary">
                {t("DashboardPayments.requests.noPaymentRequestsDescription")}
              </p>
            </div>
            <Button type="button" iconLeft={<PlusIcon />} onClick={onCreate}>
              {t("DashboardPayments.requests.create")}
            </Button>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="divide-y divide-border-default md:hidden">
              {requests.map((request) => {
                const symbol = tokenSymbolByMint.get(request.token);
                return (
                  <button
                    key={request.id}
                    type="button"
                    onClick={() => onSelect(request)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-fill-subtle"
                  >
                    <span className="min-w-0 flex-1 space-y-1.5">
                      <span className="flex items-center justify-between gap-3">
                        <StatusBadge status={request.status} />
                        <span className="truncate text-sm font-medium text-primary">
                          {formatDisplayAmount(
                            request.amount,
                            symbol ? symbol : shortenAddress(request.token)
                          )}
                        </span>
                      </span>
                      <span className="block truncate text-xs text-secondary">
                        {fromLabel(request.counterpartyId)} ·{" "}
                        {formatTimestamp(request.createdAt, t)}
                      </span>
                    </span>
                    <ChevronRightIcon className="size-4 shrink-0 text-tertiary" />
                  </button>
                );
              })}
            </div>
            <Table className="hidden rounded-none border-0 [&_table]:min-w-[800px] [&_table]:table-fixed md:block">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[16%]">{t("DashboardPayments.status")}</TableHead>
                  <TableHead className="w-[20%]">
                    {t("DashboardPayments.requests.amount")}
                  </TableHead>
                  <TableHead className="w-[22%]">{t("DashboardPayments.requests.from")}</TableHead>
                  <TableHead className="w-[22%]">{t("DashboardPayments.requests.to")}</TableHead>
                  <TableHead className="w-[20%]">
                    {t("DashboardPayments.recurring.created")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.map((request) => {
                  const symbol = tokenSymbolByMint.get(request.token);
                  return (
                    <TableRow
                      key={request.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => onSelect(request)}
                      onKeyDown={(event: KeyboardEvent) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onSelect(request);
                        }
                      }}
                      className="cursor-pointer"
                    >
                      <TableCell>
                        <StatusBadge status={request.status} />
                      </TableCell>
                      <TableCell className="font-medium">
                        <span className="block truncate">
                          {formatDisplayAmount(
                            request.amount,
                            symbol ? symbol : shortenAddress(request.token)
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-secondary">
                        <span className="block truncate">{fromLabel(request.counterpartyId)}</span>
                      </TableCell>
                      <TableCell className="font-mono text-sm text-secondary">
                        <span className="block truncate">
                          {shortenAddress(request.destinationAddress)}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-secondary">
                        {formatTimestamp(request.createdAt, t)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** The read-only details view for a selected request, including its pay link. */
function PaymentRequestDetailsModal({
  request,
  payLink,
  walletName,
  tokenSymbol,
  fromLabel,
  onClose,
}: {
  request: PaymentRequest;
  payLink: string;
  walletName: string | null | undefined;
  tokenSymbol: string | undefined;
  fromLabel: (counterpartyId: string | null) => string;
  onClose: () => void;
}) {
  const t = useTranslations();
  return (
    <Modal
      isOpen
      ariaLabel={t("DashboardPayments.requests.paymentRequestDetails")}
      onClose={onClose}
      size="lg"
    >
      <div className="space-y-5 p-6">
        <div className="flex items-start justify-between gap-4 pr-8">
          <div className="space-y-1">
            <h2 className="text-xl font-medium tracking-tight text-primary">
              {t("DashboardPayments.requests.paymentRequest")}
            </h2>
            <p className="text-sm text-secondary">{formatTimestamp(request.createdAt, t)}</p>
          </div>
          <StatusBadge status={request.status} />
        </div>

        <div className="rounded-2xl bg-fill-subtle p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-secondary">
            {t("DashboardPayments.requests.amountRequested")}
          </p>
          <p className="truncate text-xl font-semibold tracking-tight text-primary">
            {formatDisplayAmount(
              request.amount,
              tokenSymbol ? tokenSymbol : shortenAddress(request.token)
            )}
          </p>
        </div>

        <div className="flex items-center gap-2 rounded-2xl border border-border-default p-3">
          <span className="min-w-0 flex-1 truncate font-mono text-sm text-secondary">
            {payLink}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            iconLeft={<CopyIcon />}
            onClick={() => {
              void navigator.clipboard.writeText(payLink);
              toast.success(t("DashboardPayments.requests.paymentLinkCopied"));
            }}
          >
            {t("DashboardPayments.requests.copy")}
          </Button>
        </div>

        <div className="rounded-2xl border border-border-default px-4">
          <div className="divide-y divide-border-default">
            <DetailRow label={t("DashboardPayments.requests.from")}>
              {fromLabel(request.counterpartyId)}
            </DetailRow>
            <DetailRow label={t("DashboardPayments.requests.to")}>
              {walletName ? (
                <span className="block font-medium text-primary">{walletName}</span>
              ) : null}
              <span className="block font-mono text-xs font-normal text-secondary">
                {request.destinationAddress}
              </span>
            </DetailRow>
            <DetailRow label={t("DashboardPayments.requests.token")}>
              {tokenSymbol ? tokenSymbol : shortenAddress(request.token)}
            </DetailRow>
            <DetailRow label={t("DashboardPayments.requests.reference")}>
              {shortenAddress(request.reference)}
            </DetailRow>
            <DetailRow label={t("DashboardPayments.requests.expires")}>
              {request.expiresAt
                ? formatTimestamp(request.expiresAt, t)
                : t("DashboardPayments.requests.noExpiry")}
            </DetailRow>
            <DetailRow label={t("DashboardPayments.recurring.created")}>
              {formatTimestamp(request.createdAt, t)}
            </DetailRow>
          </div>
        </div>
      </div>
    </Modal>
  );
}

interface PaymentRequestsWorkspaceProps {
  initialPaymentRequests: PaymentRequest[];
  initialError?: string;
  initialLocalErrorCode?: PaymentRequestsLocalErrorCode;
  apiBaseUrl: string | null;
  apiKeys: DashboardPlaygroundApiKeyOption[];
  wallets: PaymentsDashboardWallet[];
  counterparties: Counterparty[];
  /** Sealed scope for the project this page rendered with (`lib/render-scope`). */
  renderScope: string | null;
}

export function PaymentRequestsWorkspace({
  initialPaymentRequests,
  initialError,
  initialLocalErrorCode,
  apiBaseUrl,
  apiKeys,
  wallets,
  counterparties,
  renderScope,
}: PaymentRequestsWorkspaceProps) {
  const router = useRouter();
  const { sdpEnvironment, selectedPlaygroundApiKeyId, setPlaygroundApiKeys } =
    useDashboardWorkspace();
  const tokens = useMemo(
    () => deriveTokenOptions(CLUSTER_BY_SDP_ENVIRONMENT[sdpEnvironment]),
    [sdpEnvironment]
  );
  const isPlaygroundTab = useDashboardTab() === "playground";
  const [selected, setSelected] = useState<PaymentRequest | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const requests = initialPaymentRequests;

  useEffect(() => {
    syncPlaygroundApiKeysForActiveTab(isPlaygroundTab, apiKeys, setPlaygroundApiKeys);
  }, [apiKeys, isPlaygroundTab, setPlaygroundApiKeys]);

  const selectedPlaygroundApiKey = useMemo(
    () => apiKeys.find((key) => key.id === selectedPlaygroundApiKeyId),
    [apiKeys, selectedPlaygroundApiKeyId]
  );
  const payLink = selected ? `${window.location.origin}/pay/${selected.publicToken}` : null;

  const { walletNameById, tokenSymbolByMint, fromLabel } = usePaymentRequestLabels(
    wallets,
    tokens,
    counterparties
  );
  const selectedWalletName = selected ? walletNameById.get(selected.walletId) : null;
  const selectedTokenSymbol = selected ? tokenSymbolByMint.get(selected.token) : undefined;

  return (
    <>
      <DashboardWorkspaceTabShell
        panels={[
          {
            id: "overview",
            className: cn(
              dashboardWorkspaceOverviewPanelClassName,
              "flex min-h-0 flex-col overflow-hidden"
            ),
            content: (
              <PaymentRequestsOverview
                requests={requests}
                initialError={initialError}
                initialLocalErrorCode={initialLocalErrorCode}
                tokenSymbolByMint={tokenSymbolByMint}
                fromLabel={fromLabel}
                onSelect={setSelected}
                onCreate={() => setCreateOpen(true)}
              />
            ),
          },
          {
            id: "playground",
            className: dashboardWorkspacePlaygroundPanelClassName,
            content: (
              <PaymentRequestsPlayground
                apiBaseUrl={apiBaseUrl}
                apiKeyId={selectedPlaygroundApiKey?.id ?? null}
                hasActiveApiKeys={apiKeys.length > 0}
                wallets={wallets}
                tokens={tokens}
              />
            ),
          },
        ]}
      />

      {selected && payLink ? (
        <PaymentRequestDetailsModal
          request={selected}
          payLink={payLink}
          walletName={selectedWalletName}
          tokenSymbol={selectedTokenSymbol}
          fromLabel={fromLabel}
          onClose={() => setSelected(null)}
        />
      ) : null}

      {createOpen ? (
        <CreateRequestModal
          key={sdpEnvironment}
          wallets={wallets}
          tokens={tokens}
          counterparties={counterparties}
          renderScope={renderScope}
          onClose={() => setCreateOpen(false)}
          onCreated={(request) => {
            // Swap the create form for the details view and let the table repopulate
            // behind it, rather than closing and making the user find the new row.
            setCreateOpen(false);
            setSelected(request);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
