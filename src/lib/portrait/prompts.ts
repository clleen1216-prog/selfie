export const WARDS = ["black", "charcoal", "cream", "taupe"] as const;
export type Wardrobe = (typeof WARDS)[number];

export const STEPS = [
  "clean",
  "backdrop",
  "light",
  "keylight",
  "retouch",
  "makeup",
  "hair",
  "wardrobe",
  "pose",
  "finish",
  "polish",
  "sitting",
  "print",
] as const;
export type StepId = (typeof STEPS)[number];

export const SESSION_STEPS = ["clean", "backdrop", "light", "finish"] as const;
export type SessionStep = (typeof SESSION_STEPS)[number];

export const CAREFUL_STEPS = [
  "clean",
  "backdrop",
  "keylight",
  "retouch",
  "makeup",
  "hair",
  "wardrobe",
  "pose",
  "polish",
] as const;

export type DevelopMode = "sitting" | "session" | "careful";

export function planFor(mode: DevelopMode, keepClothes: boolean): StepId[] {
  if (mode === "sitting") return ["sitting"];
  if (mode === "session") return [...SESSION_STEPS];
  const steps: StepId[] = [...CAREFUL_STEPS];
  return keepClothes ? steps.filter((step) => step !== "wardrobe") : steps;
}

export const WARDROBE_LABEL: Record<Wardrobe, string> = {
  black: "Black",
  charcoal: "Charcoal",
  cream: "Cream",
  taupe: "Taupe",
};

export const STEP_COPY: Record<
  StepId,
  { index: string; title: string; short: string; detail: string }
> = {
  clean: {
    index: "01",
    title: "Clean the source",
    short: "Clean",
    detail: "Noise, exposure, and stray clutter. Nothing else moves.",
  },
  backdrop: {
    index: "02",
    title: "Pale-bone backdrop",
    short: "Backdrop",
    detail: "A seamless studio ground, a shade warmer than the skin.",
  },
  light: {
    index: "03",
    title: "Studio light",
    short: "Light",
    detail: "Soft key, gentle fill, and a little separation from the ground.",
  },
  keylight: {
    index: "03",
    title: "Studio light",
    short: "Light",
    detail: "Soft key and fill only. The face, clothes, and expression stay.",
  },
  retouch: {
    index: "04",
    title: "Natural retouch",
    short: "Retouch",
    detail: "Temporary blemishes only. Pores, lines, and freckles stay.",
  },
  makeup: {
    index: "05",
    title: "Natural makeup",
    short: "Makeup",
    detail: "A light complexion, soft eyes, groomed brows, a muted lip.",
  },
  hair: {
    index: "06",
    title: "Hair",
    short: "Hair",
    detail: "The same hair, groomed. Color, curl, and hairline stay.",
  },
  wardrobe: {
    index: "07",
    title: "Wardrobe",
    short: "Clothes",
    detail: "A plain fitted top. No logos, jewelry, or pattern.",
  },
  pose: {
    index: "08",
    title: "Pose",
    short: "Pose",
    detail: "A slight three-quarter turn and a calm gaze to the lens.",
  },
  finish: {
    index: "04",
    title: "Quiet finish",
    short: "Finish",
    detail: "Groomed hair, a plain top, and a calm three-quarter gaze.",
  },
  polish: {
    index: "09",
    title: "Final polish",
    short: "Polish",
    detail: "Head-and-shoulders, clean color, natural depth of field.",
  },
  sitting: {
    index: "01",
    title: "The sitting",
    short: "Sitting",
    detail: "One exposure: backdrop, light, and a quiet finish together.",
  },
  print: {
    index: "05",
    title: "Print refine",
    short: "Print",
    detail: "More detail in hair, cloth, and skin. The face stays put.",
  },
};

const FINISH =
  "Photograph it with a portrait lens: sharp eyes, natural pores, accurate color, clean ears, no plastic smoothing, no extra people, and no warped features.";

const IDENTITY =
  "Preserve the person’s exact facial structure, bone structure, eye shape, nose, lips, jawline, skin tone, natural skin texture, age, hairstyle, and recognizable likeness. Do not beautify, slim, reshape, rejuvenate, or idealize the face. Do not change facial proportions, ethnicity, gender expression, or identity. Keep the face photorealistic and consistent with the reference photo.";

const WARDROBE_PHRASE: Record<Wardrobe, string> = {
  black: "solid black",
  charcoal: "charcoal",
  cream: "cream",
  taupe: "muted taupe",
};

function clothesLine(wardrobe: Wardrobe, keepClothes: boolean): string {
  if (keepClothes) {
    return "Do not change the clothing.";
  }
  return `Replace only the clothing with a well-fitted ${WARDROBE_PHRASE[wardrobe]} top or blazer with a clean simple neckline. No logos, patterns, graphics, jewelry, accessories, or visible branding. The garment should look natural, elegant, and appropriate for a professional studio portrait.`;
}

export function promptFor(step: StepId, wardrobe: Wardrobe, keepClothes: boolean): string {
  switch (step) {
    case "clean":
      return [
        "Using the uploaded selfie as the identity reference, perform only subtle technical cleanup: reduce noise, recover fine facial detail, correct minor exposure and white balance, and remove temporary distractions such as dust, lens flare, or background clutter.",
        "Do not change the pose, clothing, background, makeup, or hairstyle.",
        IDENTITY,
      ].join(" ");
    case "backdrop":
      return [
        "Using the previous image as the identity reference, replace only the background with a smooth, seamless warm pale-bone studio backdrop.",
        "Keep the person’s face, hairstyle, body position, clothing, and natural skin texture exactly unchanged.",
        "The background should fill about half the frame and be a shade warmer than the person’s skin tone.",
        IDENTITY,
      ].join(" ");
    case "light":
      return [
        "Using the previous image as the identity reference, apply soft professional studio portrait lighting: a large soft key light from the front-side, gentle fill light, and subtle natural shadow separation from the background.",
        "Keep the lighting flattering but realistic; avoid harsh contrast, colored gels, dramatic rim light, or overexposure.",
        "Apply only minimal professional retouching: reduce temporary blemishes, stray distracting hairs, and harsh specular highlights while preserving pores, fine lines, freckles, natural skin texture, and facial character.",
        "Do not smooth the skin, remove wrinkles, change face shape, alter nose or lips, whiten eyes or teeth excessively, or create an artificial beauty-filter effect.",
        "Do not change the clothing, background color, hairstyle, or facial expression.",
        IDENTITY,
      ].join(" ");
    case "keylight":
      return [
        "Using the previous image as the identity reference, apply only soft professional studio portrait lighting: a large soft key light from the front-side, gentle fill light, and subtle natural shadow separation from the background.",
        "Keep the lighting flattering but realistic; avoid harsh contrast, colored gels, dramatic rim light, or overexposure.",
        "Do not change the clothing, background color, hairstyle, facial expression, or skin texture.",
        IDENTITY,
      ].join(" ");
    case "retouch":
      return [
        "Using the previous image as the identity reference, apply only minimal professional retouching: reduce temporary blemishes, stray distracting hairs, and harsh specular highlights while preserving pores, fine lines, freckles, natural skin texture, and facial character.",
        "Do not smooth the skin, remove wrinkles, change face shape, alter nose or lips, whiten eyes or teeth excessively, or create an artificial beauty-filter effect.",
        "Do not change the clothing, background, lighting, hairstyle, or facial expression.",
        IDENTITY,
      ].join(" ");
    case "makeup":
      return [
        "Using the previous image as the identity reference, apply very subtle, natural studio makeup suitable for the person’s features and skin tone: lightly even complexion, softly defined eyes, groomed natural brows, and a muted neutral lip.",
        "Keep the result understated and believable. No heavy contouring, false lashes, glitter, bold color, overlined lips, or dramatic eye makeup.",
        "Do not change the clothing, background, lighting, hairstyle, pose, or facial structure.",
        IDENTITY,
      ].join(" ");
    case "hair":
      return [
        "Using the previous image as the identity reference, refine only the hairstyle for a professional studio portrait.",
        "Keep the person’s natural hair texture, hairline, hair color, length, density, curl pattern, and recognizable hairstyle, but make it neatly groomed and camera-ready.",
        "Add only a few natural stray hairs for realism. Do not invent a new hairstyle.",
        "Do not change the face, clothing, background, lighting, or expression.",
        IDENTITY,
      ].join(" ");
    case "wardrobe":
      return [
        "Using the previous image as the identity reference, replace only the clothing.",
        clothesLine(wardrobe, false),
        "Do not change the face, hairstyle, background, lighting, pose, or expression.",
        IDENTITY,
      ].join(" ");
    case "pose":
      return [
        "Using the previous image as the identity reference, adjust only the pose and expression.",
        "Turn the head slightly three-quarters toward the camera, relax the shoulders, keep the chin level or very slightly lifted, and create a calm, confident, approachable expression with a soft natural gaze toward the lens.",
        "The mood should be poised and self-assured, not arrogant, stiff, exaggerated, or overly serious.",
        "Do not change the clothing, background, lighting, or hairstyle.",
        IDENTITY,
      ].join(" ");
    case "polish":
      return [
        "Using the previous image as the identity reference, create the final high-quality professional studio portrait.",
        "Head-and-shoulders composition on the seamless warm pale-bone background, with the soft studio lighting already in the frame.",
        "Keep the makeup, hair, clothing, and expression already achieved. Do not redesign them.",
        "The result should look photographed with a high-quality portrait lens: natural depth of field, clean color, realistic detail, and no artificial filters or exaggerated effects.",
        FINISH,
        IDENTITY,
      ].join(" ");
    case "finish":
      return [
        "Using the previous image as the identity reference, create the final high-quality professional studio portrait.",
        "Head-and-shoulders composition, head turned slightly three-quarters, seamless warm pale-bone background filling about half the frame.",
        "Keep the soft professional studio lighting already in the frame.",
        "Apply very subtle, natural studio makeup suitable for the person’s features and skin tone: lightly even complexion, softly defined eyes, groomed natural brows, and a muted neutral lip.",
        "No heavy contouring, false lashes, glitter, bold color, overlined lips, or dramatic eye makeup.",
        "Refine only the hairstyle so it is neatly groomed and camera-ready. Keep natural hair texture, hairline, hair color, length, density, and curl pattern. Add only a few natural stray hairs for realism.",
        clothesLine(wardrobe, keepClothes),
        "Relax the shoulders, keep the chin level or very slightly lifted, and create a calm, confident, approachable expression with a soft natural gaze toward the lens. Poised, not arrogant, stiff, or overly serious.",
        "The result should look photographed with a high-quality portrait lens: natural depth of field, clean color, realistic detail, no artificial filters.",
        FINISH,
        IDENTITY,
        "Do not change the face.",
      ].join(" ");
    case "sitting":
      return [
        "Using the uploaded selfie as the identity reference, create one finished high-quality professional studio portrait.",
        "Head-and-shoulders composition. Seamless warm pale-bone background filling about half the frame and a shade warmer than the skin tone.",
        "Soft professional studio lighting: a large soft key light from the front-side, gentle fill, and subtle natural shadow separation. No harsh contrast, colored gels, dramatic rim light, or overexposure.",
        "Minimal retouching only: reduce temporary blemishes and harsh specular highlights while preserving pores, fine lines, freckles, and natural skin texture. Do not smooth the skin or erase facial character.",
        "Very subtle natural studio makeup for the person’s features and skin tone: lightly even complexion, softly defined eyes, groomed natural brows, and a muted neutral lip. No heavy contour, false lashes, glitter, or bold color.",
        "Keep the natural hair texture, hairline, hair color, length, density, and curl pattern, groomed and camera-ready, with only a few stray hairs.",
        clothesLine(wardrobe, keepClothes),
        "Turn the head slightly three-quarters toward the camera, relax the shoulders, chin level or very slightly lifted, calm confident approachable expression, soft gaze toward the lens.",
        "Photographed with a high-quality portrait lens: natural depth of field, clean color, realistic detail, no artificial filters or exaggerated effects.",
        FINISH,
        IDENTITY,
      ].join(" ");
    case "print":
      return [
        "Using the previous image as the identity reference, upscale and refine the portrait to high resolution for print-quality output.",
        "Enhance micro-detail, fabric texture, hair strands, and natural skin texture without adding plastic smoothness, changing facial features, altering identity, or introducing new artifacts.",
        FINISH,
        "Do not change the clothing, background, lighting, pose, expression, or hairstyle.",
        IDENTITY,
      ].join(" ");
  }
}
