/**
 * Session Types
 *
 * Sessions for UI authentication using magic link (passwordless) auth.
 */

import type { Permission } from "./permissions";

export type AuthMethod = "magic_link";

export interface Session {
  id: string; // ses_xxxxxxxxxxxx
  userId: string;
  organizationId: string;
  authMethod: AuthMethod;
  ipAddress: string | null;
  userAgent: string | null;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  lastActivityAt: string | null;
}

/**
 * Cached session data stored in KV for fast auth lookups
 */
export interface CachedSession {
  id: string;
  userId: string;
  organizationId: string;
  permissions: Permission[];
  expiresAt: string;
}

export interface MagicLink {
  id: string; // ml_xxxxxxxxxxxx
  email: string;
  tokenHash: string;
  organizationId: string | null;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

// API Request/Response types
export interface SendMagicLinkRequest {
  email: string;
  organizationId?: string; // Optional: direct to specific org
}

export interface SendMagicLinkResponse {
  success: boolean;
  message: string;
  expiresAt: string;
}

export interface VerifyMagicLinkResponse {
  session: {
    id: string;
    expiresAt: string;
  };
  user: {
    id: string;
    email: string;
    name: string | null;
  };
  organization: {
    id: string;
    name: string;
    slug: string;
  } | null;
}

export interface CurrentUserResponse {
  user: {
    id: string;
    email: string;
    name: string | null;
    lastLoginAt: string | null;
    loginCount: number;
  };
  organization: {
    id: string;
    name: string;
    slug: string;
    tier: string;
    role: string;
  };
  permissions: Permission[];
}

export interface ListSessionsResponse {
  sessions: Array<{
    id: string;
    authMethod: AuthMethod;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: string;
    lastActivityAt: string | null;
    current: boolean;
  }>;
}

export interface LogoutResponse {
  success: boolean;
}
