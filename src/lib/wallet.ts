import {
  Connection,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { base58Encode } from "./base58";

/* -------------------------------------------------------------------------- */
/*  Wallet Standard (Phantom, Solflare, Backpack, OKX, Coinbase, ...)          */
/*  https://github.com/anza-xyz/wallet-standard                                */
/* -------------------------------------------------------------------------- */

/** Structural view of a Wallet Standard wallet — avoids taking the dependency. */
interface StandardWallet {
  readonly name?: string;
  readonly icon?: string;
  getFeatures(): Record<string, unknown>;
}

interface WalletRegistry {
  get(): StandardWallet[];
  on?(event: "register", handler: (w: StandardWallet) => void): void;
}

type Feature = Record<string, (...args: never[]) => Promise<unknown>>;

function standardRegistry(): WalletRegistry | null {
  const wallets = (globalThis.navigator as unknown as { wallets?: WalletRegistry })?.wallets;
  return wallets && typeof wallets.get === "function" ? wallets : null;
}

function readStandardWallets(): StandardWallet[] {
  try {
    return standardRegistry()?.get() ?? [];
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*  Legacy injected providers (window.phantom.solana / solflare / backpack)     */
/* -------------------------------------------------------------------------- */

interface LegacyProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBackpack?: boolean;
  publicKey?: PublicKey | null;
  connect(): Promise<{ publicKey: PublicKey }>;
  signTransaction<T>(tx: T): Promise<T>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  disconnect?(): Promise<void>;
}

function legacyProviders(): { id: string; name: string; provider: LegacyProvider }[] {
  const win = globalThis as unknown as Record<string, LegacyProvider | undefined>;
  const found: { id: string; name: string; provider: LegacyProvider }[] = [];

  const phantom = win["phantom"]?.isPhantom ? win["phantom"] : undefined;
  if (phantom) found.push({ id: "phantom", name: "Phantom", provider: phantom });

  const solflare = win["solflare"]?.isSolflare ? win["solflare"] : undefined;
  if (solflare) found.push({ id: "solflare", name: "Solflare", provider: solflare });

  const backpack = win["backpack"]?.isBackpack ? win["backpack"] : undefined;
  if (backpack) found.push({ id: "backpack", name: "Backpack", provider: backpack });

  return found;
}

/* -------------------------------------------------------------------------- */

export interface WalletOption {
  key: string;
  name: string;
  icon?: string;
  /** Wallet Standard wallets get the richer feature set. */
  standard: boolean;
  standardWallet?: StandardWallet;
  legacyProvider?: LegacyProvider;
}

export interface Session {
  key: string;
  name: string;
  publicKey: PublicKey;
  /** Hand a transaction to the wallet for approval, then broadcast it. */
  sendTransaction(tx: VersionedTransaction, connection: Connection): Promise<string>;
  /** Fires with null when the user disconnects or switches account. */
  onAccountChange(cb: (publicKey: PublicKey | null) => void): void;
  disconnect(): Promise<void>;
}

/** Wallet Standard wallets first, then any legacy-only providers. */
export function listWallets(): WalletOption[] {
  const options: WalletOption[] = [];
  const seen = new Set<string>();

  readStandardWallets().forEach((wallet, i) => {
    const name = wallet.name?.trim() || `Wallet ${i + 1}`;
    seen.add(name.toLowerCase());
    options.push({ key: `standard:${name}:${i}`, name, icon: wallet.icon, standard: true, standardWallet: wallet });
  });

  for (const { id, name, provider } of legacyProviders()) {
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    options.push({ key: `legacy:${id}`, name, standard: false, legacyProvider: provider });
  }

  return options;
}

/** Keep the picker fresh when an extension finishes loading in the background. */
export function onWalletsChanged(cb: () => void): void {
  const registry = standardRegistry();
  registry?.on?.("register", () => cb());
  globalThis.addEventListener?.("load", () => cb());
}

/**
 * Solana features live under the `solana` namespace in Wallet Standard, e.g.
 * `features.solana["solana:signTransaction"]`. Some wallets also expose them at
 * the top level, so check both.
 */
function solanaFeature(wallet: StandardWallet, name: string): Feature | undefined {
  const features = wallet.getFeatures() as Record<string, unknown>;
  const nested = features["solana"] as Record<string, Feature | undefined> | undefined;
  return nested?.[name] ?? (features[name] as Feature | undefined);
}

function requireSolanaFeature(wallet: StandardWallet, name: string): Feature {
  const feature = solanaFeature(wallet, name);
  if (!feature) {
    throw new Error(
      `${wallet.name ?? "This wallet"} cannot sign Solana transactions: it exposes neither ` +
        `solana:${name} nor ${name}.`,
    );
  }
  return feature;
}

async function connectStandard(option: WalletOption): Promise<Session> {
  const wallet = option.standardWallet!;
  const connect = wallet.getFeatures()["standard:connect"] as
    | { connect(): Promise<{ accounts: { address: string }[] }> }
    | undefined;

  let accounts: { address: string }[];
  if (connect) {
    accounts = (await connect.connect()).accounts;
  } else {
    // Some wallets publish features but expose accounts only after the legacy handshake.
    const legacy = option.legacyProvider;
    const { publicKey } = legacy ? await legacy.connect() : { publicKey: null as never };
    if (!publicKey) throw new Error(`${option.name} did not return an account.`);
    accounts = [{ address: publicKey.toBase58() }];
  }

  const address = accounts?.[0]?.address;
  if (!address) throw new Error(`${option.name} did not return an account.`);
  const publicKey = new PublicKey(address);

  const listeners: ((publicKey: PublicKey | null) => void)[] = [];
  const emit = (next: PublicKey | null) => {
    const sameAccount = next !== null && next.toBase58() === publicKey.toBase58();
    for (const cb of listeners) cb(sameAccount ? publicKey : next);
  };

  const events = wallet.getFeatures()["standard:events"] as
    | { on(event: "change" | "disconnect", cb: (payload: unknown) => void): () => void }
    | undefined;
  events?.on("change", (payload) => {
    const changed = (payload as { accounts?: { address: string }[] })?.accounts?.[0]?.address;
    emit(changed ? new PublicKey(changed) : null);
  });
  events?.on("disconnect", () => emit(null));

  return {
    key: option.key,
    name: option.name,
    publicKey,
    onAccountChange: (cb) => listeners.push(cb),
    async sendTransaction(tx, connection) {
      const signAndSend = solanaFeature(wallet, "solana:signAndSendTransaction") as unknown as
        | {
            signAndSendTransaction(input: {
              transaction: VersionedTransaction;
              options?: { skipSimulation?: boolean; maxRetries?: number };
            }): Promise<{ signature: Uint8Array }>;
          }
        | undefined;

      if (signAndSend) {
        const { signature } = await signAndSend.signAndSendTransaction({
          transaction: tx,
          // We already simulated this exact payload a moment ago.
          options: { skipSimulation: true, maxRetries: 3 },
        });
        return base58Encode(signature);
      }

      const signOnly = requireSolanaFeature(wallet, "solana:signTransaction") as unknown as {
        signTransaction(input: { transaction: VersionedTransaction }): Promise<
          { signedTransaction: Uint8Array | VersionedTransaction }[]
        >;
      };
      const [signed] = await signOnly.signTransaction({ transaction: tx });
      const signedTx = signed!.signedTransaction;
      const raw =
        signedTx instanceof VersionedTransaction ? signedTx.serialize() : new Uint8Array(signedTx);
      return connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
    },
    disconnect: async () => {},
  };
}

async function connectLegacy(option: WalletOption): Promise<Session> {
  const provider = option.legacyProvider!;
  const { publicKey: raw } = await provider.connect();

  // Providers are inconsistent: some hand back a PublicKey, some a base58 string.
  const address = typeof raw === "string" ? raw : raw.toBase58();
  const publicKey = new PublicKey(address);

  const listeners: ((publicKey: PublicKey | null) => void)[] = [];
  provider.on?.("accountsChanged", (account) => {
    const next = typeof account === "string" && account ? new PublicKey(account) : null;
    const sameAccount = next !== null && next.toBase58() === publicKey.toBase58();
    for (const cb of listeners) cb(sameAccount ? publicKey : next);
  });
  provider.on?.("disconnect", () => {
    for (const cb of listeners) cb(null);
  });

  return {
    key: option.key,
    name: option.name,
    publicKey,
    onAccountChange: (cb) => listeners.push(cb),
    async sendTransaction(tx, connection) {
      const signed = await provider.signTransaction(tx);
      return connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
    },
    disconnect: async () => {
      await provider.disconnect?.();
    },
  };
}

export async function connectWallet(option: WalletOption): Promise<Session> {
  try {
    return option.standard ? await connectStandard(option) : await connectLegacy(option);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/user rejected|declined|cancell?ed/i.test(message)) {
      throw new Error("Connection cancelled in your wallet.");
    }
    throw new Error(message);
  }
}