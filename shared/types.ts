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
  /** URL of an input image for img2img generation */
  inputImageUrl?: string;
  /** How much to deviate from the input image (0 = faithful, 1 = ignore input). Default ~0.8 */
  promptStrength?: number;
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

// ── Projects ────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  /** Common prompt prefix prepended to every item */
  preamble: string;
  /** Common prompt suffix appended to every item */
  postfix: string;
  /** Individual items to generate */
  items: string[];
  /** Model to use */
  model: string;
  /** Output size */
  size: string;
  /** History of generation runs */
  runs: ProjectRun[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRun {
  id: string;
  /** Snapshot of the preamble/postfix/model used for this run */
  preamble: string;
  postfix: string;
  model: string;
  size: string;
  /** Per-item results */
  results: ProjectRunResult[];
  createdAt: string;
}

export interface ProjectRunResult {
  item: string;
  prompt: string;
  storedKey?: string;
  status: JobStatus;
  error?: string;
}

// ── Saved Drawings ─────────────────────────────────────────────────

export interface SavedDrawing {
  id: string;
  /** R2 key of the stored image */
  imageKey: string;
  /** Tags for organizing and filtering */
  tags: string[];
  /** Optional note about this drawing */
  note: string;
  /** The prompt used to generate this image */
  prompt: string;
  /** Model used for generation */
  model: string;
  /** Provider used */
  provider: string;
  /** Where this came from (e.g. "explorer", project name, pack name) */
  source: string;
  createdAt: string;
  updatedAt: string;
}

// ── Game Icon Projects ────────────────────────────────────────────
// Rich icon spec with chains, categories, and per-icon status tracking.
// Designed for incremental generation workflows where you build up
// a full icon set over time.

export interface GameIconSpec {
  /** Unique key — matches the game's enum value, used as filename */
  id: string;
  /** What the icon literally depicts */
  object: string;
  /** Art direction — composition, angle, lighting, key details */
  description: string;
  /** Where this icon appears in-game */
  use: string;
  /** Visual mood — maps to game phase color palette */
  theme: string;
  /** Visual grouping — icons in same category share style */
  category: string;
  /** Named generation chain — related items should look consistent */
  chain: string | null;
  /** "base" = generate first; "derived" = use base as img2img reference */
  chainRole: "base" | "derived" | "standalone";
  /** How this item visually differs from its chain base */
  chainNote?: string;
  /** Target render size (square, e.g. 64) */
  size: number;
  /** Freeform tags for filtering/batch generation */
  tags: string[];
}

export interface GameStyleGuide {
  approach: string;
  resolution: string;
  paletteConstraints: string[];
  composition: string[];
  consistency: string[];
  phaseTinting: Record<string, string>;
}

export type GameIconStatus = "pending" | "generated" | "approved" | "rejected";

export interface GameIconState {
  /** References GameIconSpec.id */
  specId: string;
  status: GameIconStatus;
  /** R2 key of the current image (latest approved or generated) */
  currentImageKey?: string;
  /** Model used to generate the current image */
  currentModel?: string;
  /** Prompt used to generate the current image */
  currentPrompt?: string;
  /** Every generation attempt */
  history: GameIconHistoryEntry[];
}

export interface GameIconHistoryEntry {
  imageKey: string;
  model: string;
  prompt: string;
  timestamp: string;
  /** Was this the one that got approved? */
  approved: boolean;
}

export interface GameProject {
  id: string;
  name: string;
  styleGuide: GameStyleGuide;
  icons: GameIconSpec[];
  /** Per-icon generation state — keyed by spec id for fast lookup */
  states: Record<string, GameIconState>;
  /** Default model for generation */
  defaultModel: string;
  /** Default size string (e.g. "64x64") */
  defaultSize: string;
  createdAt: string;
  updatedAt: string;
}

export interface GameProjectSummary {
  id: string;
  name: string;
  total: number;
  pending: number;
  generated: number;
  approved: number;
  rejected: number;
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
