/**
 * Live Kora coverage for sponsored Earn vault execution (PRO-1736).
 *
 * Two things are asserted here that no unit test can reach:
 *
 * 1. the DEPLOYED Kora allowlist covers every provider the execution registry
 *    can build a vault-direct client for. A unit test checks the local harness
 *    config; only the running service knows what it was actually deployed with.
 * 2. `signAsFeePayer` accepts a transaction in which Kora's own fee payer is
 *    ALSO the ATA rent payer. That is the exact mechanism sponsored deposits
 *    depend on, it is the one Kora method the sponsored path calls, and it had
 *    no live coverage at all before this file.
 *
 * OPT-IN, deliberately. It stays off until the Kamino program ids are deployed
 * to devnet Kora (the sdp-infra half of PRO-1736), because until then a correct
 * failure here would red an unrelated suite. Turn it on with
 * EARN_KORA_SPONSORSHIP_SMOKE=true once that deploy lands, then make it
 * unconditional.
 *
 *   EARN_KORA_SPONSORSHIP_SMOKE=true pnpm kora:devnet:test
 */

import { apiTestSupport } from "@sdp/api/test-support";
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { env, KORA_CONFIGURED, RUN_INTEGRATION_TESTS } from "../helpers/integration";

const {
  KoraAdapter,
  KoraClient,
  EARN_PROVIDERS,
  resolveEarnExecutionClient,
  supportsVaultDirect,
  createVaultDeadline,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  TOKEN_PROGRAM_ADDRESS,
} = apiTestSupport;

const ENABLED =
  KORA_CONFIGURED &&
  RUN_INTEGRATION_TESTS &&
  (env as { EARN_KORA_SPONSORSHIP_SMOKE?: string }).EARN_KORA_SPONSORSHIP_SMOKE === "true";

/** The live Kora deployment this suite targets serves devnet. */
const CLUSTER = "devnet" as const;
const USDC_DEVNET = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

describe.skipIf(!ENABLED)("Earn vault sponsorship against live Kora", () => {
  let adapter: InstanceType<typeof KoraAdapter>;
  let client: InstanceType<typeof KoraClient>;

  beforeAll(() => {
    const rpcUrl = env.KORA_RPC_URL ?? "http://localhost:8080";
    const options = {
      rpcUrl,
      apiKey: env.KORA_API_KEY,
      timeoutMs: env.KORA_TIMEOUT_MS ? Number.parseInt(env.KORA_TIMEOUT_MS, 10) : 30_000,
    };
    adapter = new KoraAdapter(options);
    client = new KoraClient({ rpcUrl, apiKey: env.KORA_API_KEY });
  });

  it("allowlists every program each executing Earn provider can emit", async () => {
    const config = await client.getConfig();
    const allowed = new Set(config.validation_config.allowed_programs ?? []);
    expect(allowed.size).toBeGreaterThan(5);

    const declared = EARN_PROVIDERS.flatMap((provider) => {
      const executing = resolveEarnExecutionClient(env, provider, createVaultDeadline());
      if (!executing || !supportsVaultDirect(executing)) return [];
      return executing.sponsoredPrograms(CLUSTER).map((program) => ({ provider, program }));
    });
    // Guards the guard: zero declarations would pass vacuously.
    expect(declared.length).toBeGreaterThan(0);

    expect(declared.filter(({ program }) => !allowed.has(program))).toEqual([]);
  });

  /**
   * The claim under test: Kora signs a transaction where its own fee payer is
   * embedded in an instruction as the ATA rent payer (writable+signer).
   *
   * Kora gates this on `fee_payer_policy.system.allow_create_account`, so a
   * rejection here means the deployed policy closed and sponsored first deposits
   * are broken, whatever the allowlist says. Uses a bare ATA create rather than a
   * real vault plan on purpose: no funded position or live vault state is needed
   * to exercise the mechanism, so this stays a smoke test rather than a fixture.
   */
  it("signs an ATA create funded by its own fee payer", async () => {
    const feePayer = await adapter.getFeePayer();
    const owner = address("11111111111111111111111111111112");
    const [ata] = await findAssociatedTokenPda({
      owner,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      mint: USDC_DEVNET,
    });
    const { blockhash, lastValidBlockHeight } = await client
      .getBlockhash()
      .then((result: { blockhash: string }) => ({
        blockhash: result.blockhash as Parameters<
          typeof setTransactionMessageLifetimeUsingBlockhash
        >[0]["blockhash"],
        lastValidBlockHeight: 2n ** 63n - 1n,
      }));

    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
      (m) =>
        appendTransactionMessageInstructions(
          [
            getCreateAssociatedTokenIdempotentInstruction({
              payer: createNoopSigner(feePayer),
              ata,
              owner,
              mint: USDC_DEVNET,
              tokenProgram: TOKEN_PROGRAM_ADDRESS,
            }),
          ],
          m
        )
    );
    const unsigned = new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));

    const signed = await adapter.signAsFeePayer(unsigned);

    // One address in two roles collapses to one signature slot, and Kora fills
    // it. If dedup did not hold this would come back short a signature.
    const decoded = getTransactionDecoder().decode(signed);
    expect(decoded.signatures[feePayer as Address]).not.toBeNull();
    expect(Object.keys(decoded.signatures)).toHaveLength(1);
  });
});
