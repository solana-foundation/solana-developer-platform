import { z } from "zod";

// Fixed entrypoint for the sdp-<env>-incident-ops Cloud Run job (dispatched by the
// .github/workflows/incident-*.yml workflows). The job's command is pinned to
// `node incident-ops.js`, so an execution can only choose among the tools and
// actions allowlisted here — never an arbitrary command.
const toolSchema = z.enum(["sponsorship-budget", "movement-control", "organization-control"]);
type ToolName = z.infer<typeof toolSchema>;

// `satisfies Record<ToolName, …>` binds this table to the schema in both
// directions: a tool missing here or absent from the enum fails the build.
const TOOL_ACTIONS = {
  "sponsorship-budget": {
    script: "sponsorship-budget",
    action: z.enum(["status", "kill", "resume", "set"]),
  },
  "movement-control": {
    script: "project-movement-control",
    action: z.enum(["status", "disable", "enable"]),
  },
  "organization-control": {
    script: "organization-control",
    action: z.enum(["status", "suspend", "resume"]),
  },
} as const satisfies Record<ToolName, { script: string; action: z.ZodType<string> }>;

async function main(): Promise<void> {
  const tool = toolSchema.safeParse(process.argv[2]);
  const entry = tool.success ? TOOL_ACTIONS[tool.data] : undefined;
  const action = entry?.action.safeParse(process.argv[3]);
  if (!entry || !action?.success) {
    console.error(
      "Usage: incident-ops <sponsorship-budget|movement-control|organization-control> <action> [flags]\n" +
        "  sponsorship-budget: status | kill | resume | set\n" +
        "  movement-control:   status | disable | enable\n" +
        "  organization-control: status | suspend | resume"
    );
    process.exitCode = 1;
    return;
  }
  // The underlying script reads its action at argv[2] and flags after it.
  process.argv.splice(2, 1);
  const script = entry.script;
  switch (script) {
    case "sponsorship-budget":
      await import("./sponsorship-budget");
      break;
    case "project-movement-control":
      await import("./project-movement-control");
      break;
    case "organization-control":
      await import("./organization-control");
      break;
    default: {
      const unreachable: never = script;
      throw new Error(`Unsupported incident script: ${unreachable}`);
    }
  }
}

void main();
