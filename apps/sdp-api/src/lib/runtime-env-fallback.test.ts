import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import { withProcessEnvFallback } from "./runtime-env";

const emptyBindings = () => ({}) as Env;

describe("withProcessEnvFallback", () => {
  const touched: string[] = [];
  const setProcessEnv = (key: string, value: string) => {
    touched.push(key);
    process.env[key] = value;
  };

  afterEach(() => {
    for (const key of touched) {
      delete process.env[key];
    }
    touched.length = 0;
  });

  it("picks up a built-in fallback key from process.env", () => {
    setProcessEnv("SENTRY_DSN", "https://example.test/1");
    const merged = withProcessEnvFallback(emptyBindings());
    expect(merged.SENTRY_DSN).toBe("https://example.test/1");
  });

  it("does not pick up a key that was never registered", () => {
    setProcessEnv("PLUGIN_UNREGISTERED_SECRET", "leaked");
    const merged = withProcessEnvFallback(emptyBindings()) as unknown as Record<string, unknown>;
    expect(merged.PLUGIN_UNREGISTERED_SECRET).toBeUndefined();
  });

  it("picks up a key after registerFallbackKeys adds it", async () => {
    vi.resetModules();
    const isolated = await import("./runtime-env");
    setProcessEnv("PLUGIN_DECLARED_SECRET", "abc123");
    isolated.registerFallbackKeys("PLUGIN_DECLARED_SECRET");
    const merged = isolated.withProcessEnvFallback(emptyBindings()) as unknown as Record<
      string,
      unknown
    >;
    expect(merged.PLUGIN_DECLARED_SECRET).toBe("abc123");
  });

  it("does not leave a registered key in the shared whitelist after the test", () => {
    setProcessEnv("PLUGIN_DECLARED_SECRET", "should-not-leak");
    const merged = withProcessEnvFallback(emptyBindings()) as unknown as Record<string, unknown>;
    expect(merged.PLUGIN_DECLARED_SECRET).toBeUndefined();
  });
});
