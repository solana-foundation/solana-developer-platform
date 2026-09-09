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
  "nodit",
  "quicknode",
  "triton",
  "validationcloud",
] as const;
export type OrganizationRpcProvider = (typeof ORGANIZATION_RPC_PROVIDERS)[number];

export const DASHBOARD_QUICK_START_STEPS = ["api-key", "wallet", "faucet", "done"] as const;
export type DashboardQuickStartStep = (typeof DASHBOARD_QUICK_START_STEPS)[number];

/** Progress is monotonic so late responses or stale tabs cannot reopen setup. */
export function advanceQuickStartProgress(
  current: unknown,
  incoming: unknown
): DashboardQuickStartStep {
  const ranks: readonly unknown[] = DASHBOARD_QUICK_START_STEPS;
  return DASHBOARD_QUICK_START_STEPS[Math.max(0, ranks.indexOf(current), ranks.indexOf(incoming))];
}

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
  /** Optional dashboard guide; independent of legacy provider setup. */
  quickStartStep?: DashboardQuickStartStep;
  rpcProvider?: OrganizationRpcProvider;
  defaultEnvironment?: "sandbox" | "production";
  webhookSecret?: string;
  allowedIpAddresses?: string[];
  /**
   * Pre-enforcement allowlist parked by migration 0055 — never applied, any
   * shape (predates validation). Re-apply by sending it as `allowedIpAddresses`.
   */
  legacyAllowedIpAddresses?: unknown;
  providerOverrides?: OrganizationProviderOverrides;
  /**
   * Set from Clerk org `private_metadata.sdp.enableProductionProject` by the
   * Clerk webhook sync; `true` unlocks selecting production projects in the
   * dashboard.
   */
  enableProductionProject?: boolean;
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
