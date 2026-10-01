/**
 * Converts an image URI (expo-image-picker result) into a local JPEG path that nobodywho can read.
 *
 * Why this step is needed (sources checked 2026-10-01):
 * - nobodywho `ContentPart::Image { path: PathBuf }` -> llama.cpp mtmd `MtmdBitmap::from_file` (stb_image).
 *   It expects a plain filesystem path, not a `file://` URI, and stb_image cannot decode HEIC
 *   and ignores EXIF orientation. Re-encoding through expo-image-manipulator yields an upright JPEG.
 *   (nobodywho core/src/tokenizer.rs `load_image`, core/src/content.rs)
 * - Qwen3.5 vision uses dynamic resolution (~32x32 px per image token after 2x2 merge).
 *   A 12MP photo would need thousands of image tokens and overflow CONTEXT_SIZE (4096).
 *   Long side 768px -> at most ~576 image tokens (estimate; measured per response as metrics.imageTokens).
 */
import {
  ImageManipulator,
  SaveFormat,
  type ImageManipulatorContext,
  type ImageRef,
  type ImageResult,
} from 'expo-image-manipulator';

/** Longest image side sent to the model. Estimate-based; tune with metrics.imageTokens. */
export const MAX_IMAGE_SIDE = 768;
const JPEG_QUALITY = 0.9;

export type PreparedImage = { path: string; width: number; height: number; prepMs: number };

export function fileUriToPath(uri: string): string {
  if (uri.startsWith('file://')) {
    return decodeURIComponent(uri.slice('file://'.length));
  }
  return uri;
}

export async function prepareImage(uri: string): Promise<PreparedImage> {
  const started = performance.now();

  // Decode once: the first render gives the size, and the same ImageRef is the source of the resize.
  // Every native shared object is released in finally, also when decoding/saving throws.
  const loader = ImageManipulator.manipulate(uri);
  let original: ImageRef | null = null;
  let context: ImageManipulatorContext | null = null;
  let rendered: ImageRef | null = null;
  let result: ImageResult;
  try {
    original = await loader.renderAsync();
    const { width, height } = original;
    context = ImageManipulator.manipulate(original);
    if (Math.max(width, height) > MAX_IMAGE_SIDE) {
      context.resize(width >= height ? { width: MAX_IMAGE_SIDE } : { height: MAX_IMAGE_SIDE });
    }
    rendered = await context.renderAsync();
    result = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_QUALITY });
  } finally {
    rendered?.release();
    context?.release();
    original?.release();
    loader.release();
  }

  return {
    path: fileUriToPath(result.uri),
    width: result.width,
    height: result.height,
    prepMs: performance.now() - started,
  };
}
