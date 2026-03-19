import type { GenerateRequest, GenerateResponse, BatchRequest, BatchResponse, GenerationJob, PackState } from "../shared/types";

export interface Env {
  ASSETS_BUCKET?: R2Bucket;
  REPLICATE_API_TOKEN?: string;
  RECRAFT_API_TOKEN?: string;
  OPENAI_API_KEY?: string;
  AUTH_SECRET?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function err(message: string, status = 400) {
  return json({ error: message }, status);
}

function checkAuth(request: Request, env: Env): Response | null {
  const secret = env.AUTH_SECRET;
  if (!secret) return null; // no auth configured = allow all (dev mode)
  const token = request.headers.get("Authorization")?.replace("Bearer ", "");
  if (token !== secret) return err("Unauthorized", 401);
  return null;
}

function generateId(): string {
  return crypto.randomUUID();
}

// ── Provider adapters ───────────────────────────────────────────────

async function generateReplicate(req: GenerateRequest, env: Env): Promise<GenerateResponse> {
  const token = env.REPLICATE_API_TOKEN;
  if (!token) return { id: "", status: "failed", error: "REPLICATE_API_TOKEN not set" };

  const input: Record<string, unknown> = {
    prompt: req.prompt,
    ...(req.negativePrompt && { negative_prompt: req.negativePrompt }),
    ...(req.seed !== undefined && { seed: req.seed }),
    ...(req.extra ?? {}),
  };

  if (req.size) {
    const [w, h] = req.size.split("x").map(Number);
    input.width = w;
    input.height = h;
  }

  const res = await fetch(`https://api.replicate.com/v1/models/${req.model}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input }),
  });

  const data = (await res.json()) as Record<string, unknown>;

  if (!res.ok) {
    return { id: "", status: "failed", error: (data.detail as string) ?? res.statusText };
  }

  return {
    id: data.id as string,
    status: data.status === "succeeded" ? "completed" : "running",
    resultUrl: Array.isArray(data.output) ? (data.output[0] as string) : undefined,
  };
}

async function pollReplicate(predictionId: string, env: Env): Promise<GenerateResponse> {
  const token = env.REPLICATE_API_TOKEN;
  if (!token) return { id: predictionId, status: "failed", error: "REPLICATE_API_TOKEN not set" };

  const res = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const data = (await res.json()) as Record<string, unknown>;
  const status = data.status as string;

  return {
    id: predictionId,
    status: status === "succeeded" ? "completed" : status === "failed" ? "failed" : "running",
    resultUrl: Array.isArray(data.output) ? (data.output[0] as string) : undefined,
    error: data.error as string | undefined,
  };
}

async function generateOpenAI(req: GenerateRequest, env: Env): Promise<GenerateResponse> {
  const key = env.OPENAI_API_KEY;
  if (!key) return { id: "", status: "failed", error: "OPENAI_API_KEY not set" };

  const body: Record<string, unknown> = {
    model: req.model || "dall-e-3",
    prompt: req.prompt,
    n: 1,
    size: req.size === "256x256" ? "1024x1024" : (req.size ?? "1024x1024"),
    response_format: "url",
  };

  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const errObj = data.error as Record<string, unknown> | undefined;
    return { id: "", status: "failed", error: (errObj?.message as string) ?? res.statusText };
  }

  const images = data.data as Array<{ url: string }>;
  return {
    id: generateId(),
    status: "completed",
    resultUrl: images[0]?.url,
  };
}

async function generateRecraft(req: GenerateRequest, env: Env): Promise<GenerateResponse> {
  const token = env.RECRAFT_API_TOKEN;
  if (!token) return { id: "", status: "failed", error: "RECRAFT_API_TOKEN not set" };

  const body: Record<string, unknown> = {
    prompt: req.prompt,
    style: "icon",
    ...(req.negativePrompt && { negative_prompt: req.negativePrompt }),
    ...(req.extra ?? {}),
  };

  if (req.size) {
    const [w, h] = req.size.split("x").map(Number);
    body.width = w;
    body.height = h;
  }

  const res = await fetch("https://external.api.recraft.ai/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    return { id: "", status: "failed", error: JSON.stringify(data) };
  }

  const images = data.data as Array<{ url: string }>;
  return {
    id: generateId(),
    status: "completed",
    resultUrl: images[0]?.url,
  };
}

async function generate(req: GenerateRequest, env: Env): Promise<GenerateResponse> {
  switch (req.provider) {
    case "replicate":
      return generateReplicate(req, env);
    case "openai":
      return generateOpenAI(req, env);
    case "recraft":
      return generateRecraft(req, env);
    default:
      return { id: "", status: "failed", error: `Unknown provider: ${req.provider}` };
  }
}

// ── Store image to R2 ───────────────────────────────────────────────

async function storeImage(env: Env, key: string, imageUrl: string): Promise<string | null> {
  if (!env.ASSETS_BUCKET) return null;

  const res = await fetch(imageUrl);
  if (!res.ok) return null;

  const contentType = res.headers.get("Content-Type") ?? "image/png";
  await env.ASSETS_BUCKET.put(key, res.body, {
    httpMetadata: { contentType },
  });
  return key;
}

// ── Router ──────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // Auth check
    const authErr = checkAuth(request, env);
    if (authErr) return authErr;

    // ── POST /api/generate — single image ───────────────────────────
    if (path === "/api/generate" && request.method === "POST") {
      const req = (await request.json()) as GenerateRequest;
      const result = await generate(req, env);

      // If completed immediately and we have R2, store it
      if (result.status === "completed" && result.resultUrl) {
        const key = `generated/${Date.now()}-${generateId()}.png`;
        const stored = await storeImage(env, key, result.resultUrl);
        if (stored) {
          (result as GenerateResponse & { storedKey?: string }).storedKey = stored;
        }
      }

      return json(result);
    }

    // ── GET /api/poll/:id — poll replicate prediction ───────────────
    if (path.startsWith("/api/poll/") && request.method === "GET") {
      const predictionId = path.replace("/api/poll/", "");
      const result = await pollReplicate(predictionId, env);

      if (result.status === "completed" && result.resultUrl) {
        const key = `generated/${Date.now()}-${predictionId}.png`;
        const stored = await storeImage(env, key, result.resultUrl);
        if (stored) {
          (result as GenerateResponse & { storedKey?: string }).storedKey = stored;
        }
      }

      return json(result);
    }

    // ── POST /api/batch — submit a full pack ────────────────────────
    if (path === "/api/batch" && request.method === "POST") {
      const { pack } = (await request.json()) as BatchRequest;
      const packId = generateId();
      const jobs: GenerationJob[] = [];

      // Process icons sequentially (respect rate limits)
      for (const icon of pack.icons) {
        const fullPrompt = `${pack.style.basePrompt}, ${icon.prompt}`;
        const req: GenerateRequest = {
          prompt: fullPrompt,
          provider: pack.style.provider,
          model: pack.style.model,
          size: icon.size ?? pack.style.defaultSize,
          seed: icon.seed ?? pack.style.seed,
          referenceImages: pack.style.referenceImages,
          negativePrompt: pack.style.negativePrompt,
          extra: { ...pack.style.extra, ...icon.extra },
        };

        const result = await generate(req, env);
        const now = new Date().toISOString();

        const job: GenerationJob = {
          id: result.id || generateId(),
          packName: pack.name,
          iconName: icon.name,
          status: result.status,
          prompt: fullPrompt,
          provider: pack.style.provider,
          model: pack.style.model,
          resultUrl: result.resultUrl,
          error: result.error,
          createdAt: now,
          updatedAt: now,
        };

        // Store completed images
        if (result.status === "completed" && result.resultUrl) {
          const key = `packs/${pack.name}/${icon.name}.png`;
          const stored = await storeImage(env, key, result.resultUrl);
          if (stored) job.storedKey = stored;
        }

        jobs.push(job);
      }

      const response: BatchResponse = { packId, jobs };
      return json(response);
    }

    // ── GET /api/image/:key — serve image from R2 ───────────────────
    if (path.startsWith("/api/image/") && request.method === "GET") {
      if (!env.ASSETS_BUCKET) return err("R2 not configured", 500);

      const key = decodeURIComponent(path.replace("/api/image/", ""));
      const obj = await env.ASSETS_BUCKET.get(key);
      if (!obj) return err("Not found", 404);

      return new Response(obj.body, {
        headers: {
          "Content-Type": obj.httpMetadata?.contentType ?? "image/png",
          "Cache-Control": "public, max-age=31536000",
        },
      });
    }

    // ── GET /api/health ─────────────────────────────────────────────
    if (path === "/api/health") {
      return json({
        ok: true,
        providers: {
          replicate: !!env.REPLICATE_API_TOKEN,
          openai: !!env.OPENAI_API_KEY,
          recraft: !!env.RECRAFT_API_TOKEN,
        },
        r2: !!env.ASSETS_BUCKET,
      });
    }

    return err("Not found", 404);
  },
};
