import type {
  GenerateRequest,
  GenerateResponse,
  BatchRequest,
  BatchResponse,
  GenerationJob,
  Project,
  ProjectRun,
  ProjectRunResult,
} from "../../shared/types";

interface Env {
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

function isFluxModel(model: string): boolean {
  return model.startsWith("black-forest-labs/flux");
}

function isRecraftModel(model: string): boolean {
  return model.startsWith("recraft-ai/");
}

function isAspectRatioModel(model: string): boolean {
  return model.startsWith("ideogram-ai/") || model.startsWith("google-deepmind/");
}

function sizeToAspectRatio(size: string): string {
  const [w, h] = size.split("x").map(Number);
  if (!w || !h) return "1:1";
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const d = gcd(w, h);
  return `${w / d}:${h / d}`;
}

function extractOutputUrl(data: Record<string, unknown>): string | undefined {
  // Models return output in different formats:
  // - Array of URLs (Flux, SDXL): ["https://..."]
  // - Single URL string (Recraft, some others): "https://..."
  // - Object with url field: { url: "https://..." }
  const output = data.output;
  if (Array.isArray(output)) return output[0] as string;
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && "url" in output) return (output as Record<string, string>).url;
  return undefined;
}

async function generateReplicate(
  req: GenerateRequest,
  env: Env
): Promise<GenerateResponse> {
  const token = env.REPLICATE_API_TOKEN;
  if (!token)
    return { id: "", status: "failed", error: "REPLICATE_API_TOKEN not set" };

  const input: Record<string, unknown> = {
    prompt: req.prompt,
    ...(req.negativePrompt && { negative_prompt: req.negativePrompt }),
    ...(req.seed !== undefined && { seed: req.seed }),
    ...(req.extra ?? {}),
  };

  if (isFluxModel(req.model)) {
    // Flux models use aspect_ratio instead of width/height
    if (req.size) {
      input.aspect_ratio = sizeToAspectRatio(req.size);
    }
    // Request PNG output for consistent storage
    if (!input.output_format) {
      input.output_format = "png";
    }
  } else if (isRecraftModel(req.model)) {
    // Recraft models accept size as a WxH string directly
    if (req.size) {
      input.size = req.size;
    }
  } else if (isAspectRatioModel(req.model)) {
    // Ideogram, Imagen etc. use aspect_ratio
    if (req.size) {
      input.aspect_ratio = sizeToAspectRatio(req.size);
    }
  } else if (req.size) {
    const [w, h] = req.size.split("x").map(Number);
    input.width = w;
    input.height = h;
  }

  const res = await fetch(
    `https://api.replicate.com/v1/models/${req.model}/predictions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input }),
    }
  );

  const data = (await res.json()) as Record<string, unknown>;

  if (!res.ok) {
    return {
      id: "",
      status: "failed",
      error: (data.detail as string) ?? res.statusText,
    };
  }

  return {
    id: data.id as string,
    status: data.status === "succeeded" ? "completed" : "running",
    resultUrl: extractOutputUrl(data),
  };
}

async function pollReplicate(
  predictionId: string,
  env: Env
): Promise<GenerateResponse> {
  const token = env.REPLICATE_API_TOKEN;
  if (!token)
    return {
      id: predictionId,
      status: "failed",
      error: "REPLICATE_API_TOKEN not set",
    };

  const res = await fetch(
    `https://api.replicate.com/v1/predictions/${predictionId}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  const data = (await res.json()) as Record<string, unknown>;
  const status = data.status as string;

  return {
    id: predictionId,
    status:
      status === "succeeded"
        ? "completed"
        : status === "failed"
          ? "failed"
          : "running",
    resultUrl: extractOutputUrl(data),
    error: data.error as string | undefined,
  };
}

// ── Store image to R2 ───────────────────────────────────────────────

async function storeImage(
  env: Env,
  key: string,
  imageUrl: string,
  meta?: Record<string, string>
): Promise<string | null> {
  if (!env.ASSETS_BUCKET) return null;

  const res = await fetch(imageUrl);
  if (!res.ok) return null;

  const contentType = res.headers.get("Content-Type") ?? "image/png";
  await env.ASSETS_BUCKET.put(key, res.body, {
    httpMetadata: { contentType },
    customMetadata: meta,
  });
  return key;
}

// ── Pages Function handler ──────────────────────────────────────────

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  // Health endpoint is public
  if (path === "/api/health") {
    return json({
      ok: true,
      replicate: !!env.REPLICATE_API_TOKEN,
      r2: !!env.ASSETS_BUCKET,
      auth: !!env.AUTH_SECRET,
    });
  }

  // ── GET /api/image/:key — serve image from R2 (public, no auth) ──
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

  // Auth check for all other API routes
  const authErr = checkAuth(request, env);
  if (authErr) return authErr;

  // ── GET /api/jobs — list stored images as jobs ─────────────────
  if (path === "/api/jobs" && request.method === "GET") {
    if (!env.ASSETS_BUCKET) return json({ jobs: [] });

    const jobs: GenerationJob[] = [];
    let cursor: string | undefined;

    do {
      const listed = await env.ASSETS_BUCKET.list({ cursor, limit: 500, include: ["customMetadata", "httpMetadata"] });
      for (const obj of listed.objects) {
        const m = obj.customMetadata ?? {};
        if (!m.prompt) continue; // skip objects without job metadata
        jobs.push({
          id: obj.key,
          packName: m.packName ?? "unknown",
          iconName: m.iconName ?? obj.key.split("/").pop()?.replace(".png", "") ?? "unknown",
          status: "completed",
          prompt: m.prompt,
          provider: m.provider ?? "replicate",
          model: m.model ?? "unknown",
          storedKey: obj.key,
          createdAt: obj.uploaded.toISOString(),
          updatedAt: obj.uploaded.toISOString(),
        });
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    // Newest first
    jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return json({ jobs });
  }

  // ── GET /api/test-replicate — verify Replicate token is valid ───
  if (path === "/api/test-replicate" && request.method === "GET") {
    const token = env.REPLICATE_API_TOKEN;
    if (!token) {
      return json({ ok: false, error: "REPLICATE_API_TOKEN not set in environment" });
    }
    try {
      const res = await fetch("https://api.replicate.com/v1/account", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        return json({
          ok: false,
          error: (data.detail as string) ?? `Replicate API returned ${res.status}`,
        });
      }
      const account = (await res.json()) as Record<string, unknown>;
      return json({ ok: true, username: account.username });
    } catch (e) {
      return json({ ok: false, error: (e as Error).message });
    }
  }

  // ── POST /api/generate — single image ───────────────────────────
  if (path === "/api/generate" && request.method === "POST") {
    const req = (await request.json()) as GenerateRequest;
    const result = await generateReplicate(req, env);

    if (result.status === "completed" && result.resultUrl) {
      const key = `generated/${Date.now()}-${generateId()}.png`;
      const meta = {
        prompt: req.prompt,
        provider: "replicate",
        model: req.model,
        packName: "explorer",
        iconName: `explore-${Date.now()}`,
      };
      const stored = await storeImage(env, key, result.resultUrl, meta);
      if (stored) {
        result.storedKey = stored;
      }
    }

    return json(result);
  }

  // ── GET /api/poll/:id — poll replicate prediction ───────────────
  if (path.startsWith("/api/poll/") && request.method === "GET") {
    const predictionId = path.replace("/api/poll/", "");
    // Read metadata from query params (passed by client during polling)
    const pollPrompt = url.searchParams.get("prompt") ?? "";
    const pollModel = url.searchParams.get("model") ?? "";
    const result = await pollReplicate(predictionId, env);

    if (result.status === "completed" && result.resultUrl) {
      const key = `generated/${Date.now()}-${predictionId}.png`;
      const meta = {
        prompt: pollPrompt,
        provider: "replicate",
        model: pollModel,
        packName: "explorer",
        iconName: `explore-${Date.now()}`,
      };
      const stored = await storeImage(env, key, result.resultUrl, meta);
      if (stored) {
        result.storedKey = stored;
      }
    }

    return json(result);
  }

  // ── POST /api/batch — submit a full pack ────────────────────────
  if (path === "/api/batch" && request.method === "POST") {
    const { pack } = (await request.json()) as BatchRequest;
    const packId = generateId();
    const jobs: GenerationJob[] = [];

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

      if (result.status === "completed" && result.resultUrl) {
        const key = `packs/${pack.name}/${icon.name}.png`;
        const meta = {
          prompt: fullPrompt,
          provider: "replicate",
          model: pack.style.model,
          packName: pack.name,
          iconName: icon.name,
        };
        const stored = await storeImage(env, key, result.resultUrl, meta);
        if (stored) job.storedKey = stored;
      }

      jobs.push(job);
    }

    const response: BatchResponse = { packId, jobs };
    return json(response);
  }

  // ── DELETE /api/image/:key — delete image from R2 ──────────────
  if (path.startsWith("/api/image/") && request.method === "DELETE") {
    if (!env.ASSETS_BUCKET) return err("R2 not configured", 500);

    const key = decodeURIComponent(path.replace("/api/image/", ""));
    await env.ASSETS_BUCKET.delete(key);
    return json({ ok: true, key });
  }

  // ── GET /api/projects — list all projects ─────────────────────
  if (path === "/api/projects" && request.method === "GET") {
    if (!env.ASSETS_BUCKET) return json({ projects: [] });

    const projects: Project[] = [];
    const listed = await env.ASSETS_BUCKET.list({ prefix: "projects/", limit: 500, include: ["customMetadata"] });
    for (const obj of listed.objects) {
      if (!obj.key.endsWith(".json")) continue;
      const data = await env.ASSETS_BUCKET.get(obj.key);
      if (!data) continue;
      try {
        const project = JSON.parse(await data.text()) as Project;
        projects.push(project);
      } catch { /* skip malformed */ }
    }
    projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return json({ projects });
  }

  // ── GET /api/projects/:id — get single project ────────────────
  if (path.match(/^\/api\/projects\/[^/]+$/) && request.method === "GET") {
    if (!env.ASSETS_BUCKET) return err("R2 not configured", 500);
    const id = path.replace("/api/projects/", "");
    const data = await env.ASSETS_BUCKET.get(`projects/${id}.json`);
    if (!data) return err("Project not found", 404);
    return json(JSON.parse(await data.text()));
  }

  // ── PUT /api/projects/:id — create or update project ──────────
  if (path.match(/^\/api\/projects\/[^/]+$/) && request.method === "PUT") {
    if (!env.ASSETS_BUCKET) return err("R2 not configured", 500);
    const project = (await request.json()) as Project;
    project.updatedAt = new Date().toISOString();
    await env.ASSETS_BUCKET.put(
      `projects/${project.id}.json`,
      JSON.stringify(project),
      { httpMetadata: { contentType: "application/json" } }
    );
    return json(project);
  }

  // ── DELETE /api/projects/:id — delete project ─────────────────
  if (path.match(/^\/api\/projects\/[^/]+$/) && request.method === "DELETE") {
    if (!env.ASSETS_BUCKET) return err("R2 not configured", 500);
    const id = path.replace("/api/projects/", "");
    await env.ASSETS_BUCKET.delete(`projects/${id}.json`);
    return json({ ok: true });
  }

  // ── POST /api/projects/:id/run — generate all items in project ─
  if (path.match(/^\/api\/projects\/[^/]+\/run$/) && request.method === "POST") {
    if (!env.ASSETS_BUCKET) return err("R2 not configured", 500);

    const id = path.replace("/api/projects/", "").replace("/run", "");
    const projectData = await env.ASSETS_BUCKET.get(`projects/${id}.json`);
    if (!projectData) return err("Project not found", 404);

    const project = JSON.parse(await projectData.text()) as Project;
    const runId = generateId();
    const now = new Date().toISOString();
    const results: ProjectRunResult[] = [];

    for (const item of project.items) {
      const parts = [project.preamble, item, project.postfix].filter(Boolean);
      const fullPrompt = parts.join(", ");

      const req: GenerateRequest = {
        prompt: fullPrompt,
        provider: "replicate",
        model: project.model,
        size: project.size,
      };

      const genResult = await generateReplicate(req, env);

      // If async, poll until done
      let finalResult = genResult;
      if (genResult.status === "running" && genResult.id) {
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          finalResult = await pollReplicate(genResult.id, env);
          if (finalResult.status === "completed" || finalResult.status === "failed") break;
        }
      }

      const runResult: ProjectRunResult = {
        item,
        prompt: fullPrompt,
        status: finalResult.status === "completed" ? "completed" : "failed",
        error: finalResult.error,
      };

      if (finalResult.status === "completed" && finalResult.resultUrl) {
        const sanitized = item.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
        const key = `projects/${id}/${runId}/${sanitized}.png`;
        const meta = {
          prompt: fullPrompt,
          provider: "replicate",
          model: project.model,
          packName: project.name,
          iconName: item,
        };
        const stored = await storeImage(env, key, finalResult.resultUrl, meta);
        if (stored) runResult.storedKey = stored;
      }

      results.push(runResult);
    }

    const run: ProjectRun = {
      id: runId,
      preamble: project.preamble,
      postfix: project.postfix,
      model: project.model,
      size: project.size,
      results,
      createdAt: now,
    };

    project.runs.push(run);
    project.updatedAt = now;
    await env.ASSETS_BUCKET.put(
      `projects/${id}.json`,
      JSON.stringify(project),
      { httpMetadata: { contentType: "application/json" } }
    );

    return json(run);
  }

  return err("Not found", 404);
};
