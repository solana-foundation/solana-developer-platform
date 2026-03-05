import type { FrozenAccount, Token, TokenAllowlistEntry, TokenTransaction } from "@sdp/types";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
export type SettingsTab = "permissions" | "extensions";
export type AdminAction =
  | "update-metadata"
  | "refresh-supply"
  | "mint"
  | "burn"
  | "seize"
  | "force-burn"
  | "authority"
  | "pause"
  | "freeze"
  | "allowlist";

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
  >;
}

export interface TokenManagementWorkspaceProps {
  token: Token;
  tokenError: string | null;
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
  status: "active" | "paused";
}

export interface MintFormState {
  destination: string;
  amount: string;
  memo: string;
}

export interface BurnFormState {
  source: string;
  amount: string;
  memo: string;
}

export interface SeizeFormState {
  source: string;
  destination: string;
  amount: string;
  delegateAuthority: string;
  memo: string;
}

export interface ForceBurnFormState {
  source: string;
  amount: string;
  delegateAuthority: string;
  memo: string;
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
  action: AdminAction;
}

export interface ExtensionRow {
  id: string;
  title: string;
  helper: string;
  value: string;
}
