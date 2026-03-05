"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { TokenActionConfirmationDialog } from "./token-action-confirmation-dialog";
import { TokenActionForms } from "./token-action-forms";
import { TokenActionResponseCard } from "./token-action-response-card";
import { TokenControlListsSection } from "./token-control-lists-section";
import { TokenManagementHeader } from "./token-management-header";
import type {
  AdminAction,
  SettingsTab,
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
  getExplorerHref,
  getExtensionRows,
  getPermissionRows,
  isPositiveAmount,
} from "./token-management-workspace.utils";
import { TokenOverviewSection } from "./token-overview-section";
import { TokenSettingsSection } from "./token-settings-section";
import { TokenTransactionsSection } from "./token-transactions-section";
import { useTokenActionRunner } from "./use-token-action-runner";

export function TokenManagementWorkspace({
  token,
  tokenError,
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
}: TokenManagementWorkspaceProps) {
  const {
    isPending,
    lastActionResult,
    actionConfirmation,
    runAction,
    dismissActionConfirmation,
    confirmAction,
  } = useTokenActionRunner();
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("permissions");
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false);
  const [activeAction, setActiveAction] = useState<AdminAction | null>("update-metadata");
  const [metadataForm, setMetadataForm] = useState(() => createInitialMetadataForm(token));
  const [mintForm, setMintForm] = useState(createInitialMintForm);
  const [burnForm, setBurnForm] = useState(createInitialBurnForm);
  const [seizeForm, setSeizeForm] = useState(createInitialSeizeForm);
  const [forceBurnForm, setForceBurnForm] = useState(createInitialForceBurnForm);
  const [authorityForm, setAuthorityForm] = useState(createInitialAuthorityForm);
  const [freezeForm, setFreezeForm] = useState(createInitialFreezeForm);
  const [allowlistForm, setAllowlistForm] = useState(createInitialAllowlistForm);

  const tokenBasePath = `/v1/issuance/tokens/${token.id}`;
  const explorerHref = getExplorerHref(token.mintAddress);
  const canDeployToken = token.status === "pending" && !token.mintAddress;
  const metadataAuthority = token.metadataAuthority ?? token.mintAuthority;
  const permissionRows = getPermissionRows(token, metadataAuthority);
  const extensionRows = getExtensionRows(token);

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
        status: metadataForm.status,
      },
    });
  };

  const handleDeploy = (mode: "prepare" | "execute") => {
    runAction(
      {
        label: `Deploy token (${mode})`,
        method: "POST",
        path: `${tokenBasePath}/deploy${mode === "prepare" ? "/prepare" : ""}`,
        body: {},
      },
      mode === "execute"
        ? {
            requiresConfirmation: true,
            confirmationTitle: "Deploy token?",
            confirmationDescription: "This will submit the deploy transaction on-chain.",
            confirmButtonLabel: "Deploy now",
            submitToast: "Submitting deploy transaction...",
            successToast: "Deploy transaction finalized.",
          }
        : undefined
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

  const handleMint = (mode: "prepare" | "execute") => {
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
        label: `Mint (${mode})`,
        method: "POST",
        path: `${tokenBasePath}/mint${mode === "prepare" ? "/prepare" : ""}`,
        body: {
          mint: {
            destination,
            amount,
            memo: asOptionalString(mintForm.memo),
          },
        },
      },
      mode === "execute"
        ? {
            requiresConfirmation: true,
            confirmationTitle: "Mint tokens?",
            confirmationDescription: "This will submit a mint transaction on-chain.",
            confirmButtonLabel: "Mint now",
            submitToast: "Submitting mint transaction...",
            successToast: "Mint transaction finalized.",
          }
        : undefined
    );
  };

  const handleBurn = (mode: "prepare" | "execute") => {
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
        label: `Burn (${mode})`,
        method: "POST",
        path: `${tokenBasePath}/burn${mode === "prepare" ? "/prepare" : ""}`,
        body: {
          burn: {
            source,
            amount,
            memo: asOptionalString(burnForm.memo),
          },
        },
      },
      mode === "execute"
        ? {
            requiresConfirmation: true,
            confirmationTitle: "Burn tokens?",
            confirmationDescription: "This will submit a burn transaction on-chain.",
            confirmButtonLabel: "Burn now",
            submitToast: "Submitting burn transaction...",
            successToast: "Burn transaction finalized.",
          }
        : undefined
    );
  };

  const handleSeize = (mode: "prepare" | "execute") => {
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
        label: `Seize (${mode})`,
        method: "POST",
        path: `${tokenBasePath}/seize${mode === "prepare" ? "/prepare" : ""}`,
        body: {
          seize: {
            source,
            destination,
            amount,
            delegateAuthority: asOptionalString(seizeForm.delegateAuthority),
            memo: asOptionalString(seizeForm.memo),
          },
        },
      },
      mode === "execute"
        ? {
            requiresConfirmation: true,
            confirmationTitle: "Force transfer?",
            confirmationDescription:
              "This will submit a seize (force transfer) transaction on-chain.",
            confirmButtonLabel: "Transfer now",
            submitToast: "Submitting force transfer transaction...",
            successToast: "Force transfer transaction finalized.",
          }
        : undefined
    );
  };

  const handleForceBurn = (mode: "prepare" | "execute") => {
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
        label: `Force Burn (${mode})`,
        method: "POST",
        path: `${tokenBasePath}/force-burn${mode === "prepare" ? "/prepare" : ""}`,
        body: {
          forceBurn: {
            source,
            amount,
            delegateAuthority: asOptionalString(forceBurnForm.delegateAuthority),
            memo: asOptionalString(forceBurnForm.memo),
          },
        },
      },
      mode === "execute"
        ? {
            requiresConfirmation: true,
            confirmationTitle: "Force burn tokens?",
            confirmationDescription: "This will submit a force-burn transaction on-chain.",
            confirmButtonLabel: "Force burn now",
            submitToast: "Submitting force-burn transaction...",
            successToast: "Force-burn transaction finalized.",
          }
        : undefined
    );
  };

  const handleAuthorityUpdate = (mode: "prepare" | "execute") => {
    runAction(
      {
        label: `Update authority (${mode})`,
        method: "POST",
        path: `${tokenBasePath}/authority${mode === "prepare" ? "/prepare" : ""}`,
        body: {
          authority: {
            role: authorityForm.role,
            currentAuthority: asOptionalString(authorityForm.currentAuthority),
            newAuthority: authorityForm.newAuthority.trim() || null,
          },
        },
      },
      mode === "execute"
        ? {
            requiresConfirmation: true,
            confirmationTitle: "Update authority?",
            confirmationDescription: "This will submit an authority update transaction on-chain.",
            confirmButtonLabel: "Update now",
            submitToast: "Submitting authority update transaction...",
            successToast: "Authority update finalized.",
          }
        : undefined
    );
  };

  const handlePause = (pause: boolean) => {
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

  const selectAction = (action: AdminAction) => {
    setActiveAction(action);
    setIsActionMenuOpen(false);
  };

  return (
    <div className="space-y-8 pb-8">
      <TokenManagementHeader
        tokenName={token.name}
        tokenSymbol={token.symbol}
        explorerHref={explorerHref}
        canDeployToken={canDeployToken}
        isPending={isPending}
        isActionMenuOpen={isActionMenuOpen}
        onActionMenuToggle={() => setIsActionMenuOpen((open) => !open)}
        onActionMenuClose={() => setIsActionMenuOpen(false)}
        onSelectAction={selectAction}
        onDeploy={() => {
          if (!canDeployToken) {
            return;
          }
          setIsActionMenuOpen(false);
          handleDeploy("execute");
        }}
      />

      {tokenError ? (
        <div className="rounded-xl border border-[#c71f37]/20 bg-[#c71f37]/[0.03] px-4 py-3">
          <p className="text-sm font-medium text-[#8a1f2a]">Token load warning</p>
          <p className="mt-1 text-sm text-[#8a1f2a]">{tokenError}</p>
        </div>
      ) : null}

      <TokenOverviewSection token={token} />

      <TokenSettingsSection
        settingsTab={settingsTab}
        permissionRows={permissionRows}
        extensionRows={extensionRows}
        onSettingsTabChange={setSettingsTab}
        onCopy={handleCopy}
        onEditAction={setActiveAction}
      />

      <TokenActionForms
        activeAction={activeAction}
        isPending={isPending}
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

      <div className="grid gap-4 xl:grid-cols-2">
        <TokenTransactionsSection
          transactions={transactions}
          transactionsError={transactionsError}
          transactionsTotal={transactionsTotal}
          transactionsHasMore={transactionsHasMore}
        />
        <TokenControlListsSection
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

      <TokenActionResponseCard result={lastActionResult} />

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
