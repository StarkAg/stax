# Chrome Web Store — submission checklist & copy

Everything you need to paste into the Web Store Developer Dashboard. Upload `build/stax-1.0.0.zip`
under **Package**, then fill the listing with the text below.

---

## Product details

**Name**
```
Stax — Easy Tab Manager
```

**Summary** (≤132 chars)
```
Triage 100+ tabs from one page. Auto-detect watched YouTube videos, save the rest, and catch duplicate tabs before they pile up.
```

**Category:** Productivity
**Language:** English

**Description** (paste into the detailed description box)
```
Drowning in 100+ YouTube tabs? Stax is the easy way to dig out.

Stax knows the difference between videos you still want to watch and ones you've already
finished — so you can clear the clutter in one click instead of scrolling forever.

▸ TRIAGE EVERYTHING FROM ONE PAGE
A full-page dashboard of every open tab across all your windows, grouped by site so 63 YouTube
tabs collapse into one row. Multi-select by checkbox or whole domain, then Save, Close, or
Save & Close.

▸ ALREADY-WATCHED DETECTION
Stax reads how far you've played each YouTube video and tags it "Watched" (90%+) or shows a live
progress percentage. Hit "Select watched" to grab every finished video at once and close them.
Progress updates live as videos play — no refresh.

▸ WATCHED HISTORY + REOPEN GUARD
Every video you finish is remembered. Try to reopen one and Stax warns you first — and if it's
still open in another tab, it offers to jump to that tab instead of making a duplicate.

▸ DUPLICATE-TAB CATCHER
Open a page that's already open somewhere else and Stax drops a banner: "Switch to it" or
"Keep this." Works on every site.

▸ QUICK POPUP + SAVED LISTS
One-tap Clear watched / Save all / Open dashboard from the toolbar. Bundle tabs into named,
reopenable lists. Instant search. Undo. Export to JSON.

PRIVACY: Everything stays on your device. No accounts, no servers, no tracking, no network
requests. Your data lives in local storage and never leaves your browser.
```

---

## Single purpose (required)
```
Stax manages the user's browser tabs: it lists, searches, groups, saves, and closes open tabs,
detects and tracks watched YouTube videos, and warns about duplicate tabs.
```

## Permission justifications (required)

**tabs**
```
Used to list the user's open tabs and their titles/URLs so they can search, group, save, switch
to, and close them — the core function of a tab manager.
```

**storage**
```
Used to store the user's saved tab lists and watched-video history locally on their device.
```

**scripting**
```
Used to read the play position of YouTube videos (to mark watched videos and show progress) and
to display the "already open in another tab" banner. No page content is collected or transmitted.
```

**host permission `<all_urls>`**
```
Required so the duplicate-tab banner can appear on any site the user opens, and so YouTube watch
progress can be read on youtube.com. Access is used only for these two features; Stax reads no
other page data and sends nothing off-device.
```

## Data usage disclosures (Privacy practices tab)
- Does this item collect personally identifiable information? **No**
- Health info? **No** · Financial info? **No** · Authentication info? **No**
- Personal communications? **No** · Location? **No** · Web history? **No** (only tab titles/URLs
  shown to the user locally; never transmitted)
- User activity / website content? **No** (not collected or sent)
- Certify: does **not** sell data, does **not** use data for unrelated purposes, does **not** use
  data for creditworthiness. **All three checked.**

**Privacy policy URL**
```
https://github.com/StarkAg/stax/blob/main/PRIVACY.md
```

---

## Assets (in `store/assets/`)
- `screenshot-1..4.png` — 1280×800, upload 1–5 of these as listing screenshots
- `promo-small-440x280.png` — Small promo tile
- `promo-marquee-1400x560.png` — Marquee promo tile
- Store icon: `icons/icon128.png` (128×128)

## Pre-submit checks
- [x] Manifest V3, valid, version 1.0.0
- [x] 128×128 icon present
- [x] No remote code / no minified obfuscation / all code bundled
- [x] At least one 1280×800 screenshot
- [x] Privacy policy URL reachable
- [ ] Pay the one-time $5 developer registration fee (if not already)
- [ ] Upload ZIP, fill listing, submit for review
```
