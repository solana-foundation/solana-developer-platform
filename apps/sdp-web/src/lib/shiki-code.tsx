"use client";

import { useEffect, useState } from "react";

/**
 * Shared Shiki highlighting for every dashboard code surface (API playground,
 * Earn integration screen). Extracted from the playground shell verbatim so
 * there is exactly ONE copy of the css-variables theme — the palette itself
 * lives in @solana/design-system/styles as --shiki-* custom properties, which
 * is what keeps highlighted markup following the root .dark class without
 * re-highlighting.
 */

export type HighlightLanguage = "javascript" | "json";

export function isHighlightLanguage(value: string): value is HighlightLanguage {
  return value === "javascript" || value === "json";
}

// @solana/design-system/styles (imported by globals.css) owns the complete
// light/dark --code-block-* and --shiki-token-* palette. Keep this Shiki theme
// variable-based so the highlighted markup follows the root .dark class
// without re-highlighting or duplicating the package palette here.
const cssVariablesTheme = {
  name: "css-variables",
  type: "light" as const,
  colors: {
    "editor.background": "var(--shiki-background)",
    "editor.foreground": "var(--shiki-foreground)",
  },
  settings: [
    {
      settings: {
        foreground: "var(--shiki-foreground)",
        background: "var(--shiki-background)",
      },
    },
    {
      scope: ["keyword", "keyword.control", "storage", "storage.type", "storage.modifier"],
      settings: {
        foreground: "var(--shiki-token-keyword)",
        fontStyle: "italic",
      },
    },
    {
      scope: ["keyword.operator", "keyword.operator.assignment"],
      settings: { foreground: "var(--shiki-token-keyword)" },
    },
    {
      scope: ["string", "string.quoted", "string.template"],
      settings: { foreground: "var(--shiki-token-string)" },
    },
    {
      scope: ["comment", "comment.line", "comment.block", "punctuation.definition.comment"],
      settings: {
        foreground: "var(--shiki-token-comment)",
        fontStyle: "italic",
      },
    },
    {
      scope: ["entity.name.function", "support.function", "meta.function-call"],
      settings: { foreground: "var(--shiki-token-function)" },
    },
    {
      scope: ["constant", "constant.numeric", "constant.language", "support.constant"],
      settings: { foreground: "var(--shiki-token-constant)" },
    },
    {
      scope: ["variable.parameter", "meta.parameter", "meta.object-literal.key"],
      settings: { foreground: "var(--shiki-token-parameter)" },
    },
    {
      scope: [
        "punctuation",
        "meta.brace",
        "meta.delimiter",
        "punctuation.separator",
        "punctuation.terminator",
      ],
      settings: { foreground: "var(--shiki-token-punctuation)" },
    },
    {
      scope: [
        "entity.name.type",
        "support.type",
        "support.class",
        "entity.other.inherited-class",
        "meta.type.annotation",
      ],
      settings: { foreground: "var(--shiki-token-type)" },
    },
    {
      scope: ["entity.other.attribute-name", "meta.attribute"],
      settings: { foreground: "var(--shiki-token-attribute)" },
    },
    {
      scope: ["constant.character.escape", "string.regexp"],
      settings: { foreground: "var(--shiki-token-escape)" },
    },
    {
      scope: ["variable.language"],
      settings: {
        foreground: "var(--shiki-token-variable-lang)",
        fontStyle: "italic",
      },
    },
    {
      scope: ["variable", "variable.other", "support.variable"],
      settings: { foreground: "var(--shiki-foreground)" },
    },
  ],
};

let shikiModulePromise: Promise<typeof import("shiki")> | null = null;

function getShikiModule() {
  if (!shikiModulePromise) {
    shikiModulePromise = import("shiki");
  }

  return shikiModulePromise;
}

export function HighlightedCode({
  content,
  language,
}: {
  content: string;
  language: HighlightLanguage;
}) {
  const [renderedHtml, setRenderedHtml] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    async function highlight() {
      try {
        const shiki = await getShikiModule();
        const html = await shiki.codeToHtml(content, {
          lang: language,
          theme: cssVariablesTheme,
        });

        if (!cancelled) {
          setRenderedHtml(html);
        }
      } catch {
        if (!cancelled) {
          setRenderedHtml("");
        }
      }
    }

    void highlight();

    return () => {
      cancelled = true;
    };
  }, [content, language]);

  return (
    <div
      className="h-full w-full overflow-auto text-sm"
      style={{
        tabSize: 2,
        scrollbarColor: "var(--code-block-scrollbar-thumb) transparent",
      }}
    >
      {renderedHtml ? (
        <div
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki returns HTML for syntax-highlighted code blocks.
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
          className="h-full [&_.shiki]:m-0 [&_.shiki]:h-full [&_.shiki]:min-h-full [&_.shiki]:w-full [&_.shiki]:overflow-visible [&_.shiki]:bg-transparent [&_.shiki]:p-0 [&_.shiki]:text-sm [&_.shiki]:leading-7 [&_.shiki]:[color:var(--shiki-foreground)] [&_.shiki_code]:block [&_.shiki_code]:min-h-full [&_.shiki_code]:min-w-full [&_.shiki_code]:whitespace-normal [&_.shiki_code_.line]:block [&_.shiki_code_.line]:whitespace-pre"
        />
      ) : (
        <pre className="m-0 min-h-full p-0 leading-7 text-[var(--shiki-foreground)]">
          <code>{content}</code>
        </pre>
      )}
    </div>
  );
}
