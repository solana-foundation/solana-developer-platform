import type { SdpModule } from "@sdp/types/release-channels";
import { SDP_GITHUB_REPO_URL } from "@sdp/types/site";
import { isModulePublished, publicSurface } from "@/lib/release-channel";

/** The docs skill `generate:ai` writes to public/SKILL.md and skills/<name>/SKILL.md. */
export const DOCS_SKILL_NAME = "sdp-docs";

/**
 * The skills under the repo's skills/ that the Agent setup menu installs. A skill about one
 * module is gated like a page about it, so no deployment offers a skill for a module it
 * does not run.
 */
const PUBLIC_SKILLS: readonly { name: string; module?: SdpModule }[] = [
  { name: DOCS_SKILL_NAME },
  { name: "sdp-tokenization", module: "issuance" },
];

export type AgentSetupOption = {
  id: string;
  label: string;
  command: string;
};

// The "owner/repo" source `npx skills add` takes.
const repository = new URL(SDP_GITHUB_REPO_URL).pathname.slice(1);

// The read-only docs MCP's install command, once it ships (PRO-2299). Until then the MCP tab
// has no command and stays hidden.
const DOCS_MCP_COMMAND: string | null = null;

/**
 * One copyable install command per coding agent, then the agent-neutral one, which asks
 * which agents to install for. Server-only: the menu receives the commands, not the gate.
 */
export function getAgentSetupOptions(surface = publicSurface): AgentSetupOption[] {
  const skills = PUBLIC_SKILLS.filter((skill) => isModulePublished(skill.module, surface));
  const add = `npx skills add ${repository} --skill ${skills.map((skill) => skill.name).join(" ")}`;
  const options = [
    { id: "claude-code", label: "Claude Code", command: `${add} --agent claude-code` },
    { id: "codex", label: "Codex", command: `${add} --agent codex` },
    { id: "cursor", label: "Cursor", command: `${add} --agent cursor` },
    { id: "skills", label: "Skills", command: add },
    { id: "mcp", label: "MCP", command: DOCS_MCP_COMMAND },
  ];
  return options.filter((option): option is AgentSetupOption => option.command !== null);
}
