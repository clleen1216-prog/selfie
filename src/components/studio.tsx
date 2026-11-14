import { useEffect, useId, useRef, useState } from "react";
import { Aperture, Download, ImagePlus, RotateCcw, Square, X } from "lucide-react";
import { fetchPortrait } from "@/lib/portrait/edit.functions";
import { developLocal, LOCAL_PLAN } from "@/lib/portrait/local";
import {
  STEP_COPY,
  WARDROBE_LABEL,
  WARDS,
  type DevelopMode,
  type StepId,
  type Wardrobe,
} from "@/lib/portrait/prompts";

type Phase = "idle" | "running" | "done" | "held" | "error";

type Frame = {
  step: StepId;
  url: string;
};

const SESSION_KEY = "halide-session";

function useSessionId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    let existing = sessionStorage.getItem(SESSION_KEY);
    if (!existing) {
      existing = crypto.randomUUID();
      sessionStorage.setItem(SESSION_KEY, existing);
    }
    setId(existing);
  }, []);
  return id;
}

async function fileToJpeg(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Choose a photograph — JPEG, PNG, or WebP.");
  }
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("This browser couldn’t read that photograph. Try a JPEG or PNG.");
  });
  let edge = 1280;
  let quality = 0.86;
  const draw = (maxEdge: number, q: number) => {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Couldn’t read that photograph.");
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", q);
  };
  let url = draw(edge, quality);
  while (url.length > 680_000 && (quality > 0.5 || edge > 720)) {
    if (quality > 0.5) quality -= 0.08;
    else edge = Math.round(edge * 0.85);
    url = draw(edge, quality);
  }
  bitmap.close();
  if (url.length > 690_000) {
    throw new Error("That photograph is still too large. Try a smaller one.");
  }
  return url;
}

async function shrinkForSource(url: string): Promise<string> {
  if (!url.startsWith("data:") || url.length <= 680_000) return url;
  const blob = await (await fetch(url)).blob();
  const bitmap = await createImageBitmap(blob);
  let edge = 1280;
  let quality = 0.86;
  const draw = (maxEdge: number, q: number) => {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", q);
  };
  let out = draw(edge, quality);
  while (out.length > 680_000 && (quality > 0.5 || edge > 720)) {
    if (quality > 0.5) quality -= 0.08;
    else edge = Math.round(edge * 0.85);
    out = draw(edge, quality);
  }
  bitmap.close();
  return out;
}

async function savePortrait(url: string, filename: string) {
  if (url.startsWith("data:")) {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    return;
  }
  const fetched = await fetchPortrait({ data: { url } });
  if (!fetched.ok) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const binary = atob(fetched.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: fetched.mime });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}

export function Studio() {
  const sessionId = useSessionId();
  const inputId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(false);
  const runLock = useRef(false);

  const [ready, setReady] = useState<boolean | null>(null);
  const [original, setOriginal] = useState<string | null>(null);
  const [angles, setAngles] = useState<string[]>([]);
  const [fileName, setFileName] = useState<string>("");
  const [dragOver, setDragOver] = useState(false);
  const [wardrobe, setWardrobe] = useState<Wardrobe>("charcoal");
  const [keepClothes, setKeepClothes] = useState(false);
  const [mode, setMode] = useState<DevelopMode>("careful");
  const [phase, setPhase] = useState<Phase>("idle");
  const [frames, setFrames] = useState<Frame[]>([]);
  const [active, setActive] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [lockedPlan, setLockedPlan] = useState<StepId[] | null>(null);
  const [compare, setCompare] = useState(false);
  const [seam, setSeam] = useState(58);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [resume, setResume] = useState<{ source: string; index: number } | null>(null);

  useEffect(() => {
    setReady(true);
  }, []);

  async function takeFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setNotice(null);
    try {
      const jpeg = await fileToJpeg(file);
      setOriginal(jpeg);
      setFileName(file.name);
      setAngles([]);
      setFrames([]);
      setActive(0);
      setPhase("idle");
      setResume(null);
      setLockedPlan(null);
      setCompare(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn’t read that photograph.");
    }
  }

  async function runFrom(startSource: string, startIndex: number, plan: StepId[]) {
    if (!sessionId || !original || runLock.current) return;
    runLock.current = true;
    cancelRef.current = false;
    setError(null);
    setNotice(null);
    setCompare(false);
    setPrinting(false);
    let source = await shrinkForSource(startSource).catch(() => startSource);
    const nextFrames = frames.slice(0, startIndex);
    let cursor = startIndex;
    setFrames(nextFrames);
    setPhase("running");

    try {
      for (let i = startIndex; i < plan.length; i++) {
        cursor = i;
        setStepIndex(i);
        const step = plan[i]!;
        const result = await developLocal(step, source).then(
          (url) => ({ ok: true as const, url }),
          () => ({ ok: false as const, error: "That pass didn’t finish. Try it again." }),
        );
        if (cancelRef.current) {
          if (result.ok) {
            const kept = [...nextFrames, { step, url: result.url }];
            setFrames(kept);
            setActive(kept.length - 1);
          }
          setPhase("held");
          setNotice("Held on the last finished pass. Continue from it, or stop here.");
          return;
        }
        if (!result.ok) {
          setFrames([...nextFrames]);
          setResume({ source, index: i });
          setError(result.error);
          setPhase("error");
          return;
        }
        source = await shrinkForSource(result.url).catch(() => result.url);
        nextFrames.push({ step, url: result.url });
        setFrames([...nextFrames]);
        setActive(nextFrames.length - 1);
      }
      setResume(null);
      setPhase("done");
    } catch {
      setResume({ source, index: cursor });
      setError("The portrait pass didn’t finish. Try this pass again.");
      setPhase("error");
    } finally {
      runLock.current = false;
    }
  }

  function develop() {
    if (!original) return;
    const plan = LOCAL_PLAN;
    setLockedPlan(plan);
    void runFrom(original, 0, plan);
  }

  function retry() {
    const plan = lockedPlan ?? LOCAL_PLAN;
    if (!resume || !original) {
      develop();
      return;
    }
    void runFrom(resume.source, resume.index, plan);
  }

  function continueHere() {
    if (!lockedPlan) return;
    const frame = frames[active];
    if (!frame) return;
    const planIndex = lockedPlan.indexOf(frame.step);
    if (planIndex < 0 || planIndex >= lockedPlan.length - 1) return;
    setNotice(null);
    void runFrom(frame.url, planIndex + 1, lockedPlan);
  }

  function stop() {
    cancelRef.current = true;
    setNotice("Finishing this pass, then holding.");
  }

  async function printRefine() {
    if (!sessionId || runLock.current) return;
    const current = frames[active] ?? frames[frames.length - 1];
    if (!current) return;
    runLock.current = true;
    cancelRef.current = false;
    setError(null);
    setNotice(null);
    setPhase("running");
    setPrinting(true);
    setCompare(false);
    try {
      const result = await developLocal(
        "print",
        await shrinkForSource(current.url).catch(() => current.url),
      ).then(
        (url) => ({ ok: true as const, url }),
        () => ({ ok: false as const, error: "The print refine didn’t finish. Try it again." }),
      );
      if (!result.ok) {
        setError(result.error);
        setPhase(frames.length ? "done" : "error");
        return;
      }
      const next = [...frames, { step: "print" as const, url: result.url }];
      setFrames(next);
      setActive(next.length - 1);
      setPhase("done");
    } catch {
      setError("The print refine didn’t finish. Try it again.");
      setPhase("done");
    } finally {
      setPrinting(false);
      runLock.current = false;
    }
  }

  async function onSave(filename: string) {
    const current = frames[active];
    if (!current) return;
    setSaving(true);
    try {
      await savePortrait(current.url, filename);
    } finally {
      setSaving(false);
    }
  }

  const running = phase === "running";
  const viewed = frames[active] ?? null;
  const prospective = LOCAL_PLAN;
  const planSteps = phase === "idle" && frames.length === 0 ? prospective : (lockedPlan ?? prospective);
  const activeStep: StepId | null = printing
    ? "print"
    : running
      ? (planSteps[stepIndex] ?? null)
      : (viewed?.step ?? null);
  const canPrint =
    !running &&
    frames.some((frame) => frame.step === "finish" || frame.step === "sitting" || frame.step === "polish");
  const planIndex = viewed && lockedPlan ? lockedPlan.indexOf(viewed.step) : -1;
  const canContinue =
    !running && lockedPlan !== null && planIndex >= 0 && planIndex < lockedPlan.length - 1;
  const canWipe = Boolean(compare && original && viewed);
  const lastStep = lockedPlan?.[lockedPlan.length - 1] ?? null;
  const finished =
    !running &&
    viewed !== null &&
    (viewed.step === "print" ||
      (lastStep !== null && viewed.step === lastStep && (phase === "done" || phase === "held")));
  const sheetComplete =
    !running &&
    lockedPlan !== null &&
    lockedPlan.every((step) => frames.some((frame) => frame.step === step));
  const doneCount = frames.filter((frame) => planSteps.includes(frame.step)).length;
  const progress = planSteps.length
    ? Math.round((Math.min(doneCount, planSteps.length) / planSteps.length) * 100)
    : 0;

  return (
    <div className="min-h-screen bg-bone text-ink">
      <header className="mx-auto flex max-w-6xl items-end justify-between gap-6 px-5 pt-7 pb-5 md:px-8 md:pt-10">
        <div className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-full bg-ink text-paper shadow-mat">
            <Aperture className="size-5" strokeWidth={1.75} aria-hidden="true" />
          </span>
          <div>
            <p className="text-xs font-medium tracking-widest text-muted uppercase">
              Portrait studio
            </p>
            <h1 className="font-display text-4xl leading-none font-medium tracking-tight md:text-5xl">
              Halide
            </h1>
          </div>
        </div>
        <p className="hidden max-w-xs text-right text-sm leading-relaxed text-muted md:block">
          A studio portrait from the photograph you already have. The face stays yours.
        </p>
      </header>

      <main className="mx-auto grid max-w-6xl items-start gap-6 px-5 pb-16 md:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] md:gap-8 md:px-8">
        <section
          className={`flex flex-col gap-5 ${viewed || running ? "order-2 md:order-1" : "order-1"}`}
          aria-label="Photograph and sitting"
        >
          <div
            className={`rounded-2xl bg-paper p-3 shadow-mat ${dragOver ? "ring-2 ring-umber" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragOver(false);
              if (running) return;
              void takeFile(event.dataTransfer.files[0]);
            }}
          >
            <div className="overflow-hidden rounded-xl bg-bone">
              {original ? (
                <img
                  src={original}
                  alt={fileName ? `Your photograph, ${fileName}` : "Your photograph"}
                  className="frame-angle w-full bg-bone object-contain outline -outline-offset-1 outline-ink/10"
                />
              ) : (
                <div className="frame-angle flex flex-col items-center justify-center gap-3 px-6 text-center">
                  <ImagePlus className="size-6 text-umber" strokeWidth={1.5} aria-hidden="true" />
                  <p className="font-display text-2xl text-ink">Place a photograph</p>
                  <p className="max-w-xs text-sm leading-relaxed text-muted">
                    A selfie is enough. Face the lens, even light if you have it. Drag it here or
                    choose a file.
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <input
              id={inputId}
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/*"
              className="sr-only"
              suppressHydrationWarning
              onChange={(event) => {
                void takeFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <label
              htmlFor={inputId}
              className="inline-flex min-h-11 items-center rounded-full bg-ink px-4 text-sm font-medium text-paper"
            >
              {original ? "Replace photograph" : "Choose photograph"}
            </label>
            {fileName ? (
              <p className="self-center truncate text-sm text-muted">{fileName}</p>
            ) : null}
          </div>

          {original ? (
            <div>
              <p className="text-xs font-medium tracking-widest text-muted uppercase">
                More angles
              </p>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                Optional. Up to three other views of the same person, used only to lock the face.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {angles.map((angle, index) => (
                  <button
                    key={`angle-${index}`}
                    type="button"
                    disabled={running}
                    onClick={() => setAngles((current) => current.filter((_, i) => i !== index))}
                    className="relative size-16 overflow-hidden rounded-xl shadow-mat"
                    aria-label={`Remove angle ${index + 1}`}
                  >
                    <img src={angle} alt="" className="size-full object-cover" />
                    <span className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-ink text-paper">
                      <X className="size-3" aria-hidden="true" />
                    </span>
                  </button>
                ))}
                {angles.length < 3 ? (
                  <label className="grid size-16 cursor-pointer place-items-center rounded-xl bg-paper text-xs font-medium text-ink shadow-mat">
                    Add
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/*"
                      className="sr-only"
                      suppressHydrationWarning
                      disabled={running}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (!file) return;
                        void fileToJpeg(file)
                          .then((jpeg) => {
                            setAngles((current) => (current.length >= 3 ? current : [...current, jpeg]));
                            setError(null);
                          })
                          .catch((err: unknown) => {
                            setError(err instanceof Error ? err.message : "Couldn’t read that photograph.");
                          });
                      }}
                    />
                  </label>
                ) : null}
              </div>
            </div>
          ) : null}

          <p className="m-0 text-sm text-muted">
            Free, on-device finish: tone, light, a pale backdrop, gentle skin retouch and a
            head-and-shoulders crop. Your photo never leaves your phone.
          </p>

          <div className="flex flex-col gap-2">
            {running ? (
              <button
                type="button"
                onClick={stop}
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-ink px-5 text-sm font-medium text-paper"
              >
                <Square className="size-3.5 fill-current" aria-hidden="true" />
                Hold
              </button>
            ) : phase === "error" ? (
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={retry}
                  disabled={!original || !sessionId || ready === false}
                  className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-umber px-5 text-sm font-medium text-paper disabled:opacity-40"
                >
                  <RotateCcw className="size-4" aria-hidden="true" />
                  Try this pass again
                </button>
                <button
                  type="button"
                  onClick={develop}
                  disabled={!original || !sessionId || ready === false}
                  className="inline-flex min-h-11 items-center justify-center rounded-full bg-paper px-4 text-sm font-medium text-ink shadow-mat disabled:opacity-40"
                >
                  Start over
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={develop}
                disabled={!original || !sessionId || ready === false}
                className="inline-flex min-h-12 items-center justify-center rounded-full bg-umber px-5 text-sm font-medium text-paper disabled:opacity-40"
              >
                {frames.length ? "Develop again" : "Develop portrait"}
                <span className="ml-2 tabular-nums text-paper/70">{prospective.length}</span>
              </button>
            )}
            <p className="text-sm leading-relaxed text-muted">
              {phase === "done" && frames.length
                ? "This sitting is finished. Save the portrait, or develop again if you want another."
                : mode === "careful"
                  ? keepClothes
                    ? "Sequence keeps the clothes and changes one thing at a time. Hold if a pass stops looking like you."
                    : "Sequence changes one thing at a time: clean, backdrop, light, retouch, makeup, hair, clothes, pose, then polish. Hold if a pass stops looking like you."
                  : mode === "session"
                    ? "Session is four generations: clean, backdrop, light, then a quiet finish. Hold after any pass."
                    : "Sitting is one generation: backdrop, light, and finish together."}{" "}
              {phase === "done" && frames.length
                ? "The face is not reshaped."
                : "Nothing here reshapes, slims, or beautifies the face."}
            </p>
            {ready === false ? (
              <p className="text-sm text-umber-deep" role="status">
                Portrait generation isn’t available in this environment yet.
              </p>
            ) : null}
          </div>
        </section>

        <section
          className={`flex flex-col gap-4 ${viewed || running ? "order-1 md:order-2" : "order-2"}`}
          aria-label="Portrait"
        >
          <div className="rounded-2xl bg-ink p-3 text-paper shadow-mat md:p-4">
            <div className="mb-3 flex items-baseline justify-between gap-3 px-1">
              <p className="text-xs font-medium tracking-widest text-paper/60 uppercase">
                {finished ? "Your portrait" : activeStep ? STEP_COPY[activeStep].title : "Proof"}
              </p>
              <p className="text-xs text-paper/50 tabular-nums">
                {running
                  ? printing
                    ? "Refining"
                    : planSteps.length === 1
                      ? "Developing"
                      : `${String(Math.min(stepIndex + 1, planSteps.length)).padStart(2, "0")} / ${String(planSteps.length).padStart(2, "0")}`
                  : finished
                    ? "Finished"
                    : viewed
                      ? canWipe
                        ? "Compare"
                        : "Ready"
                      : "Waiting"}
              </p>
            </div>
            {(phase !== "idle" || frames.length > 0) && planSteps.length > 1 ? (
              <div
                className="mb-3 h-1 overflow-hidden rounded-full bg-paper/15"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={planSteps.length}
                aria-valuenow={Math.min(doneCount, planSteps.length)}
                aria-label="Passes finished"
              >
                <div className="h-full bg-umber" style={{ width: `${progress}%` }} />
              </div>
            ) : null}
            <div className="relative overflow-hidden rounded-xl bg-ink">
              {canWipe && original && viewed ? (
                <>
                  <img
                    src={original}
                    alt="Your original photograph"
                    className="frame-proof w-full object-cover"
                  />
                  <img
                    src={viewed.url}
                    alt={`${STEP_COPY[viewed.step].title} portrait`}
                    className="frame-proof absolute inset-0 w-full object-cover"
                    style={{ clipPath: `inset(0 0 0 ${seam}%)` }}
                  />
                  <div
                    className="pointer-events-none absolute inset-y-0 w-0.5 bg-paper"
                    style={{ left: `${seam}%` }}
                  />
                  <span className="pointer-events-none absolute top-3 left-3 rounded-full bg-ink/80 px-2.5 py-1 text-xs text-paper">
                    Before
                  </span>
                  <span className="pointer-events-none absolute top-3 right-3 rounded-full bg-ink/80 px-2.5 py-1 text-xs text-paper">
                    After
                  </span>
                  <label className="absolute inset-x-3 bottom-3">
                    <span className="sr-only">Compare seam</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={seam}
                      onChange={(event) => setSeam(Number(event.target.value))}
                      className="compare-range"
                    />
                  </label>
                </>
              ) : viewed ? (
                <img
                  src={viewed.url}
                  alt={`${STEP_COPY[viewed.step].title} portrait`}
                  className="frame-proof w-full object-cover outline -outline-offset-1 outline-paper/15"
                />
              ) : (
                <div className="frame-proof flex flex-col justify-between p-6 md:p-8">
                  <p className="text-xs tracking-widest text-paper/50 uppercase">Head and shoulders</p>
                  <div>
                    <p className="font-display text-4xl leading-tight font-medium text-paper md:text-5xl">
                      The portrait sits here.
                    </p>
                    <p className="mt-3 max-w-sm text-sm leading-relaxed text-paper/65">
                      Warm pale-bone ground, soft light, a plain top. You’ll see each pass as it
                      finishes.
                    </p>
                  </div>
                </div>
              )}
              {running ? (
                <div className="developing-veil pointer-events-none absolute inset-0 bg-bone" />
              ) : null}
              {running && activeStep ? (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-ink/80 px-4 py-3">
                  <p className="text-sm font-medium text-paper">{STEP_COPY[activeStep].title}</p>
                  <p className="mt-1 text-sm text-paper/75">{STEP_COPY[activeStep].detail}</p>
                </div>
              ) : null}
            </div>
          </div>

          {planSteps.length > 1 && !sheetComplete ? (
            <ol className="flex flex-wrap gap-2">
              {planSteps.map((step, index) => (
                <StepMark
                  key={`${step}-${index}`}
                  step={step}
                  index={index}
                  state={stepState(step, index, frames, running && !printing, stepIndex, phase)}
                />
              ))}
            </ol>
          ) : null}

          {frames.length > 0 ? (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {frames.map((frame, index) => {
                const selected = index === active && !canWipe;
                return (
                  <button
                    key={`${frame.step}-${index}`}
                    type="button"
                    onClick={() => {
                      setCompare(false);
                      setActive(index);
                    }}
                    aria-pressed={selected}
                    className={`flex shrink-0 flex-col items-center gap-1 rounded-xl p-1 ${
                      selected ? "bg-umber text-paper" : "bg-paper text-ink shadow-mat"
                    }`}
                  >
                    <img src={frame.url} alt="" className="thumb rounded-lg object-cover" />
                    <span className="px-1 pb-1 text-xs font-medium">{STEP_COPY[frame.step].short}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {error ? (
            <p className="rounded-2xl bg-paper px-4 py-3 text-sm text-umber-deep shadow-mat" role="alert">
              {error}
            </p>
          ) : null}
          {notice && !error ? (
            <p className="text-sm text-muted" role="status">
              {notice}
            </p>
          ) : null}

          {viewed ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() =>
                  void onSave(finished ? "halide-portrait.jpg" : `halide-${viewed.step}.jpg`)
                }
                disabled={saving || running}
                className="inline-flex min-h-11 items-center gap-2 rounded-full bg-ink px-4 text-sm font-medium text-paper disabled:opacity-40"
              >
                <Download className="size-4" aria-hidden="true" />
                {saving ? "Saving…" : finished ? "Save portrait" : "Save this pass"}
              </button>
              <button
                type="button"
                aria-pressed={compare}
                onClick={() => {
                  setCompare((value) => !value);
                  setSeam(58);
                }}
                disabled={running || !original}
                className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-medium disabled:opacity-40 ${
                  compare ? "bg-umber text-paper" : "bg-paper text-ink shadow-mat"
                }`}
              >
                {compare ? "Close compare" : "Compare"}
              </button>
              {canContinue ? (
                <button
                  type="button"
                  onClick={continueHere}
                  disabled={!sessionId || ready === false}
                  className="inline-flex min-h-11 items-center rounded-full bg-paper px-4 text-sm font-medium text-ink shadow-mat disabled:opacity-40"
                >
                  Continue from here
                </button>
              ) : null}
              {canPrint ? (
                <button
                  type="button"
                  onClick={() => void printRefine()}
                  disabled={running || !sessionId}
                  className="inline-flex min-h-11 items-center rounded-full bg-paper px-4 text-sm font-medium text-ink shadow-mat disabled:opacity-40"
                >
                  Refine for print
                </button>
              ) : null}
            </div>
          ) : null}

          <p className="text-sm leading-relaxed text-muted">
            {finished
              ? "Your photograph was used only to make this portrait. It isn’t saved on a server. Earlier passes stay in the strip if a later one drifted."
              : "Your photograph is used only to make this portrait. It isn’t saved on a server. If a pass stops looking like you, hold and continue from the last good frame."}
          </p>
        </section>
      </main>
    </div>
  );
}

function StepMark({
  step,
  index,
  state,
}: {
  step: StepId;
  index: number;
  state: "wait" | "now" | "done";
}) {
  const copy = STEP_COPY[step];
  return (
    <li
      className={`inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-sm ${
        state === "now" ? "bg-umber text-paper" : "bg-paper text-ink shadow-mat"
      }`}
    >
      <span className={`tabular-nums ${state === "now" ? "text-paper/80" : "text-muted"}`}>
        {String(index + 1).padStart(2, "0")}
      </span>
      <span className="font-medium">{copy.short}</span>
    </li>
  );
}

function stepState(
  step: StepId,
  index: number,
  frames: Frame[],
  running: boolean,
  stepIndex: number,
  phase: Phase,
): "wait" | "now" | "done" {
  if (frames.some((frame) => frame.step === step)) return "done";
  if (running && stepIndex === index) return "now";
  if (phase === "error" && stepIndex === index) return "now";
  return "wait";
}
