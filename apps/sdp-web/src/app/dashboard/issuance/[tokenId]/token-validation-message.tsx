"use client";

interface TokenValidationMessageProps {
  message: string | null;
  reserveSpace?: boolean;
  // When false, the message is shown without an aria-live region. Use this for notes
  // that restate an error already announced elsewhere (e.g. a field's own validation
  // message) so screen readers don't announce the same text twice.
  announce?: boolean;
}

export function TokenValidationMessage({
  message,
  reserveSpace = true,
  announce = true,
}: TokenValidationMessageProps) {
  if (!reserveSpace && !message) {
    return null;
  }

  return (
    <p
      aria-live={announce && message ? "polite" : undefined}
      className={[
        reserveSpace ? "min-h-5" : "",
        "text-sm leading-5",
        message ? "text-[#9e2b38]" : "invisible text-transparent",
      ].join(" ")}
    >
      {message ?? "\u00A0"}
    </p>
  );
}
