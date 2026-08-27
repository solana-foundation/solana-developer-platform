import { describe, expect, it } from "vitest";
import { RingsAdapterError, redactAdapterMessage } from "./adapter-error";

/**
 * Adapter messages are quoted verbatim from the signer and the RPC, stored as
 * `failure_message`, and served back on every read of the operation. An RPC
 * that cannot reach a host names the URL it tried, and that URL carries the
 * Helius API key.
 */
describe("redactAdapterMessage", () => {
  it("strips the query from a URL an RPC error quotes", () => {
    const message = redactAdapterMessage(
      "fetch failed for https://devnet.helius-rpc.com/?api-key=super-secret-key"
    );

    expect(message).not.toContain("super-secret-key");
    // The host and path survive, because knowing which upstream failed is the
    // whole diagnostic value of the message.
    expect(message).toContain("https://devnet.helius-rpc.com/");
  });

  it("strips a bare credential parameter outside a URL", () => {
    expect(redactAdapterMessage("request rejected (api-key=abc123)")).not.toContain("abc123");
    expect(redactAdapterMessage("access_token=xyz789 expired")).not.toContain("xyz789");
  });

  it("leaves an ordinary message alone", () => {
    // Over-redacting costs the operator the reason, so the rules are scoped to
    // URLs and named credential parameters rather than anything key-shaped.
    const message = "blockhash not found";
    expect(redactAdapterMessage(message)).toBe(message);
  });

  it("scrubs at construction, so no call site can forget", () => {
    const error = new RingsAdapterError(
      "submit_failed",
      "send failed: https://devnet.helius-rpc.com/?api-key=super-secret-key",
      { retryable: true }
    );

    expect(error.message).not.toContain("super-secret-key");
  });
});
