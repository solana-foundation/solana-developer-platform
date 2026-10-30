import { createHash } from "node:crypto";
import { SDP_TERMS } from "@sdp/types/mainnet-access";
import { describe, expect, it } from "vitest";

/**
 * Every version of the SDP Terms and Conditions ever accepted, by the hash of its text. An
 * acceptance records only the version, so a version names one text forever: an edit to the text
 * is a new version with a new entry here, never a new hash for an old one.
 */
const TERMS_TEXT_BY_VERSION: Record<string, string> = {
  "2026-10-placeholder": "8451f2301632842f33337452d6be2c6041e492c48c031b8b831b227f1e005574",
};

function textHash(): string {
  const { version: _version, ...text } = SDP_TERMS;
  return createHash("sha256").update(JSON.stringify(text)).digest("hex");
}

describe("SDP Terms and Conditions", () => {
  it("pins the current version to its text", () => {
    expect({ version: SDP_TERMS.version, hash: textHash() }).toEqual({
      version: SDP_TERMS.version,
      hash: TERMS_TEXT_BY_VERSION[SDP_TERMS.version],
    });
  });
});
