import type { ReactNode } from "react";
import { UiI18nProvider, type UiMessageKey, type UiTranslate } from "../i18n";

// sdp-web's English catalog values for the keys the primitives read (messages/en/shared.json,
// Shared.SharedComponents), so the suites assert the strings the dashboard renders.
const ENGLISH: Record<UiMessageKey, string> = {
  "Shared.SharedComponents.chooseDate": "Choose date",
  "Shared.SharedComponents.chooseDateAndTime": "Choose date and time",
  "Shared.SharedComponents.chooseDateRange": "Choose date range",
  "Shared.SharedComponents.chooseEndDate": "Choose end date",
  "Shared.SharedComponents.clear": "Clear",
  "Shared.SharedComponents.closeModal": "Close modal",
  "Shared.SharedComponents.done": "Done",
  "Shared.SharedComponents.loading": "Loading…",
  "Shared.SharedComponents.nextPage": "Next page",
  "Shared.SharedComponents.noOptionsAvailable": "No options available.",
  "Shared.SharedComponents.noSearchMatches": "No matches for your search.",
  "Shared.SharedComponents.openCalendarFor": "Open the calendar for {field}",
  "Shared.SharedComponents.pageOf": "Page {page} of {pageCount}",
  "Shared.SharedComponents.previousPage": "Previous page",
  "Shared.SharedComponents.required": "(required)",
  "Shared.SharedComponents.rowsCount": "{count} rows",
  "Shared.SharedComponents.rowsPerPage": "Rows per page",
  "Shared.SharedComponents.search": "Search…",
  "Shared.SharedComponents.selectAnOption": "Select an option",
  "Shared.SharedComponents.time": "Time",
};

const translate: UiTranslate = (key, values) =>
  ENGLISH[key].replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name]));

/** The English labels sdp-web wires in, for suites that render the primitives on their own. */
export function EnglishUiI18nProvider({ children }: { children: ReactNode }) {
  return (
    <UiI18nProvider locale="en" translate={translate}>
      {children}
    </UiI18nProvider>
  );
}
