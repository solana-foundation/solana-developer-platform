"use client";

import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { TokenActionConfirmationDialog } from "./token-action-confirmation-dialog";
import { TokenActionForms } from "./token-action-forms";
import { TokenAuthorityModal } from "./token-authority-modal";
import { TokenControlListsSection } from "./token-control-lists-section";
import { TokenDisabledActionTooltip } from "./token-disabled-action-tooltip";
import {
  type FundManagementModalAction,
  TokenFundManagementSection,
} from "./token-fund-management-section";
import { TokenManagementHeader } from "./token-management-header";
import { TokenManagementModalShell } from "./token-management-modal-shell";
import {
  type TokenManagementSupportingData,
  fetchTokenManagementSupportingData,
} from "./token-management-workspace.data";
import type {
  ActionExecutionInput,
  AdminAction,
  PermissionRow,
  RunActionOptions,
  TokenManagementTab,
  TokenManagementWorkspaceProps,
} from "./token-management-workspace.types";
import {
  asOptionalString,
  createInitialAllowlistForm,
  createInitialAuthorityForm,
  createInitialBurnForm,
  createInitialForceBurnForm,
  createInitialFreezeForm,
  createInitialMetadataForm,
  createInitialMintForm,
  createInitialSeizeForm,
  getDefaultActionForTab,
  getDisplayedAuthorityAddress,
  getExplorerHref,
  getExtensionRows,
  getPermissionRows,
  getSignerSelectionForAction,
  getTabForAction,
  getTokenActionDisabledReasons,
  isPositiveAmount,
  resolveAuthorityAddressForRole,
} from "./token-management-workspace.utils";
import { TokenOverviewSection } from "./token-overview-section";
import { TokenSettingsSection } from "./token-settings-section";
import { TokenSignerSelect } from "./token-signer-select";
import { TokenTransactionsSection } from "./token-transactions-section";
import { useTokenActionRunner } from "./use-token-action-runner";

const managementTabs: Array<{ id: TokenManagementTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "permissions", label: "Permissions" },
  { id: "extensions", label: "Extensions" },
  { id: "compliance", label: "Compliance" },
  { id: "metadata", label: "Metadata" },
  { id: "fund-management", label: "Fund Management" },
];

const liveFundManagementRows: Array<{
  id: FundManagementModalAction;
  title: string;
  helper: string;
  actionLabel: string;
}> = [
  {
    id: "mint",
    title: "Mint Tokens",
    helper: "Create new supply in a destination wallet or token account.",
    actionLabel: "Mint",
  },
  {
    id: "burn",
    title: "Burn Tokens",
    helper: "Remove supply from a source wallet or token account.",
    actionLabel: "Burn",
  },
  {
    id: "seize",
    title: "Force Transfer",
    helper: "Move tokens administratively between two accounts.",
    actionLabel: "Transfer",
  },
  {
    id: "force-burn",
    title: "Force Burn",
    helper: "Burn tokens administratively from a source account.",
    actionLabel: "Burn",
  },
  {
    id: "refresh-supply",
    title: "Refresh Supply",
    helper: "Sync the cached supply value from on-chain state.",
    actionLabel: "Refresh",
  },
];

function LoadingSection({ message }: { message: string }) {
  return (
    <div className="flex min-h-[180px] items-center justify-center rounded-2xl border border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.02)] px-6 py-10">
      <div className="flex items-center gap-3 text-sm text-[rgba(28,28,29,0.64)]">
        <Loader2 className="size-4 animate-spin" />
        <span>{message}</span>
      </div>
    </div>
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: token management intentionally centralizes action orchestration and tab coordination in one workspace.
export function TokenManagementWorkspace({
  token,
  tokenError,
  authorityWallets: initialAuthorityWallets,
  authorityWalletsError: initialAuthorityWalletsError,
  transactions: initialTransactions,
  transactionsError: initialTransactionsError,
  transactionsTotal: initialTransactionsTotal,
  transactionsHasMore: initialTransactionsHasMore,
  allowlistEntries: initialAllowlistEntries,
  allowlistError: initialAllowlistError,
  allowlistTotal: initialAllowlistTotal,
  allowlistHasMore: initialAllowlistHasMore,
  frozenAccounts: initialFrozenAccounts,
  frozenAccountsError: initialFrozenAccountsError,
  frozenAccountsTotal: initialFrozenAccountsTotal,
  frozenAccountsHasMore: initialFrozenAccountsHasMore,
}: TokenManagementWorkspaceProps) {
  const {
    isPending,
    actionConfirmation,
    runAction: runActionBase,
    runActionImmediately: runActionImmediatelyBase,
    dismissActionConfirmation,
    confirmAction,
  } = useTokenActionRunner();
  const [activeTab, setActiveTab] = useState<TokenManagementTab>("overview");
  const [activeAction, setActiveAction] = useState<AdminAction | null>(null);
  const [authorityModalRow, setAuthorityModalRow] = useState<PermissionRow | null>(null);
  const [authorityModalCurrentAuthority, setAuthorityModalCurrentAuthority] = useState<
    string | null
  >(null);
  const [authorityModalNewAuthority, setAuthorityModalNewAuthority] = useState("");
  const [authorityModalSignerWalletId, setAuthorityModalSignerWalletId] = useState("");
  const [fundManagementModalAction, setFundManagementModalAction] =
    useState<FundManagementModalAction | null>(null);
  const [deploySignerWalletId, setDeploySignerWalletId] = useState("");
  const [metadataForm, setMetadataForm] = useState(() => createInitialMetadataForm(token));
  const [mintForm, setMintForm] = useState(createInitialMintForm);
  const [burnForm, setBurnForm] = useState(createInitialBurnForm);
  const [seizeForm, setSeizeForm] = useState(createInitialSeizeForm);
  const [forceBurnForm, setForceBurnForm] = useState(createInitialForceBurnForm);
  const [authorityForm, setAuthorityForm] = useState(createInitialAuthorityForm);
  const [freezeForm, setFreezeForm] = useState(createInitialFreezeForm);
  const [allowlistForm, setAllowlistForm] = useState(createInitialAllowlistForm);
  const shouldLoadSupportingData = activeTab !== "overview";
  const hasInitialSupportingData =
    initialAuthorityWallets.length > 0 ||
    initialTransactions.length > 0 ||
    initialAllowlistEntries.length > 0 ||
    initialFrozenAccounts.length > 0 ||
    initialAuthorityWalletsError !== null ||
    initialTransactionsError !== null ||
    initialAllowlistError !== null ||
    initialFrozenAccountsError !== null;
  const initialSupportingData = useMemo<TokenManagementSupportingData>(
    () => ({
      authorityWallets: initialAuthorityWallets,
      authorityWalletsError: initialAuthorityWalletsError,
      transactions: initialTransactions,
      transactionsError: initialTransactionsError,
      transactionsTotal: initialTransactionsTotal,
      transactionsHasMore: initialTransactionsHasMore,
      allowlistEntries: initialAllowlistEntries,
      allowlistError: initialAllowlistError,
      allowlistTotal: initialAllowlistTotal,
      allowlistHasMore: initialAllowlistHasMore,
      frozenAccounts: initialFrozenAccounts,
      frozenAccountsError: initialFrozenAccountsError,
      frozenAccountsTotal: initialFrozenAccountsTotal,
      frozenAccountsHasMore: initialFrozenAccountsHasMore,
    }),
    [
      initialAllowlistEntries,
      initialAllowlistError,
      initialAllowlistHasMore,
      initialAllowlistTotal,
      initialAuthorityWallets,
      initialAuthorityWalletsError,
      initialFrozenAccounts,
      initialFrozenAccountsError,
      initialFrozenAccountsHasMore,
      initialFrozenAccountsTotal,
      initialTransactions,
      initialTransactionsError,
      initialTransactionsHasMore,
      initialTransactionsTotal,
    ]
  );
  const {
    data: supportingData,
    error: supportingDataRequestError,
    mutate: mutateSupportingData,
  } = useSWR(
    shouldLoadSupportingData ? ["token-management-supporting-data", token.id] : null,
    ([, tokenId]: readonly [string, string]) => fetchTokenManagementSupportingData(tokenId),
    {
      fallbackData: hasInitialSupportingData ? initialSupportingData : undefined,
      refreshInterval: 60_000,
      revalidateOnFocus: true,
      revalidateIfStale: false,
    }
  );
  const supportingDataError = supportingDataRequestError
    ? supportingDataRequestError instanceof Error
      ? supportingDataRequestError.message
      : "Unable to load token management data."
    : null;
  const supportingDataLoading =
    shouldLoadSupportingData && supportingData === undefined && !supportingDataError;
  const resolvedSupportingData = supportingData ?? initialSupportingData;
  const revalidateSupportingDataAfterSuccess = async () => {
    if (!shouldLoadSupportingData) {
      return;
    }

    await mutateSupportingData();
  };
  const runAction = (input: ActionExecutionInput, options: RunActionOptions = {}) =>
    runActionBase(input, {
      ...options,
      onSuccess: async (result) => {
        await options.onSuccess?.(result);
        await revalidateSupportingDataAfterSuccess();
      },
    });
  const runActionImmediately = (input: ActionExecutionInput, options: RunActionOptions = {}) =>
    runActionImmediatelyBase(input, {
      ...options,
      onSuccess: async (result) => {
        await options.onSuccess?.(result);
        await revalidateSupportingDataAfterSuccess();
      },
    });
  const authorityWallets = resolvedSupportingData.authorityWallets;
  const authorityWalletsError = supportingDataError ?? resolvedSupportingData.authorityWalletsError;
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
    if (authorityWalletsError && selection.unavailableReason) {
      return { ...selection, unavailableReason: authorityWalletsError };
    }

    return selection;
  };
  const deploySignerSelection = withWalletLoadError(
    getSignerSelectionForAction({
      action: "deploy",
      token,
      authorityWallets,
      metadataAuthority,
    })
  );
  const mintSignerSelection = withWalletLoadError(
    getSignerSelectionForAction({
      action: "mint",
      token,
      authorityWallets,
      metadataAuthority,
    })
  );
  const burnSignerSelection = withWalletLoadError(
    getSignerSelectionForAction({
      action: "burn",
      token,
      authorityWallets,
      metadataAuthority,
    })
  );
  const seizeSignerSelection = withWalletLoadError(
    getSignerSelectionForAction({
      action: "seize",
      token,
      authorityWallets,
      metadataAuthority,
    })
  );
  const forceBurnSignerSelection = withWalletLoadError(
    getSignerSelectionForAction({
      action: "force-burn",
      token,
      authorityWallets,
      metadataAuthority,
    })
  );
  const permissionRows = getPermissionRows(token, metadataAuthority).map((row) => {
    const displayedAuthorityAddress = getDisplayedAuthorityAddress({
      token,
      role: row.authorityRole,
      metadataAuthority,
      authorityWallets,
    });
    const rowWithDisplayedValue = {
      ...row,
      value: displayedAuthorityAddress,
    };

    return {
      ...rowWithDisplayedValue,
      editDisabledReason: withWalletLoadError(
        getSignerSelectionForAction({
          action: "authority",
          token,
          authorityWallets,
          metadataAuthority,
          permissionRow: rowWithDisplayedValue,
        })
      ).unavailableReason,
    };
  });
  const displayedMintAuthority = getDisplayedAuthorityAddress({
    token,
    role: "mint",
    metadataAuthority,
    authorityWallets,
  });
  const extensionRows = getExtensionRows(token);
  const showAllowlistControls = token.requiresAllowlist;
  const complianceActions: Array<{ id: AdminAction; label: string }> = [
    ...(showAllowlistControls ? [{ id: "allowlist" as const, label: "Allowlist" }] : []),
    { id: "freeze", label: "Freeze" },
    { id: "pause", label: "Pause" },
  ];
  const effectiveMintDisabledReason = mintDisabledReason ?? mintSignerSelection.unavailableReason;
  const effectiveBurnDisabledReason = burnDisabledReason ?? burnSignerSelection.unavailableReason;
  const effectiveSeizeDisabledReason =
    seizeDisabledReason ?? seizeSignerSelection.unavailableReason;
  const effectiveForceBurnDisabledReason =
    forceBurnDisabledReason ?? forceBurnSignerSelection.unavailableReason;
  const fundManagementDisabledReasons: Record<FundManagementModalAction, string | null> = {
    deploy: deploySignerSelection.unavailableReason,
    mint: effectiveMintDisabledReason,
    burn: effectiveBurnDisabledReason,
    seize: effectiveSeizeDisabledReason,
    "force-burn": effectiveForceBurnDisabledReason,
    "refresh-supply": null,
  };
  const complianceActionDisabledReasons: Partial<Record<AdminAction, string | null>> = {
    freeze: freezeDisabledReason,
    pause: pauseDisabledReason,
  };
  const fundManagementRows = canDeployToken
    ? [
        {
          id: "deploy" as const,
          title: "Deploy Token",
          helper: "Deploy this token on-chain before running other fund operations.",
          actionLabel: "Deploy",
          disabled: Boolean(fundManagementDisabledReasons.deploy),
          disabledReason: fundManagementDisabledReasons.deploy,
        },
      ]
    : liveFundManagementRows.map((row) => ({
        ...row,
        disabled: Boolean(fundManagementDisabledReasons[row.id]),
        disabledReason: fundManagementDisabledReasons[row.id],
      }));

  const handleCopy = async (value: string | null) => {
    if (!value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied");
    } catch {
      toast.error("Unable to copy");
    }
  };

  const handleUpdateMetadata = () => {
    const nextName = metadataForm.name.trim();
    if (!nextName) {
      toast.error("Token name is required.");
      return;
    }

    runAction({
      label: "Update token",
      method: "PATCH",
      path: tokenBasePath,
      body: {
        name: nextName,
        description: metadataForm.description.trim() ? metadataForm.description.trim() : null,
        uri: metadataForm.uri.trim() ? metadataForm.uri.trim() : null,
        imageUrl: metadataForm.imageUrl.trim() ? metadataForm.imageUrl.trim() : null,
      },
    });
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
    if (pauseDisabledReason) {
      toast.error(pauseDisabledReason);
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
    if (freezeDisabledReason) {
      toast.error(freezeDisabledReason);
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
      toast.error("Allowlist address is required.");
      return;
    }

    runAction({
      label: "Add allowlist entry",
      method: "POST",
      path: `${tokenBasePath}/allowlist`,
      body: {
        address,
        label: asOptionalString(allowlistForm.label),
      },
    });
  };

  const handleRemoveAllowlist = (entryId: string) => {
    runAction({
      label: "Remove allowlist entry",
      method: "DELETE",
      path: `${tokenBasePath}/allowlist/${entryId}`,
    });
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
      case "seize":
        setSeizeForm((previous) => ({
          ...previous,
          signingWalletId: seizeSignerSelection.defaultWalletId,
        }));
        break;
      case "force-burn":
        setForceBurnForm((previous) => ({
          ...previous,
          signingWalletId: forceBurnSignerSelection.defaultWalletId,
        }));
        break;
      case "refresh-supply":
        break;
    }

    setActiveTab("fund-management");
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
      case "seize":
        handleSeize();
        return;
      case "force-burn":
        handleForceBurn();
        return;
      case "refresh-supply":
        handleRefreshSupply();
        return;
    }
  };

  const handleTabChange = (tab: TokenManagementTab) => {
    setActiveTab(tab);

    const nextDefaultAction =
      tab === "fund-management" && canDeployToken
        ? null
        : tab === "compliance" && !showAllowlistControls
          ? "freeze"
          : getDefaultActionForTab(tab);
    if (nextDefaultAction) {
      setActiveAction(nextDefaultAction);
      return;
    }

    setActiveAction((currentAction) =>
      currentAction && getTabForAction(currentAction) === tab ? currentAction : null
    );
  };

  const selectAction = (action: AdminAction) => {
    setActiveTab(getTabForAction(action));
    setActiveAction(action);
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
      default:
        return {
          signerWallets: [],
          signerUnavailableReason: null,
          onSignerWalletIdChange: (_value: string) => {},
        };
    }
  };

  const visibleActionSignerProps = getActionSignerProps(activeAction);
  const fundManagementActionSignerProps = getActionSignerProps(fundManagementModalAction);
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
        wallets: [],
        defaultWalletId: "",
        unavailableReason: null,
      };

  const visibleActionForm =
    activeAction && getTabForAction(activeAction) === activeTab ? (
      <TokenActionForms
        activeAction={activeAction}
        isPending={isPending}
        tokenStatus={token.status}
        metadataForm={metadataForm}
        setMetadataForm={setMetadataForm}
        mintForm={mintForm}
        setMintForm={setMintForm}
        burnForm={burnForm}
        setBurnForm={setBurnForm}
        seizeForm={seizeForm}
        setSeizeForm={setSeizeForm}
        forceBurnForm={forceBurnForm}
        setForceBurnForm={setForceBurnForm}
        authorityForm={authorityForm}
        setAuthorityForm={setAuthorityForm}
        freezeForm={freezeForm}
        setFreezeForm={setFreezeForm}
        allowlistForm={allowlistForm}
        setAllowlistForm={setAllowlistForm}
        allowlistEntries={allowlistEntries}
        allowlistError={allowlistError}
        signerWallets={visibleActionSignerProps.signerWallets}
        signerUnavailableReason={visibleActionSignerProps.signerUnavailableReason}
        onSignerWalletIdChange={visibleActionSignerProps.onSignerWalletIdChange}
        onUpdateMetadata={handleUpdateMetadata}
        onRefreshSupply={handleRefreshSupply}
        onMint={handleMint}
        onBurn={handleBurn}
        onSeize={handleSeize}
        onForceBurn={handleForceBurn}
        onAuthorityUpdate={handleAuthorityUpdate}
        onPause={handlePause}
        onFreeze={handleFreeze}
        onAddAllowlist={handleAddAllowlist}
        onRemoveAllowlist={handleRemoveAllowlist}
      />
    ) : null;

  return (
    <div className="space-y-8 pb-8">
      <TokenManagementHeader
        tokenName={token.name}
        tokenSymbol={token.symbol}
        tokenStatus={token.status}
        tokenAddress={token.mintAddress}
        tokenImageUrl={token.imageUrl}
        explorerHref={explorerHref}
        canDeployToken={canDeployToken}
        isPending={isPending}
        deployDisabledReason={deploySignerSelection.unavailableReason}
        mintDisabledReason={effectiveMintDisabledReason}
        burnDisabledReason={effectiveBurnDisabledReason}
        pauseDisabledReason={pauseDisabledReason}
        onCopyAddress={() => void handleCopy(token.mintAddress)}
        onMintSelect={() => openFundManagementModal("mint")}
        onBurnSelect={() => openFundManagementModal("burn")}
        onDeploy={() => {
          if (!canDeployToken) {
            return;
          }
          openFundManagementModal("deploy");
        }}
        onUnpause={() => handlePause(false)}
      />

      <div className="border-b border-[rgba(28,28,29,0.12)]">
        <div className="flex flex-wrap gap-8">
          {managementTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => handleTabChange(tab.id)}
              className={[
                "relative pb-4 text-[15px] leading-[24px] font-medium transition-colors sm:text-[16px]",
                activeTab === tab.id
                  ? "text-[#1c1c1d]"
                  : "text-[rgba(28,28,29,0.54)] hover:text-[#1c1c1d]",
              ].join(" ")}
            >
              {tab.label}
              {activeTab === tab.id ? (
                <span className="absolute right-0 bottom-[-1px] left-0 h-[2px] bg-[#1c1c1d]" />
              ) : null}
            </button>
          ))}
        </div>
      </div>

      {tokenError ? (
        <div className="rounded-xl border border-[#c71f37]/20 bg-[#c71f37]/[0.03] px-4 py-3">
          <p className="text-sm font-medium text-[#8a1f2a]">Token load warning</p>
          <p className="mt-1 text-sm text-[#8a1f2a]">{tokenError}</p>
        </div>
      ) : null}

      {token.status === "paused" ? (
        <div className="flex flex-col gap-3 rounded-xl border border-[rgba(217,119,6,0.24)] bg-[rgba(245,158,11,0.08)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-[#92400e]">Token is paused</p>
            <p className="mt-1 text-sm text-[#92400e]">
              Minting, burning, and administrative transfer actions are disabled until the token is
              unpaused.
            </p>
          </div>
          <TokenDisabledActionTooltip reason={isPending ? null : pauseDisabledReason}>
            <Button
              type="button"
              size="sm"
              onClick={() => handlePause(false)}
              disabled={isPending || Boolean(pauseDisabledReason)}
            >
              Unpause token
            </Button>
          </TokenDisabledActionTooltip>
        </div>
      ) : null}

      {activeTab === "overview" ? (
        <div className="space-y-4">
          <TokenOverviewSection
            token={token}
            showTitle={false}
            mintAuthorityValue={displayedMintAuthority}
          />
        </div>
      ) : null}

      {activeTab === "permissions" ? (
        supportingDataLoading ? (
          <LoadingSection message="Loading authority wallet access…" />
        ) : (
          <div className="space-y-4">
            <TokenSettingsSection
              mode="permissions"
              permissionRows={permissionRows}
              extensionRows={extensionRows}
              showTitle={false}
              canEditAuthorities={!canDeployToken}
              onCopy={handleCopy}
              onEditAuthority={handleAuthorityModalOpen}
            />
          </div>
        )
      ) : null}

      {activeTab === "extensions" ? (
        <div className="space-y-4">
          <TokenSettingsSection
            mode="extensions"
            permissionRows={permissionRows}
            extensionRows={extensionRows}
            showTitle={false}
            canEditAuthorities={!canDeployToken}
            onCopy={handleCopy}
            onEditAuthority={handleAuthorityModalOpen}
          />
        </div>
      ) : null}

      {activeTab === "compliance" ? (
        supportingDataLoading ? (
          <LoadingSection message="Loading compliance controls…" />
        ) : (
          <div className="space-y-4">
            <ActionSelector
              actions={complianceActions}
              activeAction={activeAction}
              disabledReasons={complianceActionDisabledReasons}
              onSelectAction={selectAction}
            />
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
              <div>{visibleActionForm}</div>
              <TokenControlListsSection
                showAllowlist={showAllowlistControls}
                allowlistEntriesCount={allowlistEntries.length}
                allowlistError={allowlistError}
                allowlistTotal={allowlistTotal}
                allowlistHasMore={allowlistHasMore}
                frozenAccountsCount={frozenAccounts.length}
                frozenAccountsError={frozenAccountsError}
                frozenAccountsTotal={frozenAccountsTotal}
                frozenAccountsHasMore={frozenAccountsHasMore}
              />
            </div>
          </div>
        )
      ) : null}

      {activeTab === "metadata" ? (
        <div className="space-y-4">
          {visibleActionForm}
          <TokenOverviewSection
            token={token}
            showTitle={false}
            mintAuthorityValue={displayedMintAuthority}
          />
        </div>
      ) : null}

      {activeTab === "fund-management" ? (
        supportingDataLoading ? (
          <LoadingSection message="Loading fund management data…" />
        ) : (
          <div className="space-y-4">
            <TokenFundManagementSection
              rows={fundManagementRows}
              onOpenAction={openFundManagementModal}
            />
            <TokenTransactionsSection
              transactions={transactions}
              transactionsError={transactionsError}
              transactionsTotal={transactionsTotal}
              transactionsHasMore={transactionsHasMore}
            />
          </div>
        )
      ) : null}

      <TokenAuthorityModal
        row={authorityModalRow}
        currentAuthorityValue={authorityModalCurrentAuthority}
        newAuthority={authorityModalNewAuthority}
        authorityWallets={authorityWallets}
        authorityWalletsError={authorityWalletsError}
        signerUnavailableReason={authorityModalSignerSelection.unavailableReason}
        isPending={isPending}
        onNewAuthorityChange={setAuthorityModalNewAuthority}
        onCancel={handleAuthorityModalClose}
        onConfirm={handleAuthorityModalConfirm}
      />

      <TokenManagementModalShell
        isOpen={Boolean(fundManagementModalAction)}
        isPending={isPending}
        onClose={closeFundManagementModal}
      >
        {fundManagementModalAction === "deploy" ? (
          <div className="rounded-2xl border border-[rgba(28,28,29,0.12)] bg-white p-5 shadow-[0_20px_40px_rgba(0,0,0,0.16)]">
            <p className="text-[24px] leading-[1.15] font-medium text-[#1c1c1d]">Deploy token</p>
            <p className="mt-2 text-[15px] leading-[1.45] text-[rgba(28,28,29,0.72)]">
              This will deploy the token on-chain so fund management actions can be used.
            </p>
            <div className="mt-5 space-y-5">
              <TokenSignerSelect
                signerWallets={deploySignerSelection.wallets}
                signerWalletId={deploySignerWalletId}
                signerUnavailableReason={deploySignerSelection.unavailableReason}
                onSignerWalletIdChange={setDeploySignerWalletId}
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={closeFundManagementModal}
                  disabled={isPending}
                  className="inline-flex h-10 items-center rounded-[12px] border border-[rgba(28,28,29,0.16)] bg-white px-4 text-sm font-medium text-[#1c1c1d] transition-colors hover:bg-[rgba(28,28,29,0.04)] disabled:pointer-events-none disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => submitFundManagementAction("deploy")}
                  disabled={isPending || Boolean(deploySignerSelection.unavailableReason)}
                  className="inline-flex h-10 items-center rounded-[12px] bg-[#0f0f10] px-4 text-sm font-medium text-white transition-colors hover:bg-black disabled:pointer-events-none disabled:opacity-50"
                >
                  Deploy now
                </button>
              </div>
            </div>
          </div>
        ) : fundManagementModalAction ? (
          <TokenActionForms
            activeAction={fundManagementModalAction}
            isPending={isPending}
            tokenStatus={token.status}
            metadataForm={metadataForm}
            setMetadataForm={setMetadataForm}
            mintForm={mintForm}
            setMintForm={setMintForm}
            burnForm={burnForm}
            setBurnForm={setBurnForm}
            seizeForm={seizeForm}
            setSeizeForm={setSeizeForm}
            forceBurnForm={forceBurnForm}
            setForceBurnForm={setForceBurnForm}
            authorityForm={authorityForm}
            setAuthorityForm={setAuthorityForm}
            freezeForm={freezeForm}
            setFreezeForm={setFreezeForm}
            allowlistForm={allowlistForm}
            setAllowlistForm={setAllowlistForm}
            allowlistEntries={allowlistEntries}
            allowlistError={allowlistError}
            signerWallets={fundManagementActionSignerProps.signerWallets}
            signerUnavailableReason={fundManagementActionSignerProps.signerUnavailableReason}
            onSignerWalletIdChange={fundManagementActionSignerProps.onSignerWalletIdChange}
            onUpdateMetadata={handleUpdateMetadata}
            onRefreshSupply={() => submitFundManagementAction("refresh-supply")}
            onMint={() => submitFundManagementAction("mint")}
            onBurn={() => submitFundManagementAction("burn")}
            onSeize={() => submitFundManagementAction("seize")}
            onForceBurn={() => submitFundManagementAction("force-burn")}
            onAuthorityUpdate={handleAuthorityUpdate}
            onPause={handlePause}
            onFreeze={handleFreeze}
            onAddAllowlist={handleAddAllowlist}
            onRemoveAllowlist={handleRemoveAllowlist}
          />
        ) : null}
      </TokenManagementModalShell>

      <TokenActionConfirmationDialog
        actionConfirmation={actionConfirmation}
        isPending={isPending}
        onCancel={dismissActionConfirmation}
        onConfirm={confirmAction}
      />

      {isPending ? (
        <div className="fixed right-4 bottom-4 z-30 inline-flex items-center gap-2 rounded-lg border border-[rgba(28,28,29,0.12)] bg-white px-3 py-2 text-sm shadow-lg">
          <Loader2 className="h-4 w-4 animate-spin" />
          Running action...
        </div>
      ) : null}
    </div>
  );
}

function ActionSelector({
  actions,
  activeAction,
  disabledReasons,
  onSelectAction,
}: {
  actions: Array<{ id: AdminAction; label: string }>;
  activeAction: AdminAction | null;
  disabledReasons?: Partial<Record<AdminAction, string | null>>;
  onSelectAction: (action: AdminAction) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((action) => (
        <TokenDisabledActionTooltip key={action.id} reason={disabledReasons?.[action.id]}>
          <button
            type="button"
            onClick={() => onSelectAction(action.id)}
            disabled={Boolean(disabledReasons?.[action.id])}
            className={[
              "inline-flex h-10 items-center rounded-[12px] px-4 text-sm font-medium transition-colors",
              activeAction === action.id
                ? "bg-[#0f0f10] text-white"
                : "bg-[rgba(28,28,29,0.08)] text-[#1c1c1d] hover:bg-[rgba(28,28,29,0.14)] disabled:pointer-events-none disabled:opacity-50",
            ].join(" ")}
          >
            {action.label}
          </button>
        </TokenDisabledActionTooltip>
      ))}
    </div>
  );
}
