/**
 * Prompt Builder
 *
 * Turns a GameIconSpec + GameStyleGuide into a generation-ready prompt.
 * Each icon gets a tailored prompt based on its description, theme, category,
 * and chain context — rather than a flat preamble shared across all icons.
 */

import type { GameIconSpec, GameStyleGuide } from "./types.js";

export interface PromptOptions {
  /** Override the style approach */
  styleOverride?: string;
  /** Additional prompt text appended at the end */
  suffix?: string;
  /** If true, include chain context for derived icons */
  includeChainContext?: boolean;
}

/**
 * Build a generation prompt for a single icon spec.
 */
export function buildPrompt(
  icon: GameIconSpec,
  style: GameStyleGuide,
  options: PromptOptions = {}
): string {
  const parts: string[] = [];

  // 1. Style approach
  parts.push(options.styleOverride ?? style.approach);

  // 2. Phase tinting context
  const tinting = style.phaseTinting[icon.theme];
  if (tinting) {
    parts.push(tinting);
  }

  // 3. The icon's own description (the meat of the prompt)
  parts.push(icon.description);

  // 4. Composition rules (pick the most relevant)
  parts.push("Single object, centered, filling ~80% of the frame");
  parts.push("Slight 3/4 top-down perspective");
  parts.push("Transparent background");

  // 5. Consistency rules
  parts.push("Top-left lighting, 2-3px outlines at 64×64");
  parts.push("Natural, weathered, handmade feel");

  // 6. Chain context for derived icons
  if (options.includeChainContext !== false && icon.chainRole === "derived" && icon.chainNote) {
    parts.push(`Visual relationship: ${icon.chainNote}`);
  }

  // 7. Optional suffix
  if (options.suffix) {
    parts.push(options.suffix);
  }

  return parts.join(". ") + ".";
}

/**
 * Build prompts for a batch of icons.
 */
export function buildPrompts(
  icons: GameIconSpec[],
  style: GameStyleGuide,
  options: PromptOptions = {}
): Map<string, string> {
  const result = new Map<string, string>();
  for (const icon of icons) {
    result.set(icon.id, buildPrompt(icon, style, options));
  }
  return result;
}

/**
 * Get all unique chain names from a set of icons.
 */
export function getChains(icons: GameIconSpec[]): string[] {
  const chains = new Set<string>();
  for (const icon of icons) {
    if (icon.chain) chains.add(icon.chain);
  }
  return [...chains];
}

/**
 * Get all unique categories from a set of icons.
 */
export function getCategories(icons: GameIconSpec[]): string[] {
  const categories = new Set<string>();
  for (const icon of icons) {
    categories.add(icon.category);
  }
  return [...categories];
}

/**
 * Get all unique themes from a set of icons.
 */
export function getThemes(icons: GameIconSpec[]): string[] {
  const themes = new Set<string>();
  for (const icon of icons) {
    themes.add(icon.theme);
  }
  return [...themes];
}

/**
 * Filter icons by various criteria.
 */
export function filterIcons(
  icons: GameIconSpec[],
  filter: {
    chain?: string;
    category?: string;
    theme?: string;
    chainRole?: "base" | "derived" | "standalone";
    tags?: string[];
    ids?: string[];
  }
): GameIconSpec[] {
  return icons.filter((icon) => {
    if (filter.chain !== undefined && icon.chain !== filter.chain) return false;
    if (filter.category && icon.category !== filter.category) return false;
    if (filter.theme && icon.theme !== filter.theme) return false;
    if (filter.chainRole && icon.chainRole !== filter.chainRole) return false;
    if (filter.tags && !filter.tags.every((t) => icon.tags.includes(t))) return false;
    if (filter.ids && !filter.ids.includes(icon.id)) return false;
    return true;
  });
}

/**
 * Order icons for generation: bases first, then derived, then standalone.
 * Within each group, order by chain so related icons are adjacent.
 */
export function orderForGeneration(icons: GameIconSpec[]): GameIconSpec[] {
  const roleOrder = { base: 0, standalone: 1, derived: 2 };
  return [...icons].sort((a, b) => {
    const ra = roleOrder[a.chainRole];
    const rb = roleOrder[b.chainRole];
    if (ra !== rb) return ra - rb;
    // Within same role, group by chain
    const ca = a.chain ?? "";
    const cb = b.chain ?? "";
    return ca.localeCompare(cb);
  });
}
