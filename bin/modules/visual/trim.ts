import { dirname, extname, resolve } from "node:path";
import {
  channelDistance,
  decodeImage,
  IMAGE_INPUT_MAX_BYTES,
  medianPixel,
  padded,
  pixelAt,
  PYTHON_TRIM_MAX_IMAGE_PIXELS,
  type Pixel,
} from "./image";
import sharp from "sharp";
import { ensureDirectory } from "./paths";
import { readRegularNoFollow, writeAtomicNoFollow } from "./secure_io";
import { writeAll } from "./write_all";

export const TRIM_ONLY = "trim_only";
export const REQUIRE_MARGIN = "require_margin";

export type TrimResult = {
  input: string;
  output: string;
  margin_policy: string;
  evidence_surface: string;
  action: "unchanged" | "blocked" | "cropped";
  reason: string;
  padding: number;
  background_rgba: number[] | null;
  content_bbox: number[] | null;
  crop_box: number[] | null;
  margin_satisfied: boolean | null;
  trimmed_pixels: { left: number; top: number; right: number; bottom: number };
  added_pixels: { left: number; top: number; right: number; bottom: number };
};

export function clamp(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(upper, value));
}

export function iterBorderPixels(
  image: { width: number; height: number; data: Buffer },
  borderWidth: number,
): Pixel[] {
  const border = Math.max(
    1,
    Math.min(
      borderWidth,
      Math.floor(image.width / 2) || 1,
      Math.floor(image.height / 2) || 1,
    ),
  );
  const seen = new Set<string>();
  const samples: Pixel[] = [];
  const add = (x: number, y: number) => {
    const key = `${x}:${y}`;
    if (seen.has(key)) return;
    seen.add(key);
    samples.push(pixelAt(image, x, y));
  };
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < border; x += 1) add(x, y);
    for (let x = image.width - border; x < image.width; x += 1) add(x, y);
  }
  for (let y = 0; y < border; y += 1)
    for (let x = 0; x < image.width; x += 1) add(x, y);
  for (let y = image.height - border; y < image.height; y += 1)
    for (let x = 0; x < image.width; x += 1) add(x, y);
  return samples;
}

export function detectBackground(
  image: { width: number; height: number; data: Buffer },
  borderWidth = 2,
  tolerance = 12,
  minUniformity = 0.95,
): { background: Pixel | null; error: string | null } {
  const samples = iterBorderPixels(image, borderWidth);
  if (samples.length === 0) return { background: null, error: "empty_image" };
  const background = medianPixel(samples);
  const uniformity =
    samples.filter((sample) => channelDistance(sample, background) <= tolerance)
      .length / samples.length;
  return uniformity < minUniformity
    ? { background: null, error: "ambiguous_border" }
    : { background, error: null };
}

export function detectContentBbox(
  image: { width: number; height: number; data: Buffer },
  background: Pixel,
  diffThreshold = 12,
): [number, number, number, number] | null {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const pixel = pixelAt(image, x, y);
      const difference = [0, 1, 2].map((index) =>
        Math.abs((pixel[index] ?? 0) - (background[index] ?? 0)),
      );
      const luminance = Math.floor(
        ((difference[0] ?? 0) * 19595 +
          (difference[1] ?? 0) * 38470 +
          (difference[2] ?? 0) * 7471 +
          0x8000) /
          0x10000,
      );
      if (luminance <= diffThreshold) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return right < 0 ? null : [left, top, right + 1, bottom + 1];
}

export function desiredPadding(bbox: [number, number, number, number]): number {
  const longEdge = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
  const rounded = Math.floor(longEdge * 0.02);
  const fraction = longEdge * 0.02 - rounded;
  const padding =
    fraction < 0.5 || (fraction === 0.5 && rounded % 2 === 0)
      ? rounded
      : rounded + 1;
  return clamp(padding, 16, 48);
}

export function expandBboxWithinImage(
  bbox: [number, number, number, number],
  size: [number, number],
  padding: number,
): [number, number, number, number] {
  return [
    Math.max(0, bbox[0] - padding),
    Math.max(0, bbox[1] - padding),
    Math.min(size[0], bbox[2] + padding),
    Math.min(size[1], bbox[3] + padding),
  ];
}

function emptyResult(
  input: string,
  output: string,
  marginPolicy: string,
  evidenceSurface: string,
): TrimResult {
  return {
    input,
    output,
    margin_policy: marginPolicy,
    evidence_surface: evidenceSurface,
    action: "unchanged",
    reason: "",
    padding: 0,
    background_rgba: null,
    content_bbox: null,
    crop_box: null,
    margin_satisfied: null,
    trimmed_pixels: { left: 0, top: 0, right: 0, bottom: 0 },
    added_pixels: { left: 0, top: 0, right: 0, bottom: 0 },
  };
}

export async function trimFile(
  input: string,
  output: string,
  options: {
    marginPolicy?: string;
    evidenceSurface?: string;
    borderWidth?: number;
    tolerance?: number;
    minUniformity?: number;
    minTrimPixels?: number;
  } = {},
): Promise<TrimResult> {
  const marginPolicy = options.marginPolicy ?? TRIM_ONLY;
  const evidenceSurface = options.evidenceSurface ?? "page";
  const borderWidth = options.borderWidth ?? 2;
  const tolerance = options.tolerance ?? 12;
  const minUniformity = options.minUniformity ?? 0.95;
  const minTrimPixels = options.minTrimPixels ?? 8;
  if (![TRIM_ONLY, REQUIRE_MARGIN].includes(marginPolicy))
    throw new Error(`unsupported margin_policy: ${marginPolicy}`);
  const result = emptyResult(input, output, marginPolicy, evidenceSurface);
  const outputPath = resolve(output);
  const outputRoot = dirname(outputPath);
  const outputExtension = extname(outputPath).toLowerCase();
  if (
    ![
      ".png",
      ".jpg",
      ".jpeg",
      ".webp",
      ".gif",
      ".avif",
      ".tif",
      ".tiff",
    ].includes(outputExtension)
  )
    throw new Error(`unsupported image output format: ${outputExtension}`);
  ensureDirectory(outputRoot);
  const copyOriginal = async () => {
    if (resolve(input) !== outputPath)
      writeAtomicNoFollow(
        outputPath,
        (fileFd) =>
          readRegularNoFollow(input, undefined, (chunk) =>
            writeAll(fileFd, chunk, "file copy failed"),
          ),
        outputRoot,
      );
  };
  if (marginPolicy === REQUIRE_MARGIN) {
    await copyOriginal();
    result.action = "blocked";
    result.reason = "source_managed_surface_required";
    result.margin_satisfied = false;
    return result;
  }
  const inputBytes = readRegularNoFollow(
    input,
    undefined,
    undefined,
    IMAGE_INPUT_MAX_BYTES,
  );
  const image = await decodeImage(inputBytes, {
    limitInputPixels: PYTHON_TRIM_MAX_IMAGE_PIXELS,
  });
  const detected = detectBackground(
    image,
    borderWidth,
    tolerance,
    minUniformity,
  );
  if (!detected.background) {
    await copyOriginal();
    result.reason = detected.error ?? "no_detectable_background";
    return result;
  }
  const bbox = detectContentBbox(image, detected.background, tolerance);
  result.background_rgba = [...detected.background];
  result.content_bbox = bbox ? [...bbox] : null;
  if (!bbox) {
    await copyOriginal();
    result.reason = "no_detectable_content";
    return result;
  }
  const padding = desiredPadding(bbox);
  const cropBox = expandBboxWithinImage(
    bbox,
    [image.width, image.height],
    padding,
  );
  const removed: [number, number, number, number] = [
    cropBox[0],
    cropBox[1],
    image.width - cropBox[2],
    image.height - cropBox[3],
  ];
  result.padding = padding;
  result.crop_box = [...cropBox];
  result.trimmed_pixels = {
    left: removed[0],
    top: removed[1],
    right: removed[2],
    bottom: removed[3],
  };
  if (Math.max(...removed) < minTrimPixels) {
    await copyOriginal();
    result.reason = "no_meaningful_whitespace";
    return result;
  }
  const croppedPipeline = sharp(inputBytes, {
    limitInputPixels: PYTHON_TRIM_MAX_IMAGE_PIXELS,
  }).extract({
    left: cropBox[0],
    top: cropBox[1],
    width: cropBox[2] - cropBox[0],
    height: cropBox[3] - cropBox[1],
  });
  if (outputExtension === ".png") croppedPipeline.png();
  else if ([".jpg", ".jpeg"].includes(outputExtension)) croppedPipeline.jpeg();
  else if (outputExtension === ".webp") croppedPipeline.webp();
  else if (outputExtension === ".gif") croppedPipeline.gif();
  else if (outputExtension === ".avif") croppedPipeline.avif();
  else if ([".tif", ".tiff"].includes(outputExtension)) croppedPipeline.tiff();
  const cropped = await croppedPipeline.toBuffer();
  writeAtomicNoFollow(outputPath, cropped, outputRoot);
  result.action = "cropped";
  result.reason = "trimmed_excess_whitespace";
  return result;
}
