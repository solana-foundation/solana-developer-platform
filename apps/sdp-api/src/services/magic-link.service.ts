/**
 * Magic Link Service
 *
 * Handles passwordless authentication via email magic links.
 */

import { hashString } from "@/lib/hash";
import type { MagicLink } from "@sdp/types";

// Magic link expires in 15 minutes
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);

  const globalWithBuffer = globalThis as {
    Buffer?: {
      from: (input: Uint8Array) => { toString: (encoding: "base64") => string };
    };
  };

  if (globalWithBuffer.Buffer) {
    return globalWithBuffer.Buffer.from(bytes)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export interface MagicLinkResult {
  id: string;
  token: string;
  expiresAt: string;
}

export interface VerifyResult {
  id: string;
  email: string;
  organizationId: string | null;
}

export class MagicLinkService {
  constructor(private db: D1Database) {}

  /**
   * Create a new magic link for an email address
   */
  async createMagicLink(email: string, organizationId?: string): Promise<MagicLinkResult> {
    const id = `ml_${crypto.randomUUID()}`;
    const token = randomBase64Url(32);
    const tokenHash = await hashString(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + MAGIC_LINK_TTL_MS);

    // Invalidate any existing unused magic links for this email
    await this.db
      .prepare(
        "UPDATE magic_links SET used_at = datetime('now') WHERE email = ? AND used_at IS NULL"
      )
      .bind(email.toLowerCase())
      .run();

    // Create new magic link
    await this.db
      .prepare(
        `INSERT INTO magic_links (id, email, token_hash, organization_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        email.toLowerCase(),
        tokenHash,
        organizationId ?? null,
        expiresAt.toISOString(),
        now.toISOString()
      )
      .run();

    return {
      id,
      token,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Verify a magic link token
   * Returns the email and organization if valid, null if invalid/expired/used
   */
  async verifyMagicLink(token: string): Promise<VerifyResult | null> {
    const tokenHash = await hashString(token);

    const row = await this.db
      .prepare(
        `SELECT id, email, organization_id, expires_at, used_at
         FROM magic_links
         WHERE token_hash = ?`
      )
      .bind(tokenHash)
      .first<{
        id: string;
        email: string;
        organization_id: string | null;
        expires_at: string;
        used_at: string | null;
      }>();

    if (!row) {
      return null;
    }

    // Check if already used
    if (row.used_at) {
      return null;
    }

    // Check if expired
    if (new Date(row.expires_at) < new Date()) {
      return null;
    }

    // Mark as used
    await this.db
      .prepare("UPDATE magic_links SET used_at = datetime('now') WHERE id = ?")
      .bind(row.id)
      .run();

    return {
      id: row.id,
      email: row.email,
      organizationId: row.organization_id,
    };
  }

  /**
   * Invalidate a magic link by ID
   */
  async invalidateMagicLink(id: string): Promise<void> {
    await this.db
      .prepare("UPDATE magic_links SET used_at = datetime('now') WHERE id = ?")
      .bind(id)
      .run();
  }

  /**
   * Get magic link details (for admin/debugging)
   */
  async getMagicLink(id: string): Promise<MagicLink | null> {
    const row = await this.db
      .prepare(
        `SELECT id, email, token_hash, organization_id, expires_at, used_at, created_at
         FROM magic_links
         WHERE id = ?`
      )
      .bind(id)
      .first<{
        id: string;
        email: string;
        token_hash: string;
        organization_id: string | null;
        expires_at: string;
        used_at: string | null;
        created_at: string;
      }>();

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      email: row.email,
      tokenHash: row.token_hash,
      organizationId: row.organization_id,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      createdAt: row.created_at,
    };
  }

  /**
   * Clean up expired magic links (for maintenance)
   */
  async cleanupExpired(): Promise<number> {
    const result = await this.db
      .prepare("DELETE FROM magic_links WHERE expires_at < datetime('now')")
      .run();

    return result.meta.changes ?? 0;
  }
}
