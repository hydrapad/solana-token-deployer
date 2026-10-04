/** The standard Metaplex off-chain metadata document. */
export interface TokenMetadataJson {
  name: string;
  symbol: string;
  description: string;
  image: string;
  external_url?: string;
  twitter_username?: string;
  telegram?: string;
  website?: string;
  properties: {
    files: { uri: string; type: string; cdn: boolean }[];
    category: string;
  };
}

export interface MetadataInput {
  name: string;
  symbol: string;
  description: string;
  image: string;
  twitter: string;
  telegram: string;
  website: string;
}

/** Bare https/ipfs/arweave URI check — catches the obvious paste mistakes. */
export function isValidUrl(value: string): boolean {
  return /^(https?:\/\/|ipfs:\/\/|ar:\/\/)/i.test(value.trim());
}

export function isValidImageUrl(value: string): boolean {
  return isValidUrl(value) && /\.(png|jpe?g|gif|webp|svg|avif)(\?.*)?$/i.test(value.trim());
}

export function buildMetadataJson(input: MetadataInput): TokenMetadataJson {
  const json: TokenMetadataJson = {
    name: input.name.trim(),
    symbol: input.symbol.trim().toUpperCase(),
    description: input.description.trim(),
    image: input.image.trim(),
    properties: {
      files: input.image.trim()
        ? [{ uri: input.image.trim(), type: imageMimeType(input.image), cdn: false }]
        : [],
      category: "token",
    },
  };

  if (input.website.trim()) json.external_url = input.website.trim();

  // Twitter is stored as a bare handle, which is what aggregators expect.
  const handle = twitterHandle(input.twitter);
  if (handle) json.twitter_username = handle;
  if (input.telegram.trim()) json.telegram = input.telegram.trim();

  return json;
}

function imageMimeType(url: string): string {
  const ext = url.split("?")[0]!.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "svg") return "image/svg+xml";
  if (ext === "avif") return "image/avif";
  return "image/png";
}

export function twitterHandle(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  const match = raw.match(/^(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com)\/@?([A-Za-z0-9_]{1,15})\/?$/);
  if (match) return match[1]!;
  return /^[A-Za-z0-9_]{1,15}$/.test(raw) ? raw : null;
}

/* -------------------------------------------------------------------------- */
/*  Optional IPFS upload                                                      */
/* -------------------------------------------------------------------------- */

type Provider = "pinata" | "filebase" | "nftstorage";

function detectProvider(key: string): Provider {
  const trimmed = key.trim();
  // Pinata issues JWTs, which are base64url JSON and always start with `eyJ`.
  if (trimmed.startsWith("eyJ")) return "pinata";
  // Filebase keys look like a long `F...` hex string.
  if (/^F[0-9a-f]{20,}$/i.test(trimmed)) return "filebase";
  return "nftstorage";
}

async function pinToPinata(key: string, json: string): Promise<string> {
  const response = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${key.trim()}`,
    },
    body: JSON.stringify({
      pinataContent: { name: "token-metadata.json", text: json },
      pinataMetadata: { name: "token-metadata.json" },
    }),
  });

  const body = (await response.json().catch(() => null)) as
    | { IpfsHash?: string; error?: { message?: string } }
    | null;

  if (!response.ok || !body?.IpfsHash) {
    throw new Error(body?.error?.message ?? `Pinata returned ${response.status}.`);
  }
  return `ipfs://${body.IpfsHash}`;
}

async function pinToFilebase(key: string, json: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([json], { type: "application/json" }), "token-metadata.json");

  const response = await fetch("https://api.filebase.io/v1/ipfs", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.trim()}` },
    body: form,
  });

  const body = (await response.json().catch(() => null)) as
    | { hash?: string; Key?: string; errors?: { detail?: string }[] }
    | null;

  if (!response.ok || !body?.Key) {
    throw new Error(
      body?.errors?.[0]?.detail ?? body?.Key ?? `Filebase returned ${response.status}.`,
    );
  }
  return `ipfs://${body.Key}`;
}

async function pinToNftStorage(key: string, json: string): Promise<string> {
  const response = await fetch("https://api.nft.storage/upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${key.trim()}` },
    body: json,
  });

  const body = (await response.json().catch(() => null)) as { value?: { cid?: string }; error?: string } | null;

  if (!response.ok || !body?.value?.cid) {
    throw new Error(body?.error ?? `nft.storage returned ${response.status}.`);
  }
  return `ipfs://${body.value.cid}`;
}

export interface UploadResult {
  uri: string;
  httpsUri: string;
}

/**
 * Pins the metadata document. The provider is inferred from the shape of the
 * key, so the user only has to paste one credential.
 */
export async function uploadMetadata(key: string, json: string): Promise<UploadResult> {
  if (!key.trim()) throw new Error("No API key supplied.");

  const provider = detectProvider(key);
  const uri =
    provider === "pinata"
      ? await pinToPinata(key, json)
      : provider === "filebase"
        ? await pinToFilebase(key, json)
        : await pinToNftStorage(key, json);

  const cid = uri.replace(/^ipfs:\/\//, "");
  return {
    uri,
    httpsUri: provider === "filebase" ? `https://ipfs.filebase.io/ipfs/${cid}` : `https://ipfs.io/ipfs/${cid}`,
  };
}

export function suggestJsonFilename(symbol: string): string {
  const safe = (symbol || "token").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${safe || "token"}-metadata.json`;
}

/** Where people actually host a JSON file, spelled out for the UI. */
export const HOSTING_HINTS: { label: string; url: string }[] = [
  { label: "IPFS via Pinata", url: "https://app.pinata.cloud/keys" },
  { label: "IPFS via Filebase", url: "https://app.filebase.io/api-keys" },
  { label: "NFT.Storage", url: "https://nft.storage/login" },
  { label: "Arweave (bundles)", url: "https://arweave.net" },
];