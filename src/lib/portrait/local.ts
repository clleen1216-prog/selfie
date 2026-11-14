/**
 * Free, in-browser portrait finishing. No AI and no API key: every pass is a
 * plain pixel operation on a canvas, so it costs nothing and never runs out of
 * quota. It cannot change clothes, hair or pose — only tone, light, backdrop
 * and skin finish.
 */
import type { StepId } from "@/lib/portrait/prompts";

/** The passes the browser can really do, in order. */
export const LOCAL_PLAN: StepId[] = ["clean", "backdrop", "light", "retouch", "polish"];

type Px = { data: Uint8ClampedArray; w: number; h: number };

async function load(url: string): Promise<Px> {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvas");
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: img.data, w: img.width, h: img.height };
}

function toUrl(p: Px, quality = 0.92): string {
  const canvas = document.createElement("canvas");
  canvas.width = p.w;
  canvas.height = p.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.w, p.h), 0, 0);
  return canvas.toDataURL("image/jpeg", quality);
}

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Separable box blur (3 passes ≈ gaussian). Returns a new buffer. */
function blur(src: Px, radius: number): Uint8ClampedArray {
  const { w, h } = src;
  let a = new Uint8ClampedArray(src.data);
  let b = new Uint8ClampedArray(src.data.length);
  const r = Math.max(1, Math.round(radius));
  const size = r * 2 + 1;
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += a[(y * w + Math.min(w - 1, Math.max(0, k))) * 4 + c]!;
        for (let x = 0; x < w; x++) {
          b[(y * w + x) * 4 + c] = sum / size;
          const add = Math.min(w - 1, x + r + 1);
          const rem = Math.max(0, x - r);
          sum += a[(y * w + add) * 4 + c]! - a[(y * w + rem) * 4 + c]!;
        }
      }
    }
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += b[(Math.min(h - 1, Math.max(0, k)) * w + x) * 4 + c]!;
        for (let y = 0; y < h; y++) {
          a[(y * w + x) * 4 + c] = sum / size;
          const add = Math.min(h - 1, y + r + 1);
          const rem = Math.max(0, y - r);
          sum += b[(add * w + x) * 4 + c]! - b[(rem * w + x) * 4 + c]!;
        }
      }
    }
  }
  for (let i = 3; i < a.length; i += 4) a[i] = 255;
  return a;
}

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
      data[i + c] = clamp(v * 0.8 + soft[i + c]! * 0.2 + (v - soft[i + c]!) * 0.0);
    }
  }
  return p;
}

function backdrop(p: Px): Px {
  const { data, w, h } = p;
  const bone = [236, 227, 214];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x / w - 0.5) / 0.4;
      const dy = (y / h - 0.52) / 0.58;
      const d = Math.sqrt(dx * dx + dy * dy);
      const m = smooth(0.85, 1.3, d) * 0.72;
      if (m <= 0) continue;
      const i = (y * w + x) * 4;
      const g = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
      for (let c = 0; c < 3; c++) {
        const base = data[i + c]! * 0.35 + g * 0.65;
        data[i + c] = clamp(base * (1 - m) + (bone[c]! * 0.85 + g * 0.15) * m);
      }
    }
  }
  return p;
}

function light(p: Px): Px {
  const { data, w, h } = p;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // soft key from upper-left, gentle fill on the shadow side
      const key = 1 + 0.12 * (1 - x / w) * (1 - 0.6 * (y / h));
      for (let c = 0; c < 3; c++) {
        let v = data[i + c]! * key;
        v = v + (255 - v) * 0.06 * (1 - v / 255); // lift shadows
        const t = v / 255;
        v = 255 * (t + 0.18 * t * (1 - t) * (t < 0.5 ? -1 : 1) * 0 + (t - 0.5) * 0.06);
        data[i + c] = clamp(v + (c === 0 ? 3 : c === 2 ? -3 : 0));
      }
    }
  }
  return p;
}

function retouch(p: Px): Px {
  const { data } = p;
  const soft = blur(p, Math.max(2, Math.min(p.w, p.h) / 260));
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const skin = r > 70 && g > 40 && b > 25 && r > g && r > b && r - g > 8 && r - b > 15;
    if (!skin) continue;
    // keep fine texture: only part of the way to the blurred copy
    const diff = Math.abs(r - soft[i]!) + Math.abs(g - soft[i + 1]!) + Math.abs(b - soft[i + 2]!);
    const amt = 0.42 * (1 - smooth(30, 90, diff)); // protect real edges
    data[i] = r + (soft[i]! - r) * amt;
    data[i + 1] = g + (soft[i + 1]! - g) * amt;
    data[i + 2] = b + (soft[i + 2]! - b) * amt;
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

function resize(p: Px, cropAspect: number | null, maxEdge: number, upscale: boolean): Px {
  const src = document.createElement("canvas");
  src.width = p.w;
  src.height = p.h;
  src.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.w, p.h), 0, 0);
  let sx = 0;
  let sy = 0;
  let sw = p.w;
  let sh = p.h;
  if (cropAspect) {
    if (p.w / p.h > cropAspect) {
      sw = Math.round(p.h * cropAspect);
      sx = Math.round((p.w - sw) / 2);
    } else {
      sh = Math.round(p.w / cropAspect);
      sy = Math.round((p.h - sh) * 0.2); // keep headroom, trim lower body
    }
  }
  const scale = upscale ? maxEdge / Math.max(sw, sh) : Math.min(1, maxEdge / Math.max(sw, sh));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(sw * scale));
  out.height = Math.max(1, Math.round(sh * scale));
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, out.width, out.height);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  return { data: img.data, w: img.width, h: img.height };
}

/** One free pass. Steps the browser can't do are returned unchanged. */
export async function developLocal(step: StepId, source: string): Promise<string> {
  let p = await load(source);
  switch (step) {
    case "clean":
      p = clean(p);
      break;
    case "backdrop":
      p = backdrop(p);
      break;
    case "light":
    case "keylight":
      p = light(p);
      break;
    case "retouch":
      p = retouch(p);
      break;
    case "polish":
      p = sharpen(resize(p, 4 / 5, 1280, false), 0.5);
      break;
    case "print":
      p = sharpen(resize(p, null, 2000, true), 0.4);
      return toUrl(p, 0.95);
    default:
      break;
  }
  return toUrl(p);
}
