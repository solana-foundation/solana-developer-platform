import { useState } from "react";

/// A code block with a copy button. Code surfaces are the only place that the playground uses a
/// monospace font.
export function Code({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });

  return (
    <div className="code">
      <button type="button" className="btn btn-ghost code-copy" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
      <pre>{text}</pre>
    </div>
  );
}

/// Snippets in several languages, one shown at a time.
export function Snippets({ snippets }: { snippets: Record<string, string> }) {
  const names = Object.keys(snippets);
  const [shown, setShown] = useState(names[0] ?? "");

  return (
    <div className="snippets">
      <div className="snippet-tabs">
        {names.map((name) => (
          <button
            type="button"
            key={name}
            className={`btn btn-sec-sm ${shown === name ? "snippet-active" : ""}`}
            onClick={() => setShown(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <Code text={snippets[shown] ?? ""} />
    </div>
  );
}

/// The bytes as rows of 16, each with its offset.
export function hexDump(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const rows = Array.from({ length: Math.ceil(bytes.length / 16) }, (_, row) => {
    const slice = Array.from(bytes.slice(row * 16, row * 16 + 16));
    const hex = slice.map((byte) => byte.toString(16).padStart(2, "0")).join(" ");

    return `${(row * 16).toString(16).padStart(4, "0")}  ${hex}`;
  });

  return rows.join("\n");
}
