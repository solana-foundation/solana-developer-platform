import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { SDP_MODULES, SDP_RELEASE_CHANNELS } from "@sdp/types/release-channels";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  DOCS_SKILL_NAME,
  getAgentSetupOptions,
  MODULE_SKILLS,
  offeredModuleSkills,
} from "@/lib/agent-setup";
import { publicSurface } from "@/lib/release-channel";

describe("Agent setup commands", () => {
  const options = getAgentSetupOptions();
  const released = SDP_RELEASE_CHANNELS.stable[0];
  const unreleased = SDP_MODULES.find((module) => !SDP_RELEASE_CHANNELS.stable.includes(module));
  assert.ok(released && unreleased, "the stable channel holds some modules and not others");

  it("install the docs skill and the offered module skills, on every deployment", () => {
    const skills = [DOCS_SKILL_NAME, ...offeredModuleSkills(MODULE_SKILLS).map((s) => s.name)];
    for (const option of options) {
      assert.match(option.command, new RegExp(` --skill ${skills.join(" ")}(?: --agent \\S+)?$`));
    }
  });

  it("offer a module skill only while it is listed and its module is stable", () => {
    const offered = offeredModuleSkills([
      { name: "listed-released", module: released, listed: true },
      { name: "listed-unreleased", module: unreleased, listed: true },
      { name: "unlisted-released", module: released, listed: false },
    ]).map((skill) => skill.name);
    assert.deepEqual(offered, ["listed-released"]);
  });

  // The committed surface publishes the released module, so this swaps in a deployment that doesn't.
  it("hide a released module's skill where the deployment doesn't publish the module", (t) => {
    t.mock.property(
      publicSurface,
      "modules",
      publicSurface.modules.filter((module) => module !== released)
    );
    const skill = { name: "listed-released", module: released, listed: true };
    assert.deepEqual(offeredModuleSkills([skill]), []);
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
