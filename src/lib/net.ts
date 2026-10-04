import { Connection } from "@solana/web3.js";

export type Cluster = "mainnet-beta" | "devnet" | "testnet";

export interface NetworkInfo {
  cluster: Cluster;
  label: string;
  isTestnet: boolean;
  /** Verified-working public endpoints, tried in order. */
  rpcs: string[];
  explorerTx: (sig: string) => string;
  explorerMint: (mint: string) => string;
  faucet?: string;
}

export const NETWORKS: Record<Cluster, NetworkInfo> = {
  "mainnet-beta": {
    cluster: "mainnet-beta",
    label: "Mainnet",
    isTestnet: false,
    // publicnode is listed first because it answers with `ACAO: *`, so it works
    // when this page is opened straight from disk and sends a null Origin.
    rpcs: [
      "https://solana-rpc.publicnode.com",
      "https://api.mainnet-beta.solana.com",
    ],
    explorerTx: (sig) => `https://solscan.io/tx/${sig}`,
    explorerMint: (mint) => `https://solscan.io/token/${mint}`,
  },
  devnet: {
    cluster: "devnet",
    label: "Devnet",
    isTestnet: true,
    rpcs: ["https://api.devnet.solana.com"],
    explorerTx: (sig) => `https://solscan.io/tx/${sig}?cluster=devnet`,
    explorerMint: (mint) => `https://solscan.io/token/${mint}?cluster=devnet`,
    faucet: "https://faucet.solana.com",
  },
  testnet: {
    cluster: "testnet",
    label: "Testnet",
    isTestnet: true,
    rpcs: ["https://solana-testnet-rpc.publicnode.com"],
    explorerTx: (sig) => `https://solscan.io/tx/${sig}?cluster=testnet`,
    explorerMint: (mint) => `https://solscan.io/token/${mint}?cluster=testnet`,
    faucet: "https://faucet.solana.com",
  },
};

let active: { key: string; connection: Connection; url: string } | null = null;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Returns a live Connection for the cluster, transparently failing over between
 * the public endpoints. A user-supplied RPC (Advanced panel) is always tried
 * first so dedicated nodes are never bypassed.
 */
export async function getConnection(
  cluster: Cluster,
  customRpc?: string,
): Promise<{ connection: Connection; url: string }> {
  const custom = customRpc?.trim();
  const key = `${cluster}|${custom ?? ""}`;

  if (active?.key === key) return { connection: active.connection, url: active.url };

  const candidates = custom ? [custom, ...NETWORKS[cluster].rpcs] : NETWORKS[cluster].rpcs;
  const failures: string[] = [];

  for (const url of candidates) {
    const connection = new Connection(url, {
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 60_000,
    });
    try {
      await withTimeout(connection.getSlot(), 8_000);
      active = { key, connection, url };
      return { connection, url };
    } catch (err) {
      failures.push(`${url} (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  throw new Error(
    `Could not reach a Solana RPC endpoint.\n${failures.join("\n")}\n` +
      `Check your internet connection, or paste your own RPC in the Advanced section.`,
  );
}

/**
 * localStorage throws when storage is blocked (private mode, or some file://
 * setups). Settings are a convenience, so failing to save must never break the app.
 */
export function saveLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — carry on without persistence */
  }
}

export function loadLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Testnet SOL is worthless — tell the user before they spend real money. */
export function describeCluster(cluster: Cluster): string {
  const net = NETWORKS[cluster];
  return net.isTestnet ? `${net.label} (test)` : `${net.label} (real SOL)`;
}