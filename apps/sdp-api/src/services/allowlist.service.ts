/**
 * Allowlist Service
 *
 * Database-backed allowlist used for SDP org provisioning flows.
 * Clerk has its own allowlist for signups; this service is intentionally local and testable.
 */

import { getDb } from "@/db";
import type { Env } from "@/types/env";

export interface AllowlistEntry {
  id: string;
  type: "email" | "domain";
  value: string;
  tier: string;
  notes: string | null;
  status: "active" | "disabled";
  createdAt: string;
}

export interface AllowlistProvider {
  listEntries(options?: {
    type?: "email" | "domain";
    status?: "active" | "disabled";
  }): Promise<AllowlistEntry[]>;
  addEntry(entry: {
    id: string;
    type: "email" | "domain";
    value: string;
    tier: string;
    notes?: string | null;
  }): Promise<AllowlistEntry>;
  removeEntry(id: string): Promise<void>;
  getEntry(id: string): Promise<AllowlistEntry | null>;
  isEmailAllowed(email: string): Promise<{ allowed: boolean; tier: string }>;
}

class PostgresAllowlistService implements AllowlistProvider {
  constructor(private db: DatabaseClient) {}

  async listEntries(
    options: { type?: "email" | "domain"; status?: "active" | "disabled" } = {}
  ): Promise<AllowlistEntry[]> {
    const where: string[] = [];
    const params: string[] = [];

    if (options.type) {
      where.push("type = ?");
      params.push(options.type);
    }
    if (options.status) {
      where.push("status = ?");
      params.push(options.status);
    }

    const sql = `
      SELECT id, type, value, tier, notes, status, created_at
      FROM allowlist
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC
    `;

    const res = await this.db
      .prepare(sql)
      .bind(...params)
      .all<{
        id: string;
        type: string;
        value: string;
        tier: string | null;
        notes: string | null;
        status: string;
        created_at: string;
      }>();

    return (res.results ?? []).map((row) => ({
      id: row.id,
      type: row.type as "email" | "domain",
      value: row.value,
      tier: row.tier ?? "standard",
      notes: row.notes,
      status: row.status as "active" | "disabled",
      createdAt: row.created_at,
    }));
  }

  async addEntry(entry: {
    id: string;
    type: "email" | "domain";
    value: string;
    tier: string;
    notes?: string | null;
  }): Promise<AllowlistEntry> {
    const value = entry.value.toLowerCase().trim();
    const now = new Date().toISOString();

    await this.db
      .prepare(
        `INSERT INTO allowlist (id, type, value, tier, notes, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`
      )
      .bind(entry.id, entry.type, value, entry.tier, entry.notes ?? null, now)
      .run();

    return {
      id: entry.id,
      type: entry.type,
      value,
      tier: entry.tier,
      notes: entry.notes ?? null,
      status: "active",
      createdAt: now,
    };
  }

  async removeEntry(id: string): Promise<void> {
    // Soft-disable to preserve auditability and avoid id reuse.
    await this.db.prepare("UPDATE allowlist SET status = 'disabled' WHERE id = ?").bind(id).run();
  }

  async getEntry(id: string): Promise<AllowlistEntry | null> {
    const row = await this.db
      .prepare(
        `SELECT id, type, value, tier, notes, status, created_at
         FROM allowlist
         WHERE id = ?`
      )
      .bind(id)
      .first<{
        id: string;
        type: string;
        value: string;
        tier: string | null;
        notes: string | null;
        status: string;
        created_at: string;
      }>();

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      type: row.type as "email" | "domain",
      value: row.value,
      tier: row.tier ?? "standard",
      notes: row.notes,
      status: row.status as "active" | "disabled",
      createdAt: row.created_at,
    };
  }

  async isEmailAllowed(email: string): Promise<{ allowed: boolean; tier: string }> {
    const normalized = email.toLowerCase().trim();
    const domain = normalized.split("@")[1] ?? "";

    const row = await this.db
      .prepare(
        `SELECT tier
         FROM allowlist
         WHERE status = 'active'
           AND (
             (type = 'email' AND lower(value) = ?)
             OR (type = 'domain' AND lower(value) = ?)
           )
         LIMIT 1`
      )
      .bind(normalized, domain)
      .first<{ tier: string | null }>();

    return { allowed: Boolean(row), tier: row?.tier ?? "standard" };
  }
}

export function createAllowlistService(env: Env): AllowlistProvider {
  return new PostgresAllowlistService(getDb(env));
}
