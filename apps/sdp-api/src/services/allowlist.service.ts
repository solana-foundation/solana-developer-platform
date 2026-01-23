/**
 * Allowlist Service
 *
 * Manages email/domain allowlist for access control.
 */

import { hashString } from "@/lib/crypto";
import { KVService } from "./kv.service";

export interface AllowlistEntry {
  id: string;
  type: "email" | "domain";
  value: string;
  tier: string;
  notes: string | null;
  status: "active" | "disabled";
  createdAt: string;
}

export class AllowlistService {
  constructor(
    private db: D1Database,
    private kv: KVService
  ) {}

  /**
   * Check if an email is allowed to create an organization
   * Checks both direct email and domain allowlists
   */
  async isEmailAllowed(email: string): Promise<{ allowed: boolean; tier: string }> {
    const normalizedEmail = email.toLowerCase().trim();
    const domain = normalizedEmail.split("@")[1];

    // Check email hash in KV cache first
    const emailHash = await hashString(normalizedEmail);
    if (await this.kv.isEmailAllowlisted(emailHash)) {
      return { allowed: true, tier: "standard" };
    }

    // Check domain in KV cache
    const domainTier = await this.kv.isDomainAllowlisted(domain);
    if (domainTier) {
      return { allowed: true, tier: domainTier };
    }

    // Fall back to D1 lookup
    const result = await this.db
      .prepare(
        `SELECT type, value, tier FROM allowlist
         WHERE status = 'active'
         AND ((type = 'email' AND value = ?) OR (type = 'domain' AND value = ?))
         LIMIT 1`
      )
      .bind(normalizedEmail, domain)
      .first<{ type: string; value: string; tier: string }>();

    if (result) {
      // Cache the result
      if (result.type === "email") {
        await this.kv.setEmailAllowlisted(emailHash, result.tier);
      } else {
        await this.kv.setDomainAllowlisted(domain, result.tier);
      }
      return { allowed: true, tier: result.tier };
    }

    return { allowed: false, tier: "standard" };
  }

  /**
   * Add an entry to the allowlist
   */
  async addEntry(entry: {
    id: string;
    type: "email" | "domain";
    value: string;
    tier?: string;
    notes?: string;
  }): Promise<AllowlistEntry> {
    const normalizedValue = entry.value.toLowerCase().trim();

    await this.db
      .prepare(
        `INSERT INTO allowlist (id, type, value, tier, notes, status)
         VALUES (?, ?, ?, ?, ?, 'active')`
      )
      .bind(
        entry.id,
        entry.type,
        normalizedValue,
        entry.tier || "standard",
        entry.notes || null
      )
      .run();

    return {
      id: entry.id,
      type: entry.type,
      value: normalizedValue,
      tier: entry.tier || "standard",
      notes: entry.notes || null,
      status: "active",
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Remove an entry from the allowlist
   */
  async removeEntry(id: string): Promise<void> {
    await this.db
      .prepare(`UPDATE allowlist SET status = 'disabled' WHERE id = ?`)
      .bind(id)
      .run();
  }

  /**
   * List all allowlist entries
   */
  async listEntries(options: {
    type?: "email" | "domain";
    status?: "active" | "disabled";
    limit?: number;
    offset?: number;
  } = {}): Promise<AllowlistEntry[]> {
    const { type, status = "active", limit = 100, offset = 0 } = options;

    let query = "SELECT * FROM allowlist WHERE status = ?";
    const params: (string | number)[] = [status];

    if (type) {
      query += " AND type = ?";
      params.push(type);
    }

    query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const results = await this.db
      .prepare(query)
      .bind(...params)
      .all();

    return results.results.map((row) => ({
      id: row.id as string,
      type: row.type as "email" | "domain",
      value: row.value as string,
      tier: row.tier as string,
      notes: row.notes as string | null,
      status: row.status as "active" | "disabled",
      createdAt: row.created_at as string,
    }));
  }
}
