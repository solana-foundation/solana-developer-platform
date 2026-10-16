import { isTransientRpcError } from "@sdp/rpc";
import { confirmTransaction, createRpcFromTransport } from "@sdp/rpc/solana";
import { signature } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as guardedEgress from "@/services/guarded-egress";
import { createCustomerRpcTransport } from "@/services/rpc-egress";

const payload = { jsonrpc: "2.0", id: "probe", method: "getVersion", params: [] };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createCustomerRpcTransport", () => {
  it("refuses an endpoint whose host resolves inward", async () => {
    const transport = createCustomerRpcTransport("https://localhost:8899/");

    await expect(transport({ payload })).rejects.toBeInstanceOf(guardedEgress.EgressBlockedError);
  });

  it("refuses a plaintext endpoint", async () => {
    const transport = createCustomerRpcTransport("http://rpc.example.com/");

    await expect(transport({ payload })).rejects.toBeInstanceOf(guardedEgress.EgressBlockedError);
  });

  it("posts through the guard with the redirect, size and time bounds", async () => {
    const guardedFetch = vi
      .spyOn(guardedEgress, "guardedFetch")
      .mockResolvedValue(
        jsonResponse({ jsonrpc: "2.0", id: "probe", result: { "solana-core": "0.0.0" } })
      );
    const transport = createCustomerRpcTransport("https://rpc.example.com/v2/key_synthetic");

    const response = await transport<{ result: { "solana-core": string } }>({ payload });

    expect(response.result["solana-core"]).toBe("0.0.0");
    expect(guardedFetch).toHaveBeenCalledTimes(1);
    expect(guardedFetch).toHaveBeenCalledWith("https://rpc.example.com/v2/key_synthetic", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
      signal: expect.any(AbortSignal),
      maxRedirects: 3,
      maxResponseBytes: 10 * 1024 * 1024,
      rejectOversizeResponse: true,
    });
  });

  it("bounds each request to 30 seconds", async () => {
    vi.spyOn(guardedEgress, "guardedFetch").mockResolvedValue(
      jsonResponse({ jsonrpc: "2.0", id: "probe", result: null })
    );
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const transport = createCustomerRpcTransport("https://rpc.example.com/");

    await transport({ payload });

    expect(timeout).toHaveBeenCalledWith(30_000);
  });

  it("keeps the time bound when the caller supplies a signal", async () => {
    const guardedFetch = vi
      .spyOn(guardedEgress, "guardedFetch")
      .mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: "probe", result: null }));
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    const controller = new AbortController();
    const transport = createCustomerRpcTransport("https://rpc.example.com/");

    await transport({ payload, signal: controller.signal });

    const [, init] = guardedFetch.mock.calls[0];
    expect(init.signal).not.toBe(controller.signal);
    expect(controller.signal.aborted).toBe(false);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal).toMatchObject({ aborted: true });
  });

  it("follows the caller's cancellation", async () => {
    const guardedFetch = vi
      .spyOn(guardedEgress, "guardedFetch")
      .mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: "probe", result: null }));
    const controller = new AbortController();
    const transport = createCustomerRpcTransport("https://rpc.example.com/");

    await transport({ payload, signal: controller.signal });
    const [, init] = guardedFetch.mock.calls[0];
    controller.abort();

    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal).toMatchObject({ aborted: true });
  });

  it("surfaces an oversize answer as the guard's error", async () => {
    vi.spyOn(guardedEgress, "guardedFetch").mockRejectedValue(
      new guardedEgress.EgressResponseTooLargeError("rpc.example.com")
    );
    const transport = createCustomerRpcTransport("https://rpc.example.com/");

    await expect(transport({ payload })).rejects.toBeInstanceOf(
      guardedEgress.EgressResponseTooLargeError
    );
  });

  it.each([408, 429, 500, 502, 503, 504])(
    "classifies an upstream HTTP %i as transient",
    async (status) => {
      vi.spyOn(guardedEgress, "guardedFetch").mockResolvedValue(new Response(null, { status }));
      const transport = createCustomerRpcTransport("https://rpc.example.com/");

      const outcome = transport({ payload });

      await expect(outcome).rejects.toThrow(`RPC request failed with HTTP ${status}`);
      await expect(outcome).rejects.toSatisfy(isTransientRpcError);
    }
  );

  it.each([400, 401, 403, 404])(
    "does not classify an upstream HTTP %i as transient",
    async (status) => {
      vi.spyOn(guardedEgress, "guardedFetch").mockResolvedValue(new Response(null, { status }));
      const transport = createCustomerRpcTransport("https://rpc.example.com/");

      const outcome = transport({ payload });

      await expect(outcome).rejects.toThrow(`RPC request failed with HTTP ${status}`);
      await expect(outcome).rejects.toSatisfy((error: unknown) => !isTransientRpcError(error));
    }
  );

  it("keeps polling a confirmation through upstream 429 and 503 answers", async () => {
    const guardedFetch = vi
      .spyOn(guardedEgress, "guardedFetch")
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(
        jsonResponse({
          jsonrpc: "2.0",
          id: "0",
          result: {
            context: { slot: 7 },
            value: [{ slot: 7, confirmations: null, err: null, confirmationStatus: "confirmed" }],
          },
        })
      );
    const rpc = createRpcFromTransport(createCustomerRpcTransport("https://rpc.example.com/"));

    const confirmation = await confirmTransaction(
      rpc,
      signature(
        "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"
      ),
      { timeoutMs: 5_000, pollIntervalMs: 1 }
    );

    expect(confirmation.confirmationStatus).toBe("confirmed");
    expect(guardedFetch).toHaveBeenCalledTimes(3);
  });
});
