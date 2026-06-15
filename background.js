// Open (or focus) the full-page dashboard when the toolbar icon is clicked.
const DASHBOARD_URL = chrome.runtime.getURL("dashboard.html");

async function openDashboard() {
  const existing = await chrome.tabs.query({ url: DASHBOARD_URL });
  if (existing.length) {
    const tab = existing[0];
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: DASHBOARD_URL });
  }
}

// Clicking the toolbar icon opens the popup (see manifest action.default_popup);
// the popup's "Open dashboard" button calls into the full-page view.

// Open the dashboard once when the extension is first installed.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") openDashboard();
});

/* ============================================================
   Duplicate-tab detector
   When a YouTube video finishes loading in a tab, check whether the same
   video is already open elsewhere. If so (and this isn't the original), drop
   a banner into the new tab offering to jump to the existing one.
   ============================================================ */

function ytVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
    if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2] || u.pathname;
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

// Canonical key two tabs share when they're "the same page".
// YouTube collapses to the video id; everything else uses the URL minus the
// hash so e.g. /article and /article#section count as duplicates.
function dupKey(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.hostname.includes("youtube.com") || u.hostname.includes("youtu.be")) {
      const id = ytVideoId(url);
      if (id) return "yt:" + id;
    }
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

async function checkDuplicate(tabId, url) {
  const key = dupKey(url);
  if (!key) return;
  const all = await chrome.tabs.query({});
  const group = all.filter((t) => t.url && t.url !== DASHBOARD_URL && dupKey(t.url) === key);
  if (group.length < 2) return; // no duplicate

  // The oldest tab (smallest id) is the "original"; only banner the newer ones.
  const oldest = group.reduce((m, t) => (t.id < m.id ? t : m));
  if (oldest.id === tabId) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: staxDupOverlay,
      args: [oldest.id],
    });
  } catch (e) {
    /* tab navigated away / not injectable — ignore */
  }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" && tab.url && /^https?:/.test(tab.url)) {
    checkDuplicate(tabId, tab.url);
  }
});

// Banner action from a duplicate tab.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === "stax-dup" && msg.action === "switch" && sender.tab) {
    const existingId = msg.existingTabId;
    chrome.tabs.update(existingId, { active: true }, () => {
      if (chrome.runtime.lastError) return; // existing tab gone
      chrome.tabs.get(existingId, (t) => {
        if (!chrome.runtime.lastError && t) chrome.windows.update(t.windowId, { focused: true });
      });
      chrome.tabs.remove(sender.tab.id);
    });
  }
});

// Injected into a duplicate YouTube tab. Self-contained — runs in the page's
// isolated world. Renders a GradeX-styled banner inside a shadow root so the
// page's CSS can't interfere.
function staxDupOverlay(existingTabId) {
  try {
    if (window.__staxDupUrl === location.href) return; // already shown for this url
    window.__staxDupUrl = location.href;
  } catch (e) {
    /* ignore */
  }
  const prev = document.getElementById("__stax-dup-host");
  if (prev) prev.remove();

  const host = document.createElement("div");
  host.id = "__stax-dup-host";
  host.style.cssText =
    "position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML =
    '<style>' +
    '.bar{display:flex;align-items:center;gap:14px;padding:11px 12px 11px 14px;border-radius:12px;' +
    'background:#0d0d0d;border:1px solid rgba(245,245,245,0.14);box-shadow:0 16px 40px rgba(0,0,0,0.5);' +
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#f5f5f5;}" +
    '.logo{display:grid;place-items:center;width:24px;height:24px;border-radius:6px;background:#f5f5f5;color:#080808;font-size:14px;flex:0 0 auto;}' +
    '.txt{font-size:13.5px;font-weight:600;line-height:1.25;white-space:nowrap;}' +
    '.txt small{display:block;font-size:11.5px;font-weight:500;color:rgba(245,245,245,0.5);}' +
    'button{font:inherit;cursor:pointer;border-radius:9px;padding:7px 12px;font-size:13px;font-weight:600;' +
    'white-space:nowrap;border:1px solid rgba(245,245,245,0.16);transition:background .15s;}' +
    '.switch{background:#f5f5f5;color:#080808;border-color:#f5f5f5;}' +
    '.keep{background:transparent;color:#f5f5f5;}.keep:hover{background:rgba(245,245,245,0.08);}' +
    '.x{background:transparent;border:none;color:rgba(245,245,245,0.5);font-size:15px;padding:4px 6px;}' +
    '</style>' +
    '<div class="bar"><div class="logo">⊟</div>' +
    '<div class="txt">Already open in another tab<small>Stax spotted a duplicate</small></div>' +
    '<button class="switch">Switch to it</button>' +
    '<button class="keep">Keep this</button>' +
    '<button class="x">✕</button></div>';

  const remove = () => host.remove();
  root.querySelector(".switch").addEventListener("click", () => {
    try {
      chrome.runtime.sendMessage(
        { type: "stax-dup", action: "switch", existingTabId },
        () => void chrome.runtime.lastError
      );
    } catch (e) {
      /* ignore */
    }
    remove();
  });
  root.querySelector(".keep").addEventListener("click", remove);
  root.querySelector(".x").addEventListener("click", remove);
  document.documentElement.appendChild(host);
  setTimeout(() => { if (host.isConnected) host.remove(); }, 12000);
}
