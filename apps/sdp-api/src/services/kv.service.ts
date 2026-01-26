/**
 * KV Service
 *
 * Manages caching for API keys, organizations, and allowlist entries.
 */

import type { CachedApiKey, CachedSession } from "@sdp/types";
import type { Organization } from "@sdp/types";

// TTL constants (in seconds)
const TTL = {
  API_KEY: 3600, // 1 hour
  ORGANIZATION: 300, // 5 minutes
  ALLOWLIST: 3600, // 1 hour
  SESSION: 3600, // 1 hour
};

export class KVService {
  constructor(
    private apiKeysKV: KVNamespace,
    private cacheKV: KVNamespace,
    private sessionsKV?: KVNamespace
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // API Keys
  // ═══════════════════════════════════════════════════════════════════════════

  async getApiKey(keyHash: string): Promise<CachedApiKey | null> {
    return this.apiKeysKV.get(`key:${keyHash}`, "json");
  }

  async setApiKey(keyHash: string, data: CachedApiKey): Promise<void> {
    await this.apiKeysKV.put(`key:${keyHash}`, JSON.stringify(data), {
      expirationTtl: TTL.API_KEY,
    });
  }

  async deleteApiKey(keyHash: string): Promise<void> {
    await this.apiKeysKV.delete(`key:${keyHash}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Organizations
  // ═══════════════════════════════════════════════════════════════════════════

  async getOrganization(orgId: string): Promise<Organization | null> {
    return this.cacheKV.get(`org:${orgId}`, "json");
  }

  async setOrganization(org: Organization): Promise<void> {
    await this.cacheKV.put(`org:${org.id}`, JSON.stringify(org), {
      expirationTtl: TTL.ORGANIZATION,
    });
  }

  async deleteOrganization(orgId: string): Promise<void> {
    await this.cacheKV.delete(`org:${orgId}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Allowlist
  // ═══════════════════════════════════════════════════════════════════════════

  async isEmailAllowlisted(emailHash: string): Promise<boolean> {
    const result = await this.cacheKV.get(`allowlist:email:${emailHash}`);
    return result !== null;
  }

  async setEmailAllowlisted(emailHash: string, tier: string): Promise<void> {
    await this.cacheKV.put(`allowlist:email:${emailHash}`, tier, {
      expirationTtl: TTL.ALLOWLIST,
    });
  }

  async isDomainAllowlisted(domain: string): Promise<string | null> {
    return this.cacheKV.get(`allowlist:domain:${domain}`);
  }

  async setDomainAllowlisted(domain: string, tier: string): Promise<void> {
    await this.cacheKV.put(`allowlist:domain:${domain}`, tier, {
      expirationTtl: TTL.ALLOWLIST,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Sessions
  // ═══════════════════════════════════════════════════════════════════════════

  async getSession(sessionId: string): Promise<CachedSession | null> {
    if (!this.sessionsKV) {
      return null;
    }
    return this.sessionsKV.get(`session:${sessionId}`, "json");
  }

  async setSession(sessionId: string, data: CachedSession): Promise<void> {
    if (!this.sessionsKV) {
      return;
    }
    await this.sessionsKV.put(`session:${sessionId}`, JSON.stringify(data), {
      expirationTtl: TTL.SESSION,
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.sessionsKV) {
      return;
    }
    await this.sessionsKV.delete(`session:${sessionId}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Utilities
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Invalidate all cached data for an organization
   */
  async invalidateOrganization(orgId: string): Promise<void> {
    await this.deleteOrganization(orgId);
    // Note: API keys are invalidated individually when revoked
  }
}
