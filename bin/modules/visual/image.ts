import sharp from "sharp";
import { lstatSync } from "node:fs";
import { writeAtomicNoFollow } from "./secure_io";

export type RgbaImage = {
  width: number;
  height: number;
  data: Buffer;
};

export type Pixel = [number, number, number, number];

export const PYTHON_COMPARE_MAX_IMAGE_PIXELS = 89_478_485;
export const PYTHON_TRIM_MAX_IMAGE_PIXELS = PYTHON_COMPARE_MAX_IMAGE_PIXELS * 2;
export const IMAGE_INPUT_MAX_BYTES = 256 * 1024 * 1024;

export async function decodeImage(
  input: string | Buffer,
  options: { limitInputPixels?: number } = {},
): Promise<RgbaImage> {
  const decoder =
    options.limitInputPixels === undefined
      ? sharp(input)
      : sharp(input, { limitInputPixels: options.limitInputPixels });
  const decoded = await decoder
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: decoded.info.width,
    height: decoded.info.height,
    data: decoded.data,
  };
}

export function pixelAt(image: RgbaImage, x: number, y: number): Pixel {
  const offset = (y * image.width + x) * 4;
  return [
    image.data[offset] ?? 0,
    image.data[offset + 1] ?? 0,
    image.data[offset + 2] ?? 0,
    image.data[offset + 3] ?? 0,
  ];
}

export function setPixel(
  image: RgbaImage,
  x: number,
  y: number,
  pixel: Pixel,
): void {
  const offset = (y * image.width + x) * 4;
  image.data[offset] = pixel[0];
  image.data[offset + 1] = pixel[1];
  image.data[offset + 2] = pixel[2];
  image.data[offset + 3] = pixel[3];
}

export function blankImage(
  width: number,
  height: number,
  pixel: Pixel = [0, 0, 0, 0],
): RgbaImage {
  const data = Buffer.alloc(width * height * 4);
  const image = { width, height, data };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) setPixel(image, x, y, pixel);
  }
  return image;
}

export function padded(
  image: RgbaImage,
  width: number,
  height: number,
): RgbaImage {
  const result = blankImage(width, height);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1)
      setPixel(result, x, y, pixelAt(image, x, y));
  }
  return result;
}

export function difference(left: RgbaImage, right: RgbaImage): RgbaImage {
  const width = Math.max(left.width, right.width);
  const height = Math.max(left.height, right.height);
  const paddedLeft = padded(left, width, height);
  const paddedRight = padded(right, width, height);
  const data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = Math.abs(
      (paddedLeft.data[index] ?? 0) - (paddedRight.data[index] ?? 0),
    );
  }
  return { width, height, data };
}

export function differenceStrength(diff: RgbaImage): Buffer {
  const strength = Buffer.alloc(diff.width * diff.height);
  for (let pixel = 0; pixel < strength.length; pixel += 1) {
    const offset = pixel * 4;
    strength[pixel] = Math.max(
      diff.data[offset] ?? 0,
      diff.data[offset + 1] ?? 0,
      diff.data[offset + 2] ?? 0,
      diff.data[offset + 3] ?? 0,
    );
  }
  return strength;
}

export function differenceBoundingBox(
  diff: RgbaImage,
): [number, number, number, number] | null {
  const strength = differenceStrength(diff);
  let left = diff.width;
  let top = diff.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < diff.height; y += 1) {
    for (let x = 0; x < diff.width; x += 1) {
      if ((strength[y * diff.width + x] ?? 0) === 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return right < 0 ? null : [left, top, right + 1, bottom + 1];
}

export function heatmapImage(diff: RgbaImage): RgbaImage {
  const strength = differenceStrength(diff);
  const data = Buffer.alloc(diff.width * diff.height * 4);
  for (let pixel = 0; pixel < strength.length; pixel += 1) {
    const alpha = Math.min(255, (strength[pixel] ?? 0) * 3);
    const overlay = alpha / 255;
    const offset = pixel * 4;
    data[offset] = Math.round(255 * (1 - overlay) + 232 * overlay);
    data[offset + 1] = Math.round(255 * (1 - overlay) + 47 * overlay);
    data[offset + 2] = Math.round(255 * (1 - overlay) + 47 * overlay);
    data[offset + 3] = 255;
  }
  return { width: diff.width, height: diff.height, data };
}

export async function writePng(
  path: string,
  image: RgbaImage,
  stopAt?: string,
): Promise<void> {
  const png = await sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .png()
    .toBuffer();
  try {
    if (lstatSync(path).isSymbolicLink())
      throw new Error("comparison heatmap output must not be a symlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  writeAtomicNoFollow(path, png, stopAt);
}

export function channelDistance(left: Pixel, right: Pixel): number {
  return Math.max(
    ...left.map((value, index) => Math.abs(value - (right[index] ?? 0))),
  );
}

export function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)] ?? 0;
}

export function medianPixel(samples: Pixel[]): Pixel {
  return [0, 1, 2, 3].map((index) =>
    median(samples.map((sample) => sample[index] ?? 0)),
  ) as Pixel;
}
