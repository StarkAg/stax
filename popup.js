"use strict";

const DASHBOARD_URL = chrome.runtime.getURL("dashboard.html");
const WATCHED_THRESHOLD = 0.9;

const $ = (s) => document.querySelector(s);

let tabs = [];           // open tabs (excluding the dashboard)
let watched = [];        // tabs played ≥ threshold
let savedLinkCount = 0;

/* ---------- data ---------- */
async function loadTabs() {
  const all = await chrome.tabs.query({});
  tabs = all.filter((t) => t.url !== DASHBOARD_URL);
}

async function loadSavedCount() {
  const { collections = [] } = await chrome.storage.local.get("collections");
  savedLinkCount = collections.reduce((a, c) => a + c.links.length, 0);
}

async function scanWatched() {
  const targets = tabs.filter((t) => t.url && t.url.includes("youtube.com") && !t.discarded);
  const results = await Promise.allSettled(
    targets.map(async (t) => {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: t.id },
        func: () => {
          const v = document.querySelector("video");
          return v && v.duration && isFinite(v.duration) && v.duration > 0
            ? v.currentTime / v.duration
            : null;
        },
      });
      return { tab: t, frac: res && typeof res.result === "number" ? res.result : null };
    })
  );
  watched = results
    .filter((r) => r.status === "fulfilled" && r.value.frac != null && r.value.frac >= WATCHED_THRESHOLD)
    .map((r) => r.value.tab);
  await recordWatchedTabs(watched); // remember finished videos for the dashboard's warning
}

function ytId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return "yt:" + u.pathname.slice(1);
    if (u.pathname.startsWith("/shorts/")) return "yt:" + (u.pathname.split("/")[2] || u.pathname);
    const v = u.searchParams.get("v");
    if (v) return "yt:" + v;
  } catch {
    /* ignore */
  }
  return null;
}

async function recordWatchedTabs(list) {
  if (!list.length) return;
  const { watchedHistory = [] } = await chrome.storage.local.get("watchedHistory");
  const have = new Set(watchedHistory.map((w) => w.id));
  let added = false;
  for (const t of list) {
    const id = ytId(t.url);
    if (!id || have.has(id)) continue;
    have.add(id);
    watchedHistory.unshift({
      id,
      title: t.title || t.url,
      url: t.url,
      favIconUrl: t.favIconUrl && t.favIconUrl.startsWith("http") ? t.favIconUrl : "",
      watchedAt: Date.now(),
    });
    added = true;
  }
  if (added) await chrome.storage.local.set({ watchedHistory });
}

/* ---------- helpers ---------- */
function defaultName() {
  const d = new Date();
  return (
    d.toLocaleDateString([], { month: "short", day: "numeric" }) +
    " · " +
    d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  );
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function saveCollection(list, name) {
  const { collections = [] } = await chrome.storage.local.get("collections");
  collections.unshift({
    id: uid(),
    name: name || defaultName(),
    createdAt: Date.now(),
    links: list.map((t) => ({
      title: t.title || t.url,
      url: t.url,
      favIconUrl: t.favIconUrl && t.favIconUrl.startsWith("http") ? t.favIconUrl : "",
    })),
  });
  await chrome.storage.local.set({ collections });
}

function showStatus(msg) {
  const s = $("#status");
  s.textContent = msg;
  s.classList.remove("hidden");
}

/* ---------- render ---------- */
function render() {
  $("#s-open").textContent = tabs.length;
  $("#s-watched").textContent = watched.length;
  $("#s-saved").textContent = savedLinkCount;

  const wn = watched.length;
  const cw = $("#clear-watched");
  cw.disabled = wn === 0;
  $("#c-watched").textContent = wn || "";

  const on = tabs.length;
  $("#save-all").disabled = on === 0;
  $("#c-open").textContent = on || "";

  $("#hint").textContent = wn
    ? `${wn} already-watched tab${wn > 1 ? "s" : ""} ready to clear.`
    : "No watched YouTube tabs detected.";
}

/* ---------- actions ---------- */
async function openDashboard() {
  const existing = await chrome.tabs.query({ url: DASHBOARD_URL });
  if (existing.length) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: DASHBOARD_URL });
  }
  window.close();
}

async function clearWatched() {
  if (!watched.length) return;
  const n = watched.length;
  await chrome.tabs.remove(watched.map((t) => t.id));
  showStatus(`Cleared ${n} watched tab${n > 1 ? "s" : ""}`);
  await refresh();
}

async function saveAllOpen() {
  if (!tabs.length) return;
  const n = tabs.length;
  await saveCollection(tabs, `All tabs · ${defaultName()}`);
  showStatus(`Saved ${n} tab${n > 1 ? "s" : ""} to a list`);
  await loadSavedCount();
  render();
}

/* ---------- init ---------- */
async function refresh() {
  await Promise.all([loadTabs(), loadSavedCount()]);
  render();          // paint counts immediately
  await scanWatched();
  render();          // fill watched count
}

$("#open-dash").addEventListener("click", openDashboard);
$("#clear-watched").addEventListener("click", clearWatched);
$("#save-all").addEventListener("click", saveAllOpen);

refresh();
