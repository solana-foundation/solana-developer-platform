import assert from "node:assert/strict";
import test from "node:test";
import { escapeMarkdownTableCell } from "../apps/sdp-docs/scripts/lib/markdown-escaping.mjs";

test("escapes backslashes before markdown table delimiters", () => {
  assert.equal(escapeMarkdownTableCell("allow \\| deny | audit"), "allow \\\\\\| deny \\| audit");
});

test("keeps generated table content on one row", () => {
  assert.equal(escapeMarkdownTableCell("first\r\nsecond\nthird"), "first second third");
});
