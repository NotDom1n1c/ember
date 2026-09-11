"use strict";
/* ============================================================
   EMBER core — app state, layers, compositing, view, history
   ============================================================ */

const PREVIEW_CAP = 4000; // display composites are capped; export always runs full-res

const App = {
  project: null,
  activeLayerId: null,
  tool: "move",
  color: "#ff5c1a",
  view: { zoom: 1, x: 0, y: 0 },
  history: { undo: [], redo: [], limit: 60 },
  dirty: false,
  crop: null,     // {x,y,w,h} in project coords while crop tool is active
  stroke: null,   // live brush stroke {layerId, canvas, alpha, erase}
  _comp: null, _compScale: 1, _compDirty: true,
  options: {
    brush: { size: 24, opacity: 100 },
    eraser: { size: 32, opacity: 100 },
    shape: { kind: "rect", fill: true, fillColor: "#ff5c1a", stroke: false, strokeColor: "#efece6", strokeWidth: 4 },
    text: { font: "Instrument Sans", size: 64, color: "#efece6", bold: false, italic: false, align: "left" },
    cropRatio: null
  }
};

let _uidCounter = 1;
function uid() { return "L" + (_uidCounter++) + "-" + Date.now().toString(36); }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
function cloneCanvas(src) {
  const c = makeCanvas(src.width, src.height);
  c.getContext("2d").drawImage(src, 0, 0);
  return c;
}

/* ============ layers ============ */

function createLayer(name, w, h, type = "image") {
  return {
    id: uid(), name, type,
    canvas: makeCanvas(w, h),
    visible: true,
    opacity: 100,
    blendMode: "source-over",
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    filters: defaultFilters(),
    text: null,            // {content,font,size,color,bold,italic,align,anchorX,anchorY}
    contentBounds: null,   // layer-local bbox for the transform box; null = whole canvas
    _rev: 0, _cache: null, _cacheKey: ""
  };
}

function createProject(w, h, bg) {
  App.project = { width: Math.round(w), height: Math.round(h), layers: [] };
  App.history.undo.length = 0;
  App.history.redo.length = 0;
  App.crop = null;
  App.stroke = null;
  const base = createLayer("Background", w, h);
  if (bg && bg !== "transparent") {
    const ctx = base.canvas.getContext("2d");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, base.canvas.width, base.canvas.height);
  }
  App.project.layers.push(base);
  App.activeLayerId = base.id;
  App.dirty = false;
  document.getElementById("welcome").style.display = "none";
  fitView();
  updateHistoryUI();
  refreshAll();
}

function getLayer(id) { return App.project ? App.project.layers.find(l => l.id === id) || null : null; }
function activeLayer() { return getLayer(App.activeLayerId); }
function layerIndex(id) { return App.project.layers.findIndex(l => l.id === id); }
function bumpLayer(layer) { layer._rev++; layer._cache = null; }

function layerMatrix(layer) {
  const t = layer.transform;
  const cx = layer.canvas.width / 2, cy = layer.canvas.height / 2;
  const m = new DOMMatrix();
  m.translateSelf(t.x + cx, t.y + cy);
  m.rotateSelf(0, 0, t.rotation * 180 / Math.PI);
  m.scaleSelf(t.scaleX, t.scaleY);
  m.translateSelf(-cx, -cy);
  return m;
}
function layerContentBounds(layer) {
  return layer.contentBounds || { x: 0, y: 0, w: layer.canvas.width, h: layer.canvas.height };
}
function transformPoint(m, x, y) {
  const p = m.transformPoint(new DOMPoint(x, y));
  return { x: p.x, y: p.y };
}

/* filtered-layer cache (non-destructive filters applied on render) */
function getRenderedLayer(layer) {
  if (!filtersActive(layer.filters)) return layer.canvas;
  const key = JSON.stringify(layer.filters) + "|" + layer._rev;
  if (layer._cache && layer._cacheKey === key) return layer._cache;
  const out = applyFiltersToCanvas(layer.canvas, layer.filters);
  layer._cache = out;
  layer._cacheKey = key;
  return out;
}

/* ============ compositing ============ */

function compositeProject(scale = 1, opts = {}) {
  const p = App.project;
  const c = makeCanvas(p.width * scale, p.height * scale);
  const ctx = c.getContext("2d");
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.scale(scale, scale);
  for (const layer of p.layers) {
    if (!layer.visible) continue;
    let src = getRenderedLayer(layer);
    if (App.stroke && App.stroke.layerId === layer.id) {
      const tmp = makeCanvas(layer.canvas.width, layer.canvas.height);
      const tctx = tmp.getContext("2d");
      tctx.drawImage(src, 0, 0);
      tctx.globalAlpha = App.stroke.alpha;
      tctx.globalCompositeOperation = App.stroke.erase ? "destination-out" : "source-over";
      tctx.drawImage(App.stroke.canvas, 0, 0);
      src = tmp;
    }
    ctx.save();
    ctx.globalAlpha = layer.opacity / 100;
    ctx.globalCompositeOperation = layer.blendMode;
    const m = layerMatrix(layer);
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.drawImage(src, 0, 0);
    ctx.restore();
  }
  return c;
}

function previewScale() {
  const m = Math.max(App.project.width, App.project.height);
  return Math.min(1, PREVIEW_CAP / m);
}
function getComposite() {
  if (!App._comp || App._compDirty) {
    App._compScale = previewScale();
    App._comp = compositeProject(App._compScale);
    App._compDirty = false;
  }
  return App._comp;
}
function invalidateComposite() { App._compDirty = true; }

/* ============ viewport rendering ============ */

let _renderQueued = false;
function requestRender(recomposite = true) {
  if (recomposite) App._compDirty = true;
  if (_renderQueued) return;
  _renderQueued = true;
  requestAnimationFrame(() => { _renderQueued = false; renderViewport(); });
}

let _checkerPattern = null;
function renderViewport() {
  const cvs = document.getElementById("viewport");
  const wrap = document.getElementById("viewport-wrap");
  if (!cvs || !wrap) return;
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (cvs.width !== Math.round(w * dpr) || cvs.height !== Math.round(h * dpr)) {
    cvs.width = Math.round(w * dpr);
    cvs.height = Math.round(h * dpr);
  }
  const ctx = cvs.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!App.project) return;

  const p = App.project, v = App.view;
  const sw = p.width * v.zoom, sh = p.height * v.zoom;

  // checkerboard = transparency indicator, only under the document
  if (!_checkerPattern) {
    const t = makeCanvas(16, 16);
    const tc = t.getContext("2d");
    tc.fillStyle = "#2e3138"; tc.fillRect(0, 0, 16, 16);
    tc.fillStyle = "#22242a"; tc.fillRect(0, 0, 8, 8); tc.fillRect(8, 8, 8, 8);
    _checkerPattern = ctx.createPattern(t, "repeat");
  }
  ctx.fillStyle = _checkerPattern;
  ctx.fillRect(v.x, v.y, sw, sh);

  const comp = getComposite();
  ctx.imageSmoothingEnabled = v.zoom < 3;
  ctx.drawImage(comp, 0, 0, comp.width, comp.height, v.x, v.y, sw, sh);
  ctx.imageSmoothingEnabled = true;

  ctx.strokeStyle = "rgba(255,255,255,0.09)";
  ctx.strokeRect(v.x - 0.5, v.y - 0.5, sw + 1, sh + 1);

  if (typeof drawToolOverlay === "function") drawToolOverlay(ctx, w, h);
}

/* ============ view transform ============ */

function screenToProject(sx, sy) {
  const v = App.view;
  return { x: (sx - v.x) / v.zoom, y: (sy - v.y) / v.zoom };
}
function projectToScreen(px, py) {
  const v = App.view;
  return { x: px * v.zoom + v.x, y: py * v.zoom + v.y };
}
function setZoom(z, cx, cy) {
  const v = App.view;
  z = clamp(z, 0.03, 32);
  if (cx === undefined) {
    const wrap = document.getElementById("viewport-wrap");
    cx = wrap.clientWidth / 2; cy = wrap.clientHeight / 2;
  }
  v.x = cx - (cx - v.x) * (z / v.zoom);
  v.y = cy - (cy - v.y) * (z / v.zoom);
  v.zoom = z;
  requestRender(false);
  updateZoomUI();
}
function fitView() {
  if (!App.project) return;
  const wrap = document.getElementById("viewport-wrap");
  const w = wrap.clientWidth || 800, h = wrap.clientHeight || 600;
  const z = clamp(Math.min((w - 90) / App.project.width, (h - 90) / App.project.height), 0.03, 8);
  App.view.zoom = z;
  App.view.x = (w - App.project.width * z) / 2;
  App.view.y = (h - App.project.height * z) / 2;
  requestRender(false);
  updateZoomUI();
}
function updateZoomUI() {
  const pct = Math.round(App.view.zoom * 100) + "%";
  const zl = document.getElementById("zoom-level");
  const sz = document.getElementById("status-zoom");
  if (zl) zl.textContent = pct;
  if (sz) sz.textContent = pct;
}

/* ============ history (command pattern) ============ */

function commit(label, undoFn, redoFn) {
  App.history.undo.push({ label, undo: undoFn, redo: redoFn });
  if (App.history.undo.length > App.history.limit) App.history.undo.shift();
  App.history.redo.length = 0;
  App.dirty = true;
  updateHistoryUI();
}
function doUndo() {
  const c = App.history.undo.pop();
  if (!c) return;
  c.undo();
  App.history.redo.push(c);
  App.dirty = true;
  afterHistory(c.label);
}
function doRedo() {
  const c = App.history.redo.pop();
  if (!c) return;
  c.redo();
  App.history.undo.push(c);
  App.dirty = true;
  afterHistory(c.label);
}
function afterHistory() {
  if (App.project && !getLayer(App.activeLayerId) && App.project.layers.length) {
    App.activeLayerId = App.project.layers[App.project.layers.length - 1].id;
  }
  updateHistoryUI();
  refreshAll();
}
function updateHistoryUI() {
  const u = document.getElementById("btn-undo"), r = document.getElementById("btn-redo");
  if (u) u.disabled = App.history.undo.length === 0;
  if (r) r.disabled = App.history.redo.length === 0;
}

/* pixel patches — bounded ImageData snapshots for reversible draw commands */
function capturePatch(canvas, rect) {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const x2 = Math.min(canvas.width, Math.ceil(rect.x + rect.w));
  const y2 = Math.min(canvas.height, Math.ceil(rect.y + rect.h));
  if (x2 <= x || y2 <= y) return null;
  return { x, y, data: canvas.getContext("2d").getImageData(x, y, x2 - x, y2 - y) };
}
function applyPatch(canvas, patch) {
  if (patch) canvas.getContext("2d").putImageData(patch.data, patch.x, patch.y);
}

/* ============ misc shared UI ============ */

function refreshAll() {
  if (typeof refreshLayersPanel === "function") refreshLayersPanel();
  if (typeof refreshAdjustPanel === "function") refreshAdjustPanel();
  if (typeof refreshPropsPanel === "function") refreshPropsPanel();
  if (typeof updateStatus === "function") updateStatus();
  requestRender();
}

function toast(msg) {
  const box = document.getElementById("toasts");
  if (!box) return;
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => {
    t.classList.add("leaving");
    setTimeout(() => t.remove(), 350);
  }, 2400);
}
