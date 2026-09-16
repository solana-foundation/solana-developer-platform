import type { PaymentsDashboardWallet, Token } from "@sdp/types";
import type { useTranslations } from "@/i18n/provider";
import type { PermissionControlStatus } from "../token-management-workspace.types";
import {
  classifyAuthorityControl,
  getDisplayedAuthorityAddress,
  getPermissionRows,
  getSignerSelectionForAction,
  getTokenActionDisabledReasons,
  summarizeAuthorityControl,
} from "../token-management-workspace.utils";

export function getTokenOperationPermissions({
  token,
  authorityWallets,
  authorityWalletsLoading,
  authorityWalletsError,
  canManageTokenAdmin,
  t,
}: {
  token: Token;
  authorityWallets: PaymentsDashboardWallet[];
  authorityWalletsLoading: boolean;
  authorityWalletsError: string | null;
  canManageTokenAdmin: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const {
    mintDisabledReason,
    burnDisabledReason,
    seizeDisabledReason,
    forceBurnDisabledReason,
    pauseDisabledReason,
    freezeDisabledReason,
  } = getTokenActionDisabledReasons(token, t);
  const metadataAuthority = token.metadataAuthority ?? token.mintAuthority;

  const withWalletLoadError = <T extends { unavailableReason: string | null }>(selection: T): T => {
    if (authorityWalletsLoading && selection.unavailableReason) {
      return {
        ...selection,
        unavailableReason: t("DashboardIssuance.management.loadingSignerWallets"),
      };
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
      getSignerSelectionForAction({ action, token, authorityWallets, metadataAuthority, t })
    );
  const deploySignerSelection = signerSelectionFor("deploy");
  const deployDisabledReason = deploySignerSelection.unavailableReason;
  const mintSignerSelection = signerSelectionFor("mint");
  const burnSignerSelection = signerSelectionFor("burn");
  const seizeSignerSelection = signerSelectionFor("seize");
  const forceBurnSignerSelection = signerSelectionFor("force-burn");
  const freezeSignerSelection = signerSelectionFor("freeze");
  const pauseSignerSelection = signerSelectionFor("pause");

  // Custody control is only knowable once the authority wallets have loaded
  // without error; until then a row's control status is "unknown" (no badge).
  const authorityControlKnown = !authorityWalletsLoading && !authorityWalletsError;
  const permissionRows = getPermissionRows(token, metadataAuthority, t).flatMap((row) => {
    if (
      row.id === "freeze-authority" &&
      !(token.isFreezable || token.freezeAuthority || token.template === "stablecoin")
    )
      return [];
    if (
      row.id === "permanent-delegate" &&
      !(token.extensions?.permanentDelegate || token.template === "stablecoin")
    )
      return [];
    const displayedAuthorityAddress = getDisplayedAuthorityAddress({
      token,
      role: row.authorityRole,
      metadataAuthority,
      authorityWallets,
    });
    const rowWithDisplayedValue = { ...row, value: displayedAuthorityAddress };
    const controlStatus: PermissionControlStatus = classifyAuthorityControl(
      displayedAuthorityAddress,
      authorityWallets,
      authorityControlKnown
    );

    return [
      {
        ...rowWithDisplayedValue,
        controlStatus,
        removalDisabledReason:
          row.authorityRole === "freeze" && token.ablListAddress
            ? t("DashboardIssuance.authority.freezeReassignOnly")
            : null,
        editDisabledReason: canManageTokenAdmin
          ? withWalletLoadError(
              getSignerSelectionForAction({
                action: "authority",
                token,
                authorityWallets,
                metadataAuthority,
                permissionRow: rowWithDisplayedValue,
                t,
              })
            ).unavailableReason
          : t("DashboardIssuance.management.onlyAdminsCanEditAuthorities"),
      },
    ];
  });

  // Roll-up for the overview "Managed authorities: N of M" tile and the
  // permissions-tab external-authority warning. Shared with the issuance list's
  // expanded card so both surfaces count identically.
  const authoritySummary = summarizeAuthorityControl({
    token,
    authorityWallets,
    controlKnown: authorityControlKnown,
    t,
  });
  const displayedMintAuthority = getDisplayedAuthorityAddress({
    token,
    role: "mint",
    metadataAuthority,
    authorityWallets,
  });

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

  return {
    pauseDisabledReason,
    metadataAuthority,
    withWalletLoadError,
    deploySignerSelection,
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
  };
}
