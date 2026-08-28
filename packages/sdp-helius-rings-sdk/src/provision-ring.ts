import type { ZolanaClient } from "@heliuslabs/zolana/client";
import type { Bytes32 } from "@heliuslabs/zolana/interface";
import {
  createRingConfigInstruction,
  fetchReaderGrant,
  fetchRingProgramConfig,
  grantReadAccessInstruction,
  initSppRingConfigInstruction,
  RingError,
  type RingProgramConfig,
  RingRpc,
  ringAuthAddress,
  ringProgramDataAddress,
} from "@heliuslabs/zolana/ring";
import {
  HeliusRingsError,
  type ProvisionRingInput,
  type ProvisionRingResult,
} from "@sdp/helius-rings";
import {
  type Address,
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createTransactionMessage,
  getAddressDecoder,
  getBase58Encoder,
  getBase64Codec,
  getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage,
  getTransactionEncoder,
  type Instruction,
  type MessagePartialSigner,
  pipe,
  type Signature,
  type SignatureBytes,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Transaction,
} from "@solana/kit";

/**
 * Completes bring-up of a pre-deployed ring program: auditor key from the ring
 * RPC, then the ring's create-config, SPP-registration and initial-reader
 * instructions, signed only through custody. Each step is gated on a read of
 * what already exists on chain, so a run that died mid-way resumes instead of
 * double-submitting.
 */

export interface ProvisionRingDeps {
  readonly client: ZolanaClient;
  readonly ringRpcUrl: string;
  /** `owner` names the key custody must sign with; a gateway serves a whole tenant. */
  readonly signTransaction: (unsignedTxBase64: string, owner: string) => Promise<string>;
  /** Ed25519 over raw message bytes, for the auditor-key attestation. */
  readonly signMessage: (messageBase64: string, owner: string) => Promise<string>;
  readonly submitTransaction: (signedTxBase64: string) => Promise<string>;
}

/**
 * The only three ring-program instructions bring-up may sign; the read grant
 * is limited to the config authority as its own initial reader. Anything else
 * in the template's instruction set (set-authority, transact, grants to other
 * readers) moves value or powers, so custody refuses it on the bytes.
 */
const CREATE_CONFIG_TAG = 1;
const INIT_SPP_RING_CONFIG_TAG = 2;
const GRANT_READ_ACCESS_TAG = 4;

const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";

/** `UpgradeableLoaderState` tags: 2 names a program, 3 its programdata. */
const PROGRAM_STATE_TAG = 2;
const PROGRAM_DATA_STATE_TAG = 3;

export async function provisionCustomRing(
  deps: ProvisionRingDeps,
  input: ProvisionRingInput
): Promise<ProvisionRingResult> {
  const ringProgramId = parseRingProgramId(input.ringProgramId);

  // An existing config is adopted, never overwritten: re-keying a live ring
  // would orphan its auditor, and update paths are deliberately out of reach.
  let custodySigned = false;
  let config = await readRingConfig(deps.client, ringProgramId);
  if (config === undefined) {
    const authority = await readUpgradeAuthority(deps.client, ringProgramId);
    const auditor = await requestAuditorKey(deps, ringProgramId, authority);
    await landRingTransaction(deps, {
      instruction: await createRingConfigInstruction({
        ringProgramId,
        payer: authority,
        authority,
        auditorPublicKey: auditor.auditorPublicKey,
      }),
      owner: authority,
      ringProgramId,
      expectedTag: CREATE_CONFIG_TAG,
    });
    custodySigned = true;

    // Confirmation says the transaction landed, not that the account holds
    // what was intended.
    config = await readRingConfig(deps.client, ringProgramId);
    if (config === undefined) {
      throw new HeliusRingsError(
        "gateway_unavailable",
        "the ring config is absent after a confirmed create"
      );
    }
  }

  // The ring-auth account only ever exists once SPP registration ran, so its
  // absence is the resume point for the second half of bring-up.
  if ((await deps.client.getAccount(await ringAuthAddress(ringProgramId))) === undefined) {
    await landRingTransaction(deps, {
      instruction: await initSppRingConfigInstruction({
        ringProgramId,
        payer: config.authority,
        authority: config.authority,
      }),
      owner: config.authority,
      ringProgramId,
      expectedTag: INIT_SPP_RING_CONFIG_TAG,
    });
    custodySigned = true;
  }

  // The config authority becomes its own initial reader, as the ring pipeline
  // defines bring-up. Without this record the ring RPC serves its decrypted
  // reads to nobody, and only the authority — a custody key — can ever grant.
  if (!(await fetchReaderGrant(deps.client, ringProgramId, config.authority))) {
    await landRingTransaction(deps, {
      instruction: await grantReadAccessInstruction({
        ringProgramId,
        payer: config.authority,
        authority: config.authority,
        reader: config.authority,
      }),
      owner: config.authority,
      ringProgramId,
      expectedTag: GRANT_READ_ACCESS_TAG,
    });
    custodySigned = true;
  }

  // Every landed transaction above proves custody holds the config authority.
  // A fully-registered ring lands nothing, so adoption must prove it another
  // way: without this, a project could activate — and bind its deposits to —
  // a ring whose authority, auditor, and reader grants belong to someone else.
  if (!custodySigned) {
    await proveCustodyHoldsAuthority(deps, config.authority);
  }

  return { auditorPublicKeyHex: hex(config.auditorPublicKey.toUncompressed()) };
}

/** Caller input rather than persisted configuration, so a bad value is theirs to fix. */
function parseRingProgramId(value: string): Address {
  try {
    return address(value);
  } catch {
    throw new HeliusRingsError("invalid_input", "the ring program id is not a valid address");
  }
}

/** Absent is a state bring-up handles; any other config failure is the caller's problem. */
async function readRingConfig(
  client: ZolanaClient,
  ringProgramId: Address
): Promise<RingProgramConfig | undefined> {
  try {
    return await fetchRingProgramConfig(client, ringProgramId);
  } catch (error) {
    if (error instanceof RingError && error.code === "RING_CONFIG_NOT_FOUND") {
      return undefined;
    }
    throw error;
  }
}

/**
 * The upgrade authority is the only key the ring program trusts to create its
 * config, so bring-up signs as it. Read from the chain rather than taken as
 * input: custody either holds the key the loader names or signing fails, and
 * a mistyped expectation cannot pass validation on someone else's program.
 */
async function readUpgradeAuthority(
  client: ZolanaClient,
  ringProgramId: Address
): Promise<Address> {
  const [program, programDataAddress] = await Promise.all([
    client.getAccount(ringProgramId),
    ringProgramDataAddress(ringProgramId),
  ]);
  if (
    program === undefined ||
    program.owner !== UPGRADEABLE_LOADER ||
    readU32(program.data, 0) !== PROGRAM_STATE_TAG
  ) {
    throw new HeliusRingsError(
      "invalid_input",
      "the ring program id does not name a deployed upgradeable program"
    );
  }
  if (decodeStoredAddress(program.data, 4) !== programDataAddress) {
    throw new HeliusRingsError(
      "invalid_input",
      "the ring program does not point at its canonical programdata account"
    );
  }

  const programData = await client.getAccount(programDataAddress);
  if (programData === undefined || readU32(programData.data, 0) !== PROGRAM_DATA_STATE_TAG) {
    throw new HeliusRingsError(
      "invalid_input",
      "the ring program's programdata account is missing or malformed"
    );
  }
  // Option<Pubkey>: byte 12 is the tag. None means the program is immutable,
  // and an immutable program has no key that may create its config.
  if (programData.data[12] !== 1) {
    throw new HeliusRingsError(
      "invalid_input",
      "the ring program is immutable; bring-up needs its upgrade authority to sign"
    );
  }
  const authority = decodeStoredAddress(programData.data, 13);
  if (authority === undefined) {
    throw new HeliusRingsError(
      "invalid_input",
      "the ring program's programdata account is missing or malformed"
    );
  }

  return authority;
}

async function requestAuditorKey(
  deps: ProvisionRingDeps,
  ringProgramId: Address,
  authority: Address
) {
  const genesisHash = await deps.client.solanaRpc.getGenesisHash().send();
  return new RingRpc(deps.ringRpcUrl).createAuditorKey({
    ringProgramId,
    // The genesis hash pins the cluster, so a key minted for devnet cannot be
    // replayed into a mainnet config.
    genesisHash: getBase58Encoder().encode(genesisHash) as Bytes32,
    authority: custodyMessageSigner(deps.signMessage, authority),
  });
}

/**
 * Proves custody can sign as the ring's config authority by signing a random
 * challenge. Nothing is broadcast; the signature is discarded. Any refusal or
 * malformed answer reads as one thing: this project's custody does not hold
 * the key that administers the ring.
 */
async function proveCustodyHoldsAuthority(
  deps: ProvisionRingDeps,
  authority: Address
): Promise<void> {
  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);
  let signature: string;
  try {
    signature = await deps.signMessage(getBase64Codec().decode(challenge), authority);
  } catch {
    throw new HeliusRingsError(
      "conflict",
      "the ring's config authority is not a key this project's custody can sign with; the ring belongs to another operator"
    );
  }
  if (getBase64Codec().encode(signature).length !== 64) {
    throw new HeliusRingsError(
      "gateway_unavailable",
      "custody returned a malformed message signature"
    );
  }
}

/**
 * A Kit message signer whose secret lives in custody. Base64 in and out at the
 * seam, like `signTransaction`, so no branded Kit type crosses into `@sdp/api`.
 */
function custodyMessageSigner(
  signMessage: ProvisionRingDeps["signMessage"],
  owner: Address
): MessagePartialSigner {
  const base64 = getBase64Codec();
  return {
    address: owner,
    signMessages: async (messages) =>
      Promise.all(
        messages.map(async (message) => {
          const signature = base64.encode(await signMessage(base64.decode(message.content), owner));
          if (signature.length !== 64) {
            throw new HeliusRingsError(
              "gateway_unavailable",
              "custody returned a malformed message signature"
            );
          }
          return Object.freeze({ [owner]: signature as SignatureBytes });
        })
      ),
  };
}

/**
 * Signs through custody, broadcasts, and waits for the chain to accept it. The
 * assertion sits here rather than at the call sites because this is the single
 * point where bytes reach `deps.signTransaction`.
 */
async function landRingTransaction(
  deps: ProvisionRingDeps,
  input: Readonly<{
    instruction: Instruction;
    owner: Address;
    ringProgramId: Address;
    expectedTag: number;
  }>
): Promise<void> {
  const lifetime = await deps.client.getLatestBlockhash();
  const transaction = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayer(input.owner, message),
      (message) => setTransactionMessageLifetimeUsingBlockhash(lifetime, message),
      (message) => appendTransactionMessageInstruction(input.instruction, message)
    )
  );
  assertRingBringUpInstruction(transaction, input.ringProgramId, input.expectedTag);

  const unsigned = getBase64Codec().decode(getTransactionEncoder().encode(transaction));
  const signed = await deps.signTransaction(unsigned, input.owner);
  const signature = await deps.submitTransaction(signed);

  await deps.client.confirmTransaction(signature as Signature);
}

/**
 * Refuses anything but the named bring-up instruction, judged on the bytes
 * rather than on how the code arrived here. The template routes set-authority
 * and transact through the same program, and custody must sign neither.
 */
function assertRingBringUpInstruction(
  transaction: Transaction,
  ringProgramId: Address,
  expectedTag: number
): void {
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const instructions = getInstructionsFromCompiledTransactionMessage(message);
  const [instruction] = instructions;
  if (
    instructions.length !== 1 ||
    instruction?.programAddress !== ringProgramId ||
    // Kit omits `data` rather than emptying it, so no payload reads as no tag.
    instruction.data?.[0] !== expectedTag
  ) {
    throw new HeliusRingsError(
      "conflict",
      "refusing to sign a transaction that is not the expected ring bring-up instruction"
    );
  }
}

function readU32(data: Uint8Array, offset: number): number | undefined {
  if (data.length < offset + 4) {
    return undefined;
  }
  return new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true);
}

function decodeStoredAddress(data: Uint8Array, offset: number): Address | undefined {
  if (data.length < offset + 32) {
    return undefined;
  }
  return getAddressDecoder().decode(data.subarray(offset, offset + 32));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
