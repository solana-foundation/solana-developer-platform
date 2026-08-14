import { type ContextVariableMap, Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PolicyGateExtraction } from "@/middleware/policy-gate";
import type { Env } from "@/types/env";

const resolvePolicyCustodyWalletMock = vi.hoisted(() => vi.fn());

vi.mock("@/services/policy/enforcement.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/policy/enforcement.service")>()),
  resolvePolicyCustodyWallet: resolvePolicyCustodyWalletMock,
}));

import { signerCheckSchema } from "../schemas";
import { extractSignerCheckPolicyCandidate } from "./signer-check";

const SERVER_MEMO_PREFIX = "SDP signer check ";

const apiKey = {
  id: "key_signer_check",
  organizationId: "org_signer_check",
  projectId: "prj_signer_check",
  role: "admin",
  permissions: ["wallets:write"],
  environment: "sandbox",
  signingWalletId: "wal_signer_check",
  signingWalletIds: ["wal_signer_check"],
  walletBindings: [{ walletId: "wal_signer_check", permissions: ["wallets:write"] }],
} satisfies NonNullable<ContextVariableMap["apiKey"]>;

async function extractForBody(body: Record<string, unknown>): Promise<PolicyGateExtraction> {
  let extraction: PolicyGateExtraction | undefined;
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    c.set("apiKey", apiKey);
    await next();
  });
  app.post("/signer-check", async (c) => {
    extraction = await extractSignerCheckPolicyCandidate(c);
    return c.body(null, 204);
  });
  app.onError((error) => {
    throw error;
  });

  const response = await app.request("/signer-check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(204);
  if (!extraction) {
    throw new Error("Signer check extraction did not run");
  }
  return extraction;
}

describe("signer check memo generation", () => {
  beforeEach(() => {
    resolvePolicyCustodyWalletMock.mockReset();
    resolvePolicyCustodyWalletMock.mockResolvedValue(null);
  });

  it("strips a caller-supplied memo at the schema boundary", () => {
    const parsed = signerCheckSchema.parse({
      walletId: "wal_signer_check",
      memo: "caller controlled text",
    });
    expect(parsed).not.toHaveProperty("memo");
  });

  it("ignores caller memo text and signs a server-generated memo", async () => {
    const extraction = await extractForBody({
      walletId: "wal_signer_check",
      memo: "caller controlled text",
    });

    const resolved = extraction.resolved as { memo: string };
    expect(resolved.memo.startsWith(SERVER_MEMO_PREFIX)).toBe(true);
    expect(resolved.memo).not.toContain("caller controlled text");
    expect(extraction.candidate?.context).toMatchObject({ memo: resolved.memo });
    expect(extraction.rawPayload).toMatchObject({ memo: resolved.memo });
  });

  it("generates a fresh memo nonce per request", async () => {
    const first = await extractForBody({ walletId: "wal_signer_check" });
    const second = await extractForBody({ walletId: "wal_signer_check" });

    const firstMemo = (first.resolved as { memo: string }).memo;
    const secondMemo = (second.resolved as { memo: string }).memo;
    expect(firstMemo).not.toBe(secondMemo);
  });
});
