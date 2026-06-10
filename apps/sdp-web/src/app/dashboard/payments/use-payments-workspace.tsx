"use client";

import type {
  PaymentTransferSummary as TransferRecord,
  PaymentWalletPolicy as WalletPolicy,
  PaymentsDashboardWallet as WalletRecord,
} from "@sdp/types";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import {
  createTransfer,
  fetchTransfers,
  fetchWalletPolicy,
  fetchWallets,
  getDevnetExplorerUrl,
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
    () => fetchTransfers({ pageSize: 20 }),
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
        ? "Failed to load wallets."
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
        setAddPolicy(await fetchWalletPolicy(addWalletId));
      } catch (error) {
        setAddError(error instanceof Error ? error.message : "Failed to load wallet policy.");
        setAddPolicy(null);
      } finally {
        setAddPolicyLoading(false);
      }
    };

    void loadPolicy();
  }, [addWalletId]);

  useEffect(() => {
    if (!transferSource) {
      setTransferPolicyAllowlist([]);
      return;
    }

    const loadTransferPolicy = async () => {
      try {
        const policy = await fetchWalletPolicy(transferSource);
        setTransferPolicyAllowlist(policy.destinationAllowlist);
      } catch {
        setTransferPolicyAllowlist([]);
      }
    };

    void loadTransferPolicy();
  }, [transferSource]);

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
      setAddError("Address is required.");
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
      setAddError(error instanceof Error ? error.message : "Compliance check failed.");
    } finally {
      setAddComplianceLoading(false);
    }
  };

  const addDestinationAddress = async () => {
    if (!canAddAddress || !addPolicy) {
      setAddError("Run compliance check before adding the address.");
      return;
    }

    if (allowlistAddresses.includes(addAddressTrimmed)) {
      setAddSuccess("Address is already in the destination allowlist.");
      return;
    }

    setIsAddingAddress(true);
    setAddError(null);
    setAddSuccess(null);
    try {
      const updated = await updateWalletPolicy(addWalletId, {
        ...addPolicy,
        destinationAllowlist: [...allowlistAddresses, addAddressTrimmed],
      });
      setAddPolicy(updated);
      void mutateWallets();
      if (addWalletId === transferSource) {
        setTransferPolicyAllowlist(updated.destinationAllowlist);
      }
      setAddSuccess("Address added to wallet destination allowlist.");
    } catch (error) {
      setAddError(error instanceof Error ? error.message : "Failed to add destination address.");
    } finally {
      setIsAddingAddress(false);
    }
  };

  const checkTransferCompliance = async () => {
    if (!transferDestinationTrimmed) {
      toast.error("Compliance check failed.", {
        description: "Destination address is required.",
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
      toast.error("Compliance check failed.", {
        description: error instanceof Error ? error.message : "Compliance check failed.",
        position: "bottom-right",
      });
    } finally {
      setTransferComplianceLoading(false);
    }
  };

  const submitTransfer = async () => {
    if (!canSubmitTransfer) {
      toast.error("Transfer blocked.", {
        description:
          "Run compliance check or use a destination already in the source wallet allowlist.",
        position: "bottom-right",
      });
      return;
    }

    setIsSubmittingTransfer(true);
    const toastId = toast.loading("Submitting transfer.", {
      position: "bottom-right",
    });
    try {
      const transfer = await createTransfer({
        source: transferSource,
        destination: transferDestinationTrimmed,
        token: transferToken.trim() || "SOL",
        amount: transferAmount.trim(),
        memo: transferMemo.trim() || undefined,
      });
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
        toast.success("Transfer submitted.", {
          id: toastId,
          description: (
            <span>
              Transaction sent.{" "}
              <a
                href={getDevnetExplorerUrl(transfer.signature)}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                View on Solana Explorer
              </a>
            </span>
          ),
          position: "bottom-right",
        });
      } else {
        toast.success("Transfer submitted.", {
          id: toastId,
          description: `Status: ${transfer.status}`,
          position: "bottom-right",
        });
      }
    } catch (error) {
      toast.error("Transfer failed.", {
        id: toastId,
        description: error instanceof Error ? error.message : "Transfer failed.",
        position: "bottom-right",
      });
    } finally {
      setIsSubmittingTransfer(false);
    }
  };

  const loadTransferAllowlist = async () => {
    if (!transferSource) {
      setTransferAllowlistError("Select a source wallet first.");
      return;
    }

    setTransferAllowlistLoading(true);
    setTransferAllowlistDismissed(false);
    setTransferAllowlistError(null);
    try {
      const policy = await fetchWalletPolicy(transferSource);
      setTransferPolicyAllowlist(policy.destinationAllowlist);
      setTransferAllowlist(policy.destinationAllowlist);
    } catch (error) {
      setTransferAllowlist(null);
      setTransferAllowlistError(
        error instanceof Error ? error.message : "Failed to load destination allowlist."
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
