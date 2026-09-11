"use strict";
/* ============================================================
   EMBER filters — real pixel math on ImageData
   ============================================================ */

function defaultFilters() {
  return {
    brightness: 0, contrast: 0, saturation: 0, hue: 0,
    blur: 0,
    grayscale: false, sepia: false, invert: false,
    curves: null // { rgb:[[x,y],...], r:[...], g:[...], b:[...] }
  };
}

function defaultCurvePoints() { return [[0, 0], [255, 255]]; }

function curveIsIdentity(pts) {
  return !pts || (pts.length === 2 &&
    pts[0][0] === 0 && pts[0][1] === 0 &&
    pts[1][0] === 255 && pts[1][1] === 255);
}
function curvesActive(c) {
  if (!c) return false;
  return ["rgb", "r", "g", "b"].some(ch => !curveIsIdentity(c[ch]));
}

function filtersActive(f) {
  return !!(f && (
    f.brightness || f.contrast || f.saturation || f.hue || f.blur ||
    f.grayscale || f.sepia || f.invert || curvesActive(f.curves)
  ));
}

/* ---------- color matrices (hue rotate / saturation) ---------- */

function hueMatrix(deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072
  ];
}
function satMatrix(s) {
  return [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s
  ];
}
function mat3mul(A, B) {
  const M = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      M[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    }
  }
  return M;
}

/* ---------- curves: monotone cubic (Fritsch–Carlson) LUT ---------- */

function curveLUT(points) {
  const pts = (points && points.length >= 2 ? points : defaultCurvePoints())
    .slice().sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const dx = [], dy = [], slope = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(xs[i + 1] - xs[i] || 1e-6);
    dy.push(ys[i + 1] - ys[i]);
    slope.push(dy[i] / dx[i]);
  }
  const m = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = (slope[i - 1] * slope[i] <= 0) ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / slope[i], b = m[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }
  const lut = new Uint8ClampedArray(256);
  let seg = 0;
  for (let v = 0; v < 256; v++) {
    if (v <= xs[0]) { lut[v] = ys[0]; continue; }
    if (v >= xs[n - 1]) { lut[v] = ys[n - 1]; continue; }
    while (seg < n - 2 && v > xs[seg + 1]) seg++;
    const h = dx[seg];
    const t = (v - xs[seg]) / h;
    const t2 = t * t, t3 = t2 * t;
    const val =
      ys[seg] * (2 * t3 - 3 * t2 + 1) +
      m[seg] * h * (t3 - 2 * t2 + t) +
      ys[seg + 1] * (-2 * t3 + 3 * t2) +
      m[seg + 1] * h * (t3 - t2);
    lut[v] = val;
  }
  return lut;
}

function buildCurvesLUTs(curves) {
  const master = curveLUT(curves.rgb);
  const chR = curveLUT(curves.r), chG = curveLUT(curves.g), chB = curveLUT(curves.b);
  const r = new Uint8ClampedArray(256), g = new Uint8ClampedArray(256), b = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    r[v] = chR[master[v]];
    g[v] = chG[master[v]];
    b[v] = chB[master[v]];
  }
  return { r, g, b };
}

/* ---------- main pixel pass ---------- */

function applyPixelFilters(d, f) {
  const useMatrix = f.hue !== 0 || f.saturation !== 0;
  let m = null;
  if (useMatrix) {
    m = mat3mul(hueMatrix(f.hue || 0), satMatrix(1 + (f.saturation || 0) / 100));
  }
  const br = (f.brightness || 0) * 1.5;
  const c255 = (f.contrast || 0) * 2.55;
  const cf = f.contrast ? (259 * (c255 + 255)) / (255 * (259 - c255)) : 1;
  const lut = curvesActive(f.curves) ? buildCurvesLUTs(f.curves) : null;
  const gs = f.grayscale, sep = f.sepia, inv = f.invert;

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];
    if (m) {
      const nr = m[0] * r + m[1] * g + m[2] * b;
      const ng = m[3] * r + m[4] * g + m[5] * b;
      const nb = m[6] * r + m[7] * g + m[8] * b;
      r = nr; g = ng; b = nb;
    }
    if (cf !== 1) {
      r = (r - 128) * cf + 128;
      g = (g - 128) * cf + 128;
      b = (b - 128) * cf + 128;
    }
    if (br) { r += br; g += br; b += br; }
    if (gs) {
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = l; g = l; b = l;
    }
    if (sep) {
      const nr = 0.393 * r + 0.769 * g + 0.189 * b;
      const ng = 0.349 * r + 0.686 * g + 0.168 * b;
      const nb = 0.272 * r + 0.534 * g + 0.131 * b;
      r = nr; g = ng; b = nb;
    }
    if (inv) { r = 255 - r; g = 255 - g; b = 255 - b; }
    r = r < 0 ? 0 : r > 255 ? 255 : r;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    b = b < 0 ? 0 : b > 255 ? 255 : b;
    if (lut) { r = lut.r[r | 0]; g = lut.g[g | 0]; b = lut.b[b | 0]; }
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
}

/* ---------- box blur (2 iterations ≈ gaussian), premultiplied alpha ---------- */

function blurChannelPass(src, dst, w, h, r) {
  // horizontal
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + clamp(x, 0, w - 1)];
    const div = r * 2 + 1;
    for (let x = 0; x < w; x++) {
      dst[row + x] = sum / div;
      sum += src[row + clamp(x + r + 1, 0, w - 1)] - src[row + clamp(x - r, 0, w - 1)];
    }
  }
  // vertical (dst -> src)
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += dst[clamp(y, 0, h - 1) * w + x];
    const div = r * 2 + 1;
    for (let y = 0; y < h; y++) {
      src[y * w + x] = sum / div;
      sum += dst[clamp(y + r + 1, 0, h - 1) * w + x] - dst[clamp(y - r, 0, h - 1) * w + x];
    }
  }
}

function boxBlur(img, w, h, radius) {
  const r = Math.max(1, Math.round(radius));
  const d = img.data;
  const n = w * h;
  const chan = new Float32Array(n);
  const tmp = new Float32Array(n);
  const alpha = new Float32Array(n);

  for (let i = 0, j = 3; i < n; i++, j += 4) alpha[i] = d[j] / 255;

  // premultiplied RGB channels
  for (let ch = 0; ch < 3; ch++) {
    for (let i = 0, j = ch; i < n; i++, j += 4) chan[i] = d[j] * alpha[i];
    blurChannelPass(chan, tmp, w, h, r);
    blurChannelPass(chan, tmp, w, h, r);
    for (let i = 0, j = ch; i < n; i++, j += 4) d[j] = chan[i]; // unpremultiply after alpha pass
  }
  // alpha channel
  for (let i = 0; i < n; i++) chan[i] = alpha[i] * 255;
  blurChannelPass(chan, tmp, w, h, r);
  blurChannelPass(chan, tmp, w, h, r);
  for (let i = 0, j = 3; i < n; i++, j += 4) d[j] = chan[i];
  // unpremultiply RGB using blurred alpha
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = d[j + 3] / 255;
    if (a > 0.0001) {
      d[j] = Math.min(255, d[j] / a);
      d[j + 1] = Math.min(255, d[j + 1] / a);
      d[j + 2] = Math.min(255, d[j + 2] / a);
    }
  }
}

/* ---------- entry point used by the render cache ---------- */

function applyFiltersToCanvas(src, f) {
  const out = makeCanvas(src.width, src.height);
  const ctx = out.getContext("2d");
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  applyPixelFilters(img.data, f);
  if (f.blur > 0) boxBlur(img, out.width, out.height, f.blur);
  ctx.putImageData(img, 0, 0);
  return out;
}
