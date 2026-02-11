/**
 * Email service exports
 */

export { EmailService, createEmailService } from "./service";
export { ConsoleEmailProvider } from "./providers/console";
export { ResendEmailProvider } from "./providers/resend";
export { renderInvitationEmail } from "./templates/invitation";
export type {
  EmailMessage,
  EmailProvider,
  EmailProviderName,
  SendEmailResult,
} from "./types";
