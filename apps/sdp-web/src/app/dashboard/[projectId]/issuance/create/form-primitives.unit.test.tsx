import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { TextField } from "./form-primitives";

const messages = getMessages("en");

function renderWithI18n(children: ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={messages}>
      {children}
    </I18nProvider>
  );
}

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Tag names of the <input>'s ancestors (outermost first), ending with "input". */
function inputAncestorPath(html: string): string[] {
  const stack: string[] = [];
  for (const match of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)[^>]*?(\/?)>/g)) {
    const [, closing, rawTag, selfClosing] = match;
    const tag = rawTag.toLowerCase();
    if (closing) {
      stack.pop();
      continue;
    }
    if (tag === "input") {
      return [...stack, "input"];
    }
    if (!selfClosing && !VOID_TAGS.has(tag)) {
      stack.push(tag);
    }
  }
  throw new Error("no <input> found in markup");
}

describe("TextField", () => {
  // The design-system TextInput swaps between a bare input and a Field.Root
  // wrapper depending on whether label/description/error is present. TextField
  // must keep that structure stable: if a validation error appearing mid-typing
  // changes the wrapper tree, React remounts the <input> and focus is dropped.
  it("keeps the input's element path stable when an error appears", () => {
    const withoutError = renderWithI18n(
      <TextField label="Website" value="h" onChange={() => {}} />
    );
    const withError = renderWithI18n(
      <TextField label="Website" value="h" onChange={() => {}} error="Enter a valid URL" />
    );

    expect(inputAncestorPath(withoutError)).toEqual(inputAncestorPath(withError));
  });

  it("keeps the structure stable for fields with help text too", () => {
    const withHelp = renderWithI18n(
      <TextField label="Logo" value="h" onChange={() => {}} help="Shown in wallets" />
    );
    const withHelpAndError = renderWithI18n(
      <TextField
        label="Logo"
        value="h"
        onChange={() => {}}
        help="Shown in wallets"
        error="Enter a valid URL"
      />
    );

    expect(inputAncestorPath(withHelp)).toEqual(inputAncestorPath(withHelpAndError));
  });
});
