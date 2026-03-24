// ── The Iconry DSL ──────────────────────────────────────────────────
// A pack spec describes a batch of icons to generate in a consistent style.

export interface PackSpec {
  name: string;
  style: StyleSpec;
  icons: IconSpec[];
}

export interface StyleSpec {
  /** Base prompt prepended to every icon generation */
  basePrompt: string;
  /** Negative prompt (if the model supports it) */
  negativePrompt?: string;
  /** Provider to use */
  provider: "replicate";
  /** Model identifier (e.g. "black-forest-labs/flux-schnell") */
  model: string;
  /** Reference/example image URLs for style consistency */
  referenceImages?: string[];
  /** Default output size */
  defaultSize?: string;
  /** Seed for reproducibility (if supported) */
  seed?: number;
  /** Extra provider-specific params */
  extra?: Record<string, unknown>;
}

export type IconType = "resource" | "nav_button" | "character" | "tile" | "decoration";

export interface IconSpec {
  /** Unique key, used as filename stem */
  name: string;
  /** Prompt fragment — combined with style.basePrompt */
  prompt: string;
  /** Override default size */
  size?: string;
  /** Semantic type — may map to prompt modifiers */
  type?: IconType;
  /** Per-icon overrides */
  seed?: number;
  extra?: Record<string, unknown>;
}

// ── Generation state ────────────────────────────────────────────────

export type JobStatus = "pending" | "running" | "completed" | "failed";

export interface GenerationJob {
  id: string;
  packName: string;
  iconName: string;
  status: JobStatus;
  prompt: string;
  provider: string;
  model: string;
  /** URL of generated image (once completed) */
  resultUrl?: string;
  /** R2 key where the image is stored */
  storedKey?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PackState {
  spec: PackSpec;
  jobs: GenerationJob[];
  createdAt: string;
}

// ── API types ───────────────────────────────────────────────────────

export interface GenerateRequest {
  prompt: string;
  provider: "replicate";
  model: string;
  size?: string;
  seed?: number;
  referenceImages?: string[];
  negativePrompt?: string;
  extra?: Record<string, unknown>;
}

export interface GenerateResponse {
  id: string;
  status: JobStatus;
  resultUrl?: string;
  storedKey?: string;
  error?: string;
}

export interface BatchRequest {
  pack: PackSpec;
}

export interface BatchResponse {
  packId: string;
  jobs: GenerationJob[];
}

// ── Example pack for the tropical island game ───────────────────────

export const EXAMPLE_PACK: PackSpec = {
  name: "tropical-island-resources",
  style: {
    basePrompt:
      "minimal flat icon, game asset, tropical island theme, clean edges, transparent background",
    negativePrompt: "blurry, text, watermark, photo-realistic, gradient",
    provider: "replicate",
    model: "black-forest-labs/flux-schnell",
    defaultSize: "256x256",
  },
  icons: [
    { name: "coconut", prompt: "a coconut", type: "resource" },
    { name: "wood", prompt: "a wooden plank", type: "resource" },
    { name: "stone", prompt: "a smooth grey stone", type: "resource" },
    { name: "fish", prompt: "a tropical fish", type: "resource" },
    { name: "shell", prompt: "a pink seashell", type: "resource" },
    { name: "water", prompt: "a water droplet", type: "resource" },
    { name: "build_btn", prompt: "a hammer icon", size: "128x128", type: "nav_button" },
    { name: "inventory_btn", prompt: "a backpack icon", size: "128x128", type: "nav_button" },
  ],
};
