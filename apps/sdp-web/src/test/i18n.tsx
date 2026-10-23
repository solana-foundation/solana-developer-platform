import type { ReactNode } from "react";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";

/** The real `I18nProvider` with the English catalog; pass as `render`'s `wrapper` or wrap a tree. */
export function EnglishI18n({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}
