import { Webhook } from "svix";

type ClerkUser = {
  id: string;
  email_addresses: Array<{ id: string; email_address: string }>;
  primary_email_address_id: string | null;
  first_name: string | null;
  last_name: string | null;
};
type ClerkOrg = { id: string; name: string; slug: string | null };
type ClerkMembership = { organization: ClerkOrg; role: string };

function readArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function clerkGet<T>(endpoint: string, secret: string): Promise<T> {
  const res = await fetch(`https://api.clerk.com${endpoint}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!res.ok) {
    throw new Error(`Clerk ${endpoint} → ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

function asArray<T>(response: unknown): T[] {
  if (Array.isArray(response)) {
    return response as T[];
  }
  if (response && typeof response === "object" && Array.isArray((response as { data: T[] }).data)) {
    return (response as { data: T[] }).data;
  }
  return [];
}

async function post(url: string, payload: string, headers: Record<string, string>): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      body: payload,
      headers: { "Content-Type": "application/json", ...headers },
    });
  } catch (error) {
    const cause = (error as { cause?: unknown })?.cause;
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause ?? "");
    throw new Error(
      `Could not reach ${url} — ${error instanceof Error ? error.message : "unknown"}${detail ? ` (cause: ${detail})` : ""}`
    );
  }
  const body = await res.text();
  console.log(`  ← ${res.status} ${res.statusText} ${body}`);
  if (!res.ok) {
    throw new Error(`Webhook POST failed: ${res.status}`);
  }
}

function sign(secret: string, msgId: string, payload: string) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = new Webhook(secret).sign(msgId, new Date(Number(timestamp) * 1000), payload);
  return {
    "svix-id": msgId,
    "svix-timestamp": timestamp,
    "svix-signature": signature,
  };
}

async function main() {
  const email = readArg("--email")?.trim();
  const targetUrl = readArg("--url")?.trim() ?? "http://127.0.0.1:8787/webhooks/clerk/link-orgs";

  if (!email) {
    throw new Error("Missing --email. Example: --email you@example.com");
  }

  const clerkSecret = process.env.CLERK_SECRET_KEY?.trim();
  const webhookSecret = process.env.CLERK_WEBHOOK_SECRET?.trim();
  if (!clerkSecret) {
    throw new Error("CLERK_SECRET_KEY is required (run under Doppler).");
  }
  if (!webhookSecret) {
    throw new Error(
      "CLERK_WEBHOOK_SECRET is required — this must match what sdp-api reads from its env."
    );
  }

  console.log(`→ Fetching Clerk user for ${email}`);
  const users = asArray<ClerkUser>(
    await clerkGet<unknown>(`/v1/users?email_address=${encodeURIComponent(email)}`, clerkSecret)
  );
  const user = users[0];
  if (!user) {
    throw new Error(`No Clerk user for ${email}`);
  }
  console.log(`  user.id=${user.id}`);

  console.log("→ Fetching Clerk organization memberships");
  const memberships = asArray<ClerkMembership>(
    await clerkGet<unknown>(`/v1/users/${user.id}/organization_memberships`, clerkSecret)
  );
  const membership = memberships[0];
  if (!membership) {
    throw new Error(`User ${user.id} has no Clerk organizations. Create one in the app first.`);
  }
  const org = membership.organization;
  console.log(`  org.id=${org.id} (${org.name})`);

  const primaryEmail =
    user.email_addresses.find((entry) => entry.id === user.primary_email_address_id)
      ?.email_address ??
    user.email_addresses[0]?.email_address ??
    email;

  const membershipEvent = {
    type: "organizationMembership.created",
    object: "event",
    data: {
      id: `orgmem_sim_${Date.now()}`,
      object: "organization_membership",
      role: membership.role || "org:admin",
      organization: { id: org.id, name: org.name, slug: org.slug },
      public_user_data: {
        user_id: user.id,
        identifier: primaryEmail,
        first_name: user.first_name,
        last_name: user.last_name,
      },
    },
  };

  const payload = JSON.stringify(membershipEvent);
  const headers = sign(webhookSecret, `msg_sim_${Date.now()}`, payload);

  console.log(`→ POST ${targetUrl}`);
  await post(targetUrl, payload, headers);
  console.log("✓ Done. Reload /dashboard.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
