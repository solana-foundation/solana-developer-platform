import { describe, expect, it, vi } from "vitest";
import { AuditService } from "./audit.service";

describe("AuditService", () => {
  it("redacts credential-shaped metadata before persisting", async () => {
    const run = vi.fn(async () => undefined);
    const bind = vi.fn((..._args: unknown[]) => ({ run }));
    const db = { prepare: vi.fn(() => ({ bind })) };
    const context = {
      get: (key: string) =>
        key === "apiKey" ? { id: "ak_123", organizationId: "org_123" } : "req_123",
      req: { header: () => null },
    };

    await new AuditService(db as never).log(context as never, {
      action: "validate_failed",
      resourceType: "provider_credential",
      resourceId: "pcred_123",
      metadata: {
        provider: "privy",
        appSecret: "privy-secret",
        nested: { authorization: "Bearer raw-token" },
      },
      status: "failure",
    });

    const metadata = String(bind.mock.calls[0]?.[7]);
    expect(metadata).toContain('"provider":"privy"');
    expect(metadata).toContain('"appSecret":"[REDACTED]"');
    expect(metadata).toContain('"authorization":"[REDACTED]"');
    expect(metadata).not.toContain("privy-secret");
    expect(metadata).not.toContain("raw-token");
  });
});
