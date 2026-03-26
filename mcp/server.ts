#!/usr/bin/env node

/**
 * Iconry MCP Server
 *
 * Exposes icon generation as MCP tools so Claude (or any MCP client)
 * can generate game assets directly.
 *
 * Usage:
 *   ICONRY_API_URL=https://iconry.pages.dev ICONRY_AUTH_TOKEN=xxx npx tsx mcp/server.ts
 *
 * Or add to claude_desktop_config.json:
 *   {
 *     "mcpServers": {
 *       "iconry": {
 *         "command": "npx",
 *         "args": ["tsx", "/path/to/iconry/mcp/server.ts"],
 *         "env": {
 *           "ICONRY_API_URL": "https://iconry.pages.dev",
 *           "ICONRY_AUTH_TOKEN": "your-secret"
 *         }
 *       }
 *     }
 *   }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { PackSpec, GenerateRequest, GenerateResponse, BatchResponse, GameProject, GameProjectSummary, GameIconStatus } from "../shared/types.js";
import { SEABOUND_STYLE, SEABOUND_ICONS } from "../shared/seabound-icons.js";
import { buildPrompt, filterIcons, getChains, getCategories } from "../shared/prompt-builder.js";

const API_URL = process.env.ICONRY_API_URL ?? "http://localhost:8787";
const AUTH_TOKEN = process.env.ICONRY_AUTH_TOKEN ?? "";

async function apiRequest<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      ...(AUTH_TOKEN && { Authorization: `Bearer ${AUTH_TOKEN}` }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

async function pollUntilDone(id: string, maxAttempts = 60): Promise<GenerateResponse> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await apiRequest<GenerateResponse>(`/api/poll/${id}`);
    if (res.status === "completed" || res.status === "failed") return res;
  }
  return { id, status: "failed", error: "Polling timeout" };
}

const server = new Server(
  { name: "iconry", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "generate_icon",
      description:
        "Generate a single icon/game asset image via Replicate. Returns the image URL. " +
        "Use this for quick exploration or one-off assets.",
      inputSchema: {
        type: "object" as const,
        properties: {
          prompt: {
            type: "string",
            description:
              "Full prompt for the icon, e.g. 'minimal flat icon, game asset, a coconut, transparent background'",
          },
          model: {
            type: "string",
            description:
              "Replicate model ID (default: black-forest-labs/flux-schnell)",
          },
          size: {
            type: "string",
            description: "Output size like '256x256' (default: 256x256)",
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "generate_icon_pack",
      description:
        "Generate a batch of icons from a pack specification. " +
        "Provide a full PackSpec JSON with style and icon list. " +
        "Icons are generated sequentially to respect rate limits. " +
        "Returns status of all generated icons.",
      inputSchema: {
        type: "object" as const,
        properties: {
          pack: {
            type: "object",
            description:
              "A PackSpec object with name, style (basePrompt, model, etc), and icons array",
          },
        },
        required: ["pack"],
      },
    },
    {
      name: "check_status",
      description:
        "Check whether the Iconry backend is reachable and Replicate is configured.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },

    // ── Game Project tools ──────────────────────────────────────────

    {
      name: "list_game_icons",
      description:
        "List all icons in the SeaBound game project with their current status. " +
        "Shows which icons are pending, generated, approved, or rejected. " +
        "Filter by chain, category, theme, status, or specific IDs.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chain: { type: "string", description: "Filter by chain name (e.g. 'coconut', 'fiber', 'stone_knapped')" },
          category: { type: "string", description: "Filter by category (e.g. 'fruit', 'wood', 'stone', 'fish')" },
          theme: { type: "string", description: "Filter by theme (e.g. 'bare_hands', 'bamboo', 'fire', 'stone', 'maritime')" },
          status: { type: "string", description: "Filter by status: 'pending', 'generated', 'approved', 'rejected'" },
          ids: {
            type: "array",
            items: { type: "string" },
            description: "Filter to specific icon IDs",
          },
        },
      },
    },

    {
      name: "sync_game_project",
      description:
        "Create or sync the SeaBound game project. " +
        "Uploads the current icon spec to the backend. " +
        "Preserves existing generation states — new icons get 'pending' status, " +
        "removed icons are dropped, existing icons keep their state.",
      inputSchema: {
        type: "object" as const,
        properties: {
          model: {
            type: "string",
            description: "Default model for generation (default: black-forest-labs/flux-schnell)",
          },
        },
      },
    },

    {
      name: "generate_game_icons",
      description:
        "Generate icons for the SeaBound game project. " +
        "Specify which icons to generate by ID, chain, category, or theme. " +
        "Base icons in a chain are generated first. " +
        "Derived icons use img2img from their approved base for visual consistency. " +
        "Returns the result for each icon generated.",
      inputSchema: {
        type: "object" as const,
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "Specific icon IDs to generate",
          },
          chain: { type: "string", description: "Generate all icons in a chain (e.g. 'coconut')" },
          category: { type: "string", description: "Generate all icons in a category (e.g. 'fish')" },
          theme: { type: "string", description: "Generate all icons with this theme" },
          model: { type: "string", description: "Override model for this batch" },
          onlyPending: {
            type: "boolean",
            description: "Only generate icons that are pending or rejected (default: true)",
          },
        },
      },
    },

    {
      name: "approve_game_icons",
      description:
        "Approve or reject generated icons. Approved icons are ready for export to the game. " +
        "Rejected icons can be re-generated.",
      inputSchema: {
        type: "object" as const,
        properties: {
          approve: {
            type: "array",
            items: { type: "string" },
            description: "Icon IDs to approve",
          },
          reject: {
            type: "array",
            items: { type: "string" },
            description: "Icon IDs to reject (can be re-generated later)",
          },
        },
      },
    },

    {
      name: "export_game_icons",
      description:
        "Get download URLs for approved (or all generated) game icons. " +
        "Returns a list of icon IDs and their image URLs, ready to download " +
        "and place into the game's asset directory.",
      inputSchema: {
        type: "object" as const,
        properties: {
          status: {
            type: "string",
            description: "Which icons to export: 'approved' (default), 'generated', or 'all'",
          },
        },
      },
    },

    {
      name: "preview_prompt",
      description:
        "Preview the generation prompt that would be built for a specific icon. " +
        "Useful for reviewing/tweaking before actually generating.",
      inputSchema: {
        type: "object" as const,
        properties: {
          iconId: { type: "string", description: "The icon ID to preview the prompt for" },
        },
        required: ["iconId"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "generate_icon": {
      const prompt = args?.prompt as string;
      const model = (args?.model as string) ?? "black-forest-labs/flux-schnell";
      const size = (args?.size as string) ?? "256x256";

      const req: GenerateRequest = { prompt, provider: "replicate", model, size };
      let res = await apiRequest<GenerateResponse>("/api/generate", req);

      // Poll if async
      if (res.status !== "completed" && res.status !== "failed" && res.id) {
        res = await pollUntilDone(res.id);
      }

      if (res.status === "completed" && res.resultUrl) {
        return {
          content: [
            { type: "text", text: `Icon generated successfully!\nURL: ${res.resultUrl}` },
            { type: "image", data: res.resultUrl, mimeType: "image/png" },
          ],
        };
      }

      return {
        content: [{ type: "text", text: `Generation failed: ${res.error ?? "unknown error"}` }],
        isError: true,
      };
    }

    case "generate_icon_pack": {
      const pack = args?.pack as PackSpec;
      const res = await apiRequest<BatchResponse>("/api/batch", { pack });

      const completed = res.jobs.filter((j) => j.status === "completed");
      const failed = res.jobs.filter((j) => j.status === "failed");

      const summary = [
        `Pack "${pack.name}" generation complete.`,
        `${completed.length}/${res.jobs.length} succeeded, ${failed.length} failed.`,
        "",
        "Results:",
        ...res.jobs.map(
          (j) =>
            `  ${j.status === "completed" ? "ok" : "FAIL"} ${j.iconName}: ${j.resultUrl ?? j.error ?? "no result"}`
        ),
      ].join("\n");

      return { content: [{ type: "text", text: summary }] };
    }

    case "check_status": {
      const health = await apiRequest<{
        ok: boolean;
        replicate: boolean;
        r2: boolean;
        auth: boolean;
      }>("/api/health");

      const lines = [
        `Backend: ${health.ok ? "connected" : "error"}`,
        `Auth: ${health.auth ? "configured" : "not configured"}`,
        `R2 Storage: ${health.r2 ? "configured" : "not configured"}`,
        `Replicate: ${health.replicate ? "configured" : "no API key"}`,
      ];

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    // ── Game Project handlers ──────────────────────────────────────

    case "list_game_icons": {
      const PROJECT_ID = "seabound";
      let project: GameProject | null = null;

      try {
        project = await apiRequest<GameProject>(`/api/game-projects/${PROJECT_ID}`);
      } catch {
        // Project doesn't exist yet — show spec-only view
      }

      let icons = SEABOUND_ICONS;

      // Apply filters
      const chain = args?.chain as string | undefined;
      const category = args?.category as string | undefined;
      const theme = args?.theme as string | undefined;
      const statusFilter = args?.status as string | undefined;
      const ids = args?.ids as string[] | undefined;

      if (chain !== undefined || category || theme || ids) {
        icons = filterIcons(icons, { chain, category, theme, ids });
      }

      const lines: string[] = [];

      // Summary
      if (project) {
        const states = Object.values(project.states);
        const counts = {
          total: project.icons.length,
          pending: states.filter((s) => s.status === "pending").length,
          generated: states.filter((s) => s.status === "generated").length,
          approved: states.filter((s) => s.status === "approved").length,
          rejected: states.filter((s) => s.status === "rejected").length,
        };
        lines.push(`SeaBound Icons: ${counts.total} total — ${counts.approved} approved, ${counts.generated} generated, ${counts.pending} pending, ${counts.rejected} rejected`);
      } else {
        lines.push(`SeaBound Icons: ${SEABOUND_ICONS.length} in spec (project not yet synced — run sync_game_project first)`);
      }
      lines.push("");

      // Group by chain for readability
      const byChain = new Map<string, typeof icons>();
      for (const icon of icons) {
        const key = icon.chain ?? "(standalone)";
        if (!byChain.has(key)) byChain.set(key, []);
        byChain.get(key)!.push(icon);
      }

      for (const [chainName, chainIcons] of byChain) {
        lines.push(`── ${chainName} ──`);
        for (const icon of chainIcons) {
          const state = project?.states[icon.id];
          const status = state?.status ?? "pending";

          if (statusFilter && status !== statusFilter) continue;

          const statusEmoji = {
            pending: "⬜",
            generated: "🟡",
            approved: "✅",
            rejected: "❌",
          }[status] ?? "⬜";

          lines.push(`  ${statusEmoji} ${icon.id} [${icon.chainRole}] — ${icon.object}`);
        }
      }

      // Available filters
      lines.push("");
      lines.push(`Chains: ${getChains(SEABOUND_ICONS).join(", ")}`);
      lines.push(`Categories: ${getCategories(SEABOUND_ICONS).join(", ")}`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    case "sync_game_project": {
      const PROJECT_ID = "seabound";
      const model = (args?.model as string) ?? "black-forest-labs/flux-schnell";

      const project: GameProject = {
        id: PROJECT_ID,
        name: "SeaBound",
        styleGuide: SEABOUND_STYLE,
        icons: SEABOUND_ICONS,
        states: {},
        defaultModel: model,
        defaultSize: "64x64",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const saved = await apiRequest<GameProject>(
        `/api/game-projects/${PROJECT_ID}`,
        project,
        "PUT"
      );

      const states = Object.values(saved.states);
      const counts = {
        total: saved.icons.length,
        pending: states.filter((s) => s.status === "pending").length,
        generated: states.filter((s) => s.status === "generated").length,
        approved: states.filter((s) => s.status === "approved").length,
      };

      return {
        content: [{
          type: "text",
          text: `Synced SeaBound project: ${counts.total} icons (${counts.pending} pending, ${counts.generated} generated, ${counts.approved} approved)`,
        }],
      };
    }

    case "generate_game_icons": {
      const PROJECT_ID = "seabound";
      const filter = {
        ids: args?.ids as string[] | undefined,
        chain: args?.chain as string | undefined,
        category: args?.category as string | undefined,
        theme: args?.theme as string | undefined,
        model: args?.model as string | undefined,
        onlyPending: (args?.onlyPending as boolean) ?? true,
      };

      const res = await apiRequest<{
        results: Array<{ id: string; status: string; error?: string; imageKey?: string }>;
      }>(`/api/game-projects/${PROJECT_ID}/generate`, filter);

      const succeeded = res.results.filter((r) => r.status === "generated").length;
      const failed = res.results.filter((r) => r.status === "failed").length;

      const lines = [
        `Generated ${succeeded}/${res.results.length} icons (${failed} failed)`,
        "",
        ...res.results.map((r) => {
          const emoji = r.status === "generated" ? "✅" : "❌";
          return `${emoji} ${r.id}: ${r.status}${r.error ? ` — ${r.error}` : ""}`;
        }),
      ];

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    case "approve_game_icons": {
      const PROJECT_ID = "seabound";
      const updates: Array<{ iconId: string; status: GameIconStatus }> = [];

      const approve = args?.approve as string[] | undefined;
      const reject = args?.reject as string[] | undefined;

      if (approve) {
        for (const id of approve) updates.push({ iconId: id, status: "approved" });
      }
      if (reject) {
        for (const id of reject) updates.push({ iconId: id, status: "rejected" });
      }

      if (updates.length === 0) {
        return { content: [{ type: "text", text: "No icons to update. Provide 'approve' and/or 'reject' arrays." }] };
      }

      await apiRequest(`/api/game-projects/${PROJECT_ID}/status`, { updates });

      const approvedCount = approve?.length ?? 0;
      const rejectedCount = reject?.length ?? 0;
      return {
        content: [{
          type: "text",
          text: `Updated ${updates.length} icons: ${approvedCount} approved, ${rejectedCount} rejected`,
        }],
      };
    }

    case "export_game_icons": {
      const PROJECT_ID = "seabound";
      const status = (args?.status as string) ?? "approved";

      const res = await apiRequest<{
        projectName: string;
        icons: Array<{ id: string; imageUrl: string; status: string }>;
      }>(`/api/game-projects/${PROJECT_ID}/export?status=${status}`);

      if (res.icons.length === 0) {
        return {
          content: [{ type: "text", text: `No ${status} icons to export. Generate and approve some icons first.` }],
        };
      }

      const lines = [
        `${res.icons.length} icons ready for export:`,
        "",
        ...res.icons.map((icon) => `  ${icon.id}.png → ${API_URL}${icon.imageUrl}`),
        "",
        "To download all to a directory:",
        `  Each URL serves the PNG directly. Download as {id}.png into your game's asset folder.`,
      ];

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    case "preview_prompt": {
      const iconId = args?.iconId as string;
      const icon = SEABOUND_ICONS.find((i) => i.id === iconId);
      if (!icon) {
        return {
          content: [{ type: "text", text: `Icon "${iconId}" not found in spec. Available: ${SEABOUND_ICONS.map(i => i.id).join(", ")}` }],
          isError: true,
        };
      }

      const prompt = buildPrompt(icon, SEABOUND_STYLE);
      const lines = [
        `Icon: ${icon.id} (${icon.object})`,
        `Chain: ${icon.chain ?? "standalone"} [${icon.chainRole}]`,
        `Theme: ${icon.theme} | Category: ${icon.category}`,
        "",
        "Generated prompt:",
        prompt,
      ];

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
