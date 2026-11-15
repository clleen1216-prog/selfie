import { createServerFn } from "@tanstack/react-start";
import {
  STEPS,
  WARDS,
  promptFor,
  type StepId,
  type Wardrobe,
} from "@/lib/portrait/prompts";

export type DevelopInput = {
  sessionId: string;
  step: StepId;
  sources: string[];
  wardrobe: Wardrobe;
  keepClothes: boolean;
  /** Visitor's own Google AI Studio key (bring-your-own-key). Never stored. */
  apiKey?: string;
};

export type DevelopResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const WINDOW_MS = 15 * 60 * 1000;
const GLOBAL_MAX = 40;
const SESSION_MAX = 16;

const usage = {
  windowStart: Date.now(),
  count: 0,
  sessions: new Map<string, number>(),
};

function slotState(sessionId: string): { used: number } | { error: string } {
  const now = Date.now();
  if (now - usage.windowStart > WINDOW_MS) {
    usage.windowStart = now;
    usage.count = 0;
    usage.sessions.clear();
  }
  const used = usage.sessions.get(sessionId) ?? 0;
  if (used >= SESSION_MAX) {
    return {
      error:
        "This sitting has used its portrait generations. Come back a little later for another.",
    };
  }
  if (usage.count >= GLOBAL_MAX) {
    return { error: "The studio is resting. Try again in a little while." };
  }
  return { used };
}

function commitSlot(sessionId: string) {
  const now = Date.now();
  if (now - usage.windowStart > WINDOW_MS) {
    usage.windowStart = now;
    usage.count = 0;
    usage.sessions.clear();
  }
  usage.sessions.set(sessionId, (usage.sessions.get(sessionId) ?? 0) + 1);
  usage.count += 1;
}

const MULTI_ANGLE =
  "The first image is the only photograph to change. Every later image is another angle of that same one person — front, three-quarter, or profile — and is an identity reference only. Output exactly one person. Do not collage the angles, do not duplicate the person, and do not invent a new face. Use the extra angles to lock bone structure, eye shape, nose, lips, jaw, and how the face turns in space.";

function imageHostAllowed(hostname: string): boolean {
  return (
    hostname === "imgen.x.ai" ||
    hostname.endsWith(".x.ai") ||
    hostname.endsWith(".grok.com")
  );
}

function normalizeSource(source: string): { url: string } | { error: string } {
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=\s]+$/.test(source)) {
    return { error: "Use a JPEG, PNG, or WebP photograph." };
  }
  if (source.length > 700_000) {
    return { error: "That photograph is too large. Try another, or a smaller crop." };
  }
  return { url: source.replace(/\s/g, "") };
}

function apiMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as {
    code?: string;
    error?: { message?: string } | string;
    message?: string;
  };
  const code = typeof record.code === "string" ? record.code : "";
  const message =
    typeof record.error === "string"
      ? record.error
      : record.error && typeof record.error.message === "string"
        ? record.error.message
        : typeof record.message === "string"
          ? record.message
          : "";
  return [code, message].filter(Boolean).join(" ");
}

function publicError(status: number, raw: string): string {
  const clipped = raw.replace(/\s+/g, " ").slice(0, 240);
  if (/credit|spending-limit|spending limit|subscription|quota|billing|exceeded your current/i.test(clipped)) {
    return "AI mode is paused — Google says this key has no image quota left. Image models usually need billing turned on for the key’s project; otherwise wait for the quota to reset.";
  }
  if (/api key not valid|api_key_invalid|permission denied|invalid api key/i.test(clipped)) {
    return "The studio’s Google API key isn’t valid. Check GEMINI_API_KEY in Vercel.";
  }
  if (status === 401 || status === 403) {
    return "The studio can’t reach the portrait model right now.";
  }
  if (status === 429) {
    return "The studio is busy. Wait a moment, then try this pass again.";
  }
  if (/safety|policy|moderation|not allowed/i.test(clipped)) {
    return "That photograph couldn’t be used for a portrait. Try another.";
  }
  return "The portrait pass didn’t finish. Try this pass again.";
}

type GeminiPart = {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
};
type GeminiBody = {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
};

function imageFromBody(body: GeminiBody): string | null {
  for (const candidate of body.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      const inline = part.inlineData ?? part.inline_data;
      const data = inline?.data;
      if (typeof data === "string" && data.length > 32) {
        const raw = (inline as { mimeType?: string; mime_type?: string }).mimeType ??
          (inline as { mime_type?: string }).mime_type;
        const mime = raw?.startsWith("image/") ? raw : "image/png";
        return `data:${mime};base64,${data}`;
      }
    }
  }
  return null;
}

function blockedByPolicy(body: GeminiBody): boolean {
  if (body.promptFeedback?.blockReason) return true;
  return (body.candidates ?? []).some((c) =>
    /SAFETY|PROHIBITED|IMAGE_OTHER|BLOCK/i.test(c.finishReason ?? ""),
  );
}

const GEMINI_MODEL = process.env.GEMINI_IMAGE_MODEL?.trim() || "gemini-2.5-flash-image";

async function postEdit(
  apiKey: string,
  model: string,
  prompt: string,
  urls: string[],
  aspect: boolean,
): Promise<{ status: number; body: unknown }> {
  const parts: Record<string, unknown>[] = [{ text: prompt }];
  for (const url of urls) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(url);
    if (!m) throw new Error("bad source");
    parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
  }
  const generationConfig: Record<string, unknown> = { responseModalities: ["IMAGE"] };
  if (aspect) generationConfig.imageConfig = { aspectRatio: "2:3" };
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ contents: [{ parts }], generationConfig }),
      signal: AbortSignal.timeout(55_000),
    },
  );
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

export const studioReady = createServerFn({ method: "GET" }).handler(async () => {
  return { ready: Boolean(process.env.GEMINI_API_KEY?.trim()) };
});

export const developPortrait = createServerFn({ method: "POST" })
  .validator((input: DevelopInput) => input)
  .handler(async ({ data }): Promise<DevelopResult> => {
    if (!UUID.test(data.sessionId)) {
      return { ok: false, error: "That request didn’t look right." };
    }
    if (!STEPS.includes(data.step) || !WARDS.includes(data.wardrobe)) {
      return { ok: false, error: "That request didn’t look right." };
    }
    if (typeof data.keepClothes !== "boolean" || !Array.isArray(data.sources)) {
      return { ok: false, error: "That request didn’t look right." };
    }
    if (data.sources.length < 1 || data.sources.length > 4) {
      return { ok: false, error: "That request didn’t look right." };
    }

    const own =
      typeof data.apiKey === "string" && /^[A-Za-z0-9_-]{20,120}$/.test(data.apiKey.trim())
        ? data.apiKey.trim()
        : null;
    const apiKey = own ?? process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      return { ok: false, error: "Portrait generation isn’t available right now." };
    }

    const urls: string[] = [];
    for (const item of data.sources) {
      if (typeof item !== "string") return { ok: false, error: "That request didn’t look right." };
      const source = normalizeSource(item);
      if ("error" in source) return { ok: false, error: source.error };
      urls.push(source.url);
    }

    if (!own) {
      const slot = slotState(data.sessionId);
      if ("error" in slot) return { ok: false, error: slot.error };
    }

    const basePrompt = [
      urls.length > 1 ? MULTI_ANGLE : "",
      promptFor(data.step, data.wardrobe, data.keepClothes),
    ]
      .filter(Boolean)
      .join(" ");
    const wantsAspect = data.step === "sitting" || data.step === "finish" || data.step === "polish";

    let aspect = wantsAspect;
    let useAllAngles = urls.length > 1;
    let attemptedShapeFallback = false;
    let attemptedRetry = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      const sent = useAllAngles ? urls : [urls[0]!];
      const prompt = useAllAngles ? basePrompt : basePrompt.replace(MULTI_ANGLE, "").trim();

      let status = 0;
      let body: unknown = null;
      try {
        const posted = await postEdit(apiKey, GEMINI_MODEL, prompt, sent, aspect);
        status = posted.status;
        body = posted.body;
      } catch {
        if (!attemptedRetry) {
          attemptedRetry = true;
          await new Promise((resolve) => setTimeout(resolve, 1200));
          continue;
        }
        return { ok: false, error: "That pass took too long. Try it again." };
      }

      if (status >= 200 && status < 300) {
        const parsed = (body ?? {}) as GeminiBody;
        const url = imageFromBody(parsed);
        if (!url) {
          if (blockedByPolicy(parsed)) {
            return { ok: false, error: "That photograph couldn’t be used for a portrait. Try another." };
          }
          return { ok: false, error: "The portrait came back empty. Try this pass again." };
        }
        if (!own) commitSlot(data.sessionId);
        return { ok: true, url };
      }

      const message = apiMessage(body);
      if (!attemptedShapeFallback && status === 400 && (aspect || useAllAngles)) {
        attemptedShapeFallback = true;
        if (useAllAngles) useAllAngles = false;
        else aspect = false;
        continue;
      }
      if (!attemptedRetry && (status === 429 || status >= 500)) {
        attemptedRetry = true;
        await new Promise((resolve) => setTimeout(resolve, 1200));
        continue;
      }
      return { ok: false, error: publicError(status, message) };
    }

    return { ok: false, error: "The portrait pass didn’t finish. Try this pass again." };
  });

export const fetchPortrait = createServerFn({ method: "POST" })
  .validator((input: { url: string }) => input)
  .handler(async ({ data }): Promise<
    { ok: true; base64: string; mime: string } | { ok: false; error: string }
  > => {
    if (typeof data.url !== "string" || !data.url.startsWith("https://") || data.url.length > 2000) {
      return { ok: false, error: "That portrait can’t be saved from here." };
    }
    let parsed: URL;
    try {
      parsed = new URL(data.url);
    } catch {
      return { ok: false, error: "That portrait can’t be saved from here." };
    }
    if (!imageHostAllowed(parsed.hostname)) {
      return { ok: false, error: "That portrait can’t be saved from here." };
    }

    try {
      const res = await fetch(data.url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return { ok: false, error: "The portrait file wasn’t ready. Open it instead." };
      const mime = res.headers.get("content-type") ?? "image/jpeg";
      if (!mime.startsWith("image/")) {
        return { ok: false, error: "The portrait file wasn’t ready. Open it instead." };
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength < 32 || bytes.byteLength > 8_000_000) {
        return { ok: false, error: "The portrait file wasn’t ready. Open it instead." };
      }
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      return { ok: true, base64: btoa(binary), mime };
    } catch {
      return { ok: false, error: "The portrait file wasn’t ready. Open it instead." };
    }
  });
