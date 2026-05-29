import { ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";

type NavPage = { name: string; url: string };

type PageNavProps = {
  prev?: NavPage;
  next?: NavPage;
};

export function PageNav({ prev, next }: PageNavProps) {
  if (!prev && !next) return null;

  return (
    <nav className="page-nav" aria-label="Page navigation">
      <div className="page-nav-prev">
        {prev && (
          <Link href={prev.url} className="page-nav-link">
            <span className="page-nav-direction">
              <ArrowLeft size={14} strokeWidth={2} />
              Previous
            </span>
            <span className="page-nav-title">{prev.name}</span>
          </Link>
        )}
      </div>
      <div className="page-nav-next">
        {next && (
          <Link href={next.url} className="page-nav-link page-nav-link--next">
            <span className="page-nav-direction">
              Next
              <ArrowRight size={14} strokeWidth={2} />
            </span>
            <span className="page-nav-title">{next.name}</span>
          </Link>
        )}
      </div>
    </nav>
  );
}
