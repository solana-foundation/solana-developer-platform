"use client";

import type { PaymentsDashboardWallet, Token } from "@sdp/types";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { getTokenAccessControlMode, hasAccessControlList } from "../../access-control.utils";
import type { FundManagementModalAction } from "../token-fund-management-section";
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
  getExplorerHref,
  getExtensionRows,
  getForceBurnValidationErrors,
  getForceBurnValidationReason,
  getLockSupplyDisabledReason,
  getMintValidationErrors,
  getMintValidationReason,
  getRemainingMintableSupply,
  getSeizeValidationErrors,
  getSeizeValidationReason,
  getSignerSelectionForAction,
  isPositiveAmount,
  resolveAuthorityAddressForRole,
} from "../token-management-workspace.utils";
import { useTokenActionRunner } from "../use-token-action-runner";
import { getTokenOperationPermissions } from "./token-operation-permissions";
import { useTokenOperationData } from "./use-token-operation-data";

/**
 * The operational core of token management (deploy, mint, burn, seize,
 * force-burn, authorities, pause, freeze, allowlist, supply refresh) for the
 * asset-profile workspace. Mirrors the handler wiring of the legacy
 * TokenManagementWorkspace against the same API endpoints and shared utils —
 * the monolith itself is intentionally untouched.
 */
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
  const t = useTranslations();
  const { sdpEnvironment } = useDashboardWorkspace();
  const {
    isPending,
    actionConfirmation,
    runAction: runActionBase,
    runActionImmediately: runActionImmediatelyBase,
    dismissActionConfirmation,
    confirmAction,
  } = useTokenActionRunner();
  const { isPending: isRefreshingSupply, runAction: refreshSupply } = useTokenActionRunner();

  const [authorityModalRow, setAuthorityModalRow] = useState<PermissionRow | null>(null);
  const [authorityModalCurrentAuthority, setAuthorityModalCurrentAuthority] = useState<
    string | null
  >(null);
  const [authorityModalNewAuthority, setAuthorityModalNewAuthority] = useState("");
  const [authorityModalSignerWalletId, setAuthorityModalSignerWalletId] = useState("");
  const [fundManagementModalAction, setFundManagementModalAction] =
    useState<FundManagementModalAction | null>(null);
  const [mintForm, setMintForm] = useState(createInitialMintForm);
  const [burnForm, setBurnForm] = useState(createInitialBurnForm);
  const [seizeForm, setSeizeForm] = useState(createInitialSeizeForm);
  const [forceBurnForm, setForceBurnForm] = useState(createInitialForceBurnForm);
  const [authorityForm, setAuthorityForm] = useState(createInitialAuthorityForm);
  const [freezeForm, setFreezeForm] = useState(createInitialFreezeForm);
  const [allowlistForm, setAllowlistForm] = useState(createInitialAllowlistForm);
  // Lock-supply has its own modal state rather than joining FundManagementModalAction:
  // it composes two endpoint calls instead of mapping to one, it must keep the modal
  // open across submission to offer a retry, and it exists only on this workspace —
  // widening the shared union would force dead entries into the legacy workspace and
  // the playground deep-links.
  const [lockSupplyModalOpen, setLockSupplyModalOpen] = useState(false);
  const [lockSupplyForm, setLockSupplyForm] = useState({
    destination: "",
    signingWalletId: "",
  });
  // Records that lock-supply's mint leg already landed, so a failed revoke can be
  // retried without minting twice. Cleared when the modal closes cleanly.
  const [lockSupplyMinted, setLockSupplyMinted] = useState(false);
  const [lockSupplyRevokeFailed, setLockSupplyRevokeFailed] = useState(false);

  const accessControlMode = getTokenAccessControlMode(token);
  const controlListCopy = getControlListCopy(accessControlMode, t);
  const showControlList = hasAccessControlList(accessControlMode);

  const {
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
    revalidateAfterSuccess,
  } = useTokenOperationData({
    token,
    shouldLoadAuthorityWallets,
    shouldLoadSupportingData,
    showControlList,
  });
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

  const tokenBasePath = `/api/dashboard/issuance/tokens/${token.id}`;
  const explorerHref = getExplorerHref(token.mintAddress);
  const canDeployToken = token.status === "pending" && !token.mintAddress;
  const {
    pauseDisabledReason,
    metadataAuthority,
    withWalletLoadError,
    deployDisabledReason,
    mintSignerSelection,
    burnSignerSelection,
    seizeSignerSelection,
    forceBurnSignerSelection,
    freezeSignerSelection,
    pauseSignerSelection,
    permissionRows,
    authoritySummary,
    displayedMintAuthority,
    effectiveMintDisabledReason,
    effectiveBurnDisabledReason,
    effectiveSeizeDisabledReason,
    effectiveForceBurnDisabledReason,
    effectiveFreezeDisabledReason,
    effectivePauseDisabledReason,
  } = getTokenOperationPermissions({
    token,
    authorityWallets,
    authorityWalletsLoading,
    authorityWalletsError,
    canManageTokenAdmin,
    t,
  });
  const extensionRows = useMemo(() => getExtensionRows(token, t), [token, t]);

  // Lock supply = mint the remainder, then revoke the mint authority. Both legs
  // are signed by the current mint authority, so mintSignerSelection covers the
  // whole flow and the modal needs only one signer picker.
  const lockSupplyRemaining = getRemainingMintableSupply(token);
  const effectiveLockSupplyDisabledReason =
    getLockSupplyDisabledReason(token, t) ?? mintSignerSelection.unavailableReason;

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
    t,
  });
  const mintValidationErrors = getMintValidationErrors({
    token,
    destination: mintForm.destination,
    amount: mintForm.amount,
    allowlistEntries,
    t,
  });
  const burnValidationReason = getBurnValidationReason({
    token,
    source: burnForm.source,
    amount: burnForm.amount,
    signerWallet: selectedBurnSignerWallet,
    walletOptions: authorityWallets,
    t,
  });
  const burnValidationErrors = getBurnValidationErrors({
    token,
    source: burnForm.source,
    amount: burnForm.amount,
    signerWallet: selectedBurnSignerWallet,
    walletOptions: authorityWallets,
    t,
  });
  const seizeValidationReason = getSeizeValidationReason({
    token,
    source: seizeForm.source,
    destination: seizeForm.destination,
    amount: seizeForm.amount,
    allowlistEntries,
    walletOptions: authorityWallets,
    t,
  });
  const seizeValidationErrors = getSeizeValidationErrors({
    token,
    source: seizeForm.source,
    destination: seizeForm.destination,
    amount: seizeForm.amount,
    allowlistEntries,
    walletOptions: authorityWallets,
    t,
  });
  const forceBurnValidationReason = getForceBurnValidationReason({
    token,
    source: forceBurnForm.source,
    amount: forceBurnForm.amount,
    walletOptions: authorityWallets,
    t,
  });
  const forceBurnValidationErrors = getForceBurnValidationErrors({
    token,
    source: forceBurnForm.source,
    amount: forceBurnForm.amount,
    walletOptions: authorityWallets,
    t,
  });

  const fundManagementDisabledReasons: Record<FundManagementModalAction, string | null> = {
    mint: effectiveMintDisabledReason ?? mintValidationReason,
    burn: effectiveBurnDisabledReason ?? burnValidationReason,
  };
  // Allowlist mutations only touch the chain when the token has an on-chain ABL
  // list; then the list is governed by the freeze-authority delegate (sRFC-37
  // Token ACL), so it needs the freeze authority under SDP custody — same check
  // as freeze. DB-only allowlists need no signer and stay ungated.
  const allowlistDisabledReason = token.ablListAddress
    ? freezeSignerSelection.unavailableReason
    : null;

  const complianceActionDisabledReasons: Partial<Record<AdminAction, string | null>> = {
    seize: effectiveSeizeDisabledReason ?? seizeValidationReason,
    "force-burn": effectiveForceBurnDisabledReason ?? forceBurnValidationReason,
    freeze: effectiveFreezeDisabledReason,
    pause: effectivePauseDisabledReason,
    allowlist: allowlistDisabledReason,
  };

  const handleCopy = async (
    value: string | null,
    successMessage = t("DashboardIssuance.management.copied")
  ) => {
    if (!value) {
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      toast.success(successMessage);
    } catch {
      toast.error(t("DashboardIssuance.management.unableToCopy"));
    }
  };

  // Fees are always Kora-sponsored and the server resolves the signing wallet
  // (token signer, then org custody fallback), so deploy fires immediately —
  // no modal, no confirmation dialog.
  const deployToken = () => {
    void runActionImmediately(
      {
        label: t("DashboardIssuance.management.deployToken"),
        method: "POST",
        path: `${tokenBasePath}/deploy`,
        body: {
          feePayment: "sponsored",
        },
      },
      {
        submitToast: t("DashboardIssuance.management.submittingDeploy"),
        successToast: t("DashboardIssuance.management.deployFinalized"),
      }
    );
  };

  const handleRefreshSupply = () => {
    if (isRefreshingSupply || isPending) return;
    refreshSupply(
      {
        label: t("DashboardIssuance.management.refreshSupply"),
        method: "POST",
        path: `${tokenBasePath}/refresh-supply`,
        body: {},
      },
      {
        submitToast: t("DashboardIssuance.management.refreshingSupply"),
        successToast: t("DashboardIssuance.management.supplyUpdated"),
      }
    );
  };

  const handleMint = () => {
    if (effectiveMintDisabledReason) {
      toast.error(effectiveMintDisabledReason);
      return;
    }

    const destination = mintForm.destination.trim();
    const amount = mintForm.amount.trim();
    if (!destination || !amount) {
      toast.error(t("DashboardIssuance.management.mintDetailsRequired"));
      return;
    }
    if (mintValidationReason) {
      toast.error(mintValidationReason);
      return;
    }
    if (!isPositiveAmount(amount)) {
      toast.error(t("DashboardIssuance.management.amountPositive"));
      return;
    }

    runAction(
      {
        label: t("DashboardIssuance.management.mintTokens"),
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
        confirmationTitle: t("DashboardIssuance.management.mintConfirmationTitle"),
        confirmationDescription: t("DashboardIssuance.management.mintConfirmationDescription"),
        confirmationDetails: [
          { label: t("DashboardIssuance.forms.amount"), value: `${amount} ${token.symbol}` },
          { label: t("DashboardIssuance.forms.destination"), value: destination },
          ...(token.requiresAllowlist
            ? [
                {
                  label: t("DashboardIssuance.management.recipientApproval"),
                  value: t("DashboardIssuance.management.recipientApprovalAutomatic"),
                },
              ]
            : []),
          {
            label: t("DashboardIssuance.draftForm.network"),
            value: sdpEnvironment === "production" ? "Mainnet" : "Devnet",
          },
        ],
        confirmButtonLabel: t("DashboardIssuance.management.mintNow"),
        submitToast: t("DashboardIssuance.management.submittingMint"),
        successToast: t("DashboardIssuance.management.mintFinalized"),
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
      toast.error(t("DashboardIssuance.management.burnDetailsRequired"));
      return;
    }
    if (burnValidationReason) {
      toast.error(burnValidationReason);
      return;
    }
    if (!isPositiveAmount(amount)) {
      toast.error(t("DashboardIssuance.management.amountPositive"));
      return;
    }

    runAction(
      {
        label: t("DashboardIssuance.management.burnTokens"),
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
        confirmationTitle: t("DashboardIssuance.management.burnConfirmationTitle"),
        confirmationDescription: t("DashboardIssuance.management.burnConfirmationDescription"),
        confirmationDetails: [
          { label: t("DashboardIssuance.forms.amount"), value: `${amount} ${token.symbol}` },
          { label: t("DashboardIssuance.forms.source"), value: source },
          {
            label: t("DashboardIssuance.draftForm.network"),
            value: sdpEnvironment === "production" ? "Mainnet" : "Devnet",
          },
        ],
        confirmButtonLabel: t("DashboardIssuance.management.burnNow"),
        submitToast: t("DashboardIssuance.management.submittingBurn"),
        successToast: t("DashboardIssuance.management.burnFinalized"),
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
      toast.error(t("DashboardIssuance.management.seizeDetailsRequired"));
      return;
    }
    if (seizeValidationReason) {
      toast.error(seizeValidationReason);
      return;
    }
    if (!isPositiveAmount(amount)) {
      toast.error(t("DashboardIssuance.management.amountPositive"));
      return;
    }

    runAction(
      {
        label: t("DashboardIssuance.compliance.forceTransfer"),
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
        confirmationTitle: t("DashboardIssuance.management.seizeConfirmationTitle"),
        confirmationDescription: t("DashboardIssuance.management.seizeConfirmationDescription"),
        confirmationWarning: t("DashboardIssuance.management.seizeConfirmationDescription"),
        confirmationDetails: [
          { label: t("DashboardIssuance.forms.amount"), value: `${amount} ${token.symbol}` },
          { label: t("DashboardIssuance.forms.source"), value: source },
          { label: t("DashboardIssuance.forms.destination"), value: destination },
          {
            label: t("DashboardIssuance.draftForm.network"),
            value: sdpEnvironment === "production" ? "Mainnet" : "Devnet",
          },
        ],
        confirmButtonLabel: t("DashboardIssuance.management.transferNow"),
        submitToast: t("DashboardIssuance.management.submittingForceTransfer"),
        successToast: t("DashboardIssuance.management.forceTransferFinalized"),
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
      toast.error(t("DashboardIssuance.management.forceBurnDetailsRequired"));
      return;
    }
    if (forceBurnValidationReason) {
      toast.error(forceBurnValidationReason);
      return;
    }
    if (!isPositiveAmount(amount)) {
      toast.error(t("DashboardIssuance.management.amountPositive"));
      return;
    }

    runAction(
      {
        label: t("DashboardIssuance.compliance.forceBurn"),
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
        confirmationTitle: t("DashboardIssuance.management.forceBurnConfirmationTitle"),
        confirmationDescription: t("DashboardIssuance.management.forceBurnConfirmationDescription"),
        confirmationWarning: t("DashboardIssuance.management.forceBurnConfirmationDescription"),
        confirmationDetails: [
          { label: t("DashboardIssuance.forms.amount"), value: `${amount} ${token.symbol}` },
          { label: t("DashboardIssuance.forms.source"), value: source },
          {
            label: t("DashboardIssuance.draftForm.network"),
            value: sdpEnvironment === "production" ? "Mainnet" : "Devnet",
          },
        ],
        confirmButtonLabel: t("DashboardIssuance.management.forceBurnNow"),
        submitToast: t("DashboardIssuance.management.submittingForceBurn"),
        successToast: t("DashboardIssuance.management.forceBurnFinalized"),
      }
    );
  };

  const handleAuthorityUpdate = () => {
    runAction(
      {
        label: t("DashboardIssuance.management.updateAuthority"),
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
        confirmationTitle: t("DashboardIssuance.management.authorityConfirmationTitle"),
        confirmationDescription: t("DashboardIssuance.management.authorityConfirmationDescription"),
        confirmButtonLabel: t("DashboardIssuance.management.updateNow"),
        submitToast: t("DashboardIssuance.management.submittingAuthority"),
        successToast: t("DashboardIssuance.management.authorityFinalized"),
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
        label: pause
          ? t("DashboardIssuance.management.pauseToken")
          : t("DashboardIssuance.management.unpauseToken"),
        method: "POST",
        path: `${tokenBasePath}/${pause ? "pause" : "unpause"}`,
        body: {},
      },
      {
        requiresConfirmation: true,
        confirmationTitle: pause
          ? t("DashboardIssuance.management.pauseConfirmationTitle")
          : t("DashboardIssuance.management.unpauseConfirmationTitle"),
        confirmationWarning: pause
          ? t("DashboardIssuance.management.pauseImpactWarning")
          : t("DashboardIssuance.management.unpauseImpactWarning"),
        confirmationDescription: pause
          ? t("DashboardIssuance.management.pauseConfirmationDescription")
          : t("DashboardIssuance.management.unpauseConfirmationDescription"),
        confirmButtonLabel: pause
          ? t("DashboardIssuance.management.pauseNow")
          : t("DashboardIssuance.management.unpauseNow"),
        submitToast: pause
          ? t("DashboardIssuance.management.submittingPause")
          : t("DashboardIssuance.management.submittingUnpause"),
        successToast: pause
          ? t("DashboardIssuance.management.pauseFinalized")
          : t("DashboardIssuance.management.unpauseFinalized"),
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
      toast.error(t("DashboardIssuance.management.accountAddressRequired"));
      return;
    }

    if (unfreeze) {
      runAction(
        {
          label: t("DashboardIssuance.management.unfreezeAccount"),
          method: "POST",
          path: `${tokenBasePath}/unfreeze`,
          body: {
            accountAddress,
          },
        },
        {
          requiresConfirmation: true,
          confirmationTitle: t("DashboardIssuance.management.unfreezeConfirmationTitle"),
          confirmationDescription: t(
            "DashboardIssuance.management.unfreezeConfirmationDescription"
          ),
          confirmationWarning: t("DashboardIssuance.management.unfreezeConfirmationDescription"),
          confirmationDetails: [
            {
              label: t("DashboardIssuance.draftForm.token"),
              value: `${token.name} (${token.symbol})`,
            },
            { label: t("DashboardIssuance.forms.walletAddress"), value: accountAddress },
            {
              label: t("DashboardIssuance.draftForm.network"),
              value: sdpEnvironment === "production" ? "Mainnet" : "Devnet",
            },
          ],
          confirmButtonLabel: t("DashboardIssuance.management.unfreezeNow"),
          submitToast: t("DashboardIssuance.management.submittingUnfreeze"),
          successToast: t("DashboardIssuance.management.unfreezeFinalized"),
        }
      );
      return;
    }

    runAction(
      {
        label: t("DashboardIssuance.management.freezeAccount"),
        method: "POST",
        path: `${tokenBasePath}/freeze`,
        body: {
          accountAddress,
          reason: asOptionalString(freezeForm.reason),
        },
      },
      {
        requiresConfirmation: true,
        confirmationTitle: t("DashboardIssuance.management.freezeConfirmationTitle"),
        confirmationDescription: t("DashboardIssuance.management.freezeConfirmationDescription"),
        confirmationWarning: t("DashboardIssuance.management.freezeConfirmationDescription"),
        confirmationDetails: [
          {
            label: t("DashboardIssuance.draftForm.token"),
            value: `${token.name} (${token.symbol})`,
          },
          { label: t("DashboardIssuance.forms.walletAddress"), value: accountAddress },
          {
            label: t("DashboardIssuance.draftForm.network"),
            value: sdpEnvironment === "production" ? "Mainnet" : "Devnet",
          },
        ],
        confirmButtonLabel: t("DashboardIssuance.management.freezeNow"),
        submitToast: t("DashboardIssuance.management.submittingFreeze"),
        successToast: t("DashboardIssuance.management.freezeFinalized"),
      }
    );
  };

  const handleAddAllowlist = () => {
    if (allowlistDisabledReason) {
      toast.error(allowlistDisabledReason);
      return;
    }
    const address = allowlistForm.address.trim();
    if (!address) {
      toast.error(
        controlListCopy?.addressRequiredMessage ??
          t("DashboardIssuance.management.allowlistAddressRequired")
      );
      return;
    }

    runAction({
      label: controlListCopy?.addActionLabel ?? t("DashboardIssuance.management.addAllowlistEntry"),
      method: "POST",
      path: `${tokenBasePath}/allowlist`,
      body: {
        address,
        label: asOptionalString(allowlistForm.label),
      },
    });
  };

  const handleRemoveAllowlist = (entryId: string) => {
    if (allowlistDisabledReason) {
      toast.error(allowlistDisabledReason);
      return;
    }
    // The list + labels/count refresh via the allowlist SWR keys in
    // revalidateAfterSuccess, so no local optimistic update is needed here.
    runAction({
      label:
        controlListCopy?.removeActionLabel ??
        t("DashboardIssuance.management.removeAllowlistEntry"),
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
        t,
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
        label: t("DashboardIssuance.management.updateAuthorityLabel", {
          authority: authorityModalRow.title,
        }),
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
        submitToast: t("DashboardIssuance.management.updatingAuthority", {
          authority: authorityModalRow.title.toLowerCase(),
        }),
        successToast: t("DashboardIssuance.management.authorityUpdated", {
          authority: authorityModalRow.title,
        }),
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
          t,
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

  const openLockSupplyModal = () => {
    if (effectiveLockSupplyDisabledReason) {
      return;
    }

    setLockSupplyForm({
      destination: "",
      // The same authority signs both the mint and the revoke.
      signingWalletId: mintSignerSelection.defaultWalletId,
    });
    setLockSupplyMinted(false);
    setLockSupplyRevokeFailed(false);
    setLockSupplyModalOpen(true);
  };

  const closeLockSupplyModal = () => {
    if (isPending) {
      return;
    }

    setLockSupplyModalOpen(false);
  };

  const closeFundManagementModal = () => {
    if (isPending) {
      return;
    }

    setFundManagementModalAction(null);
    setMintForm(createInitialMintForm);
    setBurnForm(createInitialBurnForm);
  };

  /**
   * Make the configured max supply a real on-chain cap: mint the remainder, then
   * revoke the mint authority. SPL has no supply-cap field and `InitializeMint`
   * requires a mint authority, so a fixed-supply mint can only be reached this
   * way — mint everything, then set the authority to None (irreversible).
   *
   * Two transactions, so there is a real window where the mint lands and the
   * revoke does not. That leaves the token fully minted with a live authority, so
   * the flow reports the partial state and lets the operator retry just the
   * revoke: `lockSupplyMinted` suppresses the mint leg in-session, and after the
   * token refetches `lockSupplyRemaining` is "0" anyway, which suppresses it for
   * any later attempt. The revoke is idempotent — re-revoking an already-revoked
   * authority is rejected by the API, not silently duplicated.
   */
  const handleLockSupply = async () => {
    if (effectiveLockSupplyDisabledReason) {
      toast.error(effectiveLockSupplyDisabledReason);
      return;
    }
    if (lockSupplyRemaining === null) {
      toast.error(t("DashboardIssuance.management.lockSupplyAmountUnavailable"));
      return;
    }

    const signingWalletId = lockSupplyForm.signingWalletId || undefined;
    const destination = lockSupplyForm.destination.trim();
    const needsMint = !lockSupplyMinted && isPositiveAmount(lockSupplyRemaining);

    if (needsMint && !destination) {
      toast.error(t("DashboardIssuance.management.lockSupplyDestinationRequired"));
      return;
    }

    if (needsMint) {
      const mintResult = await runActionImmediately(
        {
          label: t("DashboardIssuance.management.lockSupplyMintLabel"),
          method: "POST",
          path: `${tokenBasePath}/mint`,
          body: {
            signingWalletId,
            mint: { destination, amount: lockSupplyRemaining },
          },
        },
        {
          submitToast: t("DashboardIssuance.management.lockSupplyMinting", {
            amount: lockSupplyRemaining,
          }),
          successToast: t("DashboardIssuance.management.lockSupplyMinted", {
            amount: lockSupplyRemaining,
          }),
        }
      );

      if (!mintResult.ok) {
        // Nothing landed, so there is no partial state to report — the operator
        // can just resubmit.
        return;
      }
      setLockSupplyMinted(true);
    }

    const revokeResult = await runActionImmediately(
      {
        label: t("DashboardIssuance.management.lockSupplyRevokeLabel"),
        method: "POST",
        path: `${tokenBasePath}/authority`,
        body: {
          signingWalletId,
          authority: { role: "mint", newAuthority: null },
        },
      },
      {
        submitToast: t("DashboardIssuance.management.lockSupplyRevoking"),
        successToast: t("DashboardIssuance.management.lockSupplyLocked"),
      }
    );

    if (revokeResult.ok) {
      setLockSupplyRevokeFailed(false);
      setLockSupplyMinted(false);
      setLockSupplyModalOpen(false);
      return;
    }

    // Mint landed, revoke did not: surface it in the modal so the operator sees
    // the supply is now at the cap but still mintable, with a retry for leg 2.
    setLockSupplyRevokeFailed(true);
  };

  const submitFundManagementAction = (action: FundManagementModalAction) => {
    closeFundManagementModal();

    switch (action) {
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
      case "allowlist":
        return {
          signerWallets: [] as PaymentsDashboardWallet[],
          // On-chain allowlist mutations are signed by the freeze-authority
          // delegate, so gate on the same custody availability.
          signerUnavailableReason: allowlistDisabledReason,
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
    isRefreshingSupply,
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
    // Incomplete form values must not prevent reopening an operation.
    operationAvailability: {
      mint: effectiveMintDisabledReason,
      burn: effectiveBurnDisabledReason,
      seize: effectiveSeizeDisabledReason,
      "force-burn": effectiveForceBurnDisabledReason,
    },
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
    authoritySummary,
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
    deployDisabledReason,
    fundManagementModalAction,
    openFundManagementModal,
    closeFundManagementModal,
    submitFundManagementAction,
    // lock supply (mint to cap, then revoke the mint authority)
    lockSupplyModalOpen,
    openLockSupplyModal,
    closeLockSupplyModal,
    lockSupplyForm,
    setLockSupplyForm,
    lockSupplyRemaining,
    lockSupplyMinted,
    lockSupplyRevokeFailed,
    lockSupplyDisabledReason: effectiveLockSupplyDisabledReason,
    lockSupplySignerSelection: mintSignerSelection,
    handleLockSupply,
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
    deployToken,
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
