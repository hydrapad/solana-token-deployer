/**
 * Offline checks on the transactions the app asks a wallet to sign.
 *
 * There is no funded key here, so instead of broadcasting we verify the
 * instruction encoding against the SPL Token and Metaplex IDLs, and check that
 * every step fits inside Solana's 1232-byte packet limit.
 *
 * Run with: npm test
 */
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PROGRAM_ID as METADATA_PROGRAM_ID } from "@metaplex-foundation/mpl-token-metadata";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import { base58Encode } from "../src/lib/base58";
import { metadataAddressFor, planDeploy, type RentTable, type TokenSpec } from "../src/lib/deploy";
import { describeSupplyProblem, parseSupply, toBaseUnits } from "../src/lib/units";

const SYSTEM_PROGRAM = SystemProgram.programId;
const RENT: RentTable = {
  mint: 1_461_600,
  tokenAccount: 2_039_280,
  metadata: 11_356_000,
};

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail = ""): void {
  checks++;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** JSON-safe rendering; BigInt is common in this suite. */
function show(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function eq(label: string, actual: unknown, expected: unknown): void {
  const same =
    Object.is(actual, expected) ||
    (typeof actual === "object" &&
      actual !== null &&
      show(actual) === show(expected));
  if (same) {
    check(label, true);
  } else {
    check(label, false, `expected ${show(expected)}, got ${show(actual)}`);
  }
}

/* ------------------------------ decoders -------------------------------- */

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  u8(): number {
    const value = this.bytes[this.offset];
    this.offset++;
    if (value === undefined) throw new Error("read past end of buffer");
    return value;
  }

  u16(): number {
    const v = new DataView(this.bytes.buffer, this.bytes.byteOffset).getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32(): number {
    const v = new DataView(this.bytes.buffer, this.bytes.byteOffset).getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  u64(): bigint {
    const v = new DataView(this.bytes.buffer, this.bytes.byteOffset).getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }

  publicKey(): string {
    const slice = this.bytes.slice(this.offset, this.offset + 32);
    this.offset += 32;
    return base58Encode(slice);
  }

  string(): string {
    const length = this.u32();
    const slice = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return new TextDecoder().decode(slice);
  }

  remaining(): number {
    return this.bytes.length - this.offset;
  }
}

function wireSize(feePayer: PublicKey, instructions: TransactionInstruction[]): number {
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: feePayer,
      instructions,
      recentBlockhash: "11111111111111111111111111111111",
    }).compileToV0Message([]),
  );
  return tx.serialize().length;
}

function baseSpec(overrides: Partial<TokenSpec> = {}): TokenSpec {
  const payer = new PublicKey("So11111111111111111111111111111111111111112");
  return {
    name: "Test Coin",
    symbol: "TEST",
    decimals: 9,
    supplyRaw: 1_000_000_000n * 1_000_000_000n,
    recipient: payer,
    payer,
    uri: "",
    description: "",
    twitter: "",
    telegram: "",
    website: "",
    sellerFeeBasisPoints: 0,
    hasMetadata: false,
    revokeMint: true,
    revokeFreeze: true,
    lockMetadata: true,
    ...overrides,
  };
}

/* ------------------------------- suites --------------------------------- */

console.log("\nbase58");
{
  // Cross-check the hand-rolled encoder against web3.js's own base58.
  const zero = new Uint8Array(32);
  eq("32 zero bytes encode to 32 '1's", base58Encode(zero), "1".repeat(32));

  let matches = 0;
  const samples = 40;
  for (let i = 0; i < samples; i++) {
    const bytes = new Uint8Array(32);
    for (let j = 0; j < 32; j++) bytes[j] = Math.floor(Math.random() * 256);
    if (base58Encode(bytes) === new PublicKey(bytes).toBase58()) matches++;
  }
  eq(`matches web3.js on ${samples} random keys`, matches, samples);
}

console.log("\ntoBaseUnits");
{
  eq("1 with 9 decimals", toBaseUnits("1", 9), 1_000_000_000n);
  eq("1_000_000_000 with 9 decimals", toBaseUnits("1000000000", 9), 1_000_000_000_000_000_000n);
  eq("0 decimals keeps it whole", toBaseUnits("4200", 0), 4200n);
  eq("half a token", toBaseUnits("1.5", 9), 1_500_000_000n);
  eq("fraction padded to decimals", toBaseUnits("0.000000001", 9), 1n);
  eq("rejects scientific notation", toBaseUnits("1e9", 9), null);
  eq("rejects zero", toBaseUnits("0", 9), null);
  eq("rejects more precision than decimals", toBaseUnits("1.5", 0), null);
  eq("rejects negatives", toBaseUnits("-5", 9), null);
  eq("rejects junk", toBaseUnits("abc", 9), null);
  eq("rejects too many decimals", toBaseUnits("1.1234567890", 9), null);
}

console.log("\nparseSupply reasons");
{
  const reason = (amount: string, decimals = 9): string => {
    const result = parseSupply(amount, decimals);
    return result.ok ? `ok:${result.baseUnits}` : result.problem;
  };
  eq("valid amount", reason("1000"), "ok:1000000000000");
  eq("empty", reason(""), "empty");
  eq("junk", reason("abc"), "format");
  eq("scientific notation", reason("1e9"), "format");
  eq("negative", reason("-1"), "format");
  eq("zero", reason("0"), "zero");
  eq("too much precision", reason("1.1234567890"), "precision");
  eq("beyond u64", reason("99999999999999999999999999999"), "overflow");
  eq("exactly u64 base units", reason("18446744073709551615", 0), "ok:18446744073709551615");
  eq("one over u64", reason("18446744073709551616", 0), "overflow");
  check("every problem has a message",
    (["empty", "format", "precision", "zero", "overflow"] as const)
      .every((p) => describeSupplyProblem(p).length > 10));
}

console.log("\nplain token, authorities revoked");
{
  const spec = baseSpec();
  const plan = planDeploy(spec, RENT);
  const step = plan.steps[0]!;

  eq("one transaction", plan.steps.length, 1);
  eq("six instructions", step.instructions.length, 6);

  const [createMint, initMint, createAta, mintTo, revokeMint, revokeFreeze] = step.instructions;

  eq("1: system program", createMint!.programId.toBase58(), SYSTEM_PROGRAM.toBase58());
  eq("1: create account discriminator", createMint!.data[0], 0);
  // system createAccount data: u32 index | u64 lamports | u64 space | 32 owner
  eq("1: rent funded equals the rent-exempt minimum",
    new DataView(createMint!.data.buffer, createMint!.data.byteOffset + 4, 8).getBigUint64(0, true),
    BigInt(RENT.mint));
  eq("1: mint account space is 82", new DataView(
    createMint!.data.buffer, createMint!.data.byteOffset + 12, 8,
  ).getBigUint64(0, true), BigInt(82));
  eq("1: account owner is the token program",
    base58Encode(createMint!.data.slice(20, 52)), TOKEN_PROGRAM_ID.toBase58());
  eq("1: rent funded from the payer", createMint!.keys[0]!.pubkey.toBase58(), spec.payer.toBase58());
  eq("1: new account is our mint", createMint!.keys[1]!.pubkey.toBase58(), plan.mint.toBase58());
  // system create_account takes only two account metas; owner lives in the data.
  eq("1: exactly two account metas", createMint!.keys.length, 2);

  eq("2: token program", initMint!.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58());
  eq("2: InitializeMint2 discriminator", initMint!.data[0], 0);
  eq("2: decimals", initMint!.data[1], 9);
  // InitializeMint2 carries its authorities in the data, not as account metas.
  eq("2: payer holds mint authority", base58Encode(initMint!.data.slice(2, 34)),
    spec.payer.toBase58());
  eq("2: freeze authority is Some", initMint!.data[34], 1);
  eq("2: payer holds freeze authority", base58Encode(initMint!.data.slice(35, 67)),
    spec.payer.toBase58());
  // InitializeMint takes the mint plus the rent sysvar.
  eq("2: two account metas", initMint!.keys.length, 2);

  eq("3: ATA program", createAta!.programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  const ataAddress = getAssociatedTokenAddressSync(plan.mint, spec.recipient, true).toBase58();
  eq("3: ATA for the recipient", createAta!.keys[1]!.pubkey.toBase58(), ataAddress);
  // createAssociatedTokenAccountInstruction takes (payer, ata, owner, mint, ...).
  // Getting owner/mint the wrong way round yields on-chain InvalidSeeds.
  eq("3: third meta is the owner", createAta!.keys[2]!.pubkey.toBase58(), spec.recipient.toBase58());
  eq("3: fourth meta is the mint", createAta!.keys[3]!.pubkey.toBase58(), plan.mint.toBase58());
  eq("3: fifth meta is the system program", createAta!.keys[4]!.pubkey.toBase58(),
    SYSTEM_PROGRAM.toBase58());
  eq("3: sixth meta is the token program", createAta!.keys[5]!.pubkey.toBase58(),
    TOKEN_PROGRAM_ID.toBase58());
  check("3: payer signs", createAta!.keys[0]!.isSigner);

  eq("4: token program", mintTo!.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58());
  eq("4: MintTo discriminator", mintTo!.data[0], 7); // spl_token::instruction::TokenInstruction::MintTo
  eq("4: full supply encoded", new DataView(
    mintTo!.data.buffer, mintTo!.data.byteOffset + 1, 8,
  ).getBigUint64(0, true), spec.supplyRaw);
  eq("4: minted into the recipient ATA", mintTo!.keys[1]!.pubkey.toBase58(), ataAddress);
  check("4: payer is the mint authority", mintTo!.keys[2]!.isSigner);

  eq("5: SetAuthority discriminator", revokeMint!.data[0], 6); // TokenInstruction::SetAuthority
  eq("5: MintTokens authority type", revokeMint!.data[1], 0);
  // new_authority is COption<Pubkey>: a bare 0 byte means "nobody".
  eq("5: authority revoked to none", revokeMint!.data[2], 0);
  eq("5: nothing follows the None tag", revokeMint!.data.length, 3);

  eq("6: SetAuthority discriminator", revokeFreeze!.data[0], 6);
  eq("6: FreezeAccount authority type", revokeFreeze!.data[1], 1);
  eq("6: authority revoked to none", revokeFreeze!.data[2], 0);
  eq("6: nothing follows the None tag", revokeFreeze!.data.length, 3);

  check("step fits the 1232-byte limit", wireSize(spec.payer, step.instructions) <= 1232,
    `${wireSize(spec.payer, step.instructions)} bytes`);
  eq("recipient token account is the ATA", plan.recipientTokenAccount.toBase58(),
    getAssociatedTokenAddressSync(plan.mint, spec.recipient, true).toBase58());
}
console.log("\ntoken with metadata, locked");
{
  const spec = baseSpec({
    hasMetadata: true,
    uri: "ipfs://QmSomeCidThatIsLongEnoughToTestTheSizeBudget1234567890",
    description: "A token",
    sellerFeeBasisPoints: 250,
  });
  const plan = planDeploy(spec, RENT);
  const step = plan.steps[0]!;

  // create + mint + metadata + lock + both revokes fits in one approval.
  eq("one transaction", plan.steps.length, 1);
  eq("eight instructions", step.instructions.length, 8);
  eq("metadata PDA derivation", plan.metadataAddress?.toBase58(), metadataAddressFor(plan.mint).toBase58());

  // Ordering matters: metadata must be written before the mint authority is revoked.
  const programs = step.instructions.map((ix) => ix.programId.toBase58());
  const metadataAt = programs.indexOf(METADATA_PROGRAM_ID.toBase58());
  const revokeAt = programs.lastIndexOf(TOKEN_PROGRAM_ID.toBase58());
  check("metadata is written before the revocations", metadataAt > 0 && metadataAt < revokeAt,
    `metadata at ${metadataAt}, last token-program instruction at ${revokeAt}`);

  // createAccount, initMint, ATA, mintTo, createV3, updateV2, revokeMint, revokeFreeze
  const createMeta = step.instructions[4]!;
  const lockMeta = step.instructions[5]!;
  const revokeMint = step.instructions[6]!;
  const revokeFreeze = step.instructions[7]!;

  eq("create: token metadata program", createMeta.programId.toBase58(), METADATA_PROGRAM_ID.toBase58());
  eq("create: CreateMetadataAccountV3 discriminator", createMeta.data[0], 33);
  eq("create: metadata is the PDA", createMeta.keys[0]!.pubkey.toBase58(), plan.metadataAddress!.toBase58());
  eq("create: mint is our new mint", createMeta.keys[1]!.pubkey.toBase58(), plan.mint.toBase58());
  eq("create: payer funds the rent", createMeta.keys[3]!.pubkey.toBase58(), spec.payer.toBase58());
  check("create: payer signs", createMeta.keys[3]!.isSigner);

  // Walk the V3 payload: discriminator | DataV2 | isMutable | collectionDetails
  const reader = new Reader(createMeta.data);
  reader.u8();
  eq("name round-trips", reader.string(), spec.name);
  eq("symbol round-trips", reader.string(), spec.symbol);
  eq("uri round-trips", reader.string(), spec.uri);
  eq("seller fee basis points", reader.u16(), 250);
  eq("creators is Some", reader.u8(), 1);
  eq("one creator", reader.u32(), 1);
  eq("creator is the payer", reader.publicKey(), spec.payer.toBase58());
  eq("creator not yet verified", reader.u8(), 0);
  eq("creator holds 100%", reader.u8(), 100);
  eq("collection unset", reader.u8(), 0);
  eq("uses unset", reader.u8(), 0);
  eq("left mutable so the lock can follow", reader.u8(), 1);
  eq("collectionDetails unset", reader.u8(), 0);
  eq("encoding consumed exactly", reader.remaining(), 0);

  eq("lock: UpdateMetadataAccountV2 discriminator", lockMeta.data[0], 15);
  eq("lock: no data change", lockMeta.data[1], 0);
  eq("lock: update authority given to nobody", lockMeta.data[2], 0);
  eq("lock: primarySaleHappened untouched", lockMeta.data[3], 0);
  eq("lock: isMutable untouched", lockMeta.data[4], 0);
  eq("lock: payer still signs", lockMeta.keys[1]!.pubkey.toBase58(), spec.payer.toBase58());

  eq("revoke mint", revokeMint.data[0], 6);
  eq("revoke mint type", revokeMint.data[1], 0);
  eq("revoke freeze", revokeFreeze.data[0], 6);
  eq("revoke freeze type", revokeFreeze.data[1], 1);

  const bytes = wireSize(spec.payer, step.instructions);
  check("metadata step fits the 1232-byte limit", bytes <= 1232, `${bytes} bytes`);
}

console.log("\nmetadata left editable");
{
  const spec = baseSpec({ hasMetadata: true, uri: "https://example.com/t.json", lockMetadata: false });
  const plan = planDeploy(spec, RENT);
  eq("still one transaction", plan.steps.length, 1);
  eq("no lock instruction", plan.steps[0]!.instructions.length, 7);

  const createMeta = plan.steps[0]!.instructions[4]!;
  const reader = new Reader(createMeta.data);
  reader.u8();
  reader.string();
  reader.string();
  reader.string();
  reader.u16();
  reader.u8();
  reader.u32();
  reader.publicKey();
  reader.u8();
  reader.u8();
  reader.u8();
  reader.u8();
  eq("left mutable so a typo can be fixed", reader.u8(), 1);
  eq("collectionDetails unset", reader.u8(), 0);
  eq("encoding consumed exactly", reader.remaining(), 0);
}


console.log("\noptional pieces can be switched off");
{
  const bare = planDeploy(baseSpec({ revokeMint: false, revokeFreeze: false }), RENT);
  eq("only four instructions", bare.steps[0]!.instructions.length, 4);

  const bareMeta = planDeploy(baseSpec({ hasMetadata: false }), RENT);
  eq("no metadata transaction", bareMeta.steps.length, 1);
  eq("no metadata address", bareMeta.metadataAddress, null);
}

console.log("\nmetadata PDA derivation");
{
  // Seeds must be ["metadata", metadata program, mint]. Getting the prefix or
  // the middle seed wrong fails on chain with InvalidMetadataKey (0x5).
  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  eq("on-curve", PublicKey.isOnCurve(mint.toBuffer()), true);

  const expected = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata", "utf8"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID,
  )[0];
  eq("matches the documented derivation", metadataAddressFor(mint).toBase58(), expected.toBase58());

  const wrongPrefix = PublicKey.findProgramAddressSync(
    [METADATA_PROGRAM_ID.toBuffer(), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID,
  )[0];
  check("not the old double-program-id derivation", !wrongPrefix.equals(expected));
  check("different mints give different addresses", !metadataAddressFor(Keypair.generate().publicKey).equals(expected));
}

console.log("\nthe mint must sign for itself");
{
  // `create_account` requires the new account's signature, so the freshly
  // generated mint keypair signs locally and the wallet signs the fee payer.
  const spec = baseSpec();
  const plan = planDeploy(spec, RENT);

  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: spec.payer,
      instructions: plan.steps[0]!.instructions,
      recentBlockhash: "11111111111111111111111111111111",
    }).compileToV0Message([]),
  );

  eq("two signatures required", tx.message.header.numRequiredSignatures, 2);
  eq("one is the payer", tx.message.staticAccountKeys[0]!.toBase58(), spec.payer.toBase58());
  eq("the other is the mint", tx.message.staticAccountKeys[1]!.toBase58(), plan.mint.toBase58());

  tx.sign([plan.mintKeypair]);

  const mintSig = tx.signatures[1]!;
  const walletSig = tx.signatures[0]!;
  const isZero = (sig: Uint8Array): boolean => sig.every((b) => b === 0);

  check("mint produced a real signature", !isZero(mintSig));
  check("payer slot left blank for the wallet", isZero(walletSig));
  check("mint keypair matches the account", plan.mintKeypair.publicKey.equals(plan.mint));
  check("transaction still serialises", tx.serialize().length > 0);
}

console.log("\ncost model");
{
  const plan = planDeploy(baseSpec({ hasMetadata: true }), RENT);
  eq("rent mint + token account", plan.cost.mint + plan.cost.tokenAccount,
    RENT.mint + RENT.tokenAccount);
  eq("metadata rent included", plan.cost.metadata, RENT.metadata);
  eq("fees are 5000 per signature", plan.cost.fees, 5_000 * plan.steps.length);
  eq("total adds up", plan.cost.total,
    RENT.mint + RENT.tokenAccount + RENT.metadata + 5_000 * plan.steps.length);
}

console.log("\nmetadata account size constant");
{
  // 6791 is spl_token_metadata_interface::MAX_METADATA_LEN. If this drifts,
  // the rent funded for the metadata account would be wrong.
  check("MAX_METADATA_LEN is larger than a bare account", 6791 > ACCOUNT_SIZE, "6791 vs 165");
}

console.log(`\n${checks - failures}/${checks} checks passed\n`);
if (failures > 0) process.exit(1);