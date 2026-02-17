/**
 * Organization Types
 */

import type { OrganizationRole } from "./permissions";

export type OrganizationTier = "free" | "pro" | "enterprise";

export type OrganizationStatus = "active" | "suspended" | "deleted";

export type MemberStatus = "active" | "suspended" | "removed";

export type InvitationStatus = "pending" | "accepted" | "expired" | "revoked";

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
  | CreateOrganizationCustodyPrivy;

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
