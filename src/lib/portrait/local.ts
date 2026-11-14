/**
 * Free, on-device portrait finishing. Nothing is uploaded and nothing is paid
 * for. Two small Google MediaPipe models (person cut-out + face detector) are
 * downloaded into the visitor's browser on first use; if they can't load, every
 * pass falls back to plain pixel maths.
 */
import type { StepId } from "@/lib/portrait/prompts";

export const LOCAL_PLAN: StepId[] = ["clean", "backdrop", "light", "retouch", "polish"];

export type Look = "natural" | "warm" | "cool" | "mono";
export type BackdropId = "bone" | "sage" | "slate" | "blush" | "charcoal" | "white";
export type Options = {
  backdrop: BackdropId;
  replaceBg: boolean;
  look: Look;
  retouch: number; // 0..1
  light: number; // 0..1
};

export const DEFAULT_OPTIONS: Options = {
  backdrop: "bone",
  replaceBg: true,
  look: "natural",
  retouch: 0.6,
  light: 0.7,
};

type RGB = [number, number, number];
export const BACKDROPS: Record<BackdropId, { label: string; center: RGB; edge: RGB }> = {
  bone: { label: "Bone", center: [243, 235, 223], edge: [221, 210, 195] },
  sage: { label: "Sage", center: [208, 218, 203], edge: [165, 181, 164] },
  slate: { label: "Slate", center: [156, 168, 184], edge: [102, 114, 132] },
  blush: { label: "Blush", center: [242, 222, 218], edge: [220, 188, 184] },
  charcoal: { label: "Charcoal", center: [104, 104, 108], edge: [48, 48, 52] },
  white: { label: "White", center: [253, 253, 253], edge: [230, 230, 232] },
};
export const LOOKS: { id: Look; label: string }[] = [
  { id: "natural", label: "Natural" },
  { id: "warm", label: "Warm" },
  { id: "cool", label: "Cool" },
  { id: "mono", label: "Mono" },
];

export type Analysis = {
  /** Person probability 0..1 at the model's own resolution. */
  mask: { w: number; h: number; data: Float32Array } | null;
  /** Face box, normalised 0..1 (centre + size). */
  face: { cx: number; cy: number; w: number; h: number } | null;
  ai: boolean;
};
export const EMPTY_ANALYSIS: Analysis = { mask: null, face: null, ai: false };

type Px = { data: Uint8ClampedArray; w: number; h: number };

/* ---------- on-device AI (loaded lazily from public CDNs) ---------- */

const MP_VERSION = "0.10.14";
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const SEG_MODEL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";
const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

type Vision = { segmenter: any; detector: any };
let visionPromise: Promise<Vision | null> | null = null;

function loadVision(): Promise<Vision | null> {
  if (!visionPromise) {
    visionPromise = (async () => {
      try {
        const mod: any = await import(/* @vite-ignore */ `${MP_BASE}/vision_bundle.mjs`);
        const fileset = await mod.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
        const segmenter = await mod.ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: SEG_MODEL, delegate: "CPU" },
          runningMode: "IMAGE",
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        });
        let detector: any = null;
        try {
          detector = await mod.FaceDetector.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: FACE_MODEL, delegate: "CPU" },
            runningMode: "IMAGE",
            minDetectionConfidence: 0.5,
          });
        } catch {
          detector = null;
        }
        return { segmenter, detector };
      } catch {
        visionPromise = null; // allow a retry on the next run
        return null;
      }
    })();
  }
  return visionPromise;
}

async function toCanvas(url: string): Promise<HTMLCanvasElement> {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext("2d", { willReadFrequently: true })!.drawImage(bmp, 0, 0);
  bmp.close();
  return canvas;
}

/** Cut-out mask + face box for a photo. Never throws. */
export async function analyzePortrait(source: string): Promise<Analysis> {
  try {
    const vision = await loadVision();
    if (!vision) return EMPTY_ANALYSIS;
    const canvas = await toCanvas(source);
    let mask: Analysis["mask"] = null;
    let face: Analysis["face"] = null;

    try {
      const res = vision.segmenter.segment(canvas);
      const masks: any[] = res.confidenceMasks ?? [];
      const m = masks.length > 1 ? masks[1] : masks[0];
      if (m) {
        const w: number = m.width;
        const h: number = m.height;
        const data = new Float32Array(m.getAsFloat32Array());
        // The border of a portrait is background: if it reads as "person", invert.
        let border = 0;
        let n = 0;
        for (let x = 0; x < w; x += 4) {
          border += data[x]! + data[(h - 1) * w + x]!;
          n += 2;
        }
        if (n && border / n > 0.5) for (let i = 0; i < data.length; i++) data[i] = 1 - data[i]!;
        let sum = 0;
        for (let i = 0; i < data.length; i += 7) sum += data[i]!;
        const share = sum / (data.length / 7);
        if (share > 0.04 && share < 0.97) mask = refineMask({ w, h, data }, canvas);
      }
      res.close?.();
    } catch {
      mask = null;
    }

    try {
      if (vision.detector) {
        const det = vision.detector.detect(canvas);
        const box = det.detections?.[0]?.boundingBox;
        if (box && box.width > 0) {
          face = {
            cx: (box.originX + box.width / 2) / canvas.width,
            cy: (box.originY + box.height / 2) / canvas.height,
            w: box.width / canvas.width,
            h: box.height / canvas.height,
          };
        }
      }
    } catch {
      face = null;
    }
    return { mask, face, ai: Boolean(mask || face) };
  } catch {
    return EMPTY_ANALYSIS;
  }
}

/* ---------- pixel helpers ---------- */

async function load(url: string): Promise<Px> {
  const canvas = await toCanvas(url);
  const img = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height);
  return { data: img.data, w: img.width, h: img.height };
}

function toUrl(p: Px, quality = 0.92): string {
  const canvas = document.createElement("canvas");
  canvas.width = p.w;
  canvas.height = p.h;
  canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.w, p.h), 0, 0);
  return canvas.toDataURL("image/jpeg", quality);
}

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Separable box blur ×3 (≈ gaussian) on RGBA; returns a new buffer. */
function blur(src: Px, radius: number): Uint8ClampedArray {
  const { w, h } = src;
  const a = new Uint8ClampedArray(src.data);
  const b = new Uint8ClampedArray(src.data.length);
  const r = Math.max(1, Math.round(radius));
  const size = r * 2 + 1;
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += a[(y * w + Math.min(w - 1, Math.max(0, k))) * 4 + c]!;
        for (let x = 0; x < w; x++) {
          b[(y * w + x) * 4 + c] = sum / size;
          sum += a[(y * w + Math.min(w - 1, x + r + 1)) * 4 + c]! - a[(y * w + Math.max(0, x - r)) * 4 + c]!;
        }
      }
    }
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += b[(Math.min(h - 1, Math.max(0, k)) * w + x) * 4 + c]!;
        for (let y = 0; y < h; y++) {
          a[(y * w + x) * 4 + c] = sum / size;
          sum += b[(Math.min(h - 1, y + r + 1) * w + x) * 4 + c]! - b[(Math.max(0, y - r) * w + x) * 4 + c]!;
        }
      }
    }
  }
  for (let i = 3; i < a.length; i += 4) a[i] = 255;
  return a;
}


function sampleBilinear(d: Float32Array, w: number, h: number, fx: number, fy: number): number {
  const x = Math.min(w - 1, Math.max(0, fx * w - 0.5));
  const y = Math.min(h - 1, Math.max(0, fy * h - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  return lerp(
    lerp(d[y0 * w + x0]!, d[y0 * w + x1]!, tx),
    lerp(d[y1 * w + x0]!, d[y1 * w + x1]!, tx),
    ty,
  );
}

/**
 * The person model works at 256px, so its edge is soft and blocky. A guided
 * filter snaps that edge to the real edges in the photo (hair, ears, shoulders).
 */
function refineMask(m: { w: number; h: number; data: Float32Array }, photo: HTMLCanvasElement) {
  const scale = Math.min(1, 800 / Math.max(photo.width, photo.height));
  const gw = Math.max(8, Math.round(photo.width * scale));
  const gh = Math.max(8, Math.round(photo.height * scale));
  const small = document.createElement("canvas");
  small.width = gw;
  small.height = gh;
  const sctx = small.getContext("2d", { willReadFrequently: true })!;
  sctx.drawImage(photo, 0, 0, gw, gh);
  const px = sctx.getImageData(0, 0, gw, gh).data;
  const n = gw * gh;
  const I = new Float32Array(n);
  const P = new Float32Array(n);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      I[i] = (0.299 * px[i * 4]! + 0.587 * px[i * 4 + 1]! + 0.114 * px[i * 4 + 2]!) / 255;
      P[i] = sampleBilinear(m.data, m.w, m.h, (x + 0.5) / gw, (y + 0.5) / gh);
    }
  }
  const r = Math.max(4, Math.round(Math.max(gw, gh) / 70));
  const eps = 0.004;
  const mI = blurMask(I, gw, gh, r);
  const mP = blurMask(P, gw, gh, r);
  const II = new Float32Array(n);
  const IP = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    II[i] = I[i]! * I[i]!;
    IP[i] = I[i]! * P[i]!;
  }
  const cII = blurMask(II, gw, gh, r);
  const cIP = blurMask(IP, gw, gh, r);
  const A = new Float32Array(n);
  const B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const varI = cII[i]! - mI[i]! * mI[i]!;
    const cov = cIP[i]! - mI[i]! * mP[i]!;
    A[i] = cov / (varI + eps);
    B[i] = mP[i]! - A[i]! * mI[i]!;
  }
  const mA = blurMask(A, gw, gh, r);
  const mB = blurMask(B, gw, gh, r);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const q = mA[i]! * I[i]! + mB[i]!;
    out[i] = smooth(0.3, 0.7, Math.min(1, Math.max(0, q)));
  }
  return { w: gw, h: gh, data: out };
}

/** Box blur for a single-channel float image, two passes. */
function blurMask(m: Float32Array, w: number, h: number, radius: number): Float32Array {
  let a: Float32Array = m;
  const r = Math.max(1, Math.round(radius));
  const size = r * 2 + 1;
  for (let pass = 0; pass < 2; pass++) {
    const b = new Float32Array(a.length);
    for (let y = 0; y < h; y++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += a[y * w + Math.min(w - 1, Math.max(0, k))]!;
      for (let x = 0; x < w; x++) {
        b[y * w + x] = sum / size;
        sum += a[y * w + Math.min(w - 1, x + r + 1)]! - a[y * w + Math.max(0, x - r)]!;
      }
    }
    const c = new Float32Array(a.length);
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += b[Math.min(h - 1, Math.max(0, k)) * w + x]!;
      for (let y = 0; y < h; y++) {
        c[y * w + x] = sum / size;
        sum += b[Math.min(h - 1, y + r + 1) * w + x]! - b[Math.max(0, y - r) * w + x]!;
      }
    }
    a = c;
  }
  return a;
}

/** Person mask resampled to the working size and lightly feathered. */
function matteFor(an: Analysis, w: number, h: number): Float32Array | null {
  const m = an.mask;
  if (!m) return null;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[y * w + x] = smooth(0.4, 0.6, sampleBilinear(m.data, m.w, m.h, (x + 0.5) / w, (y + 0.5) / h));
    }
  }
  return blurMask(out, w, h, Math.max(1, w / 700));
}

/* ---------- passes ---------- */

function clean(p: Px): Px {
  const { data, w, h } = p;
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    hist[Math.round(0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!)]!++;
  }
  const total = w * h;
  let lo = 0;
  let hi = 255;
  for (let acc = 0; lo < 255; lo++) {
    acc += hist[lo]!;
    if (acc > total * 0.01) break;
  }
  for (let acc = 0; hi > 0; hi--) {
    acc += hist[hi]!;
    if (acc > total * 0.01) break;
  }
  const span = Math.max(40, hi - lo);
  const soft = blur(p, Math.max(1, Math.min(w, h) / 600));
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = (data[i + c]! - lo) * (255 / span);
      data[i + c] = clamp(v * 0.8 + soft[i + c]! * 0.2);
    }
  }
  return p;
}

function backdrop(p: Px, o: Options, an: Analysis): Px {
  const { data, w, h } = p;
  const bg = BACKDROPS[o.backdrop];
  const matte = o.replaceBg ? matteFor(an, w, h) : null;

  if (matte) {
    const diag = Math.hypot(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const m = matte[y * w + x]!;
        if (m >= 0.999) continue;
        const i = (y * w + x) * 4;
        // soft studio pool of light behind the head
        const d = Math.hypot(x - w * 0.5, y - h * 0.38) / (diag * 0.55);
        const t = smooth(0, 1, d);
        for (let c = 0; c < 3; c++) {
          const back = lerp(bg.center[c]!, bg.edge[c]!, t);
          data[i + c] = clamp(data[i + c]! * m + back * (1 - m));
        }
      }
    }
    return p;
  }

  // No cut-out available: gently wash the edges toward the backdrop colour.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x / w - 0.5) / 0.4;
      const dy = (y / h - 0.52) / 0.58;
      const m = smooth(0.85, 1.3, Math.sqrt(dx * dx + dy * dy)) * 0.72;
      if (m <= 0) continue;
      const i = (y * w + x) * 4;
      const g = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
      for (let c = 0; c < 3; c++) {
        const base = data[i + c]! * 0.35 + g * 0.65;
        data[i + c] = clamp(base * (1 - m) + (bg.center[c]! * 0.9 + g * 0.1) * m);
      }
    }
  }
  return p;
}

function light(p: Px, o: Options, an: Analysis): Px {
  const { data, w, h } = p;
  const fx = (an.face?.cx ?? 0.5) - 0.22;
  const fy = (an.face?.cy ?? 0.4) - 0.18;
  const s = o.light;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dx = x / w - fx;
      const dy = y / h - fy;
      const g = Math.exp(-(dx * dx + dy * dy) / (2 * 0.5 * 0.5));
      const key = 1 + s * (0.2 * g - 0.05);
      let r = data[i]!;
      let gg = data[i + 1]!;
      let b = data[i + 2]!;
      r *= key;
      gg *= key;
      b *= key;
      // lift shadows, tiny S-curve
      r += (255 - r) * 0.05 * s * (1 - r / 255);
      gg += (255 - gg) * 0.05 * s * (1 - gg / 255);
      b += (255 - b) * 0.05 * s * (1 - b / 255);
      if (o.look === "warm") {
        r = r * 1.05 + 4;
        b = b * 0.92 - 2;
      } else if (o.look === "cool") {
        r = r * 0.95;
        b = b * 1.06 + 3;
      } else if (o.look === "mono") {
        const l = 0.299 * r + 0.587 * gg + 0.114 * b;
        const v = (l - 128) * 1.1 + 128;
        r = gg = b = v;
      }
      data[i] = clamp(r);
      data[i + 1] = clamp(gg);
      data[i + 2] = clamp(b);
    }
  }
  return p;
}

function retouch(p: Px, o: Options, an: Analysis): Px {
  const { data, w, h } = p;
  const strength = o.retouch;
  if (strength <= 0.01) return p;
  const soft = blur(p, Math.max(2, Math.min(w, h) / 260));
  const face = an.face;
  const matte = matteFor(an, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let region = 1;
      if (face) {
        const dx = (x / w - face.cx) / (face.w * 0.85);
        const dy = (y / h - face.cy) / (face.h * 1.05);
        region = 1 - smooth(0.8, 1.25, Math.hypot(dx, dy));
      }
      if (matte) region *= matte[y * w + x]!;
      if (region <= 0.02) continue;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const skin = r > 70 && g > 40 && b > 25 && r > g && r > b && r - g > 8 && r - b > 15;
      if (!skin) continue;
      const diff = Math.abs(r - soft[i]!) + Math.abs(g - soft[i + 1]!) + Math.abs(b - soft[i + 2]!);
      const amt = 0.6 * strength * region * (1 - smooth(30, 90, diff)); // keep real edges and texture
      // studio powder: calm specular shine on forehead and nose
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const shine = 1 - 0.22 * strength * region * smooth(195, 245, lum);
      data[i] = (r + (soft[i]! - r) * amt) * shine;
      data[i + 1] = (g + (soft[i + 1]! - g) * amt) * shine;
      data[i + 2] = (b + (soft[i + 2]! - b) * amt) * shine;
    }
  }
  return p;
}

function sharpen(p: Px, amount: number, radiusDiv = 700): Px {
  const soft = blur(p, Math.max(1, Math.min(p.w, p.h) / radiusDiv));
  for (let i = 0; i < p.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      p.data[i + c] = clamp(p.data[i + c]! + (p.data[i + c]! - soft[i + c]!) * amount);
    }
  }
  return p;
}

function drawRect(p: Px, sx: number, sy: number, sw: number, sh: number, outW: number, outH: number): Px {
  const src = document.createElement("canvas");
  src.width = p.w;
  src.height = p.h;
  src.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.w, p.h), 0, 0);
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(outW));
  out.height = Math.max(1, Math.round(outH));
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, out.width, out.height);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  return { data: img.data, w: img.width, h: img.height };
}

/** 4:5 head-and-shoulders crop around the face; headroom is padded with backdrop when needed. */
function polishCrop(p: Px, an: Analysis, o: Options, maxEdge: number): Px {
  const aspect = 4 / 5;
  const maxW = Math.min(p.w, p.h * aspect);
  let cw = maxW;
  let ch = cw / aspect;
  let left = (p.w - cw) / 2;
  let top = (p.h - ch) * 0.2;
  const face = an.face;
  const canPad = o.replaceBg && Boolean(an.mask);
  if (face) {
    cw = Math.min(maxW, Math.max((face.w * p.w) / 0.38, maxW * 0.5)); // face ≈ 38% of the frame
    ch = cw / aspect;
    left = Math.min(p.w - cw, Math.max(0, face.cx * p.w - cw / 2));
    const want = face.cy * p.h - ch * 0.4; // eyes a little above centre
    top = Math.min(p.h - ch, want);
    top = canPad ? Math.max(-ch * 0.3, top) : Math.max(0, top);
  }
  const scale = Math.min(1, maxEdge / ch);
  const outW = Math.max(1, Math.round(cw * scale));
  const outH = Math.max(1, Math.round(ch * scale));
  if (top >= 0) return drawRect(p, left, top, cw, ch, outW, outH);

  // Headroom above the photo: stretch the top row (a smooth backdrop) upward.
  const src = document.createElement("canvas");
  src.width = p.w;
  src.height = p.h;
  src.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.w, p.h), 0, 0);
  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  const padPx = Math.ceil(-top * scale);
  ctx.drawImage(src, left, 0, cw, 2, 0, 0, outW, padPx + 1);
  ctx.drawImage(src, left, 0, cw, ch + top, 0, padPx, outW, outH - padPx);
  const img = ctx.getImageData(0, 0, outW, outH);
  // blend the seam so the stretched strip never shows an edge
  return { data: img.data, w: img.width, h: img.height };
}

/** One free pass. Steps the browser can't do are returned unchanged. */
export async function developLocal(
  step: StepId,
  source: string,
  opts: Options = DEFAULT_OPTIONS,
  analysis: Analysis = EMPTY_ANALYSIS,
): Promise<string> {
  let p = await load(source);
  switch (step) {
    case "clean":
      p = clean(p);
      break;
    case "backdrop":
      p = backdrop(p, opts, analysis);
      break;
    case "light":
    case "keylight":
      p = light(p, opts, analysis);
      break;
    case "retouch":
      p = retouch(p, opts, analysis);
      break;
    case "polish":
      p = sharpen(sharpen(polishCrop(p, analysis, opts, 1600), 0.5), 0.18, 60);
      break;
    case "print": {
      const scale = 2400 / Math.max(p.w, p.h);
      p = sharpen(drawRect(p, 0, 0, p.w, p.h, p.w * scale, p.h * scale), 0.4);
      return toUrl(p, 0.95);
    }
    default:
      break;
  }
  return toUrl(p);
}

/** Of several photos of the same person, pick the sharpest, best-lit, most front-facing one. */
export async function pickBestShot(urls: string[]): Promise<{ index: number }> {
  if (urls.length < 2) return { index: 0 };
  const vision = await loadVision().catch(() => null);
  const rows: { sharp: number; expo: number; front: number; size: number }[] = [];
  for (const url of urls) {
    try {
      const full = await toCanvas(url);
      const s = 480 / Math.max(full.width, full.height);
      const c = document.createElement("canvas");
      c.width = Math.max(8, Math.round(full.width * s));
      c.height = Math.max(8, Math.round(full.height * s));
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(full, 0, 0, c.width, c.height);
      const px = ctx.getImageData(0, 0, c.width, c.height).data;
      const w = c.width;
      const h = c.height;
      const gray = new Float32Array(w * h);
      let mean = 0;
      let clipped = 0;
      for (let i = 0; i < w * h; i++) {
        const l = 0.299 * px[i * 4]! + 0.587 * px[i * 4 + 1]! + 0.114 * px[i * 4 + 2]!;
        gray[i] = l;
        mean += l;
        if (l < 8 || l > 247) clipped++;
      }
      mean /= w * h;
      let acc = 0;
      let acc2 = 0;
      let cnt = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          const lap = 4 * gray[i]! - gray[i - 1]! - gray[i + 1]! - gray[i - w]! - gray[i + w]!;
          acc += lap;
          acc2 += lap * lap;
          cnt++;
        }
      }
      const sharp = acc2 / cnt - (acc / cnt) ** 2;
      const expo = Math.max(0, 1 - Math.abs(mean - 135) / 110 - clipped / (w * h));
      let front = 0.3;
      let size = 0.3;
      if (vision?.detector) {
        const det = vision.detector.detect(full);
        const d = det.detections?.[0];
        if (d?.boundingBox) {
          size = Math.min(1, d.boundingBox.width / full.width / 0.4);
          const k = d.keypoints;
          if (k && k.length >= 3) {
            const eyes = Math.abs(k[1].x - k[0].x) || 0.01;
            const yaw = (k[2].x - (k[0].x + k[1].x) / 2) / eyes;
            front = 1 - Math.min(1, Math.abs(yaw) * 2);
          } else front = 0.6;
        }
      }
      rows.push({ sharp, expo, front, size });
    } catch {
      rows.push({ sharp: 0, expo: 0, front: 0, size: 0 });
    }
  }
  const maxSharp = Math.max(1e-6, ...rows.map((r) => r.sharp));
  let best = 0;
  let bestScore = -1;
  rows.forEach((r, i) => {
    const score = 0.5 * (r.sharp / maxSharp) + 0.15 * r.expo + 0.2 * r.front + 0.15 * r.size;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return { index: best };
}
