import { SDP_RELEASE_CHANNELS, type SdpModule } from "@sdp/types/release-channels";
import { SDP_GITHUB_REPO_URL } from "@sdp/types/site";

/** The docs skill `generate:ai` writes to public/SKILL.md and skills/<name>/SKILL.md. */
export const DOCS_SKILL_NAME = "sdp-docs";

export type ModuleSkill = {
  /** Its directory under the repo's skills/. */
  name: string;
  /** The module it documents. */
  module: SdpModule;
  /** The toggle: true shows it in the Agent setup menu, false hides it. */
  listed: boolean;
};

/**
 * The module skills the Agent setup menu can install beside the docs skill. Flip `listed` to
 * show or hide one. A listed skill still waits until its module is stable, on every
 * deployment, so nothing unreleased is ever offered.
 */
export const MODULE_SKILLS: readonly ModuleSkill[] = [
  // Hidden until Issuance ships: the skill still points at repo files, not the public docs.
  { name: "sdp-tokenization", module: "issuance", listed: false },
];

const RELEASED_MODULES: ReadonlySet<SdpModule> = new Set(SDP_RELEASE_CHANNELS.stable);

/** The module skills the menu offers: listed, and their module released (stable). */
export function offeredModuleSkills(skills: readonly ModuleSkill[]): readonly ModuleSkill[] {
  return skills.filter((skill) => skill.listed && RELEASED_MODULES.has(skill.module));
}

export type AgentSetupOption = {
  id: string;
  label: string;
  command: string;
};

/** Never empty: the skills CLI tabs are always there. */
export type AgentSetupOptions = readonly [AgentSetupOption, ...AgentSetupOption[]];

// The "owner/repo" source `npx skills add` takes.
const repository = new URL(SDP_GITHUB_REPO_URL).pathname.slice(1);

// The toggle for the read-only docs MCP's tab: its install command once it ships (PRO-2299).
// Null hides the tab.
const DOCS_MCP_COMMAND: string | null = null;

/**
 * One copyable install command per coding agent, then the agent-neutral one, which asks
 * which agents to install for.
 */
export function getAgentSetupOptions(): AgentSetupOptions {
  const skills = [
    DOCS_SKILL_NAME,
    ...offeredModuleSkills(MODULE_SKILLS).map((skill) => skill.name),
  ];
  const add = `npx skills add ${repository} --skill ${skills.join(" ")}`;
  const mcp =
    DOCS_MCP_COMMAND === null ? [] : [{ id: "mcp", label: "MCP", command: DOCS_MCP_COMMAND }];
  return [
    { id: "claude-code", label: "Claude Code", command: `${add} --agent claude-code` },
    { id: "codex", label: "Codex", command: `${add} --agent codex` },
    { id: "cursor", label: "Cursor", command: `${add} --agent cursor` },
    { id: "skills", label: "Skills", command: add },
    ...mcp,
  ];
}
