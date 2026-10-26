export class LensView {
  constructor(root, { minPct = 15, maxPct = 45, pct = 30 } = {}) {
    this.root = root;
    this.minPct = minPct;
    this.maxPct = maxPct;
    this.pct = pct;
    this.x = 0.58;
    this.y = 0.45;
    this.raf = 0;
    this.drifting = false;
    this.drift = 0;
    this.driftTime = 0;
    this.preview = null;
    this.compare = false;
    this.split = 0.5;
    this.vw = 0;
    this.vh = 0;

    root.classList.add('lensview');
    root.innerHTML = '';
    this.post = document.createElement('canvas');
    this.post.className = 'lv-post';
    this.lens = document.createElement('div');
    this.lens.className = 'lv-lens';
    this.lens.tabIndex = 0;
    this.lensCanvas = document.createElement('canvas');
    this.lensCtx = this.lensCanvas.getContext('2d');
    this.lens.append(this.lensCanvas);
    root.append(this.post, this.lens);

    this.secret = document.createElement('canvas');
    this.secret.className = 'lv-secret';

    this.splitEl = document.createElement('div');
    this.splitEl.className = 'lv-split';
    this.splitEl.tabIndex = 0;
    this.splitEl.innerHTML = '<span class="lv-split-knob" aria-hidden="true"></span>';
    root.append(this.secret, this.splitEl);

    this._bind();
    this._ro = new ResizeObserver(([entry]) => {
      this.vw = entry.contentRect.width;
      this.vh = entry.contentRect.height;
      if (this.visible) this._resumeDrift();
      this.render();
    });
    this._ro.observe(root);
  }

  get visible() {
    return this.vw > 0;
  }

  setImages(postData, secretData) {
    const { width: w, height: h } = postData;
    this.post.width = w;
    this.post.height = h;
    this.post.getContext('2d').putImageData(postData, 0, 0);
    this.secret.width = w;
    this.secret.height = h;
    this.secret.getContext('2d').putImageData(secretData, 0, 0);
    (this.root.closest('.mount') || this.root).style.setProperty('--ar', String(w / h));
    this.render();
  }

  setCompare(on) {
    this.compare = !!on;
    if (this.compare) {
      this.stopDrift();
      this.endPreview();
    }
    this.root.classList.toggle('is-compare', this.compare);
    this.render();
  }

  setLimits(minPct, maxPct) {
    this.minPct = minPct;
    this.maxPct = maxPct;
    this.pct = clamp(this.pct, minPct, maxPct);
    this.render();
  }

  startDrift() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    this.drifting = true;
    this._resumeDrift();
  }

  _resumeDrift() {
    if (!this.drifting || this.drift || !this.visible) return;
    let last = performance.now();
    const step = (t) => {
      if (!this.drifting || !this.visible) {
        this.drift = 0;
        return;
      }
      this.driftTime += (t - last) / 1000;
      last = t;
      const s = this.driftTime;
      this.x = 0.5 + 0.26 * Math.sin(s * 0.55);
      this.y = 0.5 + 0.18 * Math.sin(s * 0.9 + 0.6);
      this._draw();
      this.drift = requestAnimationFrame(step);
    };
    this.drift = requestAnimationFrame(step);
  }

  stopDrift() {
    if (!this.drifting) return;
    this.drifting = false;
    cancelAnimationFrame(this.drift);
    this.drift = 0;
  }

  previewSize(pct) {
    if (!this.preview) {
      this.stopDrift();
      this.preview = { x: this.x, y: this.y };
    }
    this.preview.pct = pct;
    this.render();
  }

  endPreview() {
    if (!this.preview) return;
    ({ x: this.x, y: this.y } = this.preview);
    this.preview = null;
    this._clampPos();
    this.render();
  }

  render() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this._draw();
    });
  }

  _diameter() {
    const pct = this.preview ? this.preview.pct : clamp(this.pct, this.minPct, this.maxPct);
    return Math.round(Math.min(this.vw, this.vh) * (pct / 100));
  }

  _clampPos() {
    if (!this.visible) return;
    const r = this._diameter() / 2;
    const mx = r / this.vw;
    const my = r / this.vh;
    this.x = clamp(this.x, -mx, 1 + mx);
    this.y = clamp(this.y, -my, 1 + my);
  }

  _draw() {
    if (!this.visible || !this.post.width) return;
    if (this.compare) {
      const pct = this.split * 100;
      this.secret.style.clipPath = `inset(0 0 0 ${pct}%)`;
      this.splitEl.style.left = `${pct}%`;
      return;
    }
    const w = this.post.width;
    const h = this.post.height;
    const vw = this.vw;
    const vh = this.vh;
    const cx = this.preview ? 0.5 : this.x;
    const cy = this.preview ? 0.5 : this.y;

    const dia = this._diameter();
    this.lens.style.width = `${dia}px`;
    this.lens.style.height = `${dia}px`;
    this.lens.style.transform = `translate(${cx * vw - dia / 2}px, ${cy * vh - dia / 2}px)`;

    const dpr = window.devicePixelRatio || 1;
    const px = Math.max(16, Math.round(dia * dpr));
    if (this.lensCanvas.width !== px) {
      this.lensCanvas.width = px;
      this.lensCanvas.height = px;
    }
    const ctx = this.lensCtx;
    const sw = (w / vw) * dia;
    const sh = (h / vh) * dia;
    const sx0 = cx * w - sw / 2;
    const sy0 = cy * h - sh / 2;
    const ix0 = Math.max(0, sx0);
    const iy0 = Math.max(0, sy0);
    const ix1 = Math.min(w, sx0 + sw);
    const iy1 = Math.min(h, sy0 + sh);
    ctx.clearRect(0, 0, px, px);
    if (ix1 > ix0 && iy1 > iy0) {
      const k = px / sw;
      ctx.drawImage(
        this.secret,
        ix0, iy0, ix1 - ix0, iy1 - iy0,
        (ix0 - sx0) * k, (iy0 - sy0) * k, (ix1 - ix0) * k, (iy1 - iy0) * (px / sh)
      );
    }
  }

  _splitTo(clientX) {
    const r = this.post.getBoundingClientRect();
    this.split = clamp((clientX - r.left) / r.width, 0, 1);
    this.render();
  }

  _moveTo(clientX, clientY) {
    const r = this.post.getBoundingClientRect();
    this.x = (clientX - r.left) / r.width;
    this.y = (clientY - r.top) / r.height;
    this._clampPos();
    this.render();
  }

  _resize(delta) {
    this.pct = clamp(this.pct + delta, this.minPct, this.maxPct);
    this._clampPos();
    this.render();
  }

  _bind() {
    const root = this.root;
    let dragging = false;
    let down = null;
    let splitting = false;

    let tracking = false;
    root.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse') tracking = true;
    });

    root.addEventListener('pointerdown', (e) => {
      if (this.compare) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        splitting = true;
        root.setPointerCapture(e.pointerId);
        this._splitTo(e.clientX);
        if (e.target !== this.splitEl) e.preventDefault();
      } else if (e.pointerType !== 'mouse') {
        down = { x: e.clientX, y: e.clientY };
      }
    });
    root.addEventListener('pointermove', (e) => {
      if (splitting) this._splitTo(e.clientX);
    });
    root.addEventListener('pointerup', (e) => {
      splitting = false;
      if (!down || dragging || this.compare) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8) {
        this.stopDrift();
        this._moveTo(e.clientX, e.clientY);
      }
      down = null;
    });
    root.addEventListener('pointercancel', () => {
      splitting = false;
      down = null;
    });
    this.splitEl.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      const to = { ArrowLeft: this.split - step, ArrowRight: this.split + step, Home: 0, End: 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      this.split = clamp(to, 0, 1);
      this.render();
    });

    window.addEventListener('pointermove', (e) => {
      if (this.compare || !this.visible) return;
      if (dragging || (tracking && e.pointerType === 'mouse')) {
        this.stopDrift();
        this._moveTo(e.clientX, e.clientY);
      }
    });

    this.lens.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      dragging = true;
      this.stopDrift();
      this.lens.setPointerCapture(e.pointerId);
    });
    this.lens.addEventListener('pointerup', () => (dragging = false));
    this.lens.addEventListener('pointercancel', () => (dragging = false));

    root.addEventListener(
      'wheel',
      (e) => {
        if (this.compare) return;
        e.preventDefault();
        this.stopDrift();
        this._resize(e.deltaY < 0 ? 2 : -2);
      },
      { passive: false }
    );

    this.lens.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.08 : 0.02;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (moves[e.key]) {
        e.preventDefault();
        this.stopDrift();
        this.x += moves[e.key][0];
        this.y += moves[e.key][1];
        this._clampPos();
        this.render();
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        this._resize(3);
      } else if (e.key === '-') {
        e.preventDefault();
        this._resize(-3);
      }
    });
    this.lens.addEventListener('focus', () => this.stopDrift());
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
