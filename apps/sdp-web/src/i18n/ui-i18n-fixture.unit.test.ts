import type { UiMessageKey } from "@sdp/ui/i18n";
import { ENGLISH_UI_MESSAGES, translateEnglishUi } from "@sdp/ui/testing/english-ui-i18n";
import { describe, expect, it } from "vitest";
import { englishSourceMessages, translate } from "./messages";

// Every placeholder a primitive's label uses, so templated labels compare filled in.
const SAMPLE_VALUES = { count: 3, field: "Start date", page: 2, pageCount: 5 };

describe("@sdp/ui's English test labels", () => {
  // The primitives' own suites render with a copy of these labels; the dashboard renders the
  // catalog. A label edited in messages/en must be edited in the copy too, or this fails.
  it.each(Object.keys(ENGLISH_UI_MESSAGES) as UiMessageKey[])(
    "%s matches the dashboard's English catalog",
    (key) => {
      expect(translateEnglishUi(key, SAMPLE_VALUES)).toBe(
        translate(englishSourceMessages, key, SAMPLE_VALUES)
      );
    }
  );
});
