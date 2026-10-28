import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { SDP_RELEASE_CHANNELS } from "@sdp/types/release-channels";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { DOCS_SKILL_NAME, getAgentSetupOptions } from "@/lib/agent-setup";
import { isModulePublished, publicSurface } from "@/lib/release-channel";

describe("Agent setup commands", () => {
  const options = getAgentSetupOptions();

  it("offer the tokenization skill exactly where issuance is published", () => {
    for (const option of options) {
      assert.match(option.command, / --skill sdp-docs(?: |$)/);
      assert.equal(option.command.includes("sdp-tokenization"), isModulePublished("issuance"));
    }
  });

  // CI generates the experimental surface, so this swaps in the stable channel's modules.
  it("follow the stable channel's modules on a stable build", (t) => {
    t.mock.property(publicSurface, "modules", SDP_RELEASE_CHANNELS.stable);
    for (const option of getAgentSetupOptions()) {
      assert.equal(
        option.command.includes("sdp-tokenization"),
        SDP_RELEASE_CHANNELS.stable.includes("issuance")
      );
    }
  });

  it("name each agent the skills CLI installs for", () => {
    const agents = options.map((option) => option.command.match(/--agent (\S+)$/)?.[1]);
    assert.deepEqual(agents, ["claude-code", "codex", "cursor", undefined]);
  });

  it("hide the MCP tab until the docs MCP has a command", () => {
    assert.ok(!options.some((option) => option.id === "mcp"));
  });
});

const skillFrontmatterSchema = z.object({
  name: z.literal(DOCS_SKILL_NAME),
  description: z.string().min(1).max(1024),
});

describe("Docs skill", () => {
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  const served = readFileSync(path.join(repoRoot, "apps/sdp-docs/public/SKILL.md"), "utf8");
  const installed = readFileSync(
    path.join(repoRoot, "skills", DOCS_SKILL_NAME, "SKILL.md"),
    "utf8"
  );

  it("is the same file at /SKILL.md and in the repo's skills/", () => {
    assert.equal(served, installed);
  });

  it("has the frontmatter `npx skills add --skill` matches", () => {
    const frontmatter = installed.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
    assert.ok(frontmatter, "SKILL.md opens with a frontmatter block");
    skillFrontmatterSchema.parse(parseYaml(frontmatter));
  });
});
