"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useTranslations } from "@/i18n/provider";
import type { NavLink } from "./homepage-links";

type NavAnchorProps = {
  link: Pick<NavLink, "href" | "external">;
  className?: string;
  children: ReactNode;
  onNavigate?: () => void;
};

/** A nav link; external ones open a new tab and say so to assistive technology. */
export function NavAnchor({ link, className, children, onNavigate }: NavAnchorProps) {
  const t = useTranslations();
  return (
    <Link
      href={link.href}
      className={className}
      onClick={onNavigate}
      {...(link.external ? { target: "_blank", rel: "noreferrer" } : {})}
    >
      {children}
      {link.external ? (
        <>
          {/* A text node of its own, so every name computation keeps the space. */}{" "}
          <span className="sr-only">{t("Homepage.nav.links.opensInNewTab")}</span>
        </>
      ) : null}
    </Link>
  );
}
