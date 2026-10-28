import type { ApiMethod } from "@sdp/api-catalog/reference";
import { Fragment } from "react";

/** One path segment, its `{parameter}` parts dimmed. */
function PathSegment({ segment }: { segment: string }) {
  return segment.split(/(\{[^}]+\})/).map((part, index) =>
    index % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one segment never reorder.
      <span key={index} className="launch-api-path-param">
        {part}
      </span>
    ) : (
      part
    )
  );
}

/**
 * An operation's method and path on an API reference page (scripts/lib/api-reference-page.ts).
 * A long path wraps after a slash. `expandDocsBlocks` writes it as `METHOD /path` in a code span,
 * and search indexes the same text.
 */
export function ApiEndpoint({ method, path }: { method: ApiMethod; path: string }) {
  return (
    <p className="launch-api-endpoint">
      <span className="launch-api-method" data-method={method}>
        {method}
      </span>
      <code>
        {path.split("/").map((segment, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the segments of one path never reorder.
          <Fragment key={index}>
            {index > 0 ? (
              <>
                /<wbr />
              </>
            ) : null}
            <PathSegment segment={segment} />
          </Fragment>
        ))}
      </code>
    </p>
  );
}
