# Solana Token Launcher

Deploy an SPL token on Solana from your browser. The **entire supply is minted
straight to the recipient's wallet** — there is no treasury, no dev fee, and no
second step where anything can go missing.

Ships as a single HTML file. Double-click it; no install, no build, no server.

**Live:** <https://hydrapad.github.io/solana-token-deployer/>

---

## Quick start

Either open the hosted app above, or download
[`dist/sol-token-launcher.html`](dist/sol-token-launcher.html) and double-click
it. Both run the same build; the hosted copy is rebuilt from this repository on
every push, so it always matches the source.

Then:

1. Click **Connect wallet** and approve in Phantom, Solflare, Backpack, OKX or
   any other Wallet Standard wallet.
2. Fill in the name, symbol and supply. Leave the three "Lock it down" boxes
   ticked.
3. Click **Deploy**. Approve the single transaction in your wallet.

The app starts on **Devnet**, where tokens are worthless and free test SOL is
available from [faucet.solana.com](https://faucet.solana.com). Try it there
first, then switch to **Mainnet**.

> Opening the file directly from disk works — everything is bundled inline. The
> only network calls are to public Solana RPC endpoints.

---

## What it does

| | |
|---|---|
| **Supply** | 100% minted to the recipient in the same transaction that creates the mint. No transfer step, so nothing can be intercepted. |
| **Mint authority** | Revoked by default. Supply is permanently fixed — nobody can print more. |
| **Freeze authority** | Revoked by default. No wallet can be frozen, so holders can always sell. |
| **Metadata** | Standard Metaplex JSON, so the token gets a logo, description and social links in Phantom, Solflare, Jupiter and Solscan. |
| **Safety** | Every transaction is **simulated before you sign it**. If it would fail on chain, nothing is sent and you pay no fee. |
| **Receipt** | A JSON receipt with the mint address, authorities and transaction links, downloadable after launch. |

### Connect from a phone

Browser extensions only help on desktop. To connect a mobile wallet, add a free
**WalletConnect project ID** in **Advanced → WalletConnect project ID**
([cloud.reown.com](https://cloud.reown.com)), and "WalletConnect (mobile)"
appears in the wallet list — scan the QR with Phantom, Solflare or any other
WalletConnect wallet.

The ID is stored only in that browser and sent nowhere except WalletConnect's
relay. Nothing is baked into the build, so the public repo and any fork work
without a key. WalletConnect is off until you provide one.

> Adding it grows the single file from ~1.08 MB to ~1.58 MB, because the
> protocol (relay, crypto, JSON-RPC) is around 500 KB on its own.

### About metadata

The token's **name and symbol are written on chain** and will display
everywhere. The **logo, description and social links live in a small JSON file
that Metaplex reads over the web**, so that part needs a URL.

The app has you covered three ways:

- **Generate JSON file** — writes the correct Metaplex JSON, with copy and
  download buttons. Host it anywhere and paste the link into
  *Metadata JSON URL*.
- **Upload it for me (IPFS)** — paste a free [Pinata](https://app.pinata.cloud/keys),
  [Filebase](https://app.filebase.io/api-keys) or [NFT.Storage](https://nft.storage)
  API key and the app pins the file and fills the URL in for you.
- **Leave it blank** — the token still launches, just without a logo.

---

## Settings that matter

**Decimals.** Most tokens use `9`. Use `0` if you want whole numbers only. The
supply you type is human-facing; the app converts it to base units exactly,
with no floating point.

**Seller fee.** Royalty percentage on secondary sales. `0` is right for almost
every token — a non-zero fee makes some markets and wallets treat the token
suspiciously.

**Custom RPC.** Free public endpoints are used by default and are rate limited.
For mainnet, paste a dedicated endpoint (Helius, QuickNode, Triton) into
**Advanced → RPC endpoint**. The app fails over between public endpoints on its
own.

---

## How it is put together

```
src/
  index.html        markup, inlined into the final file
  styles.css        styles, inlined into the final file
  main.ts           form state, validation, cost preview, deploy flow
  lib/
    deploy.ts       instruction building, packing, simulation, submission
    wallet.ts       Wallet Standard + legacy providers (Phantom/Solflare/Backpack)
    walletconnect.ts  optional WalletConnect v2 for mobile wallets
    net.ts          RPC failover, network definitions
    metadata.ts     Metaplex JSON generation, optional IPFS upload
    units.ts        supply <-> base units conversion
    base58.ts       signature encoding
    dom.ts          small DOM helpers
  shims/            browser shims for process/Buffer
test/
  plan.test.ts      offline checks on instruction encoding and sizes
  onchain.cases.ts  real simulations against live devnet + mainnet
  harness.mjs       builds a mock-RPC build for UI testing
.github/workflows/
  pages.yml         typecheck + test + build + deploy to GitHub Pages
```

`dist/` is not committed. Every push to `main` rebuilds the single file from
source, asserts it is still self-contained and intact, and publishes it to
<https://hydrapad.github.io/solana-token-deployer/>.

### Notes on the transaction

- The mint account is a freshly generated keypair. `system_program`'s
  `create_account` requires the new account to **sign**, so the app signs that
  locally and the wallet signs as fee payer. Missing this makes every deploy
  fail with a signature error.
- Metadata must be written **before** the mint authority is revoked, so the
  instruction order is: create → mint supply → metadata → revoke.
- Metaplex's `CreateMetadataAccountV2` has been **removed** from the on-chain
  program (error `0x4b`). This uses `CreateMetadataAccountV3`.
- The metadata PDA uses seeds `["metadata", <metadata program>, <mint>]`.
- Steps are packed into as few transactions as the 1232-byte packet limit
  allows — normally one.
- WalletConnect is a thin layer over `@walletconnect/universal-provider` rather
  than the full Reown AppKit: AppKit ships its own UI and controller stack. The
  `solana_signTransaction` request shape and CAIP-2 chain ids are pinned by
  tests, since a typo there makes pairing fail silently.

---

## Development

```bash
npm install
npm run check      # typecheck + offline tests + build
npm run build      # -> dist/sol-token-launcher.html
npm test           # offline: instruction encoding, sizes, supply maths
npm run test:live  # real simulations against devnet and mainnet
npm run serve      # http://localhost:4173
npm run watch      # rebuild on change
```

`npm run test:live` is the important one. It borrows a funded fee payer from a
recent transaction and runs `simulateTransaction` with `sigVerify: false`, so
it needs no private key and spends nothing — but it exercises the exact
instructions the browser would submit, against the real cluster.

UI testing without spending money:

```bash
npm run harness    # writes dist/__test.html
npm run serve      # open http://localhost:4173/__test.html
```

That build swaps in a mocked RPC and a mock wallet which records what it was
asked to sign.

---

## What has been verified

- 122 offline checks over instruction encoding, discriminators, account ordering,
  PDA derivation, signature slots, packet sizes, supply maths, base58 round-trips
  and the WalletConnect chain ids and QR rendering.
- 24 live simulations on **both devnet and mainnet**, covering every combination
  the form can produce: authority toggles, metadata on/off, metadata locked vs
  editable, seller fees, 0 and 1 and 9 decimals, maximum-length name and symbol,
  and large supplies.
- The full UI flow in a real browser: wallet discovery, validation, cost
  preview, simulation gating, wallet rejection, insufficient balance, network
  switching, and the success screen.

**Not verified:** the WalletConnect handshake itself — pairing a phone and the
`solana_signTransaction` round trip. That needs a real project ID and a real
wallet on a real phone. Everything around it is tested: the QR renders from a
realistic `wc:` URI, the option appears and disappears with the project ID,
pairing failures surface actionable messages, and cancel is clean. But treat
first contact with a phone as unproven.

## Limitations

- Deploying does not create liquidity. A token with no pool cannot be bought.
  Use [Pump.fun](https://pump.fun), Raydium or Meteora after launching.
- The free public RPCs are rate limited and occasionally slow. Use your own for
  mainnet.
- WalletConnect pairing and signing is untested against a real phone wallet. See
  above.
- Metadata hosting is manual unless you supply an IPFS API key — Metaplex needs
  a reachable URL for the JSON.
- This is a launcher, not an exchange or a market maker.

## A note on dependencies

The stack is `@solana/web3.js@1.99`, `@solana/spl-token@0.4.15` and
`@metaplex-foundation/mpl-token-metadata@2.13`. `npm audit` reports advisories
in that transitive tree (`bigint-buffer`, `stream-json`, `uuid`), and
`npm audit fix --force` wants to jump to `web3.js@3`, which is a breaking
rewrite.

That has been left as-is deliberately: the current combination is the one
verified against live devnet and mainnet, and none of the advisories are
reachable through this app's code paths — there are no websocket subscriptions,
`uuid` is never called with a caller-supplied buffer, and supply amounts are
range-checked against `u64` before they are encoded. Moving to the kit-based
stack is worth doing, but as its own piece of work with its own verification
pass.

## Disclaimer

Token creation is irreversible. Verify every field before you sign. Nobody
supporting this project can recover a mistyped name, send tokens to the wrong
address, or undo a launch. Never share your seed phrase.

## License

**AGPL-3.0-only.** See [`LICENSE`](LICENSE).

Anyone may use, study and modify this. If you run a modified version as a
network service, section 13 requires you to offer its source to your users —
which is why the built app carries a source link in its footer.