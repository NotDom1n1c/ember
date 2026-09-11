"use strict";
/* ============================================================
   EMBER tools — pointer gestures, move/crop/brush/shape/text
   ============================================================ */

const Tools = {
  gesture: null,
  spaceDown: false,
  pointerInside: false,
  shapePreview: null,
  last: { sx: 0, sy: 0 }
};

const HANDLE_R = 8;      // hit radius, screen px
const CURSORS = {
  move: "default", crop: "crosshair", brush: "none", eraser: "none",
  shape: "crosshair", text: "text", eyedropper: "crosshair"
};

function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

/* ============ tool switching ============ */

function setTool(name) {
  if (App.tool === "crop" && name !== "crop") App.crop = null;
  App.tool = name;
  document.querySelectorAll(".tool-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.tool === name));
  if (name === "crop" && App.project) beginCrop();
  updateCanvasCursor();
  if (typeof refreshPropsPanel === "function") refreshPropsPanel();
  if (typeof selectTab === "function" && name !== "move") selectTab("props");
  requestRender(false);
}
function updateCanvasCursor() {
  const cvs = document.getElementById("viewport");
  cvs.style.cursor = Tools.spaceDown ? "grab" : (CURSORS[App.tool] || "default");
}

/* ============ pointer plumbing ============ */

function initTools() {
  const cvs = document.getElementById("viewport");
  cvs.addEventListener("pointerdown", onPointerDown);
  cvs.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  cvs.addEventListener("pointerenter", () => { Tools.pointerInside = true; });
  cvs.addEventListener("pointerleave", () => { Tools.pointerInside = false; requestRender(false); });
  cvs.addEventListener("wheel", onWheel, { passive: false });
  cvs.addEventListener("contextmenu", e => e.preventDefault());
  window.addEventListener("resize", () => requestRender(false));
}

function eventPos(e) {
  const rect = document.getElementById("viewport").getBoundingClientRect();
  return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
}

function onWheel(e) {
  if (!App.project) return;
  e.preventDefault();
  const { sx, sy } = eventPos(e);
  const k = Math.exp(-e.deltaY * 0.0015);
  setZoom(App.view.zoom * k, sx, sy);
}

function onPointerDown(e) {
  if (!App.project) return;
  const cvs = document.getElementById("viewport");
  try { cvs.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
  const { sx, sy } = eventPos(e);
  Tools.last = { sx, sy };

  if (Tools.spaceDown || e.button === 1) { startPan(sx, sy); return; }
  if (e.button !== 0) return;

  if (e.altKey && (App.tool === "brush" || App.tool === "shape")) {
    sampleColorAt(sx, sy);
    return;
  }
  switch (App.tool) {
    case "move": moveDown(e, sx, sy); break;
    case "crop": cropDown(e, sx, sy); break;
    case "brush":
    case "eraser": strokeDown(e, sx, sy); break;
    case "shape": shapeDown(e, sx, sy); break;
    case "text": textDown(e, sx, sy); break;
    case "eyedropper": eyedropDown(e, sx, sy); break;
  }
}

function onPointerMove(e) {
  if (!App.project) return;
  const { sx, sy } = eventPos(e);
  Tools.last = { sx, sy };
  const p = screenToProject(sx, sy);
  if (typeof updateCursorStatus === "function") updateCursorStatus(p);
  if (Tools.gesture) { Tools.gesture.move(e, sx, sy); return; }

  // hover feedback
  if (App.tool === "move") {
    const layer = activeLayer();
    const hit = layer ? hitMoveHandle(layer, sx, sy) : null;
    const cvs = document.getElementById("viewport");
    if (Tools.spaceDown) cvs.style.cursor = "grab";
    else if (hit === "rot") cvs.style.cursor = "crosshair";
    else if (hit && hit !== "body") cvs.style.cursor = "nesw-resize";
    else if (hit === "body") cvs.style.cursor = "move";
    else cvs.style.cursor = "default";
  }
  if (App.tool === "brush" || App.tool === "eraser") requestRender(false);
}

function onPointerUp(e) {
  if (Tools.gesture) {
    const g = Tools.gesture;
    Tools.gesture = null;
    if (g.up) g.up(e);
  }
}

function startPan(sx, sy) {
  const v0 = { x: App.view.x, y: App.view.y };
  const cvs = document.getElementById("viewport");
  cvs.style.cursor = "grabbing";
  Tools.gesture = {
    move(e, sx2, sy2) {
      App.view.x = v0.x + (sx2 - sx);
      App.view.y = v0.y + (sy2 - sy);
      requestRender(false);
    },
    up() { updateCanvasCursor(); }
  };
}

/* ============ MOVE / TRANSFORM ============ */

function moveHandlePoints(layer) {
  const b = layerContentBounds(layer);
  const m = layerMatrix(layer);
  const P = (x, y) => { const q = transformPoint(m, x, y); return projectToScreen(q.x, q.y); };
  const tl = P(b.x, b.y), tr = P(b.x + b.w, b.y);
  const br = P(b.x + b.w, b.y + b.h), bl = P(b.x, b.y + b.h);
  const tm = mid(tl, tr), rm = mid(tr, br), bm = mid(br, bl), lm = mid(bl, tl);
  const center = { x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 };
  let dx = tm.x - center.x, dy = tm.y - center.y;
  const len = Math.hypot(dx, dy) || 1;
  const rot = { x: tm.x + dx / len * 26, y: tm.y + dy / len * 26 };
  return { tl, tr, br, bl, tm, rm, bm, lm, rot, center };
}

function pointInLayer(layer, px, py) {
  const inv = layerMatrix(layer).inverse();
  const lp = new DOMPoint(px, py).matrixTransform(inv);
  const b = layerContentBounds(layer);
  return lp.x >= b.x && lp.x <= b.x + b.w && lp.y >= b.y && lp.y <= b.y + b.h;
}

function hitMoveHandle(layer, sx, sy) {
  const H = moveHandlePoints(layer);
  const pt = { x: sx, y: sy };
  if (dist(pt, H.rot) <= HANDLE_R + 2) return "rot";
  for (const k of ["tl", "tr", "br", "bl", "tm", "rm", "bm", "lm"]) {
    if (dist(pt, H[k]) <= HANDLE_R) return k;
  }
  const p = screenToProject(sx, sy);
  if (pointInLayer(layer, p.x, p.y)) return "body";
  return null;
}

function pickLayerAt(px, py) {
  const layers = App.project.layers;
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (!l.visible) continue;
    const inv = layerMatrix(l).inverse();
    const lp = new DOMPoint(px, py).matrixTransform(inv);
    const x = Math.floor(lp.x), y = Math.floor(lp.y);
    if (x < 0 || y < 0 || x >= l.canvas.width || y >= l.canvas.height) continue;
    const a = l.canvas.getContext("2d").getImageData(x, y, 1, 1).data[3];
    if (a > 8) return l;
  }
  return null;
}

function snapshotTransform(layer) { return { ...layer.transform }; }
function commitTransform(layer, before, label) {
  const after = { ...layer.transform };
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  commit(label,
    () => { layer.transform = { ...before }; },
    () => { layer.transform = { ...after }; });
  App.dirty = true;
}

function moveDown(e, sx, sy) {
  const p = screenToProject(sx, sy);
  let layer = activeLayer();
  const hit = layer ? hitMoveHandle(layer, sx, sy) : null;

  if (hit === "rot") { startRotate(layer, sx, sy); return; }
  if (hit && hit !== "body") { startScale(layer, hit); return; }

  if (!hit) {
    const picked = pickLayerAt(p.x, p.y);
    if (picked) {
      layer = picked;
      if (picked.id !== App.activeLayerId) {
        App.activeLayerId = picked.id;
        if (typeof refreshLayersPanel === "function") refreshLayersPanel();
        if (typeof refreshAdjustPanel === "function") refreshAdjustPanel();
        if (typeof updateStatus === "function") updateStatus();
      }
    } else { requestRender(false); return; }
  }
  // drag
  const before = snapshotTransform(layer);
  Tools.gesture = {
    move(e2, sx2, sy2) {
      layer.transform.x = before.x + (sx2 - sx) / App.view.zoom;
      layer.transform.y = before.y + (sy2 - sy) / App.view.zoom;
      if (typeof refreshPropsPanel === "function") refreshPropsPanel();
      requestRender();
    },
    up() { commitTransform(layer, before, "Move layer"); }
  };
}

function startScale(layer, handle) {
  const before = snapshotTransform(layer);
  const b = layerContentBounds(layer);
  const cw = layer.canvas.width, ch = layer.canvas.height;
  // canvas center = fixed point of the transform
  const centerProj = { x: before.x + cw / 2, y: before.y + ch / 2 };
  const hx = handle.includes("l") && handle !== "lm" ? b.x
    : handle.includes("r") && handle !== "rm" ? b.x + b.w
    : handle === "lm" ? b.x : handle === "rm" ? b.x + b.w : b.x + b.w / 2;
  const hy = handle.startsWith("t") ? b.y
    : handle.startsWith("b") && handle !== "bl" ? b.y + b.h
    : handle === "bl" ? b.y + b.h : b.y + b.h / 2;
  const offX = hx - cw / 2, offY = hy - ch / 2;
  const useX = ["tl", "tr", "br", "bl", "lm", "rm"].includes(handle) && Math.abs(offX) > 0.5;
  const useY = ["tl", "tr", "br", "bl", "tm", "bm"].includes(handle) && Math.abs(offY) > 0.5;
  const corner = ["tl", "tr", "br", "bl"].includes(handle);
  const r = before.rotation;
  const cos = Math.cos(r), sin = Math.sin(r);

  Tools.gesture = {
    move(e2, sx2, sy2) {
      const p = screenToProject(sx2, sy2);
      const vx = p.x - centerProj.x, vy = p.y - centerProj.y;
      const rx = vx * cos + vy * sin;     // un-rotate cursor vector
      const ry = -vx * sin + vy * cos;
      let kx = useX ? rx / offX : before.scaleX;
      let ky = useY ? ry / offY : before.scaleY;
      if (corner && !e2.shiftKey) {
        // keep aspect ratio (relative to starting scale)
        const bx = Math.abs(before.scaleX) < 0.001 ? 0.001 : before.scaleX;
        const by = Math.abs(before.scaleY) < 0.001 ? 0.001 : before.scaleY;
        const u = (Math.abs(kx / bx) + Math.abs(ky / by)) / 2;
        kx = before.scaleX * u;
        ky = before.scaleY * u;
      }
      const lim = v => Math.abs(v) < 0.01 ? (v < 0 ? -0.01 : 0.01) : v;
      layer.transform.scaleX = lim(kx);
      layer.transform.scaleY = lim(ky);
      if (typeof refreshPropsPanel === "function") refreshPropsPanel();
      requestRender();
    },
    up() { commitTransform(layer, before, "Scale layer"); }
  };
}

function startRotate(layer, sx, sy) {
  const before = snapshotTransform(layer);
  const cw = layer.canvas.width, ch = layer.canvas.height;
  const centerProj = { x: before.x + cw / 2, y: before.y + ch / 2 };
  const p0 = screenToProject(sx, sy);
  const a0 = Math.atan2(p0.y - centerProj.y, p0.x - centerProj.x);
  Tools.gesture = {
    move(e2, sx2, sy2) {
      const p = screenToProject(sx2, sy2);
      let rot = before.rotation + Math.atan2(p.y - centerProj.y, p.x - centerProj.x) - a0;
      if (e2.shiftKey) {
        const step = Math.PI / 12;
        rot = Math.round(rot / step) * step;
      }
      layer.transform.rotation = rot;
      if (typeof refreshPropsPanel === "function") refreshPropsPanel();
      requestRender();
    },
    up() { commitTransform(layer, before, "Rotate layer"); }
  };
}

/* ============ CROP ============ */

function beginCrop() {
  App.crop = { x: 0, y: 0, w: App.project.width, h: App.project.height };
  applyCropRatioPreset();
  updateCropInfo();
  requestRender(false);
}
function applyCropRatioPreset() {
  const r = App.options.cropRatio;
  if (!r || !App.crop) return;
  const p = App.project;
  let w = p.width, h = w / r;
  if (h > p.height) { h = p.height; w = h * r; }
  App.crop = { x: (p.width - w) / 2, y: (p.height - h) / 2, w, h };
  updateCropInfo();
  requestRender(false);
}
function updateCropInfo() {
  const el = document.getElementById("crop-info");
  if (el && App.crop) el.textContent = Math.round(App.crop.w) + " × " + Math.round(App.crop.h) + " px";
}

function cropHandlePoints() {
  const c = App.crop;
  const P = (x, y) => projectToScreen(x, y);
  const tl = P(c.x, c.y), tr = P(c.x + c.w, c.y), br = P(c.x + c.w, c.y + c.h), bl = P(c.x, c.y + c.h);
  return { tl, tr, br, bl, tm: mid(tl, tr), rm: mid(tr, br), bm: mid(br, bl), lm: mid(bl, tl) };
}
function hitCropHandle(sx, sy) {
  if (!App.crop) return null;
  const H = cropHandlePoints();
  const pt = { x: sx, y: sy };
  for (const k of ["tl", "tr", "br", "bl", "tm", "rm", "bm", "lm"]) {
    if (dist(pt, H[k]) <= HANDLE_R + 2) return k;
  }
  const p = screenToProject(sx, sy);
  const c = App.crop;
  if (p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h) return "body";
  return null;
}

function cropDown(e, sx, sy) {
  const p = screenToProject(sx, sy);
  const hit = hitCropHandle(sx, sy);
  const proj = App.project;

  if (hit === "body") {
    const c0 = { ...App.crop };
    Tools.gesture = {
      move(e2, sx2, sy2) {
        const dx = (sx2 - sx) / App.view.zoom, dy = (sy2 - sy) / App.view.zoom;
        App.crop.x = clamp(c0.x + dx, 0, proj.width - c0.w);
        App.crop.y = clamp(c0.y + dy, 0, proj.height - c0.h);
        updateCropInfo();
        requestRender(false);
      }
    };
    return;
  }

  let anchor, edge = null;
  if (hit) {
    const c = App.crop;
    if (["tm", "bm", "lm", "rm"].includes(hit)) {
      edge = hit;
      anchor = { x: c.x, y: c.y }; // unused for edges
    } else {
      anchor = {
        x: hit.includes("l") ? c.x + c.w : c.x,
        y: hit.startsWith("t") ? c.y + c.h : c.y
      };
    }
  } else {
    anchor = { x: clamp(p.x, 0, proj.width), y: clamp(p.y, 0, proj.height) };
    App.crop = { x: anchor.x, y: anchor.y, w: 0, h: 0 };
  }
  const c0 = { ...App.crop };
  const ratio = App.options.cropRatio;

  Tools.gesture = {
    move(e2, sx2, sy2) {
      const q = screenToProject(sx2, sy2);
      q.x = clamp(q.x, 0, proj.width);
      q.y = clamp(q.y, 0, proj.height);
      if (edge) {
        const c = { ...c0 };
        if (edge === "lm") { c.w = c0.x + c0.w - q.x; c.x = q.x; }
        if (edge === "rm") { c.w = q.x - c0.x; }
        if (edge === "tm") { c.h = c0.y + c0.h - q.y; c.y = q.y; }
        if (edge === "bm") { c.h = q.y - c0.y; }
        if (ratio) {
          const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
          if (edge === "lm" || edge === "rm") { c.h = c.w / ratio; c.y = cy - c.h / 2; }
          else { c.w = c.h * ratio; c.x = cx - c.w / 2; }
        }
        if (c.w > 2 && c.h > 2) App.crop = c;
      } else {
        let w = Math.abs(q.x - anchor.x), h = Math.abs(q.y - anchor.y);
        if (ratio) {
          if (w / ratio >= h) h = w / ratio; else w = h * ratio;
        }
        const signX = q.x >= anchor.x ? 1 : -1;
        const signY = q.y >= anchor.y ? 1 : -1;
        App.crop = {
          x: signX > 0 ? anchor.x : anchor.x - w,
          y: signY > 0 ? anchor.y : anchor.y - h,
          w, h
        };
      }
      // clamp inside project
      const c = App.crop;
      c.x = clamp(c.x, 0, proj.width); c.y = clamp(c.y, 0, proj.height);
      c.w = clamp(c.w, 0, proj.width - c.x); c.h = clamp(c.h, 0, proj.height - c.y);
      updateCropInfo();
      requestRender(false);
    }
  };
}

function applyCrop() {
  if (!App.crop || !App.project) return;
  const c = {
    x: Math.round(App.crop.x), y: Math.round(App.crop.y),
    w: Math.round(App.crop.w), h: Math.round(App.crop.h)
  };
  if (c.w < 1 || c.h < 1) { toast("Crop area is empty"); return; }
  const p = App.project;
  const before = { w: p.width, h: p.height };

  p.width = c.w; p.height = c.h;
  for (const l of p.layers) { l.transform.x -= c.x; l.transform.y -= c.y; }
  App.crop = null;

  commit("Crop",
    () => {
      p.width = before.w; p.height = before.h;
      for (const l of p.layers) { l.transform.x += c.x; l.transform.y += c.y; }
      fitView();
    },
    () => {
      p.width = c.w; p.height = c.h;
      for (const l of p.layers) { l.transform.x -= c.x; l.transform.y -= c.y; }
      fitView();
    });
  setTool("move");
  fitView();
  refreshAll();
  toast("Cropped to " + c.w + " × " + c.h);
}
function cancelCrop() { setTool("move"); }

/* ============ BRUSH / ERASER ============ */

function strokeDown(e, sx, sy) {
  const layer = activeLayer();
  if (!layer) return;
  if (layer.type === "text") { toast("Can't paint on a text layer — select an image layer"); return; }
  const erase = App.tool === "eraser";
  const opt = erase ? App.options.eraser : App.options.brush;
  const inv = layerMatrix(layer).inverse();

  const sc = makeCanvas(layer.canvas.width, layer.canvas.height);
  const sctx = sc.getContext("2d");
  sctx.setTransform(inv.a, inv.b, inv.c, inv.d, inv.e, inv.f);
  sctx.lineCap = "round";
  sctx.lineJoin = "round";
  sctx.strokeStyle = sctx.fillStyle = erase ? "#000" : App.color;
  sctx.lineWidth = opt.size;

  App.stroke = { layerId: layer.id, canvas: sc, alpha: opt.opacity / 100, erase };
  const start = screenToProject(sx, sy);
  const pts = [start];
  sctx.beginPath();
  sctx.arc(start.x, start.y, opt.size / 2, 0, Math.PI * 2);
  sctx.fill();
  requestRender();

  Tools.gesture = {
    move(e2, sx2, sy2) {
      const q = screenToProject(sx2, sy2);
      const last = pts[pts.length - 1];
      if (Math.hypot(q.x - last.x, q.y - last.y) * App.view.zoom < 1.5) return;
      pts.push(q);
      const n = pts.length;
      sctx.beginPath();
      if (n >= 3) {
        const p0 = pts[n - 3], p1 = pts[n - 2], p2 = pts[n - 1];
        const m0 = mid(p0, p1), m1 = mid(p1, p2);
        sctx.moveTo(m0.x, m0.y);
        sctx.quadraticCurveTo(p1.x, p1.y, m1.x, m1.y);
      } else {
        sctx.moveTo(pts[0].x, pts[0].y);
        sctx.lineTo(q.x, q.y);
      }
      sctx.stroke();
      requestRender();
    },
    up() { finishStroke(layer, sc, pts, opt, erase, inv); }
  };
}

function finishStroke(layer, sc, pts, opt, erase, inv) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    const lp = new DOMPoint(p.x, p.y).matrixTransform(inv);
    if (lp.x < minX) minX = lp.x;
    if (lp.y < minY) minY = lp.y;
    if (lp.x > maxX) maxX = lp.x;
    if (lp.y > maxY) maxY = lp.y;
  }
  const scaleMax = Math.max(Math.hypot(inv.a, inv.b), Math.hypot(inv.c, inv.d));
  const pad = (opt.size / 2 + 3) * scaleMax + 2;
  const rect = { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };

  const before = capturePatch(layer.canvas, rect);
  const ctx = layer.canvas.getContext("2d");
  ctx.save();
  ctx.globalAlpha = opt.opacity / 100;
  ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
  ctx.drawImage(sc, 0, 0);
  ctx.restore();
  App.stroke = null;
  bumpLayer(layer);

  const after = capturePatch(layer.canvas, rect);
  if (before && after) {
    commit(erase ? "Eraser stroke" : "Brush stroke",
      () => { applyPatch(layer.canvas, before); bumpLayer(layer); },
      () => { applyPatch(layer.canvas, after); bumpLayer(layer); });
  }
  requestRender();
  if (typeof refreshLayersPanel === "function") refreshLayersPanel();
}

/* ============ SHAPE ============ */

function shapeDown(e, sx, sy) {
  const layer = activeLayer();
  if (!layer) return;
  if (layer.type === "text") { toast("Can't draw on a text layer — select an image layer"); return; }
  const start = screenToProject(sx, sy);
  const st = { start, end: start, shift: e.shiftKey };
  Tools.shapePreview = st;
  Tools.gesture = {
    move(e2, sx2, sy2) {
      st.end = screenToProject(sx2, sy2);
      st.shift = e2.shiftKey;
      requestRender(false);
    },
    up() {
      Tools.shapePreview = null;
      commitShape(layer, st);
    }
  };
}

function shapeGeometry(st) {
  const o = App.options.shape;
  let { start, end } = st;
  if (o.kind === "line") {
    if (st.shift) {
      const dx = end.x - start.x, dy = end.y - start.y;
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      end = { x: start.x + Math.cos(ang) * len, y: start.y + Math.sin(ang) * len };
    }
    return { kind: "line", x1: start.x, y1: start.y, x2: end.x, y2: end.y };
  }
  let w = end.x - start.x, h = end.y - start.y;
  if (st.shift) {
    const s = Math.max(Math.abs(w), Math.abs(h));
    w = (w < 0 ? -1 : 1) * s;
    h = (h < 0 ? -1 : 1) * s;
  }
  return {
    kind: o.kind,
    x: Math.min(start.x, start.x + w), y: Math.min(start.y, start.y + h),
    w: Math.abs(w), h: Math.abs(h)
  };
}

function drawShapePath(ctx, g, o) {
  ctx.lineWidth = o.strokeWidth;
  ctx.fillStyle = o.fillColor;
  ctx.strokeStyle = o.strokeColor;
  ctx.beginPath();
  if (g.kind === "line") {
    ctx.moveTo(g.x1, g.y1);
    ctx.lineTo(g.x2, g.y2);
    ctx.stroke();
    return;
  }
  if (g.kind === "rect") ctx.rect(g.x, g.y, g.w, g.h);
  else ctx.ellipse(g.x + g.w / 2, g.y + g.h / 2, g.w / 2, g.h / 2, 0, 0, Math.PI * 2);
  const doFill = o.fill || !o.stroke;
  if (doFill) ctx.fill();
  if (o.stroke) ctx.stroke();
}

function commitShape(layer, st) {
  const o = App.options.shape;
  const g = shapeGeometry(st);
  if (g.kind !== "line" && (g.w < 1 || g.h < 1)) { requestRender(false); return; }
  if (g.kind === "line" && Math.hypot(g.x2 - g.x1, g.y2 - g.y1) < 1) { requestRender(false); return; }

  const inv = layerMatrix(layer).inverse();
  // bbox in layer space
  const cor = g.kind === "line"
    ? [[g.x1, g.y1], [g.x2, g.y2]]
    : [[g.x, g.y], [g.x + g.w, g.y], [g.x, g.y + g.h], [g.x + g.w, g.y + g.h]];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of cor) {
    const lp = new DOMPoint(x, y).matrixTransform(inv);
    minX = Math.min(minX, lp.x); minY = Math.min(minY, lp.y);
    maxX = Math.max(maxX, lp.x); maxY = Math.max(maxY, lp.y);
  }
  const scaleMax = Math.max(Math.hypot(inv.a, inv.b), Math.hypot(inv.c, inv.d));
  const pad = (o.strokeWidth + 3) * scaleMax + 2;
  const rect = { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };

  const before = capturePatch(layer.canvas, rect);
  const ctx = layer.canvas.getContext("2d");
  ctx.save();
  ctx.transform(inv.a, inv.b, inv.c, inv.d, inv.e, inv.f);
  drawShapePath(ctx, g, o);
  ctx.restore();
  bumpLayer(layer);
  const after = capturePatch(layer.canvas, rect);
  if (before && after) {
    commit("Shape",
      () => { applyPatch(layer.canvas, before); bumpLayer(layer); },
      () => { applyPatch(layer.canvas, after); bumpLayer(layer); });
  }
  requestRender();
  if (typeof refreshLayersPanel === "function") refreshLayersPanel();
}

/* ============ TEXT ============ */

function renderTextLayer(layer) {
  const t = layer.text;
  const ctx = layer.canvas.getContext("2d");
  ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
  ctx.font = (t.italic ? "italic " : "") + (t.bold ? "700 " : "400 ") + t.size + 'px "' + t.font + '"';
  ctx.fillStyle = t.color;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const lines = String(t.content || "").split("\n");
  const lh = t.size * 1.25;
  let maxW = 1;
  const widths = lines.map(l => {
    const w = ctx.measureText(l).width;
    if (w > maxW) maxW = w;
    return w;
  });
  lines.forEach((line, i) => {
    let x = t.anchorX;
    if (t.align === "center") x -= widths[i] / 2;
    if (t.align === "right") x -= widths[i];
    ctx.fillText(line, x, t.anchorY + i * lh);
  });
  let bx = t.anchorX;
  if (t.align === "center") bx -= maxW / 2;
  if (t.align === "right") bx -= maxW;
  layer.contentBounds = {
    x: bx - 4, y: t.anchorY - t.size,
    w: maxW + 8, h: lh * (lines.length - 1) + t.size * 1.35 + 8
  };
  bumpLayer(layer);
}

function textDown(e, sx, sy) {
  const p = screenToProject(sx, sy);
  const layer = activeLayer();
  // clicking inside an existing text layer selects it for editing
  const picked = pickLayerAt(p.x, p.y);
  if (picked && picked.type === "text") {
    App.activeLayerId = picked.id;
    refreshAll();
    selectTab("props");
    const ta = document.getElementById("text-content");
    if (ta) ta.focus();
    return;
  }
  createTextLayerAt(p.x, p.y);
}

function createTextLayerAt(x, y) {
  const p = App.project;
  const layer = createLayer("Text", p.width, p.height, "text");
  layer.text = {
    content: "Your text",
    font: App.options.text.font,
    size: App.options.text.size,
    color: App.options.text.color,
    bold: App.options.text.bold,
    italic: App.options.text.italic,
    align: App.options.text.align,
    anchorX: Math.round(x),
    anchorY: Math.round(y)
  };
  renderTextLayer(layer);
  const idx = Math.max(0, layerIndex(App.activeLayerId)) + 1;
  p.layers.splice(idx, 0, layer);
  App.activeLayerId = layer.id;
  commit("Add text layer",
    () => {
      const i = layerIndex(layer.id);
      if (i >= 0) p.layers.splice(i, 1);
    },
    () => {
      p.layers.splice(Math.min(idx, p.layers.length), 0, layer);
      App.activeLayerId = layer.id;
    });
  refreshAll();
  selectTab("props");
  const ta = document.getElementById("text-content");
  if (ta) { ta.focus(); ta.select(); }
}

/* ============ EYEDROPPER ============ */

function sampleColorAt(sx, sy) {
  const p = screenToProject(sx, sy);
  const comp = getComposite();
  const s = App._compScale;
  const x = Math.floor(p.x * s), y = Math.floor(p.y * s);
  if (x < 0 || y < 0 || x >= comp.width || y >= comp.height) return null;
  const d = comp.getContext("2d").getImageData(x, y, 1, 1).data;
  const hex = "#" + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, "0")).join("");
  setPrimaryColor(hex);
  const sw = document.getElementById("eyedrop-swatch");
  const hx = document.getElementById("eyedrop-hex");
  if (sw) sw.style.background = hex;
  if (hx) hx.textContent = hex;
  return hex;
}
function eyedropDown(e, sx, sy) {
  sampleColorAt(sx, sy);
  Tools.gesture = {
    move(e2, sx2, sy2) { sampleColorAt(sx2, sy2); }
  };
}
function setPrimaryColor(hex) {
  App.color = hex;
  for (const id of ["tool-color", "brush-color"]) {
    const el = document.getElementById(id);
    if (el) el.value = hex;
  }
  const bh = document.getElementById("brush-hex");
  if (bh) bh.value = hex;
}

/* ============ overlays ============ */

function drawToolOverlay(ctx) {
  if (!App.project) return;
  const accent = "#ff5c1a";

  if (App.tool === "move" && !App.stroke) {
    const layer = activeLayer();
    if (layer && layer.visible) {
      const H = moveHandlePoints(layer);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(H.tl.x, H.tl.y);
      ctx.lineTo(H.tr.x, H.tr.y);
      ctx.lineTo(H.br.x, H.br.y);
      ctx.lineTo(H.bl.x, H.bl.y);
      ctx.closePath();
      ctx.stroke();
      // rotate stem
      ctx.beginPath();
      ctx.moveTo(H.tm.x, H.tm.y);
      ctx.lineTo(H.rot.x, H.rot.y);
      ctx.stroke();
      for (const k of ["tl", "tr", "br", "bl", "tm", "rm", "bm", "lm"]) {
        drawHandle(ctx, H[k], accent, false);
      }
      drawHandle(ctx, H.rot, accent, true);
    }
  }

  if (App.tool === "crop" && App.crop) drawCropOverlay(ctx, accent);

  if (Tools.shapePreview) {
    const g = shapeGeometry(Tools.shapePreview);
    const o = App.options.shape;
    ctx.save();
    ctx.translate(App.view.x, App.view.y);
    ctx.scale(App.view.zoom, App.view.zoom);
    ctx.globalAlpha = 0.85;
    drawShapePath(ctx, g, o);
    ctx.restore();
  }

  if ((App.tool === "brush" || App.tool === "eraser") && Tools.pointerInside && !App.stroke) {
    const opt = App.tool === "eraser" ? App.options.eraser : App.options.brush;
    const r = Math.max(1.5, (opt.size / 2) * App.view.zoom);
    ctx.beginPath();
    ctx.arc(Tools.last.sx, Tools.last.sy, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawHandle(ctx, p, accent, round) {
  ctx.fillStyle = "#0c0d0f";
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (round) ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
  else ctx.rect(p.x - 3.5, p.y - 3.5, 7, 7);
  ctx.fill();
  ctx.stroke();
}

function drawCropOverlay(ctx, accent) {
  const c = App.crop;
  const a = projectToScreen(c.x, c.y);
  const b = projectToScreen(c.x + c.w, c.y + c.h);
  const wrap = document.getElementById("viewport-wrap");
  const W = wrap.clientWidth, Hh = wrap.clientHeight;
  ctx.fillStyle = "rgba(6,7,8,0.62)";
  ctx.fillRect(0, 0, W, a.y);
  ctx.fillRect(0, b.y, W, Hh - b.y);
  ctx.fillRect(0, a.y, a.x, b.y - a.y);
  ctx.fillRect(b.x, a.y, W - b.x, b.y - a.y);
  // border + thirds
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 2; i++) {
    const x = a.x + (b.x - a.x) * i / 3;
    const y = a.y + (b.y - a.y) * i / 3;
    ctx.beginPath(); ctx.moveTo(x, a.y); ctx.lineTo(x, b.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(a.x, y); ctx.lineTo(b.x, y); ctx.stroke();
  }
  const H = cropHandlePoints();
  for (const k of ["tl", "tr", "br", "bl", "tm", "rm", "bm", "lm"]) {
    drawHandle(ctx, H[k], accent, false);
  }
}
