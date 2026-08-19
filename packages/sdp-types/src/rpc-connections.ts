import type { OrganizationRpcProvider } from "./organizations";

/**
 * Lifecycle an RPC Connection can be in. Same vocabulary as custody
 * Connections on purpose — one setup model across provider families, so a
 * dashboard that can render one can render the other.
 */
export const RPC_CONNECTION_LIFECYCLES = [
  "pending",
  "checking",
  "active",
  "failed",
  "deactivated",
] as const;
export type RpcConnectionLifecycle = (typeof RPC_CONNECTION_LIFECYCLES)[number];

export const RPC_CONNECTION_SCOPES = ["organization", "project"] as const;
export type RpcConnectionScope = (typeof RPC_CONNECTION_SCOPES)[number];

/**
 * A credential is only ever good for one cluster, so a Connection is bound to
 * one. Matches `RpcEnv["SOLANA_NETWORK"]`.
 */
export const RPC_CONNECTION_NETWORKS = ["devnet", "mainnet-beta"] as const;
export type RpcConnectionNetwork = (typeof RPC_CONNECTION_NETWORKS)[number];

export const RPC_CONNECTION_CHECK_STATUSES = [
  "pending",
  "running",
  "success",
  "failed",
  "retry_unknown",
] as const;
export type RpcConnectionCheckStatus = (typeof RPC_CONNECTION_CHECK_STATUSES)[number];

export interface RpcConnectionCheck {
  status: RpcConnectionCheckStatus;
  at: string | null;
  /** Redacted code only — never an upstream provider response. */
  failureCode: string | null;
}

/**
 * Everything an RPC Connection may leave the API as. Deliberately has no field
 * for a secret ref, secret version, or decrypted payload: the type is the
 * boundary, so a future field cannot leak one by being forgotten in a mapper.
 */
export interface SafeRpcConnection {
  id: string;
  provider: OrganizationRpcProvider;
  scope: RpcConnectionScope;
  projectId: string | null;
  network: RpcConnectionNetwork;
  status: RpcConnectionLifecycle;
  /** The connection the relay picks for this scope and network. */
  isDefault: boolean;
  displayMetadata: Record<string, unknown>;
  lastCheck: RpcConnectionCheck | null;
  createdAt: string;
  activatedAt: string | null;
  deactivatedAt: string | null;
  providerCredential: {
    id: string;
    label: string;
    status: string;
  };
}

export interface RpcConnectionListResponse {
  connections: SafeRpcConnection[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
}
