import { randomUUID } from "node:crypto";
import { httpBasic, localDev } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

const username = process.env.TRANSLATION_AGENT_USERNAME?.trim() || `missing-${randomUUID()}`;
const password = process.env.TRANSLATION_AGENT_PASSWORD || randomUUID();

export default eveChannel({
  auth: [httpBasic({ username, password }), localDev()],
});
