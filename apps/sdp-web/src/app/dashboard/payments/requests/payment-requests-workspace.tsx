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
  ClockIcon,
  CoinsIcon,
  CopyIcon,
  PlusIcon,
  ReceiptTextIcon,
  UserIcon,
  WalletIcon,
} from "lucide-react";
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
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Button } from "@/components/ui/button";
import { FilterMenu, FilterMenuOptions } from "@/components/ui/filter-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ListToolbar, RowsPerPageSelect } from "@/components/ui/list-toolbar";
import { Modal } from "@/components/ui/modal";
import { SearchInput } from "@/components/ui/search-input";
import { Select, SelectItem } from "@/components/ui/select";
import { StatusText, type StatusTone } from "@/components/ui/status-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { useDashboardUrlState } from "@/lib/dashboard-url-state";
import { PAYMENT_REQUEST_CREATE_PARAM } from "@/lib/payments-routes";
import { useZodForm } from "@/lib/use-zod-form";
import { cn } from "@/lib/utils";
import { AddExternalAccountDialog } from "../counterparty/add-external-account-dialog";
import { formatDisplayAmount, formatTimestamp, shortenAddress } from "../payments-overview.utils";
import { formatDateTime, formatDecimalAmount } from "../payments-presentation";
import { fetchCounterpartyAccounts } from "../payments-workspace.data";
import {
  deriveTokenOptions,
  type PaymentRequestsLocalErrorCode,
  type PaymentRequestTokenOption,
} from "./payment-requests-page.data";

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

const REQUEST_STATUS_TONE = {
  paid: "positive",
  awaiting_payment: "attention",
  canceled: "neutral",
  expired: "neutral",
} as const satisfies Record<PaymentRequestStatus, StatusTone>;

function StatusBadge({ status }: { status: PaymentRequestStatus }) {
  const t = useTranslations();
  return (
    <StatusText tone={REQUEST_STATUS_TONE[status]} className="text-body">
      {t(STATUS_TRANSLATION_KEYS[status])}
    </StatusText>
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

// The create form's "from anyone" choice; a sentinel value, never shown.
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

function CreateRequestModal({
  wallets,
  tokens,
  counterparties,
  onClose,
  onCreated,
}: {
  wallets: PaymentsDashboardWallet[];
  tokens: PaymentRequestTokenOption[];
  counterparties: Counterparty[];
  onClose: () => void;
  /**
   * Receives the created request so its details can be shown without a round trip,
   * or `null` when the response carried no usable link.
   */
  onCreated: (request: PaymentRequest | null) => void;
}) {
  const t = useTranslations();
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
      toast.error(res.error);
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

          <div className="space-y-2">
            <Label>{t("DashboardPayments.requests.fromCounterparty")}</Label>
            <Select
              size="xl"
              className="w-full"
              iconLeft={<UserIcon />}
              value={form.values.counterparty}
              onValueChange={(value) =>
                form.setField("counterparty", value === null ? ANYONE_OPTION : value)
              }
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
                <p className="text-xs text-tertiary">
                  {t("DashboardPayments.requests.noCryptoAccount")}
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  iconLeft={<PlusIcon />}
                  onClick={() => setAddingAccount(true)}
                >
                  {t("DashboardPayments.requests.add")}
                </Button>
              </div>
            )}
          </div>

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

interface PaymentRequestsWorkspaceProps {
  initialPaymentRequests: PaymentRequest[];
  initialError?: string;
  initialLocalErrorCode?: PaymentRequestsLocalErrorCode;
  wallets: PaymentsDashboardWallet[];
  counterparties: Counterparty[];
  /** The project's full request count; more than the rows given when the load was capped. */
  total?: number;
}

const REQUEST_STATUSES = Object.keys(STATUS_TRANSLATION_KEYS) as PaymentRequestStatus[];

/** Says when the load cap left older requests out, so search and filters are known to miss them. */
function DirectoryCapNotice({ count, total }: { count: number; total: number }) {
  const t = useTranslations();
  if (total <= count) {
    return null;
  }
  return (
    <p className="text-meta text-tertiary">
      {t("DashboardPayments.requests.directoryCapped", { count, total })}
    </p>
  );
}

/**
 * The Requests list. The API has no search, so the page loads the newest requests up to a cap
 * and search, the status filter and paging all run over those here. When the cap cut the list
 * short, the list says so.
 */
export function PaymentRequestsWorkspace({
  initialPaymentRequests,
  initialError,
  initialLocalErrorCode,
  wallets,
  counterparties,
  total = initialPaymentRequests.length,
}: PaymentRequestsWorkspaceProps) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { sdpEnvironment } = useDashboardWorkspace();
  const { searchParams, replaceSearchParams } = useDashboardUrlState();
  const tokens = useMemo(
    () => deriveTokenOptions(CLUSTER_BY_SDP_ENVIRONMENT[sdpEnvironment]),
    [sdpEnvironment]
  );
  const [selected, setSelected] = useState<PaymentRequest | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<PaymentRequestStatus | undefined>();
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const requests = initialPaymentRequests;
  const createRequested = searchParams.get(PAYMENT_REQUEST_CREATE_PARAM) === "1";

  // The header's "New" is a link carrying ?create=1: open the dialog once, then drop the param
  // so a refresh or the back button does not reopen it.
  useEffect(() => {
    if (!createRequested) return;
    setCreateOpen(true);
    replaceSearchParams({ [PAYMENT_REQUEST_CREATE_PARAM]: null });
  }, [createRequested, replaceSearchParams]);

  const payLink = selected ? `${window.location.origin}/pay/${selected.publicToken}` : null;

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
      return t("DashboardPayments.requests.anyone");
    }
    const name = counterpartyNameById.get(counterpartyId);
    return name ? name : counterpartyId;
  };
  const amountLabel = (request: PaymentRequest) => {
    const symbol = tokenSymbolByMint.get(request.token);
    return `${formatDecimalAmount(request.amount, locale)} ${symbol ? symbol : shortenAddress(request.token)}`;
  };
  const selectedWalletName = selected ? walletNameById.get(selected.walletId) : null;
  const selectedTokenSymbol = selected ? tokenSymbolByMint.get(selected.token) : undefined;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return requests.filter((request) => {
      if (statusFilter !== undefined && request.status !== statusFilter) return false;
      if (!needle) return true;
      return [
        request.amount,
        tokenSymbolByMint.get(request.token) ?? request.token,
        request.counterpartyId ? (counterpartyNameById.get(request.counterpartyId) ?? "") : "",
        request.destinationAddress,
        request.reference,
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [requests, statusFilter, query, tokenSymbolByMint, counterpartyNameById]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const rows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const copyLink = (request: PaymentRequest) => {
    void navigator.clipboard.writeText(`${window.location.origin}/pay/${request.publicToken}`);
    toast.success(t("DashboardPayments.requests.paymentLinkCopied"));
  };

  return (
    <>
      <DashboardWorkspaceOverviewPanel className="flex flex-col gap-5">
        {initialError || initialLocalErrorCode ? (
          <p className="text-body text-error">
            {initialError ?? t("DashboardPayments.requests.loadFailed")}
          </p>
        ) : requests.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
            <ReceiptTextIcon className="size-8 text-tertiary" strokeWidth={1.5} aria-hidden />
            <div className="space-y-1">
              <p className="text-body font-medium text-primary">
                {t("DashboardPayments.requests.noPaymentRequests")}
              </p>
              <p className="text-body text-secondary">
                {t("DashboardPayments.requests.noPaymentRequestsDescription")}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              iconLeft={<PlusIcon />}
              onClick={() => setCreateOpen(true)}
            >
              {t("DashboardPayments.requests.new")}
            </Button>
          </div>
        ) : (
          <>
            <ListToolbar
              filters={
                <FilterMenu
                  label={t("Shared.SharedComponents.filter")}
                  searchPlaceholder={t("Shared.SharedComponents.filterBy")}
                  sections={[
                    {
                      id: "status",
                      label: t("DashboardPayments.status"),
                      value:
                        statusFilter === undefined
                          ? undefined
                          : t(STATUS_TRANSLATION_KEYS[statusFilter]),
                      content: (
                        <FilterMenuOptions
                          value={statusFilter}
                          anyLabel={t("Shared.SharedComponents.any")}
                          options={REQUEST_STATUSES.map((status) => ({
                            value: status,
                            label: t(STATUS_TRANSLATION_KEYS[status]),
                          }))}
                          onChange={(value) => {
                            setStatusFilter(REQUEST_STATUSES.find((status) => status === value));
                            setPage(1);
                          }}
                        />
                      ),
                    },
                  ]}
                />
              }
            >
              <RowsPerPageSelect
                value={pageSize}
                onChange={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
              />
              <SearchInput
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                clear={{
                  label: t("DashboardPayments.requests.clearSearch"),
                  onClear: () => setQuery(""),
                }}
                placeholder={t("DashboardPayments.requests.searchPlaceholder")}
                className="min-w-0 flex-1 sm:w-56 sm:flex-none"
              />
            </ListToolbar>
            <DirectoryCapNotice count={requests.length} total={total} />
            {rows.length === 0 ? (
              <p className="py-12 text-center text-body text-tertiary">
                {t("DashboardPayments.requests.noMatches")}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table className="min-w-[760px] rounded-none border-0">
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("DashboardPayments.status")}</TableHead>
                      <TableHead className="text-right">
                        {t("DashboardPayments.requests.amount")}
                      </TableHead>
                      <TableHead>{t("DashboardPayments.requests.from")}</TableHead>
                      <TableHead>{t("DashboardPayments.requests.to")}</TableHead>
                      <TableHead>{t("DashboardPayments.recurring.created")}</TableHead>
                      <TableHead className="w-px">
                        <span className="sr-only">{t("Shared.SharedComponents.copyLink")}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((request) => (
                      <TableRow
                        key={request.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelected(request)}
                        onKeyDown={(event: KeyboardEvent) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelected(request);
                          }
                        }}
                        className="cursor-pointer"
                      >
                        <TableCell>
                          <StatusBadge status={request.status} />
                        </TableCell>
                        <TableCell className="text-right text-body whitespace-nowrap text-primary tabular-nums">
                          {amountLabel(request)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "max-w-56 truncate text-body",
                            request.counterpartyId ? "text-primary" : "text-tertiary"
                          )}
                        >
                          {fromLabel(request.counterpartyId)}
                        </TableCell>
                        <TableCell className="text-body whitespace-nowrap text-secondary">
                          {shortenAddress(request.destinationAddress)}
                        </TableCell>
                        <TableCell className="text-body whitespace-nowrap text-secondary">
                          {formatDateTime(request.createdAt, locale)}
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            iconLeft={<CopyIcon />}
                            onClick={(event) => {
                              event.stopPropagation();
                              copyLink(request);
                            }}
                            onKeyDown={(event) => event.stopPropagation()}
                          >
                            {t("Shared.SharedComponents.copyLink")}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {filtered.length > pageSize ? (
              <ArrowPagination page={currentPage} pageCount={pageCount} onPageChange={setPage} />
            ) : null}
          </>
        )}
      </DashboardWorkspaceOverviewPanel>

      {selected && payLink ? (
        <Modal
          isOpen
          ariaLabel={t("DashboardPayments.requests.paymentRequestDetails")}
          onClose={() => setSelected(null)}
          size="lg"
        >
          <div className="space-y-5 p-6">
            <div className="flex items-start justify-between gap-4 pr-8">
              <div className="space-y-1">
                <h2 className="text-xl font-medium tracking-tight text-primary">
                  {t("DashboardPayments.requests.paymentRequest")}
                </h2>
                <p className="text-sm text-secondary">{formatTimestamp(selected.createdAt, t)}</p>
              </div>
              <StatusBadge status={selected.status} />
            </div>

            <div className="rounded-2xl bg-fill-subtle p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-secondary">
                {t("DashboardPayments.requests.amountRequested")}
              </p>
              <p className="truncate text-xl font-semibold tracking-tight text-primary">
                {formatDisplayAmount(
                  selected.amount,
                  selectedTokenSymbol ? selectedTokenSymbol : shortenAddress(selected.token)
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
                  {fromLabel(selected.counterpartyId)}
                </DetailRow>
                <DetailRow label={t("DashboardPayments.requests.to")}>
                  {selectedWalletName ? (
                    <span className="block font-medium text-primary">{selectedWalletName}</span>
                  ) : null}
                  <span className="block font-mono text-xs font-normal text-secondary">
                    {selected.destinationAddress}
                  </span>
                </DetailRow>
                <DetailRow label={t("DashboardPayments.requests.token")}>
                  {selectedTokenSymbol ? selectedTokenSymbol : shortenAddress(selected.token)}
                </DetailRow>
                <DetailRow label={t("DashboardPayments.requests.reference")}>
                  {shortenAddress(selected.reference)}
                </DetailRow>
                <DetailRow label={t("DashboardPayments.requests.expires")}>
                  {selected.expiresAt
                    ? formatTimestamp(selected.expiresAt, t)
                    : t("DashboardPayments.requests.noExpiry")}
                </DetailRow>
                <DetailRow label={t("DashboardPayments.recurring.created")}>
                  {formatTimestamp(selected.createdAt, t)}
                </DetailRow>
              </div>
            </div>
          </div>
        </Modal>
      ) : null}

      {createOpen ? (
        <CreateRequestModal
          key={sdpEnvironment}
          wallets={wallets}
          tokens={tokens}
          counterparties={counterparties}
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
