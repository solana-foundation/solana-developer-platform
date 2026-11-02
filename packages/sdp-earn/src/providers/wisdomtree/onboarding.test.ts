import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { WISDOMTREE_FUNDS } from "@sdp/types/wisdomtree-programs";
import { SdpEarnError } from "#/errors";
import type { EarnRuntimeContext } from "#/types";
import { WisdomTreeEarnClient } from "./client";
import { resetWisdomTreeTokenCache } from "./connect";
import { WisdomTreeOnboardingClient } from "./onboarding";
import {
  type WisdomTreePersonSubmission,
  wisdomTreeBusinessPatchSchema,
} from "./onboarding-schemas";

const moderatorGuid = "a3c9d5b7-8a4d-4e35-9c1e-417cba654e2c";
const childGuid = "8b6f0d3e-2c71-4f5a-a1d9-3e4c7b2f9a10";
const personGuid = "3f1c2b7e-8d4a-4c1e-9b2f-6a5d0e7c1a24";
const credentials = JSON.stringify({
  clientId: "client",
  clientSecret: "secret",
  username: "user",
  password: "password",
});
const ctx: EarnRuntimeContext = {
  environment: "sandbox",
  env: { WISDOMTREE_SANDBOX_API_KEY: credentials },
};
const client = new WisdomTreeOnboardingClient();
const form = { can_create: true, submission_template: { agreements: [] }, sections: [] };
const token = { access_token: "token", expires_in: 600 };
const person: WisdomTreePersonSubmission = {
  entity_type: "retail",
  first_name: "Jane",
  last_name: "Doe",
  email: "jane@example.com",
  phone_number: "+12025550123",
  date_of_birth: "01-31-1990",
  tax_id: "666123456",
  address: "123 Main St",
  city: "New York",
  state: "NY",
  postal_code: "10001",
  country: "US",
  primary_source_of_funds: "Savings",
  agreement_set_version: "current",
  agreements: [{ key: "privacy", version: "current", accepted: false }],
};
function replies(...responses: Array<{ status: number; body: unknown }>) {
  let i = 0;
  return mock.method(globalThis, "fetch", async () => {
    const reply = responses[i++];
    assert.ok(reply, "Unexpected provider request");
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
}
const ok = (body: unknown) => ({ status: 200, body });
beforeEach(resetWisdomTreeTokenCache);
afterEach(() => mock.restoreAll());

describe("WisdomTree onboarding wire contract", () => {
  it("uses canonical form URLs and preserves the live template/conditions", async () => {
    const f = replies(ok(token), ok(form), ok({ ...form, sections: [{ required_when: "live" }] }));
    assert.deepEqual(await client.getPersonForm(ctx), form);
    assert.deepEqual((await client.getBusinessForm(ctx)).sections, [{ required_when: "live" }]);
    assert.equal(
      String(f.mock.calls[1].arguments[0]),
      "https://api.sandbox.wisdomtreeconnect.com/api/onboarding/person"
    );
    assert.equal(
      String(f.mock.calls[2].arguments[0]),
      "https://api.sandbox.wisdomtreeconnect.com/api/onboarding/org"
    );
  });
  it("uses the new production host and distinct environment credentials", async () => {
    const f = replies(ok(token), ok(form), ok(token), ok(form));
    await client.getBusinessForm(ctx);
    await client.getBusinessForm({
      environment: "production",
      env: { WISDOMTREE_API_KEY: credentials },
    });
    assert.equal(
      String(f.mock.calls[2].arguments[0]),
      "https://api.wisdomtreeconnect.com/o/token/"
    );
    assert.equal(
      String(f.mock.calls[3].arguments[0]),
      "https://api.wisdomtreeconnect.com/api/onboarding/org"
    );
  });
  it("passes US KYC answers and actual agreement choices unchanged", async () => {
    const f = replies(ok(token), {
      status: 201,
      body: { person_guid: personGuid, person: { onboarding_status: "submitted" } },
    });
    assert.equal((await client.submitPerson(ctx, person)).person_guid, personGuid);
    assert.deepEqual(JSON.parse(String(f.mock.calls[1].arguments[1]?.body)), person);
  });
  it("rejects non-US persons, malformed SSNs and individual drafts before network", async () => {
    const f = replies();
    for (const value of [
      { ...person, country: "GB" },
      { ...person, tax_id: "****3456" },
      { ...person, status: "draft" },
    ]) {
      // SAFETY: exercise validation of data arriving at the trust boundary.
      await assert.rejects(
        client.submitPerson(ctx, value as WisdomTreePersonSubmission),
        SdpEarnError
      );
    }
    assert.equal(f.mock.callCount(), 0);
  });
  it("requires explicit business draft/submit intent", async () => {
    const f = replies();
    // SAFETY: intentionally missing intent at the external-input boundary.
    await assert.rejects(
      client.saveBusiness(ctx, { entity_type: "organization" } as Parameters<
        typeof client.saveBusiness
      >[1]),
      SdpEarnError
    );
    assert.equal(f.mock.callCount(), 0);
  });
  it("preserves non-US IDs, CDD people and full upload objects", async () => {
    const body = {
      entity_type: "organization" as const,
      status: "draft" as const,
      org_details: { name: "Foundation", country_of_incorporation: "GB", tax_id: "GB-ABC" },
      control_person: { passport: "test" },
      owners: { no_beneficial_owners_certified: true },
      formation_document: {
        blob_path: "onboarding_documents/unlinked/file.pdf",
        original_filename: "formation.pdf",
      },
    };
    const f = replies(ok(token), {
      status: 201,
      body: { organization_guid: childGuid, status: "draft" },
    });
    await client.saveBusiness(ctx, body);
    assert.deepEqual(JSON.parse(String(f.mock.calls[1].arguments[1]?.body)), body);
  });
  it("rejects bare blob strings and numeric readback documents", async () => {
    const f = replies();
    for (const doc of ["blob/path.pdf", 123]) {
      await assert.rejects(
        client.saveBusiness(ctx, {
          entity_type: "organization",
          status: "draft",
          formation_document: doc,
        }),
        SdpEarnError
      );
    }
    assert.equal(f.mock.callCount(), 0);
  });
  it("uploads a binary multipart file without a JSON Content-Type", async () => {
    const f = replies(ok(token), {
      status: 201,
      body: { blob_path: "blob/file.pdf", original_filename: "file.pdf" },
    });
    await client.uploadDocument(ctx, {
      documentType: "formation_document",
      file: new File(["%PDF-test"], "file.pdf", { type: "application/pdf" }),
    });
    const init = f.mock.calls[1].arguments[1];
    assert.ok(init?.body instanceof FormData);
    assert.equal(init.body.get("document_type"), "formation_document");
    const file = init.body.get("file");
    assert.ok(file instanceof File);
    assert.equal(await file.text(), "%PDF-test");
    assert.equal(new Headers(init.headers).has("Content-Type"), false);
  });
  it("rejects empty, unsupported and oversized files before authentication", async () => {
    const f = replies();
    for (const file of [
      new File([], "a.pdf", { type: "application/pdf" }),
      new File(["text"], "a.txt", { type: "text/plain" }),
      new File([new Uint8Array(25 * 1024 * 1024)], "a.pdf", { type: "application/pdf" }),
    ]) {
      await assert.rejects(
        client.uploadDocument(ctx, { documentType: "formation_document", file }),
        SdpEarnError
      );
    }
    assert.equal(f.mock.callCount(), 0);
  });
  it("treats submitted and unfamiliar provider statuses as live status strings", async () => {
    replies(
      ok(token),
      ok({
        org_guid: childGuid,
        onboarding_status: "new_review_state",
        sensitive_data_redacted: true,
      })
    );
    assert.equal((await client.getBusiness(ctx, childGuid)).onboarding_status, "new_review_state");
  });
  it("reads person IDs separately from their moderator organization", async () => {
    replies(
      ok(token),
      ok({
        person_guid: personGuid,
        organization_guid: moderatorGuid,
        onboarding_status: "active",
        sensitive_data_redacted: true,
      })
    );
    assert.equal((await client.getPerson(ctx, personGuid)).organization_guid, moderatorGuid);
  });
  it("uses the stored business GUID to submit an existing draft", async () => {
    const f = replies(ok(token), ok({ organization_guid: childGuid }));
    await client.saveBusiness(ctx, {
      entity_type: "organization",
      status: "submit",
      org_guid: childGuid,
    });
    assert.equal(JSON.parse(String(f.mock.calls[1].arguments[1]?.body)).org_guid, childGuid);
  });
  it("PATCH cannot change status or parentage", async () => {
    const f = replies();
    for (const patch of [{ status: "submit" }, { parent_org_guid: childGuid }]) {
      assert.equal(wisdomTreeBusinessPatchSchema.safeParse(patch).success, false);
    }
    assert.equal(f.mock.callCount(), 0);
  });
  it("posts one correction to its canonical route without implicitly resubmitting", async () => {
    const f = replies(
      ok(token),
      ok({ reason: { id: 4127, requiredAction: "provide_explanation", partnerResubmitted: true } })
    );
    await client.answerCorrection(ctx, childGuid, 4127, {
      explanation: "An answer",
      attested: false,
    });
    assert.equal(
      String(f.mock.calls[1].arguments[0]),
      `https://api.sandbox.wisdomtreeconnect.com/api/onboarding/${childGuid}/corrections/4127/`
    );
    assert.equal(f.mock.callCount(), 2);
  });
  it("retains only safe recovery GUIDs when a failed submission saved a draft", async () => {
    replies(ok(token), {
      status: 400,
      body: {
        organization_guid: childGuid,
        detail: "SSN 666123456",
        errors: { tax_id: "666123456" },
      },
    });
    await assert.rejects(
      client.saveBusiness(ctx, { entity_type: "organization", status: "submit" }),
      (error: unknown) => {
        assert.ok(error instanceof SdpEarnError);
        assert.equal(error.details?.organization_guid, childGuid);
        assert.equal(error.details?.providerStatus, 400);
        assert.doesNotMatch(JSON.stringify(error) + error.message, /666123456/);
        return true;
      }
    );
  });
  it("does not replay a write on 401 or 5xx", async () => {
    for (const status of [401, 503]) {
      resetWisdomTreeTokenCache();
      const f = replies(ok(token), { status, body: { detail: "rejected" } });
      await assert.rejects(
        client.saveBusiness(ctx, { entity_type: "organization", status: "draft" }),
        SdpEarnError
      );
      assert.equal(f.mock.callCount(), 2);
      mock.restoreAll();
    }
  });
  it("does not replay an ambiguous network failure", async () => {
    let calls = 0;
    mock.method(globalThis, "fetch", async () => {
      if (calls++ === 0) return new Response(JSON.stringify(token));
      throw new Error("timeout with applicant 666123456");
    });
    await assert.rejects(
      client.submitPerson(ctx, person),
      (error: unknown) => error instanceof SdpEarnError && !error.message.includes("666123456")
    );
    assert.equal(calls, 2);
  });
  it("refreshes a revoked token once for reads only", async () => {
    const f = replies(
      ok(token),
      { status: 401, body: {} },
      ok({ ...token, access_token: "new" }),
      ok(form)
    );
    await client.getBusinessForm(ctx);
    assert.equal(f.mock.callCount(), 4);
  });
  it("does not leak malformed response contents and retains a recovery GUID", async () => {
    replies(ok(token), ok({ organization_guid: childGuid, status: 5, tax_id: "666123456" }));
    await assert.rejects(
      client.saveBusiness(ctx, { entity_type: "organization", status: "draft" }),
      (error: unknown) =>
        error instanceof SdpEarnError &&
        error.details?.organization_guid === childGuid &&
        !error.message.includes("666123456")
    );
  });
  it("rejects unsafe path IDs before network", async () => {
    const f = replies();
    await assert.rejects(client.getBusiness(ctx, "../organizations/me"), SdpEarnError);
    await assert.rejects(
      client.answerCorrection(ctx, childGuid, -1, { attested: true }),
      SdpEarnError
    );
    assert.equal(f.mock.callCount(), 0);
  });
});

describe("Moderator deposit identity", () => {
  const earn = new WisdomTreeEarnClient();
  const input = {
    providerReference: WISDOMTREE_FUNDS[0].mint,
    owner: "wallet",
    customer: { moderatorReference: moderatorGuid, customerReference: childGuid },
  };
  it("reads wallets and products in the assigned child context", async () => {
    const f = replies(
      ok(token),
      ok({ guid: moderatorGuid, client_organizations: [{ guid: childGuid }] }),
      ok({ data: { Solana: [{ public_key: "wallet", status: "Approved" }] } }),
      ok({ products: [{ exchange_code: WISDOMTREE_FUNDS[0].exchangeCode, can_trade: true }] })
    );
    assert.equal((await earn.checkDepositEligibility(ctx, input)).eligible, true);
    assert.match(
      String(f.mock.calls[2].arguments[0]),
      new RegExp(`/organizations/${childGuid}/wallets$`)
    );
    assert.equal(
      new URL(String(f.mock.calls[3].arguments[0])).searchParams.get("organization_guid"),
      childGuid
    );
  });
  it("refuses revoked assignments before reading either customer's data", async () => {
    const f = replies(ok(token), ok({ guid: moderatorGuid, client_organizations: [] }));
    assert.equal((await earn.checkDepositEligibility(ctx, input)).eligible, false);
    assert.equal(f.mock.callCount(), 2);
  });
  it("never treats the moderator as a customer child", async () => {
    const f = replies(
      ok(token),
      ok({ guid: moderatorGuid, client_organizations: [{ guid: moderatorGuid }] })
    );
    assert.equal(
      (
        await earn.checkDepositEligibility(ctx, {
          ...input,
          customer: { ...input.customer, customerReference: moderatorGuid },
        })
      ).eligible,
      false
    );
    assert.equal(f.mock.callCount(), 2);
  });
});
