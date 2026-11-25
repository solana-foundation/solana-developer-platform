import { vi } from "vitest";
import * as i18nServer from "@/i18n/server";

/**
 * Spies on the server `getTranslations` so every message reads as its own key, letting a test
 * assert which message a server action or page chose. Call it in `beforeEach`.
 */
export function translateServerMessagesToKeys(): void {
  vi.spyOn(i18nServer, "getTranslations").mockResolvedValue((key) => key);
}
