import type { GenerateRequest, GenerateResponse, BatchRequest, BatchResponse, GenerationJob, Project, ProjectRun, SavedDrawing } from "@shared/types";

const BASE = import.meta.env.DEV ? "" : ""; // proxy in dev, same origin in prod

let authToken = localStorage.getItem("iconry_auth") ?? "";

export function setAuthToken(token: string) {
  authToken = token;
  localStorage.setItem("iconry_auth", token);
}

export function getAuthToken() {
  return authToken;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(authToken && { Authorization: `Bearer ${authToken}` }),
  };

  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  const data = await res.json();

  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }

  return data as T;
}

export async function generateImage(req: GenerateRequest): Promise<GenerateResponse> {
  return request<GenerateResponse>("/api/generate", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function pollPrediction(id: string, meta?: { prompt: string; model: string }): Promise<GenerateResponse> {
  const params = meta ? `?prompt=${encodeURIComponent(meta.prompt)}&model=${encodeURIComponent(meta.model)}` : "";
  return request<GenerateResponse>(`/api/poll/${id}${params}`);
}

export async function listJobs(): Promise<GenerationJob[]> {
  const res = await request<{ jobs: GenerationJob[] }>("/api/jobs");
  return res.jobs;
}

export async function submitBatch(pack: BatchRequest["pack"]): Promise<BatchResponse> {
  return request<BatchResponse>("/api/batch", {
    method: "POST",
    body: JSON.stringify({ pack }),
  });
}

export async function checkHealth() {
  return request<{ ok: boolean; replicate: boolean; r2: boolean; auth: boolean }>("/api/health");
}

export async function testReplicate() {
  return request<{ ok: boolean; username?: string; error?: string }>("/api/test-replicate");
}

export function imageUrl(key: string): string {
  return `${BASE}/api/image/${encodeURIComponent(key)}`;
}

export async function uploadImage(file: File): Promise<{ key: string }> {
  const res = await fetch(`${BASE}/api/upload`, {
    method: "POST",
    headers: {
      "Content-Type": file.type || "image/png",
      ...(authToken && { Authorization: `Bearer ${authToken}` }),
    },
    body: file,
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as { key: string };
}

/**
 * Build the full public URL for an R2 image key.
 * Used when we need an absolute URL (e.g. to pass to Replicate).
 */
export function imageAbsoluteUrl(key: string): string {
  return `${window.location.origin}/api/image/${encodeURIComponent(key)}`;
}

export async function deleteImage(key: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/image/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
}

// ── Projects ──────────────────────────────────────────────────────

export async function listProjects(): Promise<Project[]> {
  const res = await request<{ projects: Project[] }>("/api/projects");
  return res.projects;
}

export async function getProject(id: string): Promise<Project> {
  return request<Project>(`/api/projects/${id}`);
}

export async function saveProject(project: Project): Promise<Project> {
  return request<Project>(`/api/projects/${project.id}`, {
    method: "PUT",
    body: JSON.stringify(project),
  });
}

export async function deleteProject(id: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/projects/${id}`, { method: "DELETE" });
}

export async function runProject(id: string): Promise<ProjectRun> {
  return request<ProjectRun>(`/api/projects/${id}/run`, { method: "POST" });
}

// ── Saved Drawings ───────────────────────────────────────────────

export async function listSaved(): Promise<SavedDrawing[]> {
  const res = await request<{ drawings: SavedDrawing[] }>("/api/saved");
  return res.drawings;
}

export async function saveDrawing(data: {
  imageKey: string;
  tags?: string[];
  note?: string;
  prompt: string;
  model: string;
  provider?: string;
  source?: string;
}): Promise<SavedDrawing> {
  return request<SavedDrawing>("/api/saved", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateSaved(id: string, data: { tags?: string[]; note?: string }): Promise<SavedDrawing> {
  return request<SavedDrawing>(`/api/saved/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function removeSaved(id: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/saved/${id}`, { method: "DELETE" });
}
