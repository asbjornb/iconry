import type { GenerateRequest, GenerateResponse, BatchRequest, BatchResponse, GenerationJob } from "../shared/types";

export interface Env {
  ASSETS_BUCKET: R2Bucket;
  REPLICATE_API_TOKEN: string;
  AUTH_SECRET: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function err(message: string, status = 400) {
  return json({ error: message }, status);
}

function checkAuth(request: Request, env: Env): Response | null {
  const secret = env.AUTH_SECRET;
  if (!secret) return err("AUTH_SECRET not configured on worker", 500);
  const token = request.headers.get("Authorization")?.replace("Bearer ", "");
  if (token !== secret) return err("Unauthorized", 401);
  return null;
}

function generateId(): string {
  return crypto.randomUUID();
}

// ── Replicate adapter ───────────────────────────────────────────────

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

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // Health endpoint is public (no auth needed to check status)
    if (path === "/api/health") {
      return json({
        ok: true,
        replicate: !!env.REPLICATE_API_TOKEN,
        r2: !!env.ASSETS_BUCKET,
        auth: !!env.AUTH_SECRET,
      });
    }

    // Auth check for all other API routes
    const authErr = checkAuth(request, env);
    if (authErr) return authErr;

    // ── POST /api/generate — single image ───────────────────────────
    if (path === "/api/generate" && request.method === "POST") {
      const req = (await request.json()) as GenerateRequest;
      const result = await generateReplicate(req, env);

      // If completed immediately, store to R2
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
          provider: "replicate",
          model: pack.style.model,
          size: icon.size ?? pack.style.defaultSize,
          seed: icon.seed ?? pack.style.seed,
          referenceImages: pack.style.referenceImages,
          negativePrompt: pack.style.negativePrompt,
          extra: { ...pack.style.extra, ...icon.extra },
        };

        const result = await generateReplicate(req, env);
        const now = new Date().toISOString();

        const job: GenerationJob = {
          id: result.id || generateId(),
          packName: pack.name,
          iconName: icon.name,
          status: result.status,
          prompt: fullPrompt,
          provider: "replicate",
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
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    return err("Not found", 404);
  },
};
