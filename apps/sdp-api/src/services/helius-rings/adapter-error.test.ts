import { describe, expect, it } from "vitest";
import { RingsAdapterError, redactAdapterMessage } from "./adapter-error";

describe("redactAdapterMessage", () => {
  it("passes through a plain message when no sensitive inputs are declared", () => {
    expect(redactAdapterMessage("nothing to hide")).toBe("nothing to hide");
  });

  it("keeps origin and path shape of a sensitive URL while censoring the path segment", () => {
    const output = redactAdapterMessage(
      "sendTransaction failed: https://rpc.example/abc-123-key",
      [],
      ["https://rpc.example/abc-123-key"]
    );

    expect(output).toContain("https://rpc.example/");
    expect(output).not.toContain("abc-123-key");
  });

  it("censors query-string credentials on any URL, whether declared or not", () => {
    const output = redactAdapterMessage("failed at https://rpc.example/path?api-key=secret");

    expect(output).toContain("https://rpc.example/path?");
    expect(output).not.toContain("secret");
  });

  it("censors bare api-key/access-token/token parameters outside a URL", () => {
    const output = redactAdapterMessage("upstream returned api-key=abc access_token=def token=ghi");

    expect(output).not.toContain("abc");
    expect(output).not.toContain("def");
    expect(output).not.toContain("ghi");
  });

  it("censors sensitive raw values and their URL-encoded form", () => {
    const secret = "raw secret";
    const output = redactAdapterMessage(`raw=${secret} encoded=${encodeURIComponent(secret)}`, [
      secret,
    ]);

    expect(output).not.toContain(secret);
    expect(output).not.toContain(encodeURIComponent(secret));
  });

  it("falls back to a plain replace when the sensitive URL cannot be parsed", () => {
    const output = redactAdapterMessage(
      "boom :// not-a-url stuck in message",
      [],
      [":// not-a-url"]
    );

    expect(output).not.toContain(":// not-a-url");
  });
});

describe("RingsAdapterError", () => {
  it("scrubs the message through redactAdapterMessage before storing it", () => {
    const error = new RingsAdapterError(
      "submit_failed",
      "call to https://rpc.example/leaked-key failed",
      {
        retryable: true,
        sensitiveUrls: ["https://rpc.example/leaked-key"],
      }
    );

    expect(error.message).not.toContain("leaked-key");
    expect(error.failureCode).toBe("submit_failed");
    expect(error.retryable).toBe(true);
    expect(error.name).toBe("RingsAdapterError");
  });
});
