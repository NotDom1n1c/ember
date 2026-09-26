"use strict";
/* ============================================================
   EMBER image — whole-document resize / rotate / flip, layer flip
   All operations only touch layer transforms + document size,
   so they are lossless and fully undoable.
   ============================================================ */

function docSnapshot() {
  const p = App.project;
  return { w: p.width, h: p.height, t: p.layers.map(l => ({ l, t: { ...l.transform } })) };
}
function docRestore(s) {
  App.project.width = s.w;
  App.project.height = s.h;
  for (const { l, t } of s.t) l.transform = { ...t };
}

/* run fn(layer, center) for every layer, where center = layer centre in document space,
   then record one undo step */
function transformDocument(label, newW, newH, fn) {
  if (!App.project) return;
  if (App.tool === "crop") setTool("move");
  const p = App.project;
  const before = docSnapshot();
  for (const l of p.layers) {
    const cw = l.canvas.width / 2, ch = l.canvas.height / 2;
    const c = fn(l, { x: l.transform.x + cw, y: l.transform.y + ch });
    l.transform.x = c.x - cw;
    l.transform.y = c.y - ch;
  }
  p.width = Math.max(1, Math.round(newW));
  p.height = Math.max(1, Math.round(newH));
  const after = docSnapshot();
  commit(label,
    () => { docRestore(before); fitView(); },
    () => { docRestore(after); fitView(); });
  fitView();
  refreshAll();
}

function rotateImage(dir) {
  const p = App.project;
  if (!p) return;
  const W = p.width, H = p.height, q = Math.PI / 2;
  transformDocument(dir > 0 ? "Rotate 90° CW" : "Rotate 90° CCW", H, W, (l, c) => {
    l.transform.rotation += dir > 0 ? q : -q;
    return dir > 0 ? { x: H - c.y, y: c.x } : { x: c.y, y: W - c.x };
  });
}

function flipImage(axis) {
  const p = App.project;
  if (!p) return;
  const W = p.width, H = p.height;
  transformDocument(axis === "x" ? "Flip horizontal" : "Flip vertical", W, H, (l, c) => {
    l.transform.rotation = -l.transform.rotation;
    if (axis === "x") { l.transform.scaleX = -l.transform.scaleX; return { x: W - c.x, y: c.y }; }
    l.transform.scaleY = -l.transform.scaleY;
    return { x: c.x, y: H - c.y };
  });
}

function resizeImage(w, h) {
  const p = App.project;
  if (!p) return;
  const kx = w / p.width, ky = h / p.height;
  if (Math.abs(kx - 1) < 1e-6 && Math.abs(ky - 1) < 1e-6) return;
  transformDocument("Resize image", w, h, (l, c) => {
    l.transform.scaleX *= kx;
    l.transform.scaleY *= ky;
    return { x: c.x * kx, y: c.y * ky };
  });
  toast("Resized to " + p.width + " × " + p.height + " px");
}

function flipLayer(axis) {
  const l = activeLayer();
  if (!l) return;
  const before = { ...l.transform };
  if (axis === "x") l.transform.scaleX = -l.transform.scaleX;
  else l.transform.scaleY = -l.transform.scaleY;
  commitTransform(l, before, axis === "x" ? "Flip layer horizontal" : "Flip layer vertical");
  refreshPropsPanel();
  requestRender();
}

/* ============ resize modal ============ */

function openResize() {
  if (!App.project) { toast("Open or create a document first"); return; }
  document.getElementById("resize-w").value = App.project.width;
  document.getElementById("resize-h").value = App.project.height;
  openModal("modal-resize");
}

function initImageOps() {
  const on = (id, fn) => document.getElementById(id).addEventListener("click", () => {
    document.getElementById("image-menu").hidden = true;
    if (!App.project) { toast("Open or create a document first"); return; }
    fn();
  });
  on("img-resize", openResize);
  on("img-rot-cw", () => rotateImage(1));
  on("img-rot-ccw", () => rotateImage(-1));
  on("img-flip-x", () => flipImage("x"));
  on("img-flip-y", () => flipImage("y"));
  document.getElementById("btn-layer-flip-x").addEventListener("click", () => flipLayer("x"));
  document.getElementById("btn-layer-flip-y").addEventListener("click", () => flipLayer("y"));

  const rw = document.getElementById("resize-w"), rh = document.getElementById("resize-h");
  const lock = document.getElementById("resize-lock");
  rw.addEventListener("input", () => {
    if (lock.checked && App.project) rh.value = Math.max(1, Math.round(rw.value * App.project.height / App.project.width));
  });
  rh.addEventListener("input", () => {
    if (lock.checked && App.project) rw.value = Math.max(1, Math.round(rh.value * App.project.width / App.project.height));
  });
  document.querySelectorAll("#modal-resize [data-pct]").forEach(b => b.addEventListener("click", () => {
    const k = +b.dataset.pct / 100;
    rw.value = Math.max(1, Math.round(App.project.width * k));
    rh.value = Math.max(1, Math.round(App.project.height * k));
  }));
  document.getElementById("btn-resize-cancel").addEventListener("click", () => closeModal("modal-resize"));
  document.getElementById("btn-resize-apply").addEventListener("click", () => {
    const w = clamp(Math.round(+rw.value) || 0, 1, 12000), h = clamp(Math.round(+rh.value) || 0, 1, 12000);
    closeModal("modal-resize");
    resizeImage(w, h);
  });
}
