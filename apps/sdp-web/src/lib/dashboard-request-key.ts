import type { Arguments } from "swr";
import { z } from "zod";

export type DashboardMode = "live" | "demo";

export type DashboardRequestParams = Readonly<
  Record<string, string | number | boolean | undefined>
>;

export type DashboardJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly DashboardJsonValue[]
  | { readonly [field: string]: DashboardJsonValue };

export interface DashboardKeyScope {
  projectId: string;
  mode: DashboardMode;
}

/**
 * An SWR key that is the request itself: the Project and mode it is sent under, the BFF path and
 * its query. The path and params alone build the URL, so two keys share a cache entry only when
 * they would send the same request.
 */
export type DashboardRequestKey =
  | readonly [projectId: string, mode: DashboardMode, path: `/api/${string}`]
  | readonly [
      projectId: string,
      mode: DashboardMode,
      path: `/api/${string}`,
      params: DashboardRequestParams,
    ];

export function dashboardRequestKey(
  scope: DashboardKeyScope,
  path: `/api/${string}`,
  params?: DashboardRequestParams
): DashboardRequestKey {
  return params === undefined
    ? [scope.projectId, scope.mode, path]
    : [scope.projectId, scope.mode, path, params];
}

/**
 * A POST read's key: its params hold the serialized JSON body, which is exactly what is sent, so
 * the key alone decides the request.
 */
export type DashboardPostReadKey = readonly [
  projectId: string,
  mode: DashboardMode,
  path: `/api/${string}`,
  params: { readonly body: string },
];

export function dashboardPostReadKey(
  scope: DashboardKeyScope,
  path: `/api/${string}`,
  body: { readonly [field: string]: DashboardJsonValue }
): DashboardPostReadKey {
  return [scope.projectId, scope.mode, path, { body: JSON.stringify(body) }];
}

const requestKeyHeadSchema = z.tuple([
  z.string(),
  z.enum(["live", "demo"]),
  z.string().startsWith("/api/"),
]);
const requestKeySchema = z.union([
  requestKeyHeadSchema,
  z.tuple([
    ...requestKeyHeadSchema.def.items,
    z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.undefined()])),
  ]),
]);

/** Whether an SWR cache key is a request key (label keys from unmigrated modules are not). */
export function isDashboardRequestKey(key: Arguments): key is DashboardRequestKey {
  return requestKeySchema.safeParse(key).success;
}

export function dashboardRequestUrl(key: DashboardRequestKey): string {
  const params = key[3];
  if (params === undefined) {
    return key[2];
  }
  const query = new URLSearchParams();
  for (const name of Object.keys(params).sort()) {
    const value = params[name];
    if (value !== undefined) {
      query.set(name, String(value));
    }
  }
  const search = query.toString();
  return search === "" ? key[2] : `${key[2]}?${search}`;
}

/** Matches every request key whose path is `prefix` or lies under it, in any Project or mode. */
export function readsUnderPath(prefix: `/api/${string}`) {
  return (key: DashboardRequestKey) => key[2] === prefix || key[2].startsWith(`${prefix}/`);
}
