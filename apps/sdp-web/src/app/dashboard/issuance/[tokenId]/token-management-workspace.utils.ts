import type { PaymentsDashboardWallet, Token, TokenAllowlistEntry } from "@sdp/types";
import { type AccessControlMode, getTokenAccessControlMode } from "../access-control.utils";
import type {
  ActionExecutionInput,
  ActionExecutionResult,
  AdminAction,
  AllowlistFormState,
  AuthorityFormState,
  BurnFormState,
  BurnValidationErrors,
  ExecuteRouteResponse,
  ExtensionRow,
  ForceBurnFormState,
  ForceBurnValidationErrors,
  FreezeFormState,
  MetadataFormState,
  MintFormState,
  MintValidationErrors,
  PermissionRow,
  SeizeFormState,
  SeizeValidationErrors,
  TokenManagementTab,
} from "./token-management-workspace.types";

export const SOLANA_ADDRESS_PATTERN = "[1-9A-HJ-NP-Za-km-z]{32,44}";
export const NON_WHITESPACE_PATTERN = ".*\\S.*";

export interface ControlListCopy {
  label: string;
  description: string;
  summaryDescription: string;
  summaryTitle: string;
  addActionLabel: string;
  removeActionLabel: string;
  emptyState: string;
  addressRequiredMessage: string;
  extensionHelper: string;
  freezeHint: string | null;
}

export function getControlListCopy(mode: AccessControlMode): ControlListCopy | null {
  switch (mode) {
    case "allowlist":
      return {
        label: "Allowlist",
        description: "Manage the approved destination addresses for this token.",
        summaryDescription: "Allowlist entries and frozen account status",
        summaryTitle: "Allowlist Entries",
        addActionLabel: "Add allowlist entry",
        removeActionLabel: "Remove entry",
        emptyState: "No allowlist entries yet.",
        addressRequiredMessage: "Allowlist address is required.",
        extensionHelper:
          "Mint and controlled transfer destinations must be on the token allowlist.",
        freezeHint: null,
      };
    case "blocklist":
      return {
        label: "Denylist",
        description: "Manage the blocked destination addresses for this token.",
        summaryDescription: "Denylist entries and frozen account status",
        summaryTitle: "Denylist Entries",
        addActionLabel: "Add denylist entry",
        removeActionLabel: "Remove entry",
        emptyState: "No denylist entries yet.",
        addressRequiredMessage: "Denylist address is required.",
        extensionHelper:
          "Listed destinations are blocked from mint and controlled transfer operations.",
        freezeHint:
          "Need to restrict a wallet before it has a token account? Add it to the denylist first.",
      };
    case "disabled":
      return null;
  }
}

function getDestinationAccessControlError({
  token,
  destination,
  allowlistEntries,
}: {
  token: Token;
  destination: string;
  allowlistEntries: TokenAllowlistEntry[];
}): string | null {
  const normalizedDestination = destination.trim();
  if (!normalizedDestination) {
    return null;
  }

  const accessControlMode = getTokenAccessControlMode(token);
  const isListed = allowlistEntries.some((entry) => entry.address === normalizedDestination);

  if (accessControlMode === "allowlist" && !isListed) {
    return "Destination is not on this token's allowlist.";
  }

  if (accessControlMode === "blocklist" && isListed) {
    return "Destination is on this token's denylist.";
  }

  return null;
}

export function createInitialMetadataForm(token: Token): MetadataFormState {
  return {
    name: token.name,
    description: token.description ?? "",
    uri: token.uri ?? "",
    imageUrl: token.imageUrl ?? "",
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

function isDecimalCharacter(char: string): boolean {
  return (char >= "0" && char <= "9") || char === ".";
}

function isDecimalAmountString(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  let hasDigit = false;
  let seenDot = false;

  for (const char of normalized) {
    if (!isDecimalCharacter(char)) {
      return false;
    }

    if (char === ".") {
      if (seenDot) {
        return false;
      }
      seenDot = true;
      continue;
    }

    hasDigit = true;
  }

  return hasDigit;
}

function parseTokenAmountToBaseUnits(value: string, decimals: number): bigint | null {
  const normalized = value.trim();
  if (!isDecimalAmountString(normalized) || !Number.isInteger(decimals) || decimals < 0) {
    return null;
  }

  const [wholeRaw = "", fractionRaw = ""] = normalized.split(".");
  const whole = wholeRaw.length ? wholeRaw : "0";
  if (fractionRaw.length > decimals) {
    return null;
  }

  const combined = `${whole}${fractionRaw.padEnd(decimals, "0")}`;
  const sanitized = combined.replace(/^0+(?=\d)/, "");
  return BigInt(sanitized || "0");
}

const ZERO_BIGINT = BigInt(0);

function formatBaseUnitsAsTokenAmount(value: bigint, decimals: number): string {
  const negative = value < ZERO_BIGINT;
  const absolute = negative ? -value : value;
  let digits = absolute.toString();

  if (decimals === 0) {
    return `${negative ? "-" : ""}${digits}`;
  }

  if (digits.length <= decimals) {
    digits = digits.padStart(decimals + 1, "0");
  }

  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${fraction ? `${whole}.${fraction}` : whole}`;
}

function getTokenDisplaySymbol(token: Token): string {
  return token.symbol.trim() || token.name.trim() || "token";
}

function getWalletTokenBalanceRecord(wallet: PaymentsDashboardWallet, mintAddress: string | null) {
  if (!mintAddress) {
    return null;
  }

  return wallet.balances?.find((balance) => balance.mint === mintAddress) ?? null;
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

function getPendingAuthoritySignerWallet(
  token: Token,
  authorityWallets: PaymentsDashboardWallet[]
): PaymentsDashboardWallet | null {
  const availableWallets = getAvailableSignerWallets(authorityWallets);
  if (availableWallets.length === 0) {
    return null;
  }

  return findWalletByWalletId(availableWallets, token.signingWalletId) ?? availableWallets[0];
}

function pendingTokenRequiresPermanentDelegate(token: Token): boolean {
  return (
    token.template === "stablecoin" ||
    token.template === "arcade" ||
    token.template === "tokenized-security"
  );
}

export function getDisplayedAuthorityAddress({
  token,
  role,
  metadataAuthority,
  authorityWallets,
}: {
  token: Token;
  role: AuthorityFormState["role"];
  metadataAuthority: string | null;
  authorityWallets: PaymentsDashboardWallet[];
}): string | null {
  const resolvedAuthority = resolveAuthorityAddressForRole(token, role, metadataAuthority);
  if (resolvedAuthority) {
    return resolvedAuthority;
  }

  if (token.status !== "pending") {
    return null;
  }

  const pendingSignerWallet = getPendingAuthoritySignerWallet(token, authorityWallets);
  if (!pendingSignerWallet) {
    return null;
  }

  switch (role) {
    case "mint":
    case "metadata":
      return pendingSignerWallet.publicKey;
    case "freeze":
      return token.isFreezable ? pendingSignerWallet.publicKey : null;
    case "permanentDelegate":
      if (typeof token.extensions?.permanentDelegate === "string") {
        return token.extensions.permanentDelegate;
      }

      return pendingTokenRequiresPermanentDelegate(token) ? pendingSignerWallet.publicKey : null;
  }
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
  const primaryLabel = wallet.label?.trim() || "Unlabeled wallet";
  return `${primaryLabel} · ${formatValue(wallet.walletId)} · ${formatValue(wallet.publicKey)}`;
}

export function findWalletByWalletId(
  authorityWallets: PaymentsDashboardWallet[],
  walletId: string | null | undefined
): PaymentsDashboardWallet | null {
  if (!walletId) {
    return null;
  }

  return authorityWallets.find((wallet) => wallet.walletId === walletId) ?? null;
}

export function findWalletByPublicKey(
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
      return token.extensions?.permanentDelegate ?? null;
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
      findWalletByWalletId(availableWallets, token.signingWalletId) ?? availableWallets[0];

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

  const matchedWallet = findWalletByPublicKey(availableWallets, requiredAuthority);
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

function getFirstValidationError(...messages: Array<string | null | undefined>): string | null {
  return messages.find((message): message is string => Boolean(message)) ?? null;
}

export function getMintValidationErrors({
  token,
  destination,
  amount,
  allowlistEntries,
}: {
  token: Token;
  destination: string;
  amount: string;
  allowlistEntries: TokenAllowlistEntry[];
}): MintValidationErrors {
  const normalizedAmount = amount.trim();
  const normalizedDestination = destination.trim();
  let amountError: string | null = null;
  let destinationError: string | null = null;

  if (normalizedAmount) {
    const amountBaseUnits = parseTokenAmountToBaseUnits(normalizedAmount, token.decimals);
    if (amountBaseUnits === null) {
      amountError = "Enter a valid mint amount for this token.";
    } else if (amountBaseUnits <= ZERO_BIGINT) {
      amountError = "Mint amount must be greater than zero.";
    } else if (token.maxSupply) {
      const currentSupply = parseTokenAmountToBaseUnits(token.totalSupply, token.decimals);
      const maxSupply = parseTokenAmountToBaseUnits(token.maxSupply, token.decimals);

      if (
        currentSupply !== null &&
        maxSupply !== null &&
        currentSupply + amountBaseUnits > maxSupply
      ) {
        const remaining = maxSupply > currentSupply ? maxSupply - currentSupply : ZERO_BIGINT;
        amountError =
          remaining > ZERO_BIGINT
            ? `Mint amount exceeds the remaining supply cap of ${formatBaseUnitsAsTokenAmount(
                remaining,
                token.decimals
              )} ${getTokenDisplaySymbol(token)}.`
            : "Maximum supply has already been reached.";
      }
    }
  }

  if (normalizedDestination) {
    destinationError = getDestinationAccessControlError({
      token,
      destination: normalizedDestination,
      allowlistEntries,
    });
  }

  return {
    destination: destinationError,
    amount: amountError,
  };
}

export function getMintValidationReason(args: {
  token: Token;
  destination: string;
  amount: string;
  allowlistEntries: TokenAllowlistEntry[];
}): string | null {
  const errors = getMintValidationErrors(args);
  return getFirstValidationError(errors.destination, errors.amount);
}

export function getBurnValidationErrors({
  token,
  source,
  amount,
  signerWallet,
  walletOptions,
}: {
  token: Token;
  source: string;
  amount: string;
  signerWallet: PaymentsDashboardWallet | null;
  walletOptions: PaymentsDashboardWallet[];
}): BurnValidationErrors {
  const normalizedAmount = amount.trim();
  const normalizedSource = source.trim();
  let amountError: string | null = null;
  let sourceError: string | null = null;

  if (normalizedAmount) {
    const amountBaseUnits = parseTokenAmountToBaseUnits(normalizedAmount, token.decimals);
    if (amountBaseUnits === null) {
      amountError = "Enter a valid burn amount for this token.";
    } else if (amountBaseUnits <= ZERO_BIGINT) {
      amountError = "Burn amount must be greater than zero.";
    } else if (!normalizedSource || !signerWallet) {
      return {
        source: sourceError,
        amount: amountError,
      };
    } else {
      const totalSupply = parseTokenAmountToBaseUnits(token.totalSupply, token.decimals);
      if (totalSupply !== null && amountBaseUnits > totalSupply) {
        amountError = `Burn amount exceeds the current supply of ${token.totalSupply} ${getTokenDisplaySymbol(token)}.`;
      }
    }
  }

  if (!normalizedSource || !signerWallet) {
    return {
      source: sourceError,
      amount: amountError,
    };
  }

  const sourceWallet = findWalletByPublicKey(walletOptions, normalizedSource);
  if (sourceWallet && sourceWallet.publicKey !== signerWallet.publicKey) {
    sourceError =
      "Standard burn only works from the selected signer wallet. Use Force burn for a different wallet.";
  }

  const signerBalance = getWalletTokenBalanceRecord(signerWallet, token.mintAddress);
  if (
    !sourceError &&
    normalizedSource === signerWallet.publicKey &&
    Array.isArray(signerWallet.balances) &&
    !signerBalance
  ) {
    sourceError = "The selected signer wallet does not currently hold this token.";
    amountError = null;
  }

  if (normalizedAmount && normalizedSource === signerWallet.publicKey && signerBalance?.amount) {
    const amountBaseUnits = parseTokenAmountToBaseUnits(normalizedAmount, token.decimals);
    if (amountBaseUnits !== null && amountBaseUnits > BigInt(signerBalance.amount)) {
      amountError = `The selected signer wallet only shows ${signerBalance.uiAmount} ${getTokenDisplaySymbol(
        token
      )}.`;
    }
  }

  return {
    source: sourceError,
    amount: amountError,
  };
}

export function getBurnValidationReason(args: {
  token: Token;
  source: string;
  amount: string;
  signerWallet: PaymentsDashboardWallet | null;
  walletOptions: PaymentsDashboardWallet[];
}): string | null {
  const errors = getBurnValidationErrors(args);
  return getFirstValidationError(errors.source, errors.amount);
}

export function getSeizeValidationErrors({
  token,
  source,
  destination,
  amount,
  allowlistEntries,
  walletOptions,
}: {
  token: Token;
  source: string;
  destination: string;
  amount: string;
  allowlistEntries: TokenAllowlistEntry[];
  walletOptions: PaymentsDashboardWallet[];
}): SeizeValidationErrors {
  const normalizedSource = source.trim();
  const normalizedDestination = destination.trim();
  const normalizedAmount = amount.trim();
  let amountError: string | null = null;
  let sourceError: string | null = null;
  let destinationError: string | null = null;

  if (normalizedSource && normalizedDestination && normalizedSource === normalizedDestination) {
    destinationError = "Destination must be different from the source.";
  }

  if (!destinationError && normalizedDestination) {
    destinationError = getDestinationAccessControlError({
      token,
      destination: normalizedDestination,
      allowlistEntries,
    });
  }

  if (!normalizedAmount) {
    return {
      source: sourceError,
      destination: destinationError,
      amount: amountError,
    };
  }

  const amountBaseUnits = parseTokenAmountToBaseUnits(normalizedAmount, token.decimals);
  if (amountBaseUnits === null) {
    amountError = "Enter a valid transfer amount for this token.";
  } else if (amountBaseUnits <= ZERO_BIGINT) {
    amountError = "Transfer amount must be greater than zero.";
  }

  const sourceWallet = findWalletByPublicKey(walletOptions, normalizedSource);
  const sourceBalance = sourceWallet
    ? getWalletTokenBalanceRecord(sourceWallet, token.mintAddress)
    : null;
  if (sourceWallet && Array.isArray(sourceWallet.balances) && !sourceBalance) {
    sourceError = "The selected source wallet does not currently hold this token.";
    amountError = null;
  }

  if (
    !sourceError &&
    sourceBalance?.amount &&
    amountBaseUnits !== null &&
    amountBaseUnits > BigInt(sourceBalance.amount)
  ) {
    amountError = `The selected source wallet only shows ${sourceBalance.uiAmount} ${getTokenDisplaySymbol(
      token
    )}.`;
  }

  return {
    source: sourceError,
    destination: destinationError,
    amount: amountError,
  };
}

export function getSeizeValidationReason(args: {
  token: Token;
  source: string;
  destination: string;
  amount: string;
  allowlistEntries: TokenAllowlistEntry[];
  walletOptions: PaymentsDashboardWallet[];
}): string | null {
  const errors = getSeizeValidationErrors(args);
  return getFirstValidationError(errors.source, errors.destination, errors.amount);
}

export function getForceBurnValidationErrors({
  token,
  source,
  amount,
  walletOptions,
}: {
  token: Token;
  source: string;
  amount: string;
  walletOptions: PaymentsDashboardWallet[];
}): ForceBurnValidationErrors {
  const normalizedAmount = amount.trim();
  let amountError: string | null = null;
  if (!normalizedAmount) {
    return {
      source: null,
      amount: amountError,
    };
  }

  const amountBaseUnits = parseTokenAmountToBaseUnits(normalizedAmount, token.decimals);
  if (amountBaseUnits === null) {
    amountError = "Enter a valid burn amount for this token.";
  } else if (amountBaseUnits <= ZERO_BIGINT) {
    amountError = "Force-burn amount must be greater than zero.";
  }

  const sourceWallet = findWalletByPublicKey(walletOptions, source.trim());
  const sourceBalance = sourceWallet
    ? getWalletTokenBalanceRecord(sourceWallet, token.mintAddress)
    : null;
  const sourceError =
    sourceWallet && Array.isArray(sourceWallet.balances) && !sourceBalance
      ? "The selected source wallet does not currently hold this token."
      : null;
  if (sourceError) {
    amountError = null;
  }
  if (
    !sourceError &&
    sourceBalance?.amount &&
    amountBaseUnits !== null &&
    amountBaseUnits > BigInt(sourceBalance.amount)
  ) {
    amountError = `The selected source wallet only shows ${sourceBalance.uiAmount} ${getTokenDisplaySymbol(
      token
    )}.`;
  }

  const totalSupply = parseTokenAmountToBaseUnits(token.totalSupply, token.decimals);
  if (totalSupply !== null && amountBaseUnits !== null && amountBaseUnits > totalSupply) {
    amountError = `Force-burn amount exceeds the current supply of ${token.totalSupply} ${getTokenDisplaySymbol(
      token
    )}.`;
  }

  return {
    source: sourceError,
    amount: amountError,
  };
}

export function getForceBurnValidationReason(args: {
  token: Token;
  source: string;
  amount: string;
  walletOptions: PaymentsDashboardWallet[];
}): string | null {
  const errors = getForceBurnValidationErrors(args);
  return getFirstValidationError(errors.source, errors.amount);
}

export function getExtensionRows(token: Token): ExtensionRow[] {
  const configuredExtensionRows: ExtensionRow[] = [];
  const controlListCopy = getControlListCopy(getTokenAccessControlMode(token));

  if (token.extensions?.defaultAccountState) {
    configuredExtensionRows.push({
      id: "default-account-state",
      title: "Default Account State",
      helper: "Default state for newly created token accounts.",
      value: token.extensions.defaultAccountState,
    });
  }

  if (token.extensions?.transferFee) {
    configuredExtensionRows.push({
      id: "transfer-fee",
      title: "Transfer Fee",
      helper: "Fee configuration for token transfers.",
      value: "Configured",
    });
  }

  if (token.extensions?.scaledUiAmount) {
    configuredExtensionRows.push({
      id: "scaled-ui",
      title: "Scaled UI Amount",
      helper: "UI supply multiplier controls.",
      value: "Configured",
    });
  }

  if (token.extensions?.transferHook) {
    configuredExtensionRows.push({
      id: "transfer-hook",
      title: "Transfer Hook",
      helper: "Custom transfer logic program hook.",
      value: "Configured",
    });
  }

  if (token.extensions?.interestBearing) {
    configuredExtensionRows.push({
      id: "interest-bearing",
      title: "Interest Bearing",
      helper: "Interest-rate based balance updates.",
      value: "Configured",
    });
  }

  if (token.extensions?.nonTransferable) {
    configuredExtensionRows.push({
      id: "non-transferable",
      title: "Non-transferable",
      helper: "Disables standard transfers between accounts.",
      value: "Enabled",
    });
  }

  return [
    {
      id: "template",
      title: "Template",
      helper: "Base template applied to this token.",
      value: token.template,
    },
    ...(controlListCopy
      ? [
          {
            id: "control-list",
            title: controlListCopy.label,
            helper: controlListCopy.extensionHelper,
            value: "Enabled",
          } satisfies ExtensionRow,
        ]
      : []),
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
    ...configuredExtensionRows,
  ];
}

export function getTabForAction(action: AdminAction): TokenManagementTab {
  switch (action) {
    case "authority":
      return "permissions";
    case "allowlist":
    case "freeze":
    case "pause":
    case "seize":
    case "force-burn":
      return "compliance";
    case "update-metadata":
      return "metadata";
    case "mint":
    case "burn":
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
