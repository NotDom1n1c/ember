"use strict";
/* ============================================================
   EMBER main — bootstrap, top bar, modals, keyboard shortcuts
   ============================================================ */

function updateStatus() {
  const dims = document.getElementById("status-dims");
  const lay = document.getElementById("status-layer");
  dims.textContent = App.project
    ? App.project.width + " × " + App.project.height + " px"
    : "no document";
  const l = activeLayer();
  lay.textContent = l ? l.name : "—";
  document.title = App.project
    ? "Ember — " + App.project.width + "×" + App.project.height
    : "Ember — Editor";
}
function updateCursorStatus(p) {
  document.getElementById("status-cursor").textContent =
    Math.round(p.x) + ", " + Math.round(p.y);
}

function openModal(id) { document.getElementById(id).hidden = false; }
function closeModal(id) { document.getElementById(id).hidden = true; }

function isTypingTarget(el) {
  return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" || el.isContentEditable);
}

function init() {
  initTools();
  initPanels();
  initIO();

  // ---- left toolbar ----
  document.querySelectorAll(".tool-btn").forEach(b =>
    b.addEventListener("click", () => setTool(b.dataset.tool)));

  // ---- top bar: file ----
  document.getElementById("btn-new").addEventListener("click", () => openModal("modal-new"));
  document.getElementById("btn-new-cancel").addEventListener("click", () => closeModal("modal-new"));
  document.getElementById("btn-new-create").addEventListener("click", () => {
    const w = clamp(Math.round(+document.getElementById("new-width").value) || 1920, 1, 8000);
    const h = clamp(Math.round(+document.getElementById("new-height").value) || 1080, 1, 8000);
    if (App.project && App.dirty &&
      !confirm("Discard unsaved changes and start a new project?")) return;
    createProject(w, h, document.getElementById("new-bg").value);
    closeModal("modal-new");
  });
  document.querySelectorAll("#modal-new [data-preset]").forEach(b =>
    b.addEventListener("click", () => {
      const [w, h] = b.dataset.preset.split("x");
      document.getElementById("new-width").value = w;
      document.getElementById("new-height").value = h;
    }));

  document.getElementById("btn-open").addEventListener("click", () => pickFiles("open"));
  document.getElementById("btn-import").addEventListener("click", () => {
    if (!App.project) { toast("Open or create a document first"); return; }
    pickFiles("import");
  });

  // save dropdown
  const saveMenu = document.getElementById("save-menu");
  document.getElementById("btn-save").addEventListener("click", e => {
    e.stopPropagation();
    saveMenu.hidden = !saveMenu.hidden;
  });
  document.addEventListener("click", () => { saveMenu.hidden = true; });
  saveMenu.addEventListener("click", e => e.stopPropagation());
  document.getElementById("btn-save-browser").addEventListener("click", () => {
    saveMenu.hidden = true;
    saveToBrowser();
  });
  document.getElementById("btn-save-file").addEventListener("click", () => {
    saveMenu.hidden = true;
    downloadProjectFile();
  });

  document.getElementById("btn-export").addEventListener("click", openExport);

  // ---- history + zoom ----
  document.getElementById("btn-undo").addEventListener("click", doUndo);
  document.getElementById("btn-redo").addEventListener("click", doRedo);
  document.getElementById("btn-zoom-in").addEventListener("click", () => setZoom(App.view.zoom * 1.25));
  document.getElementById("btn-zoom-out").addEventListener("click", () => setZoom(App.view.zoom / 1.25));
  document.getElementById("zoom-level").addEventListener("click", fitView);

  // ---- welcome ----
  document.getElementById("btn-welcome-open").addEventListener("click", () => pickFiles("open"));
  document.getElementById("btn-welcome-new").addEventListener("click", () => openModal("modal-new"));
  checkResume();

  // click outside a modal closes it
  document.querySelectorAll(".modal-backdrop").forEach(m => {
    m.addEventListener("pointerdown", e => {
      if (e.target !== m) return;
      if (m.id === "modal-curves") closeCurves(true);
      else m.hidden = true;
    });
  });

  // ---- keyboard ----
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", e => {
    if (e.code === "Space") { Tools.spaceDown = false; updateCanvasCursor(); }
  });
  window.addEventListener("beforeunload", e => {
    if (App.dirty) { e.preventDefault(); e.returnValue = ""; }
  });

  updateStatus();
  updateHistoryUI();
  requestRender();
}

function onKeyDown(e) {
  const typing = isTypingTarget(document.activeElement);

  if (e.code === "Space" && !typing) {
    if (!Tools.spaceDown) { Tools.spaceDown = true; updateCanvasCursor(); }
    e.preventDefault();
    return;
  }
  if (e.key === "Escape") {
    const curves = document.getElementById("modal-curves");
    if (!curves.hidden) { closeCurves(true); return; }
    for (const id of ["modal-new", "modal-export"]) {
      const m = document.getElementById(id);
      if (!m.hidden) { m.hidden = true; return; }
    }
    if (App.tool === "crop") { cancelCrop(); return; }
    if (typing) document.activeElement.blur();
    return;
  }
  if (typing) return;

  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl) {
    switch (e.key.toLowerCase()) {
      case "z": e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return;
      case "y": e.preventDefault(); doRedo(); return;
      case "s": e.preventDefault(); saveToBrowser(); return;
      case "e": e.preventDefault(); openExport(); return;
      case "o": e.preventDefault(); pickFiles("open"); return;
      case "j": e.preventDefault(); duplicateActiveLayer(); return;
    }
    return;
  }

  switch (e.key) {
    case "v": case "V": setTool("move"); break;
    case "c": case "C": if (App.project) setTool("crop"); break;
    case "b": case "B": setTool("brush"); break;
    case "e": case "E": setTool("eraser"); break;
    case "u": case "U": setTool("shape"); break;
    case "t": case "T": setTool("text"); break;
    case "i": case "I": setTool("eyedropper"); break;
    case "+": case "=": setZoom(App.view.zoom * 1.25); break;
    case "-": case "_": setZoom(App.view.zoom / 1.25); break;
    case "0": fitView(); break;
    case "1": setZoom(1); break;
    case "[": case "]": {
      const opt = App.tool === "eraser" ? App.options.eraser : App.options.brush;
      const step = Math.max(1, Math.round(opt.size * 0.15));
      opt.size = clamp(opt.size + (e.key === "]" ? step : -step), 1, 250);
      refreshPropsPanel();
      requestRender(false);
      break;
    }
    case "Delete": case "Backspace": deleteActiveLayer(); break;
    case "Enter": if (App.tool === "crop" && App.crop) applyCrop(); break;
  }
}

document.addEventListener("DOMContentLoaded", init);
