/**
 * Organization Types
 */

import type { OrganizationRole } from "./permissions";

export const ORGANIZATION_TIERS = ["free", "pro", "enterprise"] as const;
export type OrganizationTier = (typeof ORGANIZATION_TIERS)[number];

export const ORGANIZATION_STATUSES = ["active", "suspended", "deleted"] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

export type MemberStatus = "active" | "suspended" | "removed";

export type InvitationStatus = "pending" | "accepted" | "expired" | "revoked";
export const ORGANIZATION_RPC_PROVIDERS = [
  "alchemy",
  "default",
  "helius",
  "quicknode",
  "triton",
] as const;
export type OrganizationRpcProvider = (typeof ORGANIZATION_RPC_PROVIDERS)[number];

export interface Organization {
  id: string; // org_xxxxxxxxxxxx
  name: string;
  slug: string;
  tier: OrganizationTier;
  status: OrganizationStatus;
  settings: OrganizationSettings | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationSettings {
  rpcProvider?: OrganizationRpcProvider;
  defaultEnvironment?: "sandbox" | "production";
  webhookSecret?: string;
  allowedIpAddresses?: string[];
  customRateLimits?: {
    requestsPerMinute?: number;
    requestsPerDay?: number;
  };
}

export interface User {
  id: string; // usr_xxxxxxxxxxxx
  email: string;
  emailVerified: boolean;
  name: string | null;
  status: "active" | "suspended" | "deleted";
  createdAt: string;
}

export interface OrganizationMember {
  id: string;
  organizationId: string;
  userId: string;
  role: OrganizationRole;
  status: MemberStatus;
  createdAt: string;
}

export interface OrganizationMemberWithUser extends OrganizationMember {
  user: User;
}

export interface Invitation {
  id: string;
  organizationId: string;
  email: string;
  role: OrganizationRole;
  invitedBy: string;
  tokenHash: string;
  expiresAt: string;
  status: InvitationStatus;
  createdAt: string;
}

// API Request/Response types
export interface CreateOrganizationRequest {
  name: string;
  slug?: string;
  email: string; // Creator's email (for allowlist check)
  returnFullApiKey?: boolean;
  custody?: CreateOrganizationCustody;
}

export type CreateOrganizationCustody =
  | CreateOrganizationCustodyFireblocks
  | CreateOrganizationCustodyPrivy
  | CreateOrganizationCustodyCoinbaseCdp
  | CreateOrganizationCustodyPara
  | CreateOrganizationCustodyTurnkey;

export interface CreateOrganizationCustodyFireblocks {
  provider: "fireblocks";
  apiBaseUrl?: string;
  assetId?: string;
  vaultAccountId?: string;
}

export interface CreateOrganizationCustodyPrivy {
  provider: "privy";
  apiBaseUrl?: string;
  walletId?: string;
  requestDelayMs?: number;
}

export interface CreateOrganizationCustodyCoinbaseCdp {
  provider: "coinbase_cdp";
  apiBaseUrl?: string;
  network?: "solana" | "solana-devnet";
  walletAddress?: string;
  accountPolicy?: string;
}

export interface CreateOrganizationCustodyPara {
  provider: "para";
  apiBaseUrl?: string;
  requestDelayMs?: number;
  walletId?: string;
}

export interface CreateOrganizationCustodyTurnkey {
  provider: "turnkey";
  apiBaseUrl?: string;
  requestDelayMs?: number;
  privateKeyId?: string;
}

export interface CreateOrganizationResponse {
  organization: Organization;
  apiKey: {
    id: string;
    key?: string; // Full key, only shown once when returnFullApiKey is true
    keyPrefix: string;
  };
}

export interface InviteMemberRequest {
  email: string;
  role: OrganizationRole;
}

export interface AcceptInvitationRequest {
  token: string;
  name?: string;
}
