import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { DOCS_SKILL_NAME, getAgentSetupOptions } from "@/lib/agent-setup";
import type { PublicSurface } from "@/lib/release-channel";

const SURFACE: Omit<PublicSurface, "releaseChannel" | "modules"> = {
  rampProviders: [],
  grantableActions: [],
  allModules: ["custody", "payments", "issuance"],
  allRampProviders: [],
};

const STABLE: PublicSurface = { ...SURFACE, releaseChannel: "stable", modules: ["payments"] };
const EXPERIMENTAL: PublicSurface = {
  ...SURFACE,
  releaseChannel: "experimental",
  modules: ["payments", "issuance"],
};

describe("Agent setup commands", () => {
  it("install only the docs skill where issuance is unpublished", () => {
    for (const option of getAgentSetupOptions(STABLE)) {
      assert.match(option.command, / --skill sdp-docs(?: |$)/);
      assert.doesNotMatch(option.command, /sdp-tokenization/);
    }
  });

  it("add the tokenization skill where issuance is published", () => {
    for (const option of getAgentSetupOptions(EXPERIMENTAL)) {
      assert.match(option.command, / --skill sdp-docs sdp-tokenization(?: |$)/);
    }
  });

  it("name each agent the skills CLI installs for", () => {
    const agents = getAgentSetupOptions(STABLE).map(
      (option) => option.command.match(/--agent (\S+)$/)?.[1]
    );
    assert.deepEqual(agents, ["claude-code", "codex", "cursor", undefined]);
  });

  it("hide the MCP tab until the docs MCP has a command", () => {
    const ids = getAgentSetupOptions(EXPERIMENTAL).map((option) => option.id);
    assert.ok(!ids.includes("mcp"));
  });
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
    const { name, description } = parseYaml(frontmatter) as {
      name?: unknown;
      description?: unknown;
    };
    assert.equal(name, DOCS_SKILL_NAME);
    assert.equal(typeof description, "string");
    assert.ok(String(description).length <= 1024, "a skill description is at most 1024 characters");
  });
});
