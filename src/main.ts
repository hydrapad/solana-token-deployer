import {
  LAMPORTS_PER_SOL,
  PublicKey,
  type Connection,
} from "@solana/web3.js";

import {
  $,
  $$,
  copyText,
  downloadFile,
  friendlyError,
  shorten,
  toast,
} from "./lib/dom";
import { formatAmount, parseSupply, describeSupplyProblem } from "./lib/units";
import {
  NETWORKS,
  getConnection,
  loadLocal,
  saveLocal,
  type Cluster,
} from "./lib/net";
import {
  connectWallet,
  listWallets,
  onWalletsChanged,
  type Session,
  type WalletOption,
} from "./lib/wallet";
import {
  executePlan,
  formatSol,
  loadRent,
  planDeploy,
  resetRentCache,
  type DeployPlan,
  type DeployStep,
  type RentTable,
  type TokenSpec,
} from "./lib/deploy";
import {
  HOSTING_HINTS,
  buildMetadataJson,
  isValidUrl,
  suggestJsonFilename,
  twitterHandle,
  uploadMetadata,
  type MetadataInput,
} from "./lib/metadata";

/* -------------------------------------------------------------------------- */
/*  State                                                                     */
/* -------------------------------------------------------------------------- */

const STORE_KEY = "sol-token-launcher:v1";

interface State {
  cluster: Cluster;
  session: Session | null;
  connection: Connection | null;
  rent: RentTable | null;
  busy: boolean;
  /** Fields the user has actually interacted with. */
  touched: Set<string>;
  /** True once Deploy has been pressed; reveals every error at once. */
  submitAttempted: boolean;
}

const state: State = {
  cluster: "devnet",
  session: null,
  connection: null,
  rent: null,
  busy: false,
  touched: new Set(),
  submitAttempted: false,
};

interface FieldSpec {
  id: keyof TokenSpec | string;
  max?: number;
  pattern?: RegExp;
  message: string;
}

interface ValidationResult {
  ok: boolean;
  errors: Record<string, string>;
  spec: TokenSpec | null;
  input: MetadataInput;
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

const SYMBOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-]{0,9}$/;

function recipientMode(): "self" | "custom" {
  const checked = $<HTMLInputElement>('input[name="recipientMode"]:checked');
  return checked?.value === "custom" ? "custom" : "self";
}

function validate(): ValidationResult {
  const errors: Record<string, string> = {};

  const name = $<HTMLInputElement>("#name").value.trim();
  const symbol = $<HTMLInputElement>("#symbol").value.trim().toUpperCase();
  const decimals = Number($<HTMLInputElement>("#decimals").value);
  const supply = $<HTMLInputElement>("#supply").value.trim();
  const image = $<HTMLInputElement>("#image").value.trim();
  const uri = $<HTMLInputElement>("#uri").value.trim();
  const description = $<HTMLInputElement>("#description").value.trim();
  const twitter = $<HTMLInputElement>("#twitter").value.trim();
  const telegram = $<HTMLInputElement>("#telegram").value.trim();
  const website = $<HTMLInputElement>("#website").value.trim();
  const sellerFee = Number($<HTMLInputElement>("#sellerFee").value || 0);

  const rules: FieldSpec[] = [
    { id: "name", max: 32, message: "Name is required and must be 32 characters or fewer." },
    {
      id: "symbol",
      max: 10,
      pattern: SYMBOL_PATTERN,
      message: "Symbol must be 1-10 letters, numbers, dots, dashes or underscores.",
    },
    { id: "description", max: 1000, message: "Description must be 1000 characters or fewer." },
  ];

  for (const rule of rules) {
    const value = String($<HTMLInputElement>(`#${rule.id}`).value).trim();
    if (rule.id !== "description" && !value) errors[rule.id] = rule.message;
    else if (rule.max && value.length > rule.max) errors[rule.id] = rule.message;
    else if (rule.pattern && !rule.pattern.test(value)) errors[rule.id] = rule.message;
  }

  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) {
    errors["decimals"] = "Decimals must be a whole number between 0 and 9.";
  }

  const supplyResult = parseSupply(supply, Number.isInteger(decimals) ? decimals : 0);
  const supplyRaw = supplyResult.ok ? supplyResult.baseUnits : null;
  if (!supplyResult.ok) errors["supply"] = describeSupplyProblem(supplyResult.problem);

  if (image && !isValidUrl(image)) errors["image"] = "Image must be an https, ipfs:// or ar:// URL.";
  if (uri && !isValidUrl(uri)) errors["uri"] = "Metadata URL must be an https, ipfs:// or ar:// URL.";
  else if (uri.length > 200) errors["uri"] = "Metadata URL must be 200 characters or fewer.";
  if (twitter && !twitterHandle(twitter)) errors["twitter"] = "That does not look like an X handle or link.";
  for (const [id, value] of [["telegram", telegram], ["website", website]] as const) {
    if (value && !isValidUrl(value)) errors[id] = "Must be an https URL.";
  }

  if (!Number.isFinite(sellerFee) || sellerFee < 0 || sellerFee > 10000) {
    errors["sellerFee"] = "Seller fee must be between 0 and 10000 (0-100%).";
  }

  const payer = state.session?.publicKey;
  const custom = $<HTMLInputElement>("#recipient").value.trim();
  let recipient: PublicKey | null = payer ?? null;

  if (recipientMode() === "custom") {
    try {
      recipient = new PublicKey(custom);
    } catch {
      errors["recipient"] = "Enter a valid Solana address.";
    }
  }

  const input: MetadataInput = { name, symbol, description, image, twitter, telegram, website };
  const spec: TokenSpec | null =
    payer && recipient && !Object.keys(errors).length && supplyRaw
      ? {
          name,
          symbol,
          decimals,
          supplyRaw,
          recipient,
          payer,
          uri,
          description,
          twitter,
          telegram,
          website,
          sellerFeeBasisPoints: Math.round(sellerFee),
          hasMetadata: Boolean(uri),
          revokeMint: $<HTMLInputElement>("#revokeMint").checked,
          revokeFreeze: $<HTMLInputElement>("#revokeFreeze").checked,
          lockMetadata: $<HTMLInputElement>("#lockMetadata").checked,
        }
      : null;

  return { ok: !Object.keys(errors).length, errors, spec, input };
}

/* -------------------------------------------------------------------------- */
/*  Form rendering                                                            */
/* -------------------------------------------------------------------------- */

function paintFieldErrors(errors: Record<string, string>): void {
  // Don't scold the user about fields they have not reached yet.
  const showAll = state.submitAttempted;
  const visible = (id: string): boolean => showAll || state.touched.has(id);

  for (const input of $$<HTMLInputElement | HTMLTextAreaElement>("#form input, #form textarea, #form select")) {
    const id = input.id;
    const message = visible(id) ? errors[id] : undefined;
    const field = input.closest(".field");
    input.classList.toggle("bad", Boolean(message));
    if (!field) continue;

    let hint = field.querySelector<HTMLElement>(".hint[data-error]");
    if (message) {
      if (!hint) {
        hint = document.createElement("small");
        hint.className = "hint";
        hint.dataset["error"] = "true";
        field.append(hint);
      }
      hint.textContent = message;
      hint.className = "hint warn";
    } else if (hint) {
      hint.remove();
    }
  }
}

function updateCounters(): void {
  const limits: Record<string, number> = { name: 32, symbol: 10, description: 1000 };
  for (const [id, max] of Object.entries(limits)) {
    const el = $(`[data-count="${id}"]`);
    const input = $<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
    if (input.value.length > max * 0.8) {
      el.textContent = `${input.value.length} / ${max}`;
      el.className = input.value.length > max ? "hint warn" : "hint";
    } else {
      el.textContent = "";
      el.className = "hint";
    }
  }
}

function updateSupplyHint(): void {
  const decimals = Number($<HTMLInputElement>("#decimals").value);
  const supply = $<HTMLInputElement>("#supply").value.trim();
  const hint = $("#supplyHint");

  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) {
    hint.textContent = "Decimals must be 0-9.";
    hint.className = "hint warn";
    return;
  }

  const parsed = parseSupply(supply, decimals);
  if (!parsed.ok) {
    if (parsed.problem === "overflow" || parsed.problem === "precision") {
      hint.textContent = describeSupplyProblem(parsed.problem);
      hint.className = "hint warn";
    } else {
      hint.textContent = "Whole units, no commas. 1000000 means one million tokens.";
      hint.className = "hint";
    }
    return;
  }

  hint.textContent = `${formatAmount(parsed.baseUnits, decimals)} tokens = ${parsed.baseUnits.toLocaleString()} base units on chain`;
  hint.className = "hint ok";
}

function updateDeployButton(errors: Record<string, string>): void {
  const button = $<HTMLButtonElement>("#deployBtn");
  const hint = $("#deployHint");

  if (state.busy) {
    button.disabled = true;
    button.textContent = "Working…";
    hint.textContent = "Follow the prompts in your wallet.";
    hint.className = "deploy-hint";
    return;
  }

  if (!state.session) {
    button.disabled = true;
    button.textContent = "Deploy token";
    hint.textContent = "Connect your wallet to get started.";
    hint.className = "deploy-hint";
    return;
  }

  button.disabled = Object.keys(errors).length > 0;
  button.textContent = `Deploy on ${NETWORKS[state.cluster].label}`;

  const count = Object.keys(errors).length;
  hint.textContent = count ? `${count} field${count > 1 ? "s" : ""} need attention above.` : "Ready when you are.";
  hint.className = count ? "deploy-hint bad" : "deploy-hint";
}

function renderSummary(validation: ValidationResult): void {
  const hasMetadata = Boolean(validation.spec?.uri) && Boolean(validation.spec);
  const rent = state.rent;

  $("#sumRaw").textContent = validation.spec ? validation.spec.supplyRaw.toLocaleString() : "—";
  $("#sumMeta").textContent = hasMetadata && rent ? formatSol(rent.metadata) : "not used";

  if (!rent) {
    $("#sumRent").textContent = "—";
    $("#sumFees").textContent = "—";
    $("#sumTotal").textContent = "—";
    return;
  }

  try {
    // Preflight the real plan so the transaction count shown is the real one.
    const plan = validation.spec ? planDeploy(validation.spec, rent) : null;
    const transactions = plan?.steps.length ?? (hasMetadata ? 2 : 1);

    $("#sumRent").textContent = formatSol(rent.mint + rent.tokenAccount);
    $("#sumFees").textContent = `${formatSol(transactions * 5_000)} (${transactions} tx)`;
    $("#sumTotal").textContent = formatSol(
      rent.mint + rent.tokenAccount + (hasMetadata ? rent.metadata : 0) + transactions * 5_000,
    );
  } catch {
    $("#sumRent").textContent = formatSol(rent.mint + rent.tokenAccount);
    $("#sumFees").textContent = "—";
    $("#sumTotal").textContent = "—";
  }
}

/* -------------------------------------------------------------------------- */
/*  Network + wallet                                                          */
/* -------------------------------------------------------------------------- */

function renderNetworkBanner(): void {
  const banner = $("#netBanner");
  const net = NETWORKS[state.cluster];
  banner.hidden = false;

  if (net.isTestnet) {
    banner.textContent = `You are on ${net.label}. Test tokens have no value — this is free to try.`;
  } else {
    banner.textContent = "You are on Mainnet. Deploying spends real SOL and cannot be undone.";
  }

  for (const button of $$<HTMLButtonElement>(".seg")) {
    button.classList.toggle("is-active", button.dataset["network"] === state.cluster);
  }
}

async function refreshCluster(): Promise<void> {
  resetRentCache();
  state.rent = null;
  renderNetworkBanner();

  if (!state.session) {
    renderSummary(validate());
    return;
  }

  try {
    const { connection } = await getConnection(state.cluster, rpcOverride());
    state.connection = connection;
    state.rent = await loadRent(connection);
    await refreshBalance();
  } catch (err) {
    toast(friendlyError(err), "err");
  }
  refreshForm();
}

function rpcOverride(): string | undefined {
  return $<HTMLInputElement>("#rpc").value.trim() || undefined;
}

async function refreshBalance(): Promise<void> {
  if (!state.session || !state.connection) return;
  try {
    const lamports = await state.connection.getBalance(state.session.publicKey, "confirmed");
    $("#walletBalance").textContent = formatSol(lamports);

    const low = Math.max(lamports / LAMPORTS_PER_SOL, 0.05);
    const note = $("#lowFundsNote");
    const needed = (state.rent?.mint ?? 0) + (state.rent?.tokenAccount ?? 0) + 20_000;

    if (lamports < needed) {
      note.hidden = false;
      note.innerHTML = NETWORKS[state.cluster].isTestnet
        ? `Not enough SOL for rent and fees. Get free test SOL at <a href="${NETWORKS[state.cluster].faucet}" target="_blank" rel="noopener">faucet.solana.com</a>.`
        : `This wallet holds ${formatSol(lamports)}, which is below the ~${formatSol(needed)} needed. Add SOL before deploying.`;
    } else if (lamports / LAMPORTS_PER_SOL < 0.1) {
      note.hidden = false;
      note.textContent = `Low balance: ${formatSol(low)} left. That is enough, but keep an eye on it.`;
    } else {
      note.hidden = true;
    }
  } catch {
    /* balance is a nicety; never block the UI on it */
  }
}

function renderWallet(): void {
  const card = $("#walletCard");
  const session = state.session;

  if (!session) {
    card.hidden = true;
    $("#connectLabel").textContent = "Connect wallet";
    $("#recipientSelf").textContent = "";
    return;
  }

  card.hidden = false;
  const address = session.publicKey.toBase58();
  $("#walletAddress").textContent = `${shorten(address, 10, 8)}  ·  ${session.name}`;
  $("#walletBalance").textContent = "…";
  $("#recipientSelf").textContent = shorten(address, 6, 6);
  $("#connectLabel").textContent = shorten(address, 4, 4);
}

function openWalletPicker(): void {
  const wallets = listWallets();
  const list = $<HTMLUListElement>("#walletList");
  const note = $("#walletModalNote");
  list.innerHTML = "";
  note.hidden = wallets.length > 0;

  for (const option of wallets) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wallet-btn";

    if (option.icon) {
      const img = document.createElement("img");
      img.src = option.icon;
      img.alt = "";
      button.append(img);
    } else {
      const placeholder = document.createElement("span");
      placeholder.className = "ph";
      placeholder.textContent = option.name.slice(0, 2).toUpperCase();
      button.append(placeholder);
    }

    const label = document.createElement("span");
    label.textContent = option.name;
    button.append(label);
    button.addEventListener("click", () => void connectTo(option));
    item.append(button);
    list.append(item);
  }

  $<HTMLDialogElement>("#walletModal").showModal();
}

async function connectTo(option: WalletOption): Promise<void> {
  $<HTMLDialogElement>("#walletModal").close();
  try {
    state.session = await connectWallet(option);
  } catch (err) {
    toast(friendlyError(err), "err");
    return;
  }

  state.session.onAccountChange((publicKey) => {
    if (!publicKey) {
      state.session = null;
      state.connection = null;
      renderWallet();
      refreshForm();
      toast("Wallet disconnected.");
    }
  });

  renderWallet();
  await refreshCluster();
  toast(`Connected ${option.name}`, "ok");
}

/* -------------------------------------------------------------------------- */
/*  Persistence                                                               */
/* -------------------------------------------------------------------------- */

const PERSISTED = [
  "name", "symbol", "decimals", "supply", "image", "uri", "description",
  "twitter", "telegram", "website", "revokeMint", "revokeFreeze",
  "lockMetadata", "sellerFee", "recipientMode",
] as const;

function saveSettings(): void {
  if (!$<HTMLInputElement>("#remember").checked) {
    saveLocal(STORE_KEY, "");
    return;
  }
  const data: Record<string, string> = { cluster: state.cluster, rpc: rpcOverride() ?? "" };
  for (const id of PERSISTED) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) data[id] = el.type === "checkbox" ? String(el.checked) : el.value;
  }
  data["recipientMode"] = recipientMode();

  const custom = $<HTMLInputElement>("#recipient").value.trim();
  if (custom) data["recipient"] = custom;

  saveLocal(STORE_KEY, JSON.stringify(data));
}

function loadSettings(): void {
  const raw = loadLocal(STORE_KEY);
  if (!raw) return;

  let data: Record<string, string>;
  try {
    data = JSON.parse(raw) as Record<string, string>;
  } catch {
    return;
  }

  if (data["cluster"] && data["cluster"] in NETWORKS) {
    state.cluster = data["cluster"] as Cluster;
  }
  if (data["rpc"]) $<HTMLInputElement>("#rpc").value = data["rpc"];

  for (const id of PERSISTED) {
    if (data[id] === undefined) continue;
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) continue;
    if (el.type === "checkbox") el.checked = data[id] === "true";
    else if (id === "recipientMode") continue;
    else el.value = data[id]!;
  }

  if (data["recipient"]) $<HTMLInputElement>("#recipient").value = data["recipient"]!;
  if (data["recipientMode"]) {
    const radio = $<HTMLInputElement>(
      `input[name="recipientMode"][value="${data["recipientMode"]}"]`,
    );
    if (radio) radio.checked = true;
  }
}

/* -------------------------------------------------------------------------- */
/*  Progress + success                                                        */
/* -------------------------------------------------------------------------- */

function beginProgress(total: number): void {
  const card = $("#progressCard");
  card.classList.remove("hidden");
  $("#form").classList.add("hidden");
  $("#successCard").classList.add("hidden");
  $("#retryBtn").classList.add("hidden");
  $("#log").innerHTML = "";
  $("#progressStep").textContent = "0";
  $("#progressTitle").textContent = total > 1 ? `Step 1 of ${total}` : "Deploying";
  card.scrollIntoView({ behavior: "smooth", block: "start" });
}

function logStep(index: number, step: DeployStep): void {
  $("#progressStep").textContent = String(index + 1);
  $("#progressTitle").textContent = `Step ${index + 1} of ${deployStepTotal()}`;

  const list = $<HTMLUListElement>("#log");
  const item = document.createElement("li");
  item.dataset["step"] = String(index);

  const heading = document.createElement("strong");
  heading.textContent = step.title;
  item.append(icon(), text(heading));
  list.append(item);

  for (const detail of step.details) {
    const row = document.createElement("li");
    row.append(icon("·"), text(detail));
    list.append(row);
  }
}

function icon(char = "›"): HTMLElement {
  const el = document.createElement("span");
  el.className = "ico";
  el.textContent = char;
  return el;
}

function text(value: string | HTMLElement): HTMLElement {
  const el = document.createElement("span");
  el.append(value);
  return el;
}

function logLine(_index: number, message: string, kind: "ok" | "err" | "wait"): void {
  const list = $<HTMLUListElement>("#log");
  const row = document.createElement("li");
  row.className = kind;
  const glyph = kind === "ok" ? "✓" : kind === "err" ? "✕" : "…";
  row.append(icon(glyph), text(message));
  list.append(row);
  row.scrollIntoView({ block: "nearest" });
}

function addTxLink(signature: string): void {
  const net = NETWORKS[state.cluster];
  const list = $<HTMLUListElement>("#log");
  const row = document.createElement("li");
  row.className = "ok";

  const link = document.createElement("a");
  link.className = "txlink";
  link.href = net.explorerTx(signature);
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = `View ${shorten(signature, 6, 6)} on Solscan`;

  row.append(icon("↗"), text(link));
  list.append(row);
}

let stepTotal = 1;
function deployStepTotal(): number {
  return stepTotal;
}

function failProgress(message: string): void {
  const list = $<HTMLUListElement>("#log");
  const row = document.createElement("li");
  row.className = "err";
  row.append(icon("✕"), text(message));
  list.append(row);
  row.scrollIntoView({ block: "nearest" });
  $<HTMLButtonElement>("#retryBtn").classList.remove("hidden");
}

function renderNextSteps(spec: TokenSpec, plan: DeployPlan): void {
  const net = NETWORKS[state.cluster];
  const list = $("#nextSteps");
  list.innerHTML = "";

  const steps: string[] = [];

  if (net.isTestnet) {
    steps.push(
      `This is a test token and has no value. Get free devnet SOL at <a href="${net.faucet}" target="_blank" rel="noopener">faucet.solana.com</a>, then launch again on Mainnet.`,
    );
  } else {
    steps.push(
      `Add liquidity so people can buy it: <a href="https://pump.fun" target="_blank" rel="noopener">Pump.fun</a>, Raydium or Meteora.`,
    );
  }

  if (!spec.hasMetadata) {
    steps.push("No metadata URL was set, so the token shows without a logo or description.");
  }

  steps.push(
    `Post the contract address on X and Telegram. Never share a seed phrase — anyone with it can drain the wallet.`,
  );

  if (plan.metadataAddress) {
    steps.push(
      `Metadata address <code class="mono">${shorten(plan.metadataAddress.toBase58(), 8, 6)}</code>${
        spec.lockMetadata ? " is locked permanently." : " stays editable in case you need to fix a typo."
      }`,
    );
  }

  for (const html of steps) {
    const item = document.createElement("li");
    item.innerHTML = html;
    list.append(item);
  }
}

interface Receipt {
  deployedAt: string;
  network: Cluster;
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  supply: string;
  supplyBaseUnits: string;
  recipient: string;
  recipientTokenAccount: string;
  metadata: { address: string | null; uri: string; locked: boolean } | null;
  authorities: { mint: string; freeze: string; metadataUpdate: string };
  transactions: string[];
  explorer: { mint: string; transactions: string[] };
  costSol: number;
}

function showSuccess(spec: TokenSpec, plan: DeployPlan, signatures: string[]): void {
  const net = NETWORKS[state.cluster];
  const mint = plan.mint.toBase58();

  $("#progressCard").classList.add("hidden");
  $("#successCard").classList.remove("hidden");
  $("#successSub").textContent = `${spec.name} (${spec.symbol}) is live and the entire supply sits with ${
    spec.recipient.toBase58() === spec.payer.toBase58() ? "your wallet" : spec.recipient.toBase58()
  }.`;

  $("#mintAddress").textContent = mint;
  $("#recipientAddress").textContent = spec.recipient.toBase58();
  $("#holdingAmount").textContent = `${formatAmount(spec.supplyRaw, spec.decimals)} ${spec.symbol} (100%)`;

  $<HTMLAnchorElement>("#explorerLink").href = net.explorerMint(mint);
  const pump = $<HTMLAnchorElement>("#pumpLink");
  if (net.isTestnet) {
    pump.hidden = true;
  } else {
    pump.hidden = false;
    pump.href = `https://pump.fun/${mint}`;
  }

  renderNextSteps(spec, plan);

  const receipt: Receipt = {
    deployedAt: new Date().toISOString(),
    network: state.cluster,
    mint,
    name: spec.name,
    symbol: spec.symbol,
    decimals: spec.decimals,
    supply: formatAmount(spec.supplyRaw, spec.decimals),
    supplyBaseUnits: spec.supplyRaw.toString(),
    recipient: spec.recipient.toBase58(),
    recipientTokenAccount: plan.recipientTokenAccount.toBase58(),
    metadata: spec.hasMetadata
      ? {
          address: plan.metadataAddress?.toBase58() ?? null,
          uri: spec.uri,
          locked: spec.lockMetadata,
        }
      : null,
    authorities: {
      mint: spec.revokeMint ? "REVOKED (supply is fixed)" : "RETAINED by creator",
      freeze: spec.revokeFreeze ? "REVOKED (no account can be frozen)" : "RETAINED by creator",
      metadataUpdate: spec.lockMetadata ? "REVOKED (metadata is permanent)" : "RETAINED by creator",
    },
    transactions: signatures,
    explorer: { mint: net.explorerMint(mint), transactions: signatures.map(net.explorerTx) },
    costSol: plan.cost.total / LAMPORTS_PER_SOL,
  };

  state.busy = false;
  updateDeployButton(validate().errors);
  saveSettings();

  $<HTMLButtonElement>("#downloadBtn").onclick = () =>
    downloadFile(`${spec.symbol.toLowerCase()}-launch-receipt.json`, JSON.stringify(receipt, null, 2));

  $("#successCard").scrollIntoView({ behavior: "smooth", block: "start" });
  toast("Token deployed", "ok");
}

/* -------------------------------------------------------------------------- */
/*  Deploy                                                                    */
/* -------------------------------------------------------------------------- */

async function resolveMetadataUri(input: MetadataInput, manualUri: string): Promise<string> {
  const wantsUpload = $<HTMLInputElement>("#autoUpload").checked;
  const key = $<HTMLInputElement>("#ipfsKey").value.trim();

  if (!wantsUpload || !key || manualUri) return manualUri;

  const note = $("#uploadNote");
  note.className = "note note-plain";
  note.textContent = "Uploading metadata to IPFS…";
  const json = JSON.stringify(buildMetadataJson(input), null, 2);
  const { uri, httpsUri } = await uploadMetadata(key, json);

  $<HTMLInputElement>("#uri").value = uri;
  note.className = "note note-plain ok";
  note.textContent = `Pinned at ${httpsUri}`;
  state.touched.add("uri");
  setTimeout(() => {
    note.textContent = "";
  }, 8000);

  refreshForm();
  return uri;
}

async function deploy(event: Event): Promise<void> {
  event.preventDefault();
  if (state.busy) return;

  const validation = validate();
  state.submitAttempted = true;
  paintFieldErrors(validation.errors);
  saveSettings();

  if (!state.session) {
    openWalletPicker();
    toast("Connect a wallet first.");
    return;
  }
  if (!validation.ok || !validation.spec) {
    toast("Fix the highlighted fields first.");
    return;
  }

  state.busy = true;
  updateDeployButton(validation.errors);
  beginProgress(1);

  try {
    const uri = await resolveMetadataUri(validation.input, validation.spec.uri);
    const spec: TokenSpec = { ...validation.spec, uri };

    const { connection } = await getConnection(state.cluster, rpcOverride());
    state.connection = connection;
    const rent = state.rent ?? (state.rent = await loadRent(connection));

    const plan = planDeploy(spec, rent);
    stepTotal = plan.steps.length;

    const balance = await connection.getBalance(spec.payer, "confirmed");
    if (balance < plan.cost.total) {
      throw new Error(
        `Your wallet holds ${formatSol(balance)} but the deploy needs about ${formatSol(plan.cost.total)}.` +
          (NETWORKS[state.cluster].isTestnet
            ? ` Get free test SOL at ${NETWORKS[state.cluster].faucet}.`
            : " Add SOL and try again."),
      );
    }

    const signatures = await executePlan({
      connection,
      plan,
      feePayer: spec.payer,
      send: (tx, conn) => state.session!.sendTransaction(tx, conn),
      confirm: async (signature, blockhash, lastValidBlockHeight) => {
        const result = await connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          "confirmed",
        );
        if (result.value.err) {
          throw new Error(`Confirmed but failed on chain: ${JSON.stringify(result.value.err)}`);
        }
        addTxLink(signature);
      },
      onStep: logStep,
      onLog: logLine,
    });

    showSuccess(spec, plan, signatures);
  } catch (err) {
    state.busy = false;
    failProgress(friendlyError(err));
    updateDeployButton(validate().errors);
  }
}

/* -------------------------------------------------------------------------- */
/*  Metadata JSON dialog                                                      */
/* -------------------------------------------------------------------------- */

function openJsonDialog(): void {
  const { input } = validate();
  const json = JSON.stringify(buildMetadataJson(input), null, 2);

  $("#jsonPreview").textContent = json;
  $("#jsonModalLede").innerHTML =
    `This is what wallets read for your logo, description and links. Upload the file to IPFS, ` +
    `Arweave or any web host, then paste the resulting link into <strong>Metadata JSON URL</strong>. ` +
    `Free IPFS keys: ` +
    HOSTING_HINTS.map((h) => `<a href="${h.url}" target="_blank" rel="noopener">${h.label}</a>`).join(" · ");

  $<HTMLDialogElement>("#jsonModal").showModal();

  $("#copyJsonBtn").onclick = () => void copyText(json).then(() => toast("JSON copied", "ok"));
  $("#downloadJsonBtn").onclick = () =>
    downloadFile(suggestJsonFilename(input.symbol), json);
}

/* -------------------------------------------------------------------------- */
/*  Boot                                                                      */
/* -------------------------------------------------------------------------- */

function refreshForm(): void {
  const validation = validate();
  paintFieldErrors(validation.errors);
  updateCounters();
  updateSupplyHint();
  updateDeployButton(validation.errors);
  renderSummary(validation);
}

function wire(): void {
  $("#form").addEventListener("submit", (e) => void deploy(e));
  $("#connectBtn").addEventListener("click", openWalletPicker);

  for (const button of $$<HTMLButtonElement>(".seg")) {
    button.addEventListener("click", () => {
      const next = button.dataset["network"] as Cluster;
      if (next === state.cluster) return;
      state.cluster = next;
      void refreshCluster();
      refreshForm();
      saveSettings();
    });
  }

  const form = $("#form");
  form.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement;
    if (target.id) state.touched.add(target.id);
    refreshForm();
    saveSettings();
  });
  form.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement;
    if (target.id) state.touched.add(target.id);
    refreshForm();
    saveSettings();
  });

  for (const radio of $$<HTMLInputElement>('input[name="recipientMode"]')) {
    radio.addEventListener("change", () => {
      $("#customRecipientField").hidden = recipientMode() !== "custom";
      refreshForm();
    });
  }

  $("#autoUpload").addEventListener("change", (e) => {
    const on = (e.target as HTMLInputElement).checked;
    $("#ipfsKey").hidden = !on;
    $("#uploadNote").textContent = "";
  });

  $("#jsonBtn").addEventListener("click", openJsonDialog);

  for (const button of $$<HTMLButtonElement>("[data-copy]")) {
    button.addEventListener("click", () => {
      const value = $(button.dataset["copy"]!).textContent ?? "";
      void copyText(value.trim()).then(() => toast("Copied to clipboard", "ok"));
    });
  }

  $("#retryBtn").addEventListener("click", () => {
    $("#progressCard").classList.add("hidden");
    $("#form").classList.remove("hidden");
    state.busy = false;
    refreshForm();
  });

  $("#againBtn").addEventListener("click", () => {
    $("#successCard").classList.add("hidden");
    $("#progressCard").classList.add("hidden");
    $("#form").classList.remove("hidden");
    $<HTMLInputElement>("#name").value = "";
    $<HTMLInputElement>("#symbol").value = "";
    $<HTMLInputElement>("#uri").value = "";
    refreshForm();
  });

  onWalletsChanged(() => {
    if (!state.session) renderNetworkBanner();
  });
}

function boot(): void {
  loadSettings();
  wire();
  renderNetworkBanner();
  $("#customRecipientField").hidden = recipientMode() !== "custom";
  $<HTMLInputElement>("#ipfsKey").hidden = !$<HTMLInputElement>("#autoUpload").checked;
  renderWallet();
  refreshForm();
  void refreshCluster();
}

boot();