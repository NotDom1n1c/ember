/* ============================================================
   EMBER — home page: live pixel demo, network monitor, embers
   ============================================================ */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------- procedural "photo": sunset dunes ---------------- */
  function paintScene(w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    const horizon = h * 0.58, sunX = w * 0.64, sunY = horizon - h * 0.02;

    const sky = g.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, "#1c1840");
    sky.addColorStop(0.45, "#6b2f5c");
    sky.addColorStop(0.78, "#e2633a");
    sky.addColorStop(1, "#ffc774");
    g.fillStyle = sky; g.fillRect(0, 0, w, horizon + 2);

    const halo = g.createRadialGradient(sunX, sunY, 0, sunX, sunY, w * 0.45);
    halo.addColorStop(0, "rgba(255,236,190,.95)");
    halo.addColorStop(0.08, "rgba(255,196,120,.8)");
    halo.addColorStop(0.3, "rgba(255,120,60,.25)");
    halo.addColorStop(1, "rgba(255,90,40,0)");
    g.fillStyle = halo; g.fillRect(0, 0, w, h);
    g.fillStyle = "#fff4dc";
    g.beginPath(); g.arc(sunX, sunY, h * 0.075, 0, Math.PI * 2); g.fill();

    // thin cloud streaks
    g.globalAlpha = 0.2;
    for (let i = 0; i < 7; i++) {
      const y = horizon * (0.25 + i * 0.08), x = (i * 0.37 % 1) * w;
      const cg = g.createLinearGradient(x - w * 0.3, 0, x + w * 0.3, 0);
      cg.addColorStop(0, "rgba(255,160,120,0)"); cg.addColorStop(0.5, "rgba(255,170,130,.7)"); cg.addColorStop(1, "rgba(255,160,120,0)");
      g.fillStyle = cg; g.fillRect(x - w * 0.3, y, w * 0.6, h * 0.006 + i * 0.4);
    }
    g.globalAlpha = 1;

    // dune layers, back to front
    const layers = [
      { base: 0.60, amp: 0.035, f: [1.3, 3.1], top: "#b8542d", bot: "#6e2a1e", rim: "rgba(255,200,140,.55)" },
      { base: 0.68, amp: 0.05, f: [0.9, 2.3], top: "#8c3a22", bot: "#3e1812", rim: "rgba(255,180,120,.45)" },
      { base: 0.78, amp: 0.06, f: [0.7, 1.9], top: "#5a2216", bot: "#1f0c09", rim: "rgba(255,150,90,.4)" },
      { base: 0.90, amp: 0.07, f: [0.5, 1.4], top: "#2a0f0a", bot: "#0c0504", rim: "rgba(255,120,70,.35)" },
    ];
    layers.forEach((L, li) => {
      const pts = [];
      for (let x = 0; x <= w; x += 4) {
        const t = x / w;
        const y = h * (L.base - L.amp * (Math.sin(t * Math.PI * L.f[0] + li * 1.7) * 0.7 + Math.sin(t * Math.PI * L.f[1] + li) * 0.3));
        pts.push([x, y]);
      }
      const top = Math.min(...pts.map(p => p[1]));
      const fill = g.createLinearGradient(0, top, 0, h);
      fill.addColorStop(0, L.top); fill.addColorStop(1, L.bot);
      g.beginPath(); g.moveTo(0, h);
      pts.forEach(([x, y]) => g.lineTo(x, y));
      g.lineTo(w, h); g.closePath();
      g.fillStyle = fill; g.fill();
      g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.strokeStyle = L.rim; g.lineWidth = Math.max(1, w / 900); g.stroke();
    });

    // a lone walker for scale
    g.fillStyle = "#0a0403";
    const px = w * 0.3, py = h * 0.757;
    g.fillRect(px, py - h * 0.035, w * 0.006, h * 0.035);
    g.beginPath(); g.arc(px + w * 0.003, py - h * 0.041, w * 0.0045, 0, Math.PI * 2); g.fill();

    // film grain
    const id = g.getImageData(0, 0, w, h), d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * 8;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    g.putImageData(id, 0, 0);
    return c;
  }

  /* ---------------- real pixel filters (ImageData math) ---------------- */
  const clamp = v => (v < 0 ? 0 : v > 255 ? 255 : v);
  const lut = fn => { const t = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) t[i] = clamp(fn(i / 255) * 255); return t; };
  const sCurve = k => x => 1 / (1 + Math.exp(-k * (x - 0.5)));
  const norm = (f, k) => { const a = f(0), b = f(1); return x => (f(x) - a) / (b - a); };

  const FX = {
    ember: {
      name: "EMBER GRADE",
      run(d, w, h) {
        const c = lut(norm(sCurve(6), 6));
        const cx = w / 2, cy = h / 2, md = Math.hypot(cx, cy);
        for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) {
          let r = c[d[i]] * 1.08 + 10, g = c[d[i + 1]] * 0.98, b = c[d[i + 2]] * 0.82;
          const v = 1 - 0.55 * Math.pow(Math.hypot(x - cx, y - cy) / md, 2.2);
          d[i] = clamp(r * v); d[i + 1] = clamp(g * v); d[i + 2] = clamp(b * v);
        }
      },
    },
    mono: {
      name: "SILVER GELATIN",
      run(d) {
        const c = lut(norm(sCurve(7), 7));
        for (let i = 0; i < d.length; i += 4) {
          const l = c[clamp(0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]) | 0]; // LUT index must be an integer
          d[i] = clamp(l + 6); d[i + 1] = l; d[i + 2] = clamp(l - 4);
        }
      },
    },
    cross: {
      name: "CROSS-PROCESS",
      run(d) {
        const R = lut(norm(sCurve(8), 8)), G = lut(x => Math.pow(x, 0.85)), B = lut(x => 0.18 + x * 0.6);
        for (let i = 0; i < d.length; i += 4) {
          const g = d[i + 1];
          d[i] = R[d[i]]; d[i + 1] = clamp(G[g] + 12); d[i + 2] = B[d[i + 2]];
        }
      },
    },
    duo: {
      name: "DUOTONE",
      run(d) {
        const a = [34, 18, 88], b = [255, 150, 70];
        for (let i = 0; i < d.length; i += 4) {
          const t = (0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]) / 255;
          d[i] = a[0] + (b[0] - a[0]) * t; d[i + 1] = a[1] + (b[1] - a[1]) * t; d[i + 2] = a[2] + (b[2] - a[2]) * t;
        }
      },
    },
    negative: {
      name: "NEGATIVE",
      run(d) { for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; } },
    },
    pixel: {
      name: "PIXELATE 14PX",
      run(d, w, h) {
        const s = Math.max(6, Math.round(w / 90));
        for (let by = 0; by < h; by += s) for (let bx = 0; bx < w; bx += s) {
          let r = 0, g = 0, b = 0, n = 0;
          const ey = Math.min(by + s, h), ex = Math.min(bx + s, w);
          for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) { const i = (y * w + x) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
          r /= n; g /= n; b /= n;
          for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) { const i = (y * w + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; }
        }
      },
    },
  };

  /* ---------------- demo stage ---------------- */
  const stage = $("#stage"), canvas = $("#demo"), ctx = canvas.getContext("2d");
  const split = $("#split"), knob = $("#knob");
  let W = 0, H = 0, source = null, original = null, edited = null;
  let fxKey = "ember", pos = 0.5, developing = 0; // developing: 0..1 fade from negative

  function sizeCanvas() {
    const r = stage.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = Math.min(1600, Math.round(r.width * dpr)); H = Math.round(W * r.height / r.width);
    canvas.width = W; canvas.height = H;
    $("[data-meta-size]").textContent = `${W} × ${H} PX`;
  }

  function coverDraw(img) {
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d");
    const iw = img.width, ih = img.height, s = Math.max(W / iw, H / ih);
    g.drawImage(img, (W - iw * s) / 2, (H - ih * s) / 2, iw * s, ih * s);
    return g.getImageData(0, 0, W, H);
  }

  function applyFx() {
    const t0 = performance.now();
    const out = new ImageData(new Uint8ClampedArray(original.data), W, H);
    FX[fxKey].run(out.data, W, H);
    edited = out;
    $("[data-fx-ms]").textContent = (performance.now() - t0).toFixed(1);
    $("[data-fx-px]").textContent = (W * H).toLocaleString("en-US");
    $("[data-fx-name]").textContent = FX[fxKey].name;
  }

  const bufA = document.createElement("canvas"), bufB = document.createElement("canvas");
  function render() {
    if (!original) return;
    bufA.width = bufB.width = W; bufA.height = bufB.height = H;
    bufA.getContext("2d").putImageData(original, 0, 0);
    bufB.getContext("2d").putImageData(edited, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(bufA, 0, 0);
    const sx = Math.round(W * pos);
    ctx.drawImage(bufB, sx, 0, W - sx, H, sx, 0, W - sx, H);
    if (developing < 1) { // "developing" the print: negative fades to positive
      ctx.save();
      ctx.globalCompositeOperation = "difference";
      ctx.fillStyle = `rgba(255,255,255,${1 - easeOut(developing)})`;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    split.style.left = pos * 100 + "%";
    knob.setAttribute("aria-valuenow", Math.round(pos * 100));
  }
  const easeOut = t => 1 - Math.pow(1 - t, 3);

  function load(img) {
    sizeCanvas();
    original = coverDraw(img);
    applyFx();
    render();
  }

  function develop() {
    if (reduced) { developing = 1; pos = 0.5; render(); split.classList.add("ready"); return; }
    const t0 = performance.now();
    pos = 1; // start fully original, then sweep the edit in
    (function step(now) {
      const t = Math.min(1, (now - t0) / 2600);
      developing = Math.min(1, t / 0.55);
      if (t > 0.5) pos = 1 - 0.5 * easeOut((t - 0.5) / 0.5);
      render();
      if (t > 0.5) split.classList.add("ready");
      if (t < 1) requestAnimationFrame(step);
    })(t0);
  }

  // drag to compare
  function setPos(clientX) {
    const r = stage.getBoundingClientRect();
    pos = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    render();
  }
  stage.addEventListener("pointerdown", e => {
    if (!split.classList.contains("ready")) return;
    stage.setPointerCapture(e.pointerId); stage.classList.add("dragging"); setPos(e.clientX);
  });
  stage.addEventListener("pointermove", e => { if (stage.classList.contains("dragging")) setPos(e.clientX); });
  const endDrag = () => stage.classList.remove("dragging");
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  knob.addEventListener("keydown", e => {
    const k = { ArrowLeft: -0.04, ArrowRight: 0.04, Home: -1, End: 1 }[e.key];
    if (k == null) return;
    e.preventDefault(); pos = Math.min(1, Math.max(0, pos + k)); render();
  });

  // filter chips
  $$(".fx").forEach(b => b.addEventListener("click", () => {
    if (!original || b.dataset.fx === fxKey) return;
    $$(".fx").forEach(x => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); });
    fxKey = b.dataset.fx;
    b.classList.add("busy");
    requestAnimationFrame(() => { applyFx(); render(); b.classList.remove("busy"); bumpLocal(); });
  }));

  // user photo: file picker + drag & drop (stays local, decoded by the browser)
  let localCount = 1;
  function bumpLocal() { localCount++; $("[data-local-count]").textContent = localCount; }
  function takeFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      source = img; load(img); URL.revokeObjectURL(url);
      bumpLocal();
      log(`decoded “${file.name}” locally · ${(file.size / 1024).toFixed(0)} KB · 0 B sent`, "ok");
      stage.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
    };
    img.src = url;
  }
  $("#demo-file").addEventListener("change", e => takeFile(e.target.files[0]));
  ["dragenter", "dragover"].forEach(t => stage.addEventListener(t, e => { e.preventDefault(); stage.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach(t => stage.addEventListener(t, e => { e.preventDefault(); stage.classList.remove("dragover"); }));
  stage.addEventListener("drop", e => takeFile(e.dataTransfer.files[0]));

  let rT;
  addEventListener("resize", () => {
    clearTimeout(rT);
    rT = setTimeout(() => {
      const r = stage.getBoundingClientRect();
      if (Math.abs(Math.round(Math.min(1600, r.width * Math.min(devicePixelRatio || 1, 2))) - W) > 40) load(source);
    }, 200);
  });

  sizeCanvas();
  source = paintScene(W, H);
  load(source);
  develop();

  /* ---------------- scroll reveals ---------------- */
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add("seen"); io.unobserve(e.target); }
  }), { threshold: 0.2 });
  $$(".frame").forEach(f => io.observe(f));

  /* ---------------- real network monitor ---------------- */
  const logEl = $("[data-net-log]");
  const hhmmss = d => d.toTimeString().slice(0, 8);
  function log(msg, cls = "") {
    const li = document.createElement("li");
    li.innerHTML = `<time>${hhmmss(new Date())}</time><span class="${cls}"></span>`;
    li.lastChild.textContent = msg;
    logEl.appendChild(li); logEl.scrollTop = logEl.scrollHeight;
  }
  let netCount = 0, boot = 0;
  function startMonitor() {
    boot = performance.now();
    $("[data-boot-time]").textContent = hhmmss(new Date());
    if ("PerformanceObserver" in window) {
      try {
        new PerformanceObserver(list => list.getEntries().forEach(en => {
          if (en.startTime < boot || /^(blob|data):/.test(en.name)) return;
          netCount++;
          $$("[data-net-count]").forEach(el => (el.textContent = netCount));
          $$("[data-net-word]").forEach(el => (el.textContent = netCount === 1 ? "request" : "requests"));
          let host = en.name; try { host = new URL(en.name).host; } catch {}
          log(`GET ${host} (${en.initiatorType}) · download only`, "warn");
          pulse = 1;
        })).observe({ type: "resource", buffered: false });
      } catch {}
    }
    setInterval(() => {
      const s = Math.floor((performance.now() - boot) / 1000);
      $("[data-uptime]").textContent = [s / 3600, (s % 3600) / 60, s % 60].map(v => String(Math.floor(v)).padStart(2, "0")).join(":");
    }, 1000);
  }
  // start listening once the page and its web fonts are fully loaded, so only later traffic is counted
  const loaded = document.readyState === "complete" ? Promise.resolve() : new Promise(r => addEventListener("load", r, { once: true }));
  const faces = ['800 1em "Bricolage Grotesque"', '700 1em "Bricolage Grotesque"', '400 1em "Instrument Sans"',
    '600 1em "Instrument Sans"', 'italic 1em "Instrument Serif"', '400 1em "JetBrains Mono"', '500 1em "JetBrains Mono"'];
  const fontsIn = document.fonts ? Promise.all(faces.map(f => document.fonts.load(f).catch(() => null))) : null;
  Promise.all([loaded, fontsIn]).then(startMonitor);

  // oscilloscope: flat line (spikes only if a real request happens)
  const scope = $("#scope"), sg = scope.getContext("2d");
  let pulse = 0, phase = 0;
  function drawScope() {
    const r = scope.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
    if (scope.width !== Math.round(r.width * dpr)) { scope.width = Math.round(r.width * dpr); scope.height = Math.round(r.height * dpr); }
    const w = scope.width, h = scope.height;
    sg.clearRect(0, 0, w, h);
    sg.beginPath();
    for (let x = 0; x <= w; x += 3) {
      const t = x / w;
      const spike = pulse * Math.exp(-Math.pow((t - 0.85) * 18, 2)) * h * 0.38 * Math.sin(t * 90);
      const y = h / 2 + Math.sin(t * 40 + phase) * 0.6 * dpr + spike;
      x ? sg.lineTo(x, y) : sg.moveTo(x, y);
    }
    sg.strokeStyle = "#58c98b"; sg.lineWidth = 1.6 * dpr; sg.shadowColor = "#58c98b"; sg.shadowBlur = 10 * dpr; sg.stroke();
    // sweep dot
    const sx = ((phase * 40) % w + w) % w;
    sg.fillStyle = "#b8ffd8"; sg.beginPath(); sg.arc(sx, h / 2, 2.5 * dpr, 0, Math.PI * 2); sg.fill();
    phase += 0.05; pulse *= 0.96;
    requestAnimationFrame(drawScope);
  }
  drawScope();

  /* ---------------- rising embers in the finale ---------------- */
  const ec = $("#embers"), eg = ec.getContext("2d");
  let parts = [], running = false;
  function sizeEmbers() { const r = ec.getBoundingClientRect(); ec.width = r.width; ec.height = r.height; }
  function spawn() {
    return { x: Math.random() * ec.width, y: ec.height + 10, r: Math.random() * 2.2 + 0.6, vy: Math.random() * 0.9 + 0.4, vx: (Math.random() - 0.5) * 0.4, life: 1, w: Math.random() * 6 };
  }
  function tickEmbers() {
    if (!running) return;
    eg.clearRect(0, 0, ec.width, ec.height);
    if (parts.length < 90) parts.push(spawn());
    parts.forEach(p => {
      p.y -= p.vy; p.w += 0.03; p.x += p.vx + Math.sin(p.w) * 0.35; p.life -= 0.0028;
      const a = Math.max(0, p.life) * Math.min(1, (ec.height - p.y) / 80);
      eg.beginPath(); eg.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      eg.fillStyle = `rgba(255,${120 + p.r * 40 | 0},60,${a})`;
      eg.shadowColor = "rgba(255,92,26,.9)"; eg.shadowBlur = 12; eg.fill();
    });
    parts = parts.filter(p => p.life > 0 && p.y > -10);
    requestAnimationFrame(tickEmbers);
  }
  if (!reduced) {
    sizeEmbers(); addEventListener("resize", sizeEmbers);
    new IntersectionObserver(([e]) => {
      const was = running; running = e.isIntersecting;
      if (running && !was) tickEmbers();
    }).observe(ec);
  }
})();
