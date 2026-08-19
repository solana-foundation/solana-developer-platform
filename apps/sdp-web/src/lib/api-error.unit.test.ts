import { describe, expect, it } from "vitest";
import { parseErrorMessage, readApiErrorMessage } from "./api-error";

describe("readApiErrorMessage", () => {
  it("reads supported error envelope messages", () => {
    expect(readApiErrorMessage({ error: { message: "Invalid request" } })).toBe("Invalid request");
    expect(readApiErrorMessage({ error: "Rate limited" })).toBe("Rate limited");
    expect(readApiErrorMessage({ message: "Gateway unavailable" })).toBe("Gateway unavailable");
  });

  it("rejects malformed envelopes without inspecting nested validation details", () => {
    expect(readApiErrorMessage(null)).toBeNull();
    expect(readApiErrorMessage({ error: null })).toBeNull();
    expect(readApiErrorMessage({ error: { message: 400, details: undefined } })).toBeNull();
  });
});

describe("parseErrorMessage", () => {
  it("degrades invalid JSON and wrong-shaped JSON to a safe message", () => {
    expect(parseErrorMessage("upstream unavailable")).toBe("upstream unavailable");
    expect(parseErrorMessage("{}")).toBe("{}");
    expect(parseErrorMessage("")).toBe("Unknown error");
  });
});
