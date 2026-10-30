import type { ApiMethod } from "@sdp/api-catalog/reference";
import { ArrowRight } from "lucide-react";
import { Fragment } from "react";
import { getPlaygroundHref } from "@/lib/playground-link";

/**
 * A path's segments, each keyed by the path up to it, which is unique within the path and the
 * same on every render.
 */
function segmentsOf(path: string): { key: string; text: string }[] {
  const segments = path.split("/");
  return segments.map((text, index) => ({
    key: segments.slice(0, index + 1).join("/"),
    text,
  }));
}

/** One path segment, its `{parameter}` part dimmed. */
function PathSegment({ text }: { text: string }) {
  const parameter = /^(.*?)(\{[^}]+\})(.*)$/.exec(text);
  if (parameter === null) return text;
  const [, before, name, after] = parameter;
  return (
    <>
      {before}
      <span className="launch-api-path-param">{name}</span>
      {after}
    </>
  );
}

/**
 * An operation's method and path on an API reference page (scripts/lib/api-reference-page.ts).
 * A long path wraps after a slash. `expandDocsBlocks` writes it as `METHOD /path` in a code span,
 * and search indexes the same text.
 */
export function ApiEndpoint({ method, path }: { method: ApiMethod; path: string }) {
  const playgroundHref = getPlaygroundHref(method, path);
  return (
    <p className="launch-api-endpoint">
      <span className="launch-api-method" data-method={method}>
        {method}
      </span>
      <code>
        {segmentsOf(path).map((segment, index) => (
          <Fragment key={segment.key}>
            {index > 0 ? (
              <>
                /<wbr />
              </>
            ) : null}
            <PathSegment text={segment.text} />
          </Fragment>
        ))}
      </code>
      {playgroundHref ? (
        <a
          href={playgroundHref}
          target="_blank"
          rel="noopener noreferrer"
          className="launch-api-playground-link"
        >
          Run in dashboard
          <ArrowRight size={14} aria-hidden="true" />
        </a>
      ) : null}
    </p>
  );
}
