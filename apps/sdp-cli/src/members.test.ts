import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ORGANIZATION_ROLES } from "@sdp/types/roles";
import { operationById } from "./contract";
import { runCli } from "./run";

const session = {
  SDP_TOKEN: "members-test-session",
  SDP_PROJECT_ID: "prj_example",
  SDP_API_URL: "http://localhost:8787",
};
const meta = { requestId: "req_members", timestamp: "2026-01-01T00:00:00.000Z" };
const membership = {
  memberId: "mem_example",
  userId: "usr_example",
  organizationId: "org_example",
  role: "member",
};
const invitation = {
  id: "inv_example",
  email: "invitee@example.com",
  role: "viewer",
  expiresAt: "2026-01-08T00:00:00.000Z",
  clerkInvitationId: "orginv_example",
};
const directory = {
  members: [
    {
      id: "mem_example",
      role: "member",
      status: "active",
      createdAt: meta.timestamp,
      isSelf: true,
      user: { id: "usr_example", email: "member@example.com", name: null },
    },
  ],
  invitations: [
    {
      id: invitation.id,
      email: invitation.email,
      role: "viewer",
      status: "pending",
      createdAt: meta.timestamp,
      expiresAt: invitation.expiresAt,
    },
  ],
  meta: { total: 2, page: 1, pageSize: 25, hasMore: false, activeAdminCount: 1 },
};

interface RecordedRequest {
  url: string;
  init: RequestInit;
}
async function invoke(
  args: string[],
  response: Response,
  options: { env?: NodeJS.ProcessEnv; stdin?: string } = {}
) {
  let stdout = "";
  let stderr = "";
  const requests: RecordedRequest[] = [];
  const code = await runCli(args, {
    env: options.env ?? session,
    fetcher: async (url, init) => {
      assert(init);
      requests.push({ url: String(url), init });
      return response;
    },
    readStdin: async () => options.stdin ?? "",
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr, requests };
}
function memberResponse(): Response {
  return Response.json({ data: membership, meta });
}
function inviteResponse(): Response {
  return Response.json({ data: { invitation }, meta }, { status: 201 });
}
function headers(request: RecordedRequest): Headers {
  return new Headers(request.init.headers);
}

const mutations = [
  ["invitations", "create", "--email", invitation.email, "--role", "viewer"],
  ["invitations", "revoke", invitation.id],
  ["members", "update-role", membership.memberId, "--role", "viewer"],
  ["members", "remove", membership.memberId],
];
const readsAndLeave = [
  ["members", "list"],
  ["members", "get-self"],
  ["members", "leave-organization"],
];

test("members and invitations help explains roles, project scope, and self-service leave", async () => {
  for (const args of [
    ["members"],
    ["invitations"],
    ["members", "update-role", "--help"],
    ["members", "leave-organization", "--help"],
    ["invitations", "create", "--help"],
  ]) {
    const result = await invoke(args, memberResponse(), { env: {} });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 0);
    if (args[1] === "update-role") {
      assert(result.stdout.includes("<memberId>"));
      assert(result.stdout.includes("--project"));
    }
    if (args[1] === "leave") {
      assert(!result.stdout.includes("Requires action:"));
      assert(result.stdout.includes("own organization membership"));
    }
    if (args[0] === "invitations" && args[1] === "create")
      assert(result.stdout.includes("emailed link"));
  }
});

test("lists the combined member and pending-invitation directory with its metadata", async () => {
  const result = await invoke(["members", "list"], Response.json({ data: directory, meta }), {
    env: { SDP_TOKEN: "session-without-a-project" },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, "https://api.solana.com/v1/members");
  assert.equal(headers(result.requests[0]).get("x-project-id"), null);
  assert.deepEqual(JSON.parse(result.stdout), { data: directory, meta });
});

test("pagination serializes numeric page and pageSize query parameters", async () => {
  const result = await invoke(
    ["members", "list", "--page", "2", "--page-size", "10"],
    Response.json({
      data: { ...directory, meta: { ...directory.meta, page: 2, pageSize: 10 } },
      meta,
    })
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, "http://localhost:8787/v1/members?page=2&pageSize=10");
});

test("a read-only directory response keeps invitations empty", async () => {
  const data = { ...directory, invitations: [], meta: { ...directory.meta, total: 1 } };
  const result = await invoke(["members", "list"], Response.json({ data, meta }));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data.invitations, []);
});

test("gets the caller's current membership without a project", async () => {
  const result = await invoke(["members", "get-self"], memberResponse(), {
    env: { SDP_TOKEN: "session-without-a-project" },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests[0].url, "https://api.solana.com/v1/members/me");
  assert.deepEqual(JSON.parse(result.stdout).data, membership);
});

test("creates an invitation with explicit role, project, and idempotency key", async () => {
  const result = await invoke(
    [...mutations[0], "--project", "prj_selected", "--idempotency-key", "invite-operation-1"],
    inviteResponse()
  );
  assert.equal(result.code, 0, result.stderr);
  const request = result.requests[0];
  assert.equal(request.url, "http://localhost:8787/v1/members/invitations");
  assert.equal(request.init.method, "POST");
  assert.deepEqual(JSON.parse(String(request.init.body)), {
    email: invitation.email,
    role: "viewer",
  });
  assert.equal(headers(request).get("x-project-id"), "prj_selected");
  assert.equal(headers(request).get("idempotency-key"), "invite-operation-1");
  assert.deepEqual(JSON.parse(result.stdout).data.invitation, invitation);
  assert(!result.stdout.includes(session.SDP_TOKEN));
  assert(!result.stdout.includes('"url"'));
  assert.equal(result.requests.length, 1);
});

test("invitation creation and role changes support complete JSON bodies and stdin", async () => {
  const directoryPath = await mkdtemp(path.join(tmpdir(), "sdp-cli-member-"));
  try {
    const file = path.join(directoryPath, "invite.json");
    const body = JSON.stringify({ email: invitation.email, role: "viewer" });
    await writeFile(file, body);
    for (const source of [body, `@${file}`, "-"]) {
      const result = await invoke(["invitations", "create", "--data", source], inviteResponse(), {
        stdin: body,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.requests[0].init.body, body);
    }
    const result = await invoke(
      ["members", "update-role", membership.memberId, "--data", "-"],
      memberResponse(),
      { stdin: '{"role":"viewer"}' }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(String(result.requests[0].init.body)), { role: "viewer" });
  } finally {
    await rm(directoryPath, { recursive: true, force: true });
  }
});

test("updates a member to every canonical organization role", async () => {
  for (const role of ORGANIZATION_ROLES) {
    const result = await invoke(
      [
        "members",
        "update-role",
        membership.memberId,
        "--role",
        role,
        "--idempotency-key",
        `role-${role}`,
      ],
      Response.json({ data: { ...membership, role }, meta })
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests[0].init.method, "PATCH");
    assert.equal(new URL(result.requests[0].url).pathname, `/v1/members/${membership.memberId}`);
    assert.deepEqual(JSON.parse(String(result.requests[0].init.body)), { role });
    assert.equal(headers(result.requests[0]).get("idempotency-key"), `role-${role}`);
  }
});

test("removal and revocation send DELETE with explicit idempotency and no body", async () => {
  for (const [args, path] of [
    [["members", "remove", membership.memberId], `/v1/members/${membership.memberId}`],
    [["invitations", "revoke", invitation.id], `/v1/members/invitations/${invitation.id}`],
  ] as const) {
    const result = await invoke(
      [...args, "--idempotency-key", "delete-operation-1"],
      new Response(null, { status: 204 })
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(new URL(result.requests[0].url).pathname, path);
    assert.equal(result.requests[0].init.method, "DELETE");
    assert.equal(result.requests[0].init.body, undefined);
    assert.equal(headers(result.requests[0]).get("idempotency-key"), "delete-operation-1");
    assert.equal(headers(result.requests[0]).get("x-project-id"), session.SDP_PROJECT_ID);
    assert.equal(result.stdout, "");
  }
});

test("leaves through the caller's own route, independently of a stale project selection", async () => {
  for (const env of [{ SDP_TOKEN: session.SDP_TOKEN }, session]) {
    const result = await invoke(
      ["members", "leave-organization"],
      new Response(null, { status: 204 }),
      { env }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(new URL(result.requests[0].url).pathname, "/v1/members/me");
    assert.equal(result.requests[0].init.method, "DELETE");
    assert.equal(headers(result.requests[0]).get("x-project-id"), null);
    assert.equal(result.stdout, "");
  }
  assert.equal(operationById("leaveOrganization").authorization.kind, "membership");
});

test("an explicit member or invitation ID is encoded as one URL segment", async () => {
  for (const [args, suffix] of [
    [["members", "remove", "mem_/with?#"], "/v1/members/mem_%2Fwith%3F%23"],
    [["invitations", "revoke", "inv_/with?#"], "/v1/members/invitations/inv_%2Fwith%3F%23"],
  ] as const) {
    const result = await invoke([...args], new Response(null, { status: 204 }));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(new URL(result.requests[0].url).pathname, suffix);
  }
});

test("remove me cannot accidentally invoke the separate leave route", async () => {
  const result = await invoke(["members", "remove", "me"], new Response(null, { status: 204 }));
  assert.equal(result.code, 2, result.stderr);
  assert.equal(result.requests.length, 0);
  assert(result.stderr.includes("different API route"));
  assert(operationById("removeMember").shadowedBy.includes("/v1/members/me"));
});

test("mutation commands require a project before sending any request", async () => {
  for (const args of mutations) {
    const result = await invoke(args, inviteResponse(), { env: { SDP_TOKEN: session.SDP_TOKEN } });
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
    assert(result.stderr.includes("--project"));
  }
});

test("API keys cannot call any member or invitation operation", async () => {
  for (const args of [...mutations, ...readsAndLeave]) {
    const result = await invoke(args, memberResponse(), {
      env: { SDP_API_KEY: "fixture-key", SDP_PROJECT_ID: "prj_example" },
    });
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.requests.length, 0);
    assert(result.stderr.includes("Clerk session"));
  }
});

test("invalid arguments, pagination, roles and body fields make no requests", async () => {
  const cases = [
    ["members", "list", "--page", "0"],
    ["members", "list", "--page", "1.5"],
    ["members", "list", "--page", "NaN"],
    ["members", "list", "--page-size", "101"],
    ["members", "list", "--page-size", "-1"],
    ["members", "get-self", "--page", "1"],
    ["members", "remove"],
    ["members", "remove", ".."],
    ["members", "update-role", "--role", "viewer"],
    ["members", "update-role", membership.memberId],
    ["members", "update-role", membership.memberId, "--role", "owner"],
    ["members", "update-role", membership.memberId, "--data", '{"role":null}'],
    [
      "members",
      "update-role",
      membership.memberId,
      "--data",
      '{"role":"viewer","userId":"usr_other"}',
    ],
    ["members", "leave-organization", membership.memberId],
    ["members", "leave-organization", "--idempotency-key", "unsupported"],
    ["invitations", "create"],
    ["invitations", "create", "--email", "invalid", "--role", "viewer"],
    ["invitations", "create", "--email", invitation.email],
    ["invitations", "create", "--role", "developer", "--email", invitation.email],
    ["invitations", "create", "--email", invitation.email, "--data", '{"role":"viewer"}'],
    [
      "invitations",
      "create",
      "--data",
      '{"email":"invitee@example.com","role":"viewer","organizationId":"org_other"}',
    ],
    ["invitations", "revoke"],
    ["invitations", "accept", "untrusted-ticket"],
    ["invitations", "list"],
    ["invitations", "revoke", invitation.id, "--idempotency-key", "invalid\nkey"],
  ];
  for (const args of cases) {
    const result = await invoke(args, memberResponse());
    assert.equal(result.code, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.requests.length, 0, args.join(" "));
    assert.equal(result.stdout, "");
  }
});

test("server conflicts for invitations and membership rules are preserved without retries", async () => {
  for (const args of [...mutations, ["members", "leave-organization"]]) {
    const result = await invoke(
      args,
      Response.json(
        { error: { code: "CONFLICT", message: "Operation conflicts with membership rules" }, meta },
        { status: 409 }
      )
    );
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.requests.length, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.requestId, meta.requestId);
  }
});

test("member key lookup remains organization-wide and returns safe metadata without revoking anything", async () => {
  const data = {
    apiKeys: [
      {
        id: "key_example",
        name: "Automation",
        keyPrefix: "sf_example",
        environment: "sandbox",
        projectId: "prj_example",
        projectName: "Payments",
        createdAt: meta.timestamp,
      },
    ],
  };
  const result = await invoke(
    ["members", "api-keys", "list", "member/with space"],
    Response.json({ data, meta })
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 1);
  assert.equal(
    result.requests[0].url,
    "http://localhost:8787/v1/members/member%2Fwith%20space/api-keys"
  );
  assert.equal(result.requests[0].init.method, "GET");
  assert.equal(result.requests[0].init.body, undefined);
  assert.equal(new Headers(result.requests[0].init.headers).get("x-project-id"), null);
  assert.deepEqual(JSON.parse(result.stdout).data, data);
});
