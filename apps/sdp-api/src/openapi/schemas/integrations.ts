import { projectIntegrationsSchema } from "@sdp/types/integrations";
import { withOpenApi } from "./base";

export const projectIntegrationsResponseSchema = withOpenApi(projectIntegrationsSchema, {
  description:
    "The project's integrations, grouped by family in a fixed order. A family this deployment does not run, or with no provider the project can use, is omitted. Each integration's `state` is `not_configured` (the project can set it up, in the listed `modes`), `provided` (SDP supplies it and the project sets nothing up), or `connected` (the project's own setup is active; `mode` says whether it runs on the deployment's provider account, `managed`, or the project's own, `byok`).",
  example: {
    projectId: "prj_sandbox01",
    environment: "sandbox",
    families: [
      {
        family: "custody",
        integrations: [
          { provider: "privy", category: "server", state: { status: "connected", mode: "byok" } },
          {
            provider: "fireblocks",
            category: "institutional",
            state: { status: "not_configured", modes: ["managed", "byok"] },
          },
        ],
      },
    ],
  },
});
