import Link from "next/link";

const contactHref = "https://solanafoundation.typeform.com/to/PLfMTDQs";

interface HomepageCtasProps {
  contactUsLabel: string;
  joinWaitlistLabel: string;
  openSignup: boolean;
  trySdpLabel: string;
}

export function HomepageCtas({
  contactUsLabel,
  joinWaitlistLabel,
  openSignup,
  trySdpLabel,
}: HomepageCtasProps) {
  if (!openSignup) {
    return (
      <div className="mt-[34px]">
        <Link
          href={contactHref}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-10 items-center justify-center rounded-[10px] bg-primary px-[18px] text-[15px] font-semibold leading-[15px] text-on-primary transition hover:opacity-90"
        >
          {joinWaitlistLabel}
        </Link>
      </div>
    );
  }

  return (
    <div className="mt-[34px] flex flex-wrap items-center gap-3">
      <Link
        href="/sign-up"
        className="inline-flex h-10 items-center justify-center rounded-[10px] bg-primary px-[18px] text-[15px] font-semibold leading-[15px] text-on-primary transition hover:opacity-90"
      >
        {trySdpLabel}
      </Link>
      <Link
        href={contactHref}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-10 items-center justify-center rounded-[10px] border border-border-default bg-surface-raised px-[18px] text-[15px] font-semibold leading-[15px] text-primary transition-colors hover:bg-fill-subtle"
      >
        {contactUsLabel}
      </Link>
    </div>
  );
}
