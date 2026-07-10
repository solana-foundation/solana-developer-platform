"use client";

import type { PaymentsDashboardWallet, Token } from "@sdp/types";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import { getTokenAccessControlMode, hasAccessControlList } from "../../access-control.utils";
import type { FundManagementModalAction } from "../token-fund-management-section";
import {
  fetchTokenAuthorityWallets,
  fetchTokenManagementSupportingData,
  type TokenManagementSupportingData,
} from "../token-management-workspace.data";
import type {
  ActionExecutionInput,
  AdminAction,
  PermissionRow,
  RunActionOptions,
} from "../token-management-workspace.types";
import {
  asOptionalString,
  createInitialAllowlistForm,
  createInitialAuthorityForm,
  createInitialBurnForm,
  createInitialForceBurnForm,
  createInitialFreezeForm,
  createInitialMintForm,
  createInitialSeizeForm,
  findWalletByWalletId,
  getBurnValidationErrors,
  getBurnValidationReason,
  getControlListCopy,
  getDisplayedAuthorityAddress,
  getExplorerHref,
  getExtensionRows,
  getForceBurnValidationErrors,
  getForceBurnValidationReason,
  getMintValidationErrors,
  getMintValidationReason,
  getPermissionRows,
  getSeizeValidationErrors,
  getSeizeValidationReason,
  getSignerSelectionForAction,
  getTokenActionDisabledReasons,
  isPositiveAmount,
  resolveAuthorityAddressForRole,
} from "../token-management-workspace.utils";
import { useTokenActionRunner } from "../use-token-action-runner";

// Same cache keys and TTLs as the old TokenManagementWorkspace, so the two UIs
// share warm caches for a given token.
const TOKEN_AUTHORITY_WALLETS_CACHE_TTL_MS = 60_000;
const TOKEN_SUPPORTING_DATA_CACHE_TTL_MS = 60_000;

const EMPTY_SUPPORTING_DATA: TokenManagementSupportingData = {
  authorityWallets: [],
  authorityWalletsError: null,
  transactions: [],
  transactionsError: null,
  transactionsTotal: null,
  transactionsHasMore: false,
  allowlistEntries: [],
  allowlistError: null,
  allowlistTotal: null,
  allowlistHasMore: false,
  frozenAccounts: [],
  frozenAccountsError: null,
  frozenAccountsTotal: null,
  frozenAccountsHasMore: false,
};

function mergeWalletsPreferBalances(
  primaryWallets: PaymentsDashboardWallet[],
  secondaryWallets: PaymentsDashboardWallet[]
): PaymentsDashboardWallet[] {
  if (primaryWallets.length === 0) {
    return secondaryWallets;
  }
  if (secondaryWallets.length === 0) {
    return primaryWallets;
  }

  const secondaryById = new Map(secondaryWallets.map((wallet) => [wallet.id, wallet]));
  const merged = primaryWallets.map((wallet) => {
    const richerWallet = secondaryById.get(wallet.id);
    if (!richerWallet) {
      return wallet;
    }
    return Array.isArray(richerWallet.balances)
      ? { ...wallet, balances: richerWallet.balances }
      : wallet;
  });

  const primaryIds = new Set(primaryWallets.map((wallet) => wallet.id));
  for (const wallet of secondaryWallets) {
    if (!primaryIds.has(wallet.id)) {
      merged.push(wallet);
    }
  }
  return merged;
}

/**
 * The operational core of token management (deploy, mint, burn, seize,
 * force-burn, authorities, pause, freeze, allowlist, supply refresh) for the
 * asset-profile workspace. Mirrors the handler wiring of the legacy
 * TokenManagementWorkspace against the same API endpoints and shared utils —
 * the monolith itself is intentionally untouched.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: mirrors the legacy workspace's centralized action orchestration.
export function useTokenOperations({
  token,
  shouldLoadSupportingData,
  shouldLoadAuthorityWallets,
  canManageTokenAdmin,
}: {
  token: Token;
  shouldLoadSupportingData: boolean;
  shouldLoadAuthorityWallets: boolean;
  canManageTokenAdmin: boolean;
}) {
  const {
    isPending,
    actionConfirmation,
    runAction: runActionBase,
    runActionImmediately: runActionImmediatelyBase,
    dismissActionConfirmation,
    confirmAction,
  } = useTokenActionRunner();

  const [authorityModalRow, setAuthorityModalRow] = useState<PermissionRow | null>(null);
  const [authorityModalCurrentAuthority, setAuthorityModalCurrentAuthority] = useState<
    string | null
  >(null);
  const [authorityModalNewAuthority, setAuthorityModalNewAuthority] = useState("");
  const [authorityModalSignerWalletId, setAuthorityModalSignerWalletId] = useState("");
  const [fundManagementModalAction, setFundManagementModalAction] =
    useState<FundManagementModalAction | null>(null);
  const [deploySignerWalletId, setDeploySignerWalletId] = useState("");
  const [mintForm, setMintForm] = useState(createInitialMintForm);
  const [burnForm, setBurnForm] = useState(createInitialBurnForm);
  const [seizeForm, setSeizeForm] = useState(createInitialSeizeForm);
  const [forceBurnForm, setForceBurnForm] = useState(createInitialForceBurnForm);
  const [authorityForm, setAuthorityForm] = useState(createInitialAuthorityForm);
  const [freezeForm, setFreezeForm] = useState(createInitialFreezeForm);
  const [allowlistForm, setAllowlistForm] = useState(createInitialAllowlistForm);

  const accessControlMode = getTokenAccessControlMode(token);
  const controlListCopy = getControlListCopy(accessControlMode);
  const showControlList = hasAccessControlList(accessControlMode);

  const {
    data: authorityWalletsData,
    error: authorityWalletsRequestError,
    mutate: mutateAuthorityWallets,
  } = usePersistedDashboardSWR(
    shouldLoadAuthorityWallets ? ["token-management-authority-wallets", token.id] : null,
    ([, tokenId]: readonly [string, string]) => fetchTokenAuthorityWallets(tokenId),
    {
      refreshInterval: 60_000,
      revalidateOnFocus: true,
      revalidateIfStale: true,
    },
    {
      key: `token.${token.id}.authority-wallets`,
      ttlMs: TOKEN_AUTHORITY_WALLETS_CACHE_TTL_MS,
    }
  );
  const {
    data: supportingData,
    error: supportingDataRequestError,
    mutate: mutateSupportingData,
  } = usePersistedDashboardSWR(
    shouldLoadSupportingData ? ["token-management-supporting-data", token.id] : null,
    ([, tokenId]: readonly [string, string]) => fetchTokenManagementSupportingData(tokenId),
    {
      refreshInterval: 60_000,
      revalidateOnFocus: true,
      revalidateIfStale: true,
    },
    {
      key: `token.${token.id}.supporting-data`,
      ttlMs: TOKEN_SUPPORTING_DATA_CACHE_TTL_MS,
    }
  );

  const supportingDataError = supportingDataRequestError
    ? supportingDataRequestError instanceof Error
      ? supportingDataRequestError.message
      : "Unable to load token management data."
    : null;
  const supportingDataLoading =
    shouldLoadSupportingData && supportingData === undefined && !supportingDataError;
  const resolvedSupportingData = supportingData ?? EMPTY_SUPPORTING_DATA;
  const authorityWalletsFetchError = authorityWalletsRequestError
    ? authorityWalletsRequestError instanceof Error
      ? authorityWalletsRequestError.message
      : "Unable to load signer wallets."
    : null;
  const authorityWalletsLoading =
    shouldLoadAuthorityWallets && authorityWalletsData === undefined && !authorityWalletsFetchError;

  const revalidateAfterSuccess = async () => {
    if (shouldLoadAuthorityWallets) {
      await mutateAuthorityWallets();
    }
    if (shouldLoadSupportingData) {
      await mutateSupportingData();
    }
  };
  const runAction = (input: ActionExecutionInput, options: RunActionOptions = {}) =>
    runActionBase(input, {
      ...options,
      onSuccess: async (result) => {
        await options.onSuccess?.(result);
        await revalidateAfterSuccess();
      },
    });
  const runActionImmediately = (input: ActionExecutionInput, options: RunActionOptions = {}) =>
    runActionImmediatelyBase(input, {
      ...options,
      onSuccess: async (result) => {
        await options.onSuccess?.(result);
        await revalidateAfterSuccess();
      },
    });

  const authorityWallets = mergeWalletsPreferBalances(
    authorityWalletsData?.authorityWallets ?? [],
    resolvedSupportingData.authorityWallets
  );
  const authorityWalletsError =
    authorityWalletsFetchError ??
    authorityWalletsData?.authorityWalletsError ??
    supportingDataError ??
    resolvedSupportingData.authorityWalletsError;
  const transactions = resolvedSupportingData.transactions;
  const transactionsError = supportingDataError ?? resolvedSupportingData.transactionsError;
  const transactionsTotal = resolvedSupportingData.transactionsTotal;
  const transactionsHasMore = resolvedSupportingData.transactionsHasMore;
  const allowlistEntries = resolvedSupportingData.allowlistEntries;
  const allowlistError = supportingDataError ?? resolvedSupportingData.allowlistError;
  const allowlistTotal = resolvedSupportingData.allowlistTotal;
  const allowlistHasMore = resolvedSupportingData.allowlistHasMore;
  const frozenAccounts = resolvedSupportingData.frozenAccounts;
  const frozenAccountsError = supportingDataError ?? resolvedSupportingData.frozenAccountsError;
  const frozenAccountsTotal = resolvedSupportingData.frozenAccountsTotal;
  const frozenAccountsHasMore = resolvedSupportingData.frozenAccountsHasMore;

  const tokenBasePath = `/v1/issuance/tokens/${token.id}`;
  const explorerHref = getExplorerHref(token.mintAddress);
  const canDeployToken = token.status === "pending" && !token.mintAddress;
  const {
    mintDisabledReason,
    burnDisabledReason,
    seizeDisabledReason,
    forceBurnDisabledReason,
    pauseDisabledReason,
    freezeDisabledReason,
  } = getTokenActionDisabledReasons(token);
  const metadataAuthority = token.metadataAuthority ?? token.mintAuthority;

  const withWalletLoadError = <T extends { unavailableReason: string | null }>(selection: T): T => {
    if (authorityWalletsLoading && selection.unavailableReason) {
      return { ...selection, unavailableReason: "Loading signer wallets…" };
    }
    if (authorityWalletsError && selection.unavailableReason) {
      return { ...selection, unavailableReason: authorityWalletsError };
    }
    return selection;
  };
  const signerSelectionFor = (
    action: Parameters<typeof getSignerSelectionForAction>[0]["action"]
  ) =>
    withWalletLoadError(
      getSignerSelectionForAction({ action, token, authorityWallets, metadataAuthority })
    );
  const deploySignerSelection = signerSelectionFor("deploy");
  const mintSignerSelection = signerSelectionFor("mint");
  const burnSignerSelection = signerSelectionFor("burn");
  const seizeSignerSelection = signerSelectionFor("seize");
  const forceBurnSignerSelection = signerSelectionFor("force-burn");
  const freezeSignerSelection = signerSelectionFor("freeze");
  const pauseSignerSelection = signerSelectionFor("pause");

  const permissionRows = getPermissionRows(token, metadataAuthority).map((row) => {
    const displayedAuthorityAddress = getDisplayedAuthorityAddress({
      token,
      role: row.authorityRole,
      metadataAuthority,
      authorityWallets,
    });
    const rowWithDisplayedValue = { ...row, value: displayedAuthorityAddress };

    return {
      ...rowWithDisplayedValue,
      editDisabledReason: canManageTokenAdmin
        ? withWalletLoadError(
            getSignerSelectionForAction({
              action: "authority",
              token,
              authorityWallets,
              metadataAuthority,
              permissionRow: rowWithDisplayedValue,
            })
          ).unavailableReason
        : "Only admins can edit token authorities.",
    };
  });
  const displayedMintAuthority = getDisplayedAuthorityAddress({
    token,
    role: "mint",
    metadataAuthority,
    authorityWallets,
  });
  const extensionRows = useMemo(() => getExtensionRows(token), [token]);

  const effectiveMintDisabledReason = mintDisabledReason ?? mintSignerSelection.unavailableReason;
  const effectiveBurnDisabledReason = burnDisabledReason ?? burnSignerSelection.unavailableReason;
  const effectiveSeizeDisabledReason =
    seizeDisabledReason ?? seizeSignerSelection.unavailableReason;
  const effectiveForceBurnDisabledReason =
    forceBurnDisabledReason ?? forceBurnSignerSelection.unavailableReason;
  const effectiveFreezeDisabledReason =
    freezeDisabledReason ?? freezeSignerSelection.unavailableReason;
  const effectivePauseDisabledReason =
    pauseDisabledReason ?? pauseSignerSelection.unavailableReason;

  const selectedBurnSignerWallet =
    findWalletByWalletId(
      burnSignerSelection.wallets,
      burnForm.signingWalletId || burnSignerSelection.defaultWalletId
    ) ??
    burnSignerSelection.wallets[0] ??
    null;
  const mintValidationReason = getMintValidationReason({
    token,
    destination: mintForm.destination,
    amount: mintForm.amount,
    allowlistEntries,
  });
  const mintValidationErrors = getMintValidationErrors({
    token,
    destination: mintForm.destination,
    amount: mintForm.amount,
    allowlistEntries,
  });
  const burnValidationReason = getBurnValidationReason({
    token,
    source: burnForm.source,
    amount: burnForm.amount,
    signerWallet: selectedBurnSignerWallet,
    walletOptions: authorityWallets,
  });
  const burnValidationErrors = getBurnValidationErrors({
    token,
    source: burnForm.source,
    amount: burnForm.amount,
    signerWallet: selectedBurnSignerWallet,
    walletOptions: authorityWallets,
  });
  const seizeValidationReason = getSeizeValidationReason({
    token,
    source: seizeForm.source,
    destination: seizeForm.destination,
    amount: seizeForm.amount,
    allowlistEntries,
    walletOptions: authorityWallets,
  });
  const seizeValidationErrors = getSeizeValidationErrors({
    token,
    source: seizeForm.source,
    destination: seizeForm.destination,
    amount: seizeForm.amount,
    allowlistEntries,
    walletOptions: authorityWallets,
  });
  const forceBurnValidationReason = getForceBurnValidationReason({
    token,
    source: forceBurnForm.source,
    amount: forceBurnForm.amount,
    walletOptions: authorityWallets,
  });
  const forceBurnValidationErrors = getForceBurnValidationErrors({
    token,
    source: forceBurnForm.source,
    amount: forceBurnForm.amount,
    walletOptions: authorityWallets,
  });

  const fundManagementDisabledReasons: Record<FundManagementModalAction, string | null> = {
    deploy: deploySignerSelection.unavailableReason,
    mint: effectiveMintDisabledReason ?? mintValidationReason,
    burn: effectiveBurnDisabledReason ?? burnValidationReason,
  };
  const complianceActionDisabledReasons: Partial<Record<AdminAction, string | null>> = {
    seize: effectiveSeizeDisabledReason ?? seizeValidationReason,
    "force-burn": effectiveForceBurnDisabledReason ?? forceBurnValidationReason,
    freeze: effectiveFreezeDisabledReason,
    pause: effectivePauseDisabledReason,
  };

  const handleCopy = async (value: string | null, successMessage = "Copied") => {
    if (!value) {
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      toast.success(successMessage);
    } catch {
      toast.error("Unable to copy");
    }
  };

  const handleDeploy = () => {
    runAction(
      {
        label: "Deploy token",
        method: "POST",
        path: `${tokenBasePath}/deploy`,
        body: {
          signingWalletId: deploySignerWalletId || undefined,
        },
      },
      {
        requiresConfirmation: true,
        confirmationTitle: "Deploy token?",
        confirmationDescription: "This will submit the deploy transaction on-chain.",
        confirmButtonLabel: "Deploy now",
        submitToast: "Submitting deploy transaction...",
        successToast: "Deploy transaction finalized.",
      }
    );
  };

  const handleRefreshSupply = () => {
    runAction({
      label: "Refresh supply",
      method: "POST",
      path: `${tokenBasePath}/supply/refresh`,
      body: {},
    });
  };

  const handleMint = () => {
    if (effectiveMintDisabledReason) {
      toast.error(effectiveMintDisabledReason);
      return;
    }

    const destination = mintForm.destination.trim();
    const amount = mintForm.amount.trim();
    if (!destination || !amount) {
      toast.error("Mint destination and amount are required.");
      return;
    }
    if (mintValidationReason) {
      toast.error(mintValidationReason);
      return;
    }
    if (!isPositiveAmount(amount)) {
      toast.error("Amount must be a positive number.");
      return;
    }

    runAction(
      {
        label: "Mint tokens",
        method: "POST",
        path: `${tokenBasePath}/mint`,
        body: {
          signingWalletId: mintForm.signingWalletId || undefined,
          mint: {
            destination,
            amount,
            memo: asOptionalString(mintForm.memo),
          },
        },
      },
      {
        requiresConfirmation: true,
        confirmationTitle: "Mint tokens?",
        confirmationDescription: "This will submit a mint transaction on-chain.",
        confirmButtonLabel: "Mint now",
        submitToast: "Submitting mint transaction...",
        successToast: "Mint transaction finalized.",
      }
    );
  };

  const handleBurn = () => {
    if (effectiveBurnDisabledReason) {
      toast.error(effectiveBurnDisabledReason);
      return;
    }

    const source = burnForm.source.trim();
    const amount = burnForm.amount.trim();
    if (!source || !amount) {
      toast.error("Burn source and amount are required.");
      return;
    }
    if (burnValidationReason) {
      toast.error(burnValidationReason);
      return;
    }
    if (!isPositiveAmount(amount)) {
      toast.error("Amount must be a positive number.");
      return;
    }

    runAction(
      {
        label: "Burn tokens",
        method: "POST",
        path: `${tokenBasePath}/burn`,
        body: {
          signingWalletId: burnForm.signingWalletId || undefined,
          burn: {
            source,
            amount,
            memo: asOptionalString(burnForm.memo),
          },
        },
      },
      {
        requiresConfirmation: true,
        confirmationTitle: "Burn tokens?",
        confirmationDescription: "This will submit a burn transaction on-chain.",
        confirmButtonLabel: "Burn now",
        submitToast: "Submitting burn transaction...",
        successToast: "Burn transaction finalized.",
      }
    );
  };

  const handleSeize = () => {
    if (effectiveSeizeDisabledReason) {
      toast.error(effectiveSeizeDisabledReason);
      return;
    }

    const source = seizeForm.source.trim();
    const destination = seizeForm.destination.trim();
    const amount = seizeForm.amount.trim();
    if (!source || !destination || !amount) {
      toast.error("Seize source, destination, and amount are required.");
      return;
    }
    if (seizeValidationReason) {
      toast.error(seizeValidationReason);
      return;
    }
    if (!isPositiveAmount(amount)) {
      toast.error("Amount must be a positive number.");
      return;
    }

    runAction(
      {
        label: "Force transfer",
        method: "POST",
        path: `${tokenBasePath}/seize`,
        body: {
          signingWalletId: seizeForm.signingWalletId || undefined,
          seize: {
            source,
            destination,
            amount,
            delegateAuthority: asOptionalString(seizeForm.delegateAuthority),
            memo: asOptionalString(seizeForm.memo),
          },
        },
      },
      {
        requiresConfirmation: true,
        confirmationTitle: "Force transfer?",
        confirmationDescription: "This will submit a seize (force transfer) transaction on-chain.",
        confirmButtonLabel: "Transfer now",
        submitToast: "Submitting force transfer transaction...",
        successToast: "Force transfer transaction finalized.",
      }
    );
  };

  const handleForceBurn = () => {
    if (effectiveForceBurnDisabledReason) {
      toast.error(effectiveForceBurnDisabledReason);
      return;
    }

    const source = forceBurnForm.source.trim();
    const amount = forceBurnForm.amount.trim();
    if (!source || !amount) {
      toast.error("Force-burn source and amount are required.");
      return;
    }
    if (forceBurnValidationReason) {
      toast.error(forceBurnValidationReason);
      return;
    }
    if (!isPositiveAmount(amount)) {
      toast.error("Amount must be a positive number.");
      return;
    }

    runAction(
      {
        label: "Force burn",
        method: "POST",
        path: `${tokenBasePath}/force-burn`,
        body: {
          signingWalletId: forceBurnForm.signingWalletId || undefined,
          forceBurn: {
            source,
            amount,
            delegateAuthority: asOptionalString(forceBurnForm.delegateAuthority),
            memo: asOptionalString(forceBurnForm.memo),
          },
        },
      },
      {
        requiresConfirmation: true,
        confirmationTitle: "Force burn tokens?",
        confirmationDescription: "This will submit a force-burn transaction on-chain.",
        confirmButtonLabel: "Force burn now",
        submitToast: "Submitting force-burn transaction...",
        successToast: "Force-burn transaction finalized.",
      }
    );
  };

  const handleAuthorityUpdate = () => {
    runAction(
      {
        label: "Update authority",
        method: "POST",
        path: `${tokenBasePath}/authority`,
        body: {
          authority: {
            role: authorityForm.role,
            currentAuthority: asOptionalString(authorityForm.currentAuthority),
            newAuthority: authorityForm.newAuthority.trim() || null,
          },
        },
      },
      {
        requiresConfirmation: true,
        confirmationTitle: "Update authority?",
        confirmationDescription: "This will submit an authority update transaction on-chain.",
        confirmButtonLabel: "Update now",
        submitToast: "Submitting authority update transaction...",
        successToast: "Authority update finalized.",
      }
    );
  };

  const handlePause = (pause: boolean) => {
    if (effectivePauseDisabledReason) {
      toast.error(effectivePauseDisabledReason);
      return;
    }

    runAction(
      {
        label: pause ? "Pause token" : "Unpause token",
        method: "POST",
        path: `${tokenBasePath}/${pause ? "pause" : "unpause"}`,
        body: {},
      },
      {
        requiresConfirmation: true,
        confirmationTitle: pause ? "Pause token?" : "Unpause token?",
        confirmationDescription: pause
          ? "This will submit a pause transaction on-chain."
          : "This will submit an unpause transaction on-chain.",
        confirmButtonLabel: pause ? "Pause now" : "Unpause now",
        submitToast: pause
          ? "Submitting pause transaction..."
          : "Submitting unpause transaction...",
        successToast: pause ? "Pause transaction finalized." : "Unpause transaction finalized.",
      }
    );
  };

  const handleFreeze = (unfreeze: boolean) => {
    if (effectiveFreezeDisabledReason) {
      toast.error(effectiveFreezeDisabledReason);
      return;
    }

    const accountAddress = freezeForm.accountAddress.trim();
    if (!accountAddress) {
      toast.error("Account address is required.");
      return;
    }

    if (unfreeze) {
      runAction(
        {
          label: "Unfreeze account",
          method: "POST",
          path: `${tokenBasePath}/unfreeze`,
          body: {
            accountAddress,
          },
        },
        {
          requiresConfirmation: true,
          confirmationTitle: "Unfreeze account?",
          confirmationDescription: "This will submit an unfreeze transaction on-chain.",
          confirmButtonLabel: "Unfreeze now",
          submitToast: "Submitting unfreeze transaction...",
          successToast: "Unfreeze transaction finalized.",
        }
      );
      return;
    }

    runAction(
      {
        label: "Freeze account",
        method: "POST",
        path: `${tokenBasePath}/freeze`,
        body: {
          accountAddress,
          reason: asOptionalString(freezeForm.reason),
        },
      },
      {
        requiresConfirmation: true,
        confirmationTitle: "Freeze account?",
        confirmationDescription: "This will submit a freeze transaction on-chain.",
        confirmButtonLabel: "Freeze now",
        submitToast: "Submitting freeze transaction...",
        successToast: "Freeze transaction finalized.",
      }
    );
  };

  const handleAddAllowlist = () => {
    const address = allowlistForm.address.trim();
    if (!address) {
      toast.error(controlListCopy?.addressRequiredMessage ?? "Allowlist address is required.");
      return;
    }

    runAction({
      label: controlListCopy?.addActionLabel ?? "Add allowlist entry",
      method: "POST",
      path: `${tokenBasePath}/allowlist`,
      body: {
        address,
        label: asOptionalString(allowlistForm.label),
      },
    });
  };

  const handleRemoveAllowlist = (entryId: string) => {
    runAction(
      {
        label: controlListCopy?.removeActionLabel ?? "Remove allowlist entry",
        method: "DELETE",
        path: `${tokenBasePath}/allowlist/${entryId}`,
      },
      {
        onSuccess: async () => {
          await mutateSupportingData(
            (current) => {
              if (!current) {
                return current;
              }

              const nextAllowlistEntries = current.allowlistEntries.filter(
                (entry) => entry.id !== entryId
              );
              const removedCount = current.allowlistEntries.length - nextAllowlistEntries.length;
              const nextAllowlistTotal =
                current.allowlistTotal === null
                  ? null
                  : Math.max(0, current.allowlistTotal - removedCount);

              return {
                ...current,
                allowlistEntries: nextAllowlistEntries,
                allowlistTotal: nextAllowlistTotal,
              };
            },
            { revalidate: false }
          );
        },
      }
    );
  };

  const handleAuthorityModalOpen = (row: PermissionRow) => {
    const currentAuthority = resolveAuthorityAddressForRole(
      token,
      row.authorityRole,
      metadataAuthority
    );
    const signerSelection = withWalletLoadError(
      getSignerSelectionForAction({
        action: "authority",
        token,
        authorityWallets,
        metadataAuthority,
        permissionRow: row,
      })
    );

    setAuthorityModalRow(row);
    setAuthorityModalCurrentAuthority(currentAuthority);
    setAuthorityModalNewAuthority(row.value ?? "");
    setAuthorityModalSignerWalletId(signerSelection.defaultWalletId);
  };

  const handleAuthorityModalClose = () => {
    if (isPending) {
      return;
    }

    setAuthorityModalRow(null);
    setAuthorityModalCurrentAuthority(null);
    setAuthorityModalNewAuthority("");
    setAuthorityModalSignerWalletId("");
  };

  const handleAuthorityModalConfirm = async () => {
    if (!authorityModalRow) {
      return;
    }

    const result = await runActionImmediately(
      {
        label: `Update ${authorityModalRow.title}`,
        method: "POST",
        path: `${tokenBasePath}/authority`,
        body: {
          signingWalletId: authorityModalSignerWalletId || undefined,
          authority: {
            role: authorityModalRow.authorityRole,
            currentAuthority: authorityModalCurrentAuthority ?? undefined,
            newAuthority: asOptionalString(authorityModalNewAuthority) ?? null,
          },
        },
      },
      {
        submitToast: `Updating ${authorityModalRow.title.toLowerCase()}...`,
        successToast: `${authorityModalRow.title} updated.`,
      }
    );

    if (result.ok) {
      handleAuthorityModalClose();
    }
  };

  const authorityModalSignerSelection = authorityModalRow
    ? withWalletLoadError(
        getSignerSelectionForAction({
          action: "authority",
          token,
          authorityWallets,
          metadataAuthority,
          permissionRow: authorityModalRow,
        })
      )
    : {
        wallets: [] as PaymentsDashboardWallet[],
        defaultWalletId: "",
        unavailableReason: null,
      };

  const openFundManagementModal = (action: FundManagementModalAction) => {
    if (fundManagementDisabledReasons[action]) {
      return;
    }

    switch (action) {
      case "deploy":
        setDeploySignerWalletId(deploySignerSelection.defaultWalletId);
        break;
      case "mint":
        setMintForm((previous) => ({
          ...previous,
          signingWalletId: mintSignerSelection.defaultWalletId,
        }));
        break;
      case "burn":
        setBurnForm((previous) => ({
          ...previous,
          signingWalletId: burnSignerSelection.defaultWalletId,
        }));
        break;
    }

    setFundManagementModalAction(action);
  };

  const closeFundManagementModal = () => {
    if (isPending) {
      return;
    }

    setFundManagementModalAction(null);
  };

  const submitFundManagementAction = (action: FundManagementModalAction) => {
    closeFundManagementModal();

    switch (action) {
      case "deploy":
        handleDeploy();
        return;
      case "mint":
        handleMint();
        return;
      case "burn":
        handleBurn();
        return;
    }
  };

  const getActionSignerProps = (action: AdminAction | FundManagementModalAction | null) => {
    switch (action) {
      case "mint":
        return {
          signerWallets: mintSignerSelection.wallets,
          signerUnavailableReason: mintSignerSelection.unavailableReason,
          onSignerWalletIdChange: (value: string) =>
            setMintForm((previous) => ({ ...previous, signingWalletId: value })),
        };
      case "burn":
        return {
          signerWallets: burnSignerSelection.wallets,
          signerUnavailableReason: burnSignerSelection.unavailableReason,
          onSignerWalletIdChange: (value: string) =>
            setBurnForm((previous) => ({ ...previous, signingWalletId: value })),
        };
      case "seize":
        return {
          signerWallets: seizeSignerSelection.wallets,
          signerUnavailableReason: seizeSignerSelection.unavailableReason,
          onSignerWalletIdChange: (value: string) =>
            setSeizeForm((previous) => ({ ...previous, signingWalletId: value })),
        };
      case "force-burn":
        return {
          signerWallets: forceBurnSignerSelection.wallets,
          signerUnavailableReason: forceBurnSignerSelection.unavailableReason,
          onSignerWalletIdChange: (value: string) =>
            setForceBurnForm((previous) => ({ ...previous, signingWalletId: value })),
        };
      case "freeze":
        return {
          signerWallets: freezeSignerSelection.wallets,
          defaultSignerWalletId: freezeSignerSelection.defaultWalletId,
          signerUnavailableReason: freezeSignerSelection.unavailableReason,
          // Freeze authority is always single
          onSignerWalletIdChange: (_value: string) => {},
        };
      case "pause":
        return {
          signerWallets: pauseSignerSelection.wallets,
          defaultSignerWalletId: pauseSignerSelection.defaultWalletId,
          signerUnavailableReason: pauseSignerSelection.unavailableReason,
          // Pause authority is always single
          onSignerWalletIdChange: (_value: string) => {},
        };
      default:
        return {
          signerWallets: [] as PaymentsDashboardWallet[],
          signerUnavailableReason: null,
          onSignerWalletIdChange: (_value: string) => {},
        };
    }
  };

  return {
    // action runner
    isPending,
    actionConfirmation,
    dismissActionConfirmation,
    confirmAction,
    // token facts
    tokenBasePath,
    explorerHref,
    canDeployToken,
    accessControlMode,
    controlListCopy,
    showControlList,
    pauseDisabledReason,
    effectivePauseDisabledReason,
    effectiveFreezeDisabledReason,
    complianceActionDisabledReasons,
    fundManagementDisabledReasons,
    // wallets + supporting data
    authorityWallets,
    authorityWalletsError,
    authorityWalletsLoading,
    supportingDataLoading,
    transactions,
    transactionsError,
    transactionsTotal,
    transactionsHasMore,
    allowlistEntries,
    allowlistError,
    allowlistTotal,
    allowlistHasMore,
    frozenAccounts,
    frozenAccountsError,
    frozenAccountsTotal,
    frozenAccountsHasMore,
    // rows
    permissionRows,
    extensionRows,
    displayedMintAuthority,
    // form state
    mintForm,
    setMintForm,
    burnForm,
    setBurnForm,
    seizeForm,
    setSeizeForm,
    forceBurnForm,
    setForceBurnForm,
    authorityForm,
    setAuthorityForm,
    freezeForm,
    setFreezeForm,
    allowlistForm,
    setAllowlistForm,
    // validation
    mintValidationErrors,
    mintValidationReason,
    burnValidationErrors,
    burnValidationReason,
    seizeValidationErrors,
    seizeValidationReason,
    forceBurnValidationErrors,
    forceBurnValidationReason,
    // deploy modal
    deploySignerSelection,
    deploySignerWalletId,
    setDeploySignerWalletId,
    fundManagementModalAction,
    openFundManagementModal,
    closeFundManagementModal,
    submitFundManagementAction,
    // authority modal
    authorityModalRow,
    authorityModalCurrentAuthority,
    authorityModalNewAuthority,
    setAuthorityModalNewAuthority,
    authorityModalSignerSelection,
    handleAuthorityModalOpen,
    handleAuthorityModalClose,
    handleAuthorityModalConfirm,
    // handlers
    handleCopy,
    handleDeploy,
    handleRefreshSupply,
    handleMint,
    handleBurn,
    handleSeize,
    handleForceBurn,
    handleAuthorityUpdate,
    handlePause,
    handleFreeze,
    handleAddAllowlist,
    handleRemoveAllowlist,
    getActionSignerProps,
  };
}

export type TokenOperations = ReturnType<typeof useTokenOperations>;
