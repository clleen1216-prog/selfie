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
        if (share > 0.04 && share < 0.97) mask = { w, h, data };
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

/** Person mask resampled to the working size, hardened a little, then feathered. */
function matteFor(an: Analysis, w: number, h: number): Float32Array | null {
  const m = an.mask;
  if (!m) return null;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const my = Math.min(m.h - 1, Math.floor((y / h) * m.h));
    for (let x = 0; x < w; x++) {
      const mx = Math.min(m.w - 1, Math.floor((x / w) * m.w));
      out[y * w + x] = smooth(0.35, 0.7, m.data[my * m.w + mx]!);
    }
  }
  return blurMask(out, w, h, Math.max(1.5, w / 260));
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
      data[i] = r + (soft[i]! - r) * amt;
      data[i + 1] = g + (soft[i + 1]! - g) * amt;
      data[i + 2] = b + (soft[i + 2]! - b) * amt;
    }
  }
  return p;
}

function sharpen(p: Px, amount: number): Px {
  const soft = blur(p, Math.max(1, Math.min(p.w, p.h) / 700));
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

/** 4:5 head-and-shoulders crop, placed around the face when one was found. */
function polishCrop(p: Px, an: Analysis, maxEdge: number): Px {
  const aspect = 4 / 5;
  let cw = Math.min(p.w, p.h * aspect);
  let ch = cw / aspect;
  let left = (p.w - cw) / 2;
  let top = (p.h - ch) * 0.2;
  const face = an.face;
  if (face) {
    const facePx = face.w * p.w;
    const want = Math.max(facePx / 0.36, 0); // face ≈ 36% of the frame width
    cw = Math.min(Math.min(p.w, p.h * aspect), Math.max(want, Math.min(p.w, p.h * aspect) * 0.55));
    ch = cw / aspect;
    left = Math.min(p.w - cw, Math.max(0, face.cx * p.w - cw / 2));
    top = Math.min(p.h - ch, Math.max(0, face.cy * p.h - ch * 0.4));
  }
  const scale = Math.min(1, maxEdge / ch);
  return drawRect(p, left, top, cw, ch, cw * scale, ch * scale);
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
      p = sharpen(polishCrop(p, analysis, 1280), 0.5);
      break;
    case "print": {
      const scale = 2000 / Math.max(p.w, p.h);
      p = sharpen(drawRect(p, 0, 0, p.w, p.h, p.w * scale, p.h * scale), 0.4);
      return toUrl(p, 0.95);
    }
    default:
      break;
  }
  return toUrl(p);
}
