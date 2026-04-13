/**
 * Organization Types
 */

import type { OrganizationRole } from "./permissions";
import type { OrganizationProviderOverrides } from "./provider-access";

export const ORGANIZATION_TIERS = ["individual", "enterprise"] as const;
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
  providerOverrides?: OrganizationProviderOverrides;
  customRateLimits?: {
    requestsPerMinute?: number;
    requestsPerDay?: number;
  };
}

const LEGACY_ORGANIZATION_TIER_ALIASES = {
  standard: "individual",
  starter: "individual",
  pro: "enterprise",
  growth: "enterprise",
} as const;

export function isOrganizationTier(value: string | null | undefined): value is OrganizationTier {
  return ORGANIZATION_TIERS.includes(value as OrganizationTier);
}

export function normalizeOrganizationTier(value: string | null | undefined): OrganizationTier {
  if (!value) {
    return "enterprise";
  }

  if (isOrganizationTier(value)) {
    return value;
  }

  const legacyTier =
    LEGACY_ORGANIZATION_TIER_ALIASES[value as keyof typeof LEGACY_ORGANIZATION_TIER_ALIASES];
  return legacyTier ?? "individual";
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

export interface InviteMemberRequest {
  email: string;
  role: OrganizationRole;
}

export interface AcceptInvitationRequest {
  token: string;
  name?: string;
}
