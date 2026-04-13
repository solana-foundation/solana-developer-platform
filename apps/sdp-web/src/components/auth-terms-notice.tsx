import Link from "next/link";

const TOS_HREF = "https://solana.com/tos";

export function AuthTermsNotice() {
  return (
    <p className="max-w-sm text-center text-xs leading-5 text-[rgba(28,28,29,0.72)]">
      By using the app, you agree to the{" "}
      <Link
        href={TOS_HREF}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-[#1c1c1d] underline underline-offset-2 transition-colors hover:text-black"
      >
        Solana Foundation Term Of Services
      </Link>
      .
    </p>
  );
}
