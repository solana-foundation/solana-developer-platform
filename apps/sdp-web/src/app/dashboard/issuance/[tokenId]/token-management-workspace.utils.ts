import type { PaymentsDashboardWallet, Token } from "@sdp/types";
import type {
  ActionExecutionInput,
  ActionExecutionResult,
  AdminAction,
  AllowlistFormState,
  AuthorityFormState,
  BurnFormState,
  ExecuteRouteResponse,
  ExtensionRow,
  ForceBurnFormState,
  FreezeFormState,
  MetadataFormState,
  MintFormState,
  PermissionRow,
  SeizeFormState,
  TokenManagementTab,
} from "./token-management-workspace.types";

export const SOLANA_ADDRESS_PATTERN = "[1-9A-HJ-NP-Za-km-z]{32,44}";
export const NON_WHITESPACE_PATTERN = ".*\\S.*";

export function createInitialMetadataForm(token: Token): MetadataFormState {
  return {
    name: token.name,
    description: token.description ?? "",
    uri: token.uri ?? "",
    imageUrl: token.imageUrl ?? "",
    status: token.status === "paused" ? "paused" : "active",
  };
}

export function createInitialMintForm(): MintFormState {
  return {
    destination: "",
    amount: "",
    memo: "",
    signingWalletId: "",
  };
}

export function createInitialBurnForm(): BurnFormState {
  return {
    source: "",
    amount: "",
    memo: "",
    signingWalletId: "",
  };
}

export function createInitialSeizeForm(): SeizeFormState {
  return {
    source: "",
    destination: "",
    amount: "",
    delegateAuthority: "",
    memo: "",
    signingWalletId: "",
  };
}

export function createInitialForceBurnForm(): ForceBurnFormState {
  return {
    source: "",
    amount: "",
    delegateAuthority: "",
    memo: "",
    signingWalletId: "",
  };
}

export function createInitialAuthorityForm(): AuthorityFormState {
  return {
    role: "mint",
    currentAuthority: "",
    newAuthority: "",
  };
}

export function createInitialFreezeForm(): FreezeFormState {
  return {
    accountAddress: "",
    reason: "",
  };
}

export function createInitialAllowlistForm(): AllowlistFormState {
  return {
    address: "",
    label: "",
  };
}

export function formatDate(value: string | null | undefined): string {
  if (!value) {
    return "—";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

export function stringifyBody(body: unknown): string {
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return String(body);
  }
}

export function asOptionalString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function isPositiveAmount(value: string): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

export function hasReachedMaxSupply(totalSupply: string, maxSupply: string | null): boolean {
  if (!maxSupply) {
    return false;
  }

  const comparison = compareNonNegativeDecimalStrings(totalSupply, maxSupply);
  return comparison !== null && comparison >= 0;
}

function compareNonNegativeDecimalStrings(left: string, right: string): number | null {
  const leftMatch = /^(\d+)(?:\.(\d+))?$/.exec(left.trim());
  const rightMatch = /^(\d+)(?:\.(\d+))?$/.exec(right.trim());
  if (!leftMatch || !rightMatch) {
    return null;
  }

  const leftWhole = leftMatch[1].replace(/^0+(?=\d)/, "");
  const rightWhole = rightMatch[1].replace(/^0+(?=\d)/, "");
  if (leftWhole.length !== rightWhole.length) {
    return leftWhole.length > rightWhole.length ? 1 : -1;
  }

  if (leftWhole !== rightWhole) {
    return leftWhole > rightWhole ? 1 : -1;
  }

  const leftFraction = (leftMatch[2] ?? "").replace(/0+$/, "");
  const rightFraction = (rightMatch[2] ?? "").replace(/0+$/, "");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const normalizedLeftFraction = leftFraction.padEnd(scale, "0");
  const normalizedRightFraction = rightFraction.padEnd(scale, "0");

  if (normalizedLeftFraction === normalizedRightFraction) {
    return 0;
  }

  return normalizedLeftFraction > normalizedRightFraction ? 1 : -1;
}

function getTokenLifecycleDisabledReason(
  token: Token,
  verb: "mint" | "burn" | "force transfer" | "force burn"
): string | null {
  switch (token.status) {
    case "active":
      return null;
    case "paused":
      return `Token is paused. Unpause it to ${verb}.`;
    case "pending":
      return `Token must be active to ${verb}.`;
    case "revoked":
      return `Token is revoked and can no longer ${verb}.`;
    default:
      return `Token must be active to ${verb}.`;
  }
}

function getPauseAuthorityAddress(token: Token): string | null {
  return token.extensions?.pausable?.authority ?? token.mintAuthority ?? null;
}

export function getTokenActionDisabledReasons(token: Token): {
  mintDisabledReason: string | null;
  burnDisabledReason: string | null;
  seizeDisabledReason: string | null;
  forceBurnDisabledReason: string | null;
  pauseDisabledReason: string | null;
  freezeDisabledReason: string | null;
} {
  const hasSupply = isPositiveAmount(token.totalSupply);
  const maxSupplyReached = hasReachedMaxSupply(token.totalSupply, token.maxSupply);
  const mintDisabledReason = getTokenLifecycleDisabledReason(token, "mint")
    ? getTokenLifecycleDisabledReason(token, "mint")
    : !token.isMintable
      ? "Minting is disabled for this token."
      : !token.mintAuthority
        ? "No mint authority is configured."
        : maxSupplyReached
          ? "Maximum supply has already been reached."
          : null;
  const burnDisabledReason =
    getTokenLifecycleDisabledReason(token, "burn") ?? (hasSupply ? null : "Supply is zero.");
  const permanentDelegateDisabledReason = !token.extensions?.permanentDelegate
    ? "Permanent delegate authority is not configured."
    : null;
  const pauseAuthority = getPauseAuthorityAddress(token);

  return {
    mintDisabledReason,
    burnDisabledReason,
    seizeDisabledReason:
      getTokenLifecycleDisabledReason(token, "force transfer") ??
      permanentDelegateDisabledReason ??
      (hasSupply ? null : "No supply is currently held."),
    forceBurnDisabledReason:
      getTokenLifecycleDisabledReason(token, "force burn") ??
      permanentDelegateDisabledReason ??
      (hasSupply ? null : "Supply is zero."),
    pauseDisabledReason: pauseAuthority
      ? token.status === "revoked"
        ? "Revoked tokens cannot be paused or unpaused."
        : token.status === "pending"
          ? "Token must be deployed and active before pause controls are available."
          : null
      : "No pause authority is configured. Set a pausable authority or mint authority first.",
    freezeDisabledReason: !token.isFreezable
      ? "Freezing is disabled for this token."
      : !token.freezeAuthority
        ? "No freeze authority is configured."
        : null,
  };
}

export function formatValue(value: string | null | undefined): string {
  if (!value) {
    return "None";
  }

  if (value.length <= 16) {
    return value;
  }

  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

export function extractApiError(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }

  if (body && typeof body === "object") {
    const maybeError = (body as { error?: { message?: string } }).error;
    if (maybeError?.message) {
      return maybeError.message;
    }

    const maybeMessage = (body as { message?: string }).message;
    if (typeof maybeMessage === "string" && maybeMessage) {
      return maybeMessage;
    }
  }

  return "Unknown error";
}

export function getExplorerHref(mintAddress: string | null): string | null {
  if (!mintAddress) {
    return null;
  }

  const cluster = process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim() || "devnet";
  const clusterQuery =
    cluster === "mainnet-beta" || cluster === "mainnet"
      ? ""
      : `?cluster=${encodeURIComponent(cluster)}`;
  return `https://explorer.solana.com/address/${mintAddress}${clusterQuery}`;
}

export async function executeActionRequest(
  input: ActionExecutionInput
): Promise<ActionExecutionResult> {
  try {
    const response = await fetch("/api/playground/execute", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        method: input.method,
        path: input.path,
        body: input.body,
      }),
    });

    const payload = (await response.json()) as ExecuteRouteResponse;

    if (!response.ok) {
      return {
        ok: false,
        message: payload.error ?? `Execution route failed (${response.status})`,
        status: response.status,
        body: payload,
      };
    }

    if (!payload.ok) {
      const status = payload.status ?? null;
      return {
        ok: false,
        message: `${input.label} failed (${status ?? "unknown"}): ${extractApiError(payload.body)}`,
        status,
        body: payload.body,
      };
    }

    return {
      ok: true,
      message: `${input.label} succeeded (${payload.status ?? "ok"})`,
      status: payload.status ?? null,
      body: payload.body ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Request failed",
      status: null,
      body: null,
    };
  }
}

export function getPermissionRows(token: Token, metadataAuthority: string | null): PermissionRow[] {
  return [
    {
      id: "mint-authority",
      title: "Mint Authority",
      helper: "Can mint new tokens.",
      value: token.mintAuthority,
      authorityRole: "mint",
    },
    {
      id: "freeze-authority",
      title: "Freeze Authority",
      helper: "Can freeze and unfreeze token accounts.",
      value: token.freezeAuthority,
      authorityRole: "freeze",
    },
    {
      id: "metadata-authority",
      title: "Metadata Authority",
      helper: "Can update token metadata.",
      value: metadataAuthority,
      authorityRole: "metadata",
    },
    {
      id: "permanent-delegate",
      title: "Permanent Delegate Authority",
      helper: "Can perform delegated transfer/burn operations.",
      value: token.extensions?.permanentDelegate ?? null,
      authorityRole: "permanentDelegate",
    },
  ];
}

export type SignerAwareAction = "deploy" | "mint" | "burn" | "seize" | "force-burn" | "authority";

export interface SignerSelectionState {
  wallets: PaymentsDashboardWallet[];
  defaultWalletId: string;
  unavailableReason: string | null;
}

export function getAvailableSignerWallets(
  authorityWallets: PaymentsDashboardWallet[]
): PaymentsDashboardWallet[] {
  return authorityWallets.filter((wallet) => wallet.publicKey.trim());
}

export function getSignerWalletOptionLabel(wallet: PaymentsDashboardWallet): string {
  const primaryLabel = wallet.label?.trim() || wallet.walletId;
  return `${primaryLabel} · ${formatValue(wallet.publicKey)}`;
}

function findSignerWalletById(
  authorityWallets: PaymentsDashboardWallet[],
  walletId: string | null | undefined
): PaymentsDashboardWallet | null {
  if (!walletId) {
    return null;
  }

  return authorityWallets.find((wallet) => wallet.walletId === walletId) ?? null;
}

function findSignerWalletByPublicKey(
  authorityWallets: PaymentsDashboardWallet[],
  publicKey: string | null | undefined
): PaymentsDashboardWallet | null {
  if (!publicKey) {
    return null;
  }

  return authorityWallets.find((wallet) => wallet.publicKey === publicKey) ?? null;
}

export function resolveAuthorityAddressForRole(
  token: Token,
  role: AuthorityFormState["role"],
  metadataAuthority: string | null
): string | null {
  switch (role) {
    case "mint":
      return token.mintAuthority;
    case "freeze":
      return token.freezeAuthority;
    case "metadata":
      return metadataAuthority;
    case "permanentDelegate":
      return token.extensions?.permanentDelegate ?? token.mintAuthority;
  }
}

export function getSignerSelectionForAction({
  action,
  token,
  authorityWallets,
  metadataAuthority,
  permissionRow,
}: {
  action: SignerAwareAction;
  token: Token;
  authorityWallets: PaymentsDashboardWallet[];
  metadataAuthority: string | null;
  permissionRow?: PermissionRow | null;
}): SignerSelectionState {
  const availableWallets = getAvailableSignerWallets(authorityWallets);

  if (availableWallets.length === 0) {
    return {
      wallets: [],
      defaultWalletId: "",
      unavailableReason: "No controlled wallets are available to sign this action.",
    };
  }

  if (action === "deploy" || action === "burn") {
    const preferredWallet =
      findSignerWalletById(availableWallets, token.signingWalletId) ?? availableWallets[0];

    return {
      wallets: availableWallets,
      defaultWalletId: preferredWallet.walletId,
      unavailableReason: null,
    };
  }

  let requiredAuthority: string | null = null;
  let missingReason = "No signer is configured for this action.";
  let uncontrolledReason = "The required signer is not one of your controlled wallets.";

  switch (action) {
    case "mint":
      requiredAuthority = token.mintAuthority;
      missingReason = "No mint authority is configured.";
      uncontrolledReason = "Mint authority is not one of your controlled wallets.";
      break;
    case "seize":
    case "force-burn":
      requiredAuthority = token.extensions?.permanentDelegate ?? token.mintAuthority;
      missingReason = "No permanent delegate authority is configured.";
      uncontrolledReason = "Permanent delegate authority is not one of your controlled wallets.";
      break;
    case "authority": {
      const authorityRole = permissionRow?.authorityRole ?? "mint";
      requiredAuthority = resolveAuthorityAddressForRole(token, authorityRole, metadataAuthority);
      missingReason = `No ${permissionRow?.title?.toLowerCase() ?? "authority"} is configured.`;
      uncontrolledReason = `${
        permissionRow?.title ?? "Current authority"
      } is not one of your controlled wallets.`;
      break;
    }
    default:
      break;
  }

  if (!requiredAuthority) {
    return {
      wallets: [],
      defaultWalletId: "",
      unavailableReason: missingReason,
    };
  }

  const matchedWallet = findSignerWalletByPublicKey(availableWallets, requiredAuthority);
  if (!matchedWallet) {
    return {
      wallets: [],
      defaultWalletId: "",
      unavailableReason: uncontrolledReason,
    };
  }

  return {
    wallets: [matchedWallet],
    defaultWalletId: matchedWallet.walletId,
    unavailableReason: null,
  };
}

export function getExtensionRows(token: Token): ExtensionRow[] {
  return [
    {
      id: "template",
      title: "Template",
      helper: "Base template applied to this token.",
      value: token.template,
    },
    {
      id: "allowlist",
      title: "Allowlist Enforcement",
      helper: "Requires destination allowlisting for controlled actions.",
      value: token.requiresAllowlist ? "Enabled" : "Disabled",
    },
    {
      id: "mintable",
      title: "Mintable",
      helper: "Allows mint operations after deployment.",
      value: token.isMintable ? "Enabled" : "Disabled",
    },
    {
      id: "freezable",
      title: "Freezable",
      helper: "Allows freeze/unfreeze account controls.",
      value: token.isFreezable ? "Enabled" : "Disabled",
    },
    {
      id: "default-account-state",
      title: "Default Account State",
      helper: "Default state for newly created token accounts.",
      value: token.extensions?.defaultAccountState ?? "initialized",
    },
    {
      id: "transfer-fee",
      title: "Transfer Fee",
      helper: "Fee configuration for token transfers.",
      value: token.extensions?.transferFee ? "Configured" : "Not configured",
    },
    {
      id: "scaled-ui",
      title: "Scaled UI Amount",
      helper: "UI supply multiplier controls.",
      value: token.extensions?.scaledUiAmount ? "Configured" : "Not configured",
    },
    {
      id: "transfer-hook",
      title: "Transfer Hook",
      helper: "Custom transfer logic program hook.",
      value: token.extensions?.transferHook ? "Configured" : "Not configured",
    },
    {
      id: "interest-bearing",
      title: "Interest Bearing",
      helper: "Interest-rate based balance updates.",
      value: token.extensions?.interestBearing ? "Configured" : "Not configured",
    },
    {
      id: "non-transferable",
      title: "Non-transferable",
      helper: "Disables standard transfers between accounts.",
      value: token.extensions?.nonTransferable ? "Enabled" : "Disabled",
    },
  ];
}

export function getTabForAction(action: AdminAction): TokenManagementTab {
  switch (action) {
    case "authority":
      return "permissions";
    case "allowlist":
    case "freeze":
    case "pause":
      return "compliance";
    case "update-metadata":
      return "metadata";
    case "refresh-supply":
    case "mint":
    case "burn":
    case "seize":
    case "force-burn":
      return "fund-management";
  }
}

export function getDefaultActionForTab(tab: TokenManagementTab): AdminAction | null {
  switch (tab) {
    case "compliance":
      return "allowlist";
    case "metadata":
      return "update-metadata";
    case "fund-management":
      return "mint";
    default:
      return null;
  }
}
