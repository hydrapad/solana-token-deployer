/** Tiny helpers so the wiring code stays readable. No framework needed. */

export function $<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

export function $$<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

export type ToastKind = "info" | "ok" | "err";

export function toast(message: string, kind: ToastKind = "info", ms = 5200): void {
  const host = $("#toastHost");
  const el = document.createElement("div");
  el.className = `toast ${kind === "info" ? "" : kind}`;
  el.textContent = message;
  host.append(el);
  setTimeout(() => {
    el.style.transition = "opacity .3s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 320);
  }, ms);
}

/** 9WzD…c4Tb — enough to recognise an address without wrapping the layout. */
export function shorten(address: string, lead = 4, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

export function downloadFile(filename: string, contents: string, mime = "application/json"): void {
  const url = URL.createObjectURL(new Blob([contents], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // clipboard API needs a secure context; fall back to the old way
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

/** Turn a wallet/RPC error into something a person can act on. */
export function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/user rejected|declined|cancell?ed by the user/i.test(raw)) {
    return "You rejected the request in your wallet. Nothing was changed on chain.";
  }
  if (/blockhash not found|BlockhashNotFound|expired/i.test(raw)) {
    return "The transaction expired before it landed. Your token may not have been created — check your mint address before retrying.";
  }
  if (/fetch failed|network|Failed to fetch|ECONNREFUSED/i.test(raw)) {
    return "Lost the connection to the Solana network. Check your internet and try again.";
  }
  if (/429|Too Many Requests/i.test(raw)) {
    return "The public RPC is rate limiting you. Add your own endpoint in Advanced for a smoother deploy.";
  }
  if (/InsufficientFunds|insufficient funds|0x1\b/i.test(raw)) {
    return "Not enough SOL in the connected wallet to cover rent and fees.";
  }
  return raw;
}