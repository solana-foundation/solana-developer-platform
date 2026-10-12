import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  docsReleaseChannel,
  isPageSourceInChannel,
  resolveInChannelBlocks,
} from "../src/lib/release-channel";

const ISSUANCE_PAGE = "---\nmodule: issuance\ntitle: Mint and Burn\n---\n\nBody\n";
const SHARED_PAGE = [
  "Transfers<InChannel module=\"ramps\"> and ramps</InChannel>.",
  "",
  '<InChannel module="issuance">',
  "",
  "- [Mint and Burn](/docs/tokens/mint-and-burn)",
  "",
  "</InChannel>",
  "After",
].join("\n");

describe("docs release channel", () => {
  it("documents every module when unset outside Vercel, and requires it on Vercel", () => {
    assert.equal(docsReleaseChannel({}), "experimental");
    assert.equal(docsReleaseChannel({ SDP_RELEASE_CHANNEL: "stable" }), "stable");
    assert.throws(() => docsReleaseChannel({ VERCEL: "1" }), /SDP_RELEASE_CHANNEL is required/);
  });

  it("publishes a module page only on a channel that runs the module", () => {
    assert.equal(isPageSourceInChannel(ISSUANCE_PAGE, "experimental", "page"), true);
    assert.equal(isPageSourceInChannel(ISSUANCE_PAGE, "stable", "page"), false);
    assert.equal(isPageSourceInChannel("---\ntitle: Shared\n---\n", "stable", "page"), true);
  });

  it("rejects an unknown module tag", () => {
    assert.throws(
      () => isPageSourceInChannel("---\nmodule: issuence\n---\n", "stable", "page"),
      /module must be one of/
    );
  });

  it("removes out-of-channel blocks, keeping line numbers, and unwraps the rest", () => {
    const stable = resolveInChannelBlocks(SHARED_PAGE, "stable", "page");
    assert.doesNotMatch(stable, /ramps|mint-and-burn|InChannel/);
    assert.equal(stable.split("\n").length, SHARED_PAGE.split("\n").length);
    assert.equal(stable.split("\n").at(-1), "After");

    const experimental = resolveInChannelBlocks(SHARED_PAGE, "experimental", "page");
    assert.match(experimental, /Transfers and ramps\./);
    assert.match(experimental, /mint-and-burn/);
    assert.doesNotMatch(experimental, /InChannel/);
  });
});
