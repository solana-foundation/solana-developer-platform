import { createHash } from "node:crypto";
import { SDP_TERMS, type SdpTermsBlock, sdpTermsRuns } from "@sdp/types/mainnet-access";
import { SDP_TERMS_MARKDOWN } from "@sdp/types/sdp-terms-text";
import { describe, expect, it } from "vitest";

/**
 * Every version of the SDP Terms and Conditions ever accepted, by the hash of its text. An
 * acceptance records only the version, so a version names one text forever: an edit to the text
 * is a new version with a new entry here, never a new hash for an old one.
 */
const TERMS_TEXT_BY_VERSION = {
  "2026-10-placeholder": "8451f2301632842f33337452d6be2c6041e492c48c031b8b831b227f1e005574",
  "2026-11-03": "f35a5d370dc6b4466844a0b237d8f91ccec0cd86c1f7988330bffa559588c17a",
} as const satisfies Record<string, string>;

function textHash(): string {
  const { version: _version, ...text } = SDP_TERMS;
  return createHash("sha256").update(JSON.stringify(text)).digest("hex");
}

describe("SDP Terms and Conditions", () => {
  it("pins the current version to its text", () => {
    expect({ version: SDP_TERMS.version, hash: textHash() }).toEqual({
      version: SDP_TERMS.version,
      hash: new Map<string, string>(Object.entries(TERMS_TEXT_BY_VERSION)).get(SDP_TERMS.version),
    });
  });

  it("reads every line of the source text into a section", () => {
    const lines = (block: SdpTermsBlock) =>
      block.kind === "list"
        ? block.items
        : [block.kind === "subheading" ? `### ${block.text}` : block.text];
    const rebuilt = SDP_TERMS.sections.flatMap((section) => [
      `## ${section.heading}`,
      ...section.blocks.flatMap(lines),
    ]);
    const source = SDP_TERMS_MARKDOWN.split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => (line.startsWith("- ") ? line.slice(2) : line));
    expect(rebuilt).toEqual(source);
  });

  it("closes every bold run it opens", () => {
    const texts = SDP_TERMS.sections.flatMap((section) =>
      section.blocks.flatMap((block) => (block.kind === "list" ? block.items : [block.text]))
    );
    for (const text of texts) expect(text.split("**").length % 2, text).toBe(1);
    expect(sdpTermsRuns("a **b** c")).toEqual([
      { text: "a ", bold: false },
      { text: "b", bold: true },
      { text: " c", bold: false },
    ]);
  });
});
