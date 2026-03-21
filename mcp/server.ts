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
import type { PackSpec, GenerateRequest, GenerateResponse, BatchResponse } from "../shared/types.js";

const API_URL = process.env.ICONRY_API_URL ?? "http://localhost:8787";
const AUTH_TOKEN = process.env.ICONRY_AUTH_TOKEN ?? "";

async function apiRequest<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: body ? "POST" : "GET",
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
        "Generate a single icon/game asset image. Returns the image URL. " +
        "Use this for quick exploration or one-off assets.",
      inputSchema: {
        type: "object" as const,
        properties: {
          prompt: {
            type: "string",
            description:
              "Full prompt for the icon, e.g. 'minimal flat icon, game asset, a coconut, transparent background'",
          },
          provider: {
            type: "string",
            enum: ["replicate", "openai", "recraft"],
            description: "Which image generation provider to use (default: replicate)",
          },
          model: {
            type: "string",
            description:
              "Model ID (default: black-forest-labs/flux-schnell for replicate)",
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
              "A PackSpec object with name, style (basePrompt, provider, model, etc), and icons array",
          },
        },
        required: ["pack"],
      },
    },
    {
      name: "check_status",
      description:
        "Check which providers are configured and whether the Iconry backend is reachable.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "generate_icon": {
      const prompt = args?.prompt as string;
      const provider = (args?.provider as string) ?? "replicate";
      const model =
        (args?.model as string) ??
        (provider === "replicate" ? "black-forest-labs/flux-schnell" : undefined) ??
        "";
      const size = (args?.size as string) ?? "256x256";

      const req: GenerateRequest = { prompt, provider: provider as GenerateRequest["provider"], model, size };
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
            `  ${j.status === "completed" ? "✓" : "✗"} ${j.iconName}: ${j.resultUrl ?? j.error ?? "no result"}`
        ),
      ].join("\n");

      return { content: [{ type: "text", text: summary }] };
    }

    case "check_status": {
      const health = await apiRequest<{
        ok: boolean;
        providers: Record<string, boolean>;
        r2: boolean;
      }>("/api/health");

      const lines = [
        `Backend: ${health.ok ? "connected" : "error"}`,
        `R2 Storage: ${health.r2 ? "configured" : "not configured"}`,
        "Providers:",
        ...Object.entries(health.providers).map(
          ([name, ok]) => `  ${name}: ${ok ? "configured" : "no API key"}`
        ),
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
