import { describe, expect, it } from "vitest";
import { PRIVATE_CHANNEL_NAME_MAX_LENGTH, validatePrivateChannelName } from "./channels";

describe("validatePrivateChannelName", () => {
  it("accepts a normal name", () => {
    expect(validatePrivateChannelName("Treasury")).toBeNull();
  });

  it("rejects empty / whitespace-only", () => {
    expect(validatePrivateChannelName("")).toMatch(/required/i);
    expect(validatePrivateChannelName("   ")).toMatch(/required/i);
  });

  it("rejects names over the max length", () => {
    expect(validatePrivateChannelName("a".repeat(PRIVATE_CHANNEL_NAME_MAX_LENGTH + 1))).toMatch(
      /at most/i
    );
  });
});
