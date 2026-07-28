import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { AlphaLedgerService } from "./service";

describe("AlphaLedgerService.request", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("POSTs JSON with bearer auth to the environment base and parses the response", async () => {
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async () => new Response(JSON.stringify({ id: "ALFNDPF000140932" }), { status: 200 })
    );

    const service = new AlphaLedgerService("test-key", "sandbox");
    const result = await service.request<{ id: string }>("POST", "/api/v1/financial-instruments", {
      code: "sdp-test",
    });

    assert.deepEqual(result, { id: "ALFNDPF000140932" });
    const [url, init] = fetchMock.mock.calls[0].arguments;
    assert.equal(
      url,
      "https://vf-solana-api.qa.alphaledger.com/api/v1/financial-instruments?svmCluster=SOLANA_DEVNET"
    );
    assert.equal(init?.method, "POST");
    assert.deepEqual(init?.headers, {
      authorization: "Bearer test-key",
      "content-type": "application/json",
    });
    assert.equal(init?.body, JSON.stringify({ code: "sdp-test" }));
  });

  it("throws with method, path, status, and body on a non-2xx response", async () => {
    mock.method(
      globalThis,
      "fetch",
      async () => new Response("UNIQUE_INSERT_VIOLATION", { status: 409 })
    );

    const service = new AlphaLedgerService("test-key", "production");
    await assert.rejects(
      service.request("PATCH", "/api/v1/accounts", {}),
      /AlphaLedger PATCH \/api\/v1\/accounts failed \(409\): UNIQUE_INSERT_VIOLATION/
    );
  });
});
