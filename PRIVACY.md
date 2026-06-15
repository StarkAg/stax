# Privacy Policy — Stax

_Last updated: June 2026_

Stax is a Chrome extension that helps you manage browser tabs. **Stax does not collect,
transmit, sell, or share any personal data.** It has no backend server, no analytics, and makes
no network requests of its own.

## What Stax stores, and where

All data Stax creates is stored **locally on your device** using Chrome's `storage.local` API.
It never leaves your browser. This includes:

- **Saved lists** — the tab titles and URLs you choose to save.
- **Watched history** — the IDs/titles/URLs of YouTube videos you've finished, so Stax can warn
  you before you reopen one.

You can delete this data at any time from within Stax (per-item removal, "Clear all", "Clear
history") or by removing the extension.

## What Stax accesses, and why

- **Tabs** (`tabs`) — to list your open tabs and their titles/URLs so you can search, group,
  save, switch to, or close them.
- **Storage** (`storage`) — to keep your saved lists and watched history on your device.
- **Scripting + YouTube host access** (`scripting`, `*://*.youtube.com/*`) — used for exactly two
  things:
  1. Reading the play position of YouTube videos (the `<video>` element's current time) to tag
     watched videos and show live progress.
  2. Showing the "already open in another tab" banner on a page that duplicates one you already
     have open.
- **Optional all-sites access** (`<all_urls>`, off by default) — only requested if you turn on
  "Enable on all sites" in the popup, which extends the duplicate-tab banner to non-YouTube
  sites. You can revoke it anytime. It is used solely for that banner and transmits nothing.

  Stax does not read page content, form data, passwords, or browsing history beyond the tab
  titles and URLs needed for the features above, and none of it is transmitted anywhere.

## Third parties

None. Stax integrates with no third-party services and ships no third-party tracking code. The
bundled fonts (Space Grotesk, JetBrains Mono, American Captain) are packaged locally and make no
network calls.

## Contact

Questions? Open an issue at https://github.com/StarkAg/stax/issues
