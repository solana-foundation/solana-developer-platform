import Link from "next/link";

const TOS_HREF = "https://solana.com/tos";

export function AuthTermsNotice() {
  return (
    <p className="max-w-sm text-center text-xs leading-5 text-secondary">
      By using the app, you agree to the{" "}
      <Link
        href={TOS_HREF}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-primary underline underline-offset-2 transition-colors hover:text-black"
      >
        Solana Foundation Term Of Services
      </Link>
      .
    </p>
  );
}
