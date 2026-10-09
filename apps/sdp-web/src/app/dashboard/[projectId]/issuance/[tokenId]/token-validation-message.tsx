"use client";

interface TokenValidationMessageProps {
  message: string | null;
  reserveSpace?: boolean;
  // When false, the message is shown without an aria-live region. Use this for notes
  // that restate an error already announced elsewhere (e.g. a field's own validation
  // message) so screen readers don't announce the same text twice.
  announce?: boolean;
  // Lets a field point its input's aria-describedby at this message so screen
  // readers read the error when the field is focused, not only when it appears.
  id?: string;
}

export function TokenValidationMessage({
  message,
  reserveSpace = true,
  announce = true,
  id,
}: TokenValidationMessageProps) {
  if (!reserveSpace && !message) {
    return null;
  }

  return (
    <p
      id={id}
      aria-live={announce && message ? "polite" : undefined}
      className={[
        reserveSpace ? "min-h-5" : "",
        "text-sm leading-5",
        message ? "text-destructive-strong" : "invisible text-transparent",
      ].join(" ")}
    >
      {message ?? "\u00A0"}
    </p>
  );
}
