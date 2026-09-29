/* Shared helpers for the XScript device tools (no build step, no dependencies). */
"use strict";

const XS = {
  async api(method, path, body, opts = {}) {
    const init = { method, headers: { "X-XScript-Client": "tools" } };
    if (body instanceof Blob || body instanceof ArrayBuffer) {
      init.body = body;
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers["Content-Type"] = "application/json";
    }
    const r = await fetch(path, init);
    if (opts.raw) {
      if (!r.ok) throw new Error(await r.text());
      return r;
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.status + " " + r.statusText);
    return data;
  },

  status(el, text, kind) {
    el.textContent = text || "";
    el.className = "status" + (kind ? " " + kind : "");
  },

  hex(r, g, b) {
    return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
  },

  copy(text, statusEl) {
    const done = () => statusEl && XS.status(statusEl, "已复制", "ok");
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, () => XS._fallbackCopy(text, done));
    } else {
      XS._fallbackCopy(text, done);
    }
  },

  // Plain http:// on a LAN IP is not a secure context, so the async clipboard API is absent.
  _fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      done();
    } finally {
      ta.remove();
    }
  },

  esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  },

  /** Load an image URL into an offscreen canvas for exact pixel reads. */
  async loadPixels(url) {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return { img, canvas: c, ctx, width: c.width, height: c.height };
  },
};

/**
 * Zoomable, pannable view of an image on a <canvas>, with an overlay draw callback.
 * Coordinates handed to callers are always image pixels.
 */
class ImageView {
  constructor(canvas, { onDraw, onPointer } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onDraw = onDraw || (() => {});
    this.onPointer = onPointer || (() => {});
    this.img = null;
    this.scale = 1;
    this.ox = 0;
    this.oy = 0;
    this._panning = null;
    this._bind();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
  }

  setImage(img) {
    this.img = img;
    this.fit();
  }

  resize() {
    const p = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(p.clientWidth * dpr));
    this.canvas.height = Math.max(1, Math.floor(p.clientHeight * dpr));
    this.canvas.style.width = p.clientWidth + "px";
    this.canvas.style.height = p.clientHeight + "px";
    this.draw();
  }

  fit() {
    if (!this.img) return this.draw();
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    this.scale = Math.min(cw / this.img.width, ch / this.img.height);
    this.ox = (cw - this.img.width * this.scale) / 2;
    this.oy = (ch - this.img.height * this.scale) / 2;
    this.draw();
  }

  /** Canvas pixel → image pixel (floored). */
  toImage(cx, cy) {
    return { x: Math.floor((cx - this.ox) / this.scale), y: Math.floor((cy - this.oy) / this.scale) };
  }

  /** Image pixel → canvas pixel. */
  toCanvas(x, y) {
    return { x: this.ox + x * this.scale, y: this.oy + y * this.scale };
  }

  eventPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return { cx: (e.clientX - r.left) * dpr, cy: (e.clientY - r.top) * dpr };
  }

  inside(p) {
    return this.img && p.x >= 0 && p.y >= 0 && p.x < this.img.width && p.y < this.img.height;
  }

  draw() {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#1b1d22";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!this.img) return;
    ctx.imageSmoothingEnabled = this.scale < 2;
    ctx.drawImage(this.img, this.ox, this.oy, this.img.width * this.scale, this.img.height * this.scale);
    this.onDraw(ctx, this);
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener("wheel", (e) => {
      if (!this.img) return;
      e.preventDefault();
      const { cx, cy } = this.eventPoint(e);
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = Math.min(40, Math.max(0.05, this.scale * factor));
      this.ox = cx - (cx - this.ox) * (next / this.scale);
      this.oy = cy - (cy - this.oy) * (next / this.scale);
      this.scale = next;
      this.draw();
    }, { passive: false });
    c.addEventListener("pointerdown", (e) => {
      if (!this.img) return;
      const pt = this.eventPoint(e);
      // Middle button, or space held, pans; everything else goes to the tool.
      if (e.button === 1 || ImageView.spaceDown) {
        this._panning = { x: pt.cx, y: pt.cy, ox: this.ox, oy: this.oy };
        c.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
      c.setPointerCapture(e.pointerId);
      this.onPointer("down", this.toImage(pt.cx, pt.cy), e);
    });
    c.addEventListener("pointermove", (e) => {
      if (!this.img) return;
      const pt = this.eventPoint(e);
      if (this._panning) {
        this.ox = this._panning.ox + (pt.cx - this._panning.x);
        this.oy = this._panning.oy + (pt.cy - this._panning.y);
        this.draw();
        return;
      }
      this.onPointer("move", this.toImage(pt.cx, pt.cy), e);
    });
    const end = (e) => {
      if (this._panning) {
        this._panning = null;
        return;
      }
      if (!this.img) return;
      const pt = this.eventPoint(e);
      this.onPointer("up", this.toImage(pt.cx, pt.cy), e);
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("contextmenu", (e) => e.preventDefault());
  }
}
ImageView.spaceDown = false;
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
    ImageView.spaceDown = true;
    e.preventDefault();
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") ImageView.spaceDown = false;
});
