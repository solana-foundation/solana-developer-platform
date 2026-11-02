import { refreshThemeProps } from "@sdp/design-tokens";
import { Button } from "@sdp/ui/button";
import Link from "next/link";
import type { ReactNode } from "react";
import { externalLinkProps } from "@/components/homepage/homepage-links";
import { getTranslations } from "@/i18n/server";

type AuthPageAction = {
  href: string;
  label: string;
  external: boolean;
};

export async function AuthPageShell({
  action,
  children,
}: {
  action: AuthPageAction | null;
  children: ReactNode;
}) {
  const t = await getTranslations();

  return (
    <main
      data-sdp-auth-shell=""
      {...refreshThemeProps}
      className="flex min-h-dvh flex-col bg-surface px-6 pb-10"
    >
      <div className="flex h-18 items-center justify-end">
        {action === null ? null : (
          <Button asChild variant="outline" size="sm">
            <Link href={action.href} {...externalLinkProps(action.external)}>
              {action.label}
            </Link>
          </Button>
        )}
      </div>
      <div className="flex flex-1 justify-center pt-20">
        <div className="flex w-full max-w-84 flex-col gap-10">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-fill-strong">
              <span
                aria-hidden
                className="size-4.5 bg-primary mask-[url(/homepage/logos/sdp-mark.svg)] mask-contain mask-center mask-no-repeat"
              />
            </span>
            <span className="w-min text-nav font-medium leading-none text-primary">
              {t("Shared.authShell.productName")}
            </span>
          </div>
          {children}
        </div>
      </div>
    </main>
  );
}
