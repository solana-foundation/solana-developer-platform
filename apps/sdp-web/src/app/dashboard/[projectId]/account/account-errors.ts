import { isClerkAPIResponseError, isReverificationCancelledError } from "@clerk/nextjs/errors";
import { toast } from "sonner";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";

const CLERK_ERROR_MESSAGE_KEYS = new Map<string, MessageKey>([
  ["form_code_incorrect", "Shared.account.errors.codeIncorrect"],
  ["verification_expired", "Shared.account.errors.codeExpired"],
  ["verification_failed", "Shared.account.errors.tooManyAttempts"],
  ["verification_code_too_many_requests", "Shared.account.errors.tooManyAttempts"],
  ["form_identifier_exists", "Shared.account.errors.emailTaken"],
  ["email_address_exists", "Shared.account.errors.emailTaken"],
  ["form_param_format_invalid", "Shared.account.errors.emailInvalid"],
  ["form_password_incorrect", "Shared.account.errors.currentPasswordIncorrect"],
  ["form_password_pwned", "Shared.account.errors.passwordPwned"],
  ["form_password_not_strong_enough", "Shared.account.errors.passwordWeak"],
  ["form_password_length_too_short", "Shared.account.errors.passwordWeak"],
  ["form_password_size_in_bytes_exceeded", "Shared.account.errors.passwordTooLong"],
]);

/**
 * The message for a failed Clerk call, by Clerk's error code. Null when the person closed the
 * reverification prompt: nothing failed, so nothing is said.
 */
function accountErrorMessageKey(error: unknown): MessageKey | null {
  if (isReverificationCancelledError(error)) {
    return null;
  }
  const code = isClerkAPIResponseError(error) ? error.errors[0]?.code : undefined;
  return (
    (code === undefined ? undefined : CLERK_ERROR_MESSAGE_KEYS.get(code)) ??
    "Shared.account.errors.generic"
  );
}

export function useReportAccountError() {
  const t = useTranslations();
  return (error: unknown) => {
    const key = accountErrorMessageKey(error);
    if (key !== null) {
      toast.error(t(key));
    }
  };
}
