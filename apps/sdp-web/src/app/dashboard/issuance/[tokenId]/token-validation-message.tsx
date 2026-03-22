"use client";

interface TokenValidationMessageProps {
  message: string | null;
  reserveSpace?: boolean;
}

export function TokenValidationMessage({
  message,
  reserveSpace = true,
}: TokenValidationMessageProps) {
  if (!reserveSpace && !message) {
    return null;
  }

  return (
    <p
      aria-live={message ? "polite" : undefined}
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
