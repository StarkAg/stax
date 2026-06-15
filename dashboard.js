"use strict";

const DASHBOARD_URL = chrome.runtime.getURL("dashboard.html");
const FALLBACK_FAVICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="%239aa3b2" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>'
  );

const state = {
  view: "open",
  tabs: [],
  collections: [],
  selected: new Set(), // open-tab ids
  query: "",
  grouped: true,
  collapsed: new Set(), // collapsed domain groups
};

let lastClosed = null; // for Undo

const WATCHED_THRESHOLD = 0.9; // ≥90% played counts as "watched"
state.progress = new Map(); // tabId -> fraction watched (0..1) or null if unknown
state.watchedHistory = []; // [{ id, title, url, favIconUrl, watchedAt }] — finished videos

/* ---------- helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function hostOf(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    return h || "other";
  } catch {
    return url?.startsWith("chrome") ? "chrome" : "other";
  }
}

function faviconFor(tab) {
  return tab.favIconUrl && tab.favIconUrl.startsWith("http")
    ? tab.favIconUrl
    : FALLBACK_FAVICON;
}

function matches(tab, q) {
  if (!q) return true;
  const s = (tab.title + " " + tab.url).toLowerCase();
  return s.includes(q);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ---------- data ---------- */
async function loadTabs() {
  const tabs = await chrome.tabs.query({});
  state.tabs = tabs.filter((t) => t.url !== DASHBOARD_URL);
  // drop selections / progress for tabs that no longer exist
  const ids = new Set(state.tabs.map((t) => t.id));
  state.selected = new Set([...state.selected].filter((id) => ids.has(id)));
  for (const id of state.progress.keys()) if (!ids.has(id)) state.progress.delete(id);
}

function isYouTube(tab) {
  return !!tab.url && tab.url.includes("youtube.com");
}

function watchedFraction(tab) {
  const p = state.progress.get(tab.id);
  return typeof p === "number" ? p : null;
}

function isWatched(tab) {
  const p = watchedFraction(tab);
  return p != null && p >= WATCHED_THRESHOLD;
}

function watchedTabs() {
  return state.tabs.filter(isWatched);
}

// Read each YouTube video's play position by injecting into the page.
// Skips discarded tabs so we never force-reload your pile to scan it.
async function scanWatched() {
  const targets = state.tabs.filter((t) => isYouTube(t) && !t.discarded);
  let added = false;
  await Promise.allSettled(
    targets.map(async (t) => {
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: t.id },
          func: staxProbe, // returns current fraction AND installs a live reporter (once)
        });
        const frac = res && typeof res.result === "number" ? res.result : null;
        state.progress.set(t.id, frac);
        if (frac != null && frac >= WATCHED_THRESHOLD && recordWatched(t)) added = true;
      } catch {
        state.progress.set(t.id, null); // discarded / restricted / not loaded
      }
    })
  );
  if (added) await saveWatchedHistory();
}

// Injected into each YouTube tab. Returns the current played fraction for the
// initial paint, and (once per tab) wires media events so the tab pushes live
// progress to the dashboard via chrome.runtime.sendMessage as the video plays.
// Must be fully self-contained — it runs in the page's isolated world.
function staxProbe() {
  const cur = () => {
    const v = document.querySelector("video");
    return v && v.duration && isFinite(v.duration) && v.duration > 0
      ? v.currentTime / v.duration
      : null;
  };
  if (!window.__staxProbe) {
    window.__staxProbe = true;
    let last = 0;
    const send = () => {
      try {
        // callback reads lastError to silence "no receiver" noise when the
        // dashboard tab isn't open
        chrome.runtime.sendMessage({ type: "stax-progress", frac: cur() }, () => {
          void chrome.runtime.lastError;
        });
      } catch (e) {
        /* extension context invalidated — ignore */
      }
    };
    // media events don't bubble, so listen in the capture phase
    document.addEventListener(
      "timeupdate",
      (e) => {
        if (e.target && e.target.tagName === "VIDEO") {
          const now = Date.now();
          if (now - last > 1000) { last = now; send(); } // throttle to ~1/s
        }
      },
      true
    );
    ["play", "pause", "seeked", "ended", "loadedmetadata", "emptied"].forEach((ev) =>
      document.addEventListener(
        ev,
        (e) => { if (e.target && e.target.tagName === "VIDEO") send(); },
        true
      )
    );
  }
  return cur();
}

async function loadCollections() {
  const { collections = [] } = await chrome.storage.local.get("collections");
  state.collections = collections;
}

async function saveCollections() {
  await chrome.storage.local.set({ collections: state.collections });
}

/* ---------- watched history ---------- */
// Stable id for a YouTube video so we recognise it across tabs/sessions.
function ytId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return "yt:" + u.pathname.slice(1);
    if (u.pathname.startsWith("/shorts/")) return "yt:" + (u.pathname.split("/")[2] || u.pathname);
    const v = u.searchParams.get("v");
    if (v) return "yt:" + v;
  } catch {
    /* fall through */
  }
  return null; // not a recognisable YouTube video
}

function isWatchedUrl(url) {
  const id = ytId(url);
  return !!id && state.watchedHistory.some((w) => w.id === id);
}

async function loadWatchedHistory() {
  const { watchedHistory = [] } = await chrome.storage.local.get("watchedHistory");
  state.watchedHistory = watchedHistory;
}

async function saveWatchedHistory() {
  await chrome.storage.local.set({ watchedHistory: state.watchedHistory });
}

// Record a finished video (dedupe by video id). Returns true if newly added.
function recordWatched(tab) {
  const id = ytId(tab.url);
  if (!id) return false;
  if (state.watchedHistory.some((w) => w.id === id)) return false;
  state.watchedHistory.unshift({
    id,
    title: tab.title || tab.url,
    url: tab.url,
    favIconUrl: tab.favIconUrl && tab.favIconUrl.startsWith("http") ? tab.favIconUrl : "",
    watchedAt: Date.now(),
  });
  return true;
}

/* ---------- rendering: open tabs ---------- */
function visibleTabs() {
  return state.tabs.filter((t) => matches(t, state.query));
}

function renderOpen() {
  const list = $("#tab-list");
  list.innerHTML = "";
  const tabs = visibleTabs();

  $("#open-empty").classList.toggle("hidden", tabs.length > 0 || state.tabs.length === 0);

  if (state.grouped) {
    const groups = new Map();
    for (const t of tabs) {
      const h = hostOf(t.url);
      if (!groups.has(h)) groups.set(h, []);
      groups.get(h).push(t);
    }
    // biggest groups first — that's where the YouTube pile lives
    const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [host, items] of sorted) list.appendChild(renderGroup(host, items));
  } else {
    const group = el("div", "group");
    const body = el("div", "group-body");
    for (const t of tabs) body.appendChild(renderRow(t));
    group.appendChild(body);
    list.appendChild(group);
  }
  updateActionBar();
}

function renderGroup(host, items) {
  const group = el("div", "group");
  if (state.collapsed.has(host)) group.classList.add("collapsed");

  const head = el("div", "group-head");
  const allSelected = items.every((t) => state.selected.has(t.id));

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = allSelected;
  cb.addEventListener("click", (e) => {
    e.stopPropagation();
    for (const t of items) {
      if (cb.checked) state.selected.add(t.id);
      else state.selected.delete(t.id);
    }
    renderOpen();
  });

  const fav = el("img", "favicon");
  fav.src = faviconFor(items[0]);
  fav.onerror = () => (fav.src = FALLBACK_FAVICON);

  head.appendChild(cb);
  head.appendChild(fav);
  head.appendChild(el("span", "domain", host));
  head.appendChild(el("span", "count", `${items.length} tab${items.length > 1 ? "s" : ""}`));
  head.appendChild(el("span", "chevron", "▾"));
  head.addEventListener("click", () => {
    if (state.collapsed.has(host)) state.collapsed.delete(host);
    else state.collapsed.add(host);
    group.classList.toggle("collapsed");
  });

  const body = el("div", "group-body");
  for (const t of items) body.appendChild(renderRow(t));

  group.appendChild(head);
  group.appendChild(body);
  return group;
}

function renderRow(tab) {
  const row = el("div", "row");
  if (state.selected.has(tab.id)) row.classList.add("selected");

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = state.selected.has(tab.id);
  cb.addEventListener("change", () => {
    if (cb.checked) state.selected.add(tab.id);
    else state.selected.delete(tab.id);
    row.classList.toggle("selected", cb.checked);
    updateActionBar();
    syncGroupHeads();
  });

  const fav = el("img", "favicon");
  fav.src = faviconFor(tab);
  fav.onerror = () => (fav.src = FALLBACK_FAVICON);

  const meta = el("div", "meta");
  meta.appendChild(el("div", "title", tab.title || tab.url));
  meta.appendChild(el("div", "url", tab.url));
  meta.title = "Switch to this tab";
  meta.addEventListener("click", () => switchToTab(tab));

  const actions = el("div", "row-actions");
  const closeBtn = el("button", "icon-btn close", "✕");
  closeBtn.title = "Close tab";
  closeBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await chrome.tabs.remove(tab.id);
  });
  actions.appendChild(closeBtn);

  row.appendChild(cb);
  row.appendChild(fav);
  row.appendChild(meta);
  row.appendChild(actions);

  row.dataset.tabId = tab.id;
  row._tab = tab;
  applyRowIndicators(row, tab); // watched pill + progress bar
  return row;
}

// (Re)build the watched pill + progress bar on a row from current progress data.
// Safe to call repeatedly — used both at render time and for live updates.
function applyRowIndicators(row, tab) {
  row.querySelector(".pill")?.remove();
  row.querySelector(".meta .progress")?.remove();
  row.classList.remove("is-watched");

  const frac = watchedFraction(tab);
  if (!isYouTube(tab) || frac == null) return;

  const pct = Math.round(frac * 100);
  const pill = el("span", "pill " + (frac >= WATCHED_THRESHOLD ? "watched" : "partial"));
  pill.textContent = frac >= WATCHED_THRESHOLD ? "✓ Watched" : `${pct}%`;
  pill.title = `${pct}% played`;
  row.insertBefore(pill, row.querySelector(".row-actions"));
  if (frac >= WATCHED_THRESHOLD) row.classList.add("is-watched");

  const bar = el("div", "progress");
  const fill = el("div", "progress-fill");
  fill.style.width = `${Math.max(3, pct)}%`;
  bar.appendChild(fill);
  row.querySelector(".meta").appendChild(bar);
}

function syncGroupHeads() {
  // keep group-head checkboxes in sync without full re-render
  if (state.grouped) renderOpen();
}

async function switchToTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

/* ---------- action bar ---------- */
function updateActionBar() {
  const n = state.selected.size;
  const visible = visibleTabs();
  $("#open-count").textContent = state.tabs.length;
  $("#saved-count").textContent = state.collections.reduce((a, c) => a + c.links.length, 0);
  $("#watched-count").textContent = state.watchedHistory.length;

  $("#selection-label").textContent = n ? `${n} selected` : "Select all";
  $("#save-close-selected").disabled = n === 0;
  $("#save-selected").disabled = n === 0;
  $("#close-selected").disabled = n === 0;
  $("#save-close-selected").textContent = n ? `Save & Close (${n})` : "Save & Close";

  const wn = watchedTabs().length;
  const wbtn = $("#select-watched");
  wbtn.disabled = wn === 0;
  wbtn.textContent = wn ? `✓ Select watched (${wn})` : "✓ Select watched";

  const allVisibleSelected = visible.length > 0 && visible.every((t) => state.selected.has(t.id));
  const someSelected = visible.some((t) => state.selected.has(t.id));
  const selAll = $("#select-all");
  selAll.checked = allVisibleSelected;
  selAll.indeterminate = someSelected && !allVisibleSelected;
}

/* ---------- save / close actions ---------- */
function selectedTabs() {
  return state.tabs.filter((t) => state.selected.has(t.id));
}

function makeCollection(tabs, name) {
  return {
    id: uid(),
    name: name || defaultName(),
    createdAt: Date.now(),
    links: tabs.map((t) => ({
      title: t.title || t.url,
      url: t.url,
      favIconUrl: t.favIconUrl && t.favIconUrl.startsWith("http") ? t.favIconUrl : "",
    })),
  };
}

function defaultName() {
  const d = new Date();
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) +
    " · " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

async function saveSelected(close) {
  const tabs = selectedTabs();
  if (!tabs.length) return;
  const col = makeCollection(tabs);
  state.collections.unshift(col);
  await saveCollections();

  if (close) {
    const ids = tabs.map((t) => t.id);
    await chrome.tabs.remove(ids);
    lastClosed = col;
    showToast(`Saved & closed ${tabs.length} tab${tabs.length > 1 ? "s" : ""}`, true);
  } else {
    showToast(`Saved ${tabs.length} tab${tabs.length > 1 ? "s" : ""}`, false);
  }
  state.selected.clear();
  await refresh();
}

async function closeSelected() {
  const ids = [...state.selected];
  if (!ids.length) return;
  await chrome.tabs.remove(ids);
  state.selected.clear();
  showToast(`Closed ${ids.length} tab${ids.length > 1 ? "s" : ""}`, false);
}

/* ---------- rendering: saved ---------- */
function renderSaved() {
  const wrap = $("#collections");
  wrap.innerHTML = "";
  const q = state.query;

  const cols = state.collections
    .map((c) => ({ ...c, links: c.links.filter((l) => matches(l, q)) }))
    .filter((c) => c.links.length > 0 || !q);

  $("#saved-empty").classList.toggle("hidden", state.collections.length > 0);
  const total = state.collections.reduce((a, c) => a + c.links.length, 0);
  $("#saved-summary").textContent = state.collections.length
    ? `${state.collections.length} list${state.collections.length > 1 ? "s" : ""} · ${total} links`
    : "No saved lists yet.";

  for (const col of cols) wrap.appendChild(renderCollection(col));
  updateActionBar();
}

function renderCollection(col) {
  const node = el("div", "collection");

  const head = el("div", "collection-head");
  const name = document.createElement("input");
  name.className = "name";
  name.value = col.name;
  name.title = "Click to rename";
  name.addEventListener("change", async () => {
    const real = state.collections.find((c) => c.id === col.id);
    if (real) { real.name = name.value.trim() || defaultName(); await saveCollections(); }
  });

  const when = el("span", "when", `${col.links.length} links · ${new Date(col.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`);

  const actions = el("div", "actions");
  const openAll = el("button", "btn primary", "Open all");
  openAll.addEventListener("click", () => guardedOpen(col.links, false));
  const openWin = el("button", "btn", "Open in new window");
  openWin.addEventListener("click", () => guardedOpen(col.links, true));
  const del = el("button", "btn ghost danger", "Delete");
  del.addEventListener("click", () => deleteCollection(col.id));
  actions.append(openAll, openWin, del);

  head.append(name, when, actions);
  node.appendChild(head);

  const body = el("div", "collection-body");
  for (const link of col.links) body.appendChild(renderSavedRow(col.id, link));
  node.appendChild(body);
  return node;
}

function renderSavedRow(colId, link) {
  const row = el("div", "saved-row");
  const fav = el("img", "favicon");
  fav.src = link.favIconUrl || FALLBACK_FAVICON;
  fav.onerror = () => (fav.src = FALLBACK_FAVICON);

  const a = document.createElement("a");
  a.href = link.url;
  a.addEventListener("click", (e) => {
    e.preventDefault();
    guardedOpen([link]);
  });
  a.appendChild(el("div", "s-title", link.title || link.url));
  a.appendChild(el("div", "s-url", link.url));

  const sActions = el("div", "s-actions");
  const copy = el("button", "icon-btn", "⧉");
  copy.title = "Copy link";
  copy.addEventListener("click", (e) => {
    e.preventDefault();
    navigator.clipboard.writeText(link.url);
    showToast("Link copied", false);
  });
  const rm = el("button", "icon-btn close", "✕");
  rm.title = "Remove from list";
  rm.addEventListener("click", (e) => {
    e.preventDefault();
    removeLink(colId, link.url);
  });
  sActions.append(copy, rm);

  row.append(fav, a, sActions);
  return row;
}

async function openLinks(links) {
  for (const l of links) await chrome.tabs.create({ url: l.url, active: false });
  showToast(`Opened ${links.length} tabs`, false);
}

async function openLinksWindow(links) {
  if (!links.length) return;
  const win = await chrome.windows.create({ url: links[0].url, focused: true });
  for (const l of links.slice(1)) await chrome.tabs.create({ windowId: win.id, url: l.url, active: false });
}

// Find currently-open tabs showing the same video (excludes the dashboard).
async function openTabsForVideo(url) {
  const id = ytId(url);
  if (!id) return [];
  const all = await chrome.tabs.query({});
  return all.filter((t) => t.url && t.url !== DASHBOARD_URL && ytId(t.url) === id);
}

// Open links, but warn first if any are already-watched videos.
async function guardedOpen(links, newWindow = false) {
  if (links.length === 1 && isWatchedUrl(links[0].url)) {
    return guardedOpenSingle(links[0], newWindow);
  }
  const watched = links.filter((l) => isWatchedUrl(l.url));
  if (watched.length) {
    const buttons = [{ label: "Cancel", value: "cancel", kind: "ghost" }];
    if (links.length > watched.length) buttons.push({ label: "Open unwatched only", value: "unwatched" });
    buttons.push({ label: "Open all anyway", value: "all", kind: "danger" });
    const choice = await showConfirm({
      title: "Already watched",
      message: `${watched.length} of these ${links.length} videos you've already finished. Reopen anyway?`,
      buttons,
    });
    if (choice !== "all" && choice !== "unwatched") return;
    if (choice === "unwatched") links = links.filter((l) => !isWatchedUrl(l.url));
  }
  if (!links.length) return;
  if (newWindow) await openLinksWindow(links);
  else await openLinks(links);
}

// A single already-watched video. If it's still open somewhere, offer to close
// that tab instead of opening a duplicate.
async function guardedOpenSingle(link, newWindow) {
  const existing = await openTabsForVideo(link.url);
  const buttons = [{ label: "Cancel", value: "cancel", kind: "ghost" }];
  let message;
  if (existing.length) {
    const where = existing.length > 1 ? `${existing.length} other tabs` : "another tab";
    message = `You already watched this — and it's still open in ${where}. Close ${existing.length > 1 ? "them" : "it"} instead of reopening?`;
    buttons.push({ label: "Open anyway", value: "open" });
    buttons.push({ label: existing.length > 1 ? `Close those ${existing.length} tabs` : "Close the open tab", value: "close", kind: "danger" });
  } else {
    message = `You already finished this video${watchedWhen(link)}. Reopen it anyway?`;
    buttons.push({ label: "Open anyway", value: "open", kind: "danger" });
  }

  const choice = await showConfirm({ title: "Already watched", message, buttons });
  if (choice === "close") {
    await chrome.tabs.remove(existing.map((t) => t.id));
    showToast(`Closed ${existing.length} watched tab${existing.length > 1 ? "s" : ""}`, false);
    await refresh();
  } else if (choice === "open") {
    if (newWindow) await openLinksWindow([link]);
    else await openLinks([link]);
  }
}

function watchedWhen(link) {
  const w = state.watchedHistory.find((x) => x.id === ytId(link.url));
  return w ? " on " + new Date(w.watchedAt).toLocaleDateString([], { month: "short", day: "numeric" }) : "";
}

/* ---------- confirm / warning modal ---------- */
function showConfirm({ title, message, icon = "⚠", buttons }) {
  return new Promise((resolve) => {
    const modal = $("#modal");
    $("#modal-title").textContent = title;
    $("#modal-msg").textContent = message;
    $("#modal-icon").textContent = icon;
    const actions = $("#modal-actions");
    actions.innerHTML = "";
    let settled = false;
    const close = (val) => {
      if (settled) return;
      settled = true;
      modal.classList.add("hidden");
      document.removeEventListener("keydown", onKey);
      modal.removeEventListener("click", onBackdrop);
      resolve(val);
    };
    for (const b of buttons) {
      const btn = el("button", "btn" + (b.kind ? " " + b.kind : ""), b.label);
      btn.addEventListener("click", () => close(b.value));
      actions.appendChild(btn);
    }
    const onKey = (e) => { if (e.key === "Escape") close(null); };
    const onBackdrop = (e) => { if (e.target === modal) close(null); };
    document.addEventListener("keydown", onKey);
    modal.addEventListener("click", onBackdrop);
    modal.classList.remove("hidden");
  });
}

/* ---------- rendering: watched history ---------- */
function renderWatched() {
  const wrap = $("#watched-list");
  wrap.innerHTML = "";
  const items = state.watchedHistory.filter((l) => matches(l, state.query));

  const has = state.watchedHistory.length > 0;
  $("#watched-empty").classList.toggle("hidden", has);
  $("#watched-note").classList.toggle("hidden", !has);
  $("#watched-summary").textContent = has
    ? `${state.watchedHistory.length} finished video${state.watchedHistory.length > 1 ? "s" : ""}`
    : "No watched videos yet.";

  if (items.length) {
    const col = el("div", "collection");
    const body = el("div", "collection-body");
    for (const link of items) body.appendChild(renderWatchedRow(link));
    col.appendChild(body);
    wrap.appendChild(col);
  }
  updateActionBar();
}

function renderWatchedRow(link) {
  const row = el("div", "saved-row");
  const fav = el("img", "favicon");
  fav.src = link.favIconUrl || FALLBACK_FAVICON;
  fav.onerror = () => (fav.src = FALLBACK_FAVICON);

  const a = document.createElement("a");
  a.href = link.url;
  a.addEventListener("click", (e) => {
    e.preventDefault();
    guardedOpen([link]);
  });
  a.appendChild(el("div", "s-title", link.title || link.url));
  a.appendChild(
    el("div", "s-url", `watched ${new Date(link.watchedAt).toLocaleDateString([], { month: "short", day: "numeric" })} · ${link.url}`)
  );

  const lock = el("span", "pill watched", "✓ watched");

  const sActions = el("div", "s-actions");
  const rm = el("button", "icon-btn close", "✕");
  rm.title = "Forget this video (re-opening won't warn anymore)";
  rm.addEventListener("click", (e) => {
    e.preventDefault();
    forgetWatched(link.id);
  });
  sActions.append(rm);

  row.append(fav, a, lock, sActions);
  return row;
}

async function forgetWatched(id) {
  state.watchedHistory = state.watchedHistory.filter((w) => w.id !== id);
  await saveWatchedHistory();
  renderWatched();
}

async function clearWatchedHistory() {
  if (!state.watchedHistory.length) return;
  if (!confirm("Forget ALL watched videos? Re-opening them won't warn you anymore.")) return;
  state.watchedHistory = [];
  await saveWatchedHistory();
  renderWatched();
}

async function deleteCollection(id) {
  state.collections = state.collections.filter((c) => c.id !== id);
  await saveCollections();
  renderSaved();
  updateActionBar();
}

async function removeLink(colId, url) {
  const col = state.collections.find((c) => c.id === colId);
  if (!col) return;
  col.links = col.links.filter((l) => l.url !== url);
  if (!col.links.length) state.collections = state.collections.filter((c) => c.id !== colId);
  await saveCollections();
  renderSaved();
  updateActionBar();
}

/* ---------- export / clear ---------- */
function exportSaved() {
  const blob = new Blob([JSON.stringify(state.collections, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tab-saver-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function clearSaved() {
  if (!state.collections.length) return;
  if (!confirm("Delete ALL saved lists? This can't be undone.")) return;
  state.collections = [];
  await saveCollections();
  renderSaved();
  updateActionBar();
}

/* ---------- toast / undo ---------- */
let toastTimer = null;
function showToast(msg, undoable) {
  const toast = $("#toast");
  $("#toast-msg").textContent = msg;
  const undo = $("#toast-undo");
  undo.classList.toggle("hidden", !undoable);
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), undoable ? 6000 : 2500);
}

async function undoLastClose() {
  if (!lastClosed) return;
  for (const l of lastClosed.links) await chrome.tabs.create({ url: l.url, active: false });
  // remove the collection we just created
  state.collections = state.collections.filter((c) => c.id !== lastClosed.id);
  await saveCollections();
  lastClosed = null;
  $("#toast").classList.add("hidden");
  await refresh();
}

/* ---------- view switching ---------- */
function switchView(view) {
  state.view = view;
  document.querySelectorAll(".view-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $("#view-open").classList.toggle("hidden", view !== "open");
  $("#view-saved").classList.toggle("hidden", view !== "saved");
  $("#view-watched").classList.toggle("hidden", view !== "watched");
  render();
}

function render() {
  if (state.view === "open") renderOpen();
  else if (state.view === "saved") renderSaved();
  else renderWatched();
  updateActionBar();
}

async function refresh() {
  await Promise.all([loadTabs(), loadCollections(), loadWatchedHistory()]);
  render(); // paint immediately
  if (state.view === "open" || state.view === "watched") {
    await scanWatched(); // fill in watched badges + record finished videos
    render();
    updateActionBar();
  }
}

/* ---------- live progress (pushed from YouTube tabs) ---------- */
let abTimer = null;
function scheduleActionBar() {
  clearTimeout(abTimer);
  abTimer = setTimeout(updateActionBar, 150);
}

// A YouTube tab reported new progress — update just that row, no full re-render.
function liveUpdateTab(tabId) {
  const row = document.querySelector(`#tab-list .row[data-tab-id="${tabId}"]`);
  if (row && row._tab) applyRowIndicators(row, row._tab);
  scheduleActionBar();
}

/* ---------- wiring ---------- */
function wire() {
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg && msg.type === "stax-progress" && sender.tab) {
      const frac = typeof msg.frac === "number" ? msg.frac : null;
      state.progress.set(sender.tab.id, frac);
      // a video just crossed the finish line — remember it
      if (frac != null && frac >= WATCHED_THRESHOLD && recordWatched(sender.tab)) {
        saveWatchedHistory();
        if (state.view === "watched") renderWatched();
      }
      liveUpdateTab(sender.tab.id);
    }
  });

  $("#search").addEventListener("input", (e) => {
    state.query = e.target.value.trim().toLowerCase();
    render();
  });

  document.querySelectorAll(".view-btn").forEach((b) =>
    b.addEventListener("click", () => switchView(b.dataset.view))
  );

  $("#select-all").addEventListener("change", (e) => {
    const visible = visibleTabs();
    if (e.target.checked) visible.forEach((t) => state.selected.add(t.id));
    else visible.forEach((t) => state.selected.delete(t.id));
    renderOpen();
  });

  $("#select-watched").addEventListener("click", () => {
    const watched = watchedTabs();
    state.selected = new Set(watched.map((t) => t.id));
    if (state.view !== "open") switchView("open");
    else renderOpen();
  });

  $("#group-toggle").addEventListener("click", () => {
    state.grouped = !state.grouped;
    $("#group-toggle").classList.toggle("active", state.grouped);
    $("#group-toggle").textContent = state.grouped ? "Grouped by site" : "Flat list";
    renderOpen();
  });
  $("#group-toggle").classList.toggle("active", state.grouped);

  $("#save-close-selected").addEventListener("click", () => saveSelected(true));
  $("#save-selected").addEventListener("click", () => saveSelected(false));
  $("#close-selected").addEventListener("click", closeSelected);

  $("#export-btn").addEventListener("click", exportSaved);
  $("#clear-saved").addEventListener("click", clearSaved);
  $("#clear-watched-history").addEventListener("click", clearWatchedHistory);
  $("#toast-undo").addEventListener("click", undoLastClose);

  // keyboard: "/" focuses search
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement.tagName !== "INPUT") {
      e.preventDefault();
      $("#search").focus();
    }
  });

  // live-update when tabs open/close/update in the browser (debounced)
  let liveTimer = null;
  const liveRefresh = () => {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { if (state.view === "open") refresh(); }, 400);
  };
  chrome.tabs.onRemoved.addListener(liveRefresh);
  chrome.tabs.onCreated.addListener(liveRefresh);
  chrome.tabs.onUpdated.addListener((id, info) => { if (info.status === "complete" || info.title) liveRefresh(); });
}

/* ---------- init ---------- */
wire();
refresh();
