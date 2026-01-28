/**
 * KV Service tests
 */

import { KVService } from "@/services/kv.service";
import { TEST_CACHED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import type { Organization } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("KVService", () => {
  let kvService: KVService;

  beforeEach(() => {
    kvService = new KVService(env.SDP_API_KEYS, env.SDP_CACHE);
  });

  afterEach(async () => {
    // Clear KV namespaces between tests
    const apiKeysList = await env.SDP_API_KEYS.list();
    for (const key of apiKeysList.keys) {
      await env.SDP_API_KEYS.delete(key.name);
    }

    const cacheList = await env.SDP_CACHE.list();
    for (const key of cacheList.keys) {
      await env.SDP_CACHE.delete(key.name);
    }
  });

  describe("API Keys", () => {
    const testKeyHash = "abc123def456";

    it("returns null for non-existent key", async () => {
      const result = await kvService.getApiKey("nonexistent");
      expect(result).toBeNull();
    });

    it("stores and retrieves API key data", async () => {
      await kvService.setApiKey(testKeyHash, TEST_CACHED_API_KEY);

      const result = await kvService.getApiKey(testKeyHash);

      expect(result).toEqual(TEST_CACHED_API_KEY);
    });

    it("deletes API key data", async () => {
      await kvService.setApiKey(testKeyHash, TEST_CACHED_API_KEY);
      await kvService.deleteApiKey(testKeyHash);

      const result = await kvService.getApiKey(testKeyHash);
      expect(result).toBeNull();
    });

    it("overwrites existing key data", async () => {
      await kvService.setApiKey(testKeyHash, TEST_CACHED_API_KEY);

      const updated = { ...TEST_CACHED_API_KEY, role: "api_readonly" as const };
      await kvService.setApiKey(testKeyHash, updated);

      const result = await kvService.getApiKey(testKeyHash);
      expect(result?.role).toBe("api_readonly");
    });
  });

  describe("Organizations", () => {
    const testOrg: Organization = {
      id: TEST_ORG.id,
      name: TEST_ORG.name,
      slug: TEST_ORG.slug,
      tier: TEST_ORG.tier,
      status: TEST_ORG.status,
      settings: null,
      createdAt: TEST_ORG.createdAt,
      updatedAt: TEST_ORG.updatedAt,
    };

    it("returns null for non-existent organization", async () => {
      const result = await kvService.getOrganization("nonexistent");
      expect(result).toBeNull();
    });

    it("stores and retrieves organization data", async () => {
      await kvService.setOrganization(testOrg);

      const result = await kvService.getOrganization(testOrg.id);

      expect(result).toEqual(testOrg);
    });

    it("deletes organization data", async () => {
      await kvService.setOrganization(testOrg);
      await kvService.deleteOrganization(testOrg.id);

      const result = await kvService.getOrganization(testOrg.id);
      expect(result).toBeNull();
    });
  });

  describe("Allowlist", () => {
    const testEmailHash = "emailhash123";
    const testDomain = "example.com";

    describe("email allowlist", () => {
      it("returns false for non-allowlisted email", async () => {
        const result = await kvService.isEmailAllowlisted("unknown");
        expect(result).toBe(false);
      });

      it("returns true for allowlisted email", async () => {
        await kvService.setEmailAllowlisted(testEmailHash, "pro");

        const result = await kvService.isEmailAllowlisted(testEmailHash);
        expect(result).toBe(true);
      });
    });

    describe("domain allowlist", () => {
      it("returns null for non-allowlisted domain", async () => {
        const result = await kvService.isDomainAllowlisted("unknown.com");
        expect(result).toBeNull();
      });

      it("returns tier for allowlisted domain", async () => {
        await kvService.setDomainAllowlisted(testDomain, "enterprise");

        const result = await kvService.isDomainAllowlisted(testDomain);
        expect(result).toBe("enterprise");
      });
    });
  });

  // biome-ignore lint/nursery/noSecrets: Test describe block name, not a secret
  describe("invalidateOrganization", () => {
    it("removes organization from cache", async () => {
      const testOrg: Organization = {
        id: TEST_ORG.id,
        name: TEST_ORG.name,
        slug: TEST_ORG.slug,
        tier: TEST_ORG.tier,
        status: TEST_ORG.status,
        settings: null,
        createdAt: TEST_ORG.createdAt,
        updatedAt: TEST_ORG.updatedAt,
      };

      await kvService.setOrganization(testOrg);
      expect(await kvService.getOrganization(testOrg.id)).not.toBeNull();

      await kvService.invalidateOrganization(testOrg.id);

      expect(await kvService.getOrganization(testOrg.id)).toBeNull();
    });
  });
});
