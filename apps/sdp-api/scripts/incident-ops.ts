// Fixed entrypoint for the sdp-<env>-incident-ops Cloud Run job (dispatched by the
// .github/workflows/incident-*.yml workflows). The job's command is pinned to
// `node incident-ops.js`, so an execution can only choose among the tools and
// actions allowlisted here — never an arbitrary command.
const TOOL_ACTIONS = {
  "sponsorship-budget": {
    script: "sponsorship-budget",
    actions: new Set(["status", "kill", "resume", "set"]),
  },
  "movement-control": {
    script: "project-movement-control",
    actions: new Set(["status", "disable", "enable"]),
  },
} as const satisfies Record<string, { script: string; actions: ReadonlySet<string> }>;

function isTool(value: string): value is keyof typeof TOOL_ACTIONS {
  return value in TOOL_ACTIONS;
}

async function main(): Promise<void> {
  const tool = process.argv[2];
  const action = process.argv[3];
  const entry = tool !== undefined && isTool(tool) ? TOOL_ACTIONS[tool] : undefined;
  if (!entry || action === undefined || !entry.actions.has(action)) {
    console.error(
      "Usage: incident-ops <sponsorship-budget|movement-control> <action> [flags]\n" +
        "  sponsorship-budget: status | kill | resume | set\n" +
        "  movement-control:   status | disable | enable"
    );
    process.exitCode = 1;
    return;
  }
  // The underlying script reads its action at argv[2] and flags after it.
  process.argv.splice(2, 1);
  if (entry.script === "sponsorship-budget") {
    await import("./sponsorship-budget");
  } else {
    await import("./project-movement-control");
  }
}

void main();
