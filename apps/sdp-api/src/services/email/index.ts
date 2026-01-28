/**
 * Email service exports
 */

export { EmailService, createEmailService } from "./service";
export { ConsoleEmailProvider } from "./providers/console";
export { ResendEmailProvider } from "./providers/resend";
export { createMagicLinkEmail } from "./templates/magic-link";
export { createInvitationEmail } from "./templates/invitation";
export type { EmailMessage, EmailProvider, EmailProviderName, SendEmailResult } from "./types";
