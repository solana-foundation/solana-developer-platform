import { Hono } from "hono";
import { requireHumanSession } from "@/middleware/human-session";
import { meteredQuota } from "@/middleware/metered-quota";
import { requireAction } from "@/middleware/require-action";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { sendFeedback } from "./handlers";
import { sendFeedbackSchema } from "./schemas";

// Mounted under /organizations/:orgId/feedback; the parent router applies auth.
// Feedback is the dashboard's Send feedback screen (PRO-2421): a signed-in person in any role,
// never an API key, so it takes the read every role holds.
export const organizationFeedback = new Hono<{ Bindings: Env }>();

// Each send is one email to the SDP alias through Iterable.
const sendQuota = meteredQuota({ name: "feedback", actorMax: 10, orgMax: 30 });

organizationFeedback.post(
  "/",
  requireAction("organizations.read"),
  requireHumanSession(),
  sendQuota,
  validateBody(sendFeedbackSchema),
  sendFeedback
);
