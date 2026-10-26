import { decodeStegoImage, detectStegoHeader } from "../../src/core/codec.js";
import { detectPresenceMark } from "../../src/core/mark.js";

// ---------------------------------------------------------------------------
// X's DOM
// ---------------------------------------------------------------------------
const IMG_SELECTOR = 'img[src^="https://pbs.twimg.com/media/"]';
const MEDIA_ID = /^https:\/\/pbs\.twimg\.com\/media\/([A-Za-z0-9_-]+)/;
const MARK_ATTR = "data-xlens-mark";
const ON_ATTR = "data-xlens-on";

const mediaId = (src) => MEDIA_ID.exec(src)?.[1] ?? null;
const withParams = (src, params) => {
  const u = new URL(src);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.href;
};
const isPhotoView = () => /\/photo\/\d+/.test(location.pathname);

const pageStyle = document.createElement("style");
pageStyle.textContent = `
html[${ON_ATTR}] [${MARK_ATTR}] {
  &::before {
    content: "";
    position: absolute;
    bottom: 10px;
    right: 10px;
    width: 15px;
    height: 15px;
    border-radius: 50%;
    border: 0.1875rem solid #2b3035;
    background: conic-gradient(from 200deg, #5b3fd6, #2e9e6e, #d69a2d, #5b3fd6);
    box-shadow: inset 0 0 0.1875rem rgba(0 0 0 / 128), 0 0 0.1875rem 0.1875rem rgb(255 255 255 / 20%);
    pointer-events: none;
    opacity: 1;
    transition: opacity 0.2s ease;
  }
  &:hover::before {
    opacity: 0;
  }
}
html[${ON_ATTR}] [${MARK_ATTR}="purple"] {
  &::before {
    box-shadow: inset 0 0 0.1875rem rgba(0 0 0 / 128), 0 0 0.1875rem 0.1875rem #5b3fd680;
  }
}
`;
(document.head || document.documentElement).append(pageStyle);

// ---------------------------------------------------------------------------
// Fetching image files
// ---------------------------------------------------------------------------
let loggedVia = new Set();
async function fetchBlob(url) {
  try {
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (res.ok) {
      logVia("page");
      return await res.blob();
    }
  } catch {
  }
  const res = await chrome.runtime.sendMessage({ type: "xlens:fetch", url });
  if (!res?.ok) throw new Error(res?.error || "fetch failed");
  logVia("worker");
  const bin = atob(res.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: res.type });
}
function logVia(via) {
  if (loggedVia.has(via)) return;
  loggedVia.add(via);
  console.debug(
    `[X-Lens] images are fetched via the ${via === "page" ? "page (browser cache)" : "service worker"}`,
  );
}

async function loadPixels(url) {
  const bmp = await createImageBitmap(await fetchBlob(url), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, c.width, c.height);
}

function limiter(max) {
  let running = 0;
  const queue = [];
  const next = () => {
    if (running >= max || !queue.length) return;
    running++;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        running--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}
const limit = limiter(3);

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------
const markResults = new Map();
const marked = new Map();

function checkImage(img) {
  const id = mediaId(img.src);
  if (!id) return;
  if (!markResults.has(id)) {
    const job = limit(async () => {
      const data = await loadPixels(img.src);
      const header = detectStegoHeader(data);
      if (header) return header.locked ? "locked" : "open";
      const mark = detectPresenceMark(data);
      return mark.marked ? (mark.locked ? "locked" : "open") : null;
    }).catch((err) => {
      console.debug("[X-Lens] check failed", err);
      markResults.delete(id);
      return null;
    });
    markResults.set(id, job);
  }
  markResults.get(id).then((kind) => {
    if (!kind) return;
    marked.set(id, kind);
    applyMark(img);
  });
}

function applyMark(img) {
  const box = img.parentElement;
  if (!box) return;
  const kind = marked.get(mediaId(img.src));
  const color = kind === "locked" && !savedPassword(img) ? "purple" : "gold";
  if (box.getAttribute(MARK_ATTR) !== color) box.setAttribute(MARK_ATTR, color);
}

// ---------------------------------------------------------------------------
// Saved passwords
// ---------------------------------------------------------------------------
let savedKeys = {};
chrome.storage.local.get("xlensKeys").then((v) => {
  savedKeys = v.xlensKeys || {};
  if (lensMode) scan();
});
chrome.storage.onChanged.addListener((changes) => {
  if (!changes.xlensKeys) return;
  savedKeys = changes.xlensKeys.newValue || {};
  if (lensMode) scan();
});

function photoKey(img) {
  const link = img.closest('a[href*="/status/"]');
  const m =
    link && /\/status\/(\d+)\/photo\/(\d+)/.exec(link.getAttribute("href"));
  if (m) return `${m[1]}/${m[2]}`;
  const page = /\/status\/(\d+)\/photo\/(\d+)/.exec(location.pathname);
  if (!page) return null;
  const li = img.closest('li[role="listitem"]');
  const n = li
    ? [...li.parentElement.children].indexOf(li) + 1
    : Number(page[2]);
  return `${page[1]}/${n}`;
}
const savedPassword = (img) => {
  const key = photoKey(img);
  return key ? savedKeys[key] : undefined;
};
function savePassword(img, password) {
  const key = photoKey(img);
  if (!key) return;
  savedKeys = { ...savedKeys, [key]: password };
  chrome.storage.local.set({ xlensKeys: savedKeys });
}
function forgetPassword(img) {
  const key = photoKey(img);
  if (!key || !(key in savedKeys)) return;
  const { [key]: _, ...rest } = savedKeys;
  savedKeys = rest;
  chrome.storage.local.set({ xlensKeys: savedKeys });
}

const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      checkImage(e.target);
    }
  },
  { rootMargin: "600px 0px" },
);

let seen = new WeakMap();
function scan() {
  for (const img of document.querySelectorAll(IMG_SELECTOR)) {
    const id = mediaId(img.src);
    if (marked.has(id)) applyMark(img);
    if (seen.get(img) === img.src) continue;
    seen.set(img, img.src);
    if (!markResults.has(id)) io.observe(img);
    else checkImage(img);
  }
}
let scanQueued = false;
const mo = new MutationObserver(() => {
  if (scanQueued) return;
  scanQueued = true;
  requestAnimationFrame(() => {
    scanQueued = false;
    scan();
    if (refreshOverlays() && lensMode && pointer && menuEl.hidden)
      updateHover(targetAt(pointer.x, pointer.y));
  });
});

const OVERLAYS = '[role="menu"], [data-testid="mask"]';
let overlayLayers = [];
function refreshOverlays() {
  const next = [...document.querySelectorAll(OVERLAYS)].map(
    (el) => el.closest("#layers > *") || el.parentElement || el,
  );
  const changed =
    next.length !== overlayLayers.length || next.some((l, i) => l !== overlayLayers[i]);
  overlayLayers = next;
  return changed;
}
function covered(img) {
  return overlayLayers.some((layer) => !layer.contains(img));
}

// ---------------------------------------------------------------------------
// Hidden pictures
// ---------------------------------------------------------------------------
const secrets = new Map();
const settled = new Map();
const SECRET_CACHE = 8;

function viewable(dec) {
  const { width, height } = dec.secretImageData;
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d").putImageData(dec.secretImageData, 0, 0);
  return {
    canvas,
    minPct: dec.detectedMinLensPct,
    maxPct: dec.detectedMaxLensPct,
    noCopy: !!dec.noCopy,
  };
}

async function decodeOriginal(img) {
  const orig = withParams(img.src, { name: "orig" });
  let stego = await loadPixels(orig);
  let header = detectStegoHeader(stego);
  if (!header && new URL(orig).searchParams.get("format") !== "png") {
    stego = await loadPixels(withParams(orig, { format: "png" }));
    header = detectStegoHeader(stego);
  }
  if (!header) return null;
  const password = header.locked ? savedPassword(img) : undefined;
  const dec = await decodeStegoImage(stego, { password });
  if (dec.mode === "jpeg") return viewable(dec);
  if (dec.mode !== "locked") return null;
  if (dec.wrongPassword) forgetPassword(img);
  return {
    locked: true,
    stego,
    minPct: dec.detectedMinLensPct,
    maxPct: dec.detectedMaxLensPct,
    noCopy: !!dec.noCopy,
  };
}

async function unlock(img, entry, password) {
  const dec = await decodeStegoImage(entry.stego, { password });
  if (dec.mode !== "jpeg") return null;
  const ready = viewable(dec);
  secrets.set(mediaId(img.src), Promise.resolve(ready));
  settled.set(mediaId(img.src), ready);
  savePassword(img, password);
  scan();
  return ready;
}

function getSecret(img) {
  const id = mediaId(img.src);
  if (!secrets.has(id)) {
    const job = decodeOriginal(img).catch((err) => {
      console.debug("[X-Lens] decode failed", err);
      secrets.delete(id);
      return null;
    });
    job.then((entry) => settled.set(id, entry));
    secrets.set(id, job);
    while (secrets.size > SECRET_CACHE)
      secrets.delete(secrets.keys().next().value);
  }
  return secrets.get(id);
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
const host = document.createElement("div");
host.style.cssText =
  "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; contain: strict;";
const shadow = host.attachShadow({ mode: "closed" });
shadow.innerHTML = /* html */`
<style>
  :host { all: initial; }

  .toggle {
    position: fixed; left: 0; top: 0;
    width: var(--w, 56px); height: var(--h, 56px); padding: 0; margin: 0; box-sizing: border-box;
    display: grid; place-items: center; cursor: pointer; pointer-events: auto;
    border: var(--border, 0); border-radius: var(--radius, 16px);
    background-color: var(--bg, #fff); color: var(--fg, rgb(15, 20, 25));
    box-shadow: var(--shadow, rgba(101, 119, 134, 0.2) 0 0 15px, rgba(101, 119, 134, 0.15) 0 0 3px 1px);
    transform: translate(var(--x, calc(100vw - 72px)), var(--y, calc(100vh - 200px)));
    transition: background-color 0.2s, transform 200ms ease-out;
  }
  .toggle.no-anim { transition: none; }
  .toggle:hover { background-color: var(--bg-hover, var(--bg, #fff)); }
  .toggle:focus-visible { outline: 2px solid rgb(29, 155, 240); outline-offset: 2px; }
  .toggle[aria-pressed='true'] { background-color: rgb(239, 243, 244); color: rgb(15, 20, 25); }
  .toggle[hidden] { display: none; }
  .toggle svg { width: var(--icon, 24px); height: var(--icon, 24px); fill: currentColor; }
  .lens {
    position: fixed; left: 0; top: 0; border-radius: 50%; overflow: hidden;
    will-change: transform;
    box-shadow: 0 0 0 3px #2b3035, 0 14px 30px -8px rgba(15, 18, 21, 0.55);
  }
  .lens canvas { display: block; width: 100%; height: 100%; }
  .status {
    position: fixed; left: 0; top: 0; white-space: nowrap;
    padding: 4px 10px; border-radius: 9999px;
    background: rgba(15, 20, 25, 0.85); color: #fff;
    font: 700 13px/1.4 -apple-system, 'Segoe UI', 'Hiragino Sans', 'Yu Gothic UI', 'Meiryo', sans-serif;
  }
  [hidden] { display: none !important; }

  .unlock {
    --card: #fff; --text: rgb(15, 20, 25); --sub: #737373; --line: rgb(207, 217, 222);
    --primary-bg: rgb(15, 20, 25); --primary-fg: #fff; --backdrop: rgba(0, 0, 0, 0.4);
    box-sizing: border-box; width: min(320px, calc(100vw - 32px)); max-width: none;
    margin: auto; padding: 32px; border: 0; border-radius: 16px;
    background: var(--card); color: var(--text); pointer-events: auto;
    font: 400 15px/20px var(--font, -apple-system, 'Segoe UI', 'Hiragino Sans', 'Yu Gothic UI', 'Meiryo', sans-serif);
  }
  .unlock::backdrop { background: var(--backdrop); }
  .unlock h2 { margin: 0 0 8px; font-size: 20px; line-height: 24px; font-weight: 700; }
  .unlock p { margin: 0; color: var(--sub); font-size: 14px; }
  .unlock input {
    box-sizing: border-box; display: block; width: 100%; margin: 20px 0 0; padding: 12px;
    border: 2px solid var(--line); border-radius: 6px; outline: none;
    background: transparent; color: var(--text); font: inherit; font-size: 17px; line-height: 24px;
  }
  .unlock input:not(.bad):focus { border-color: #0ea5e9; }
  .unlock input.bad { border-color: #ef4444; }
  .unlock .error { margin-top: 14px; color: #ef4444; font-size: 12px; line-height: 16px; display: flex; gap: 0 6px; }
  .unlock .actions { display: grid; gap: 12px; margin-top: 24px; }
  .unlock button {
    min-height: 44px; padding: 0 24px; border-radius: 9999px; cursor: pointer;
    font: inherit; font-weight: 700; transition: background-color 0.2s, opacity 0.2s;
  }
  .unlock .ok { border: 0; background: var(--primary-bg); color: var(--primary-fg); }
  .unlock .ok:hover { opacity: 0.9; }
  .unlock .ok:disabled { opacity: 0.5; cursor: default; }
  .unlock .cancel { border: 1px solid var(--line); background: transparent; color: var(--text); }
  .unlock .cancel:hover { background: color-mix(in srgb, var(--text) 10%, transparent); }
  .unlock button:focus-visible { outline: 2px solid rgb(29, 155, 240); outline-offset: 2px; }

  .menu {
    --card: #fff; --text: rgb(15, 20, 25); --sub: rgb(83, 100, 113);
    position: fixed; left: 0; top: 0; min-width: 220px; padding: 4px 0;
    display: grid; border-radius: 12px; pointer-events: auto;
    background: var(--card); color: var(--text);
    box-shadow: rgba(101, 119, 134, 0.2) 0 0 15px, rgba(101, 119, 134, 0.15) 0 0 3px 1px;
    font: 700 15px/20px var(--font, -apple-system, 'Segoe UI', 'Hiragino Sans', 'Yu Gothic UI', 'Meiryo', sans-serif);
  }
  .menu button {
    display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px 16px;
    border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
  }
  .menu button svg { width: 18px; height: 18px; flex: none; fill: currentColor; }
  .menu button:hover:not(:disabled), .menu button:focus-visible { background: color-mix(in srgb, var(--text) 7%, transparent); outline: none; }
  .menu button:disabled { color: var(--sub); opacity: 0.6; cursor: default; }
  .menu .hint { padding: 0 16px 10px 46px; margin-top: -8px; color: var(--sub); font-size: 12px; font-weight: 400; line-height: 16px; }
  .toast {
    position: fixed; left: 50%; bottom: 32px; transform: translateX(-50%);
    padding: 12px 16px; border-radius: 4px; background: rgb(29, 155, 240); color: #fff;
    font: 400 15px/20px -apple-system, 'Segoe UI', 'Hiragino Sans', 'Yu Gothic UI', 'Meiryo', sans-serif;
    box-shadow: rgba(101, 119, 134, 0.2) 0 0 15px; pointer-events: none;
  }
  .toast.bad { background: rgb(244, 33, 46); }
</style>
<button class="toggle no-anim" type="button" aria-pressed="false" title="X-Lens：レンズモード">
  <svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M10.5 3a7.5 7.5 0 0 1 5.96 12.05l4.75 4.74-1.42 1.42-4.74-4.75A7.5 7.5 0 1 1 10.5 3zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z"/></svg>
</button>
<div class="lens" hidden><canvas></canvas></div>
<div class="status" hidden></div>
<dialog class="unlock">
  <form method="dialog">
    <h2>合言葉を入力</h2>
    <p>この画像は合言葉で保護されています。</p>
    <input type="text" name="password" autocomplete="off" spellcheck="false" aria-label="合言葉" />
    <div class="error" hidden>
      <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" data-icon="icon-error-triangle" viewBox="0 0 24 24" width="16" height="16" display="flex" role="img" aria-hidden="true"><path fill-rule="evenodd" d="M9.40228 3.50031C10.557 1.50055 13.4429 1.50055 14.5976 3.50031L22.3925 17.0003C23.547 19.0003 22.1032 21.5003 19.7939 21.5003H4.20599C1.8967 21.5003 0.452936 19.0003 1.60736 17.0003L9.40228 3.50031ZM11.998 15.2005C11.3354 15.2005 10.798 15.7372 10.7978 16.3997C10.7978 17.0625 11.3352 17.5999 11.998 17.5999C12.6606 17.5998 13.1982 17.0624 13.1982 16.3997C13.198 15.7372 12.6605 15.2006 11.998 15.2005ZM11.6035 8.50031C11.0118 8.50031 10.5495 9.01123 10.6083 9.59992L10.998 13.5003H12.998L13.3876 9.59992C13.4465 9.01123 12.9841 8.50031 12.3925 8.50031H11.6035Z" clip-rule="evenodd"></path></svg>
      合言葉が違います
    </div>
    <div class="actions">
      <button type="submit" class="ok">解除</button>
      <button type="button" class="cancel">キャンセル</button>
    </div>
  </form>
</dialog>
<div class="menu" role="menu" hidden>
  <button type="button" role="menuitem" data-act="cover">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3h11a2 2 0 0 1 2 2v11h-2V5H8V3zM3 8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8zm2 0v11h10V8H5z"/></svg>表画像をコピー
  </button>
  <button type="button" role="menuitem" data-act="secret">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M10.5 3a7.5 7.5 0 0 1 5.96 12.05l4.75 4.74-1.42 1.42-4.74-4.75A7.5 7.5 0 1 1 10.5 3zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z"/></svg>裏画像をコピー
  </button>
  <div class="hint" hidden>合言葉で解除するとコピーできます</div>
</div>
<div class="toast" role="status" hidden></div>`;
const toggle = shadow.querySelector(".toggle");
const lensEl = shadow.querySelector(".lens");
const lensCanvas = shadow.querySelector("canvas");
const lensCtx = lensCanvas.getContext("2d");
const statusEl = shadow.querySelector(".status");
const unlockDialog = shadow.querySelector(".unlock");
const unlockInput = unlockDialog.querySelector("input");
const unlockError = unlockDialog.querySelector(".error");
const unlockOk = unlockDialog.querySelector(".ok");
const menuEl = shadow.querySelector(".menu");
const toastEl = shadow.querySelector(".toast");

function closeOnBackdrop(dialog) {
  let pressedOutside = false;
  const outside = (e) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  dialog.addEventListener("pointerdown", (e) => {
    pressedOutside = e.target === dialog && outside(e);
  });
  dialog.addEventListener("click", (e) => {
    if (pressedOutside && e.target === dialog && outside(e)) dialog.close();
    pressedOutside = false;
  });
}
document.documentElement.append(host);

// ---------------------------------------------------------------------------
// Lens mode
// ---------------------------------------------------------------------------
let lensMode = false;
function reportMode() {
  chrome.runtime.sendMessage({ type: "xlens:lens-mode", on: lensMode }).catch(() => {});
}
reportMode();
function setMode(on) {
  lensMode = on;
  toggle.setAttribute("aria-pressed", String(on));
  document.documentElement.toggleAttribute(ON_ATTR, on);
  reportMode();
  if (on) {
    scan();
    refreshOverlays();
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });
  } else {
    mo.disconnect();
    io.disconnect();
    seen = new WeakMap();
    hideLens();
  }
}
toggle.addEventListener("click", () => setMode(!lensMode));

// ---------------------------------------------------------------------------
// Toggle button
// ---------------------------------------------------------------------------
const CLOSED_MAX_H = 60;
const DEFAULT_GAP = 12;

const visible = (el) => {
  const r = el?.getBoundingClientRect();
  return r && r.width > 0 && r.height > 0 ? r : null;
};

const look = {};
const isTransparent = (color) =>
  color === "transparent" || /^rgba\(.*,\s*0\)$/.test(color);

function paintOf(btn, root) {
  const stop = root?.parentElement;
  for (let el = btn; el; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (!isTransparent(cs.backgroundColor)) return { el, cs };
    if (el === stop || el === document.body) break;
  }
  return null;
}

function copyLook(btn, root) {
  const found = paintOf(btn, root);
  if (!found) return;
  const cs = getComputedStyle(btn);
  const paint = found.cs;
  if (btn.matches(":hover")) {
    look["--bg-hover"] = paint.backgroundColor;
    return;
  }
  const r = found.el.getBoundingClientRect();
  const h = Math.round(r.height);
  const w = Math.round(Math.min(r.width, h * 2) === r.width ? r.width : h);
  const svg = btn.querySelector("svg");
  const icon = svg ? Math.round(svg.getBoundingClientRect().width) : 0;
  Object.assign(look, {
    "--w": `${w}px`,
    "--h": `${h}px`,
    "--bg": paint.backgroundColor,
    "--fg": svg ? getComputedStyle(svg).color : cs.color,
    "--radius": paint.borderRadius,
    "--shadow": paint.boxShadow === "none" ? "none" : paint.boxShadow,
    "--border": `${paint.borderTopWidth} ${paint.borderTopStyle} ${paint.borderTopColor}`,
    ...(icon ? { "--icon": `${icon}px` } : {}),
  });
}

let lastLayout = "";
function layoutButton() {
  toggle.hidden = isPhotoView();
  if (toggle.hidden) return;
  const grok = document.querySelector('[data-testid="GrokDrawer"]');
  const dm = document.querySelector('[data-testid="chat-drawer-root"]');
  const grokBtn =
    grok?.querySelector('[data-testid="GrokDrawerHeader"]') || grok;
  const dmBtn = dm?.querySelector('[data-testid="chat-drawer-main"]') || dm;
  const grokRoot = visible(grok);
  const dmRoot = visible(dm);
  const grokR = visible(grokBtn);
  const dmR = visible(dmBtn);
  const grokOpen = grokRoot && grokRoot.height > CLOSED_MAX_H;
  const dmOpen = dmRoot && dmRoot.height > CLOSED_MAX_H;

  if (grokR && !grokOpen) copyLook(grokBtn, grok);
  else if (dmR && !dmOpen) copyLook(dmBtn, dm);
  for (const [k, v] of Object.entries(look)) toggle.style.setProperty(k, v);

  const w = parseFloat(look["--w"]) || 56;
  const h = parseFloat(look["--h"]) || 56;
  const gap =
    grokR && dmR && !grokOpen && !dmOpen
      ? Math.max(4, Math.round(dmR.top - grokR.bottom))
      : DEFAULT_GAP;
  let x;
  let y;
  if (grokR && !grokOpen && !dmOpen) {
    x = grokR.right - w;
    y = grokR.top - gap - h;
  } else if (grokR && dmOpen && !grokOpen) {
    x = grokR.left - gap - w;
    y = grokR.top + (grokR.height - h) / 2;
  } else if (dmR && grokOpen && !dmOpen) {
    x = dmR.left - gap - w;
    y = dmR.top + (dmR.height - h) / 2;
  } else if (dmR || grokR) {
    const r = dmR || grokR;
    x = r.left - gap - w;
    y = r.top + (r.height - h) / 2;
  }
  const key = `${x}|${y}`;
  if (key === lastLayout) return;
  lastLayout = key;
  if (x === undefined) {
    toggle.style.removeProperty("--x");
    toggle.style.removeProperty("--y");
  } else {
    toggle.style.setProperty("--x", `${Math.round(x)}px`);
    toggle.style.setProperty("--y", `${Math.round(y)}px`);
  }
  if (toggle.classList.contains("no-anim"))
    requestAnimationFrame(() => toggle.classList.remove("no-anim"));
}
layoutButton();
setInterval(layoutButton, 150);
window.addEventListener("popstate", layoutButton);
window.addEventListener("resize", layoutButton);

// ---------------------------------------------------------------------------
// Lens
// ---------------------------------------------------------------------------
let pointer = null;
let active = null;
let pct = null;
const lensSizes = new Map();
let drawQueued = false;

function hideLens() {
  active = null;
  lensEl.hidden = true;
  statusEl.hidden = true;
}

const STATUS_LENS = 90;

function clipBox(bg) {
  let el = bg;
  for (
    let i = 0;
    i < 8 && el && el !== document.body;
    i++, el = el.parentElement
  ) {
    const cs = getComputedStyle(el);
    const radius = parseFloat(cs.borderTopLeftRadius) || 0;
    if (radius > 0 && cs.overflow !== "visible")
      return { rect: el.getBoundingClientRect(), radius };
  }
  return { rect: bg.getBoundingClientRect(), radius: 0 };
}

function placement(bg, rect, W, H) {
  const cs = getComputedStyle(bg);
  if (cs.backgroundSize === "cover" || cs.backgroundSize === "contain") {
    const s =
      cs.backgroundSize === "cover"
        ? Math.max(rect.width / W, rect.height / H)
        : Math.min(rect.width / W, rect.height / H);
    const [px, py] = cs.backgroundPosition
      .split(" ")
      .map((v) => (v.endsWith("%") ? parseFloat(v) / 100 : 0.5));
    return {
      x: rect.left + (rect.width - W * s) * px,
      y: rect.top + (rect.height - H * s) * (py ?? px),
      sx: s,
      sy: s,
    };
  }
  return { x: rect.left, y: rect.top, sx: rect.width / W, sy: rect.height / H };
}

function draw() {
  drawQueued = false;
  if (!active || !pointer) return;
  const { box, img, secret } = active;
  const bg = img.previousElementSibling || box;
  const rect = bg.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  let dia = STATUS_LENS;
  let pl = null;
  if (secret?.canvas) {
    const W = secret.canvas.width;
    const H = secret.canvas.height;
    pl = placement(bg, rect, W, H);
    if (pct === null)
      pct = Math.min(secret.maxPct, Math.max(secret.minPct, 30));
    pct = Math.min(secret.maxPct, Math.max(secret.minPct, pct));
    lensSizes.set(active.id, pct);
    dia = Math.max(
      24,
      Math.round(Math.min(W * pl.sx, H * pl.sy) * (pct / 100)),
    );
  }
  const lx = pointer.x - dia / 2;
  const ly = pointer.y - dia / 2;
  lensEl.hidden = false;
  lensEl.style.width = lensEl.style.height = `${dia}px`;
  lensEl.style.transform = `translate(${lx}px, ${ly}px)`;
  const px = Math.round(dia * dpr);
  if (lensCanvas.width !== px) lensCanvas.width = lensCanvas.height = px;
  lensCtx.clearRect(0, 0, px, px);

  if (!secret?.canvas) {
    lensCtx.fillStyle = "rgba(27, 31, 35, 0.35)";
    lensCtx.fillRect(0, 0, px, px);
    if (secret?.locked) drawLock(lensCtx, px);
    statusEl.textContent =
      secret === null
        ? "読み取れません"
        : secret?.locked
          ? "クリックで解除"
          : "読み込み中…";
    statusEl.hidden = false;
    const sw = statusEl.offsetWidth;
    const sh = statusEl.offsetHeight;
    const above = ly - 8 - sh;
    statusEl.style.transform = `translate(${pointer.x - sw / 2}px, ${above >= 0 ? above : ly + dia + 8}px)`;
    return;
  }
  statusEl.hidden = true;

  const clip = clipBox(bg);
  const c = clip.rect;
  const x0 = Math.max(lx, c.left);
  const y0 = Math.max(ly, c.top);
  const x1 = Math.min(lx + dia, c.right);
  const y1 = Math.min(ly + dia, c.bottom);
  if (x1 <= x0 || y1 <= y0) return;
  lensCtx.save();
  if (clip.radius > 0) {
    lensCtx.beginPath();
    lensCtx.roundRect(
      (c.left - lx) * dpr,
      (c.top - ly) * dpr,
      c.width * dpr,
      c.height * dpr,
      clip.radius * dpr,
    );
    lensCtx.clip();
  }
  lensCtx.drawImage(
    secret.canvas,
    (x0 - pl.x) / pl.sx,
    (y0 - pl.y) / pl.sy,
    (x1 - x0) / pl.sx,
    (y1 - y0) / pl.sy,
    (x0 - lx) * dpr,
    (y0 - ly) * dpr,
    (x1 - x0) * dpr,
    (y1 - y0) * dpr,
  );
  lensCtx.restore();
}
function drawLock(ctx, px) {
  const u = px / 90;
  const cx = px / 2;
  const cy = px / 2;
  ctx.save();
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#fff";
  ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
  ctx.shadowBlur = 6 * u;
  ctx.lineWidth = 4.5 * u;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx - 9 * u, cy - 2 * u);
  ctx.lineTo(cx - 9 * u, cy - 9 * u);
  ctx.arc(cx, cy - 9 * u, 9 * u, Math.PI, 0);
  ctx.lineTo(cx + 9 * u, cy - 2 * u);
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(cx - 15 * u, cy - 3 * u, 30 * u, 23 * u, 4 * u);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(cx, cy + 6 * u, 3.2 * u, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(cx - 1.5 * u, cy + 6 * u, 3 * u, 7 * u);
  ctx.restore();
}

function render() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(draw);
}

function hoverTarget(el) {
  const box = el?.closest?.(`[${MARK_ATTR}]`);
  const img = box?.querySelector(":scope > img");
  return img ? { box, img } : null;
}

function updateHover(target) {
  if (!target || covered(target.img)) return hideLens();
  const id = mediaId(target.img.src);
  if (active?.id === id && active.box === target.box) return render();
  pct = lensSizes.get(id) ?? null;
  active = { ...target, id, secret: undefined };
  getSecret(target.img).then((secret) => {
    if (active?.id !== id) return;
    active.secret = secret;
    render();
  });
  render();
}

document.addEventListener(
  "pointermove",
  (e) => {
    if (!lensMode || e.pointerType !== "mouse" || !menuEl.hidden) return;
    pointer = { x: e.clientX, y: e.clientY };
    updateHover(hoverTarget(e.target) || targetAt(e.clientX, e.clientY));
  },
  { capture: true, passive: true },
);
function targetAt(x, y) {
  const inside = (box) => {
    const img = box.querySelector(":scope > img");
    if (!img || !box.isConnected) return null;
    const r = clipBox(img.previousElementSibling || box).rect;
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom ? { box, img } : null;
  };
  if (active) {
    const hit = inside(active.box);
    if (hit) return hit;
  }
  const scope = (isPhotoView() && document.querySelector('[aria-modal="true"]')) || document;
  for (const box of scope.querySelectorAll(`[${MARK_ATTR}]`)) {
    const hit = inside(box);
    if (hit) return hit;
  }
  return null;
}

window.addEventListener(
  "scroll",
  () => {
    if (!lensMode || !pointer) return;
    updateHover(targetAt(pointer.x, pointer.y));
  },
  { capture: true, passive: true },
);
document.documentElement.addEventListener("mouseleave", () => {
  pointer = null;
  hideLens();
});

document.addEventListener(
  "wheel",
  (e) => {
    const secret = active?.secret;
    if (!lensMode || !secret?.canvas || secret.minPct === secret.maxPct) return;
    e.preventDefault();
    pct += e.deltaY < 0 ? 2 : -2;
    render();
  },
  { capture: true, passive: false },
);

// ---------------------------------------------------------------------------
// Unlocking
// ---------------------------------------------------------------------------
window.addEventListener(
  "click",
  (e) => {
    if (!lensMode || !active?.secret?.locked || e.button !== 0) return;
    if (!active.box.contains(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    openUnlockDialog(active.img, active.secret);
  },
  true,
);

const THEMES = {
  light: {
    card: "#fff",
    text: "rgb(15, 20, 25)",
    sub: "rgb(83, 100, 113)",
    line: "rgb(207, 217, 222)",
    primaryBg: "rgb(15, 20, 25)",
    primaryFg: "#fff",
    backdrop: "rgba(0, 0, 0, 0.4)",
  },
  dim: {
    card: "rgb(21, 32, 43)",
    text: "rgb(247, 249, 249)",
    sub: "rgb(139, 152, 165)",
    line: "rgb(83, 100, 113)",
    primaryBg: "rgb(239, 243, 244)",
    primaryFg: "rgb(15, 20, 25)",
    backdrop: "rgba(91, 112, 131, 0.4)",
  },
  dark: {
    card: "#000",
    text: "rgb(231, 233, 234)",
    sub: "rgb(113, 118, 123)",
    line: "rgb(83, 100, 113)",
    primaryBg: "rgb(239, 243, 244)",
    primaryFg: "rgb(15, 20, 25)",
    backdrop: "rgba(91, 112, 131, 0.4)",
  },
};
function applyTheme() {
  const bg = getComputedStyle(document.body).backgroundColor;
  const theme =
    bg === "rgb(0, 0, 0)"
      ? THEMES.dark
      : bg === "rgb(21, 32, 43)"
        ? THEMES.dim
        : THEMES.light;
  const set = (k, v) => {
    unlockDialog.style.setProperty(k, v);
    menuEl.style.setProperty(k, v);
  };
  set("--card", theme.card);
  set("--text", theme.text);
  set("--sub", theme.sub);
  set("--line", theme.line);
  set("--primary-bg", theme.primaryBg);
  set("--primary-fg", theme.primaryFg);
  set("--backdrop", theme.backdrop);
  set("--font", getComputedStyle(document.body).fontFamily);
}

let unlocking = null;
function openUnlockDialog(img, entry) {
  unlocking = { img, entry };
  hideLens();
  applyTheme();
  unlockInput.value = "";
  unlockInput.classList.remove("bad");
  unlockError.hidden = true;
  unlockOk.disabled = false;
  unlockOk.textContent = "解除";
  unlockDialog.showModal();
  unlockInput.focus();
}
unlockDialog.querySelector("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!unlocking || !unlockInput.value) return unlockInput.focus();
  const { img, entry } = unlocking;
  unlockOk.disabled = true;
  unlockOk.textContent = "確認中…";
  const ready = await unlock(img, entry, unlockInput.value);
  unlockOk.disabled = false;
  unlockOk.textContent = "解除";
  if (ready) return unlockDialog.close();
  unlockInput.classList.add("bad");
  unlockError.hidden = false;
  unlockInput.select();
});
unlockDialog
  .querySelector(".cancel")
  .addEventListener("click", () => unlockDialog.close());
closeOnBackdrop(unlockDialog);
unlockDialog.addEventListener("close", () => {
  unlocking = null;
  if (pointer)
    updateHover(hoverTarget(document.elementFromPoint(pointer.x, pointer.y)));
});
for (const type of ["keydown", "keyup", "keypress"]) {
  unlockDialog.addEventListener(type, (e) => e.stopPropagation());
}

// ---------------------------------------------------------------------------
// Copying originals
// ---------------------------------------------------------------------------
let toastTimer = 0;
function toast(text, bad = false) {
  toastEl.textContent = text;
  toastEl.classList.toggle("bad", bad);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 2400);
}

async function asPng(blob) {
  if (blob.type === "image/png") return blob;
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext("2d").drawImage(bmp, 0, 0);
  bmp.close();
  return c.convertToBlob({ type: "image/png" });
}

async function originalPng(src) {
  const orig = withParams(src, { name: "orig" });
  let blob = await fetchBlob(orig);
  if (blob.type !== "image/png" && marked.has(mediaId(src))) {
    blob = await fetchBlob(withParams(orig, { format: "png" })).catch(() => blob);
  }
  return asPng(blob);
}

async function copyPng(blobPromise, done) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blobPromise })]);
    toast(done);
  } catch (err) {
    console.debug("[X-Lens] copy failed", err);
    toast("コピーできませんでした", true);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "xlens:copy-original" || typeof msg.src !== "string" || !mediaId(msg.src)) return;
  copyPng(originalPng(msg.src), "画像をコピーしました");
});

let menuFor = null;

function closeMenu() {
  if (menuEl.hidden) return;
  menuEl.hidden = true;
  menuFor = null;
}

function openMenu(target, x, y) {
  hideLens();
  applyTheme();
  const { img } = target;
  const id = mediaId(img.src);
  menuFor = { img };
  const entry = settled.get(id);
  const locked =
    entry?.locked || (entry === undefined && marked.get(id) === "locked" && !savedPassword(img));
  const unreadable = entry === null;
  const noCopy = !!entry?.noCopy;
  const secretBtn = menuEl.querySelector('[data-act="secret"]');
  secretBtn.disabled = locked || unreadable || noCopy;
  const hint = menuEl.querySelector(".hint");
  hint.textContent = noCopy ? "作成者がコピーを禁止しています" : "合言葉が必要です";
  hint.hidden = !(noCopy || locked);
  if (entry === undefined) getSecret(img);
  menuEl.hidden = false;
  const w = menuEl.offsetWidth;
  const h = menuEl.offsetHeight;
  const left = Math.min(x, innerWidth - w - 8);
  const top = y + h > innerHeight - 8 ? Math.max(8, y - h) : y;
  menuEl.style.transform = `translate(${Math.max(8, left)}px, ${top}px)`;
  menuEl.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
}

document.addEventListener(
  "contextmenu",
  (e) => {
    if (!lensMode) return;
    const target = hoverTarget(e.target) || targetAt(e.clientX, e.clientY);
    if (!target || covered(target.img)) return closeMenu();
    e.preventDefault();
    e.stopPropagation();
    openMenu(target, e.clientX, e.clientY);
  },
  true,
);

menuEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn || btn.disabled || !menuFor) return;
  const { img } = menuFor;
  closeMenu();
  if (btn.dataset.act === "cover") {
    copyPng(originalPng(img.src), "表画像をコピーしました");
  } else {
    const blob = getSecret(img).then((entry) => {
      if (!entry?.canvas) throw new Error("hidden picture not available");
      if (entry.noCopy) throw new Error("the creator turned copying off");
      return entry.canvas.convertToBlob({ type: "image/png" });
    });
    copyPng(blob, "裏画像をコピーしました");
  }
});
menuEl.addEventListener("keydown", (e) => {
  e.stopPropagation();
  const items = [...menuEl.querySelectorAll("button:not(:disabled)")];
  const i = items.indexOf(shadow.activeElement);
  if (e.key === "Escape") closeMenu();
  else if (e.key === "ArrowDown") items[(i + 1) % items.length]?.focus();
  else if (e.key === "ArrowUp") items[(i - 1 + items.length) % items.length]?.focus();
  else return;
  e.preventDefault();
});
window.addEventListener(
  "pointerdown",
  (e) => {
    if (!menuEl.hidden && !e.composedPath().includes(host)) closeMenu();
  },
  true,
);
for (const type of ["scroll", "resize"]) {
  window.addEventListener(type, closeMenu, { capture: true, passive: true });
}
window.addEventListener("blur", (e) => e.target === window && closeMenu());
document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu(), true);
