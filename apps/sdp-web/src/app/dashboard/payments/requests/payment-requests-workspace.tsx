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
import { useRouter, useSearchParams } from "next/navigation";
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
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { getStoredApiKeySecret } from "@/lib/playground-api-keys";
import { useZodForm } from "@/lib/use-zod-form";
import { cn } from "@/lib/utils";
import { AddExternalAccountDialog } from "../counterparty/add-external-account-dialog";
import { CounterpartyPlaygroundLoading } from "../counterparty-menu-loading";
import { formatDisplayAmount, formatTimestamp, shortenAddress } from "../payments-overview.utils";
import { syncPlaygroundApiKeysForActiveTab } from "../payments-playground-api-key-state";
import { fetchCounterpartyAccounts } from "../payments-workspace.data";
import { PaymentsRouteTabs } from "../payments-workspace-tabs";
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
  onCreated: () => void;
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
      ? ["payment-request-counterparty-accounts", selectedCounterpartyId]
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
    const res = await dashboardFetch("/api/dashboard/payments/requests", {
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
    onCreated();
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
  apiBaseUrl: string | null;
  apiKeys: DashboardPlaygroundApiKeyOption[];
  wallets: PaymentsDashboardWallet[];
  counterparties: Counterparty[];
}

export function PaymentRequestsWorkspace({
  initialPaymentRequests,
  initialError,
  initialLocalErrorCode,
  apiBaseUrl,
  apiKeys,
  wallets,
  counterparties,
}: PaymentRequestsWorkspaceProps) {
  const t = useTranslations();
  const router = useRouter();
  const { sdpEnvironment, selectedPlaygroundApiKeyId, setPlaygroundApiKeys } =
    useDashboardWorkspace();
  const searchParams = useSearchParams();
  const tokens = useMemo(
    () => deriveTokenOptions(CLUSTER_BY_SDP_ENVIRONMENT[sdpEnvironment]),
    [sdpEnvironment]
  );
  const isPlaygroundTab = searchParams.get("tab") === "playground";
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
  const playgroundApiKeyValue = useMemo(() => {
    if (!selectedPlaygroundApiKey) {
      return "";
    }
    const stored = getStoredApiKeySecret({
      apiKeyId: selectedPlaygroundApiKey.id,
      keyPrefix: selectedPlaygroundApiKey.keyPrefix,
    });
    return stored ? stored : "";
  }, [selectedPlaygroundApiKey]);

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
      return ANYONE_OPTION;
    }
    const name = counterpartyNameById.get(counterpartyId);
    return name ? name : counterpartyId;
  };
  const selectedWalletName = selected ? walletNameById.get(selected.walletId) : null;
  const selectedTokenSymbol = selected ? tokenSymbolByMint.get(selected.token) : undefined;

  return (
    <>
      <DashboardWorkspaceTabShell
        isPlaygroundTab={isPlaygroundTab}
        tabNavigation={
          <PaymentsRouteTabs
            basePath="/dashboard/payments/requests"
            value={isPlaygroundTab ? "playground" : "overview"}
          />
        }
        overviewClassName="flex min-h-0 flex-col overflow-hidden"
        overviewKey="payment-requests-overview-tab"
        playgroundKey="payment-requests-playground-tab"
        overview={
          <Card className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden rounded-lg border border-border-default bg-surface-raised py-0 shadow-none ring-0">
            <CardHeader className="p-4">
              <CardTitle>{t("DashboardPayments.requests.paymentRequests")}</CardTitle>
              <CardDescription>
                {t("DashboardPayments.requests.paymentRequestsDescription")}
              </CardDescription>
              {requests.length > 0 && (
                <CardAction>
                  <Button type="button" iconLeft={<PlusIcon />} onClick={() => setCreateOpen(true)}>
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
                  <Button type="button" iconLeft={<PlusIcon />} onClick={() => setCreateOpen(true)}>
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
                          onClick={() => setSelected(request)}
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
                        <TableHead className="w-[22%]">
                          {t("DashboardPayments.requests.from")}
                        </TableHead>
                        <TableHead className="w-[22%]">
                          {t("DashboardPayments.requests.to")}
                        </TableHead>
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
                            <TableCell className="font-medium">
                              <span className="block truncate">
                                {formatDisplayAmount(
                                  request.amount,
                                  symbol ? symbol : shortenAddress(request.token)
                                )}
                              </span>
                            </TableCell>
                            <TableCell className="text-sm text-secondary">
                              <span className="block truncate">
                                {fromLabel(request.counterpartyId)}
                              </span>
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
        }
        playground={
          <PaymentRequestsPlayground
            apiBaseUrl={apiBaseUrl}
            apiKeyValue={playgroundApiKeyValue}
            hasActiveApiKeys={apiKeys.length > 0}
            wallets={wallets}
            tokens={tokens}
          />
        }
      />

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
          onCreated={() => {
            setCreateOpen(false);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
