import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import { walletOperationExecutionRequest } from "./approved-operation-replay";

function requestContext(method: string, url: string): Context<{ Bindings: Env }> {
  // SAFETY: walletOperationExecutionRequest reads only req.method, req.url and
  // req.header from the context; the rest of the hono Context is unused here.
  return {
    req: { method, url, path: new URL(url).pathname, header: () => undefined },
  } as unknown as Context<{ Bindings: Env }>;
}

describe("walletOperationExecutionRequest", () => {
  it("captures a POST route with its body", () => {
    const request = walletOperationExecutionRequest(
      requestContext("POST", "http://api.internal/v1/issuance/tokens/tok_1/allowlist"),
      { address: "Addr1" }
    );
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/v1/issuance/tokens/tok_1/allowlist");
    expect(request.body).toEqual({ address: "Addr1" });
  });

  it("captures a DELETE route with its query string, so approval replay reaches the same route", () => {
    const request = walletOperationExecutionRequest(
      requestContext(
        "DELETE",
        "http://api.internal/v1/issuance/tokens/tok_1/allowlist/tal_1?signingCustodyWalletId=cwlt_1"
      ),
      { entryId: "tal_1" }
    );
    expect(request.method).toBe("DELETE");
    expect(request.path).toBe(
      "/v1/issuance/tokens/tok_1/allowlist/tal_1?signingCustodyWalletId=cwlt_1"
    );
  });

  it("refuses methods the replay engine cannot re-issue", () => {
    expect(() =>
      walletOperationExecutionRequest(
        requestContext("PATCH", "http://api.internal/v1/issuance/tokens/tok_1"),
        {}
      )
    ).toThrow();
  });
});
