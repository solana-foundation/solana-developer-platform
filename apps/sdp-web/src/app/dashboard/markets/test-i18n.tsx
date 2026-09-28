import type { ReactNode } from "react";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";

/**
 * The one provider every markets test mounts around the component under
 * test: the production messages, in locale "en". A test that asserts copy
 * asserts what the app actually ships, so that pair is spelled once here
 * rather than once per render call in every test file.
 */
export function EnglishTestI18n({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}
