import type {
  FrozenAccount,
  PaymentsDashboardWallet,
  Token,
  TokenAllowlistEntry,
  TokenTransaction,
} from "@sdp/types";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
export type TokenManagementTab =
  | "overview"
  | "permissions"
  | "extensions"
  | "compliance"
  | "metadata"
  | "fund-management";
export type AdminAction =
  | "update-metadata"
  | "mint"
  | "burn"
  | "seize"
  | "force-burn"
  | "authority"
  | "pause"
  | "freeze"
  | "allowlist";

export type DeployFeePayment = "sponsored" | "wallet";

export interface ActionExecutionInput {
  label: string;
  method: HttpMethod;
  path: string;
  body?: unknown;
}

export interface ExecuteRouteResponse {
  ok?: boolean;
  status?: number;
  body?: unknown;
  error?: string;
}

export interface ActionExecutionResult {
  ok: boolean;
  message: string;
  status: number | null;
  body: unknown;
}

export interface RunActionOptions {
  requiresConfirmation?: boolean;
  confirmationTitle?: string;
  confirmationDescription?: string;
  confirmButtonLabel?: string;
  submitToast?: string;
  successToast?: string;
  onSuccess?: (result: ActionExecutionResult) => Promise<void> | void;
}

export interface ActionConfirmationState {
  input: ActionExecutionInput;
  options: Required<
    Pick<
      RunActionOptions,
      | "confirmationTitle"
      | "confirmationDescription"
      | "confirmButtonLabel"
      | "submitToast"
      | "successToast"
    >
  > &
    Pick<RunActionOptions, "onSuccess">;
}

export interface TokenManagementWorkspaceProps {
  token: Token;
  tokenError: string | null;
  authorityWallets: PaymentsDashboardWallet[];
  authorityWalletsError: string | null;
  transactions: TokenTransaction[];
  transactionsError: string | null;
  transactionsTotal: number | null;
  transactionsHasMore: boolean;
  allowlistEntries: TokenAllowlistEntry[];
  allowlistError: string | null;
  allowlistTotal: number | null;
  allowlistHasMore: boolean;
  frozenAccounts: FrozenAccount[];
  frozenAccountsError: string | null;
  frozenAccountsTotal: number | null;
  frozenAccountsHasMore: boolean;
}

export interface MetadataFormState {
  name: string;
  description: string;
  uri: string;
  imageUrl: string;
}

export interface MintFormState {
  destination: string;
  amount: string;
  memo: string;
  signingWalletId: string;
}

export interface BurnFormState {
  source: string;
  amount: string;
  memo: string;
  signingWalletId: string;
}

export interface SeizeFormState {
  source: string;
  destination: string;
  amount: string;
  delegateAuthority: string;
  memo: string;
  signingWalletId: string;
}

export interface ForceBurnFormState {
  source: string;
  amount: string;
  delegateAuthority: string;
  memo: string;
  signingWalletId: string;
}

export interface MintValidationErrors {
  destination: string | null;
  amount: string | null;
}

export interface BurnValidationErrors {
  source: string | null;
  amount: string | null;
}

export interface SeizeValidationErrors {
  source: string | null;
  destination: string | null;
  amount: string | null;
}

export interface ForceBurnValidationErrors {
  source: string | null;
  amount: string | null;
}

export interface AuthorityFormState {
  role: "mint" | "freeze" | "permanentDelegate" | "metadata";
  currentAuthority: string;
  newAuthority: string;
}

export interface FreezeFormState {
  accountAddress: string;
  reason: string;
}

export interface AllowlistFormState {
  address: string;
  label: string;
}

export interface PermissionRow {
  id: string;
  title: string;
  helper: string;
  value: string | null;
  authorityRole: AuthorityFormState["role"];
  editDisabledReason?: string | null;
}

export interface ExtensionRow {
  id: string;
  title: string;
  helper: string;
  value: string;
}
