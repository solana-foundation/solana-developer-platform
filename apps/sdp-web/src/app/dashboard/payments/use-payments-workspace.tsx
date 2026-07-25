"use client";

import type {
  PaymentTransferSummary as TransferRecord,
  PaymentWalletPolicy as WalletPolicy,
  PaymentsDashboardWallet as WalletRecord,
} from "@sdp/types";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "@/i18n/provider";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import { explorerTxUrl } from "@/lib/explorer";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import {
  createTransfer,
  fetchTransfers,
  fetchWalletPolicy,
  fetchWallets,
  runComplianceCheck,
  updateWalletPolicy,
} from "./payments-workspace.data";
import type { ComplianceSnapshot } from "./payments-workspace.types";

const PAYMENTS_WORKSPACE_WALLETS_KEY = "payments-workspace-wallets";
const PAYMENTS_WORKSPACE_TRANSFERS_KEY = "payments-workspace-transfers";
const PAYMENTS_WORKSPACE_WALLETS_CACHE_TTL_MS = 30_000;
const PAYMENTS_WORKSPACE_TRANSFERS_CACHE_TTL_MS = 20_000;

export interface DestinationAllowlistSectionState {
  walletId: string;
  setWalletId: (walletId: string) => void;
  address: string;
  setAddress: (address: string) => void;
  policyLoading: boolean;
  compliance: ComplianceSnapshot | null;
  complianceLoading: boolean;
  complianceDismissed: boolean;
  dismissCompliance: () => void;
  error: string | null;
  success: string | null;
  isSubmitting: boolean;
  canSubmit: boolean;
  checkCompliance: () => Promise<void>;
  submit: () => Promise<void>;
}

export interface TransferSectionState {
  source: string;
  setSource: (walletId: string) => void;
  destination: string;
  setDestination: (address: string) => void;
  token: string;
  setToken: (token: string) => void;
  amount: string;
  setAmount: (amount: string) => void;
  memo: string;
  setMemo: (memo: string) => void;
  compliance: ComplianceSnapshot | null;
  complianceLoading: boolean;
  complianceDismissed: boolean;
  dismissCompliance: () => void;
  allowlist: string[] | null;
  allowlistLoading: boolean;
  allowlistError: string | null;
  allowlistDismissed: boolean;
  dismissAllowlist: () => void;
  isSubmitting: boolean;
  canSubmit: boolean;
  checkCompliance: () => Promise<void>;
  loadAllowlist: () => Promise<void>;
  submit: () => Promise<void>;
}

export interface PaymentsWorkspaceState {
  recentTransfers: TransferRecord[];
  wallets: WalletRecord[];
  walletsLoading: boolean;
  walletsError: string | null;
  addAddressSection: DestinationAllowlistSectionState;
  transferSection: TransferSectionState;
}

export function usePaymentsWorkspace(): PaymentsWorkspaceState {
  const t = useTranslations();
  const cluster = useSolanaCluster();
  const {
    data: wallets = [],
    error: walletsFetchError,
    isLoading: walletsLoading,
    mutate: mutateWallets,
  } = usePersistedDashboardSWR<WalletRecord[]>(
    PAYMENTS_WORKSPACE_WALLETS_KEY,
    fetchWallets,
    {
      revalidateOnFocus: true,
      refreshInterval: 30_000,
    },
    {
      key: "payments.wallets.summary",
      ttlMs: PAYMENTS_WORKSPACE_WALLETS_CACHE_TTL_MS,
    }
  );
  const { data: recentTransfers = [], mutate: mutateTransfers } = usePersistedDashboardSWR<
    TransferRecord[]
  >(
    PAYMENTS_WORKSPACE_TRANSFERS_KEY,
    () => fetchTransfers({ pageSize: 20 }, t),
    {
      revalidateOnFocus: true,
      refreshInterval: 10_000,
    },
    {
      // Shared with payments-overview because both views read the same recent transfers endpoint.
      key: "payments.transfers.recent",
      ttlMs: PAYMENTS_WORKSPACE_TRANSFERS_CACHE_TTL_MS,
    }
  );

  const [addWalletId, setAddWalletIdState] = useState("");
  const [addAddress, setAddAddressState] = useState("");
  const [addPolicy, setAddPolicy] = useState<WalletPolicy | null>(null);
  const [addPolicyLoading, setAddPolicyLoading] = useState(false);
  const [addCompliance, setAddCompliance] = useState<ComplianceSnapshot | null>(null);
  const [addComplianceLoading, setAddComplianceLoading] = useState(false);
  const [addComplianceDismissed, setAddComplianceDismissed] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSuccess, setAddSuccess] = useState<string | null>(null);
  const [isAddingAddress, setIsAddingAddress] = useState(false);

  const [transferSource, setTransferSourceState] = useState("");
  const [transferDestination, setTransferDestinationState] = useState("");
  const [transferToken, setTransferToken] = useState("SOL");
  const [transferAmount, setTransferAmount] = useState("");
  const [transferMemo, setTransferMemo] = useState("");
  const [transferCompliance, setTransferCompliance] = useState<ComplianceSnapshot | null>(null);
  const [transferComplianceLoading, setTransferComplianceLoading] = useState(false);
  const [transferComplianceDismissed, setTransferComplianceDismissed] = useState(false);
  const [transferPolicyAllowlist, setTransferPolicyAllowlist] = useState<string[]>([]);
  const [transferAllowlist, setTransferAllowlist] = useState<string[] | null>(null);
  const [transferAllowlistLoading, setTransferAllowlistLoading] = useState(false);
  const [transferAllowlistError, setTransferAllowlistError] = useState<string | null>(null);
  const [transferAllowlistDismissed, setTransferAllowlistDismissed] = useState(false);
  const [isSubmittingTransfer, setIsSubmittingTransfer] = useState(false);

  const walletsError =
    walletsFetchError instanceof Error
      ? walletsFetchError.message
      : walletsFetchError
        ? t("DashboardPayments.workspace.walletsLoadFailed")
        : null;

  useEffect(() => {
    if (wallets.length === 0) {
      setAddWalletIdState("");
      setTransferSourceState("");
      return;
    }

    if (!addWalletId) {
      setAddWalletIdState(wallets[0]?.walletId ?? "");
    }
    if (!transferSource) {
      setTransferSourceState(wallets[0]?.walletId ?? "");
    }
  }, [wallets, addWalletId, transferSource]);

  useEffect(() => {
    if (!addWalletId) {
      setAddPolicy(null);
      return;
    }

    const loadPolicy = async () => {
      setAddPolicyLoading(true);
      setAddError(null);
      try {
        setAddPolicy(await fetchWalletPolicy(addWalletId, t));
      } catch (error) {
        setAddError(
          error instanceof Error
            ? error.message
            : t("DashboardPayments.workspace.walletPolicyLoadFailed")
        );
        setAddPolicy(null);
      } finally {
        setAddPolicyLoading(false);
      }
    };

    void loadPolicy();
  }, [addWalletId, t]);

  useEffect(() => {
    if (!transferSource) {
      setTransferPolicyAllowlist([]);
      return;
    }

    const loadTransferPolicy = async () => {
      try {
        const policy = await fetchWalletPolicy(transferSource, t);
        setTransferPolicyAllowlist(policy.destinationAllowlist);
      } catch {
        setTransferPolicyAllowlist([]);
      }
    };

    void loadTransferPolicy();
  }, [transferSource, t]);

  const addAddressTrimmed = addAddress.trim();
  const transferDestinationTrimmed = transferDestination.trim();
  const transferHasComplianceForDestination =
    !!transferCompliance &&
    transferCompliance.address === transferDestinationTrimmed &&
    transferCompliance.providers.length > 0;
  const transferDestinationIsAllowlisted =
    !!transferDestinationTrimmed && transferPolicyAllowlist.includes(transferDestinationTrimmed);
  const allowlistAddresses = addPolicy?.destinationAllowlist ?? [];
  const canAddAddress =
    !!addWalletId &&
    !!addAddressTrimmed &&
    !!addCompliance &&
    addCompliance.address === addAddressTrimmed &&
    addCompliance.providers.length > 0;
  const canSubmitTransfer =
    !!transferSource &&
    !!transferDestinationTrimmed &&
    !!transferAmount.trim() &&
    (transferHasComplianceForDestination || transferDestinationIsAllowlisted);

  const setAddWalletId = (walletId: string) => {
    setAddWalletIdState(walletId);
    setAddCompliance(null);
    setAddComplianceDismissed(false);
    setAddSuccess(null);
  };

  const setAddAddress = (address: string) => {
    setAddAddressState(address);
    setAddCompliance(null);
    setAddComplianceDismissed(false);
  };

  const setTransferSource = (walletId: string) => {
    setTransferSourceState(walletId);
    setTransferAllowlist(null);
    setTransferAllowlistError(null);
    setTransferAllowlistDismissed(false);
  };

  const setTransferDestination = (address: string) => {
    setTransferDestinationState(address);
    setTransferCompliance(null);
    setTransferComplianceDismissed(false);
  };

  const checkAddAddressCompliance = async () => {
    if (!addAddressTrimmed) {
      setAddError(t("DashboardPayments.workspace.addressRequired"));
      return;
    }

    setAddComplianceLoading(true);
    setAddComplianceDismissed(false);
    setAddError(null);
    setAddSuccess(null);
    try {
      setAddCompliance(await runComplianceCheck(addAddressTrimmed, "wallet_address_addition"));
    } catch (error) {
      setAddCompliance(null);
      setAddError(
        error instanceof Error
          ? error.message
          : t("DashboardPayments.workspace.complianceCheckFailed")
      );
    } finally {
      setAddComplianceLoading(false);
    }
  };

  const addDestinationAddress = async () => {
    if (!canAddAddress || !addPolicy) {
      setAddError(t("DashboardPayments.workspace.complianceCheckRequired"));
      return;
    }

    if (allowlistAddresses.includes(addAddressTrimmed)) {
      setAddSuccess(t("DashboardPayments.workspace.addressAlreadyAllowlisted"));
      return;
    }

    setIsAddingAddress(true);
    setAddError(null);
    setAddSuccess(null);
    try {
      const updated = await updateWalletPolicy(
        addWalletId,
        {
          ...addPolicy,
          destinationAllowlist: [...allowlistAddresses, addAddressTrimmed],
        },
        t
      );
      setAddPolicy(updated);
      void mutateWallets();
      if (addWalletId === transferSource) {
        setTransferPolicyAllowlist(updated.destinationAllowlist);
      }
      setAddSuccess(t("DashboardPayments.workspace.addressAddedToAllowlist"));
    } catch (error) {
      setAddError(
        error instanceof Error
          ? error.message
          : t("DashboardPayments.workspace.destinationAddressAddFailed")
      );
    } finally {
      setIsAddingAddress(false);
    }
  };

  const checkTransferCompliance = async () => {
    if (!transferDestinationTrimmed) {
      toast.error(t("DashboardPayments.workspace.complianceCheckFailed"), {
        description: t("DashboardPayments.workspace.destinationRequired"),
        position: "bottom-right",
      });
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
      toast.error(t("DashboardPayments.workspace.complianceCheckFailed"), {
        description:
          error instanceof Error
            ? error.message
            : t("DashboardPayments.workspace.complianceCheckFailed"),
        position: "bottom-right",
      });
    } finally {
      setTransferComplianceLoading(false);
    }
  };

  const submitTransfer = async () => {
    if (!canSubmitTransfer) {
      toast.error(t("DashboardPayments.workspace.transferBlocked"), {
        description: t("DashboardPayments.workspace.transferBlockedDescription"),
        position: "bottom-right",
      });
      return;
    }

    setIsSubmittingTransfer(true);
    const toastId = toast.loading(t("DashboardPayments.onchainSend.submittingTransfer"), {
      position: "bottom-right",
    });
    try {
      const transfer = await createTransfer(
        {
          source: transferSource,
          destination: transferDestinationTrimmed,
          token: transferToken.trim() || "SOL",
          amount: transferAmount.trim(),
          memo: transferMemo.trim() || undefined,
        },
        t
      );
      await mutateTransfers(
        (current) =>
          [transfer, ...(current ?? []).filter((entry) => entry.id !== transfer.id)].slice(0, 20),
        {
          revalidate: false,
        }
      );
      void mutateTransfers();
      void mutateWallets();

      if (transfer.signature) {
        toast.success(t("DashboardPayments.onchainSend.transferSubmitted"), {
          id: toastId,
          description: (
            <span>
              {t("DashboardPayments.workspace.transactionSent")}{" "}
              <a
                href={explorerTxUrl(transfer.signature, cluster)}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                {t("DashboardPayments.workspace.viewOnSolanaExplorer")}
              </a>
            </span>
          ),
          position: "bottom-right",
        });
      } else {
        toast.success(t("DashboardPayments.onchainSend.transferSubmitted"), {
          id: toastId,
          description: t("DashboardPayments.onchainSend.transferStatus", {
            status: transfer.status,
          }),
          position: "bottom-right",
        });
      }
    } catch (error) {
      toast.error(t("DashboardPayments.onchainSend.transferFailed"), {
        id: toastId,
        description:
          error instanceof Error
            ? error.message
            : t("DashboardPayments.onchainSend.transferFailed"),
        position: "bottom-right",
      });
    } finally {
      setIsSubmittingTransfer(false);
    }
  };

  const loadTransferAllowlist = async () => {
    if (!transferSource) {
      setTransferAllowlistError(t("DashboardPayments.workspace.sourceWalletRequired"));
      return;
    }

    setTransferAllowlistLoading(true);
    setTransferAllowlistDismissed(false);
    setTransferAllowlistError(null);
    try {
      const policy = await fetchWalletPolicy(transferSource, t);
      setTransferPolicyAllowlist(policy.destinationAllowlist);
      setTransferAllowlist(policy.destinationAllowlist);
    } catch (error) {
      setTransferAllowlist(null);
      setTransferAllowlistError(
        error instanceof Error
          ? error.message
          : t("DashboardPayments.workspace.destinationAllowlistLoadFailed")
      );
    } finally {
      setTransferAllowlistLoading(false);
    }
  };

  return {
    recentTransfers,
    wallets,
    walletsLoading,
    walletsError,
    addAddressSection: {
      walletId: addWalletId,
      setWalletId: setAddWalletId,
      address: addAddress,
      setAddress: setAddAddress,
      policyLoading: addPolicyLoading,
      compliance: addCompliance,
      complianceLoading: addComplianceLoading,
      complianceDismissed: addComplianceDismissed,
      dismissCompliance: () => setAddComplianceDismissed(true),
      error: addError,
      success: addSuccess,
      isSubmitting: isAddingAddress,
      canSubmit: canAddAddress,
      checkCompliance: checkAddAddressCompliance,
      submit: addDestinationAddress,
    },
    transferSection: {
      source: transferSource,
      setSource: setTransferSource,
      destination: transferDestination,
      setDestination: setTransferDestination,
      token: transferToken,
      setToken: setTransferToken,
      amount: transferAmount,
      setAmount: setTransferAmount,
      memo: transferMemo,
      setMemo: setTransferMemo,
      compliance: transferCompliance,
      complianceLoading: transferComplianceLoading,
      complianceDismissed: transferComplianceDismissed,
      dismissCompliance: () => setTransferComplianceDismissed(true),
      allowlist: transferAllowlist,
      allowlistLoading: transferAllowlistLoading,
      allowlistError: transferAllowlistError,
      allowlistDismissed: transferAllowlistDismissed,
      dismissAllowlist: () => setTransferAllowlistDismissed(true),
      isSubmitting: isSubmittingTransfer,
      canSubmit: canSubmitTransfer,
      checkCompliance: checkTransferCompliance,
      loadAllowlist: loadTransferAllowlist,
      submit: submitTransfer,
    },
  };
}
