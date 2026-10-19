import { listTemplates } from "@sdp/issuance/templates";
import {
  ASSET_CATEGORIES,
  ASSET_TYPES,
  type PublicToken,
  TOKEN_TRANSACTION_STATUSES,
  TOKEN_TRANSACTION_TYPES,
} from "@sdp/types";
import { z } from "zod";
import type { DemoAnswer } from "./demo-handlers";
import {
  type DemoIssuedToken,
  findIssuedToken,
  type IssuanceWorld,
  metadataAuthorityOf,
} from "./issuance-fixtures";

/*
 * What the demo answers for the Issuance reads: tokens and their facets, one token with the
 * authorities it asks for, its transactions, activity, control list and frozen accounts, the
 * templates, and asset profiles. The envelopes, defaults and filters are the SDP API's, so the
 * screens can't tell the two apart.
 */

const REQUEST_ID = "demo_request";

function success<T>(data: T, status = 200): DemoAnswer {
  return {
    status,
    body: { data, meta: { requestId: REQUEST_ID, timestamp: new Date().toISOString() } },
  };
}

function notFound(resource: string): DemoAnswer {
  return { status: 404, body: { error: { code: "NOT_FOUND", message: `${resource} not found` } } };
}

function badQuery(message: string, details?: Record<string, unknown>): DemoAnswer {
  const error: Record<string, unknown> = { code: "BAD_REQUEST", message };
  if (details) error.details = details;
  return { status: 400, body: { error } };
}

/*
 * The query schemas. Each route parses its query once, at the boundary. A count the API would
 * ignore (not a positive whole number) reads as absent, so the route's default applies.
 */
const countParam = z
  .string()
  .regex(/^\d+$/)
  .transform((value) => Number(value))
  .pipe(z.number().positive())
  .optional()
  .catch(undefined);

const pageQuery = z.object({ page: countParam, pageSize: countParam });

const flagParam = z.enum(["true", "false"]).optional();
const transactionType = z.enum(TOKEN_TRANSACTION_TYPES);
const transactionStatus = z.enum(TOKEN_TRANSACTION_STATUSES);

/** One page of rows in the API's paginated envelope. */
function paginated<T>(
  rows: readonly T[],
  params: URLSearchParams,
  defaults: { pageSize: number; maxPageSize: number }
): DemoAnswer {
  const query = pageQuery.parse(Object.fromEntries(params));
  const page = query.page ?? 1;
  const pageSize = Math.min(query.pageSize ?? defaults.pageSize, defaults.maxPageSize);
  return {
    status: 200,
    body: {
      data: rows.slice((page - 1) * pageSize, page * pageSize),
      meta: {
        total: rows.length,
        page,
        pageSize,
        hasMore: page * pageSize < rows.length,
        requestId: REQUEST_ID,
      },
    },
  };
}

function isDeployed(token: PublicToken): boolean {
  return token.mintAddress !== null || token.deployedAt !== null;
}

function deploymentStatusOf(token: PublicToken): "draft" | "active" | "paused" {
  if (!isDeployed(token)) return "draft";
  return token.status === "paused" ? "paused" : "active";
}

/** `GET /tokens`: search, status, deployment status, template, created range, then sort. */
const tokenListQuery = pageQuery.extend({
  search: z.string().optional(),
  status: z.string().optional(),
  deploymentStatus: z.string().optional(),
  template: z.string().optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  sortBy: z.string().optional(),
  sortDirection: z.string().optional(),
});

function tokenList(world: IssuanceWorld, params: URLSearchParams): DemoAnswer {
  const query = tokenListQuery.parse(Object.fromEntries(params));
  const search = query.search?.trim().toLowerCase() ?? "";
  const { status, deploymentStatus, template } = query;
  const after = query.createdAfter;
  const before = query.createdBefore;
  if (after && before && Date.parse(after) > Date.parse(before)) {
    return badQuery("Invalid query parameters", {
      errors: { createdBefore: ["createdBefore must be at or after createdAfter"] },
    });
  }
  const rows = world.tokens
    .map((entry) => entry.token)
    .filter((token) =>
      search
        ? [token.name, token.symbol, token.mintAddress, token.id].some((value) =>
            value?.toLowerCase().includes(search)
          )
        : true
    )
    .filter((token) => (status ? token.status === status : true))
    .filter((token) => (deploymentStatus ? deploymentStatusOf(token) === deploymentStatus : true))
    .filter((token) => (template ? token.template === template : true))
    .filter((token) => (after ? Date.parse(token.createdAt) >= Date.parse(after) : true))
    .filter((token) => (before ? Date.parse(token.createdAt) <= Date.parse(before) : true));

  const byName = query.sortBy === "name";
  const direction = query.sortDirection === "asc" ? 1 : -1;
  rows.sort((left, right) => {
    const order = byName
      ? left.name.toLowerCase().localeCompare(right.name.toLowerCase())
      : left.createdAt.localeCompare(right.createdAt);
    return (order || left.id.localeCompare(right.id)) * direction;
  });
  return paginated(rows, params, { pageSize: 50, maxPageSize: 100 });
}

/** `GET /tokens/facets`: the project's unfiltered totals. */
function tokenFacets(world: IssuanceWorld): DemoAnswer {
  const templates = new Map<string, number>();
  const deploymentStatuses = { draft: 0, active: 0, paused: 0 };
  for (const { token } of world.tokens) {
    templates.set(token.template, (templates.get(token.template) ?? 0) + 1);
    deploymentStatuses[deploymentStatusOf(token)] += 1;
  }
  return success({
    templates: [...templates.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([template, count]) => ({ template, count })),
    deploymentStatuses,
    total: world.tokens.length,
  });
}

const includeQuery = z.object({
  includeAllowlistAuthority: flagParam,
  includeFreezeAuthority: flagParam,
  includeMetadataAuthority: flagParam,
  includePauseAuthority: flagParam,
});

/** `GET /tokens/:id`: the token, with each authority it was asked for beside it. */
function tokenDetail(entry: DemoIssuedToken, params: URLSearchParams): DemoAnswer {
  const parsed = includeQuery.safeParse(Object.fromEntries(params));
  if (!parsed.success) {
    const flag = String(parsed.error.issues[0]?.path[0]);
    return badQuery("Invalid query parameters", { errors: { [flag]: ["Invalid input"] } });
  }
  const query = parsed.data;
  const { token } = entry;
  const asked = (flag: keyof typeof query) => query[flag] === "true";
  const authorities: Record<string, unknown> = {};
  if (asked("includeAllowlistAuthority")) {
    authorities.allowlistAuthority = token.ablListAddress ? token.mintAuthority : null;
  }
  if (asked("includeFreezeAuthority")) authorities.freezeAuthority = token.freezeAuthority;
  if (asked("includeMetadataAuthority")) {
    authorities.metadataAuthority = metadataAuthorityOf(token);
  }
  if (asked("includePauseAuthority")) {
    authorities.pauseAuthority = token.extensions?.pausable
      ? (token.extensions.pausable.authority ?? token.mintAuthority)
      : null;
  }
  return success({ token, ...authorities });
}

const tokenTransactionsQuery = pageQuery.extend({
  type: transactionType.optional(),
  status: transactionStatus.optional(),
});

/** `GET /tokens/:id/transactions`: newest first, one type and one status at most. */
function tokenTransactions(entry: DemoIssuedToken, params: URLSearchParams): DemoAnswer {
  const parsed = tokenTransactionsQuery.safeParse(Object.fromEntries(params));
  if (!parsed.success) return badQuery("Invalid query parameters");
  const { type, status } = parsed.data;
  const rows = entry.transactions.filter(
    (row) => (type ? row.type === type : true) && (status ? row.status === status : true)
  );
  return paginated(rows, params, { pageSize: 50, maxPageSize: 500 });
}

/** `GET /transactions`: every token's, each with the token it belongs to. */
const allTransactionsQuery = pageQuery.extend({ status: transactionStatus.optional() });

function allTransactions(world: IssuanceWorld, params: URLSearchParams): DemoAnswer {
  const types = params.getAll("type");
  const invalidTypes = types.filter((type) => !transactionType.safeParse(type).success);
  if (invalidTypes.length > 0) {
    return badQuery("Invalid type query parameter", {
      invalidTypes,
      allowedTypes: TOKEN_TRANSACTION_TYPES,
    });
  }
  const parsed = allTransactionsQuery.safeParse(Object.fromEntries(params));
  if (!parsed.success) {
    return badQuery("Invalid status query parameter", {
      allowedStatuses: TOKEN_TRANSACTION_STATUSES,
    });
  }
  const status = parsed.data.status;
  const wantedTypes = new Set(types);
  const rows = world.tokens
    .flatMap(({ token, transactions }) =>
      transactions.map((transaction) => ({
        token: {
          id: token.id,
          name: token.name,
          symbol: token.symbol,
          mintAddress: token.mintAddress,
        },
        transaction,
      }))
    )
    .filter(
      ({ transaction }) =>
        (wantedTypes.size === 0 || wantedTypes.has(transaction.type)) &&
        (status ? transaction.status === status : true)
    )
    .sort((left, right) => right.transaction.createdAt.localeCompare(left.transaction.createdAt));
  return paginated(rows, params, { pageSize: 50, maxPageSize: 100 });
}

/** `GET /tokens/:id/audit`: the activity feed, filtered by action, outcome and actor. */
const tokenAuditQuery = pageQuery.extend({
  action: z.string().optional(),
  status: z.string().optional(),
  type: z.string().optional(),
});

function tokenAudit(entry: DemoIssuedToken, params: URLSearchParams): DemoAnswer {
  const query = tokenAuditQuery.parse(Object.fromEntries(params));
  const { action, status } = query;
  const actorType = query.type;
  const rows = entry.audit.filter(
    (event) =>
      (action ? event.action === action : true) &&
      (status ? event.status === status : true) &&
      (actorType ? event.actorType === actorType : true)
  );
  return paginated(rows, params, { pageSize: 50, maxPageSize: 100 });
}

/** `GET /tokens/:id/allowlist`: the active entries, searched by address or label. */
const controlListQuery = pageQuery.extend({
  search: z.string().optional(),
  label: z.string().optional(),
});

function controlList(entry: DemoIssuedToken, params: URLSearchParams): DemoAnswer {
  const query = controlListQuery.parse(Object.fromEntries(params));
  const search = query.search?.trim().toLowerCase() ?? "";
  const label = query.label;
  const rows = entry.controlList.filter(
    (row) =>
      row.status === "active" &&
      (search
        ? row.address.toLowerCase().includes(search) ||
          (row.label?.toLowerCase().includes(search) ?? false)
        : true) &&
      (label ? row.label === label : true)
  );
  return paginated(rows, params, { pageSize: 50, maxPageSize: 500 });
}

function controlListLabels(entry: DemoIssuedToken): DemoAnswer {
  const active = entry.controlList.filter((row) => row.status === "active");
  const labels = [...new Set(active.flatMap((row) => (row.label ? [row.label] : [])))].sort(
    (left, right) => left.localeCompare(right)
  );
  return success({ labels, total: active.length });
}

/** `GET /tokens/:id/frozen`: accounts still frozen, latest first. */
function frozenAccounts(entry: DemoIssuedToken, params: URLSearchParams): DemoAnswer {
  return paginated(
    entry.frozen.filter((row) => row.unfrozenAt === null),
    params,
    { pageSize: 50, maxPageSize: 100 }
  );
}

function tokenRoute(world: IssuanceWorld, rest: readonly string[], params: URLSearchParams) {
  const [tokenId = "", sub, leaf] = rest;
  const entry = findIssuedToken(world, tokenId);
  if (!entry) return notFound("Token");
  if (sub === undefined) return tokenDetail(entry, params);
  if (leaf === undefined) {
    switch (sub) {
      case "transactions":
        return tokenTransactions(entry, params);
      case "audit":
        return tokenAudit(entry, params);
      case "allowlist":
        return controlList(entry, params);
      case "frozen":
        return frozenAccounts(entry, params);
      default:
        return undefined;
    }
  }
  return sub === "allowlist" && leaf === "labels" ? controlListLabels(entry) : undefined;
}

const assetProfilesQuery = pageQuery.extend({
  tokenIds: z.string().optional(),
  category: z.string().optional(),
});

function assetProfilesRoute(
  world: IssuanceWorld,
  rest: readonly string[],
  params: URLSearchParams
): DemoAnswer | undefined {
  const [first, second] = rest;
  if (first === undefined) {
    const query = assetProfilesQuery.parse(Object.fromEntries(params));
    const tokenIds = query.tokenIds?.split(",").filter(Boolean);
    const wantedTokenIds = tokenIds ? new Set(tokenIds) : null;
    const category = query.category;
    const profiles = world.tokens
      .map((entry) => entry.profile)
      .filter((profile) => (wantedTokenIds ? wantedTokenIds.has(profile.tokenId) : true))
      .filter((profile) => (category ? profile.assetCategory === category : true));
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 20, 100);
    return success({
      assetProfiles: profiles.slice((page - 1) * pageSize, page * pageSize),
      total: profiles.length,
      page,
      pageSize,
    });
  }
  if (first === "field-options" && second === undefined) {
    return success({
      fields: {
        categories: ASSET_CATEGORIES,
        types: ASSET_TYPES,
      },
    });
  }
  if (first === "by-token" && second !== undefined) {
    const entry = findIssuedToken(world, second);
    return entry ? success({ assetProfile: entry.profile }) : notFound("Asset profile");
  }
  if (second === undefined) {
    const entry = world.tokens.find((candidate) => candidate.profile.id === first);
    return entry ? success({ assetProfile: entry.profile }) : notFound("Asset profile");
  }
  return undefined;
}

/**
 * The demo's answer to an Issuance read, by the path's segments after `issuance`, or undefined
 * when the demo holds none (the caller then says it isn't part of the demo).
 */
export function issuanceRead(
  world: IssuanceWorld,
  rest: readonly string[],
  params: URLSearchParams
): DemoAnswer | undefined {
  const [resource, ...tail] = rest;
  switch (resource) {
    case "templates": {
      const templates = listTemplates();
      if (tail.length === 0) return success({ templates });
      const template = templates.find((candidate) => candidate.id === tail[0]);
      return tail.length === 1
        ? template
          ? success({ template })
          : notFound("Template")
        : undefined;
    }
    case "tokens":
      if (tail.length === 0) return tokenList(world, params);
      if (tail.length === 1 && tail[0] === "facets") return tokenFacets(world);
      return tokenRoute(world, tail, params);
    case "transactions":
      return tail.length === 0 ? allTransactions(world, params) : undefined;
    case "asset-profiles":
      return assetProfilesRoute(world, tail, params);
    default:
      return undefined;
  }
}
