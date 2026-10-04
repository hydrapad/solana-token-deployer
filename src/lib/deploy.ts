import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ACCOUNT_SIZE,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  AuthorityType,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";
import {
  createCreateMetadataAccountV3Instruction,
  createUpdateMetadataAccountV2Instruction,
  PROGRAM_ID as TOKEN_METADATA_PROGRAM_ID,
} from "@metaplex-foundation/mpl-token-metadata";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

/** Hard Solana packet limit; we aim well below it. */
const WIRE_LIMIT = 1232;
const WIRE_TARGET = 1150;
/** A 32-zero-byte blockhash: valid base58, so it is safe for size probing. */
const PLACEHOLDER_BLOCKHASH = "11111111111111111111111111111111";
/** spl_token_metadata_interface::MAX_METADATA_LEN */
const METADATA_ACCOUNT_LEN = 6791;
/** Lamports charged per signature. No priority fee is assumed. */
export const LAMPORTS_PER_SIGNATURE = 5_000;

/* -------------------------------------------------------------------------- */
/*  Rent + fees                                                               */
/* -------------------------------------------------------------------------- */

export interface RentTable {
  mint: number;
  tokenAccount: number;
  metadata: number;
}

export interface CostEstimate extends RentTable {
  hasMetadata: boolean;
  transactions: number;
  fees: number;
  total: number;
}

let rentCache: RentTable | null = null;

/** Rent differs per cluster, so switching networks must invalidate the cache. */
export function resetRentCache(): void {
  rentCache = null;
}

/** Rent comes from the live cluster, so it is fetched once and reused. */
export async function loadRent(connection: Connection): Promise<RentTable> {
  if (rentCache) return rentCache;
  const [mint, tokenAccount, metadata] = await Promise.all([
    getMinimumBalanceForRentExemptMint(connection),
    connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE),
    connection.getMinimumBalanceForRentExemption(METADATA_ACCOUNT_LEN),
  ]);
  rentCache = { mint, tokenAccount, metadata };
  return rentCache;
}

export function estimateCost(rent: RentTable, hasMetadata: boolean, transactions: number): CostEstimate {
  const fees = transactions * LAMPORTS_PER_SIGNATURE;
  return {
    ...rent,
    hasMetadata,
    transactions,
    fees,
    total: rent.mint + rent.tokenAccount + (hasMetadata ? rent.metadata : 0) + fees,
  };
}

/* -------------------------------------------------------------------------- */
/*  Planning                                                                  */
/* -------------------------------------------------------------------------- */

export interface TokenSpec {
  name: string;
  symbol: string;
  decimals: number;
  /** Supply in base units, already scaled by decimals. */
  supplyRaw: bigint;
  recipient: PublicKey;
  payer: PublicKey;
  uri: string;
  description: string;
  twitter: string;
  telegram: string;
  website: string;
  sellerFeeBasisPoints: number;
  hasMetadata: boolean;
  revokeMint: boolean;
  revokeFreeze: boolean;
  lockMetadata: boolean;
}

/** One wallet approval: a title, what it does, and the instructions it carries. */
export interface DeployStep {
  title: string;
  details: string[];
  instructions: TransactionInstruction[];
}

export interface DeployPlan {
  mint: PublicKey;
  mintKeypair: Keypair;
  recipientTokenAccount: PublicKey;
  metadataAddress: PublicKey | null;
  steps: DeployStep[];
  cost: CostEstimate;
}

/** spl_token_metadata_interface::PREFIX */
const METADATA_SEED_PREFIX = Buffer.from("metadata", "utf8");

/**
 * The Metaplex metadata PDA: seeds are ["metadata", metadata program, mint].
 * The program rejects any other derivation with InvalidMetadataKey (0x5).
 */
export function metadataAddressFor(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [METADATA_SEED_PREFIX, TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
}

function toVersioned(feePayer: PublicKey, instructions: TransactionInstruction[]): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: feePayer,
    instructions,
    recentBlockhash: PLACEHOLDER_BLOCKHASH,
  }).compileToV0Message([]);

  const tx = new VersionedTransaction(message);
  // The constructor leaves the slots undefined; fill them so `serialize()`
  // measures and transmits the full, correctly sized packet.
  tx.signatures = new Array(message.header.numRequiredSignatures).fill(new Uint8Array(64));
  return tx;
}

/** Exact serialized size of the transaction the wallet will be asked to sign. */
function wireSize(feePayer: PublicKey, instructions: TransactionInstruction[]): number {
  return toVersioned(feePayer, instructions).serialize().length;
}

export function planDeploy(spec: TokenSpec, rent: RentTable): DeployPlan {
  const { payer, recipient } = spec;
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;
  const recipientTokenAccount = getAssociatedTokenAddressSync(mint, recipient, true);
  const metadataAddress = spec.hasMetadata ? metadataAddressFor(mint) : null;

  // Steps are assembled as ordered units and then packed into as few
  // transactions as the 1232-byte packet limit allows.
  const units: { detail: string; instructions: TransactionInstruction[] }[] = [
    {
      detail: `Create mint ${mint.toBase58()}`,
      instructions: [
        SystemProgram.createAccount({
          fromPubkey: payer,
          newAccountPubkey: mint,
          lamports: rent.mint,
          space: MINT_SIZE,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMintInstruction(mint, spec.decimals, payer, payer),
      ],
    },
    {
      detail: `Mint the entire supply to ${recipient.toBase58()}`,
      instructions: [
        // Note the argument order: owner comes before mint.
        createAssociatedTokenAccountInstruction(
          payer,
          recipientTokenAccount,
          recipient,
          mint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
        createMintToInstruction(mint, recipientTokenAccount, payer, spec.supplyRaw),
      ],
    },
  ];

  // Metadata has to be written while the mint authority still exists, so this
  // unit must stay ahead of the revocations below.
  if (spec.hasMetadata && metadataAddress) {
    // Metaplex rejects a `uri` longer than 200 bytes.
    const uri = spec.uri.slice(0, 200);

    units.push({
      detail: "Write the name, symbol and logo into the metadata account",
      instructions: [
        createCreateMetadataAccountV3Instruction(
          {
            metadata: metadataAddress,
            mint,
            mintAuthority: payer,
            payer,
            updateAuthority: payer,
          },
          {
            createMetadataAccountArgsV3: {
              data: {
                name: spec.name,
                symbol: spec.symbol,
                uri,
                sellerFeeBasisPoints: spec.sellerFeeBasisPoints,
                creators: [{ address: payer, verified: false, share: 100 }],
                collection: null,
                uses: null,
              },
              // Left mutable so the instruction below can hand the update
              // authority to nobody, which is what makes the details permanent.
              isMutable: true,
              collectionDetails: null,
            },
          },
          TOKEN_METADATA_PROGRAM_ID,
        ),
      ],
    });

    if (spec.lockMetadata) {
      units.push({
        detail: "Revoke the metadata update authority — details become permanent",
        instructions: [
          createUpdateMetadataAccountV2Instruction(
            { metadata: metadataAddress, updateAuthority: payer },
            {
              updateMetadataAccountArgsV2: {
                data: null,
                updateAuthority: null,
                primarySaleHappened: null,
                isMutable: null,
              },
            },
            TOKEN_METADATA_PROGRAM_ID,
          ),
        ],
      });
    }
  }

  if (spec.revokeMint) {
    units.push({
      detail: "Revoke mint authority — supply is permanently fixed",
      instructions: [
        createSetAuthorityInstruction(mint, payer, AuthorityType.MintTokens, null),
      ],
    });
  }

  if (spec.revokeFreeze) {
    units.push({
      detail: "Revoke freeze authority — holders can never be blocked",
      instructions: [
        createSetAuthorityInstruction(mint, payer, AuthorityType.FreezeAccount, null),
      ],
    });
  }

  const packed: DeployStep[] = [];
  for (const unit of units) {
    const current = packed[packed.length - 1];
    const fits =
      current && wireSize(payer, [...current.instructions, ...unit.instructions]) <= WIRE_TARGET;

    if (fits && current) {
      current.instructions.push(...unit.instructions);
      current.details.push(unit.detail);
    } else {
      packed.push({ title: "", details: [unit.detail], instructions: [...unit.instructions] });
    }
  }

  for (const [index, step] of packed.entries()) {
    step.title =
      packed.length === 1
        ? "Create the token and send the entire supply"
        : `Part ${index + 1} of ${packed.length}`;
  }

  for (const step of packed) {
    const size = wireSize(payer, step.instructions);
    if (size > WIRE_LIMIT) {
      throw new Error(
        `That transaction would be ${size} bytes, over Solana's ${WIRE_LIMIT}-byte limit. ` +
          `Use a shorter metadata URL, or drop the seller fee, and try again.`,
      );
    }
  }

  return {
    mint,
    mintKeypair,
    recipientTokenAccount,
    metadataAddress,
    steps: packed,
    cost: estimateCost(rent, spec.hasMetadata, packed.length),
  };
}

/* -------------------------------------------------------------------------- */
/*  Simulation + submission                                                   */
/* -------------------------------------------------------------------------- */

export interface SimulationResult {
  ok: boolean;
  error?: string;
}

function describeFailure(err: unknown): string {
  if (typeof err === "object" && err !== null && "InstructionError" in err) {
    const tuple = (err as { InstructionError: [number | string, unknown] }).InstructionError;
    return `instruction ${String(tuple[0])} failed: ${JSON.stringify(tuple[1])}`;
  }
  if (typeof err === "object" && err !== null) return JSON.stringify(err);
  return String(err);
}

export async function simulate(
  connection: Connection,
  feePayer: PublicKey,
  instructions: TransactionInstruction[],
): Promise<SimulationResult> {
  try {
    const tx = toVersioned(feePayer, instructions);
    const sim = await connection.simulateTransaction(tx, {
      commitment: "processed",
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
    if (sim.value.err) {
      return { ok: false, error: describeFailure(sim.value.err) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface DeployCallbacks {
  connection: Connection;
  plan: DeployPlan;
  feePayer: PublicKey;
  send: (tx: VersionedTransaction, connection: Connection) => Promise<string>;
  confirm: (signature: string, blockhash: string, lastValidBlockHeight: number) => Promise<void>;
  onStep(index: number, step: DeployStep): void;
  onLog(index: number, text: string, kind: "ok" | "err" | "wait"): void;
}

/**
 * Walks the plan, simulating every step before asking the wallet to sign, so a
 * failure never costs the user a transaction fee.
 */
export async function executePlan(cb: DeployCallbacks): Promise<string[]> {
  const signatures: string[] = [];

  for (const [index, step] of cb.plan.steps.entries()) {
    cb.onStep(index, step);

    const dry = await simulate(cb.connection, cb.feePayer, step.instructions);
    if (!dry.ok) {
      cb.onLog(index, `Simulation failed: ${dry.error}`, "err");
      throw new Error(
        `Step ${index + 1} of ${cb.plan.steps.length} would fail on chain, so nothing was sent or paid for.\n\n${dry.error}`,
      );
    }
    cb.onLog(index, "Simulated successfully, no issues found", "ok");

    const { blockhash, lastValidBlockHeight } = await cb.connection.getLatestBlockhash("confirmed");
    // Same bytes as the simulated probe — only the blockhash is swapped in.
    const tx = toVersioned(cb.feePayer, step.instructions);
    tx.message.recentBlockhash = blockhash;
    // The mint account is a fresh keypair, and `create_account` demands its
    // signature. The connected wallet fills the other slot.
    tx.sign([cb.plan.mintKeypair]);

    cb.onLog(index, "Approve this in your wallet…", "wait");
    const signature = await cb.send(tx, cb.connection);
    signatures.push(signature);
    cb.onLog(index, "Broadcast to the network", "ok");

    await cb.confirm(signature, blockhash, lastValidBlockHeight);
    cb.onLog(index, "Confirmed on chain", "ok");
  }

  return signatures;
}

export function formatSol(lamports: number, digits = 4): string {
  return `${(lamports / LAMPORTS_PER_SOL).toFixed(digits)} SOL`;
}