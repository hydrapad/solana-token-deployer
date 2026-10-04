import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";

import { loadRent, planDeploy, simulate, type TokenSpec } from "../src/lib/deploy";

/** Every combination the UI can produce, run against the real cluster. */
const base: TokenSpec = {
  name: "Onchain Simulation Coin",
  symbol: "OSIM",
  decimals: 9,
  supplyRaw: 1_000_000_000n * 1_000_000_000n,
  recipient: new PublicKey(0),
  payer: new PublicKey(0),
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
};

const longUri = `ipfs://${"Qm".repeat(1)}${"a".repeat(58)}`;

const cases: { label: string; spec: (payer: PublicKey) => TokenSpec }[] = [
  { label: "plain token, both authorities revoked", spec: (p) => ({ ...base, payer: p, recipient: p }) },
  { label: "token keeping both authorities", spec: (p) => ({ ...base, payer: p, recipient: p, revokeMint: false, revokeFreeze: false }) },
  { label: "mint authority revoked, freeze kept", spec: (p) => ({ ...base, payer: p, recipient: p, revokeFreeze: false }) },
  { label: "0 decimals", spec: (p) => ({ ...base, payer: p, recipient: p, decimals: 0, supplyRaw: 4200n }) },
  { label: "1 decimal", spec: (p) => ({ ...base, payer: p, recipient: p, decimals: 1, supplyRaw: 100_000_000_000n }) },
  { label: "max name and symbol lengths", spec: (p) => ({ ...base, payer: p, recipient: p, name: "N".repeat(32), symbol: "S".repeat(10) }) },
  { label: "9_000_000_000 supply", spec: (p) => ({ ...base, payer: p, recipient: p, supplyRaw: 9_000_000_000n * 1_000_000_000n }) },
  {
    label: "metadata locked",
    spec: (p) => ({ ...base, payer: p, recipient: p, hasMetadata: true, uri: "https://example.com/token.json", lockMetadata: true }),
  },
  {
    label: "metadata editable",
    spec: (p) => ({ ...base, payer: p, recipient: p, hasMetadata: true, uri: "https://example.com/token.json", lockMetadata: false }),
  },
  {
    label: "metadata + seller fee 2.5%",
    spec: (p) => ({ ...base, payer: p, recipient: p, hasMetadata: true, uri: longUri, sellerFeeBasisPoints: 250, lockMetadata: true }),
  },
  {
    label: "metadata locked, authorities kept",
    spec: (p) => ({ ...base, payer: p, recipient: p, hasMetadata: true, uri: longUri, revokeMint: false, revokeFreeze: false }),
  },
  {
    label: "metadata, name/symbol at max length",
    spec: (p) => ({
      ...base, payer: p, recipient: p, hasMetadata: true, name: "N".repeat(32), symbol: "S".repeat(10),
      uri: longUri, lockMetadata: true,
    }),
  },
];

/**
 * Borrow a funded fee payer from recent transactions. Simulation ignores
 * signatures, so no private key is needed — only a balance.
 */
async function fundedPayer(connection: Connection): Promise<PublicKey | null> {
  const recent = await connection.getSignaturesForAddress(TOKEN_PROGRAM_ID, { limit: 12 });
  let best: { key: PublicKey; lamports: number } | null = null;

  for (const entry of recent ?? []) {
    if (!entry.signature) continue;
    const tx = await connection.getTransaction(entry.signature, { maxSupportedTransactionVersion: 1 });
    const message = tx?.transaction?.message as
      | { accountKeys?: ({ pubkey?: string } | string)[]; staticAccountKeys?: ({ pubkey?: string } | string)[] }
      | undefined;
    const head = (message?.accountKeys ?? message?.staticAccountKeys)?.[0] as unknown;
    const address =
      typeof head === "string"
        ? head
        : head instanceof PublicKey
          ? head.toBase58()
          : (head as { pubkey?: string } | undefined)?.pubkey;
    if (!address) continue;

    const key = new PublicKey(address);
    const lamports = await connection.getBalance(key);
    if (!best || lamports > best.lamports) best = { key, lamports };
    // Comfortably enough for mint + token + metadata rent and fees.
    if (lamports > 100_000_000) break;
  }

  return best?.key ?? null;
}

let failures = 0;
let checks = 0;

for (const [cluster, url] of [
  ["devnet", "https://api.devnet.solana.com"],
  ["mainnet-beta", "https://solana-rpc.publicnode.com"],
] as const) {
  const connection = new Connection(url, "confirmed");
  const payer = await fundedPayer(connection);
  const lamports = payer ? await connection.getBalance(payer) : 0;

  console.log(`\n${cluster}   payer ${payer?.toBase58().slice(0, 14) ?? "?"}…  ${(lamports / 1e9).toFixed(4)} SOL`);

  if (!payer || lamports < 100_000_000) {
    console.log("  skipped: no funded payer found\n");
    continue;
  }

  const rent = await loadRent(connection);
  console.log(
    `  live rent: mint ${rent.mint} · token ${rent.tokenAccount} · metadata ${rent.metadata}\n`,
  );

  for (const { label, spec } of cases) {
    const plan = planDeploy(spec(payer), rent);
    let ok = true;

    for (const [index, step] of plan.steps.entries()) {
      const result = await simulate(connection, payer, step.instructions);
      checks++;
      if (!result.ok) {
        ok = false;
        console.log(`  FAIL  ${label}  (step ${index + 1}/${plan.steps.length})`);
        console.log(`        ${result.error}`);
      }
    }

    if (ok) {
      const instructions = plan.steps.reduce((n, s) => n + s.instructions.length, 0);
      console.log(
        `  PASS  ${label.padEnd(38)} ${plan.steps.length} tx · ${instructions} instructions · ` +
          `${(plan.cost.total / 1e9).toFixed(4)} SOL`,
      );
    }
  }
  console.log("");
}

console.log(`${checks - failures}/${checks} live simulations passed\n`);
if (failures > 0) process.exitCode = 1;