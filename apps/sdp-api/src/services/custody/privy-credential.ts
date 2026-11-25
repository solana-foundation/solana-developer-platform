import { checkPrivyCredential } from "@sdp/custody/providers/privy/credential";
import { hashString } from "@sdp/payments/hash";
import { currentClusterScope } from "@sdp/rpc/scope";
import { badRequest } from "@/lib/errors";
import { createRuntime } from "@/services/custody/provisioning";

const PRIVY_CREDENTIALS_REJECTED_MESSAGE =
  "The provider rejected these credentials. Check the credential fields, then connect again.";
const PRIVY_CREDENTIALS_UNCONFIRMED_MESSAGE =
  "Privy did not confirm these credentials, so nothing was saved. Try again.";

export interface PrivyCredentialAuthentication {
  appId: string;
  appSecret: string;
}

export async function getPrivyProviderAccountFingerprint(appId: string): Promise<string> {
  return `sha256:${await hashString(appId.trim())}`;
}

export async function assertPrivyCredentialAccepted(
  credential: PrivyCredentialAuthentication
): Promise<void> {
  const result = await checkPrivyCredential(createRuntime(), {
    ...credential,
    cluster: currentClusterScope().cluster,
  });
  if (result === "failed") {
    throw badRequest(PRIVY_CREDENTIALS_REJECTED_MESSAGE, { reason: "invalid_credentials" });
  }
  if (result === "retry_unknown") {
    throw badRequest(PRIVY_CREDENTIALS_UNCONFIRMED_MESSAGE, { reason: "provider_unconfirmed" });
  }
}
