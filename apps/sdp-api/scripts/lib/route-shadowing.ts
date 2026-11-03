/** A route's segments, a parameter (`{name}` or `:name`) as null. */
function routeSegments(template: string): (string | null)[] {
  return template
    .split("/")
    .map((segment) => (segment.startsWith("{") || segment.startsWith(":") ? null : segment));
}

/** A `route-actions.generated.json` key, `METHOD /path`; any other shape fails the build. */
function parseRouteOperation(operation: string): { method: string; path: string } {
  const match = /^([A-Z]+) (\/\S*)$/.exec(operation);
  if (match === null) {
    throw new Error(`route-actions.generated.json has a malformed operation: ${operation}`);
  }
  const [, method, path] = match;
  if (method === undefined || path === undefined) {
    throw new Error(`route-actions.generated.json has a malformed operation: ${operation}`);
  }
  return { method, path };
}

/** Find same-method routes with literals that take precedence over template parameters. */
export function findShadowingRoutePaths(
  method: string,
  template: string,
  routeOperations: readonly string[]
): string[] {
  const own = routeSegments(template);
  return routeOperations
    .map(parseRouteOperation)
    .filter((route) => route.method === method)
    .map((route) => route.path)
    .filter((routePath) => {
      const theirs = routeSegments(routePath);
      if (theirs.length !== own.length) return false;
      let literalOverParameter = false;
      for (const [index, segment] of own.entries()) {
        const other = theirs[index];
        if (segment !== null && other !== null && segment !== other) return false;
        if (segment === null && other !== null) literalOverParameter = true;
        if (segment !== null && other === null) return false;
      }
      return literalOverParameter;
    })
    .map((routePath) => routePath.replace(/:[^/]+/g, "{_}"))
    .sort();
}
