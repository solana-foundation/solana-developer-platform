import { z } from "zod";

export const FEEDBACK_CATEGORIES = ["problem", "idea", "question"] as const;
export const FEEDBACK_MESSAGE_MAX_LENGTH = 5000;
/** The dashboard takes up to five files; they go to Sentry, and the email only counts them. */
export const FEEDBACK_ATTACHMENTS_MAX = 5;

/**
 * Feedback from the dashboard's Send feedback screen (PRO-2421): what it is about, what the
 * person would change, the page they sent it from, and the Sentry feedback event that holds their
 * attachments and session replay, when the deployment runs Sentry.
 */
export const sendFeedbackSchema = z.strictObject({
  category: z.enum(FEEDBACK_CATEGORIES).optional(),
  message: z.string().trim().min(1).max(FEEDBACK_MESSAGE_MAX_LENGTH),
  pageUrl: z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .optional(),
  attachmentCount: z.number().int().min(0).max(FEEDBACK_ATTACHMENTS_MAX).optional(),
  sentryEventId: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .optional(),
});
