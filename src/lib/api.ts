import type { GenerateRequest, GenerateResponse, BatchRequest, BatchResponse } from "@shared/types";

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

export async function pollPrediction(id: string): Promise<GenerateResponse> {
  return request<GenerateResponse>(`/api/poll/${id}`);
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

export function imageUrl(key: string): string {
  return `${BASE}/api/image/${encodeURIComponent(key)}`;
}
