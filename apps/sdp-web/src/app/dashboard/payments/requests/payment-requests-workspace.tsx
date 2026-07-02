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
import { ApiPlaygroundShellSkeleton } from "@/components/api-playground-shell-skeleton";
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
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { getStoredApiKeySecret } from "@/lib/playground-api-keys";
import { useZodForm } from "@/lib/use-zod-form";
import { cn } from "@/lib/utils";
import { AddExternalAccountDialog } from "../counterparty/add-external-account-dialog";
import { formatDisplayAmount, formatTimestamp, shortenAddress } from "../payments-overview.utils";
import { fetchCounterpartyAccounts } from "../payments-workspace.data";
import { deriveTokenOptions, type PaymentRequestTokenOption } from "./payment-requests-page.data";

const PaymentRequestsPlayground = dynamic(
  () => import("./payment-requests-playground").then((module) => module.PaymentRequestsPlayground),
  { loading: () => <ApiPlaygroundShellSkeleton /> }
);

const STATUS_LABEL = {
  awaiting_payment: "Awaiting payment",
  paid: "Paid",
  canceled: "Canceled",
  expired: "Expired",
} as const satisfies Record<PaymentRequestStatus, string>;

const EXPIRY_OPTIONS = [
  { label: "No expiry", hours: null },
  { label: "1 hour", hours: 1 },
  { label: "24 hours", hours: 24 },
  { label: "7 days", hours: 168 },
  { label: "30 days", hours: 720 },
] as const satisfies readonly { label: string; hours: number | null }[];

/**
 * Resolves the absolute expiry instant from a preset label. Computed from the
 * browser clock; callers `.toISOString()` it to UTC before sending.
 */
function resolveExpiryDate(expiryLabel: string): Date | null {
  const option = EXPIRY_OPTIONS.find((entry) => entry.label === expiryLabel);
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
  const tone = statusTone(status);
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
        tone === "success" && "bg-status-success-bg text-status-success-text",
        tone === "error" && "bg-status-error-bg text-status-error-text",
        tone === "pending" && "bg-border-light text-text-medium"
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <span className="shrink-0 text-sm text-text-medium">{label}</span>
      <span className="min-w-0 break-all text-right text-sm font-medium text-text-extra-high">
        {children}
      </span>
    </div>
  );
}

const ANYONE_OPTION = "Anyone with the link";

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
  const form = useZodForm(createRequestSchema, {
    amount: "",
    token: "",
    wallet: "",
    counterparty: ANYONE_OPTION,
    expiry: "No expiry",
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
    ([, id]: readonly [string, string]) => fetchCounterpartyAccounts(id),
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
    toast.success("Payment link created");
    onCreated();
  }

  return (
    <>
      <Modal
        isOpen
        ariaLabel="Create payment request"
        onClose={submitting || addingAccount ? undefined : onClose}
        size="lg"
      >
        <div className="space-y-5 p-6">
          <div className="space-y-1">
            <h2 className="text-xl font-medium tracking-tight text-text-extra-high">
              Create payment link
            </h2>
            <p className="text-sm text-text-medium">
              Request a fixed payment to one of your wallets.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="pr-amount">Amount</Label>
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
                <p className="mt-1 text-xs text-status-error-text">{form.errors.amount}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Token</Label>
              <Select
                size="xl"
                className="w-full"
                iconLeft={<CoinsIcon />}
                placeholder="Select token"
                value={form.values.token}
                onValueChange={(value) => form.setField("token", value === null ? "" : value)}
              >
                {tokens.map((token) => (
                  <SelectItem key={token.mintAddress} value={token.mintAddress}>
                    {token.symbol}
                  </SelectItem>
                ))}
              </Select>
              {form.errors.token && (
                <p className="mt-1 text-xs text-status-error-text">{form.errors.token}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Destination wallet</Label>
            <Select
              size="xl"
              className="w-full"
              iconLeft={<WalletIcon />}
              placeholder="Select wallet"
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
            {form.errors.wallet && (
              <p className="mt-1 text-xs text-status-error-text">{form.errors.wallet}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label>From (counterparty)</Label>
            <Select
              size="xl"
              className="w-full"
              iconLeft={<UserIcon />}
              value={form.values.counterparty}
              onValueChange={(value) =>
                form.setField("counterparty", value === null ? ANYONE_OPTION : value)
              }
            >
              <SelectItem value={ANYONE_OPTION}>{ANYONE_OPTION}</SelectItem>
              {counterparties.map((counterparty) => (
                <SelectItem key={counterparty.id} value={counterparty.id}>
                  {counterparty.displayName}
                </SelectItem>
              ))}
            </Select>
            {selectedCounterpartyId && accountsLoading && (
              <p className="text-xs text-text-low">Loading crypto account…</p>
            )}
            {selectedCounterpartyId && !accountsLoading && primaryCryptoAccount && (
              <p className="text-xs text-text-low">
                Pays from{" "}
                <span className="font-mono text-text-medium">
                  {resolveAccountAddress(primaryCryptoAccount)}
                </span>
              </p>
            )}
            {selectedCounterpartyId && !accountsLoading && !primaryCryptoAccount && (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-border-medium px-3 py-2">
                <p className="text-xs text-text-low">No crypto account on file.</p>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  iconLeft={<PlusIcon />}
                  onClick={() => setAddingAccount(true)}
                >
                  Add
                </Button>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label>Link expires</Label>
            <Select
              size="xl"
              className="w-full"
              iconLeft={<ClockIcon />}
              trailing={expiresAtPreview ? formatLocalExpiry(expiresAtPreview) : undefined}
              value={form.values.expiry}
              onValueChange={(value) =>
                form.setField("expiry", value === null ? "No expiry" : value)
              }
            >
              {EXPIRY_OPTIONS.map((option) => (
                <SelectItem key={option.label} value={option.label}>
                  {option.label}
                </SelectItem>
              ))}
            </Select>
          </div>

          <div className="flex items-center justify-end gap-3">
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleSubmit()} disabled={submitting}>
              {submitting ? "Creating…" : "Create link"}
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
  apiBaseUrl: string | null;
  apiKeys: DashboardPlaygroundApiKeyOption[];
  wallets: PaymentsDashboardWallet[];
  counterparties: Counterparty[];
}

export function PaymentRequestsWorkspace({
  initialPaymentRequests,
  initialError,
  apiBaseUrl,
  apiKeys,
  wallets,
  counterparties,
}: PaymentRequestsWorkspaceProps) {
  const router = useRouter();
  const { counterpartyTab, sdpEnvironment, selectedPlaygroundApiKeyId, setPlaygroundApiKeys } =
    useDashboardWorkspace();
  const tokens = useMemo(
    () => deriveTokenOptions(CLUSTER_BY_SDP_ENVIRONMENT[sdpEnvironment]),
    [sdpEnvironment]
  );
  const isPlaygroundTab = counterpartyTab === "playground";
  const [selected, setSelected] = useState<PaymentRequest | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const requests = initialPaymentRequests;

  useEffect(() => {
    setPlaygroundApiKeys(apiKeys);
  }, [apiKeys, setPlaygroundApiKeys]);

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
        overviewClassName="flex min-h-0 flex-col overflow-hidden"
        overviewKey="payment-requests-overview-tab"
        playgroundKey="payment-requests-playground-tab"
        overview={
          <Card className="flex min-h-0 flex-1 flex-col">
            <CardHeader>
              <CardTitle>Payment requests</CardTitle>
              <CardDescription>Shareable links that request a fixed payment.</CardDescription>
              {requests.length > 0 && (
                <CardAction>
                  <Button type="button" iconLeft={<PlusIcon />} onClick={() => setCreateOpen(true)}>
                    Create
                  </Button>
                </CardAction>
              )}
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col">
              {initialError ? (
                <p className="text-sm text-status-error-text">{initialError}</p>
              ) : requests.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border-medium py-16 text-center">
                  <ReceiptTextIcon className="h-10 w-10 text-text-extra-low" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-text-extra-high">
                      No payment requests yet
                    </p>
                    <p className="text-sm text-text-low">
                      Create a payment link to request a fixed payment.
                    </p>
                  </div>
                  <Button type="button" iconLeft={<PlusIcon />} onClick={() => setCreateOpen(true)}>
                    Create
                  </Button>
                </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <Table className="[&_table]:table-fixed">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[16%]">Status</TableHead>
                        <TableHead className="w-[20%]">Amount</TableHead>
                        <TableHead className="w-[22%]">From</TableHead>
                        <TableHead className="w-[22%]">To</TableHead>
                        <TableHead className="w-[20%]">Created</TableHead>
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
                            <TableCell className="text-sm text-text-medium">
                              <span className="block truncate">
                                {fromLabel(request.counterpartyId)}
                              </span>
                            </TableCell>
                            <TableCell className="font-mono text-sm text-text-medium">
                              <span className="block truncate">
                                {shortenAddress(request.destinationAddress)}
                              </span>
                            </TableCell>
                            <TableCell className="text-sm text-text-medium">
                              {formatTimestamp(request.createdAt)}
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
          ariaLabel="Payment request details"
          onClose={() => setSelected(null)}
          size="lg"
        >
          <div className="space-y-5 p-6">
            <div className="flex items-start justify-between gap-4 pr-8">
              <div className="space-y-1">
                <h2 className="text-xl font-medium tracking-tight text-text-extra-high">
                  Payment request
                </h2>
                <p className="text-sm text-text-medium">{formatTimestamp(selected.createdAt)}</p>
              </div>
              <StatusBadge status={selected.status} />
            </div>

            <div className="rounded-2xl bg-border-extra-light p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-text-medium">
                Amount requested
              </p>
              <p className="truncate text-xl font-semibold tracking-tight text-text-extra-high">
                {formatDisplayAmount(
                  selected.amount,
                  selectedTokenSymbol ? selectedTokenSymbol : shortenAddress(selected.token)
                )}
              </p>
            </div>

            <div className="flex items-center gap-2 rounded-2xl border border-border-light p-3">
              <span className="min-w-0 flex-1 truncate font-mono text-sm text-text-medium">
                {payLink}
              </span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                iconLeft={<CopyIcon />}
                onClick={() => {
                  void navigator.clipboard.writeText(payLink);
                  toast.success("Payment link copied");
                }}
              >
                Copy
              </Button>
            </div>

            <div className="rounded-2xl border border-border-light px-4">
              <div className="divide-y divide-border-light">
                <DetailRow label="From">{fromLabel(selected.counterpartyId)}</DetailRow>
                <DetailRow label="To">
                  {selectedWalletName ? (
                    <span className="block font-medium text-text-extra-high">
                      {selectedWalletName}
                    </span>
                  ) : null}
                  <span className="block font-mono text-xs font-normal text-text-medium">
                    {selected.destinationAddress}
                  </span>
                </DetailRow>
                <DetailRow label="Token">
                  {selectedTokenSymbol ? selectedTokenSymbol : shortenAddress(selected.token)}
                </DetailRow>
                <DetailRow label="Reference">{shortenAddress(selected.reference)}</DetailRow>
                <DetailRow label="Expires">
                  {selected.expiresAt ? formatTimestamp(selected.expiresAt) : "No expiry"}
                </DetailRow>
                <DetailRow label="Created">{formatTimestamp(selected.createdAt)}</DetailRow>
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
