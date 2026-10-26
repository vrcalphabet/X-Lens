import "./styles/app.css";
import createPica from "pica";
import {
  encodeStegoImage,
  decodeStegoImage,
  setLensRange,
} from "./core/codec.js";
import { applyPresenceMark, detectPresenceMark } from "./core/mark.js";
import { LensView } from "./ui/lens.js";
import { loadSamplePair } from "./samples.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  cover: null,
  secret: null,
  sample: null,
  secretFit: "cover",
  secretBg: "#000000",
  compare: false,
  minPct: 15,
  maxPct: 45,
  passwordEnabled: false,
  noCopy: true,
  password: "",
};

const OUTPUT_SIZE = 896;
const pica = createPica({ features: ["js", "wasm", "ww"] });

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const PAGE_NAMES = {
  make: "画像を隠す",
  peek: "画像を覗く",
  terms: "利用規約",
  privacy: "プライバシーポリシー",
  faq: "よくある質問",
};

function parseRoute() {
  if (location.hash === "#/make") return { screen: "make" };
  if (location.hash === "#/peek") return { screen: "peek" };
  if (location.hash === "#/terms") return { screen: "terms" };
  if (location.hash === "#/privacy") return { screen: "privacy" };
  if (location.hash === "#/faq") return { screen: "faq" };
  return { screen: "home" };
}

const currentStep = () => (history.state?.step === 2 ? 2 : 1);

function goStep(step) {
  if (step === 2) {
    history.pushState({ step: 2 }, "", "#/make");
  } else if (history.state?.step === 2) {
    history.back();
    return;
  } else {
    history.replaceState({ step: 1 }, "", "#/make");
  }
  route();
}

let lastScreen = null;
let lastRouteKey = "";
function route() {
  const { screen } = parseRoute();
  let step = 0;
  if (screen === "make") {
    step = currentStep();
    if (step === 2 && !(state.cover && state.secret)) {
      history.replaceState({ step: 1 }, "", "#/make");
      step = 1;
    }
  }
  lastRouteKey = `${location.hash}|${step}`;

  $$(".screen").forEach((el) => (el.hidden = el.dataset.screen !== screen));
  $$("[data-nav]").forEach((a) =>
    a.toggleAttribute("aria-current", a.dataset.nav === screen),
  );
  const pageName = PAGE_NAMES[screen];
  const pageTitle = $("#pageTitle");
  pageTitle.hidden = !pageName;
  pageTitle.textContent = pageName || "";
  document.title = pageName ? `${pageName} | X-Lens` : "X-Lens";

  if (screen === "home") enterHome();
  if (screen === "make") enterStep(step);

  if (lastScreen !== null) {
    $("#main").focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
  lastScreen = screen;
}
const onNavigate = () => {
  const { screen } = parseRoute();
  if (
    `${location.hash}|${screen === "make" ? currentStep() : 0}` !== lastRouteKey
  )
    route();
};
window.addEventListener("popstate", onNavigate);
window.addEventListener("hashchange", onNavigate);

document.addEventListener("click", (e) => {
  const a = e.target.closest('a[href="#/make"]');
  if (!a || a.id === "toStep2" || parseRoute().screen !== "make") return;
  e.preventDefault();
  goStep(1);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sourceDims = (source) => ({
  sw: source.naturalWidth || source.width,
  sh: source.naturalHeight || source.height,
});
const aspectOf = (source) => {
  const { sw, sh } = sourceDims(source);
  return sw / sh;
};

function outputDims(source) {
  const { sw, sh } = sourceDims(source);
  const size = OUTPUT_SIZE;
  const short = (n) =>
    Math.max(8, Math.round((size * n) / Math.max(sw, sh) / 8) * 8);
  return sw >= sh ? { w: size, h: short(sh) } : { w: short(sw), h: size };
}

function canvasOf(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

const CLAMP_BG = "clamp";

function clampEdges(fitted, w, h, x0, y0) {
  const fw = fitted.width;
  const fh = fitted.height;
  const src = fitted.getContext("2d").getImageData(0, 0, fw, fh).data;
  const out = new ImageData(w, h);
  const px = new Uint32Array(out.data.buffer);
  const spx = new Uint32Array(src.buffer, src.byteOffset, fw * fh);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(fh - 1, Math.max(0, y - y0));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(fw - 1, Math.max(0, x - x0));
      px[y * w + x] = spx[sy * fw + sx];
    }
  }
  return out;
}

const BLUR_BG = "blur";

function drawBlurredCover(ctx, img, w, h) {
  const s = Math.max(w / img.width, h / img.height);
  const dw = img.width * s;
  const dh = img.height * s;
  const mid = canvasOf(
    Math.max(1, Math.round(w / 4)),
    Math.max(1, Math.round(h / 4)),
  );
  const tiny = canvasOf(
    Math.max(1, Math.round(w / 32)),
    Math.max(1, Math.round(h / 32)),
  );
  const mctx = mid.getContext("2d");
  const tctx = tiny.getContext("2d");
  mctx.imageSmoothingQuality =
    tctx.imageSmoothingQuality =
    ctx.imageSmoothingQuality =
      "high";
  mctx.drawImage(img, (w - dw) / 8, (h - dh) / 8, dw / 4, dh / 4);
  tctx.drawImage(mid, 0, 0, tiny.width, tiny.height);
  ctx.drawImage(tiny, 0, 0, w, h);
}

async function fitImage(source, w, h, fit = "cover", bg = "#000000") {
  const { sw, sh } = sourceDims(source);
  const out = canvasOf(w, h);
  const ctx = out.getContext("2d", { willReadFrequently: true });
  if (fit === "contain") {
    const s = Math.min(w / sw, h / sh);
    const fw = Math.max(1, Math.round(sw * s));
    const fh = Math.max(1, Math.round(sh * s));
    const fitted = await pica.resize(source, canvasOf(fw, fh));
    const x0 = Math.floor((w - fw) / 2);
    const y0 = Math.floor((h - fh) / 2);
    if (bg === CLAMP_BG) return clampEdges(fitted, w, h, x0, y0);
    if (bg === BLUR_BG) {
      drawBlurredCover(ctx, fitted, w, h);
    } else {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(fitted, x0, y0);
  } else {
    const s = Math.max(w / sw, h / sh);
    const cw = Math.min(sw, Math.round(w / s));
    const ch = Math.min(sh, Math.round(h / s));
    const crop =
      cw === sw && ch === sh
        ? source
        : await createImageBitmap(
            source,
            Math.floor((sw - cw) / 2),
            Math.floor((sh - ch) / 2),
            cw,
            ch,
          );
    try {
      await pica.resize(crop, out);
    } finally {
      if (crop !== source) crop.close();
    }
  }
  return ctx.getImageData(0, 0, w, h);
}

const remToDevicePx = (rem) =>
  Math.round(
    rem *
      parseFloat(getComputedStyle(document.documentElement).fontSize) *
      (window.devicePixelRatio || 1),
  );

const drawnThumbs = new WeakMap();
function drawContain(canvas, source, size, { skipSame = false } = {}) {
  let w = canvas.width;
  let h = canvas.height;
  if (size) {
    w = h = size;
  } else {
    const rect = canvas.getBoundingClientRect();
    if (rect.width) {
      const dpr = window.devicePixelRatio || 1;
      w = Math.round(rect.width * dpr);
      h = Math.round(rect.height * dpr);
    }
  }
  const resized = canvas.width !== w || canvas.height !== h;
  if (resized) {
    canvas.width = w;
    canvas.height = h;
  }
  if (skipSame && !resized && drawnThumbs.get(canvas) === source) return;
  drawnThumbs.set(canvas, source);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  const { sw, sh } = sourceDims(source);
  const s = Math.min(w / sw, h / sh);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(source, (w - sw * s) / 2, (h - sh * s) / 2, sw * s, sh * s);
}

const ratiosDiffer = () =>
  !!(state.cover && state.secret) &&
  Math.abs(
    Math.log(aspectOf(state.cover.source) / aspectOf(state.secret.source)),
  ) > 0.01;

const busyEl = $("#busy");
let busyCount = 0;
function withBusy(fn) {
  busyCount++;
  const timer = setTimeout(() => (busyEl.hidden = busyCount === 0), 150);
  return Promise.resolve()
    .then(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r))))
    .then(fn)
    .finally(() => {
      clearTimeout(timer);
      busyCount--;
      if (busyCount === 0) busyEl.hidden = true;
    });
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
let homeLens = null;
async function enterHome() {
  if (homeLens) return;
  homeLens = new LensView($("#homeLens"), { pct: 34 });
  try {
    const { cover, secret } = await loadSamplePair("fruit");
    const { w, h } = outputDims(cover.source);
    const [coverData, secretData] = await Promise.all([
      fitImage(cover.source, w, h),
      fitImage(secret.source, w, h),
    ]);
    const { image: encoded } = await encodeStegoImage(coverData, secretData, {
      minLensPct: 20,
      maxLensPct: 50,
    });
    const dec = await decodeStegoImage(encoded);
    homeLens.setLimits(dec.detectedMinLensPct, dec.detectedMaxLensPct);
    homeLens.setImages(encoded, dec.secretImageData);
    homeLens.startDrift();
  } catch (err) {
    console.warn("home demo failed", err);
  }
}

// ---------------------------------------------------------------------------
// Make: step 1
// ---------------------------------------------------------------------------
const slots = {
  cover: { root: $("#coverSlot"), input: $("#coverInput") },
  secret: { root: $("#secretSlot"), input: $("#secretInput") },
};
const toStep2 = $("#toStep2");

function renderSlots() {
  for (const key of ["cover", "secret"]) {
    const { root } = slots[key];
    const img = state[key];
    const thumb = $(".slot-thumb", root);
    const empty = $(".slot-empty", root);
    thumb.hidden = !img;
    empty.hidden = !!img;
    root.classList.toggle("is-filled", !!img);
    if (img) drawContain(thumb, img.source, 0, { skipSame: true });
  }
  $$("[data-sample]").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.sample === state.sample)),
  );
  const ready = !!(state.cover && state.secret);
  toStep2.setAttribute("aria-disabled", String(!ready));
}

function releaseImage(img) {
  if (!img || img.sample || img === state.cover || img === state.secret) return;
  Promise.resolve(building)
    .catch(() => {})
    .finally(() => img.source.close());
}

async function setSlotFile(key, file) {
  if (!file || !file.type.startsWith("image/")) return;
  const bmp = await createImageBitmap(file);
  const old = state[key];
  state[key] = { source: bmp, base: file.name.replace(/\.[^.]+$/, "") };
  state.sample = null;
  releaseImage(old);
  renderSlots();
}

for (const [key, { root, input }] of Object.entries(slots)) {
  input.addEventListener("change", () => {
    setSlotFile(key, input.files[0]);
    input.value = "";
  });
  const drop = $(".slot-drop", root);
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("is-over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("is-over");
    setSlotFile(key, e.dataTransfer.files[0]);
  });
}

$("#swapBtn").addEventListener("click", () => {
  [state.cover, state.secret] = [state.secret, state.cover];
  renderSlots();
});

$$("[data-sample]").forEach((btn) =>
  btn.addEventListener("click", () =>
    withBusy(async () => {
      const id = btn.dataset.sample;
      const { cover, secret } = await loadSamplePair(id);
      const entry = (img) => ({
        source: img.source,
        base: `sample_${img.file.replace(/\.[^.]+$/, "")}`,
        sample: true,
      });
      const old = [state.cover, state.secret];
      state.cover = entry(cover);
      state.secret = entry(secret);
      state.sample = id;
      old.forEach(releaseImage);
      renderSlots();
    }).catch((err) => console.warn("sample load failed", err)),
  ),
);

toStep2.addEventListener("click", (e) => {
  e.preventDefault();
  if (toStep2.getAttribute("aria-disabled") === "true") return;
  goStep(2);
});

// ---------------------------------------------------------------------------
// Make: step 2
// ---------------------------------------------------------------------------
let makeLens = null;
const tuneForm = $("#tuneForm");
const minLens = $("#minLens");
const maxLens = $("#maxLens");

const build = {
  coverSrc: null,
  coverLocked: false,
  cover: null,
  secretSrc: null,
  secretKey: "",
  secret: null,
  encodedFrom: [null, null],
  encodedPassword: "",
  encoded: null,
  preview: null,
  rangeKey: "",
  rev: 0,
};

function wanted() {
  const { w, h } = outputDims(state.cover.source);
  const fit = ratiosDiffer() ? state.secretFit : "cover";
  const bg = fit === "contain" ? state.secretBg : "";
  return {
    w,
    h,
    fit,
    bg,
    secretKey: `${w}x${h}|${fit}|${bg}`,
    rangeKey: `${state.minPct}|${state.maxPct}|${state.noCopy}`,
    password: state.passwordEnabled ? state.password : "",
  };
}

function isCurrent() {
  if (!(state.cover && state.secret && build.encoded)) return false;
  const want = wanted();
  return (
    build.coverSrc === state.cover.source &&
    build.coverLocked === !!want.password &&
    build.encodedPassword === want.password &&
    build.secretSrc === state.secret.source &&
    build.secretKey === want.secretKey &&
    build.encodedFrom[0] === build.cover &&
    build.encodedFrom[1] === build.secret &&
    build.rangeKey === want.rangeKey
  );
}

async function buildOnce() {
  const cover = state.cover.source;
  const secret = state.secret.source;
  const want = wanted();
  const jobs = [];
  const locked = !!want.password;
  if (build.coverSrc !== cover || build.coverLocked !== locked) {
    jobs.push(
      fitImage(cover, want.w, want.h).then((data) => {
        applyPresenceMark(data, { lsbSafe: true, locked });
        build.cover = data;
        build.coverSrc = cover;
        build.coverLocked = locked;
      }),
    );
  }
  if (build.secretSrc !== secret || build.secretKey !== want.secretKey) {
    jobs.push(
      fitImage(secret, want.w, want.h, want.fit, want.bg).then((data) => {
        build.secret = data;
        build.secretSrc = secret;
        build.secretKey = want.secretKey;
      }),
    );
  }
  await Promise.all(jobs);

  const { minPct, maxPct, noCopy } = state;
  const rangeKey = `${minPct}|${maxPct}|${noCopy}`;
  const password = want.password;
  if (
    build.encodedFrom[0] !== build.cover ||
    build.encodedFrom[1] !== build.secret ||
    build.encodedPassword !== password
  ) {
    const from = [build.cover, build.secret];
    const { image } = await encodeStegoImage(build.cover, build.secret, {
      minLensPct: minPct,
      maxLensPct: maxPct,
      password,
      noCopy,
    });
    build.encoded = image;
    build.preview =
      (await decodeStegoImage(image, { password })).secretImageData ?? image;
    build.encodedFrom = from;
    build.encodedPassword = password;
    build.rangeKey = rangeKey;
    build.rev++;
  } else if (build.rangeKey !== rangeKey) {
    setLensRange(build.encoded, build.cover, minPct, maxPct, noCopy);
    build.rangeKey = rangeKey;
    build.rev++;
  }
}

let shownPreview = null;
function showPreview() {
  if (!makeLens) {
    makeLens = new LensView($("#makeLens"));
    makeLens.setCompare(state.compare);
  }
  makeLens.setLimits(state.minPct, state.maxPct);
  if (shownPreview !== build.preview) {
    shownPreview = build.preview;
    makeLens.setImages(build.encoded, build.preview);
  }
}

let building = null;
let dirty = false;
function rebuild() {
  if (!(state.cover && state.secret)) return Promise.resolve();
  dirty = true;
  building ??= withBusy(async () => {
    while (dirty) {
      dirty = false;
      if (!(state.cover && state.secret)) break;
      try {
        await buildOnce();
        if (!dirty) showPreview();
      } catch (err) {
        console.warn("build failed", err);
      }
    }
  }).finally(() => (building = null));
  return building;
}

async function ensureEncoded() {
  state.password = passwordInput.value;
  for (let tries = 0; tries < 3 && !isCurrent(); tries++) await rebuild();
  if (!isCurrent()) throw new Error("encode failed");
}

function renderTuneNotes() {
  $("#secretFitField").hidden = !ratiosDiffer();
  $("#bgPicker").hidden = state.secretFit !== "contain";
  $("#bgHex").textContent =
    state.secretBg === CLAMP_BG
      ? "クランプ"
      : state.secretBg === BLUR_BG
        ? "ぼかし"
        : state.secretBg;

  const { minPct, maxPct } = state;
  $("#lensRangeOut").textContent =
    minPct === maxPct ? `${minPct}% 固定` : `${minPct}〜${maxPct}%`;
  const lo = Number(minLens.min);
  const span = Number(minLens.max) - lo;
  const fill = $("#lensRangeFill");
  fill.style.left = `${((minPct - lo) / span) * 100}%`;
  fill.style.width = `${((maxPct - minPct) / span) * 100}%`;
}

tuneForm.addEventListener("submit", (e) => e.preventDefault());
const passwordInput = $("#passwordInput");
tuneForm.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "compareToggle") return;
  if (t.name === "secretFit") state.secretFit = t.value;
  if (t.id === "passwordInput") state.password = t.value;
  if (t.id === "noCopyToggle") state.noCopy = t.checked;
  if (t.id === "customColor") {
    selectSwatch(customSwatch, t.value);
    return;
  }
  renderTuneNotes();
  rebuild();
});

$("#compareToggle").addEventListener("change", (e) => {
  state.compare = e.target.checked;
  makeLens?.setCompare(state.compare);
});

$("#passwordToggle").addEventListener("change", (e) => {
  state.passwordEnabled = e.target.checked;
  $("div:has(> #passwordInput)").hidden = !e.target.checked;
  tuneForm.dispatchEvent(new Event("change"));
})

$("#generatePassword").addEventListener("click", (e) => {
  e.preventDefault();
  $("#passwordInput").value = generatePassword();
})

function generatePassword() {
  const char = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!$%^&*()_+=";
  const length = 15;
  const password = [...Array(length)].map((_) => {
    return char[Math.floor(Math.random() * char.length)];
  }).join("");

  return password;
}

const customColor = $("#customColor");
const customSwatch = $("#customSwatch");
function openColorPicker() {
  try {
    customColor.showPicker();
  } catch {
    customColor.click();
  }
}
function selectSwatch(btn, color) {
  $$(".swatch").forEach((b) => b.classList.toggle("is-selected", b === btn));
  state.secretBg = color;
  renderTuneNotes();
  rebuild();
}
$$(".swatch").forEach((btn) =>
  btn.addEventListener("click", () => {
    if (btn === customSwatch) {
      selectSwatch(btn, customColor.value);
      openColorPicker();
    } else {
      selectSwatch(btn, btn.dataset.bg);
    }
  }),
);
customColor.addEventListener("input", () => {
  customSwatch.style.setProperty("--c", customColor.value);
  $("#bgHex").textContent = customColor.value;
});

minLens.addEventListener("input", () => {
  $("#compareToggle").checked = false;
  $("#compareToggle").dispatchEvent(new Event("change"));

  state.minPct = Number(minLens.value);
  if (state.minPct > state.maxPct) {
    state.maxPct = state.minPct;
    maxLens.value = state.maxPct;
  }
  renderTuneNotes();
  makeLens?.setLimits(state.minPct, state.maxPct);
});
maxLens.addEventListener("input", () => {
  $("#compareToggle").checked = false;
  $("#compareToggle").dispatchEvent(new Event("change"));

  state.maxPct = Number(maxLens.value);
  if (state.maxPct < state.minPct) {
    state.minPct = state.maxPct;
    minLens.value = state.minPct;
  }
  renderTuneNotes();
  makeLens?.setLimits(state.minPct, state.maxPct);
});
let lensHandleHeld = false;
let lensPreviewTimer = 0;
const endLensPreview = () => {
  clearTimeout(lensPreviewTimer);
  makeLens?.endPreview();
};
for (const [input, key] of [
  [minLens, "minPct"],
  [maxLens, "maxPct"],
]) {
  input.addEventListener("pointerdown", () => {
    lensHandleHeld = true;
    clearTimeout(lensPreviewTimer);
    makeLens?.previewSize(state[key]);
  });
  input.addEventListener("input", () => {
    clearTimeout(lensPreviewTimer);
    makeLens?.previewSize(state[key]);
    if (!lensHandleHeld) lensPreviewTimer = setTimeout(endLensPreview, 1200);
  });
  input.addEventListener("blur", endLensPreview);
}
for (const type of ["pointerup", "pointercancel"]) {
  window.addEventListener(type, () => {
    if (!lensHandleHeld) return;
    lensHandleHeld = false;
    endLensPreview();
  });
}

// ---------------------------------------------------------------------------
// Make: save / copy
// ---------------------------------------------------------------------------
function fileName() {
  const base = (
    state.cover?.base || `${build.encoded.width}x${build.encoded.height}`
  ).replace(/[\\/:*?"<>|]/g, "_");
  return `xlens_${base}.png`;
}

const encodedCanvasEl = document.createElement("canvas");
let canvasRev = -1;
function encodedCanvas() {
  if (canvasRev !== build.rev) {
    encodedCanvasEl.width = build.encoded.width;
    encodedCanvasEl.height = build.encoded.height;
    encodedCanvasEl.getContext("2d").putImageData(build.encoded, 0, 0);
    canvasRev = build.rev;
  }
  return encodedCanvasEl;
}
let blobCache = { rev: -1, blob: null };
function encodedToBlob() {
  if (blobCache.rev !== build.rev) {
    const c = encodedCanvas();
    blobCache = {
      rev: build.rev,
      blob: new Promise((resolve) => c.toBlob(resolve, "image/png")),
    };
  }
  return blobCache.blob;
}

const postDialog = $("#postDialog");
const DIALOG_TEXT = {
  saved: {
    title: "保存しました",
    lede: "投稿画面で、保存した画像を添付してください。",
  },
  copied: {
    title: "コピーしました",
    lede: "投稿画面で Ctrl+V をすると、画像を貼り付けられます。",
  },
};
const LOCKED_NOTE = "合言葉は見せたい人にだけ伝えてください。";

function openPostDialog(kind) {
  const text = DIALOG_TEXT[kind];
  $("#postDialogTitle").textContent = text.title;
  $("#postDialogLede").textContent = build.encodedPassword
    ? `${text.lede}${LOCKED_NOTE}`
    : text.lede;
  drawContain($("#postThumb"), encodedCanvas(), remToDevicePx(6));
  postDialog.showModal();
  $("#postToX").focus();
}
$("#postClose").addEventListener("click", () => postDialog.close());
$("#postToX").addEventListener("click", () => postDialog.close());
closeOnBackdrop(postDialog);

function flashButton(btn, text) {
  const label = btn.dataset.label || (btn.dataset.label = btn.textContent);
  btn.textContent = text;
  clearTimeout(btn._flash);
  btn._flash = setTimeout(() => (btn.textContent = label), 2500);
}

$("#downloadBtn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const name = fileName();
  try {
    if (window.showSaveFilePicker) {
      let handle = null;
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: name,
          startIn: "downloads",
          types: [
            { description: "PNG画像", accept: { "image/png": [".png"] } },
          ],
        });
      } catch (err) {
        if (err.name === "AbortError") return;
      }
      if (handle) {
        await ensureEncoded();
        const writable = await handle.createWritable();
        await writable.write(await encodedToBlob());
        await writable.close();
        openPostDialog("saved");
        return;
      }
    }

    await ensureEncoded();
    const url = URL.createObjectURL(await encodedToBlob());
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    openPostDialog("saved");
  } catch (err) {
    console.warn("save failed", err);
    flashButton(btn, "保存できませんでした");
  }
});

$("#copyBtn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  try {
    const blob = ensureEncoded().then(encodedToBlob);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    openPostDialog("copied");
  } catch (err) {
    console.warn("clipboard write failed", err);
    flashButton(btn, "コピーできませんでした。保存してください");
  }
});

function enterStep(step) {
  $$(".step").forEach((el) => (el.hidden = Number(el.dataset.step) !== step));
  renderSlots();
  if (step === 2) {
    renderTuneNotes();
    rebuild();
  }
}

// ---------------------------------------------------------------------------
// Peek
// ---------------------------------------------------------------------------
let peekLens = null;

async function openPeekFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const {
    picture,
    data,
    dec: first,
  } = await withBusy(async () => {
    const bmp = await createImageBitmap(file, {
      colorSpaceConversion: "none",
      premultiplyAlpha: "none",
    });
    const w = Math.floor(bmp.width / 8) * 8;
    const h = Math.floor(bmp.height / 8) * 8;
    const c = canvasOf(w, h);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, w, h, 0, 0, w, h);
    bmp.close();
    const data = ctx.getImageData(0, 0, w, h);
    return { picture: c, data, dec: await decodeStegoImage(data) };
  });
  let dec = first;
  if (dec.mode === "none") {
    openPeekDialog(picture, detectPresenceMark(data).marked);
    return;
  }
  if (dec.mode === "locked") {
    dec = await askPassword(data);
    if (!dec) return;
  }

  $("#peekEmpty").hidden = true;
  $("#peekView").hidden = false;
  if (!peekLens) peekLens = new LensView($("#peekLens"));
  peekLens.setLimits(dec.detectedMinLensPct, dec.detectedMaxLensPct);
  peekLens.setImages(data, dec.secretImageData);
}

const unlockDialog = $("#unlockDialog");
const unlockInput = $("#unlockInput");
const unlockError = $("#unlockError");
function askPassword(data) {
  return new Promise((resolve) => {
    unlockInput.value = "";
    unlockError.hidden = true;
    const finish = (result) => {
      unlockDialog.removeEventListener("close", onClose);
      $("#unlockForm").removeEventListener("submit", onSubmit);
      if (unlockDialog.open) unlockDialog.close();
      resolve(result);
    };
    const onClose = () => finish(null);
    const onSubmit = async (e) => {
      e.preventDefault();
      $("#unlockOk").disabled = true;
      const dec = await withBusy(() =>
        decodeStegoImage(data, { password: unlockInput.value }),
      );
      $("#unlockOk").disabled = false;
      if (dec.mode === "jpeg") return finish(dec);
      unlockError.hidden = false;
      unlockInput.select();
    };
    unlockDialog.addEventListener("close", onClose);
    $("#unlockForm").addEventListener("submit", onSubmit);
    unlockDialog.showModal();
    unlockInput.focus();
  });
}
$("#unlockCancel").addEventListener("click", () => unlockDialog.close());
closeOnBackdrop(unlockDialog);

const peekDialog = $("#peekDialog");
function openPeekDialog(picture, marked) {
  $("#peekDialogTitle").textContent = marked
    ? "縮小された画像です"
    : "隠した画像が見つかりません";
  $("#peekDialogLede").textContent = marked
    ? "X-Lensで作られた画像ですが、切り抜きや圧縮により隠した画像が消えています。"
    : "X-Lensで作られた画像ではありません。";
  drawContain($("#peekThumb"), picture, remToDevicePx(6));
  if (!peekDialog.open) peekDialog.showModal();
  $("#peekDialogOpen").focus();
}
$("#peekDialogClose").addEventListener("click", () => peekDialog.close());
$("#peekDialogOpen").addEventListener("click", () => {
  peekDialog.close();
  $("#peekInput2").click();
});
closeOnBackdrop(peekDialog);

for (const id of ["#peekInput", "#peekInput2"]) {
  $(id).addEventListener("change", (e) => {
    openPeekFile(e.target.files[0]);
    e.target.value = "";
  });
}
const peekScreen = $(".screen-peek");
const peekDrop = $("#peekDrop");
peekScreen.addEventListener("dragover", (e) => {
  e.preventDefault();
  peekDrop.classList.add("is-over");
});
peekScreen.addEventListener("dragleave", (e) => {
  if (!peekScreen.contains(e.relatedTarget))
    peekDrop.classList.remove("is-over");
});
peekScreen.addEventListener("drop", (e) => {
  e.preventDefault();
  peekDrop.classList.remove("is-over");
  openPeekFile(e.dataTransfer.files[0]);
});
document.addEventListener("paste", (e) => {
  if (parseRoute().screen !== "peek") return;
  const item = [...e.clipboardData.items].find((i) =>
    i.type.startsWith("image/"),
  );
  if (item) openPeekFile(item.getAsFile());
});

route();
