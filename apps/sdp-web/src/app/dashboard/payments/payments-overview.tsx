"use client";

import { SectionEntry } from "@/app/dashboard/wallets/section-entry";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useEscapeKey } from "@/lib/use-escape-key";
import type {
  CustodyWalletAggregate,
  CustodyWalletTokenBalance,
  PaymentTransferSummary as TransferRecord,
  PaymentsDashboardWallet as WalletRecord,
} from "@sdp/types";
import { ArrowDownLeft, ArrowUpRight, ExternalLink, RefreshCw } from "lucide-react";
import QRCode from "qrcode";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import {
  fetchTransfers,
  fetchWalletAggregate,
  fetchWallets,
  getDevnetExplorerUrl,
  runComplianceCheck,
} from "./payments-workspace.data";
import type { ComplianceSnapshot } from "./payments-workspace.types";
import { ProviderRiskTable } from "./provider-risk-table";

interface PaymentsOverviewProps {
  wallets: WalletRecord[];
  walletsError: string | null;
  aggregate: CustodyWalletAggregate | null;
  aggregateError: string | null;
  transfers: TransferRecord[];
  transfersError: string | null;
}

const REQUIRED_AGGREGATE_BALANCE_ROWS = [
  { token: "SOL", mint: "sol" },
  { token: "USDC", mint: "usdc" },
] as const;
const REQUIRED_ACTION_ASSETS = ["SOL", "USDC"] as const;
const MOONPAY_ONRAMP_MIN_USD = 20;
const PAYMENTS_OVERVIEW_WALLETS_KEY = "payments-overview-wallets";
const PAYMENTS_OVERVIEW_AGGREGATE_KEY = "payments-overview-aggregate";
const PAYMENTS_OVERVIEW_TRANSFERS_KEY = "payments-overview-transfers";
const BVNK_COUNTRY_OPTIONS = [
  { label: "United States", value: "US" },
  { label: "Canada", value: "CA" },
  { label: "United Kingdom", value: "GB" },
] as const;

type QuickActionFlow =
  | "transfer"
  | "moonpay_onramp"
  | "moonpay_offramp"
  | "lightspark_onramp"
  | "lightspark_offramp"
  | "bvnk_onramp"
  | "bvnk_offramp";
type RampDirection = "onramp" | "offramp";
type RampProviderId = "moonpay" | "lightspark" | "bvnk";

interface RampExecution {
  id: string;
  provider: string;
  status: string;
  redirectUrl?: string;
  reference?: string;
}

interface RampExecutionEnvelope {
  data?: {
    ramp?: RampExecution;
  };
  error?: {
    message?: string;
  };
}

function formatDisplayAmount(value?: string, token?: string): string {
  if (!value) {
    return token ? `- ${token}` : "-";
  }

  const numericValue = Number(value);
  const formattedValue = Number.isFinite(numericValue)
    ? new Intl.NumberFormat("en-US", {
        minimumFractionDigits: numericValue >= 100 ? 0 : 2,
        maximumFractionDigits: 6,
      }).format(numericValue)
    : value;

  return token ? `${formattedValue} ${token}` : formattedValue;
}

function formatCurrencyAmount(value: number | string | null): string {
  if (value === null) {
    return "$0.00";
  }

  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return "$0.00";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numericValue);
}

function formatTimestamp(value?: string): string {
  if (!value) {
    return "Pending";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Pending";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatDirection(direction?: string): string {
  if (!direction) {
    return "Unknown";
  }
  return direction[0]?.toUpperCase() + direction.slice(1);
}

function statusClassName(status: string): string {
  switch (status.toLowerCase()) {
    case "confirmed":
    case "finalized":
      return "border-[rgba(17,94,61,0.18)] bg-[rgba(16,185,129,0.1)] text-[#115e3d]";
    case "processing":
    case "pending":
      return "border-[rgba(180,83,9,0.22)] bg-[rgba(245,158,11,0.12)] text-[#8a5a00]";
    case "failed":
      return "border-[rgba(158,43,56,0.2)] bg-[rgba(158,43,56,0.08)] text-[#9e2b38]";
    default:
      return "border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.05)] text-[rgba(28,28,29,0.72)]";
  }
}

function resolveCounterparty(transfer: TransferRecord): string {
  if (transfer.direction === "outbound") {
    return transfer.destination ?? "Unavailable";
  }

  if (transfer.direction === "inbound") {
    return transfer.source ?? "Unavailable";
  }

  return transfer.destination ?? transfer.source ?? "Unavailable";
}

function resolveTotalBalance(balances: CustodyWalletTokenBalance[]): number | null {
  if (balances.length === 0) {
    return null;
  }

  let hasNumericBalance = false;
  const total = balances.reduce((sum, balance) => {
    const numericValue = Number(balance.uiAmount);
    if (!Number.isFinite(numericValue)) {
      return sum;
    }

    hasNumericBalance = true;
    return sum + numericValue;
  }, 0);

  return hasNumericBalance ? total : null;
}

function aggregateBalancesFromWallets(wallets: WalletRecord[]): CustodyWalletTokenBalance[] {
  const aggregate = new Map<
    string,
    { token: string; mint: string; amount: number; decimals: number }
  >();

  for (const wallet of wallets) {
    for (const balance of wallet.balances ?? []) {
      const current = aggregate.get(balance.mint);
      const numericValue = Number(balance.uiAmount);
      if (!Number.isFinite(numericValue)) {
        continue;
      }

      if (!current) {
        aggregate.set(balance.mint, {
          token: balance.token,
          mint: balance.mint,
          amount: numericValue,
          decimals: balance.decimals,
        });
        continue;
      }

      current.amount += numericValue;
    }
  }

  return [...aggregate.values()].map((entry) => ({
    token: entry.token,
    mint: entry.mint,
    amount: "0",
    uiAmount: entry.amount.toString(),
    decimals: entry.decimals,
  }));
}

function normalizeAggregateBalances(
  balances: CustodyWalletTokenBalance[]
): CustodyWalletTokenBalance[] {
  const balancesByToken = new Map(
    balances.map((balance) => [balance.token.toUpperCase(), balance] as const)
  );

  const requiredBalances = REQUIRED_AGGREGATE_BALANCE_ROWS.map(({ token, mint }) => {
    const existingBalance = balancesByToken.get(token);
    if (existingBalance) {
      return existingBalance;
    }

    return {
      token,
      mint,
      amount: "0",
      uiAmount: "0",
      decimals: token === "SOL" ? 9 : 6,
    };
  });

  const remainingBalances = balances.filter(
    (balance) => !REQUIRED_AGGREGATE_BALANCE_ROWS.some(({ token }) => token === balance.token)
  );

  return [...requiredBalances, ...remainingBalances];
}

function resolvePrimaryWalletBalance(
  wallet: WalletRecord | null
): CustodyWalletTokenBalance | null {
  if (!wallet?.balances || wallet.balances.length === 0) {
    return null;
  }

  return (
    wallet.balances.find((balance) => {
      const numericValue = Number(balance.uiAmount);
      return Number.isFinite(numericValue) && numericValue > 0;
    }) ??
    wallet.balances[0] ??
    null
  );
}

function getWalletActionLabel(wallet: WalletRecord): string {
  const balance = resolvePrimaryWalletBalance(wallet);
  if (!balance) {
    return wallet.label ?? wallet.walletId;
  }

  return `${wallet.label ?? wallet.walletId} · ${formatCurrencyAmount(balance.uiAmount)}`;
}

function resolveWalletActionAssets(wallet: WalletRecord | null): string[] {
  const assetSet = new Set<string>(REQUIRED_ACTION_ASSETS);

  for (const balance of wallet?.balances ?? []) {
    const token = balance.token.trim().toUpperCase();
    if (token) {
      assetSet.add(token);
    }
  }

  return [...assetSet];
}

function getQuickActionFlowOptions(
  mode: "send" | "receive"
): Array<{ label: string; value: QuickActionFlow }> {
  return mode === "send"
    ? [
        { label: "Wallet transfer", value: "transfer" },
        { label: "MoonPay off-ramp", value: "moonpay_offramp" },
        { label: "Lightspark off-ramp", value: "lightspark_offramp" },
        { label: "BVNK off-ramp", value: "bvnk_offramp" },
      ]
    : [
        { label: "Wallet transfer", value: "transfer" },
        { label: "MoonPay on-ramp", value: "moonpay_onramp" },
        { label: "Lightspark on-ramp", value: "lightspark_onramp" },
        { label: "BVNK on-ramp", value: "bvnk_onramp" },
      ];
}

function getQuickActionDirection(flow: QuickActionFlow): RampDirection | null {
  if (flow === "transfer") {
    return null;
  }

  return flow.endsWith("_onramp") ? "onramp" : "offramp";
}

function getQuickActionProvider(flow: QuickActionFlow): RampProviderId | null {
  if (flow === "transfer") {
    return null;
  }

  if (flow.startsWith("moonpay_")) {
    return "moonpay";
  }

  if (flow.startsWith("lightspark_")) {
    return "lightspark";
  }

  return "bvnk";
}

function getQuickActionProviderLabel(flow: QuickActionFlow): string | null {
  const provider = getQuickActionProvider(flow);
  if (provider === "moonpay") {
    return "MoonPay";
  }
  if (provider === "lightspark") {
    return "Lightspark";
  }
  if (provider === "bvnk") {
    return "BVNK";
  }
  return null;
}

function getQuickActionDescription(mode: "send" | "receive", flow: QuickActionFlow): string {
  if (flow === "moonpay_onramp") {
    return "Generate the hosted MoonPay on-ramp URL.";
  }

  if (flow === "moonpay_offramp") {
    return "Generate the hosted MoonPay off-ramp URL.";
  }

  if (flow === "lightspark_onramp") {
    return "Create a Lightspark quote using the selected wallet as the crypto destination.";
  }

  if (flow === "lightspark_offramp") {
    return "Create and execute a Lightspark off-ramp quote with Lightspark account IDs.";
  }

  if (flow === "bvnk_onramp") {
    return "Create a BVNK on-ramp checkout session for the selected wallet.";
  }

  if (flow === "bvnk_offramp") {
    return "Create a BVNK off-ramp estimate and acceptance flow with beneficiary details.";
  }

  return mode === "send"
    ? "Draft a wallet transfer using the same field styling as the API playground."
    : "Choose a wallet and asset for the incoming wallet transfer flow.";
}

function getQuickActionSubmitLabel(mode: "send" | "receive", flow: QuickActionFlow): string {
  if (flow !== "transfer") {
    return "Generate URL";
  }

  return mode === "send" ? "Prepare send" : "Prepare receive";
}

function getApiErrorMessage(
  body: {
    error?: {
      message?: string;
    };
  },
  fallback: string
): string {
  return typeof body.error?.message === "string" && body.error.message
    ? body.error.message
    : fallback;
}

async function executeRampFlow(
  direction: RampDirection,
  payload: Record<string, unknown>
): Promise<RampExecution> {
  const response = await fetch(`/api/dashboard/payments/ramps/${direction}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => ({}))) as RampExecutionEnvelope;

  if (!response.ok) {
    throw new Error(getApiErrorMessage(body, `Ramp request failed (${response.status}).`));
  }

  if (!body.data?.ramp) {
    throw new Error("Ramp response is missing execution details.");
  }

  return body.data.ramp;
}

function parseOptionalNumber(value: string): number | null {
  const numericValue = Number.parseFloat(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function resolveRequestError(error: unknown, fallback: string | null): string | null {
  if (error instanceof Error) {
    return error.message;
  }

  if (error) {
    return "Request failed.";
  }

  return fallback;
}

interface QuickActionModalProps {
  open: boolean;
  mode: "send" | "receive";
  wallets: WalletRecord[];
  initialWalletId: string;
  onWalletChange: (walletId: string) => void;
  onClose: () => void;
}

interface QuickActionRequestFieldsProps {
  mode: "send" | "receive";
  wallets: WalletRecord[];
  selectedWalletId: string;
  onWalletChange: (walletId: string) => void;
  flowOptions: Array<{ label: string; value: QuickActionFlow }>;
  selectedFlow: QuickActionFlow;
  onFlowChange: (flow: QuickActionFlow) => void;
  assetOptions: string[];
  selectedAsset: string;
  onAssetChange: (asset: string) => void;
  amount: string;
  onAmountChange: (value: string) => void;
  destination: string;
  onDestinationChange: (value: string) => void;
  memo: string;
  onMemoChange: (value: string) => void;
  reference: string;
  onReferenceChange: (value: string) => void;
  customerId: string;
  onCustomerIdChange: (value: string) => void;
  lightsparkSourceAccountId: string;
  onLightsparkSourceAccountIdChange: (value: string) => void;
  lightsparkDestinationAccountId: string;
  onLightsparkDestinationAccountIdChange: (value: string) => void;
  bvnkFirstName: string;
  onBvnkFirstNameChange: (value: string) => void;
  bvnkLastName: string;
  onBvnkLastNameChange: (value: string) => void;
  bvnkDateOfBirth: string;
  onBvnkDateOfBirthChange: (value: string) => void;
  bvnkCountryCode: string;
  onBvnkCountryCodeChange: (value: string) => void;
  selectedWallet: WalletRecord | null;
  transferCompliance: ComplianceSnapshot | null;
  transferComplianceLoading: boolean;
  transferComplianceDismissed: boolean;
  onCheckTransferCompliance: () => void;
  onDismissTransferCompliance: () => void;
}

function FormValueBridge({
  label,
  name,
  required = false,
  value,
}: {
  label: string;
  name: string;
  required?: boolean;
  value: string;
}) {
  return (
    <input
      aria-label={label}
      name={name}
      required={required}
      value={value}
      onChange={() => {}}
      tabIndex={-1}
      className="pointer-events-none absolute h-px w-px opacity-0"
    />
  );
}

function WalletAddressQrCode({ address }: { address: string }) {
  const [qrCodeUrl, setQrCodeUrl] = useState("");

  useEffect(() => {
    let cancelled = false;

    if (!address) {
      setQrCodeUrl("");
      return;
    }

    void QRCode.toDataURL(address, {
      margin: 1,
      width: 240,
      color: {
        dark: "#1c1c1d",
        light: "#ffffff",
      },
    })
      .then((url) => {
        if (!cancelled) {
          setQrCodeUrl(url);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setQrCodeUrl("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [address]);

  if (!address) {
    return null;
  }

  return (
    <section className="rounded-2xl border border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.03)] p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[rgba(28,28,29,0.52)]">
        Wallet QR
      </p>
      <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row sm:items-start">
        <div className="flex size-[140px] items-center justify-center rounded-[20px] bg-white p-3 shadow-[inset_0_0_0_1px_rgba(28,28,29,0.08)]">
          {qrCodeUrl ? (
            <img src={qrCodeUrl} alt="Wallet address QR code" className="size-full" />
          ) : (
            <div className="size-full animate-pulse rounded-[14px] bg-[rgba(28,28,29,0.08)]" />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm text-[rgba(28,28,29,0.62)]">Scan to send to this wallet.</p>
          <p className="break-all font-mono text-xs text-[rgba(28,28,29,0.78)]">{address}</p>
        </div>
      </div>
    </section>
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Provider-specific demo variants are kept explicit in one renderer.
function QuickActionRequestFields({
  mode,
  wallets,
  selectedWalletId,
  onWalletChange,
  flowOptions,
  selectedFlow,
  onFlowChange,
  assetOptions,
  selectedAsset,
  onAssetChange,
  amount,
  onAmountChange,
  destination,
  onDestinationChange,
  memo,
  onMemoChange,
  reference,
  onReferenceChange,
  customerId,
  onCustomerIdChange,
  lightsparkSourceAccountId,
  onLightsparkSourceAccountIdChange,
  lightsparkDestinationAccountId,
  onLightsparkDestinationAccountIdChange,
  bvnkFirstName,
  onBvnkFirstNameChange,
  bvnkLastName,
  onBvnkLastNameChange,
  bvnkDateOfBirth,
  onBvnkDateOfBirthChange,
  bvnkCountryCode,
  onBvnkCountryCodeChange,
  selectedWallet,
  transferCompliance,
  transferComplianceLoading,
  transferComplianceDismissed,
  onCheckTransferCompliance,
  onDismissTransferCompliance,
}: QuickActionRequestFieldsProps) {
  const isSendModal = mode === "send";
  const isTransferFlow = selectedFlow === "transfer";
  const rampDirection = getQuickActionDirection(selectedFlow);
  const provider = getQuickActionProvider(selectedFlow);
  const providerLabel = getQuickActionProviderLabel(selectedFlow);
  const isOnrampFlow = rampDirection === "onramp";
  const isMoonPayFlow = provider === "moonpay";
  const isLightsparkFlow = provider === "lightspark";
  const isLightsparkOfframpFlow = selectedFlow === "lightspark_offramp";
  const isBvnkFlow = provider === "bvnk";
  const isBvnkOfframpFlow = selectedFlow === "bvnk_offramp";
  const numericAmount = parseOptionalNumber(amount);
  const isBelowMoonPayOnrampMinimum =
    selectedFlow === "moonpay_onramp" &&
    amount.trim().length > 0 &&
    (numericAmount === null || numericAmount < MOONPAY_ONRAMP_MIN_USD);
  const destinationTrimmed = destination.trim();

  return (
    <section className="space-y-3">
      <h2 className="text-[18px] leading-6 font-medium text-[#1c1c1d]">Request body</h2>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`${mode}-wallet`}>Wallet</Label>
            <div className="relative">
              <FormValueBridge
                label="Selected wallet"
                name={`${mode}Wallet`}
                required
                value={selectedWalletId}
              />
              <Select
                value={selectedWalletId}
                onValueChange={onWalletChange}
                disabled={wallets.length === 0}
              >
                <SelectTrigger
                  id={`${mode}-wallet`}
                  className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-white px-4 shadow-none"
                >
                  <SelectValue placeholder="Select wallet" />
                </SelectTrigger>
                <SelectContent
                  position="popper"
                  className="rounded-2xl border-[rgba(28,28,29,0.12)] bg-white"
                >
                  {wallets.map((wallet) => (
                    <SelectItem key={wallet.walletId} value={wallet.walletId}>
                      {getWalletActionLabel(wallet)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor={`${mode}-flow`}>Flow</Label>
            <div className="relative">
              <Select
                value={selectedFlow}
                onValueChange={(value) => onFlowChange(value as QuickActionFlow)}
              >
                <SelectTrigger
                  id={`${mode}-flow`}
                  className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-white px-4 shadow-none"
                >
                  <SelectValue placeholder="Select flow" />
                </SelectTrigger>
                <SelectContent
                  position="popper"
                  className="rounded-2xl border-[rgba(28,28,29,0.12)] bg-white"
                >
                  {flowOptions.map((flow) => (
                    <SelectItem key={flow.value} value={flow.value}>
                      {flow.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {isTransferFlow ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor={`${mode}-asset`}>Asset</Label>
                <div className="relative">
                  <FormValueBridge
                    label="Selected asset"
                    name={`${mode}Asset`}
                    required
                    value={selectedAsset}
                  />
                  <Select
                    value={selectedAsset}
                    onValueChange={onAssetChange}
                    disabled={assetOptions.length === 0}
                  >
                    <SelectTrigger
                      id={`${mode}-asset`}
                      className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-white px-4 shadow-none"
                    >
                      <SelectValue placeholder="Select asset" />
                    </SelectTrigger>
                    <SelectContent
                      position="popper"
                      className="rounded-2xl border-[rgba(28,28,29,0.12)] bg-white"
                    >
                      {assetOptions.map((asset) => (
                        <SelectItem key={asset} value={asset}>
                          {asset}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {isSendModal ? (
                <div className="space-y-2">
                  <Label htmlFor={`${mode}-amount`}>Amount</Label>
                  <Input
                    id={`${mode}-amount`}
                    type="number"
                    inputMode="decimal"
                    min="0.000001"
                    step="any"
                    required
                    value={amount}
                    onChange={(event) => onAmountChange(event.currentTarget.value)}
                    placeholder="1.00"
                    className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-white px-4 shadow-none"
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor={`${mode}-reference`}>Reference label</Label>
                  <Input
                    id={`${mode}-reference`}
                    value={reference}
                    onChange={(event) => onReferenceChange(event.currentTarget.value)}
                    placeholder="Customer top-up"
                    className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-white px-4 shadow-none"
                  />
                </div>
              )}
            </div>

            {isSendModal ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor={`${mode}-destination`}>Destination address</Label>
                  <Input
                    id={`${mode}-destination`}
                    required
                    minLength={32}
                    maxLength={44}
                    value={destination}
                    onChange={(event) => onDestinationChange(event.currentTarget.value)}
                    placeholder="Destination Solana address"
                    className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-white px-4 shadow-none"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={onCheckTransferCompliance}
                    disabled={transferComplianceLoading || !selectedWalletId || !destinationTrimmed}
                  >
                    {transferComplianceLoading ? "Checking..." : "Check risk score"}
                  </Button>
                </div>
                {transferCompliance && !transferComplianceDismissed ? (
                  <ProviderRiskTable
                    title="Risk score results"
                    snapshot={transferCompliance}
                    onClose={onDismissTransferCompliance}
                  />
                ) : null}
                <div className="space-y-2">
                  <Label htmlFor={`${mode}-memo`}>Memo</Label>
                  <Input
                    id={`${mode}-memo`}
                    value={memo}
                    onChange={(event) => onMemoChange(event.currentTarget.value)}
                    placeholder="Invoice #1234"
                    className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-white px-4 shadow-none"
                  />
                </div>
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor={`${mode}-address`}>Receiving address</Label>
                  <Input
                    id={`${mode}-address`}
                    value={selectedWallet?.publicKey ?? ""}
                    readOnly
                    className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] px-4 font-mono text-sm shadow-none"
                  />
                </div>
                <WalletAddressQrCode address={selectedWallet?.publicKey ?? ""} />
              </>
            )}
          </>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor={`${mode}-provider`}>Provider</Label>
                <Input
                  id={`${mode}-provider`}
                  value={providerLabel ?? ""}
                  readOnly
                  className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] px-4 shadow-none"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor={`${mode}-asset`}>Asset</Label>
                <div className="relative">
                  <FormValueBridge
                    label="Selected asset"
                    name={`${mode}Asset`}
                    required
                    value={selectedAsset}
                  />
                  <Select
                    value={selectedAsset}
                    onValueChange={onAssetChange}
                    disabled={assetOptions.length === 0}
                  >
                    <SelectTrigger
                      id={`${mode}-asset`}
                      className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-white px-4 shadow-none"
                    >
                      <SelectValue placeholder="Select asset" />
                    </SelectTrigger>
                    <SelectContent
                      position="popper"
                      className="rounded-2xl border-[rgba(28,28,29,0.12)] bg-white"
                    >
                      {assetOptions.map((asset) => (
                        <SelectItem key={asset} value={asset}>
                          {asset}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor={`${mode}-amount`}>
                {isOnrampFlow ? "Fiat amount (USD)" : "Crypto amount"}
              </Label>
              <Input
                id={`${mode}-amount`}
                type="number"
                inputMode="decimal"
                min={
                  selectedFlow === "moonpay_onramp" ? String(MOONPAY_ONRAMP_MIN_USD) : "0.000001"
                }
                step="any"
                required
                value={amount}
                onChange={(event) => onAmountChange(event.currentTarget.value)}
                placeholder="250.00"
                className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-white px-4 shadow-none"
              />
              {selectedFlow === "moonpay_onramp" ? (
                <p
                  className={
                    isBelowMoonPayOnrampMinimum
                      ? "text-xs text-[#9e2b38]"
                      : "text-xs text-[rgba(28,28,29,0.56)]"
                  }
                >
                  Minimum $20 USD.
                </p>
              ) : null}
            </div>

            {isLightsparkFlow ? (
              isLightsparkOfframpFlow ? (
                <>
                  <p className="text-xs text-[rgba(28,28,29,0.56)]">
                    Lightspark off-ramp uses Lightspark account IDs instead of an SDP custody
                    wallet.
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor={`${mode}-lightspark-source`}>Source account ID</Label>
                      <Input
                        id={`${mode}-lightspark-source`}
                        required
                        value={lightsparkSourceAccountId}
                        onChange={(event) =>
                          onLightsparkSourceAccountIdChange(event.currentTarget.value)
                        }
                        placeholder="InternalAccount:acc_source_123"
                        className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-white px-4 shadow-none"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`${mode}-lightspark-destination`}>
                        Destination account ID
                      </Label>
                      <Input
                        id={`${mode}-lightspark-destination`}
                        required
                        value={lightsparkDestinationAccountId}
                        onChange={(event) =>
                          onLightsparkDestinationAccountIdChange(event.currentTarget.value)
                        }
                        placeholder="ExternalAccount:acc_destination_123"
                        className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-white px-4 shadow-none"
                      />
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label htmlFor={`${mode}-customer-id`}>Customer ID</Label>
                    <Input
                      id={`${mode}-customer-id`}
                      required
                      value={customerId}
                      onChange={(event) => onCustomerIdChange(event.currentTarget.value)}
                      placeholder="Customer:cus_123"
                      className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-white px-4 shadow-none"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`${mode}-address`}>Destination address</Label>
                    <Input
                      id={`${mode}-address`}
                      value={selectedWallet?.publicKey ?? ""}
                      readOnly
                      className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] px-4 font-mono text-sm shadow-none"
                    />
                  </div>
                </>
              )
            ) : null}

            {isBvnkFlow ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor={`${mode}-customer-id`}>Customer ID</Label>
                  <Input
                    id={`${mode}-customer-id`}
                    required
                    value={customerId}
                    onChange={(event) => onCustomerIdChange(event.currentTarget.value)}
                    placeholder="customer_123"
                    className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-white px-4 shadow-none"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`${mode}-address`}>
                    {isOnrampFlow ? "Destination address" : "Source address"}
                  </Label>
                  <Input
                    id={`${mode}-address`}
                    value={selectedWallet?.publicKey ?? ""}
                    readOnly
                    className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] px-4 font-mono text-sm shadow-none"
                  />
                </div>
                {isBvnkOfframpFlow ? (
                  <>
                    <p className="text-xs text-[rgba(28,28,29,0.56)]">
                      BVNK off-ramp also needs a lightweight beneficiary profile for compliance.
                    </p>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor={`${mode}-bvnk-first-name`}>First name</Label>
                        <Input
                          id={`${mode}-bvnk-first-name`}
                          required
                          value={bvnkFirstName}
                          onChange={(event) => onBvnkFirstNameChange(event.currentTarget.value)}
                          placeholder="Jane"
                          className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-white px-4 shadow-none"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`${mode}-bvnk-last-name`}>Last name</Label>
                        <Input
                          id={`${mode}-bvnk-last-name`}
                          required
                          value={bvnkLastName}
                          onChange={(event) => onBvnkLastNameChange(event.currentTarget.value)}
                          placeholder="Doe"
                          className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-white px-4 shadow-none"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`${mode}-bvnk-dob`}>Date of birth</Label>
                        <Input
                          id={`${mode}-bvnk-dob`}
                          type="date"
                          required
                          value={bvnkDateOfBirth}
                          onChange={(event) => onBvnkDateOfBirthChange(event.currentTarget.value)}
                          className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-white px-4 shadow-none"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`${mode}-bvnk-country`}>Country</Label>
                        <select
                          id={`${mode}-bvnk-country`}
                          required
                          value={bvnkCountryCode}
                          onChange={(event) => onBvnkCountryCodeChange(event.currentTarget.value)}
                          className="h-11 w-full rounded-[12px] border border-[rgba(28,28,29,0.12)] bg-white px-4 text-sm text-[#1c1c1d]"
                        >
                          <option value="">Select country</option>
                          {BVNK_COUNTRY_OPTIONS.map((country) => (
                            <option key={country.value} value={country.value}>
                              {country.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </>
                ) : null}
              </>
            ) : null}

            {isMoonPayFlow ? (
              <div className="space-y-2">
                <Label htmlFor={`${mode}-address`}>
                  {isOnrampFlow ? "Destination address" : "Source address"}
                </Label>
                <Input
                  id={`${mode}-address`}
                  value={selectedWallet?.publicKey ?? ""}
                  readOnly
                  className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] px-4 font-mono text-sm shadow-none"
                />
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function QuickActionModal({
  open,
  mode,
  wallets,
  initialWalletId,
  onWalletChange,
  onClose,
}: QuickActionModalProps) {
  const [selectedWalletId, setSelectedWalletId] = useState(initialWalletId);
  const [selectedFlow, setSelectedFlow] = useState<QuickActionFlow>("transfer");
  const [selectedAsset, setSelectedAsset] = useState<string>("USDC");
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [reference, setReference] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [lightsparkSourceAccountId, setLightsparkSourceAccountId] = useState("");
  const [lightsparkDestinationAccountId, setLightsparkDestinationAccountId] = useState("");
  const [bvnkFirstName, setBvnkFirstName] = useState("");
  const [bvnkLastName, setBvnkLastName] = useState("");
  const [bvnkDateOfBirth, setBvnkDateOfBirth] = useState("");
  const [bvnkCountryCode, setBvnkCountryCode] = useState("");
  const [rampExecution, setRampExecution] = useState<RampExecution | null>(null);
  const [transferCompliance, setTransferCompliance] = useState<ComplianceSnapshot | null>(null);
  const [transferComplianceLoading, setTransferComplianceLoading] = useState(false);
  const [transferComplianceDismissed, setTransferComplianceDismissed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }

    const nextWalletId = wallets.some((wallet) => wallet.walletId === initialWalletId)
      ? initialWalletId
      : (wallets[0]?.walletId ?? "");
    setSelectedWalletId(nextWalletId);
    setRampExecution(null);
    setCustomerId("");
    setLightsparkSourceAccountId("");
    setLightsparkDestinationAccountId("");
    setBvnkFirstName("");
    setBvnkLastName("");
    setBvnkDateOfBirth("");
    setBvnkCountryCode("");
    setTransferCompliance(null);
    setTransferComplianceDismissed(false);
    if (nextWalletId) {
      onWalletChange(nextWalletId);
    }
  }, [initialWalletId, onWalletChange, open, wallets]);

  const selectedWallet = useMemo(
    () => wallets.find((wallet) => wallet.walletId === selectedWalletId) ?? null,
    [selectedWalletId, wallets]
  );
  const flowOptions = useMemo(() => getQuickActionFlowOptions(mode), [mode]);
  const assetOptions = useMemo(() => resolveWalletActionAssets(selectedWallet), [selectedWallet]);

  useEffect(() => {
    if (!flowOptions.some((option) => option.value === selectedFlow)) {
      setSelectedFlow(flowOptions[0]?.value ?? "transfer");
    }
  }, [flowOptions, selectedFlow]);

  useEffect(() => {
    if (assetOptions.length === 0) {
      setSelectedAsset("");
      return;
    }

    if (!assetOptions.includes(selectedAsset)) {
      setSelectedAsset(assetOptions.includes("USDC") ? "USDC" : (assetOptions[0] ?? ""));
    }
  }, [assetOptions, selectedAsset]);

  const isSendModal = mode === "send";
  const isTransferFlow = selectedFlow === "transfer";
  const rampDirection = getQuickActionDirection(selectedFlow);
  const providerLabel = getQuickActionProviderLabel(selectedFlow);
  const isOnrampFlow = rampDirection === "onramp";
  const transferDestinationTrimmed = destination.trim();
  const hasTransferComplianceForDestination =
    !!transferCompliance &&
    transferCompliance.address === transferDestinationTrimmed &&
    transferCompliance.providers.length > 0;
  const title = isSendModal ? "Send" : "Receive";
  const description = getQuickActionDescription(mode, selectedFlow);
  const submitLabel = getQuickActionSubmitLabel(mode, selectedFlow);

  const getWalletSelectionDescription = (wallet: WalletRecord) =>
    `${wallet.label ?? wallet.walletId} · ${selectedAsset}`;

  const submitTransferFlow = async (wallet: WalletRecord) => {
    const loadingToastId = toast.loading(
      isSendModal ? "Preparing send transfer..." : "Preparing receive transfer...",
      {
        description: getWalletSelectionDescription(wallet),
        position: "bottom-right",
      }
    );

    await new Promise((resolve) => window.setTimeout(resolve, 900));

    toast.success(`${title} transfer flow ready.`, {
      id: loadingToastId,
      description: "Transfer submission is still using placeholder wiring for now.",
      position: "bottom-right",
    });
  };

  const checkTransferCompliance = async () => {
    if (!transferDestinationTrimmed) {
      return;
    }

    setTransferComplianceLoading(true);
    setTransferComplianceDismissed(false);
    try {
      setTransferCompliance(
        await runComplianceCheck(transferDestinationTrimmed, "transfer_destination")
      );
    } catch (error) {
      setTransferCompliance(null);
      toast.error("Compliance check failed.", {
        description: error instanceof Error ? error.message : "Compliance check failed.",
        position: "bottom-right",
      });
    } finally {
      setTransferComplianceLoading(false);
    }
  };

  const buildRampPayload = (wallet: WalletRecord): Record<string, unknown> => {
    if (selectedFlow === "moonpay_onramp") {
      return {
        provider: "moonpay",
        destinationWallet: wallet.walletId,
        cryptoToken: selectedAsset,
        fiatAmount: amount.trim(),
      };
    }

    if (selectedFlow === "moonpay_offramp") {
      return {
        provider: "moonpay",
        sourceWallet: wallet.walletId,
        cryptoToken: selectedAsset,
        cryptoAmount: amount.trim(),
      };
    }

    if (selectedFlow === "lightspark_onramp") {
      return {
        provider: "lightspark",
        destinationWallet: wallet.walletId,
        cryptoToken: selectedAsset,
        fiatAmount: amount.trim(),
        kycReference: customerId.trim(),
      };
    }

    if (selectedFlow === "lightspark_offramp") {
      return {
        provider: "lightspark",
        sourceWallet: lightsparkSourceAccountId.trim(),
        cryptoToken: selectedAsset,
        cryptoAmount: amount.trim(),
        kycReference: lightsparkDestinationAccountId.trim(),
      };
    }

    if (selectedFlow === "bvnk_onramp") {
      return {
        provider: "bvnk",
        destinationWallet: wallet.walletId,
        cryptoToken: selectedAsset,
        fiatAmount: amount.trim(),
        kycReference: customerId.trim(),
      };
    }

    return {
      provider: "bvnk",
      sourceWallet: wallet.walletId,
      cryptoToken: selectedAsset,
      cryptoAmount: amount.trim(),
      kycReference: customerId.trim(),
      bvnkCompliance: {
        partyDetails: [
          {
            type: "BENEFICIARY",
            entityType: "INDIVIDUAL",
            relationshipType: "THIRD_PARTY",
            firstName: bvnkFirstName.trim(),
            lastName: bvnkLastName.trim(),
            dateOfBirth: bvnkDateOfBirth,
            countryCode: bvnkCountryCode,
          },
        ],
      },
    };
  };

  const submitRampFlow = async (wallet: WalletRecord) => {
    const direction = rampDirection;
    if (!direction) {
      return;
    }
    const loadingToastId = toast.loading(
      isOnrampFlow
        ? `Starting ${providerLabel} on-ramp...`
        : `Starting ${providerLabel} off-ramp...`,
      {
        description: getWalletSelectionDescription(wallet),
        position: "bottom-right",
      }
    );

    try {
      const ramp = await executeRampFlow(direction, buildRampPayload(wallet));
      setRampExecution(ramp);

      toast.success(`${providerLabel} flow ready.`, {
        id: loadingToastId,
        position: "bottom-right",
      });
    } catch (error) {
      toast.error(`${title} flow failed to initialize.`, {
        id: loadingToastId,
        description:
          error instanceof Error ? error.message : "Try again. No request was submitted.",
        position: "bottom-right",
      });
      throw error;
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!selectedWallet) {
      return;
    }

    if (isTransferFlow && isSendModal && !hasTransferComplianceForDestination) {
      toast.error("Transfer blocked.", {
        description: "Run risk check before preparing the transfer.",
        position: "bottom-right",
      });
      return;
    }

    setIsSubmitting(true);

    try {
      if (isTransferFlow) {
        await submitTransferFlow(selectedWallet);
        onClose();
      } else {
        await submitRampFlow(selectedWallet);
      }
    } catch (error) {
      if (isTransferFlow) {
        toast.error(`${title} flow failed to initialize.`, {
          description:
            error instanceof Error ? error.message : "Try again. No request was submitted.",
          position: "bottom-right",
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  useEscapeKey(open, onClose);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8">
      <button
        type="button"
        aria-label={`Close ${title.toLowerCase()} modal`}
        className="absolute inset-0 bg-black/35"
        onClick={onClose}
      />

      <div className="relative z-10 w-full max-w-2xl overflow-hidden rounded-3xl border border-[rgba(28,28,29,0.16)] bg-white text-[#1c1c1d] shadow-[0_24px_64px_rgba(28,28,29,0.28)]">
        <div className="border-b border-[rgba(28,28,29,0.1)] bg-[rgba(28,28,29,0.02)] px-8 py-7">
          <p className="text-3xl leading-none font-semibold">{title}</p>
          <p className="mt-2 text-base text-[rgba(28,28,29,0.62)]">{description}</p>
        </div>

        <form onSubmit={handleSubmit} className="grid gap-6 px-8 py-7">
          <QuickActionRequestFields
            mode={mode}
            wallets={wallets}
            selectedWalletId={selectedWalletId}
            onWalletChange={(value) => {
              setSelectedWalletId(value);
              setRampExecution(null);
              setTransferCompliance(null);
              setTransferComplianceDismissed(false);
              onWalletChange(value);
            }}
            flowOptions={flowOptions}
            selectedFlow={selectedFlow}
            onFlowChange={(value) => {
              setSelectedFlow(value);
              setRampExecution(null);
              setCustomerId("");
              setLightsparkSourceAccountId("");
              setLightsparkDestinationAccountId("");
              setBvnkFirstName("");
              setBvnkLastName("");
              setBvnkDateOfBirth("");
              setBvnkCountryCode("");
              setTransferCompliance(null);
              setTransferComplianceDismissed(false);
            }}
            assetOptions={assetOptions}
            selectedAsset={selectedAsset}
            onAssetChange={(value) => {
              setSelectedAsset(value);
              setRampExecution(null);
            }}
            amount={amount}
            onAmountChange={(value) => {
              setAmount(value);
              setRampExecution(null);
            }}
            destination={destination}
            onDestinationChange={(value) => {
              setDestination(value);
              setTransferCompliance(null);
              setTransferComplianceDismissed(false);
            }}
            memo={memo}
            onMemoChange={setMemo}
            reference={reference}
            onReferenceChange={setReference}
            customerId={customerId}
            onCustomerIdChange={setCustomerId}
            lightsparkSourceAccountId={lightsparkSourceAccountId}
            onLightsparkSourceAccountIdChange={setLightsparkSourceAccountId}
            lightsparkDestinationAccountId={lightsparkDestinationAccountId}
            onLightsparkDestinationAccountIdChange={setLightsparkDestinationAccountId}
            bvnkFirstName={bvnkFirstName}
            onBvnkFirstNameChange={setBvnkFirstName}
            bvnkLastName={bvnkLastName}
            onBvnkLastNameChange={setBvnkLastName}
            bvnkDateOfBirth={bvnkDateOfBirth}
            onBvnkDateOfBirthChange={setBvnkDateOfBirth}
            bvnkCountryCode={bvnkCountryCode}
            onBvnkCountryCodeChange={setBvnkCountryCode}
            selectedWallet={selectedWallet}
            transferCompliance={transferCompliance}
            transferComplianceLoading={transferComplianceLoading}
            transferComplianceDismissed={transferComplianceDismissed}
            onCheckTransferCompliance={() => {
              void checkTransferCompliance();
            }}
            onDismissTransferCompliance={() => setTransferComplianceDismissed(true)}
          />

          {!isTransferFlow && rampExecution ? (
            <section className="rounded-2xl border border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.03)] p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[rgba(28,28,29,0.52)]">
                Demo result
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <p className="text-xs text-[rgba(28,28,29,0.56)]">Status</p>
                  <p className="text-sm font-medium text-[#1c1c1d]">{rampExecution.status}</p>
                </div>
                {rampExecution.reference ? (
                  <div className="space-y-1">
                    <p className="text-xs text-[rgba(28,28,29,0.56)]">Reference</p>
                    <p className="font-mono text-xs text-[rgba(28,28,29,0.78)]">
                      {rampExecution.reference}
                    </p>
                  </div>
                ) : null}
              </div>
              {rampExecution.redirectUrl ? (
                <>
                  <p className="mt-4 text-xs font-semibold uppercase tracking-[0.16em] text-[rgba(28,28,29,0.52)]">
                    Redirect URL
                  </p>
                  <Input
                    readOnly
                    value={rampExecution.redirectUrl}
                    className="mt-3 h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-white px-4 font-mono text-sm shadow-none"
                  />
                  <div className="mt-3 flex items-center justify-end gap-3">
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        window.open(rampExecution.redirectUrl, "_blank", "noopener,noreferrer")
                      }
                    >
                      {providerLabel ? `Open ${providerLabel}` : "Open provider"}
                    </Button>
                  </div>
                </>
              ) : null}
            </section>
          ) : null}

          <div className="flex items-center justify-end gap-3">
            <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting || wallets.length === 0}
              aria-busy={isSubmitting}
            >
              {isSubmitting ? `${submitLabel}...` : submitLabel}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function PaymentsOverview({
  wallets,
  walletsError,
  aggregate,
  aggregateError,
  transfers,
  transfersError,
}: PaymentsOverviewProps) {
  const {
    data: swrWallets,
    error: walletsFetchError,
    isValidating: walletsRefreshing,
    mutate: mutateWallets,
  } = useSWR<WalletRecord[]>(PAYMENTS_OVERVIEW_WALLETS_KEY, () => fetchWallets(), {
    fallbackData: walletsError ? undefined : wallets,
    revalidateOnFocus: true,
    refreshInterval: 30_000,
  });
  const {
    data: swrAggregate,
    error: aggregateFetchError,
    isValidating: aggregateRefreshing,
    mutate: mutateAggregate,
  } = useSWR<CustodyWalletAggregate>(
    PAYMENTS_OVERVIEW_AGGREGATE_KEY,
    () => fetchWalletAggregate(),
    {
      fallbackData: aggregateError || !aggregate ? undefined : aggregate,
      revalidateOnFocus: true,
      refreshInterval: 30_000,
    }
  );
  const {
    data: swrTransfers,
    error: transfersFetchError,
    isValidating: transfersRefreshing,
    mutate: mutateTransfers,
  } = useSWR<TransferRecord[]>(PAYMENTS_OVERVIEW_TRANSFERS_KEY, () => fetchTransfers(), {
    fallbackData: transfersError ? undefined : transfers,
    revalidateOnFocus: true,
    refreshInterval: 10_000,
  });

  const liveWallets = swrWallets ?? wallets;
  const liveAggregate = swrAggregate ?? aggregate;
  const liveTransfers = swrTransfers ?? transfers;
  const liveWalletsError = walletsFetchError
    ? resolveRequestError(walletsFetchError, walletsError)
    : swrWallets === undefined
      ? walletsError
      : null;
  const liveAggregateError = aggregateFetchError
    ? resolveRequestError(aggregateFetchError, aggregateError)
    : swrAggregate === undefined
      ? aggregateError
      : null;
  const liveTransfersError = transfersFetchError
    ? resolveRequestError(transfersFetchError, transfersError)
    : swrTransfers === undefined
      ? transfersError
      : null;
  const isRefreshing = walletsRefreshing || aggregateRefreshing || transfersRefreshing;
  const [selectedWalletId, setSelectedWalletId] = useState("");
  const [sendModalOpen, setSendModalOpen] = useState(false);
  const [receiveModalOpen, setReceiveModalOpen] = useState(false);

  useEffect(() => {
    if (liveWallets.length === 0) {
      setSelectedWalletId("");
      return;
    }

    if (!liveWallets.some((wallet) => wallet.walletId === selectedWalletId)) {
      setSelectedWalletId(liveWallets[0]?.walletId ?? "");
    }
  }, [liveWallets, selectedWalletId]);

  const aggregateBalances = useMemo(() => {
    if (liveAggregate?.balances) {
      return normalizeAggregateBalances(liveAggregate.balances);
    }

    return normalizeAggregateBalances(aggregateBalancesFromWallets(liveWallets));
  }, [liveAggregate, liveWallets]);
  const totalBalance = resolveTotalBalance(aggregateBalances);
  const hasWallets = liveWallets.length > 0;
  const walletCount = liveAggregate?.walletCount ?? liveWallets.length;

  const handleRefresh = () => {
    void Promise.all([mutateWallets(), mutateAggregate(), mutateTransfers()]);
  };

  return (
    <>
      <div className="grid gap-6">
        <SectionEntry>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              className="rounded-full px-5"
              onClick={() => setSendModalOpen(true)}
              disabled={!hasWallets}
            >
              <ArrowUpRight className="size-4" />
              Send
            </Button>
            <Button
              type="button"
              className="rounded-full px-5"
              onClick={() => setReceiveModalOpen(true)}
              disabled={!hasWallets}
            >
              <ArrowDownLeft className="size-4" />
              Receive
            </Button>
          </div>
        </SectionEntry>

        <SectionEntry delay={0.04}>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,1fr)]">
            <div className="flex min-h-[244px] flex-col justify-center rounded-[4px] bg-[rgba(28,28,29,0.04)] px-8 py-10 sm:px-14">
              <div className="space-y-3">
                <p className="text-[15px] font-medium tracking-[0.01em] text-[#1c1c1d]">
                  Total SDP balance
                </p>
                <p className="text-[38px] leading-none font-medium tracking-[-0.05em] text-[#1c1c1d] sm:text-[54px]">
                  {formatCurrencyAmount(totalBalance)}
                </p>
                <p className="text-sm text-[rgba(28,28,29,0.56)]">
                  Aggregated across {walletCount} {walletCount === 1 ? "wallet" : "wallets"}.
                </p>
              </div>
            </div>

            <div className="grid gap-1.5">
              {aggregateBalances.length > 0 ? (
                aggregateBalances.map((balance) => (
                  <div
                    key={`${balance.token}-${balance.mint}`}
                    className="flex min-h-[78px] items-center justify-between gap-4 rounded-[4px] bg-[rgba(28,28,29,0.04)] px-6 py-5"
                  >
                    <p className="text-[18px] font-medium tracking-[0.04em] text-[#1c1c1d] uppercase">
                      {balance.token}
                    </p>
                    <p className="text-right text-[18px] font-medium tracking-[0.01em] text-[#1c1c1d] sm:text-[20px]">
                      {formatCurrencyAmount(balance.uiAmount)}
                    </p>
                  </div>
                ))
              ) : (
                <div className="flex min-h-[78px] items-center rounded-[4px] bg-[rgba(28,28,29,0.04)] px-6 py-5 text-sm text-[rgba(28,28,29,0.64)]">
                  No aggregated balance rows available yet.
                </div>
              )}
            </div>
          </div>

          {liveWalletsError ? (
            <p className="mt-4 text-sm text-[#9e2b38]">{liveWalletsError}</p>
          ) : null}
          {liveAggregateError ? (
            <p className="mt-2 text-sm text-[#9e2b38]">{liveAggregateError}</p>
          ) : null}
        </SectionEntry>

        <SectionEntry delay={0.08}>
          <Card>
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1">
                <CardTitle>Recent transactions</CardTitle>
                <CardDescription>
                  Latest transfer activity across all organization wallets.
                </CardDescription>
              </div>
              <Button
                type="button"
                variant="secondary"
                onClick={handleRefresh}
                disabled={isRefreshing}
              >
                <RefreshCw className={`size-4 ${isRefreshing ? "animate-spin" : ""}`} />
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </Button>
            </CardHeader>
            <CardContent>
              {liveTransfersError ? (
                <p className="text-sm text-[#9e2b38]">{liveTransfersError}</p>
              ) : liveTransfers.length === 0 ? (
                <p className="text-sm text-[rgba(28,28,29,0.72)]">No transactions found yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Status</TableHead>
                        <TableHead>Direction</TableHead>
                        <TableHead>Asset</TableHead>
                        <TableHead>Counterparty</TableHead>
                        <TableHead>Signature</TableHead>
                        <TableHead>Created</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {liveTransfers.map((transfer) => {
                        const counterparty = resolveCounterparty(transfer);

                        return (
                          <TableRow key={transfer.id}>
                            <TableCell>
                              <span
                                className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusClassName(transfer.status)}`}
                              >
                                {transfer.status}
                              </span>
                            </TableCell>
                            <TableCell className="text-[rgba(28,28,29,0.72)]">
                              {formatDirection(transfer.direction)}
                            </TableCell>
                            <TableCell className="font-medium">
                              {formatDisplayAmount(transfer.amount, transfer.token)}
                            </TableCell>
                            <TableCell className="font-mono text-xs text-[rgba(28,28,29,0.72)]">
                              <div
                                className="max-w-[12rem] truncate sm:max-w-[18rem]"
                                title={counterparty}
                              >
                                {counterparty}
                              </div>
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {transfer.signature ? (
                                <a
                                  href={getDevnetExplorerUrl(transfer.signature)}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 text-[#1c1c1d] underline underline-offset-2"
                                  title={transfer.signature}
                                >
                                  <span className="max-w-[9rem] truncate sm:max-w-[12rem]">
                                    {transfer.signature}
                                  </span>
                                  <ExternalLink className="size-3" />
                                </a>
                              ) : (
                                <span className="text-[rgba(28,28,29,0.52)]">Pending</span>
                              )}
                            </TableCell>
                            <TableCell className="text-[rgba(28,28,29,0.72)]">
                              {formatTimestamp(transfer.createdAt)}
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
        </SectionEntry>
      </div>

      <QuickActionModal
        open={sendModalOpen}
        mode="send"
        wallets={liveWallets}
        initialWalletId={selectedWalletId}
        onWalletChange={setSelectedWalletId}
        onClose={() => setSendModalOpen(false)}
      />
      <QuickActionModal
        open={receiveModalOpen}
        mode="receive"
        wallets={liveWallets}
        initialWalletId={selectedWalletId}
        onWalletChange={setSelectedWalletId}
        onClose={() => setReceiveModalOpen(false)}
      />
    </>
  );
}
