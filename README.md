# iconry

Personal tool for generating consistent game asset icon packs using AI image generation APIs.

Deployed at `iconry.pages.dev` — a Cloudflare Pages SPA + Worker backend.

## The problem

Generating 70+ consistent icons for a game is painful:
- Manually tweaking prompts one at a time
- Copy-pasting between tabs
- No bulk generation or batch rerolling
- Images scattered across downloads folders

## How it works

1. **Explore** — Try prompts, pick a style that works, save good reference outputs
2. **Batch** — Write a JSON pack spec (style once, then list all icons), submit the whole batch
3. **Review** — Grid view of all results, reroll individual failures, download the pack

### Pack spec (JSON DSL)

```json
{
  "name": "tropical-island-resources",
  "style": {
    "basePrompt": "minimal flat icon, game asset, tropical island theme, transparent bg",
    "negativePrompt": "blurry, text, watermark",
    "provider": "replicate",
    "model": "black-forest-labs/flux-schnell",
    "defaultSize": "256x256"
  },
  "icons": [
    { "name": "coconut", "prompt": "a coconut", "type": "resource" },
    { "name": "wood", "prompt": "a wooden plank", "type": "resource" },
    { "name": "build_btn", "prompt": "a hammer", "size": "128x128", "type": "nav_button" }
  ]
}
```

## Stack

- **Frontend:** React + Vite + TypeScript (Cloudflare Pages)
- **Backend:** Cloudflare Worker (API proxy, holds secrets)
- **Storage:** Cloudflare R2 (generated images)
- **Auth:** Cloudflare Access or simple bearer token
- **MCP Server:** Use from Claude Code / any MCP client

## Supported providers

- [Replicate](https://replicate.com) — Flux, SDXL, etc.
- [OpenAI](https://platform.openai.com) — DALL-E 3
- [Recraft](https://recraft.ai) — icon/illustration specialist

## Setup

```bash
npm install

# Dev (frontend + worker)
npm run dev          # Vite dev server (port 5173)
npm run worker:dev   # Worker dev server (port 8787)

# Set API keys on the worker
wrangler secret put REPLICATE_API_TOKEN
wrangler secret put AUTH_SECRET

# Create R2 bucket
wrangler r2 bucket create iconry-assets
# Then uncomment the [[r2_buckets]] section in wrangler.toml

# Deploy
npm run deploy
wrangler deploy worker/index.ts
```

## MCP server

Use Iconry as an MCP tool from Claude Code or Claude Desktop:

```json
{
  "mcpServers": {
    "iconry": {
      "command": "npx",
      "args": ["tsx", "/path/to/iconry/mcp/server.ts"],
      "env": {
        "ICONRY_API_URL": "https://iconry.pages.dev",
        "ICONRY_AUTH_TOKEN": "your-secret"
      }
    }
  }
}
```

Tools exposed:
- `generate_icon` — single image generation
- `generate_icon_pack` — batch generation from a pack spec
- `check_status` — verify backend connectivity and provider config
