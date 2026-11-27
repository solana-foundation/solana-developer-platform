import {
  supportsVaultDirect,
  supportsVaultParRedemption,
  supportsVaultWithdraw,
} from "@sdp/earn/capabilities";
import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import { resolveEarnExecutionClient } from "./earn/execution-registry";
import { createVaultDeadline } from "./earn/vault-deadline";
import { EARN_PROVIDER_CLIENTS, resolveEarnProviderClient } from "./earn-provider-registry";

describe("API Earn provider registry", () => {
  it("registers Kamino's executable vault-direct client", () => {
    const client = resolveEarnProviderClient("kamino");

    expect(client).toBe(EARN_PROVIDER_CLIENTS.kamino);
    expect(supportsVaultDirect(client)).toBe(true);
  });

  it("keeps the non-Kamino provider singletons", () => {
    expect(resolveEarnProviderClient("upshift")).toBe(EARN_PROVIDER_CLIENTS.upshift);
  });

  it("registers Hastra's deposit, par, and optional liquid-exit capabilities", () => {
    const client = resolveEarnProviderClient("hastra");

    expect(client).toBe(EARN_PROVIDER_CLIENTS.hastra);
    expect(supportsVaultDirect(client)).toBe(true);
    expect(supportsVaultWithdraw(client)).toBe(true);
    expect(supportsVaultParRedemption(client)).toBe(true);
  });
  it("preserves singleton identity while creating a fresh client for each operation", () => {
    const singleton = resolveEarnProviderClient("hastra");
    const first = resolveEarnExecutionClient({} as Env, "hastra", createVaultDeadline());
    const second = resolveEarnExecutionClient({} as Env, "hastra", createVaultDeadline());

    expect(resolveEarnProviderClient("hastra")).toBe(singleton);
    expect(first).not.toBe(singleton);
    expect(second).not.toBe(first);
    expect(first?.provider).toBe(singleton.provider);
  });

  it.each(["unregistered", "toString", "constructor", "__proto__"])(
    "keeps unknown provider %s unavailable in both registries",
    (provider) => {
      expect(() => resolveEarnProviderClient(provider)).toThrow("is not available");
      expect(resolveEarnExecutionClient({} as Env, provider, createVaultDeadline())).toBeNull();
    }
  );
});
