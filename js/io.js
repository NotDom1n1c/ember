"use strict";
/* ============================================================
   EMBER io — open/import images, export, save/load projects
   ============================================================ */

let _fileMode = "open"; // "open" replaces the document, "import" adds layers
const LS_KEY = "ember.project.v1";

function initIO() {
  const input = document.getElementById("file-input");
  input.addEventListener("change", () => {
    openFiles([...input.files]);
    input.value = "";
  });

  // drag & drop anywhere on the window
  let dragDepth = 0;
  const overlay = document.getElementById("drop-overlay");
  window.addEventListener("dragenter", e => {
    e.preventDefault();
    dragDepth++;
    overlay.hidden = false;
  });
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) overlay.hidden = true;
  });
  window.addEventListener("drop", e => {
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    if (e.dataTransfer.files.length) {
      _fileMode = App.project ? "import-or-open" : "open";
      openFiles([...e.dataTransfer.files]);
    }
  });

  // paste image from clipboard
  document.addEventListener("paste", e => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type.indexOf("image/") === 0) {
        const f = it.getAsFile();
        if (f) {
          e.preventDefault();
          _fileMode = App.project ? "import" : "open";
          openFiles([f]);
          return;
        }
      }
    }
  });

  // export modal wiring
  document.getElementById("export-format").addEventListener("change", () => {
    updateExportUI();
    scheduleEstimate();
  });
  const q = document.getElementById("export-quality");
  q.addEventListener("input", () => {
    document.getElementById("export-quality-val").textContent = q.value;
    scheduleEstimate();
  });
  document.getElementById("btn-export-cancel").addEventListener("click", () =>
    document.getElementById("modal-export").hidden = true);
  document.getElementById("btn-export-download").addEventListener("click", downloadExport);
}

function pickFiles(mode) {
  _fileMode = mode;
  document.getElementById("file-input").click();
}

async function decodeImage(file) {
  try { return await createImageBitmap(file); }
  catch (e) {
    return await new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("decode failed")); };
      img.src = url;
    });
  }
}

async function openFiles(files) {
  const proj = files.find(f => /\.(ember|json)$/i.test(f.name) || f.type === "application/json");
  if (proj) { await openProjectFile(proj); return; }

  const imgs = files.filter(f => /^image\//.test(f.type));
  if (!imgs.length) { toast("Unsupported file type — use PNG, JPG, WebP or .ember"); return; }

  let first = true;
  for (const f of imgs) {
    let bmp;
    try { bmp = await decodeImage(f); }
    catch (e) { toast("Couldn't decode " + f.name); continue; }
    const name = f.name.replace(/\.[^.]+$/, "");
    const replace = !App.project || (_fileMode === "open" && first);
    if (replace) {
      if (App.project && App.dirty &&
        !confirm("Replace the current project? Unsaved changes will be lost.")) return;
      newProjectFromImage(bmp, name);
    } else {
      importImageAsLayer(bmp, name);
    }
    first = false;
  }
  _fileMode = "open";
}

function newProjectFromImage(bmp, name) {
  createProject(bmp.width, bmp.height, "transparent");
  const base = App.project.layers[0];
  base.name = name || "Background";
  base.canvas.getContext("2d").drawImage(bmp, 0, 0);
  bumpLayer(base);
  App.dirty = false;
  fitView();
  refreshAll();
  toast("Opened " + bmp.width + " × " + bmp.height + " px");
}

function importImageAsLayer(bmp, name) {
  const p = App.project;
  const layer = createLayer(name || "Imported", bmp.width, bmp.height);
  layer.canvas.getContext("2d").drawImage(bmp, 0, 0);
  layer.transform.x = Math.round((p.width - bmp.width) / 2);
  layer.transform.y = Math.round((p.height - bmp.height) / 2);
  const idx = p.layers.length;
  p.layers.push(layer);
  App.activeLayerId = layer.id;
  commit("Import layer",
    () => { const i = layerIndex(layer.id); if (i >= 0) p.layers.splice(i, 1); },
    () => { p.layers.splice(Math.min(idx, p.layers.length), 0, layer); App.activeLayerId = layer.id; });
  refreshAll();
  toast("Imported as layer: " + layer.name);
}

/* ============ export ============ */

const ExportState = { blob: null, timer: null };

function openExport() {
  if (!App.project) { toast("Nothing to export yet"); return; }
  document.getElementById("modal-export").hidden = false;
  document.getElementById("export-dims").textContent =
    App.project.width + " × " + App.project.height + " px";
  updateExportUI();
  scheduleEstimate();
}
function updateExportUI() {
  const fmt = document.getElementById("export-format").value;
  document.getElementById("export-quality-row").style.display =
    fmt === "image/png" ? "none" : "flex";
}
function scheduleEstimate() {
  if (document.getElementById("modal-export").hidden) return;
  clearTimeout(ExportState.timer);
  ExportState.blob = null;
  document.getElementById("export-size").textContent = "estimating…";
  ExportState.timer = setTimeout(buildExportBlob, 250);
}
function buildExportBlob(cb) {
  const fmt = document.getElementById("export-format").value;
  const q = (+document.getElementById("export-quality").value) / 100;
  // full-resolution composite — the preview cap never affects export
  const canvas = compositeProject(1, {
    background: fmt === "image/jpeg" ? "#ffffff" : null
  });
  canvas.toBlob(b => {
    ExportState.blob = b;
    document.getElementById("export-size").textContent = b ? "~ " + humanSize(b.size) : "—";
    if (cb) cb(b);
  }, fmt, q);
}
function downloadExport() {
  const doIt = blob => {
    if (!blob) { toast("Export failed — format may be unsupported"); return; }
    const fmt = document.getElementById("export-format").value;
    const ext = fmt === "image/png" ? ".png" : fmt === "image/jpeg" ? ".jpg" : ".webp";
    const name = (document.getElementById("export-name").value.trim() || "ember-export") + ext;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    document.getElementById("modal-export").hidden = true;
    toast("Exported " + name + " (" + humanSize(blob.size) + ")");
  };
  if (ExportState.blob) doIt(ExportState.blob);
  else buildExportBlob(doIt);
}

function humanSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(2) + " MB";
}

/* ============ project save / load ============ */

function serializeProject() {
  const p = App.project;
  return {
    app: "ember", version: 1,
    width: p.width, height: p.height,
    layers: p.layers.map(l => ({
      name: l.name, type: l.type, visible: l.visible,
      opacity: l.opacity, blendMode: l.blendMode,
      transform: { ...l.transform },
      filters: JSON.parse(JSON.stringify(l.filters)),
      text: l.text ? { ...l.text } : null,
      contentBounds: l.contentBounds ? { ...l.contentBounds } : null,
      canvasW: l.canvas.width, canvasH: l.canvas.height,
      data: l.type === "text" ? null : l.canvas.toDataURL("image/png")
    }))
  };
}

async function loadProjectData(data) {
  if (!data || data.app !== "ember" || !Array.isArray(data.layers)) {
    throw new Error("not an ember project");
  }
  const layers = [];
  for (const ld of data.layers) {
    const layer = createLayer(
      ld.name || "Layer",
      ld.canvasW || data.width, ld.canvasH || data.height,
      ld.type || "image");
    layer.visible = ld.visible !== false;
    layer.opacity = typeof ld.opacity === "number" ? ld.opacity : 100;
    layer.blendMode = ld.blendMode || "source-over";
    layer.transform = Object.assign({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, ld.transform);
    layer.filters = Object.assign(defaultFilters(), ld.filters);
    layer.text = ld.text ? { ...ld.text } : null;
    layer.contentBounds = ld.contentBounds ? { ...ld.contentBounds } : null;
    if (ld.data) {
      await new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => { layer.canvas.getContext("2d").drawImage(img, 0, 0); res(); };
        img.onerror = () => rej(new Error("layer image corrupt"));
        img.src = ld.data;
      });
    } else if (layer.type === "text" && layer.text) {
      renderTextLayer(layer);
    }
    layers.push(layer);
  }
  App.project = { width: data.width, height: data.height, layers };
  App.activeLayerId = layers.length ? layers[layers.length - 1].id : null;
  App.history.undo.length = 0;
  App.history.redo.length = 0;
  App.crop = null;
  App.stroke = null;
  App.dirty = false;
  updateHistoryUI();
  document.getElementById("welcome").style.display = "none";
  fitView();
  refreshAll();
}

async function openProjectFile(file) {
  try {
    const data = JSON.parse(await file.text());
    await loadProjectData(data);
    toast("Project loaded — " + App.project.layers.length + " layer(s)");
  } catch (err) {
    console.error(err);
    toast("Couldn't read that project file");
  }
}

function saveToBrowser() {
  if (!App.project) { toast("Nothing to save yet"); return; }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(serializeProject()));
    App.dirty = false;
    toast("Project saved to this browser");
  } catch (e) {
    toast("Browser storage is full — use “Download project file” instead");
  }
}

function downloadProjectFile() {
  if (!App.project) { toast("Nothing to save yet"); return; }
  const blob = new Blob([JSON.stringify(serializeProject())], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "project.ember";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  App.dirty = false;
  toast("Project file downloaded");
}

function checkResume() {
  let raw = null;
  try { raw = localStorage.getItem(LS_KEY); } catch (e) { /* storage blocked */ }
  if (!raw) return;
  const actions = document.querySelector(".welcome-actions");
  if (!actions) return;
  const btn = document.createElement("button");
  btn.className = "btn-ghost";
  btn.textContent = "Resume last session";
  btn.addEventListener("click", async () => {
    try {
      await loadProjectData(JSON.parse(raw));
      toast("Session restored");
    } catch (e) {
      console.error(e);
      toast("Saved session couldn't be restored");
    }
  });
  actions.appendChild(btn);
}
