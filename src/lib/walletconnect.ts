/**
 * WalletConnect v2 for Solana, so people on a phone can connect without
 * installing a desktop extension.
 *
 * Deliberately a thin layer over `@walletconnect/universal-provider` rather than
 * the full Reown AppKit: AppKit ships its own UI and controller stack, and this
 * app already has a connect flow. All we need is the session transport, the
 * `solana_signTransaction` request shape, and a QR code.
 *
 * Protocol notes (WalletConnect v2, Solana namespace):
 *   - namespace key : `solana`
 *   - chain ids     : CAIP-2, `solana:<genesis hash>`
 *   - sign request  : { method: "solana_signTransaction",
 *                       params: { transaction: <base64>, pubkey: <address> } }
 *   - sign response : { transaction: <base64> } preferred,
 *                     { signature: <base58> } from older wallets
 */

import { PublicKey, VersionedTransaction, type Connection } from "@solana/web3.js";
import UniversalProvider from "@walletconnect/universal-provider";

import { base58Decode } from "./base58";
import { loadLocal, saveLocal } from "./net";

const PROJECT_ID_KEY = "sol-token-launcher:wc-project-id";

/** CAIP-2 genesis hashes for the Solana clusters. */
export const WC_CHAINS: Record<string, string> = {
  "mainnet-beta": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  devnet: "solana:8E9rvCKLFQia2Y35HXjjpWzj8weVo44K",
  testnet: "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
};

const WC_METHODS = ["solana_signTransaction", "solana_signAndSendTransaction", "solana_signMessage"];

export const WALLET_CONNECT_NAME = "WalletConnect";
export const WALLET_CONNECT_KEY = "walletconnect";

export function getProjectId(): string {
  return loadLocal(PROJECT_ID_KEY) ?? "";
}

export function setProjectId(value: string): void {
  const trimmed = value.trim();
  if (trimmed) saveLocal(PROJECT_ID_KEY, trimmed);
  else saveLocal(PROJECT_ID_KEY, "");
}

export function isWalletConnectConfigured(): boolean {
  return getProjectId().length > 0;
}

/**
 * WalletConnect errors must not be run through the Solana RPC error mapper — a
 * relay failure reads as "lost the connection to the Solana network", which
 * sends people debugging the wrong thing.
 */
export function friendlyWalletConnectError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  if (/user (rejected|declined|cancell?ed)|user closed/i.test(raw)) {
    return "Connection declined in your wallet.";
  }
  if (/401|403|unauthor|forbidden|project ?id/i.test(raw)) {
    return "WalletConnect rejected the project ID. Check the value in Advanced, or get a fresh one at cloud.reown.com.";
  }
  if (/relay|wss:|websocket|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(raw)) {
    return "Could not reach the WalletConnect relay. Check your connection, or try again in a moment.";
  }
  return `WalletConnect could not connect: ${raw}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked so we do not blow the argument limit on large payloads.
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** First address from a CAIP-10 account id such as `solana:mainnet:<addr>`. */
function firstAccount(namespaces: Record<string, { accounts?: string[] }> | undefined): {
  address: string;
  chainId: string;
} {
  const account = namespaces?.["solana"]?.accounts?.[0];
  if (!account) throw new Error("WalletConnect session returned no Solana account.");

  const parts = account.split(":");
  const address = parts[parts.length - 1] ?? "";
  if (!address) throw new Error("WalletConnect session returned a malformed account id.");
  return { address, chainId: `${parts[0]}:${parts[1]}` };
}

/** Exactly the shape `provider.connect()` expects, taken from its own types. */
type ConnectNamespaces = NonNullable<
  Parameters<UniversalProvider["connect"]>[0]["namespaces"]
>;

function namespacesFor(cluster: string): ConnectNamespaces {
  const preferred = WC_CHAINS[cluster] ?? WC_CHAINS["mainnet-beta"]!;
  return {
    solana: {
      chains: [preferred, ...Object.values(WC_CHAINS)],
      methods: WC_METHODS,
      events: [],
      rpcMap: {},
    },
  } as ConnectNamespaces;
}

/**
 * Waits for the pairing URI. UniversalProvider emits `display_uri` while pairing
 * and also mirrors it onto `provider.uri`, so listen for the event and poll as
 * a fallback in case the event fired before we subscribed.
 */
function awaitPairingUri(provider: UniversalProvider, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let poll: ReturnType<typeof setInterval> | undefined;

    const cleanup = (): void => {
      clearTimeout(timer);
      if (poll !== undefined) clearInterval(poll);
      provider.off?.("display_uri", onUri);
    };

    const onUri = (uri: string | undefined): void => {
      if (!uri) return;
      cleanup();
      resolve(uri);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          "No pairing code arrived. Check your WalletConnect project ID and that this " +
            "network allows the WalletConnect relay.",
        ),
      );
    }, timeoutMs);

    provider.on("display_uri", onUri);
    poll = setInterval(() => onUri(provider.uri), 150);
    onUri(provider.uri);
  });
}

export interface WalletConnectSession {
  address: string;
  publicKey: PublicKey;
  /** CAIP-2 chain id the session was established on, e.g. `solana:5eyk…`. */
  chainId: string;
  signAndSendTransaction(tx: VersionedTransaction, connection: Connection): Promise<string>;
  disconnect(): Promise<void>;
}

export interface ConnectHandlers {
  /** Fired with the `wc:` pairing URI as soon as it exists. */
  onUri(uri: string): void;
  /** Fired if the session ends or pairing fails. */
  onError(message: string): void;
}

/** Pairs with a mobile wallet; resolves once approved on the phone. */
export async function connectWalletConnect(
  cluster: string,
  handlers: ConnectHandlers,
): Promise<WalletConnectSession> {
  const projectId = getProjectId();
  if (!projectId) {
    throw new Error(
      "Add a free WalletConnect project ID in Advanced first — get one at https://cloud.reown.com.",
    );
  }

  const provider = await UniversalProvider.init({
    projectId,
    metadata: {
      name: "Solana Token Launcher",
      description: "Deploy an SPL token and send the entire supply to your wallet.",
      url: "https://github.com/hydrapad/solana-token-deployer",
      icons: [],
    },
  });

  const pairing = provider.connect({ namespaces: namespacesFor(cluster) });
  // Rejections are surfaced below; this stops an unhandled rejection while the
  // user is still looking at the QR code.
  void pairing.catch(() => {});

  const uri = await awaitPairingUri(provider, 20_000);
  handlers.onUri(uri);

  let namespaces: Record<string, { accounts?: string[] }>;
  try {
    namespaces = (await pairing)?.namespaces as typeof namespaces;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/user (rejected|declined|cancell?ed)|user closed/i.test(message)) {
      throw new Error("Connection declined in your wallet.");
    }
    throw new Error(`WalletConnect pairing failed: ${message}`);
  }

  const { address, chainId } = firstAccount(namespaces);
  const publicKey = new PublicKey(address);

  provider.on("session_delete", () => handlers.onError("The WalletConnect session ended."));

  const signLocally = async (tx: VersionedTransaction): Promise<Uint8Array> => {
    const result = (await provider.request(
      {
        method: "solana_signTransaction",
        params: { transaction: toBase64(tx.serialize()), pubkey: address },
      },
      chainId,
    )) as { transaction?: string; signature?: string } | undefined;

    if (result?.transaction) {
      return VersionedTransaction.deserialize(fromBase64(result.transaction)).serialize();
    }

    if (result?.signature) {
      // Older wallets return only the signature; graft it onto our own copy.
      const signed = VersionedTransaction.deserialize(tx.serialize());
      signed.addSignature(publicKey, base58Decode(result.signature));
      return signed.serialize();
    }

    throw new Error("Wallet returned an unrecognised signing response.");
  };

  return {
    address,
    publicKey,
    chainId,
    async signAndSendTransaction(tx, connection) {
      // Prefer the wallet broadcasting: it knows its own RPC and fee payer state.
      const sent = (await provider.request(
        {
          method: "solana_signAndSendTransaction",
          params: {
            transaction: toBase64(tx.serialize()),
            pubkey: address,
            sendOptions: { skipPreflight: true },
          },
        },
        chainId,
      )) as { signature?: string } | undefined;

      if (sent?.signature) return sent.signature;

      const raw = await signLocally(tx);
      return connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
    },
    async disconnect() {
      try {
        await provider.disconnect();
      } catch {
        /* the session may already be gone */
      }
    },
  };
}