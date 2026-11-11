import { getDb } from "@/db/client";
import { forbidden, internalError } from "@/lib/errors";
import { success } from "@/lib/response";
import { requireHumanActor } from "@/middleware/human-session";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { sendFeedbackEmail } from "@/services/feedback-email";
import type { sendFeedbackSchema } from "./schemas";

interface SenderContext {
  organization_name: string;
  sender_email: string | null;
  sender_name: string | null;
}

/**
 * Emails the feedback to the SDP alias, replying to the sender. Nothing is stored: the email is
 * the record, so it audits nothing.
 */
export const sendFeedback = async (c: ValidatedBodyContext<typeof sendFeedbackSchema>) => {
  const { orgId } = c.req.param();
  const actor = requireHumanActor(c);
  if (actor.organizationId !== orgId) throw forbidden("Access denied to this organization");
  const body = c.req.valid("json");

  const context = await getDb(c.env).queryOne<SenderContext>(
    `SELECT o.name AS organization_name, u.email AS sender_email, u.name AS sender_name
     FROM organizations o
     LEFT JOIN users u ON u.id = ?
     WHERE o.id = ?`,
    [actor.userId, orgId]
  );
  if (!context) throw internalError("Organization not found for feedback");

  await sendFeedbackEmail(c.env, {
    organizationId: orgId,
    organizationName: context.organization_name,
    sender: { userId: actor.userId, email: context.sender_email, name: context.sender_name },
    category: body.category,
    message: body.message,
    pageUrl: body.pageUrl,
    attachmentCount: body.attachmentCount ?? 0,
    sentryEventId: body.sentryEventId,
  });
  return success(c, { sent: true }, 201);
};
