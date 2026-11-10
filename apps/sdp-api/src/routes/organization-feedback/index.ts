import { Hono } from "hono";
import { requireHumanSession } from "@/middleware/human-session";
import { meteredQuota } from "@/middleware/metered-quota";
import { requireAction } from "@/middleware/require-action";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { sendFeedback } from "./handlers";
import { sendFeedbackSchema } from "./schemas";

// Mounted under /organizations/:orgId/feedback; the parent router applies auth.
// Feedback is the dashboard's Send feedback screen (PRO-2421): it sends an email, so it is an
// `execute` that admins and members hold and viewers do not, and API keys can never hold it.
export const organizationFeedback = new Hono<{ Bindings: Env }>();

// Each send is one email to the SDP alias through Iterable.
const sendQuota = meteredQuota({ name: "feedback", actorMax: 10, orgMax: 30 });

organizationFeedback.post(
  "/",
  requireHumanSession(),
  requireAction("feedback.execute"),
  sendQuota,
  validateBody(sendFeedbackSchema),
  sendFeedback
);
