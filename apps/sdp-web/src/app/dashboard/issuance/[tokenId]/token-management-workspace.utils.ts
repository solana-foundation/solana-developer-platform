import type { PaymentsDashboardWallet, Token, TokenAllowlistEntry } from "@sdp/types";
import type { AppLocale } from "@/i18n/config";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { formatDisplayLabel } from "@/lib/utils";
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

type Translate = (key: MessageKey, values?: TranslationValues) => string;
export const getTokenAmountFieldDescription = (t: Translate) =>
  t("DashboardIssuance.management.tokenAmountDescription");
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

export function getControlListCopy(mode: AccessControlMode, t: Translate): ControlListCopy | null {
  switch (mode) {
    case "allowlist":
      return {
        label: t("DashboardIssuance.management.allowlist"),
        description: t("DashboardIssuance.management.allowlistDescription"),
        summaryDescription: t("DashboardIssuance.management.allowlistSummaryDescription"),
        summaryTitle: t("DashboardIssuance.management.allowlistEntries"),
        addActionLabel: t("DashboardIssuance.management.addAllowlistEntry"),
        removeActionLabel: t("DashboardIssuance.management.removeEntry"),
        emptyState: t("DashboardIssuance.management.noAllowlistEntries"),
        addressRequiredMessage: t("DashboardIssuance.management.allowlistAddressRequired"),
        extensionHelper: t("DashboardIssuance.management.allowlistExtensionHelper"),
        freezeHint: null,
      };
    case "blocklist":
      return {
        label: t("DashboardIssuance.management.denylist"),
        description: t("DashboardIssuance.management.denylistDescription"),
        summaryDescription: t("DashboardIssuance.management.denylistSummaryDescription"),
        summaryTitle: t("DashboardIssuance.management.denylistEntries"),
        addActionLabel: t("DashboardIssuance.management.addDenylistEntry"),
        removeActionLabel: t("DashboardIssuance.management.removeEntry"),
        emptyState: t("DashboardIssuance.management.noDenylistEntries"),
        addressRequiredMessage: t("DashboardIssuance.management.denylistAddressRequired"),
        extensionHelper: t("DashboardIssuance.management.denylistExtensionHelper"),
        freezeHint: t("DashboardIssuance.management.denylistFreezeHint"),
      };
    case "disabled":
      return null;
  }
}

function getDestinationAccessControlError({
  token,
  destination,
  allowlistEntries,
  t,
}: {
  token: Token;
  destination: string;
  allowlistEntries: TokenAllowlistEntry[];
  t: Translate;
}): string | null {
  const normalizedDestination = destination.trim();
  if (!normalizedDestination) {
    return null;
  }

  const accessControlMode = getTokenAccessControlMode(token);
  const isListed = allowlistEntries.some((entry) => entry.address === normalizedDestination);

  if (accessControlMode === "allowlist" && !isListed) {
    return t("DashboardIssuance.management.destinationNotAllowlisted");
  }

  if (accessControlMode === "blocklist" && isListed) {
    return t("DashboardIssuance.management.destinationDenylisted");
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

export function formatDate(value: string | null | undefined, locale: AppLocale): string {
  if (!value) {
    return "—";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString(locale, {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

/** Full date + time, e.g. "Jul 21, 2026, 3:45 PM" — used in the audit table. */
export function formatDateTime(value: string | null | undefined, locale: AppLocale): string {
  if (!value) {
    return "—";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString(locale, {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Compact activity timestamp: just the time when the event happened today,
 * otherwise the short date. Keeps the recent-activity preview scannable.
 */
export function formatActivityTimestamp(
  value: string | null | undefined,
  locale: AppLocale
): string {
  if (!value) {
    return "—";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (isToday) {
    return date.toLocaleString(locale, { hour: "numeric", minute: "2-digit" });
  }

  return formatDate(value, locale);
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

function getTokenDisplaySymbol(token: Token, t: Translate): string {
  return token.symbol.trim() || token.name.trim() || t("DashboardIssuance.management.token");
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
  action: "mint" | "burn" | "forceTransfer" | "forceBurn",
  t: Translate
): string | null {
  switch (token.status) {
    case "active":
      return null;
    case "paused":
      return t("DashboardIssuance.management.actionPaused", {
        action: t(`DashboardIssuance.management.${action}`),
      });
    case "pending":
      return t("DashboardIssuance.management.actionRequiresActive", {
        action: t(`DashboardIssuance.management.${action}`),
      });
    case "revoked":
      return t("DashboardIssuance.management.actionRevoked", {
        action: t(`DashboardIssuance.management.${action}`),
      });
    default:
      return t("DashboardIssuance.management.actionRequiresActive", {
        action: t(`DashboardIssuance.management.${action}`),
      });
  }
}

function getPauseAuthorityAddress(token: Token): string | null {
  return token.extensions?.pausable?.authority ?? token.mintAuthority ?? null;
}

export function getTokenActionDisabledReasons(
  token: Token,
  t: Translate
): {
  mintDisabledReason: string | null;
  burnDisabledReason: string | null;
  seizeDisabledReason: string | null;
  forceBurnDisabledReason: string | null;
  pauseDisabledReason: string | null;
  freezeDisabledReason: string | null;
} {
  const hasSupply = isPositiveAmount(token.totalSupply);
  const maxSupplyReached = hasReachedMaxSupply(token.totalSupply, token.maxSupply);
  const mintDisabledReason = getTokenLifecycleDisabledReason(token, "mint", t)
    ? getTokenLifecycleDisabledReason(token, "mint", t)
    : !token.isMintable
      ? t("DashboardIssuance.management.mintingDisabled")
      : !token.mintAuthority
        ? t("DashboardIssuance.management.noMintAuthorityConfigured")
        : maxSupplyReached
          ? t("DashboardIssuance.management.maximumSupplyReached")
          : null;
  const burnDisabledReason =
    getTokenLifecycleDisabledReason(token, "burn", t) ??
    (hasSupply ? null : t("DashboardIssuance.management.supplyZero"));
  const permanentDelegateDisabledReason = !token.extensions?.permanentDelegate
    ? t("DashboardIssuance.management.noPermanentDelegateAuthority")
    : null;
  const pauseAuthority = getPauseAuthorityAddress(token);

  return {
    mintDisabledReason,
    burnDisabledReason,
    seizeDisabledReason:
      getTokenLifecycleDisabledReason(token, "forceTransfer", t) ??
      permanentDelegateDisabledReason ??
      (hasSupply ? null : t("DashboardIssuance.management.noSupplyHeld")),
    forceBurnDisabledReason:
      getTokenLifecycleDisabledReason(token, "forceBurn", t) ??
      permanentDelegateDisabledReason ??
      (hasSupply ? null : t("DashboardIssuance.management.supplyZero")),
    pauseDisabledReason: pauseAuthority
      ? token.status === "revoked"
        ? t("DashboardIssuance.management.revokedTokensCannotPause")
        : token.status === "pending"
          ? t("DashboardIssuance.management.pauseRequiresActiveToken")
          : null
      : t("DashboardIssuance.management.noPauseAuthorityConfigured"),
    freezeDisabledReason: !token.isFreezable
      ? t("DashboardIssuance.management.freezingDisabled")
      : !token.freezeAuthority
        ? t("DashboardIssuance.management.noFreezeAuthorityConfigured")
        : null,
  };
}

export function formatValue(value: string | null | undefined, t: Translate): string {
  if (!value) {
    return t("DashboardIssuance.wallet.none");
  }

  if (value.length <= 16) {
    return value;
  }

  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

export function extractApiError(body: unknown, t: Translate): string {
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

  return t("DashboardIssuance.management.unknownError");
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
  input: ActionExecutionInput,
  t: Translate
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
        message:
          payload.error ??
          t("DashboardIssuance.management.executionRouteFailed", { status: response.status }),
        status: response.status,
        body: payload,
      };
    }

    if (!payload.ok) {
      const status = payload.status ?? null;
      return {
        ok: false,
        message: t("DashboardIssuance.management.actionFailed", {
          action: input.label,
          status: status ?? t("DashboardIssuance.management.unknown"),
          error: extractApiError(payload.body, t),
        }),
        status,
        body: payload.body,
      };
    }

    return {
      ok: true,
      message: t("DashboardIssuance.management.actionSucceeded", {
        action: input.label,
        status: payload.status ?? t("DashboardIssuance.management.ok"),
      }),
      status: payload.status ?? null,
      body: payload.body ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : t("DashboardIssuance.management.requestFailed"),
      status: null,
      body: null,
    };
  }
}

export function getPermissionRows(
  token: Token,
  metadataAuthority: string | null,
  t: Translate
): PermissionRow[] {
  return [
    {
      id: "mint-authority",
      title: t("DashboardIssuance.forms.mintAuthority"),
      helper: t("DashboardIssuance.management.mintAuthorityHelper"),
      value: token.mintAuthority,
      authorityRole: "mint",
    },
    {
      id: "freeze-authority",
      title: t("DashboardIssuance.forms.freezeAuthority"),
      helper: t("DashboardIssuance.management.freezeAuthorityHelper"),
      value: token.freezeAuthority,
      authorityRole: "freeze",
    },
    {
      id: "metadata-authority",
      title: t("DashboardIssuance.forms.metadataAuthority"),
      helper: t("DashboardIssuance.management.metadataAuthorityHelper"),
      value: metadataAuthority,
      authorityRole: "metadata",
    },
    {
      id: "permanent-delegate",
      title: t("DashboardIssuance.forms.permanentDelegate"),
      helper: t("DashboardIssuance.management.permanentDelegateHelper"),
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

export type SignerAwareAction =
  | "deploy"
  | "mint"
  | "burn"
  | "seize"
  | "force-burn"
  | "authority"
  | "freeze"
  | "pause";

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

export function getSignerWalletOptionLabel(wallet: PaymentsDashboardWallet, t: Translate): string {
  const primaryLabel = wallet.label?.trim() || t("DashboardIssuance.wallet.unlabeled");
  return `${primaryLabel} · ${formatValue(wallet.walletId, t)} · ${formatValue(wallet.publicKey, t)}`;
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
  t,
}: {
  action: SignerAwareAction;
  token: Token;
  authorityWallets: PaymentsDashboardWallet[];
  metadataAuthority: string | null;
  permissionRow?: PermissionRow | null;
  t: Translate;
}): SignerSelectionState {
  const availableWallets = getAvailableSignerWallets(authorityWallets);

  if (availableWallets.length === 0) {
    return {
      wallets: [],
      defaultWalletId: "",
      unavailableReason: t("DashboardIssuance.management.noControlledWalletsAvailable"),
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
  let missingReason = t("DashboardIssuance.management.noSignerConfigured");
  let uncontrolledReason = t("DashboardIssuance.management.requiredSignerNotControlled");

  switch (action) {
    case "mint":
      requiredAuthority = token.mintAuthority;
      missingReason = t("DashboardIssuance.management.noMintAuthorityConfigured");
      uncontrolledReason = t("DashboardIssuance.management.mintAuthorityNotControlled");
      break;
    case "seize":
    case "force-burn":
      requiredAuthority = token.extensions?.permanentDelegate ?? token.mintAuthority;
      missingReason = t("DashboardIssuance.management.noPermanentDelegateAuthority");
      uncontrolledReason = t("DashboardIssuance.management.permanentDelegateNotControlled");
      break;
    case "authority": {
      const authorityRole = permissionRow?.authorityRole ?? "mint";
      requiredAuthority = resolveAuthorityAddressForRole(token, authorityRole, metadataAuthority);
      missingReason = t("DashboardIssuance.management.noAuthorityConfigured", {
        authority:
          permissionRow?.title?.toLowerCase() ?? t("DashboardIssuance.management.authority"),
      });
      uncontrolledReason = t("DashboardIssuance.management.authorityNotControlled", {
        authority: permissionRow?.title ?? t("DashboardIssuance.authority.current"),
      });
      break;
    }
    case "freeze":
      requiredAuthority = token.freezeAuthority;
      missingReason = t("DashboardIssuance.management.noFreezeAuthorityConfigured");
      uncontrolledReason = t("DashboardIssuance.management.freezeAuthorityNotControlled");
      break;
    case "pause":
      requiredAuthority = token.extensions?.pausable?.authority ?? token.mintAuthority;
      missingReason = t("DashboardIssuance.management.noPauseAuthorityConfigured");
      uncontrolledReason = t("DashboardIssuance.management.pauseAuthorityNotControlled");
      break;
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
  t,
}: {
  token: Token;
  destination: string;
  amount: string;
  allowlistEntries: TokenAllowlistEntry[];
  t: Translate;
}): MintValidationErrors {
  const normalizedAmount = amount.trim();
  const normalizedDestination = destination.trim();
  let amountError: string | null = null;
  let destinationError: string | null = null;

  if (normalizedAmount) {
    const amountBaseUnits = parseTokenAmountToBaseUnits(normalizedAmount, token.decimals);
    if (amountBaseUnits === null) {
      amountError = t("DashboardIssuance.management.validMintAmount");
    } else if (amountBaseUnits <= ZERO_BIGINT) {
      amountError = t("DashboardIssuance.management.mintAmountPositive");
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
            ? t("DashboardIssuance.management.mintAmountExceedsSupplyCap", {
                amount: formatBaseUnitsAsTokenAmount(remaining, token.decimals),
                symbol: getTokenDisplaySymbol(token, t),
              })
            : t("DashboardIssuance.management.maximumSupplyReached");
      }
    }
  }

  if (normalizedDestination) {
    destinationError = getDestinationAccessControlError({
      token,
      destination: normalizedDestination,
      allowlistEntries,
      t,
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
  t: Translate;
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
  t,
}: {
  token: Token;
  source: string;
  amount: string;
  signerWallet: PaymentsDashboardWallet | null;
  walletOptions: PaymentsDashboardWallet[];
  t: Translate;
}): BurnValidationErrors {
  const normalizedAmount = amount.trim();
  const normalizedSource = source.trim();
  let amountError: string | null = null;
  let sourceError: string | null = null;

  if (normalizedAmount) {
    const amountBaseUnits = parseTokenAmountToBaseUnits(normalizedAmount, token.decimals);
    if (amountBaseUnits === null) {
      amountError = t("DashboardIssuance.management.validBurnAmount");
    } else if (amountBaseUnits <= ZERO_BIGINT) {
      amountError = t("DashboardIssuance.management.burnAmountPositive");
    } else if (!normalizedSource || !signerWallet) {
      return {
        source: sourceError,
        amount: amountError,
      };
    } else {
      const totalSupply = parseTokenAmountToBaseUnits(token.totalSupply, token.decimals);
      if (totalSupply !== null && amountBaseUnits > totalSupply) {
        amountError = t("DashboardIssuance.management.burnAmountExceedsSupply", {
          amount: token.totalSupply,
          symbol: getTokenDisplaySymbol(token, t),
        });
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
    sourceError = t("DashboardIssuance.management.standardBurnSignerOnly");
  }

  const signerBalance = getWalletTokenBalanceRecord(signerWallet, token.mintAddress);
  if (
    !sourceError &&
    normalizedSource === signerWallet.publicKey &&
    Array.isArray(signerWallet.balances) &&
    !signerBalance
  ) {
    sourceError = t("DashboardIssuance.management.selectedSignerDoesNotHoldToken");
    amountError = null;
  }

  if (normalizedAmount && normalizedSource === signerWallet.publicKey && signerBalance?.amount) {
    const amountBaseUnits = parseTokenAmountToBaseUnits(normalizedAmount, token.decimals);
    if (amountBaseUnits !== null && amountBaseUnits > BigInt(signerBalance.amount)) {
      amountError = t("DashboardIssuance.management.selectedWalletOnlyShows", {
        amount: signerBalance.uiAmount,
        symbol: getTokenDisplaySymbol(token, t),
      });
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
  t: Translate;
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
  t,
}: {
  token: Token;
  source: string;
  destination: string;
  amount: string;
  allowlistEntries: TokenAllowlistEntry[];
  walletOptions: PaymentsDashboardWallet[];
  t: Translate;
}): SeizeValidationErrors {
  const normalizedSource = source.trim();
  const normalizedDestination = destination.trim();
  const normalizedAmount = amount.trim();
  let amountError: string | null = null;
  let sourceError: string | null = null;
  let destinationError: string | null = null;

  if (normalizedSource && normalizedDestination && normalizedSource === normalizedDestination) {
    destinationError = t("DashboardIssuance.management.destinationMustDiffer");
  }

  if (!destinationError && normalizedDestination) {
    destinationError = getDestinationAccessControlError({
      token,
      destination: normalizedDestination,
      allowlistEntries,
      t,
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
    amountError = t("DashboardIssuance.management.validTransferAmount");
  } else if (amountBaseUnits <= ZERO_BIGINT) {
    amountError = t("DashboardIssuance.management.transferAmountPositive");
  }

  const sourceWallet = findWalletByPublicKey(walletOptions, normalizedSource);
  const sourceBalance = sourceWallet
    ? getWalletTokenBalanceRecord(sourceWallet, token.mintAddress)
    : null;
  if (sourceWallet && Array.isArray(sourceWallet.balances) && !sourceBalance) {
    sourceError = t("DashboardIssuance.management.selectedSourceDoesNotHoldToken");
    amountError = null;
  }

  if (
    !sourceError &&
    sourceBalance?.amount &&
    amountBaseUnits !== null &&
    amountBaseUnits > BigInt(sourceBalance.amount)
  ) {
    amountError = t("DashboardIssuance.management.selectedWalletOnlyShows", {
      amount: sourceBalance.uiAmount,
      symbol: getTokenDisplaySymbol(token, t),
    });
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
  t: Translate;
}): string | null {
  const errors = getSeizeValidationErrors(args);
  return getFirstValidationError(errors.source, errors.destination, errors.amount);
}

export function getForceBurnValidationErrors({
  token,
  source,
  amount,
  walletOptions,
  t,
}: {
  token: Token;
  source: string;
  amount: string;
  walletOptions: PaymentsDashboardWallet[];
  t: Translate;
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
    amountError = t("DashboardIssuance.management.validBurnAmount");
  } else if (amountBaseUnits <= ZERO_BIGINT) {
    amountError = t("DashboardIssuance.management.forceBurnAmountPositive");
  }

  const sourceWallet = findWalletByPublicKey(walletOptions, source.trim());
  const sourceBalance = sourceWallet
    ? getWalletTokenBalanceRecord(sourceWallet, token.mintAddress)
    : null;
  const sourceError =
    sourceWallet && Array.isArray(sourceWallet.balances) && !sourceBalance
      ? t("DashboardIssuance.management.selectedSourceDoesNotHoldToken")
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
    amountError = t("DashboardIssuance.management.selectedWalletOnlyShows", {
      amount: sourceBalance.uiAmount,
      symbol: getTokenDisplaySymbol(token, t),
    });
  }

  const totalSupply = parseTokenAmountToBaseUnits(token.totalSupply, token.decimals);
  if (totalSupply !== null && amountBaseUnits !== null && amountBaseUnits > totalSupply) {
    amountError = t("DashboardIssuance.management.forceBurnAmountExceedsSupply", {
      amount: token.totalSupply,
      symbol: getTokenDisplaySymbol(token, t),
    });
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
  t: Translate;
}): string | null {
  const errors = getForceBurnValidationErrors(args);
  return getFirstValidationError(errors.source, errors.amount);
}

export function getExtensionRows(token: Token, t: Translate): ExtensionRow[] {
  const configuredExtensionRows: ExtensionRow[] = [];
  const controlListCopy = getControlListCopy(getTokenAccessControlMode(token), t);

  if (token.extensions?.defaultAccountState) {
    configuredExtensionRows.push({
      id: "default-account-state",
      title: t("DashboardIssuance.management.defaultAccountState"),
      helper: t("DashboardIssuance.management.defaultAccountStateHelper"),
      value: formatDisplayLabel(token.extensions.defaultAccountState),
    });
  }

  if (token.extensions?.transferFee) {
    configuredExtensionRows.push({
      id: "transfer-fee",
      title: t("DashboardIssuance.management.transferFee"),
      helper: t("DashboardIssuance.management.transferFeeHelper"),
      value: t("DashboardIssuance.management.configured"),
    });
  }

  if (token.extensions?.scaledUiAmount) {
    configuredExtensionRows.push({
      id: "scaled-ui",
      title: t("DashboardIssuance.management.scaledUiAmount"),
      helper: t("DashboardIssuance.management.scaledUiAmountHelper"),
      value: t("DashboardIssuance.management.configured"),
    });
  }

  if (token.extensions?.transferHook) {
    configuredExtensionRows.push({
      id: "transfer-hook",
      title: t("DashboardIssuance.management.transferHook"),
      helper: t("DashboardIssuance.management.transferHookHelper"),
      value: t("DashboardIssuance.management.configured"),
    });
  }

  if (token.extensions?.interestBearing) {
    configuredExtensionRows.push({
      id: "interest-bearing",
      title: t("DashboardIssuance.management.interestBearing"),
      helper: t("DashboardIssuance.management.interestBearingHelper"),
      value: t("DashboardIssuance.management.configured"),
    });
  }

  if (token.extensions?.nonTransferable) {
    configuredExtensionRows.push({
      id: "non-transferable",
      title: t("DashboardIssuance.management.nonTransferable"),
      helper: t("DashboardIssuance.management.nonTransferableHelper"),
      value: t("DashboardIssuance.management.enabled"),
    });
  }

  return [
    {
      id: "template",
      title: t("DashboardIssuance.management.template"),
      helper: t("DashboardIssuance.management.templateHelper"),
      value: formatDisplayLabel(token.template),
    },
    ...(controlListCopy
      ? [
          {
            id: "control-list",
            title: controlListCopy.label,
            helper: controlListCopy.extensionHelper,
            value: t("DashboardIssuance.management.enabled"),
          } satisfies ExtensionRow,
        ]
      : []),
    {
      id: "mintable",
      title: t("DashboardIssuance.management.mintable"),
      helper: t("DashboardIssuance.management.mintableHelper"),
      value: token.isMintable
        ? t("DashboardIssuance.management.enabled")
        : t("DashboardIssuance.management.disabled"),
    },
    {
      id: "freezable",
      title: t("DashboardIssuance.management.freezable"),
      helper: t("DashboardIssuance.management.freezableHelper"),
      value: token.isFreezable
        ? t("DashboardIssuance.management.enabled")
        : t("DashboardIssuance.management.disabled"),
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
