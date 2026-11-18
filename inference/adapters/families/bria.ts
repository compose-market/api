/**
 * Bria AI family wire protocol.
 * 
 * Handles request payload building for Bria models:
 *   - RMBG 2.0 (background removal)
 *   - Erase / Erase Foreground / Blur Background
 *   - Replace Background / Expand / Generative Fill
 *   - Bria 3.2 text-to-image / vector
 * 
 * API Reference:
 *   - https://docs.bria.ai/
 */

import { sizeToDimensions } from "../shared/index.js";
import type { ImageInput, ImageEditMode } from "../modalities/image.js";

export interface BriaImageOptions {
  prompt?: string;
  image?: string;
  mask?: string;
  n?: number;
  size?: string;
  width?: number;
  height?: number;
  aspectRatio?: string;
  seed?: number;
  steps?: number;
  guidance?: number;
  outputFormat?: "png" | "jpeg" | "webp";
  mode?: ImageEditMode;
  customParams?: Record<string, unknown>;
}

export function buildBriaBody(
  modelId: string,
  prompt: string,
  options: BriaImageOptions = {}
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const idLower = modelId.toLowerCase();

  // Basic prompt
  if (prompt) {
    body.prompt = prompt;
  }

  // Image input
  if (options.image) {
    body.image = options.image;
  }

  // Mask input (for erase / gen_fill / inpainting)
  if (options.mask) {
    body.mask = options.mask;
  }

  // Geometry
  const sizeDims = sizeToDimensions(options.size);
  const width = options.width ?? sizeDims.width;
  const height = options.height ?? sizeDims.height;

  if (typeof width === "number") body.width = width;
  if (typeof height === "number") body.height = height;
  if (options.aspectRatio) body.aspect_ratio = options.aspectRatio;
  if (typeof options.seed === "number") body.seed = options.seed;
  if (typeof options.steps === "number") body.num_inference_steps = options.steps;
  if (typeof options.guidance === "number") body.guidance_scale = options.guidance;

  // Add custom parameters
  if (options.customParams) {
    Object.assign(body, options.customParams);
  }

  return body;
}
