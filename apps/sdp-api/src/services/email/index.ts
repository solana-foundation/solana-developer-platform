/**
 * Email service exports
 */

export { ConsoleEmailProvider } from "./providers/console";
export { ResendEmailProvider } from "./providers/resend";
export { createEmailService, EmailService } from "./service";
export { renderInvitationEmail } from "./templates/invitation";
export type {
  EmailMessage,
  EmailProvider,
  EmailProviderName,
  SendEmailResult,
} from "./types";
