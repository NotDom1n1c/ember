"use strict";
/* ============================================================
   EMBER panels — layers list, adjustments, curves, tool props
   ============================================================ */

/* ============ tabs ============ */

function selectTab(name) {
  document.querySelectorAll(".tab-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach(p =>
    p.classList.toggle("active", p.id === "tab-" + name));
}

/* ============ layer state snapshots (for merge/flatten undo) ============ */

function snapshotLayerState(l) {
  return {
    canvas: cloneCanvas(l.canvas),
    transform: { ...l.transform },
    filters: JSON.parse(JSON.stringify(l.filters)),
    opacity: l.opacity, blendMode: l.blendMode, visible: l.visible,
    type: l.type, name: l.name,
    text: l.text ? { ...l.text } : null,
    contentBounds: l.contentBounds ? { ...l.contentBounds } : null
  };
}
function restoreLayerState(l, s) {
  l.canvas = cloneCanvas(s.canvas);
  l.transform = { ...s.transform };
  l.filters = JSON.parse(JSON.stringify(s.filters));
  l.opacity = s.opacity; l.blendMode = s.blendMode; l.visible = s.visible;
  l.type = s.type; l.name = s.name;
  l.text = s.text ? { ...s.text } : null;
  l.contentBounds = s.contentBounds ? { ...s.contentBounds } : null;
  bumpLayer(l);
}

/* ============ layer operations (with history) ============ */

function addEmptyLayer() {
  if (!App.project) return;
  const p = App.project;
  const layer = createLayer("Layer " + (p.layers.length + 1), p.width, p.height);
  const idx = Math.max(0, layerIndex(App.activeLayerId)) + 1;
  p.layers.splice(idx, 0, layer);
  App.activeLayerId = layer.id;
  commit("New layer",
    () => { const i = layerIndex(layer.id); if (i >= 0) p.layers.splice(i, 1); },
    () => { p.layers.splice(Math.min(idx, p.layers.length), 0, layer); App.activeLayerId = layer.id; });
  refreshAll();
}

function duplicateActiveLayer() {
  const l = activeLayer();
  if (!l) return;
  const p = App.project;
  const copy = createLayer(l.name + " copy", l.canvas.width, l.canvas.height, l.type);
  copy.canvas = cloneCanvas(l.canvas);
  copy.transform = { ...l.transform };
  copy.opacity = l.opacity;
  copy.blendMode = l.blendMode;
  copy.filters = JSON.parse(JSON.stringify(l.filters));
  copy.text = l.text ? { ...l.text } : null;
  copy.contentBounds = l.contentBounds ? { ...l.contentBounds } : null;
  const idx = layerIndex(l.id) + 1;
  p.layers.splice(idx, 0, copy);
  App.activeLayerId = copy.id;
  commit("Duplicate layer",
    () => { const i = layerIndex(copy.id); if (i >= 0) p.layers.splice(i, 1); },
    () => { p.layers.splice(Math.min(idx, p.layers.length), 0, copy); App.activeLayerId = copy.id; });
  refreshAll();
}

function deleteActiveLayer() {
  if (!App.project) return;
  const p = App.project;
  if (p.layers.length <= 1) { toast("Can't delete the last layer"); return; }
  const l = activeLayer();
  if (!l) return;
  const i = layerIndex(l.id);
  p.layers.splice(i, 1);
  App.activeLayerId = p.layers[Math.max(0, i - 1)].id;
  commit("Delete layer",
    () => { p.layers.splice(Math.min(i, p.layers.length), 0, l); App.activeLayerId = l.id; },
    () => { const j = layerIndex(l.id); if (j >= 0) p.layers.splice(j, 1); });
  refreshAll();
}

function moveLayerTo(fromIdx, toIdx) {
  const p = App.project;
  toIdx = clamp(toIdx, 0, p.layers.length - 1);
  if (fromIdx === toIdx || fromIdx < 0) return;
  const [l] = p.layers.splice(fromIdx, 1);
  p.layers.splice(toIdx, 0, l);
  commit("Reorder layers",
    () => { const [x] = p.layers.splice(toIdx, 1); p.layers.splice(fromIdx, 0, x); },
    () => { const [x] = p.layers.splice(fromIdx, 1); p.layers.splice(toIdx, 0, x); });
  refreshAll();
}

function mergeDown() {
  const l = activeLayer();
  if (!l) return;
  const p = App.project;
  const i = layerIndex(l.id);
  if (i <= 0) { toast("No layer below to merge into"); return; }
  const below = p.layers[i - 1];
  const beforeBelow = snapshotLayerState(below);
  const removed = l;

  const merged = makeCanvas(p.width, p.height);
  const ctx = merged.getContext("2d");
  for (const layer of [below, l]) {
    if (!layer.visible) continue;
    ctx.save();
    ctx.globalAlpha = layer.opacity / 100;
    ctx.globalCompositeOperation = layer.blendMode;
    const m = layerMatrix(layer);
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.drawImage(getRenderedLayer(layer), 0, 0);
    ctx.restore();
  }
  below.canvas = merged;
  below.transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
  below.filters = defaultFilters();
  below.opacity = 100;
  below.blendMode = "source-over";
  below.type = "image";
  below.text = null;
  below.contentBounds = null;
  bumpLayer(below);
  p.layers.splice(i, 1);
  App.activeLayerId = below.id;

  const afterBelow = snapshotLayerState(below);
  commit("Merge down",
    () => {
      restoreLayerState(below, beforeBelow);
      p.layers.splice(Math.min(i, p.layers.length), 0, removed);
      App.activeLayerId = removed.id;
    },
    () => {
      restoreLayerState(below, afterBelow);
      const j = layerIndex(removed.id);
      if (j >= 0) p.layers.splice(j, 1);
      App.activeLayerId = below.id;
    });
  refreshAll();
}

function flattenAll() {
  if (!App.project) return;
  const p = App.project;
  if (p.layers.length <= 1) { toast("Already a single layer"); return; }
  const oldLayers = p.layers.slice();
  const oldActive = App.activeLayerId;
  const layer = createLayer("Flattened", p.width, p.height);
  layer.canvas = compositeProject(1);
  p.layers = [layer];
  App.activeLayerId = layer.id;
  commit("Flatten",
    () => { p.layers = oldLayers.slice(); App.activeLayerId = oldActive; },
    () => { p.layers = [layer]; App.activeLayerId = layer.id; });
  refreshAll();
}

function toggleLayerVisible(layer) {
  const v = layer.visible;
  layer.visible = !v;
  commit(v ? "Hide layer" : "Show layer",
    () => { layer.visible = v; },
    () => { layer.visible = !v; });
  refreshAll();
}

function renameLayer(layer, name) {
  const old = layer.name;
  name = name.trim() || old;
  if (name === old) { refreshLayersPanel(); return; }
  layer.name = name;
  commit("Rename layer",
    () => { layer.name = old; },
    () => { layer.name = name; });
  refreshLayersPanel();
  if (typeof updateStatus === "function") updateStatus();
}

/* ============ layers panel UI ============ */

const EYE_ON = '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a17.9 17.9 0 0 1-2.2 3.2M6.6 6.6A17.4 17.4 0 0 0 2 12s3.5 7 10 7c1.4 0 2.7-.3 3.9-.9"/></svg>';

let _dragLayerIdx = null;

function refreshLayersPanel() {
  const list = document.getElementById("layers-list");
  if (!list) return;
  list.innerHTML = "";
  const noDoc = !App.project;
  ["layer-add", "layer-dup", "layer-del", "layer-merge", "layer-flatten", "layer-up", "layer-down"]
    .forEach(id => { const b = document.getElementById(id); if (b) b.disabled = noDoc; });
  const blend = document.getElementById("layer-blend");
  const opac = document.getElementById("layer-opacity");
  if (noDoc) { blend.disabled = opac.disabled = true; return; }

  const layers = App.project.layers;
  const active = activeLayer();
  blend.disabled = opac.disabled = !active;
  if (active) {
    blend.value = active.blendMode;
    opac.value = active.opacity;
    document.getElementById("layer-opacity-val").textContent = Math.round(active.opacity);
  }

  // top-most layer first in the list
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    const item = document.createElement("div");
    item.className = "layer-item" + (layer.id === App.activeLayerId ? " active" : "");
    item.draggable = true;
    item.dataset.idx = i;

    const eye = document.createElement("button");
    eye.className = "layer-eye" + (layer.visible ? "" : " off");
    eye.innerHTML = layer.visible ? EYE_ON : EYE_OFF;
    eye.title = "Toggle visibility";
    eye.addEventListener("click", ev => { ev.stopPropagation(); toggleLayerVisible(layer); });

    const thumb = document.createElement("div");
    thumb.className = "layer-thumb";
    const tc = document.createElement("canvas");
    tc.width = 38; tc.height = 30;
    const tctx = tc.getContext("2d");
    const k = Math.min(38 / layer.canvas.width, 30 / layer.canvas.height);
    const tw = layer.canvas.width * k, th = layer.canvas.height * k;
    tctx.drawImage(layer.canvas, (38 - tw) / 2, (30 - th) / 2, tw, th);
    thumb.appendChild(tc);

    const name = document.createElement("span");
    name.className = "layer-name";
    name.textContent = layer.name;
    name.title = layer.name + " (double-click to rename)";
    name.addEventListener("dblclick", ev => {
      ev.stopPropagation();
      const inp = document.createElement("input");
      inp.value = layer.name;
      name.textContent = "";
      name.appendChild(inp);
      inp.focus();
      inp.select();
      const done = () => renameLayer(layer, inp.value);
      inp.addEventListener("blur", done);
      inp.addEventListener("keydown", ke => {
        if (ke.key === "Enter") inp.blur();
        if (ke.key === "Escape") { inp.value = layer.name; inp.blur(); }
        ke.stopPropagation();
      });
    });

    item.appendChild(eye);
    item.appendChild(thumb);
    item.appendChild(name);
    if (layer.type === "text") {
      const badge = document.createElement("span");
      badge.className = "layer-badge";
      badge.textContent = "T";
      item.appendChild(badge);
    }

    item.addEventListener("click", () => {
      if (App.activeLayerId !== layer.id) {
        App.activeLayerId = layer.id;
        refreshLayersPanel();
        refreshAdjustPanel();
        refreshPropsPanel();
        if (typeof updateStatus === "function") updateStatus();
        requestRender(false);
      }
    });

    // drag to reorder
    item.addEventListener("dragstart", () => { _dragLayerIdx = i; });
    item.addEventListener("dragover", ev => {
      ev.preventDefault();
      const r = item.getBoundingClientRect();
      const top = ev.clientY < r.top + r.height / 2;
      item.classList.toggle("dragover-top", top);
      item.classList.toggle("dragover-bottom", !top);
    });
    item.addEventListener("dragleave", () => {
      item.classList.remove("dragover-top", "dragover-bottom");
    });
    item.addEventListener("drop", ev => {
      ev.preventDefault();
      item.classList.remove("dragover-top", "dragover-bottom");
      if (_dragLayerIdx === null || _dragLayerIdx === i) return;
      const r = item.getBoundingClientRect();
      const above = ev.clientY < r.top + r.height / 2; // above in UI = higher index
      let target = above ? i : i - 1;
      if (_dragLayerIdx < target) { /* removing shifts down */ } else if (_dragLayerIdx > target) target = above ? i + 1 : i;
      // recompute simply: desired insertion position in array after removal
      let to = above ? i : i - 1;
      if (_dragLayerIdx > to) to = to + 1;
      moveLayerTo(_dragLayerIdx, clamp(to, 0, App.project.layers.length - 1));
      _dragLayerIdx = null;
    });

    list.appendChild(item);
  }
}

function initLayersPanel() {
  document.getElementById("layer-add").addEventListener("click", addEmptyLayer);
  document.getElementById("layer-dup").addEventListener("click", duplicateActiveLayer);
  document.getElementById("layer-del").addEventListener("click", deleteActiveLayer);
  document.getElementById("layer-merge").addEventListener("click", mergeDown);
  document.getElementById("layer-flatten").addEventListener("click", flattenAll);
  document.getElementById("layer-up").addEventListener("click", () => {
    const i = layerIndex(App.activeLayerId);
    if (i >= 0) moveLayerTo(i, i + 1);
  });
  document.getElementById("layer-down").addEventListener("click", () => {
    const i = layerIndex(App.activeLayerId);
    if (i > 0) moveLayerTo(i, i - 1);
  });

  const blend = document.getElementById("layer-blend");
  blend.addEventListener("change", () => {
    const l = activeLayer();
    if (!l) return;
    const old = l.blendMode, val = blend.value;
    if (old === val) return;
    l.blendMode = val;
    commit("Blend mode",
      () => { l.blendMode = old; },
      () => { l.blendMode = val; });
    requestRender();
  });

  const opac = document.getElementById("layer-opacity");
  let opacityOld = null;
  opac.addEventListener("input", () => {
    const l = activeLayer();
    if (!l) return;
    if (opacityOld === null) opacityOld = l.opacity;
    l.opacity = +opac.value;
    document.getElementById("layer-opacity-val").textContent = opac.value;
    requestRender();
  });
  opac.addEventListener("change", () => {
    const l = activeLayer();
    if (!l || opacityOld === null) return;
    const oldV = opacityOld, newV = l.opacity;
    opacityOld = null;
    if (oldV === newV) return;
    commit("Layer opacity",
      () => { l.opacity = oldV; },
      () => { l.opacity = newV; });
  });
}

/* ============ adjustments panel ============ */

const ADJ_SLIDERS = ["brightness", "contrast", "saturation", "hue", "blur"];
const ADJ_CHECKS = ["grayscale", "sepia", "invert"];
let _adjOld = null;

function commitFilterChange(layer, oldF, label) {
  const newF = JSON.parse(JSON.stringify(layer.filters));
  if (JSON.stringify(oldF) === JSON.stringify(newF)) return;
  commit(label || "Adjustment",
    () => { layer.filters = JSON.parse(JSON.stringify(oldF)); },
    () => { layer.filters = JSON.parse(JSON.stringify(newF)); });
}

function refreshAdjustPanel() {
  const l = activeLayer();
  const off = !l;
  for (const k of ADJ_SLIDERS) {
    const s = document.getElementById("adj-" + k);
    s.disabled = off;
    s.value = off ? 0 : l.filters[k];
    document.getElementById("adj-" + k + "-val").textContent = off ? 0 : l.filters[k];
  }
  for (const k of ADJ_CHECKS) {
    const c = document.getElementById("adj-" + k);
    c.disabled = off;
    c.checked = off ? false : !!l.filters[k];
  }
  document.getElementById("btn-curves").disabled = off;
  document.getElementById("btn-adj-reset").disabled = off;
  document.getElementById("adjust-note").textContent = off
    ? "Open a document to adjust layers."
    : 'Editing "' + l.name + '" — non-destructive, applied on render.';
}

function initAdjustPanel() {
  for (const k of ADJ_SLIDERS) {
    const s = document.getElementById("adj-" + k);
    s.addEventListener("input", () => {
      const l = activeLayer();
      if (!l) return;
      if (_adjOld === null) _adjOld = JSON.parse(JSON.stringify(l.filters));
      l.filters[k] = +s.value;
      document.getElementById("adj-" + k + "-val").textContent = s.value;
      requestRender();
    });
    s.addEventListener("change", () => {
      const l = activeLayer();
      if (!l || _adjOld === null) return;
      commitFilterChange(l, _adjOld, "Adjust " + k);
      _adjOld = null;
    });
  }
  for (const k of ADJ_CHECKS) {
    const c = document.getElementById("adj-" + k);
    c.addEventListener("change", () => {
      const l = activeLayer();
      if (!l) return;
      const old = JSON.parse(JSON.stringify(l.filters));
      l.filters[k] = c.checked;
      commitFilterChange(l, old, k);
      requestRender();
    });
  }
  document.getElementById("btn-adj-reset").addEventListener("click", () => {
    const l = activeLayer();
    if (!l) return;
    const old = JSON.parse(JSON.stringify(l.filters));
    l.filters = defaultFilters();
    commitFilterChange(l, old, "Reset adjustments");
    refreshAdjustPanel();
    requestRender();
  });
  document.getElementById("btn-curves").addEventListener("click", openCurves);
  initCurves();
}

/* ============ curves editor ============ */

const Curves = { channel: "rgb", old: null, drag: null };
const CURVE_PAD = 16;

function curveChannelColor(ch) {
  return ch === "r" ? "#ff6b5e" : ch === "g" ? "#6bd98a" : ch === "b" ? "#6ba8ff" : "#efece6";
}

function openCurves() {
  const l = activeLayer();
  if (!l) return;
  if (!l.filters.curves) {
    l.filters.curves = {
      rgb: defaultCurvePoints(), r: defaultCurvePoints(),
      g: defaultCurvePoints(), b: defaultCurvePoints()
    };
  }
  Curves.old = JSON.parse(JSON.stringify(l.filters));
  Curves.channel = "rgb";
  document.querySelectorAll("#modal-curves [data-channel]").forEach(b =>
    b.classList.toggle("active", b.dataset.channel === "rgb"));
  document.getElementById("modal-curves").hidden = false;
  drawCurves();
}
function closeCurves(commitIt) {
  const l = activeLayer();
  document.getElementById("modal-curves").hidden = true;
  if (l && Curves.old) {
    if (commitIt) commitFilterChange(l, Curves.old, "Curves");
    else { l.filters = JSON.parse(JSON.stringify(Curves.old)); requestRender(); refreshAdjustPanel(); }
  }
  Curves.old = null;
}

function curveToCanvas(x, y) {
  return { x: CURVE_PAD + x, y: CURVE_PAD + (255 - y) };
}
function canvasToCurve(cx, cy) {
  return { x: clamp(cx - CURVE_PAD, 0, 255), y: clamp(255 - (cy - CURVE_PAD), 0, 255) };
}

function drawCurves() {
  const cvs = document.getElementById("curves-canvas");
  const ctx = cvs.getContext("2d");
  const l = activeLayer();
  if (!l || !l.filters.curves) return;
  const pts = l.filters.curves[Curves.channel];
  ctx.clearRect(0, 0, cvs.width, cvs.height);

  // grid
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = CURVE_PAD + i * 64;
    ctx.beginPath(); ctx.moveTo(v, CURVE_PAD); ctx.lineTo(v, CURVE_PAD + 256); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(CURVE_PAD, v); ctx.lineTo(CURVE_PAD + 256, v); ctx.stroke();
  }
  // diagonal reference
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(CURVE_PAD, CURVE_PAD + 256);
  ctx.lineTo(CURVE_PAD + 256, CURVE_PAD);
  ctx.stroke();
  ctx.setLineDash([]);

  // curve from LUT
  const lut = curveLUT(pts);
  ctx.strokeStyle = curveChannelColor(Curves.channel);
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x <= 255; x++) {
    const p = curveToCanvas(x, lut[x]);
    if (x === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();

  // points
  for (const [x, y] of pts) {
    const p = curveToCanvas(x, y);
    ctx.fillStyle = "#0c0d0f";
    ctx.strokeStyle = curveChannelColor(Curves.channel);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function initCurves() {
  const cvs = document.getElementById("curves-canvas");
  if (!cvs || cvs._wired) return;
  cvs._wired = true;

  const getPts = () => {
    const l = activeLayer();
    return l && l.filters.curves ? l.filters.curves[Curves.channel] : null;
  };
  const hitPoint = (cx, cy) => {
    const pts = getPts();
    if (!pts) return -1;
    for (let i = 0; i < pts.length; i++) {
      const p = curveToCanvas(pts[i][0], pts[i][1]);
      if (Math.hypot(p.x - cx, p.y - cy) <= 9) return i;
    }
    return -1;
  };
  const pos = e => {
    const r = cvs.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  cvs.addEventListener("pointerdown", e => {
    const pts = getPts();
    if (!pts) return;
    try { cvs.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
    const { x, y } = pos(e);
    let idx = hitPoint(x, y);
    if (idx < 0) {
      const c = canvasToCurve(x, y);
      pts.push([Math.round(c.x), Math.round(c.y)]);
      pts.sort((a, b) => a[0] - b[0]);
      idx = pts.findIndex(p => p[0] === Math.round(c.x));
    }
    Curves.drag = idx;
    drawCurves();
    requestRender();
  });
  cvs.addEventListener("pointermove", e => {
    if (Curves.drag === null || Curves.drag < 0) return;
    const pts = getPts();
    if (!pts) return;
    const { x, y } = pos(e);
    const c = canvasToCurve(x, y);
    const i = Curves.drag;
    const lo = i === 0 ? 0 : pts[i - 1][0] + 1;
    const hi = i === pts.length - 1 ? 255 : pts[i + 1][0] - 1;
    pts[i][0] = Math.round(clamp(c.x, lo, hi));
    pts[i][1] = Math.round(c.y);
    drawCurves();
    requestRender();
  });
  window.addEventListener("pointerup", () => { Curves.drag = null; });
  cvs.addEventListener("dblclick", e => {
    const pts = getPts();
    if (!pts || pts.length <= 2) return;
    const { x, y } = pos(e);
    const idx = hitPoint(x, y);
    if (idx > 0 && idx < pts.length - 1) {
      pts.splice(idx, 1);
      drawCurves();
      requestRender();
    }
  });

  document.querySelectorAll("#modal-curves [data-channel]").forEach(b => {
    b.addEventListener("click", () => {
      Curves.channel = b.dataset.channel;
      document.querySelectorAll("#modal-curves [data-channel]").forEach(x =>
        x.classList.toggle("active", x === b));
      drawCurves();
    });
  });
  document.getElementById("btn-curves-reset").addEventListener("click", () => {
    const l = activeLayer();
    if (!l) return;
    l.filters.curves = {
      rgb: defaultCurvePoints(), r: defaultCurvePoints(),
      g: defaultCurvePoints(), b: defaultCurvePoints()
    };
    drawCurves();
    requestRender();
  });
  document.getElementById("btn-curves-done").addEventListener("click", () => closeCurves(true));
}

/* ============ tool properties panel ============ */

let _textOld = null;

function refreshPropsPanel() {
  const groups = ["move", "crop", "brush", "eraser", "shape", "text", "eyedropper"];
  for (const g of groups) {
    const el = document.getElementById("props-" + g);
    if (el) el.hidden = g !== App.tool;
  }
  const l = activeLayer();

  if (App.tool === "move") {
    const info = document.getElementById("move-info");
    if (l) {
      const t = l.transform;
      info.textContent =
        "x " + Math.round(t.x) + "  y " + Math.round(t.y) +
        "  ·  " + Math.round(t.scaleX * 100) + "% / " + Math.round(t.scaleY * 100) + "%" +
        "  ·  " + Math.round(t.rotation * 180 / Math.PI) + "°";
    } else info.textContent = "—";
  }

  if (App.tool === "brush") {
    document.getElementById("brush-size").value = App.options.brush.size;
    document.getElementById("brush-size-val").textContent = App.options.brush.size;
    document.getElementById("brush-opacity").value = App.options.brush.opacity;
    document.getElementById("brush-opacity-val").textContent = App.options.brush.opacity;
    document.getElementById("brush-color").value = App.color;
    document.getElementById("brush-hex").value = App.color;
  }
  if (App.tool === "eraser") {
    document.getElementById("eraser-size").value = App.options.eraser.size;
    document.getElementById("eraser-size-val").textContent = App.options.eraser.size;
  }
  if (App.tool === "eyedropper") {
    document.getElementById("eyedrop-swatch").style.background = App.color;
    document.getElementById("eyedrop-hex").textContent = App.color;
  }
  if (App.tool === "text") {
    const editing = l && l.type === "text";
    const t = editing ? l.text : App.options.text;
    document.getElementById("text-content").value = editing ? t.content : "";
    document.getElementById("text-font").value = t.font;
    document.getElementById("text-size").value = t.size;
    document.getElementById("text-size-val").textContent = t.size;
    document.getElementById("text-color").value = t.color;
    document.getElementById("text-bold").classList.toggle("active", !!t.bold);
    document.getElementById("text-italic").classList.toggle("active", !!t.italic);
    document.querySelectorAll("#props-text [data-align]").forEach(b =>
      b.classList.toggle("active", b.dataset.align === t.align));
    document.getElementById("text-note").hidden = editing;
  }
}

function textPatch(patch, opts = {}) {
  const l = activeLayer();
  // update tool defaults (everything except content)
  for (const k of Object.keys(patch)) {
    if (k !== "content" && k in App.options.text) App.options.text[k] = patch[k];
  }
  if (l && l.type === "text") {
    if (_textOld === null) _textOld = { ...l.text };
    Object.assign(l.text, patch);
    renderTextLayer(l);
    requestRender();
    if (opts.instant) commitTextEdit(l);
    refreshLayersPanel();
  }
}
function commitTextEdit(layer) {
  if (!_textOld || !layer || layer.type !== "text") { _textOld = null; return; }
  const oldT = _textOld;
  const newT = { ...layer.text };
  _textOld = null;
  if (JSON.stringify(oldT) === JSON.stringify(newT)) return;
  commit("Edit text",
    () => { layer.text = { ...oldT }; renderTextLayer(layer); },
    () => { layer.text = { ...newT }; renderTextLayer(layer); });
}

function initPropsPanel() {
  // --- brush / eraser ---
  const wire = (id, fn) => {
    const el = document.getElementById(id);
    el.addEventListener("input", () => fn(el));
    return el;
  };
  wire("brush-size", el => {
    App.options.brush.size = +el.value;
    document.getElementById("brush-size-val").textContent = el.value;
  });
  wire("brush-opacity", el => {
    App.options.brush.opacity = +el.value;
    document.getElementById("brush-opacity-val").textContent = el.value;
  });
  wire("eraser-size", el => {
    App.options.eraser.size = +el.value;
    document.getElementById("eraser-size-val").textContent = el.value;
  });
  wire("eraser-opacity", el => {
    App.options.eraser.opacity = +el.value;
    document.getElementById("eraser-opacity-val").textContent = el.value;
  });
  document.getElementById("brush-color").addEventListener("input", e => setPrimaryColor(e.target.value));
  document.getElementById("brush-hex").addEventListener("change", e => {
    const v = e.target.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) setPrimaryColor(v.toLowerCase());
    else e.target.value = App.color;
  });
  document.getElementById("tool-color").addEventListener("input", e => setPrimaryColor(e.target.value));

  // --- crop ---
  document.querySelectorAll("#props-crop [data-ratio]").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#props-crop [data-ratio]").forEach(x =>
        x.classList.toggle("active", x === b));
      const r = b.dataset.ratio;
      if (!r) App.options.cropRatio = null;
      else {
        const [a, c] = r.split(":").map(Number);
        App.options.cropRatio = a / c;
      }
      applyCropRatioPreset();
    });
  });
  document.getElementById("btn-crop-apply").addEventListener("click", applyCrop);
  document.getElementById("btn-crop-cancel").addEventListener("click", cancelCrop);

  // --- move ---
  document.getElementById("btn-reset-transform").addEventListener("click", () => {
    const l = activeLayer();
    if (!l) return;
    const before = { ...l.transform };
    l.transform = { x: before.x, y: before.y, scaleX: 1, scaleY: 1, rotation: 0 };
    commitTransform(l, before, "Reset transform");
    refreshPropsPanel();
    requestRender();
  });

  // --- shape ---
  document.querySelectorAll("#props-shape [data-shape]").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#props-shape [data-shape]").forEach(x =>
        x.classList.toggle("active", x === b));
      App.options.shape.kind = b.dataset.shape;
    });
  });
  document.getElementById("shape-fill").addEventListener("change", e => { App.options.shape.fill = e.target.checked; });
  document.getElementById("shape-stroke").addEventListener("change", e => { App.options.shape.stroke = e.target.checked; });
  document.getElementById("shape-fill-color").addEventListener("input", e => { App.options.shape.fillColor = e.target.value; });
  document.getElementById("shape-stroke-color").addEventListener("input", e => { App.options.shape.strokeColor = e.target.value; });
  wire("shape-stroke-width", el => {
    App.options.shape.strokeWidth = +el.value;
    document.getElementById("shape-stroke-width-val").textContent = el.value;
  });

  // --- text ---
  const ta = document.getElementById("text-content");
  ta.addEventListener("input", () => textPatch({ content: ta.value }));
  ta.addEventListener("blur", () => commitTextEdit(activeLayer()));
  document.getElementById("text-font").addEventListener("change", e =>
    textPatch({ font: e.target.value }, { instant: true }));
  const ts = document.getElementById("text-size");
  ts.addEventListener("input", () => {
    document.getElementById("text-size-val").textContent = ts.value;
    textPatch({ size: +ts.value });
  });
  ts.addEventListener("change", () => commitTextEdit(activeLayer()));
  document.getElementById("text-color").addEventListener("input", e => textPatch({ color: e.target.value }));
  document.getElementById("text-color").addEventListener("change", () => commitTextEdit(activeLayer()));
  document.getElementById("text-bold").addEventListener("click", e => {
    const l = activeLayer();
    const cur = (l && l.type === "text") ? l.text.bold : App.options.text.bold;
    textPatch({ bold: !cur }, { instant: true });
    refreshPropsPanel();
  });
  document.getElementById("text-italic").addEventListener("click", () => {
    const l = activeLayer();
    const cur = (l && l.type === "text") ? l.text.italic : App.options.text.italic;
    textPatch({ italic: !cur }, { instant: true });
    refreshPropsPanel();
  });
  document.querySelectorAll("#props-text [data-align]").forEach(b => {
    b.addEventListener("click", () => {
      textPatch({ align: b.dataset.align }, { instant: true });
      refreshPropsPanel();
    });
  });
}

function initPanels() {
  document.querySelectorAll(".tab-btn").forEach(b =>
    b.addEventListener("click", () => selectTab(b.dataset.tab)));
  initLayersPanel();
  initAdjustPanel();
  initPropsPanel();
  refreshLayersPanel();
  refreshAdjustPanel();
  refreshPropsPanel();
}
