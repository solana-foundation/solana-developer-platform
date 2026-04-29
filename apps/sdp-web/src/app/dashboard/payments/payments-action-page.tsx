"use client";

import type {
  ComplianceProviderId,
  PaymentsDashboardWallet,
  PaymentTransferSummary,
  RampProviderId,
} from "@sdp/types";
import { Select, SelectItem } from "@solana/design-system/select";
import {
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  Copy,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isSolBalance } from "./payments-overview.utils";
import {
  createTransfer,
  executeRampFlow,
  fetchWalletBalances,
  fetchWalletPolicy,
  fetchWallets,
  getDevnetExplorerUrl,
  type PaymentRampExecution,
  type PaymentWalletBalance,
  runComplianceCheck,
} from "./payments-workspace.data";
import type { ComplianceSnapshot } from "./payments-workspace.types";
import { ProviderRiskTable } from "./provider-risk-table";

interface PaymentsActionPageProps {
  mode: "send" | "receive";
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  issuedTokenSymbolsByMint: Record<string, string>;
  enabledComplianceProviders: ComplianceProviderId[];
  enabledRampProviders: RampProviderId[];
}

const REQUIRED_ACTION_ASSETS = ["USDC"] as const;
const MOONPAY_ONRAMP_MIN_USD = 20;
const PAYMENTS_ACTION_WALLETS_KEY = "payments-action-wallets";
const PAYMENTS_ACTION_WALLET_BALANCES_KEY = "payments-action-wallet-balances";
// biome-ignore lint/security/noSecrets: Solana native mint address constant, not a secret.
const SOL_MINT = "So11111111111111111111111111111111111111112";
// biome-ignore lint/security/noSecrets: Devnet USDC mint address constant, not a secret.
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
// biome-ignore lint/security/noSecrets: Mainnet USDC mint address constant, not a secret.
const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BVNK_COUNTRY_OPTIONS = [
  { label: "United States", value: "US" },
  { label: "Canada", value: "CA" },
  { label: "United Kingdom", value: "GB" },
] as const;

type ActionBranch = "wallet_transfer" | "wallet_deposit" | "onramp" | "offramp";
type StepId = "branch" | "provider" | "details" | "review" | "deposit";
type ExecutionState = "idle" | "submitting" | "success";

type ProviderOption = {
  id: RampProviderId;
  title: string;
  description: string;
};

type StepDefinition = {
  id: StepId;
  label: string;
  title: string;
  description: string;
};

type SummaryRow = {
  label: string;
  value: ReactNode;
};

type RampReviewRowsInput = {
  isOnrampBranch: boolean;
  isOfframpBranch: boolean;
  provider: RampProviderId | null;
  providerLabel: string | null;
  selectedAsset: string;
  amount: string;
  selectedWallet: PaymentsDashboardWallet | null;
  customerId: string;
  lightsparkSourceAccountId: string;
  lightsparkDestinationAccountId: string;
  bvnkFirstName: string;
  bvnkLastName: string;
  bvnkDateOfBirth: string;
  bvnkCountryCode: string;
};

const ONRAMP_PROVIDER_OPTIONS: ProviderOption[] = [
  {
    id: "moonpay",
    title: "MoonPay",
    description: "Hosted fiat-to-crypto checkout into the selected wallet.",
  },
  {
    id: "lightspark",
    title: "Lightspark",
    description: "Create a Lightspark quote using the selected wallet as the destination.",
  },
  {
    id: "bvnk",
    title: "BVNK",
    description: "Create a BVNK checkout session with a customer reference.",
  },
];

const OFFRAMP_PROVIDER_OPTIONS: ProviderOption[] = [
  {
    id: "moonpay",
    title: "MoonPay",
    description: "Hosted crypto-to-fiat withdrawal using the selected wallet.",
  },
  {
    id: "lightspark",
    title: "Lightspark",
    description: "Execute an off-ramp using Lightspark source and destination account IDs.",
  },
  {
    id: "bvnk",
    title: "BVNK",
    description: "Create an off-ramp with beneficiary details for compliance.",
  },
];

const KNOWN_ASSET_MINTS: Record<string, string[]> = {
  USDC: [DEVNET_USDC_MINT, MAINNET_USDC_MINT],
};

function buildPaymentsReturnUrl(refreshToken?: string | null): string {
  if (!refreshToken) {
    return "/dashboard/payments";
  }

  return `/dashboard/payments?refresh=${encodeURIComponent(refreshToken)}`;
}

function parseOptionalNumber(value: string): number | null {
  const numericValue = Number.parseFloat(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function resolvePrimaryWalletBalance(wallet: PaymentsDashboardWallet | null) {
  const supportedBalances = wallet?.balances?.filter((balance) => !isSolBalance(balance)) ?? [];

  if (supportedBalances.length === 0) {
    return null;
  }

  return (
    supportedBalances.find((balance) => {
      const numericValue = Number(balance.uiAmount);
      return Number.isFinite(numericValue) && numericValue > 0;
    }) ??
    supportedBalances[0] ??
    null
  );
}

function resolveBalanceDisplayToken(
  balance: PaymentWalletBalance,
  issuedTokenSymbolsByMint: Record<string, string>
): string {
  const normalizedToken = balance.token.trim().toUpperCase();
  const normalizedMint = balance.mint.trim();
  const issuedTokenSymbol = issuedTokenSymbolsByMint[normalizedMint]?.trim();

  if (issuedTokenSymbol) {
    return issuedTokenSymbol.toUpperCase();
  }

  if (normalizedToken === "SOL" || normalizedMint === SOL_MINT) {
    return "SOL";
  }

  if (
    normalizedToken === "USDC" ||
    normalizedMint === DEVNET_USDC_MINT ||
    normalizedMint === MAINNET_USDC_MINT
  ) {
    return "USDC";
  }

  return normalizedToken || normalizedMint;
}

function balanceMatchesAsset(
  balance: PaymentWalletBalance,
  asset: string,
  issuedTokenSymbolsByMint: Record<string, string>
): boolean {
  const normalizedAsset = asset.trim().toUpperCase();
  if (!normalizedAsset) {
    return false;
  }

  if (resolveBalanceDisplayToken(balance, issuedTokenSymbolsByMint) === normalizedAsset) {
    return true;
  }

  return KNOWN_ASSET_MINTS[normalizedAsset]?.includes(balance.mint.trim()) ?? false;
}

function getWalletActionLabel(
  wallet: PaymentsDashboardWallet,
  issuedTokenSymbolsByMint: Record<string, string>
): string {
  const balance = resolvePrimaryWalletBalance(wallet);
  if (!balance) {
    return wallet.label ?? wallet.walletId;
  }

  return `${wallet.label ?? wallet.walletId} · ${balance.uiAmount} ${resolveBalanceDisplayToken(balance, issuedTokenSymbolsByMint)}`;
}

function resolveWalletActionAssets(
  wallet: PaymentsDashboardWallet | null,
  issuedTokenSymbolsByMint: Record<string, string>
): string[] {
  const assetSet = new Set<string>(REQUIRED_ACTION_ASSETS);

  for (const balance of wallet?.balances ?? []) {
    if (isSolBalance(balance)) {
      continue;
    }

    const token = resolveBalanceDisplayToken(balance, issuedTokenSymbolsByMint);
    if (token) {
      assetSet.add(token);
    }
  }

  return [...assetSet];
}

function resolveWalletAssetBalance(
  wallet: PaymentsDashboardWallet | null,
  asset: string,
  issuedTokenSymbolsByMint: Record<string, string>
): NonNullable<PaymentsDashboardWallet["balances"]>[number] | null {
  const normalizedAsset = asset.trim().toUpperCase();
  if (!wallet || !normalizedAsset) {
    return null;
  }

  return (
    wallet.balances?.find((balance) =>
      balanceMatchesAsset(balance, normalizedAsset, issuedTokenSymbolsByMint)
    ) ?? null
  );
}

function appendMoonpayReviewRows(
  rows: SummaryRow[],
  selectedWallet: PaymentsDashboardWallet | null
) {
  rows.push({
    label: "Address",
    value: <span className="font-mono text-xs">{selectedWallet?.publicKey ?? "—"}</span>,
  });
}

function appendLightsparkReviewRows(rows: SummaryRow[], input: RampReviewRowsInput) {
  if (input.isOnrampBranch) {
    rows.push({
      label: "Customer ID",
      value: input.customerId.trim() || "—",
    });
    rows.push({
      label: "Destination address",
      value: <span className="font-mono text-xs">{input.selectedWallet?.publicKey ?? "—"}</span>,
    });
    return;
  }

  rows.push({
    label: "Source account ID",
    value: input.lightsparkSourceAccountId.trim() || "—",
  });
  rows.push({
    label: "Destination account ID",
    value: input.lightsparkDestinationAccountId.trim() || "—",
  });
}

function appendBvnkReviewRows(rows: SummaryRow[], input: RampReviewRowsInput) {
  rows.push({
    label: "Customer ID",
    value: input.customerId.trim() || "—",
  });
  rows.push({
    label: input.isOnrampBranch ? "Destination address" : "Source address",
    value: <span className="font-mono text-xs">{input.selectedWallet?.publicKey ?? "—"}</span>,
  });

  if (!input.isOfframpBranch) {
    return;
  }

  rows.push({
    label: "Beneficiary",
    value: `${input.bvnkFirstName.trim()} ${input.bvnkLastName.trim()}`.trim() || "—",
  });
  rows.push({
    label: "Date of birth",
    value: input.bvnkDateOfBirth || "—",
  });
  rows.push({
    label: "Country",
    value:
      BVNK_COUNTRY_OPTIONS.find((country) => country.value === input.bvnkCountryCode)?.label ?? "—",
  });
}

function buildRampReviewRows(input: RampReviewRowsInput): SummaryRow[] {
  const rows: SummaryRow[] = [
    {
      label: "Flow",
      value: input.isOnrampBranch ? "On-ramp" : "Off-ramp",
    },
    {
      label: "Provider",
      value: input.providerLabel ?? "—",
    },
    {
      label: "Asset",
      value: input.selectedAsset || "—",
    },
    {
      label: input.isOnrampBranch ? "Fiat amount (USD)" : "Crypto amount",
      value: input.amount || "—",
    },
  ];

  if (input.isOnrampBranch || input.provider !== "lightspark") {
    rows.push({
      label: "Wallet",
      value: input.selectedWallet?.label ?? input.selectedWallet?.walletId ?? "—",
    });
  }

  if (input.provider === "moonpay") {
    appendMoonpayReviewRows(rows, input.selectedWallet);
    return rows;
  }

  if (input.provider === "lightspark") {
    appendLightsparkReviewRows(rows, input);
    return rows;
  }

  if (input.provider === "bvnk") {
    appendBvnkReviewRows(rows, input);
  }

  return rows;
}

function resolveStepSequence(
  mode: "send" | "receive",
  branch: ActionBranch | null
): StepDefinition[] {
  if (!branch) {
    return [
      {
        id: "branch",
        label: "Flow",
        title: `Choose a ${mode} flow`,
        description:
          mode === "send"
            ? "Choose whether you are sending to another wallet or starting an off-ramp."
            : "Choose whether you want wallet deposit details or an on-ramp flow.",
      },
    ];
  }

  if (branch === "wallet_transfer") {
    return [
      {
        id: "branch",
        label: "Flow",
        title: "Choose a send flow",
        description: "Wallet transfer keeps the flow inside SDP wallets and Solana addresses.",
      },
      {
        id: "details",
        label: "Details",
        title: "Enter transfer details",
        description: "Choose the source wallet, destination, and amount before review.",
      },
      {
        id: "review",
        label: "Review",
        title: "Review transfer",
        description: "Confirm the transfer details before submission.",
      },
    ];
  }

  if (branch === "wallet_deposit") {
    return [
      {
        id: "branch",
        label: "Flow",
        title: "Choose a receive flow",
        description: "Wallet deposit shows the wallet details needed to receive funds directly.",
      },
      {
        id: "details",
        label: "Details",
        title: "Choose wallet and asset",
        description: "Select the wallet and token context you want to use for this deposit.",
      },
      {
        id: "deposit",
        label: "Receive",
        title: "Receive funds",
        description: "Use this address or QR code to deposit into the selected wallet.",
      },
    ];
  }

  return [
    {
      id: "branch",
      label: "Flow",
      title: `Choose a ${mode} flow`,
      description:
        branch === "onramp"
          ? "On-ramp flows move fiat into the selected wallet through a provider."
          : "Off-ramp flows move funds out through a provider-specific withdrawal flow.",
    },
    {
      id: "provider",
      label: "Provider",
      title: `Choose a ${branch === "onramp" ? "provider" : "provider"}`,
      description:
        branch === "onramp"
          ? "Choose the on-ramp provider you want to use."
          : "Choose the off-ramp provider you want to use.",
    },
    {
      id: "details",
      label: "Details",
      title: branch === "onramp" ? "Enter on-ramp details" : "Enter off-ramp details",
      description:
        branch === "onramp"
          ? "Fill in the wallet, amount, and provider-specific information."
          : "Fill in the amount and provider-specific payout information.",
    },
    {
      id: "review",
      label: "Review",
      title: branch === "onramp" ? "Review on-ramp" : "Review off-ramp",
      description: "Confirm the provider request before it is submitted.",
    },
  ];
}

function ActionChoiceCard({
  active,
  title,
  description,
  icon,
  onClick,
}: {
  active: boolean;
  title: string;
  description: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "w-full rounded-2xl border px-5 py-5 text-left transition-colors",
        active
          ? "border-gray-1400 bg-border-extra-light"
          : "border-border-light bg-white hover:bg-border-extra-light",
      ].join(" ")}
    >
      <div className="flex items-start gap-4">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-border-light text-text-extra-high">
          {icon}
        </div>
        <div className="space-y-1">
          <p className="text-[22px] leading-none font-medium text-text-extra-high">{title}</p>
          <p className="text-sm text-text-low">{description}</p>
        </div>
      </div>
    </button>
  );
}

function ReviewSummaryCard({ rows }: { rows: Array<{ label: string; value: ReactNode }> }) {
  return (
    <section className="rounded-2xl border border-border-light bg-border-extra-light p-5">
      <div className="divide-y divide-border-extra-light">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0"
          >
            <p className="text-sm text-text-low">{row.label}</p>
            <div className="text-right text-base font-medium text-text-extra-high">{row.value}</div>
          </div>
        ))}
      </div>
    </section>
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
    <section className="rounded-2xl border border-border-light bg-border-extra-light p-6">
      <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start">
        <div className="flex size-[180px] items-center justify-center rounded-2xl bg-white p-4 ring-1 ring-border-extra-light">
          {qrCodeUrl ? (
            <img src={qrCodeUrl} alt="Wallet address QR code" className="size-full" />
          ) : (
            <div className="size-full animate-pulse rounded-xl bg-border-light" />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <p className="text-sm text-text-low">
            Scan this QR code or copy the address to receive funds into the selected wallet.
          </p>
          <div className="rounded-2xl border border-border-extra-light bg-white px-4 py-3">
            <p className="break-all font-mono text-xs text-text-medium">{address}</p>
          </div>
          <div className="flex justify-end">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void navigator.clipboard.writeText(address);
                toast.success("Address copied.", {
                  position: "bottom-right",
                });
              }}
            >
              <Copy className="size-4" />
              Copy address
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function MoonpayRampFields({
  isOnrampBranch,
  isBelowMoonPayOnrampMinimum,
  selectedWallet,
}: {
  isOnrampBranch: boolean;
  isBelowMoonPayOnrampMinimum: boolean;
  selectedWallet: PaymentsDashboardWallet | null;
}) {
  return (
    <>
      {isOnrampBranch ? (
        <p
          className={
            isBelowMoonPayOnrampMinimum ? "text-sm text-status-error-text" : "text-sm text-text-low"
          }
        >
          Minimum $20 USD for MoonPay on-ramp.
        </p>
      ) : null}

      {selectedWallet?.publicKey ? (
        <div className="space-y-2">
          <Label>{isOnrampBranch ? "Destination address" : "Source address"}</Label>
          <Input
            readOnly
            value={selectedWallet.publicKey}
            className="h-12 rounded-2xl border-border-light bg-border-extra-light px-4 font-mono text-sm shadow-none"
          />
        </div>
      ) : null}
    </>
  );
}

function LightsparkRampFields({
  mode,
  isOnrampBranch,
  selectedWallet,
  customerId,
  setCustomerId,
  lightsparkSourceAccountId,
  setLightsparkSourceAccountId,
  lightsparkDestinationAccountId,
  setLightsparkDestinationAccountId,
  resetExecution,
}: {
  mode: "send" | "receive";
  isOnrampBranch: boolean;
  selectedWallet: PaymentsDashboardWallet | null;
  customerId: string;
  setCustomerId: (value: string) => void;
  lightsparkSourceAccountId: string;
  setLightsparkSourceAccountId: (value: string) => void;
  lightsparkDestinationAccountId: string;
  setLightsparkDestinationAccountId: (value: string) => void;
  resetExecution: () => void;
}) {
  if (isOnrampBranch) {
    return (
      <>
        <div className="space-y-2">
          <Label htmlFor={`${mode}-customer-id`}>Customer ID</Label>
          <Input
            id={`${mode}-customer-id`}
            value={customerId}
            onChange={(event) => {
              setCustomerId(event.currentTarget.value);
              resetExecution();
            }}
            placeholder="Customer:cus_123"
            className="h-12 rounded-2xl border-border-light bg-white px-4 shadow-none"
          />
        </div>
        <div className="space-y-2">
          <Label>Destination address</Label>
          <Input
            readOnly
            value={selectedWallet?.publicKey ?? ""}
            className="h-12 rounded-2xl border-border-light bg-border-extra-light px-4 font-mono text-sm shadow-none"
          />
        </div>
      </>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor={`${mode}-lightspark-source`}>Source account ID</Label>
        <Input
          id={`${mode}-lightspark-source`}
          value={lightsparkSourceAccountId}
          onChange={(event) => {
            setLightsparkSourceAccountId(event.currentTarget.value);
            resetExecution();
          }}
          placeholder="InternalAccount:acc_source_123"
          className="h-12 rounded-2xl border-border-light bg-white px-4 shadow-none"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${mode}-lightspark-destination`}>Destination account ID</Label>
        <Input
          id={`${mode}-lightspark-destination`}
          value={lightsparkDestinationAccountId}
          onChange={(event) => {
            setLightsparkDestinationAccountId(event.currentTarget.value);
            resetExecution();
          }}
          placeholder="ExternalAccount:acc_destination_123"
          className="h-12 rounded-2xl border-border-light bg-white px-4 shadow-none"
        />
      </div>
    </div>
  );
}

function BvnkRampFields({
  mode,
  isOnrampBranch,
  selectedWallet,
  customerId,
  setCustomerId,
  bvnkFirstName,
  setBvnkFirstName,
  bvnkLastName,
  setBvnkLastName,
  bvnkDateOfBirth,
  setBvnkDateOfBirth,
  bvnkCountryCode,
  setBvnkCountryCode,
  resetExecution,
}: {
  mode: "send" | "receive";
  isOnrampBranch: boolean;
  selectedWallet: PaymentsDashboardWallet | null;
  customerId: string;
  setCustomerId: (value: string) => void;
  bvnkFirstName: string;
  setBvnkFirstName: (value: string) => void;
  bvnkLastName: string;
  setBvnkLastName: (value: string) => void;
  bvnkDateOfBirth: string;
  setBvnkDateOfBirth: (value: string) => void;
  bvnkCountryCode: string;
  setBvnkCountryCode: (value: string) => void;
  resetExecution: () => void;
}) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={`${mode}-bvnk-customer-id`}>Customer ID</Label>
        <Input
          id={`${mode}-bvnk-customer-id`}
          value={customerId}
          onChange={(event) => {
            setCustomerId(event.currentTarget.value);
            resetExecution();
          }}
          placeholder="customer_123"
          className="h-12 rounded-2xl border-border-light bg-white px-4 shadow-none"
        />
      </div>

      {selectedWallet?.publicKey ? (
        <div className="space-y-2">
          <Label>{isOnrampBranch ? "Destination address" : "Source address"}</Label>
          <Input
            readOnly
            value={selectedWallet.publicKey}
            className="h-12 rounded-2xl border-border-light bg-border-extra-light px-4 font-mono text-sm shadow-none"
          />
        </div>
      ) : null}

      {isOnrampBranch ? null : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`${mode}-bvnk-first-name`}>First name</Label>
            <Input
              id={`${mode}-bvnk-first-name`}
              value={bvnkFirstName}
              onChange={(event) => {
                setBvnkFirstName(event.currentTarget.value);
                resetExecution();
              }}
              placeholder="Jane"
              className="h-12 rounded-2xl border-border-light bg-white px-4 shadow-none"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${mode}-bvnk-last-name`}>Last name</Label>
            <Input
              id={`${mode}-bvnk-last-name`}
              value={bvnkLastName}
              onChange={(event) => {
                setBvnkLastName(event.currentTarget.value);
                resetExecution();
              }}
              placeholder="Doe"
              className="h-12 rounded-2xl border-border-light bg-white px-4 shadow-none"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${mode}-bvnk-dob`}>Date of birth</Label>
            <Input
              id={`${mode}-bvnk-dob`}
              type="date"
              value={bvnkDateOfBirth}
              onChange={(event) => {
                setBvnkDateOfBirth(event.currentTarget.value);
                resetExecution();
              }}
              className="h-12 rounded-2xl border-border-light bg-white px-4 shadow-none"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${mode}-bvnk-country`}>Country</Label>
            <select
              id={`${mode}-bvnk-country`}
              value={bvnkCountryCode}
              onChange={(event) => {
                setBvnkCountryCode(event.currentTarget.value);
                resetExecution();
              }}
              className="h-12 w-full rounded-2xl border border-border-light bg-white px-4 text-sm text-text-extra-high"
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
      )}
    </>
  );
}

function RampProviderFields({
  mode,
  provider,
  isOnrampBranch,
  isBelowMoonPayOnrampMinimum,
  selectedWallet,
  customerId,
  setCustomerId,
  lightsparkSourceAccountId,
  setLightsparkSourceAccountId,
  lightsparkDestinationAccountId,
  setLightsparkDestinationAccountId,
  bvnkFirstName,
  setBvnkFirstName,
  bvnkLastName,
  setBvnkLastName,
  bvnkDateOfBirth,
  setBvnkDateOfBirth,
  bvnkCountryCode,
  setBvnkCountryCode,
  resetExecution,
}: {
  mode: "send" | "receive";
  provider: RampProviderId;
  isOnrampBranch: boolean;
  isBelowMoonPayOnrampMinimum: boolean;
  selectedWallet: PaymentsDashboardWallet | null;
  customerId: string;
  setCustomerId: (value: string) => void;
  lightsparkSourceAccountId: string;
  setLightsparkSourceAccountId: (value: string) => void;
  lightsparkDestinationAccountId: string;
  setLightsparkDestinationAccountId: (value: string) => void;
  bvnkFirstName: string;
  setBvnkFirstName: (value: string) => void;
  bvnkLastName: string;
  setBvnkLastName: (value: string) => void;
  bvnkDateOfBirth: string;
  setBvnkDateOfBirth: (value: string) => void;
  bvnkCountryCode: string;
  setBvnkCountryCode: (value: string) => void;
  resetExecution: () => void;
}) {
  if (provider === "moonpay") {
    return (
      <MoonpayRampFields
        isOnrampBranch={isOnrampBranch}
        isBelowMoonPayOnrampMinimum={isBelowMoonPayOnrampMinimum}
        selectedWallet={selectedWallet}
      />
    );
  }

  if (provider === "lightspark") {
    return (
      <LightsparkRampFields
        mode={mode}
        isOnrampBranch={isOnrampBranch}
        selectedWallet={selectedWallet}
        customerId={customerId}
        setCustomerId={setCustomerId}
        lightsparkSourceAccountId={lightsparkSourceAccountId}
        setLightsparkSourceAccountId={setLightsparkSourceAccountId}
        lightsparkDestinationAccountId={lightsparkDestinationAccountId}
        setLightsparkDestinationAccountId={setLightsparkDestinationAccountId}
        resetExecution={resetExecution}
      />
    );
  }

  return (
    <BvnkRampFields
      mode={mode}
      isOnrampBranch={isOnrampBranch}
      selectedWallet={selectedWallet}
      customerId={customerId}
      setCustomerId={setCustomerId}
      bvnkFirstName={bvnkFirstName}
      setBvnkFirstName={setBvnkFirstName}
      bvnkLastName={bvnkLastName}
      setBvnkLastName={setBvnkLastName}
      bvnkDateOfBirth={bvnkDateOfBirth}
      setBvnkDateOfBirth={setBvnkDateOfBirth}
      bvnkCountryCode={bvnkCountryCode}
      setBvnkCountryCode={setBvnkCountryCode}
      resetExecution={resetExecution}
    />
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this component intentionally coordinates the full multi-step payments flow in one place.
export function PaymentsActionPage({
  mode,
  wallets,
  walletsError,
  issuedTokenSymbolsByMint,
  enabledComplianceProviders,
  enabledRampProviders,
}: PaymentsActionPageProps) {
  const router = useRouter();

  const [branch, setBranch] = useState<ActionBranch | null>(null);
  const [provider, setProvider] = useState<RampProviderId | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [selectedWalletId, setSelectedWalletId] = useState("");
  const [selectedAsset, setSelectedAsset] = useState("USDC");
  const [amount, setAmount] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);
  const [destination, setDestination] = useState("");
  const [memo, setMemo] = useState("");
  const [reference, setReference] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [lightsparkSourceAccountId, setLightsparkSourceAccountId] = useState("");
  const [lightsparkDestinationAccountId, setLightsparkDestinationAccountId] = useState("");
  const [bvnkFirstName, setBvnkFirstName] = useState("");
  const [bvnkLastName, setBvnkLastName] = useState("");
  const [bvnkDateOfBirth, setBvnkDateOfBirth] = useState("");
  const [bvnkCountryCode, setBvnkCountryCode] = useState("");
  const [policyAllowlist, setPolicyAllowlist] = useState<string[]>([]);
  const [policyLoading, setPolicyLoading] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [transferCompliance, setTransferCompliance] = useState<ComplianceSnapshot | null>(null);
  const [transferComplianceLoading, setTransferComplianceLoading] = useState(false);
  const [transferComplianceDismissed, setTransferComplianceDismissed] = useState(false);
  const [executionState, setExecutionState] = useState<ExecutionState>("idle");
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [transferResult, setTransferResult] = useState<PaymentTransferSummary | null>(null);
  const [rampExecution, setRampExecution] = useState<PaymentRampExecution | null>(null);
  const shouldLoadWallets = branch !== null;
  const hasServerWalletSnapshot = wallets.length > 0 || walletsError !== null;
  const {
    data: swrWallets,
    error: walletsFetchError,
    isValidating: walletsRefreshing,
  } = useSWR<PaymentsDashboardWallet[]>(
    shouldLoadWallets ? PAYMENTS_ACTION_WALLETS_KEY : null,
    () => fetchWallets(),
    {
      fallbackData: hasServerWalletSnapshot ? wallets : undefined,
      revalidateOnFocus: false,
      revalidateIfStale: false,
    }
  );
  const liveWallets = swrWallets ?? wallets;
  const liveWalletsError = walletsFetchError
    ? walletsFetchError instanceof Error
      ? walletsFetchError.message
      : "Request failed."
    : swrWallets === undefined
      ? walletsError
      : null;
  const hasWallets = liveWallets.length > 0;
  const walletsLoading = shouldLoadWallets && walletsRefreshing && swrWallets === undefined;

  useEffect(() => {
    if (!hasWallets) {
      setSelectedWalletId("");
      return;
    }

    if (!liveWallets.some((wallet) => wallet.walletId === selectedWalletId)) {
      setSelectedWalletId(liveWallets[0]?.walletId ?? "");
    }
  }, [hasWallets, liveWallets, selectedWalletId]);

  const selectedWallet = useMemo(
    () => liveWallets.find((wallet) => wallet.walletId === selectedWalletId) ?? null,
    [liveWallets, selectedWalletId]
  );
  const { data: selectedWalletBalancesSnapshot } = useSWR(
    selectedWalletId ? [PAYMENTS_ACTION_WALLET_BALANCES_KEY, selectedWalletId] : null,
    ([, walletId]: readonly [string, string]) => fetchWalletBalances(walletId),
    {
      revalidateOnFocus: false,
      revalidateIfStale: false,
    }
  );
  const selectedWalletWithBalances = useMemo(() => {
    if (!selectedWallet) {
      return null;
    }

    if (selectedWalletBalancesSnapshot?.walletId !== selectedWallet.walletId) {
      return selectedWallet;
    }

    return {
      ...selectedWallet,
      balances: selectedWalletBalancesSnapshot.balances,
    };
  }, [selectedWallet, selectedWalletBalancesSnapshot]);
  const isOnrampBranch = branch === "onramp";
  const isOfframpBranch = branch === "offramp";
  const assetOptions = useMemo(
    () => resolveWalletActionAssets(selectedWalletWithBalances, issuedTokenSymbolsByMint),
    [issuedTokenSymbolsByMint, selectedWalletWithBalances]
  );
  const selectedAssetBalance = useMemo(
    () =>
      resolveWalletAssetBalance(
        selectedWalletWithBalances,
        selectedAsset,
        issuedTokenSymbolsByMint
      ),
    [issuedTokenSymbolsByMint, selectedAsset, selectedWalletWithBalances]
  );

  useEffect(() => {
    if (assetOptions.length === 0) {
      setSelectedAsset("");
      return;
    }

    if (!assetOptions.includes(selectedAsset)) {
      setSelectedAsset(assetOptions.includes("USDC") ? "USDC" : (assetOptions[0] ?? ""));
    }
  }, [assetOptions, selectedAsset]);

  const steps = useMemo(() => resolveStepSequence(mode, branch), [branch, mode]);
  const safeStepIndex = Math.min(stepIndex, steps.length - 1);
  const currentStep = steps[safeStepIndex] ?? steps[0];

  useEffect(() => {
    if (safeStepIndex !== stepIndex) {
      setStepIndex(safeStepIndex);
    }
  }, [safeStepIndex, stepIndex]);

  const isSendAction = mode === "send";
  const isTransferBranch = branch === "wallet_transfer";
  const isDepositBranch = branch === "wallet_deposit";
  const hasEnabledComplianceProviders = enabledComplianceProviders.length > 0;
  const providerOptions = useMemo(
    () =>
      (isOnrampBranch ? ONRAMP_PROVIDER_OPTIONS : OFFRAMP_PROVIDER_OPTIONS).filter((option) =>
        enabledRampProviders.includes(option.id)
      ),
    [enabledRampProviders, isOnrampBranch]
  );
  const providerLabel = providerOptions.find((option) => option.id === provider)?.title ?? null;
  const numericAmount = parseOptionalNumber(amount);
  const destinationTrimmed = destination.trim();
  const destinationIsAllowlisted =
    !!destinationTrimmed && policyAllowlist.includes(destinationTrimmed);
  const hasTransferComplianceForDestination =
    !!transferCompliance &&
    transferCompliance.address === destinationTrimmed &&
    transferCompliance.providers.length > 0;
  const isBelowMoonPayOnrampMinimum =
    isOnrampBranch &&
    provider === "moonpay" &&
    amount.trim().length > 0 &&
    (numericAmount === null || numericAmount < MOONPAY_ONRAMP_MIN_USD);
  const availableSelectedAssetAmount = useMemo(() => {
    if (!selectedAsset) {
      return null;
    }

    if (!selectedAssetBalance) {
      return 0;
    }

    const numericValue = Number(selectedAssetBalance.uiAmount);
    return Number.isFinite(numericValue) ? numericValue : 0;
  }, [selectedAsset, selectedAssetBalance]);
  const exceedsSelectedAssetBalance =
    isTransferBranch &&
    !!selectedAsset &&
    amount.trim().length > 0 &&
    numericAmount !== null &&
    availableSelectedAssetAmount !== null &&
    numericAmount > availableSelectedAssetAmount;

  const resetExecution = useCallback(() => {
    setExecutionState("idle");
    setExecutionError(null);
    setTransferResult(null);
    setRampExecution(null);
  }, []);

  useEffect(() => {
    if (!provider) {
      return;
    }

    if (!providerOptions.some((option) => option.id === provider)) {
      setProvider(null);
      setStepIndex(1);
      resetExecution();
    }
  }, [provider, providerOptions, resetExecution]);

  useEffect(() => {
    if (!isTransferBranch || !selectedWalletId) {
      setPolicyAllowlist([]);
      setPolicyError(null);
      return;
    }

    let cancelled = false;
    setPolicyLoading(true);
    setPolicyError(null);

    void fetchWalletPolicy(selectedWalletId)
      .then((policy) => {
        if (!cancelled) {
          setPolicyAllowlist(policy.destinationAllowlist);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setPolicyAllowlist([]);
          setPolicyError(
            error instanceof Error ? error.message : "Failed to load source wallet allowlist."
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setPolicyLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isTransferBranch, selectedWalletId]);

  const resetFlowFields = () => {
    setAmount("");
    setAmountTouched(false);
    setDestination("");
    setMemo("");
    setReference("");
    setCustomerId("");
    setLightsparkSourceAccountId("");
    setLightsparkDestinationAccountId("");
    setBvnkFirstName("");
    setBvnkLastName("");
    setBvnkDateOfBirth("");
    setBvnkCountryCode("");
    setTransferCompliance(null);
    setTransferComplianceDismissed(false);
    setPolicyError(null);
    resetExecution();
  };

  const selectBranch = (nextBranch: ActionBranch) => {
    setBranch(nextBranch);
    setProvider(null);
    resetFlowFields();
    setStepIndex(1);
  };

  const selectProvider = (nextProvider: RampProviderId) => {
    setProvider(nextProvider);
    resetExecution();
    setExecutionError(null);
    setStepIndex(2);
  };

  const checkTransferCompliance = async () => {
    if (!hasEnabledComplianceProviders) {
      toast.error("Compliance check unavailable.", {
        description:
          "Risk checks are only enabled for enterprise organizations with a configured provider.",
        position: "bottom-right",
      });
      return;
    }

    if (!destinationTrimmed) {
      return;
    }

    setTransferComplianceLoading(true);
    setTransferComplianceDismissed(false);
    try {
      setTransferCompliance(await runComplianceCheck(destinationTrimmed, "transfer_destination"));
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

  const canAdvanceDetailsStep = useMemo(() => {
    if (isTransferBranch) {
      return (
        !!selectedWalletId &&
        !!selectedAsset &&
        !!destinationTrimmed &&
        !!amount.trim() &&
        !exceedsSelectedAssetBalance &&
        (hasTransferComplianceForDestination || destinationIsAllowlisted)
      );
    }

    if (isDepositBranch) {
      return !!selectedWalletId && !!selectedAsset;
    }

    if (!provider) {
      return false;
    }

    if (isOnrampBranch) {
      if (!selectedWalletId || !selectedAsset || !amount.trim() || !numericAmount) {
        return false;
      }

      if (provider === "moonpay") {
        return !isBelowMoonPayOnrampMinimum;
      }

      return !!customerId.trim();
    }

    if (!selectedAsset || !amount.trim() || !numericAmount) {
      return false;
    }

    if (provider === "moonpay") {
      return !!selectedWalletId;
    }

    if (provider === "lightspark") {
      return !!lightsparkSourceAccountId.trim() && !!lightsparkDestinationAccountId.trim();
    }

    return (
      !!selectedWalletId &&
      !!customerId.trim() &&
      !!bvnkFirstName.trim() &&
      !!bvnkLastName.trim() &&
      !!bvnkDateOfBirth &&
      !!bvnkCountryCode
    );
  }, [
    amount,
    bvnkCountryCode,
    bvnkDateOfBirth,
    bvnkFirstName,
    bvnkLastName,
    customerId,
    destinationIsAllowlisted,
    destinationTrimmed,
    exceedsSelectedAssetBalance,
    hasTransferComplianceForDestination,
    isBelowMoonPayOnrampMinimum,
    isDepositBranch,
    isOnrampBranch,
    isTransferBranch,
    lightsparkDestinationAccountId,
    lightsparkSourceAccountId,
    numericAmount,
    provider,
    selectedAsset,
    selectedWalletId,
  ]);

  const transferReviewRows = useMemo(
    () => [
      {
        label: "Flow",
        value: "Wallet transfer",
      },
      {
        label: "Source wallet",
        value: selectedWallet?.label ?? selectedWallet?.walletId ?? "—",
      },
      {
        label: "Asset",
        value: selectedAsset || "—",
      },
      {
        label: "Amount",
        value: amount || "—",
      },
      {
        label: "Destination",
        value: <span className="font-mono text-xs">{destinationTrimmed || "—"}</span>,
      },
      {
        label: "Risk/compliance",
        value: destinationIsAllowlisted
          ? "Source wallet allowlist"
          : hasTransferComplianceForDestination
            ? "Risk check completed"
            : hasEnabledComplianceProviders
              ? "Required"
              : "Allowlist required",
      },
      ...(memo.trim()
        ? [
            {
              label: "Memo",
              value: memo.trim(),
            },
          ]
        : []),
    ],
    [
      amount,
      destinationIsAllowlisted,
      destinationTrimmed,
      hasEnabledComplianceProviders,
      hasTransferComplianceForDestination,
      memo,
      selectedAsset,
      selectedWallet?.label,
      selectedWallet?.walletId,
    ]
  );

  const rampReviewRows = useMemo(
    () =>
      buildRampReviewRows({
        isOnrampBranch,
        isOfframpBranch,
        provider,
        providerLabel,
        selectedAsset,
        amount,
        selectedWallet,
        customerId,
        lightsparkSourceAccountId,
        lightsparkDestinationAccountId,
        bvnkFirstName,
        bvnkLastName,
        bvnkDateOfBirth,
        bvnkCountryCode,
      }),
    [
      amount,
      bvnkCountryCode,
      bvnkDateOfBirth,
      bvnkFirstName,
      bvnkLastName,
      customerId,
      isOfframpBranch,
      isOnrampBranch,
      lightsparkDestinationAccountId,
      lightsparkSourceAccountId,
      provider,
      providerLabel,
      selectedAsset,
      selectedWallet,
    ]
  );

  const submitTransferFlow = async () => {
    if (!selectedWalletId) {
      return;
    }

    setExecutionState("submitting");
    setExecutionError(null);
    const toastId = toast.loading("Submitting transfer.", {
      position: "bottom-right",
    });

    try {
      const transfer = await createTransfer({
        source: selectedWalletId,
        destination: destinationTrimmed,
        token:
          selectedAssetBalance?.mint?.trim() ||
          (selectedAsset.trim().toUpperCase() === "SOL" ? "SOL" : selectedAsset.trim()) ||
          "SOL",
        amount: amount.trim(),
        ...(memo.trim() ? { memo: memo.trim() } : {}),
      });
      setTransferResult(transfer);
      setExecutionState("success");

      toast.success("Transfer submitted.", {
        id: toastId,
        description: transfer.signature
          ? "Transaction sent successfully."
          : `Status: ${transfer.status}`,
        position: "bottom-right",
      });
    } catch (error) {
      setExecutionState("idle");
      setExecutionError(error instanceof Error ? error.message : "Transfer failed.");
      toast.error("Transfer failed.", {
        id: toastId,
        description: error instanceof Error ? error.message : "Transfer failed.",
        position: "bottom-right",
      });
    }
  };

  const buildRampPayload = (): Record<string, unknown> => {
    if (!provider) {
      return {};
    }

    if (provider === "moonpay" && isOnrampBranch) {
      return {
        provider: "moonpay",
        destinationWallet: selectedWalletId,
        cryptoToken: selectedAsset,
        fiatAmount: amount.trim(),
      };
    }

    if (provider === "moonpay" && isOfframpBranch) {
      return {
        provider: "moonpay",
        sourceWallet: selectedWalletId,
        cryptoToken: selectedAsset,
        cryptoAmount: amount.trim(),
      };
    }

    if (provider === "lightspark" && isOnrampBranch) {
      return {
        provider: "lightspark",
        destinationWallet: selectedWalletId,
        cryptoToken: selectedAsset,
        fiatAmount: amount.trim(),
        kycReference: customerId.trim(),
      };
    }

    if (provider === "lightspark" && isOfframpBranch) {
      return {
        provider: "lightspark",
        sourceWallet: lightsparkSourceAccountId.trim(),
        cryptoToken: selectedAsset,
        cryptoAmount: amount.trim(),
        kycReference: lightsparkDestinationAccountId.trim(),
      };
    }

    if (provider === "bvnk" && isOnrampBranch) {
      return {
        provider: "bvnk",
        destinationWallet: selectedWalletId,
        cryptoToken: selectedAsset,
        fiatAmount: amount.trim(),
        kycReference: customerId.trim(),
      };
    }

    return {
      provider: "bvnk",
      sourceWallet: selectedWalletId,
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

  const submitRampRequest = async () => {
    if (!provider) {
      return;
    }

    setExecutionState("submitting");
    setExecutionError(null);
    const toastId = toast.loading(`Preparing ${providerLabel ?? "provider"} flow.`, {
      position: "bottom-right",
    });

    try {
      const execution = await executeRampFlow(
        isOnrampBranch ? "onramp" : "offramp",
        buildRampPayload()
      );
      setRampExecution(execution);
      setExecutionState("success");
      toast.success(`${providerLabel ?? "Provider"} flow ready.`, {
        id: toastId,
        position: "bottom-right",
      });
    } catch (error) {
      setExecutionState("idle");
      setExecutionError(error instanceof Error ? error.message : "Ramp request failed.");
      toast.error(`${providerLabel ?? "Provider"} flow failed to initialize.`, {
        id: toastId,
        description: error instanceof Error ? error.message : "Ramp request failed.",
        position: "bottom-right",
      });
    }
  };

  const handlePrimaryAction = async () => {
    if (currentStep.id === "branch") {
      if (branch) {
        setStepIndex((current) => current + 1);
      }
      return;
    }

    if (currentStep.id === "provider") {
      if (provider) {
        setStepIndex((current) => current + 1);
      }
      return;
    }

    if (currentStep.id === "details") {
      if (canAdvanceDetailsStep) {
        setStepIndex((current) => current + 1);
      }
      return;
    }

    if (currentStep.id === "deposit") {
      router.push("/dashboard/payments");
      return;
    }

    if (currentStep.id === "review") {
      if (executionState === "success") {
        router.push(buildPaymentsReturnUrl(transferResult?.id ?? rampExecution?.id ?? null));
        return;
      }

      if (isTransferBranch) {
        await submitTransferFlow();
        return;
      }

      await submitRampRequest();
    }
  };

  const handleSecondaryAction = async () => {
    if (currentStep.id === "branch") {
      router.push("/dashboard/payments");
      return;
    }

    if (currentStep.id === "review" && executionState === "success") {
      setStepIndex(0);
      setBranch(null);
      setProvider(null);
      resetFlowFields();
      return;
    }

    setStepIndex((current) => Math.max(0, current - 1));
  };

  const primaryLabel = useMemo(() => {
    if (currentStep.id === "details") {
      return "Next";
    }

    if (currentStep.id === "deposit") {
      return "Done";
    }

    if (executionState === "submitting") {
      return isTransferBranch ? "Submitting..." : "Preparing...";
    }

    if (executionState === "success") {
      return "Back to payments";
    }

    return "Confirm";
  }, [currentStep.id, executionState, isTransferBranch]);

  const secondaryLabel = useMemo(() => {
    if (currentStep.id === "branch") {
      return "Back";
    }

    if (currentStep.id === "review" && executionState === "success") {
      return "Start over";
    }

    return "Previous";
  }, [currentStep.id, executionState]);

  const showPrimaryAction = currentStep.id !== "branch" && currentStep.id !== "provider";

  const primaryDisabled =
    executionState === "submitting" || (currentStep.id === "details" && !canAdvanceDetailsStep);

  const renderBranchStep = () => (
    <div className="grid gap-4">
      {isSendAction ? (
        <>
          <ActionChoiceCard
            active={branch === "wallet_transfer"}
            title="Wallet transfer"
            description="Send funds from an SDP wallet to a destination Solana address."
            icon={<ArrowUpRight className="size-5" />}
            onClick={() => selectBranch("wallet_transfer")}
          />
          {enabledRampProviders.length > 0 ? (
            <ActionChoiceCard
              active={branch === "offramp"}
              title="Off-ramp"
              description="Move value out through a provider-specific off-ramp flow."
              icon={<ArrowDownLeft className="size-5" />}
              onClick={() => selectBranch("offramp")}
            />
          ) : (
            <div className="rounded-2xl border border-border-light bg-border-extra-light px-5 py-5 text-sm text-text-low">
              Off-ramp providers are only available on enterprise organizations with an enabled
              provider.
            </div>
          )}
        </>
      ) : (
        <>
          <ActionChoiceCard
            active={branch === "wallet_deposit"}
            title="Wallet deposit"
            description="Receive funds directly into one of your SDP wallets."
            icon={<ArrowDownLeft className="size-5" />}
            onClick={() => selectBranch("wallet_deposit")}
          />
          {enabledRampProviders.length > 0 ? (
            <ActionChoiceCard
              active={branch === "onramp"}
              title="On-ramp"
              description="Start a provider flow to move fiat into the selected wallet."
              icon={<ArrowUpRight className="size-5" />}
              onClick={() => selectBranch("onramp")}
            />
          ) : (
            <div className="rounded-2xl border border-border-light bg-border-extra-light px-5 py-5 text-sm text-text-low">
              On-ramp providers are only available on enterprise organizations with an enabled
              provider.
            </div>
          )}
        </>
      )}
    </div>
  );

  const renderProviderStep = () => (
    <div className="grid gap-4">
      {providerOptions.length === 0 ? (
        <div className="rounded-2xl border border-border-light bg-border-extra-light px-5 py-5 text-sm text-text-low">
          No ramp providers are enabled for this organization.
        </div>
      ) : null}
      {providerOptions.map((option) => (
        <ActionChoiceCard
          key={option.id}
          active={provider === option.id}
          title={option.title}
          description={option.description}
          icon={<CheckCircle2 className="size-5" />}
          onClick={() => selectProvider(option.id)}
        />
      ))}
    </div>
  );

  const renderWalletSelect = ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: string;
    onChange: (value: string) => void;
  }) => {
    if (walletsLoading) {
      return (
        <div className="space-y-2">
          <Label>{label}</Label>
          <div className="h-12 animate-pulse rounded-2xl border border-border-extra-light bg-border-extra-light" />
        </div>
      );
    }

    return (
      <div className="space-y-2">
        <Select
          className="w-full"
          disabled={!hasWallets}
          label={label}
          onValueChange={(nextValue) => {
            if (nextValue) {
              onChange(nextValue);
            }
          }}
          placeholder="Select wallet"
          size="xl"
          value={value || null}
        >
          {liveWallets.map((wallet) => (
            <SelectItem key={wallet.walletId} value={wallet.walletId}>
              {getWalletActionLabel(wallet, issuedTokenSymbolsByMint)}
            </SelectItem>
          ))}
        </Select>
      </div>
    );
  };

  const renderAssetAndAmount = (amountLabel: string) => (
    <div className="space-y-1">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_160px]">
        <div className="space-y-2">
          <Label htmlFor={`${mode}-amount`}>{amountLabel}</Label>
          <Input
            id={`${mode}-amount`}
            type="number"
            inputMode="decimal"
            min="0.000001"
            step="any"
            value={amount}
            onChange={(event) => {
              setAmount(event.currentTarget.value);
              if (event.currentTarget.value.trim().length > 0) {
                setAmountTouched(true);
              }
              resetExecution();
            }}
            onBlur={() => setAmountTouched(true)}
            placeholder="1.00"
            className="h-12 rounded-2xl border-border-light bg-white px-4 shadow-none"
          />
        </div>
        <div className="space-y-2">
          <Select
            className="w-full"
            disabled={walletsLoading || assetOptions.length === 0}
            label="Asset"
            onValueChange={(value) => {
              if (value) {
                setSelectedAsset(value);
                resetExecution();
              }
            }}
            placeholder="Select asset"
            size="xl"
            value={selectedAsset || null}
          >
            {assetOptions.map((asset) => (
              <SelectItem key={asset} value={asset}>
                {asset}
              </SelectItem>
            ))}
          </Select>
        </div>
      </div>
      <p
        className={[
          "h-5 text-sm leading-5",
          amountTouched && exceedsSelectedAssetBalance
            ? "text-status-error-text"
            : "invisible text-transparent",
        ].join(" ")}
      >
        Insufficient {selectedAsset}. Available balance: {selectedAssetBalance?.uiAmount ?? "0"}{" "}
        {selectedAsset}.
      </p>
    </div>
  );

  const renderTransferDetailsStep = () => (
    <div className="space-y-6">
      {renderWalletSelect({
        label: "Source wallet",
        value: selectedWalletId,
        onChange: (value) => {
          setSelectedWalletId(value);
          setTransferCompliance(null);
          setTransferComplianceDismissed(false);
          resetExecution();
        },
      })}
      {renderAssetAndAmount("Amount")}
      <div className="space-y-2">
        <Label htmlFor={`${mode}-destination`}>Destination address</Label>
        <Input
          id={`${mode}-destination`}
          value={destination}
          onChange={(event) => {
            setDestination(event.currentTarget.value);
            setTransferCompliance(null);
            setTransferComplianceDismissed(false);
            resetExecution();
          }}
          placeholder="Destination Solana address"
          className="h-12 rounded-2xl border-border-light bg-white px-4 shadow-none"
        />
      </div>
      {destinationIsAllowlisted ? (
        <div className="rounded-2xl border border-status-success-border bg-status-success-bg px-4 py-3 text-sm text-status-success-text">
          This destination is already on the source wallet allowlist. You can continue without a new
          risk check.
        </div>
      ) : !hasEnabledComplianceProviders ? (
        <div className="rounded-2xl border border-status-warning-border bg-status-warning-bg px-4 py-3 text-sm text-status-warning-text">
          Risk checks are not enabled for this organization. Add the destination to the source
          wallet allowlist before submitting the transfer.
        </div>
      ) : (
        <div className="flex min-h-[44px] flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void checkTransferCompliance();
            }}
            disabled={
              policyLoading || transferComplianceLoading || !selectedWalletId || !destinationTrimmed
            }
          >
            Run a risk check
          </Button>
        </div>
      )}
      {policyError ? <p className="text-sm text-status-error-text">{policyError}</p> : null}
      {transferCompliance && !transferComplianceDismissed ? (
        <ProviderRiskTable
          title="Risk score results"
          snapshot={transferCompliance}
          onClose={() => setTransferComplianceDismissed(true)}
        />
      ) : null}
      <div className="space-y-2">
        <Label htmlFor={`${mode}-memo`}>Memo (optional)</Label>
        <Input
          id={`${mode}-memo`}
          value={memo}
          onChange={(event) => {
            setMemo(event.currentTarget.value);
            resetExecution();
          }}
          placeholder="Invoice #1234"
          className="h-12 rounded-2xl border-border-light bg-white px-4 shadow-none"
        />
      </div>
    </div>
  );

  const renderDepositDetailsStep = () => (
    <div className="space-y-6">
      {renderWalletSelect({
        label: "Wallet",
        value: selectedWalletId,
        onChange: (value) => {
          setSelectedWalletId(value);
          resetExecution();
        },
      })}
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_160px]">
        <div className="space-y-2">
          <Label htmlFor={`${mode}-reference`}>Reference label</Label>
          <Input
            id={`${mode}-reference`}
            value={reference}
            onChange={(event) => setReference(event.currentTarget.value)}
            placeholder="Treasury top-up"
            className="h-12 rounded-2xl border-border-light bg-white px-4 shadow-none"
          />
        </div>
        <div className="space-y-2">
          <Select
            className="w-full"
            disabled={assetOptions.length === 0}
            label="Asset"
            onValueChange={(value) => {
              if (value) {
                setSelectedAsset(value);
              }
            }}
            placeholder="Select asset"
            size="xl"
            value={selectedAsset || null}
          >
            {assetOptions.map((asset) => (
              <SelectItem key={asset} value={asset}>
                {asset}
              </SelectItem>
            ))}
          </Select>
        </div>
      </div>
    </div>
  );

  const renderRampDetailsStep = () => {
    if (!provider) {
      return null;
    }

    const shouldShowWalletSelect = !(provider === "lightspark" && isOfframpBranch);
    const walletLabel = isOnrampBranch ? "Destination wallet" : "Source wallet";

    return (
      <div className="space-y-6">
        {shouldShowWalletSelect
          ? renderWalletSelect({
              label: walletLabel,
              value: selectedWalletId,
              onChange: (value) => {
                setSelectedWalletId(value);
                resetExecution();
              },
            })
          : null}

        {renderAssetAndAmount(isOnrampBranch ? "Fiat amount (USD)" : "Crypto amount")}

        <RampProviderFields
          mode={mode}
          provider={provider}
          isOnrampBranch={isOnrampBranch}
          isBelowMoonPayOnrampMinimum={isBelowMoonPayOnrampMinimum}
          selectedWallet={selectedWallet}
          customerId={customerId}
          setCustomerId={setCustomerId}
          lightsparkSourceAccountId={lightsparkSourceAccountId}
          setLightsparkSourceAccountId={setLightsparkSourceAccountId}
          lightsparkDestinationAccountId={lightsparkDestinationAccountId}
          setLightsparkDestinationAccountId={setLightsparkDestinationAccountId}
          bvnkFirstName={bvnkFirstName}
          setBvnkFirstName={setBvnkFirstName}
          bvnkLastName={bvnkLastName}
          setBvnkLastName={setBvnkLastName}
          bvnkDateOfBirth={bvnkDateOfBirth}
          setBvnkDateOfBirth={setBvnkDateOfBirth}
          bvnkCountryCode={bvnkCountryCode}
          setBvnkCountryCode={setBvnkCountryCode}
          resetExecution={resetExecution}
        />
      </div>
    );
  };

  const renderTransferReview = () => {
    if (executionState === "submitting") {
      return (
        <div className="space-y-6 text-center">
          <div className="mx-auto flex size-16 items-center justify-center rounded-full border border-border-medium">
            <RefreshCw className="size-7 animate-spin text-text-medium" />
          </div>
          <div className="space-y-2">
            <p className="text-[18px] font-medium text-text-extra-high">Transfer in progress…</p>
            <p className="text-sm text-text-low">
              Submitting the transaction through the payments API.
            </p>
          </div>
          <ReviewSummaryCard rows={transferReviewRows} />
        </div>
      );
    }

    if (executionState === "success" && transferResult) {
      return (
        <div className="space-y-6">
          <div className="rounded-2xl border border-status-success-border bg-status-success-bg p-5">
            <p className="text-[20px] font-medium text-status-success-text">Transfer submitted</p>
            <p className="mt-2 text-sm text-status-success-text">
              {transferResult.signature
                ? "The transfer was signed and broadcast successfully. It will appear in the transaction list when you return to Payments."
                : `Current status: ${transferResult.status}`}
            </p>
          </div>
          <ReviewSummaryCard
            rows={[
              ...transferReviewRows,
              {
                label: "Status",
                value: transferResult.status,
              },
              {
                label: "Signature",
                value: transferResult.signature ? (
                  <a
                    href={getDevnetExplorerUrl(transferResult.signature)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-text-extra-high underline underline-offset-2"
                  >
                    <span className="max-w-[12rem] truncate font-mono text-xs">
                      {transferResult.signature}
                    </span>
                    <ExternalLink className="size-3" />
                  </a>
                ) : (
                  "Pending"
                ),
              },
            ]}
          />
        </div>
      );
    }

    return <ReviewSummaryCard rows={transferReviewRows} />;
  };

  const renderRampReview = () => {
    if (executionState === "submitting") {
      return (
        <div className="space-y-6 text-center">
          <div className="mx-auto flex size-16 items-center justify-center rounded-full border border-border-medium">
            <RefreshCw className="size-7 animate-spin text-text-medium" />
          </div>
          <div className="space-y-2">
            <p className="text-[18px] font-medium text-text-extra-high">
              {providerLabel ?? "Provider"} request in progress…
            </p>
            <p className="text-sm text-text-low">
              Preparing the {isOnrampBranch ? "on-ramp" : "off-ramp"} flow.
            </p>
          </div>
          <ReviewSummaryCard rows={rampReviewRows} />
        </div>
      );
    }

    if (executionState === "success" && rampExecution) {
      return (
        <div className="space-y-6">
          <div className="rounded-2xl border border-status-success-border bg-status-success-bg p-5">
            <p className="text-[20px] font-medium text-status-success-text">
              {providerLabel ?? "Provider"} flow ready
            </p>
            <p className="mt-2 text-sm text-status-success-text">
              Continue with the provider using the details below.
            </p>
          </div>
          <ReviewSummaryCard
            rows={[
              ...rampReviewRows,
              {
                label: "Status",
                value: rampExecution.status,
              },
              ...(rampExecution.reference
                ? [
                    {
                      label: "Reference",
                      value: <span className="font-mono text-xs">{rampExecution.reference}</span>,
                    },
                  ]
                : []),
            ]}
          />
          {rampExecution.redirectUrl ? (
            <div className="rounded-2xl border border-border-light bg-border-extra-light p-5">
              <p className="text-sm font-medium text-text-extra-high">Redirect URL</p>
              <p className="mt-3 break-all font-mono text-xs text-text-medium">
                {rampExecution.redirectUrl}
              </p>
              <div className="mt-4 flex justify-end">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    window.open(rampExecution.redirectUrl, "_blank", "noopener,noreferrer")
                  }
                >
                  Open {providerLabel ?? "provider"}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      );
    }

    return <ReviewSummaryCard rows={rampReviewRows} />;
  };

  const renderDepositStep = () => (
    <div className="space-y-6">
      <ReviewSummaryCard
        rows={[
          {
            label: "Wallet",
            value: selectedWallet?.label ?? selectedWallet?.walletId ?? "—",
          },
          {
            label: "Asset",
            value: selectedAsset || "—",
          },
          ...(reference.trim()
            ? [
                {
                  label: "Reference",
                  value: reference.trim(),
                },
              ]
            : []),
          {
            label: "Address",
            value: <span className="font-mono text-xs">{selectedWallet?.publicKey ?? "—"}</span>,
          },
        ]}
      />
      <WalletAddressQrCode address={selectedWallet?.publicKey ?? ""} />
    </div>
  );

  const renderCurrentStep = () => {
    if (currentStep.id === "branch") {
      return renderBranchStep();
    }

    if (currentStep.id === "provider") {
      return renderProviderStep();
    }

    if (currentStep.id === "details") {
      if (isTransferBranch) {
        return renderTransferDetailsStep();
      }

      if (isDepositBranch) {
        return renderDepositDetailsStep();
      }

      return renderRampDetailsStep();
    }

    if (currentStep.id === "deposit") {
      return renderDepositStep();
    }

    if (isTransferBranch) {
      return renderTransferReview();
    }

    return renderRampReview();
  };

  if (branch && !walletsLoading && !hasWallets) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 py-8">
        <div className="space-y-3 text-center">
          <p className="text-[44px] leading-none font-medium tracking-[-0.04em] text-text-extra-high">
            {isSendAction ? "Send" : "Receive"}
          </p>
          <p className="text-base text-text-low">
            You need at least one wallet before you can start this flow.
          </p>
          {liveWalletsError ? (
            <p className="text-sm text-status-error-text">{liveWalletsError}</p>
          ) : null}
        </div>
        <div className="mx-auto flex w-full max-w-md flex-col gap-3">
          <Button type="button" onClick={() => router.push("/dashboard/wallets")}>
            Go to wallets
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => router.push("/dashboard/payments")}
          >
            Back to payments
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 py-6">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        {currentStep.id === "branch" ? null : (
          <div className="text-center">
            <p className="text-[28px] leading-tight font-medium text-text-extra-high">
              {currentStep.title}
            </p>
          </div>
        )}

        {executionError ? (
          <div className="rounded-2xl border border-status-error-border bg-status-error-bg px-4 py-3 text-sm text-status-error-text">
            {executionError}
          </div>
        ) : null}

        {renderCurrentStep()}
      </div>

      {currentStep.id !== "branch" ? (
        <div
          className={`mx-auto flex w-full max-w-3xl flex-col gap-3 ${
            showPrimaryAction ? "sm:flex-row sm:justify-between" : "sm:flex-row sm:justify-start"
          }`}
        >
          <Button
            type="button"
            variant="secondary"
            className="h-14 rounded-full text-base"
            disabled={executionState === "submitting"}
            onClick={() => {
              void handleSecondaryAction();
            }}
          >
            {secondaryLabel}
          </Button>
          {showPrimaryAction ? (
            <Button
              type="button"
              className="h-14 rounded-full text-base"
              disabled={primaryDisabled}
              onClick={() => {
                void handlePrimaryAction();
              }}
            >
              {primaryLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
