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
  if (source.startsWith("https://")) {
    if (source.length > 2000) return { error: "That image link isn’t valid." };
    let parsed: URL;
    try {
      parsed = new URL(source);
    } catch {
      return { error: "That image link isn’t valid." };
    }
    if (!imageHostAllowed(parsed.hostname)) {
      return { error: "Only a photograph from this sitting can be continued." };
    }
    return { url: source };
  }
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
  if (/credit|spending-limit|spending limit|subscription|quota/i.test(clipped)) {
    return "Portrait generation is paused — the studio’s image credits are used up. Add credits, then try again.";
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

type EditBody = {
  data?: { url?: string; b64_json?: string; mime_type?: string }[];
};

function imageFromBody(body: EditBody): string | null {
  const first = body.data?.[0];
  if (!first) return null;
  if (typeof first.url === "string" && first.url.startsWith("https://")) return first.url;
  if (typeof first.b64_json === "string" && first.b64_json.length > 32) {
    const mime = first.mime_type?.startsWith("image/") ? first.mime_type : "image/jpeg";
    return `data:${mime};base64,${first.b64_json}`;
  }
  return null;
}

async function postEdit(
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: unknown; text: string }> {
  const res = await fetch("https://api.x.ai/v1/images/edits", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(85_000),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

function isModelMiss(status: number, message: string): boolean {
  return status === 404 || /model|not found|does not exist|unknown/i.test(message);
}

export const studioReady = createServerFn({ method: "GET" }).handler(async () => {
  return { ready: Boolean(process.env.XAI_API_KEY) };
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

    const apiKey = process.env.XAI_API_KEY;
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

    const slot = slotState(data.sessionId);
    if ("error" in slot) return { ok: false, error: slot.error };

    const prompt = [
      urls.length > 1 ? MULTI_ANGLE : "",
      promptFor(data.step, data.wardrobe, data.keepClothes),
    ]
      .filter(Boolean)
      .join(" ");
    const wantsAspect = data.step === "sitting" || data.step === "finish" || data.step === "polish";
    let resolution = data.step === "print" || data.step === "sitting" || data.step === "polish" || data.step === "finish" ? "2k" : "1k";

    let model = "grok-imagine-image-2.0";
    let aspect = wantsAspect;
    let useAllAngles = urls.length > 1;
    let attemptedModelFallback = false;
    let attemptedShapeFallback = false;
    let attemptedRetry = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      const payload: Record<string, unknown> = {
        model,
        prompt,
        response_format: "url",
        n: 1,
        resolution,
      };
      if (useAllAngles) {
        payload.images = urls.map((url) => ({ url, type: "image_url" }));
      } else {
        payload.image = { url: urls[0], type: "image_url" };
      }
      if (aspect) payload.aspect_ratio = "2:3";

      let status = 0;
      let body: unknown = null;
      try {
        const posted = await postEdit(apiKey, payload);
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
        const url = imageFromBody((body ?? {}) as EditBody);
        if (!url) {
          return { ok: false, error: "The portrait came back empty. Try this pass again." };
        }
        commitSlot(data.sessionId);
        return { ok: true, url };
      }

      const message = apiMessage(body);
      if (!attemptedModelFallback && isModelMiss(status, message)) {
        attemptedModelFallback = true;
        model = "grok-imagine-image";
        continue;
      }
      if (!attemptedShapeFallback && status === 400 && (aspect || resolution === "2k" || useAllAngles)) {
        attemptedShapeFallback = true;
        if (useAllAngles) useAllAngles = false;
        else if (resolution === "2k") resolution = "1k";
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
