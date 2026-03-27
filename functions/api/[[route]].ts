import type {
  GenerateRequest,
  GenerateResponse,
  BatchRequest,
  BatchResponse,
  GenerationJob,
  Project,
  ProjectRun,
  ProjectRunResult,
  GameProject,
  GameProjectSummary,
  GameIconSpec,
  GameIconState,
  GameIconStatus,
} from "../../shared/types";
import { buildPrompt } from "../../shared/prompt-builder";

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
      "Cache-Control": "no-store",
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

  // img2img: pass input image and prompt strength to models that support it
  if (req.inputImageUrl) {
    input.image = req.inputImageUrl;
    if (req.promptStrength !== undefined) {
      input.prompt_strength = req.promptStrength;
    }
  }

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
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
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

    // Game icon images are mutable (overwritten on re-upload), so
    // prevent all caching.  Other images are immutable (unique key per
    // generation) and can be cached aggressively.
    const isMutable = key.startsWith("game/");
    const cacheControl = isMutable
      ? "no-store, must-revalidate"
      : "public, max-age=31536000";

    const headers: Record<string, string> = {
      "Content-Type": obj.httpMetadata?.contentType ?? "image/png",
      "Cache-Control": cacheControl,
      "Access-Control-Allow-Origin": "*",
    };
    // For mutable images, also prevent Cloudflare edge caching
    if (isMutable) {
      headers["CDN-Cache-Control"] = "no-store";
    }

    return new Response(obj.body, { headers });
  }

  // Auth check for all other API routes
  const authErr = checkAuth(request, env);
  if (authErr) return authErr;

  // ── POST /api/upload — upload a reference image to R2 ─────────
  if (path === "/api/upload" && request.method === "POST") {
    if (!env.ASSETS_BUCKET) return err("R2 not configured", 500);

    const contentType = request.headers.get("Content-Type") ?? "image/png";
    if (!contentType.startsWith("image/")) {
      return err("Only image uploads are supported", 400);
    }

    const key = `uploads/${Date.now()}-${generateId()}.${contentType.split("/")[1]?.replace("+xml", "") || "png"}`;
    const body = await request.arrayBuffer();
    if (body.byteLength === 0) return err("Empty upload", 400);

    await env.ASSETS_BUCKET.put(key, body, {
      httpMetadata: { contentType },
    });

    // Return the key — the client can build the full URL via imageUrl()
    return json({ key });
  }

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

  // ── GET /api/saved — list all saved drawings ────────────────────
  if (path === "/api/saved" && request.method === "GET") {
    if (!env.ASSETS_BUCKET) return json({ drawings: [] });
    const data = await env.ASSETS_BUCKET.get("saved/index.json");
    if (!data) return json({ drawings: [] });
    try {
      const drawings = JSON.parse(await data.text()) as unknown[];
      return json({ drawings });
    } catch {
      return json({ drawings: [] });
    }
  }

  // ── POST /api/saved — save a drawing ──────────────────────────
  if (path === "/api/saved" && request.method === "POST") {
    if (!env.ASSETS_BUCKET) return err("R2 not configured", 500);

    const body = (await request.json()) as {
      imageKey: string;
      tags?: string[];
      note?: string;
      prompt: string;
      model: string;
      provider?: string;
      source?: string;
    };

    // Verify the image exists
    const imgObj = await env.ASSETS_BUCKET.head(body.imageKey);
    if (!imgObj) return err("Image not found in storage", 404);

    const now = new Date().toISOString();
    const drawing = {
      id: generateId(),
      imageKey: body.imageKey,
      tags: body.tags ?? [],
      note: body.note ?? "",
      prompt: body.prompt,
      model: body.model,
      provider: body.provider ?? "replicate",
      source: body.source ?? "explorer",
      createdAt: now,
      updatedAt: now,
    };

    // Load existing index
    let drawings: unknown[] = [];
    const existing = await env.ASSETS_BUCKET.get("saved/index.json");
    if (existing) {
      try { drawings = JSON.parse(await existing.text()) as unknown[]; } catch { /* start fresh */ }
    }

    // Check for duplicates by imageKey
    const isDuplicate = drawings.some((d: any) => d.imageKey === body.imageKey);
    if (isDuplicate) return err("This image is already saved", 409);

    drawings.unshift(drawing);
    await env.ASSETS_BUCKET.put("saved/index.json", JSON.stringify(drawings), {
      httpMetadata: { contentType: "application/json" },
    });

    return json(drawing);
  }

  // ── PUT /api/saved/:id — update tags/note ─────────────────────
  if (path.match(/^\/api\/saved\/[^/]+$/) && request.method === "PUT") {
    if (!env.ASSETS_BUCKET) return err("R2 not configured", 500);

    const id = path.replace("/api/saved/", "");
    const body = (await request.json()) as { tags?: string[]; note?: string };

    const data = await env.ASSETS_BUCKET.get("saved/index.json");
    if (!data) return err("No saved drawings", 404);

    let drawings: any[] = [];
    try { drawings = JSON.parse(await data.text()); } catch { return err("Corrupted index", 500); }

    const idx = drawings.findIndex((d: any) => d.id === id);
    if (idx === -1) return err("Drawing not found", 404);

    if (body.tags !== undefined) drawings[idx].tags = body.tags;
    if (body.note !== undefined) drawings[idx].note = body.note;
    drawings[idx].updatedAt = new Date().toISOString();

    await env.ASSETS_BUCKET.put("saved/index.json", JSON.stringify(drawings), {
      httpMetadata: { contentType: "application/json" },
    });

    return json(drawings[idx]);
  }

  // ── DELETE /api/saved/:id — remove from saved ─────────────────
  if (path.match(/^\/api\/saved\/[^/]+$/) && request.method === "DELETE") {
    if (!env.ASSETS_BUCKET) return err("R2 not configured", 500);

    const id = path.replace("/api/saved/", "");

    const data = await env.ASSETS_BUCKET.get("saved/index.json");
    if (!data) return err("No saved drawings", 404);

    let drawings: any[] = [];
    try { drawings = JSON.parse(await data.text()); } catch { return err("Corrupted index", 500); }

    const filtered = drawings.filter((d: any) => d.id !== id);
    if (filtered.length === drawings.length) return err("Drawing not found", 404);

    await env.ASSETS_BUCKET.put("saved/index.json", JSON.stringify(filtered), {
      httpMetadata: { contentType: "application/json" },
    });

    return json({ ok: true });
  }

  // ══════════════════════════════════════════════════════════════════
  // Game Projects — rich icon spec with per-icon status tracking
  // ══════════════════════════════════════════════════════════════════

  // ── GET /api/game-projects — list all game projects (summaries) ──
  if (path === "/api/game-projects" && request.method === "GET") {
    if (!env.ASSETS_BUCKET) return json({ projects: [] });

    const projects: GameProjectSummary[] = [];
    const listed = await env.ASSETS_BUCKET.list({ prefix: "game-projects/", limit: 500 });
    for (const obj of listed.objects) {
      if (!obj.key.endsWith(".json")) continue;
      const data = await env.ASSETS_BUCKET.get(obj.key);
      if (!data) continue;
      try {
        const gp = JSON.parse(await data.text()) as GameProject;
        const states = Object.values(gp.states);
        projects.push({
          id: gp.id,
          name: gp.name,
          total: gp.icons.length,
          pending: states.filter((s) => s.status === "pending").length,
          generated: states.filter((s) => s.status === "generated").length,
          approved: states.filter((s) => s.status === "approved").length,
          rejected: states.filter((s) => s.status === "rejected").length,
        });
      } catch { /* skip malformed */ }
    }
    return json({ projects });
  }

  // ── GET /api/game-projects/:id — get full game project ──────────
  if (path.match(/^\/api\/game-projects\/[^/]+$/) && request.method === "GET") {
    if (!env.ASSETS_BUCKET) return err("R2 not configured", 500);
    const id = path.replace("/api/game-projects/", "");
    const data = await env.ASSETS_BUCKET.get(`game-projects/${id}.json`);
    if (!data) return err("Game project not found", 404);
    return json(JSON.parse(await data.text()));
  }

  // ── PUT /api/game-projects/:id — create or update (sync spec) ───
  if (path.match(/^\/api\/game-projects\/[^/]+$/) && request.method === "PUT") {
    if (!env.ASSETS_BUCKET) return err("R2 not configured", 500);

    const incoming = (await request.json()) as GameProject;
    const id = path.replace("/api/game-projects/", "");
    incoming.id = id;

    // Try to load existing to preserve states
    const existing = await env.ASSETS_BUCKET.get(`game-projects/${id}.json`);
    if (existing) {
      try {
        const old = JSON.parse(await existing.text()) as GameProject;
        // Merge: keep existing states, add "pending" for new icons, remove stale
        const mergedStates: Record<string, GameIconState> = {};
        for (const icon of incoming.icons) {
          mergedStates[icon.id] = old.states[icon.id] ?? {
            specId: icon.id,
            status: "pending" as GameIconStatus,
            history: [],
          };
        }
        incoming.states = mergedStates;
      } catch { /* start fresh */ }
    } else {
      // Initialize all icons as pending
      const states: Record<string, GameIconState> = {};
      for (const icon of incoming.icons) {
        states[icon.id] = {
          specId: icon.id,
          status: "pending",
          history: [],
        };
      }
      incoming.states = states;
    }

    incoming.updatedAt = new Date().toISOString();
    if (!incoming.createdAt) incoming.createdAt = incoming.updatedAt;

    await env.ASSETS_BUCKET.put(
      `game-projects/${id}.json`,
      JSON.stringify(incoming),
      { httpMetadata: { contentType: "application/json" } }
    );
    return json(incoming);
  }

  // ── DELETE /api/game-projects/:id ───────────────────────────────
  if (path.match(/^\/api\/game-projects\/[^/]+$/) && request.method === "DELETE") {
    if (!env.ASSETS_BUCKET) return err("R2 not configured", 500);
    const id = path.replace("/api/game-projects/", "");
    await env.ASSETS_BUCKET.delete(`game-projects/${id}.json`);
    return json({ ok: true });
  }

  // ── POST /api/game-projects/:id/generate — generate specific icons
  // Body: { ids?: string[], chain?: string, category?: string, theme?: string, model?: string }
  if (path.match(/^\/api\/game-projects\/[^/]+\/generate$/) && request.method === "POST") {
    if (!env.ASSETS_BUCKET) return err("R2 not configured", 500);

    const id = path.replace("/api/game-projects/", "").replace("/generate", "");
    const projectData = await env.ASSETS_BUCKET.get(`game-projects/${id}.json`);
    if (!projectData) return err("Game project not found", 404);

    const project = JSON.parse(await projectData.text()) as GameProject;
    const body = (await request.json()) as {
      ids?: string[];
      chain?: string;
      category?: string;
      theme?: string;
      model?: string;
      onlyPending?: boolean;
    };

    // Filter which icons to generate
    let targets = project.icons;
    if (body.ids) {
      targets = targets.filter((i) => body.ids!.includes(i.id));
    }
    if (body.chain !== undefined) {
      targets = targets.filter((i) => i.chain === body.chain);
    }
    if (body.category) {
      targets = targets.filter((i) => i.category === body.category);
    }
    if (body.theme) {
      targets = targets.filter((i) => i.theme === body.theme);
    }
    if (body.onlyPending) {
      targets = targets.filter((i) => {
        const state = project.states[i.id];
        return !state || state.status === "pending" || state.status === "rejected";
      });
    }

    if (targets.length === 0) {
      return err("No matching icons to generate", 400);
    }

    // Order: bases first, then derived
    const roleOrder = { base: 0, standalone: 1, derived: 2 };
    targets.sort((a, b) => roleOrder[a.chainRole] - roleOrder[b.chainRole]);

    const model = body.model ?? project.defaultModel;
    const results: Array<{ id: string; status: string; error?: string; imageKey?: string }> = [];

    for (const icon of targets) {
      const prompt = buildPrompt(icon, project.styleGuide);
      const size = `${icon.size}x${icon.size}`;

      // For derived icons, check if base has an approved image for img2img
      let inputImageUrl: string | undefined;
      if (icon.chainRole === "derived" && icon.chain) {
        const baseIcon = project.icons.find(
          (i) => i.chain === icon.chain && i.chainRole === "base"
        );
        if (baseIcon) {
          const baseState = project.states[baseIcon.id];
          if (baseState?.currentImageKey) {
            // Build absolute URL to the stored base image
            inputImageUrl = `${url.origin}/api/image/${encodeURIComponent(baseState.currentImageKey)}`;
          }
        }
      }

      const req: GenerateRequest = {
        prompt,
        provider: "replicate",
        model,
        size,
        ...(inputImageUrl && { inputImageUrl, promptStrength: 0.7 }),
      };

      const genResult = await generateReplicate(req, env);

      // Poll if async
      let finalResult = genResult;
      if (genResult.status === "running" && genResult.id) {
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          finalResult = await pollReplicate(genResult.id, env);
          if (finalResult.status === "completed" || finalResult.status === "failed") break;
        }
      }

      const now = new Date().toISOString();

      if (finalResult.status === "completed" && finalResult.resultUrl) {
        const key = `game/${id}/${icon.id}.png`;
        const meta = {
          prompt,
          provider: "replicate",
          model,
          gameProject: id,
          iconId: icon.id,
        };
        const stored = await storeImage(env, key, finalResult.resultUrl, meta);

        // Update state
        if (!project.states[icon.id]) {
          project.states[icon.id] = { specId: icon.id, status: "pending", history: [] };
        }
        const state = project.states[icon.id];
        state.status = "generated";
        state.currentImageKey = stored ?? undefined;
        state.currentModel = model;
        state.currentPrompt = prompt;
        state.history.push({
          imageKey: stored ?? key,
          model,
          prompt,
          timestamp: now,
          approved: false,
        });

        results.push({ id: icon.id, status: "generated", imageKey: stored ?? undefined });
      } else {
        results.push({ id: icon.id, status: "failed", error: finalResult.error });
      }
    }

    // Save updated project
    project.updatedAt = new Date().toISOString();
    await env.ASSETS_BUCKET.put(
      `game-projects/${id}.json`,
      JSON.stringify(project),
      { httpMetadata: { contentType: "application/json" } }
    );

    return json({ results });
  }

  // ── POST /api/game-projects/:id/icons/:iconId/upload — upload custom image for a game icon
  // Body: raw image bytes (Content-Type: image/*)
  const uploadMatch = path.match(/^\/api\/game-projects\/([^/]+)\/icons\/([^/]+)\/upload$/);
  if (uploadMatch && request.method === "POST") {
    if (!env.ASSETS_BUCKET) return err("R2 not configured", 500);

    const projectId = uploadMatch[1];
    const iconId = decodeURIComponent(uploadMatch[2]);

    const contentType = request.headers.get("Content-Type") ?? "image/png";
    if (!contentType.startsWith("image/")) {
      return err("Only image uploads are supported", 400);
    }

    const body = await request.arrayBuffer();
    if (body.byteLength === 0) return err("Empty upload", 400);

    // Load project
    const projectData = await env.ASSETS_BUCKET.get(`game-projects/${projectId}.json`);
    if (!projectData) return err("Game project not found", 404);
    const project = JSON.parse(await projectData.text()) as GameProject;

    // Verify icon exists
    const iconSpec = project.icons.find((i) => i.id === iconId);
    if (!iconSpec) return err("Icon not found in project", 404);

    // Store image at game/{projectId}/{iconId}.png
    const key = `game/${projectId}/${iconId}.png`;
    await env.ASSETS_BUCKET.put(key, body, {
      httpMetadata: { contentType },
      customMetadata: {
        gameProject: projectId,
        iconId,
        source: "upload",
      },
    });

    // Update icon state
    const now = new Date().toISOString();
    if (!project.states[iconId]) {
      project.states[iconId] = { specId: iconId, status: "pending", history: [] };
    }
    const state = project.states[iconId];
    state.status = "generated";
    state.currentImageKey = key;
    state.currentModel = "upload";
    state.currentPrompt = "(custom upload)";
    state.history.push({
      imageKey: key,
      model: "upload",
      prompt: "(custom upload)",
      timestamp: now,
      approved: false,
    });

    project.updatedAt = now;
    await env.ASSETS_BUCKET.put(
      `game-projects/${projectId}.json`,
      JSON.stringify(project),
      { httpMetadata: { contentType: "application/json" } }
    );

    return json({ ok: true, imageKey: key });
  }

  // ── POST /api/game-projects/:id/icons/:iconId/use-image — assign an existing R2 image to a game icon
  // Body: { imageKey: string }
  const useImageMatch = path.match(/^\/api\/game-projects\/([^/]+)\/icons\/([^/]+)\/use-image$/);
  if (useImageMatch && request.method === "POST") {
    if (!env.ASSETS_BUCKET) return err("R2 not configured", 500);

    const projectId = useImageMatch[1];
    const iconId = decodeURIComponent(useImageMatch[2]);

    const { imageKey } = (await request.json()) as { imageKey: string };
    if (!imageKey) return err("imageKey is required", 400);

    // Verify the source image exists
    const sourceImage = await env.ASSETS_BUCKET.get(imageKey);
    if (!sourceImage) return err("Source image not found", 404);

    // Load project
    const projectData = await env.ASSETS_BUCKET.get(`game-projects/${projectId}.json`);
    if (!projectData) return err("Game project not found", 404);
    const project = JSON.parse(await projectData.text()) as GameProject;

    // Verify icon exists
    const iconSpec = project.icons.find((i) => i.id === iconId);
    if (!iconSpec) return err("Icon not found in project", 404);

    // Copy image to game icon path
    const destKey = `game/${projectId}/${iconId}.png`;
    const sourceBody = await sourceImage.arrayBuffer();
    await env.ASSETS_BUCKET.put(destKey, sourceBody, {
      httpMetadata: { contentType: sourceImage.httpMetadata?.contentType ?? "image/png" },
      customMetadata: {
        gameProject: projectId,
        iconId,
        source: "explorer",
        sourceKey: imageKey,
      },
    });

    // Update icon state
    const now = new Date().toISOString();
    if (!project.states[iconId]) {
      project.states[iconId] = { specId: iconId, status: "pending", history: [] };
    }
    const state = project.states[iconId];
    state.status = "generated";
    state.currentImageKey = destKey;
    state.currentModel = "explorer";
    state.currentPrompt = "(from explorer)";
    state.history.push({
      imageKey: destKey,
      model: "explorer",
      prompt: "(from explorer)",
      timestamp: now,
      approved: false,
    });

    project.updatedAt = now;
    await env.ASSETS_BUCKET.put(
      `game-projects/${projectId}.json`,
      JSON.stringify(project),
      { httpMetadata: { contentType: "application/json" } }
    );

    return json({ ok: true, imageKey: destKey });
  }

  // ── POST /api/game-projects/:id/status — update icon statuses
  // Body: { updates: Array<{ iconId: string, status: GameIconStatus }> }
  if (path.match(/^\/api\/game-projects\/[^/]+\/status$/) && request.method === "POST") {
    if (!env.ASSETS_BUCKET) return err("R2 not configured", 500);

    const id = path.replace("/api/game-projects/", "").replace("/status", "");
    const projectData = await env.ASSETS_BUCKET.get(`game-projects/${id}.json`);
    if (!projectData) return err("Game project not found", 404);

    const project = JSON.parse(await projectData.text()) as GameProject;
    const { updates } = (await request.json()) as {
      updates: Array<{ iconId: string; status: GameIconStatus }>;
    };

    for (const update of updates) {
      const state = project.states[update.iconId];
      if (!state) continue;
      state.status = update.status;

      // If approving, mark the current history entry as approved
      if (update.status === "approved" && state.history.length > 0) {
        // Clear previous approvals
        for (const h of state.history) h.approved = false;
        state.history[state.history.length - 1].approved = true;
      }
    }

    project.updatedAt = new Date().toISOString();
    await env.ASSETS_BUCKET.put(
      `game-projects/${id}.json`,
      JSON.stringify(project),
      { httpMetadata: { contentType: "application/json" } }
    );

    return json({ ok: true, updated: updates.length });
  }

  // ── GET /api/game-projects/:id/export — download approved icons as ZIP
  if (path.match(/^\/api\/game-projects\/[^/]+\/export$/) && request.method === "GET") {
    if (!env.ASSETS_BUCKET) return err("R2 not configured", 500);

    const id = path.replace("/api/game-projects/", "").replace("/export", "");
    const projectData = await env.ASSETS_BUCKET.get(`game-projects/${id}.json`);
    if (!projectData) return err("Game project not found", 404);

    const project = JSON.parse(await projectData.text()) as GameProject;
    const statusFilter = url.searchParams.get("status") ?? "approved";

    // Return a manifest of downloadable icons (client-side can fetch each)
    const icons: Array<{ id: string; imageUrl: string; status: string }> = [];
    for (const icon of project.icons) {
      const state = project.states[icon.id];
      if (!state?.currentImageKey) continue;
      if (statusFilter !== "all" && state.status !== statusFilter) continue;
      icons.push({
        id: icon.id,
        imageUrl: `/api/image/${encodeURIComponent(state.currentImageKey)}`,
        status: state.status,
      });
    }

    return json({ projectName: project.name, icons });
  }

  return err("Not found", 404);
};
