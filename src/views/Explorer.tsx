import { useState, useEffect } from "react";
import { generateImage, pollPrediction, imageUrl, deleteImage, saveDrawing, listProjects } from "../lib/api";
import type { GenerateRequest, GenerationJob, Project } from "@shared/types";
import { ModelSelect } from "../components/ModelSelect";

interface Props {
  onJobCreated: (job: GenerationJob) => void;
  initialPrompt?: string | null;
  initialModel?: string | null;
  onPromptConsumed?: () => void;
}

interface ExplorerResult {
  id: string;
  prompt: string;
  model: string;
  status: "running" | "completed" | "failed";
  resultUrl?: string;
  storedKey?: string;
  error?: string;
  saved?: boolean;
}

export function Explorer({ onJobCreated, initialPrompt, initialModel, onPromptConsumed }: Props) {
  const [prompt, setPrompt] = useState(
    "minimal flat icon, game asset, tropical island theme, clean edges, transparent background, a coconut"
  );
  const [model, setModel] = useState("black-forest-labs/flux-schnell");
  const [size, setSize] = useState("256x256");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<ExplorerResult[]>([]);
  const [error, setError] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [saveMenuId, setSaveMenuId] = useState<string | null>(null);

  useEffect(() => {
    if (initialPrompt) {
      setPrompt(initialPrompt);
      if (initialModel) setModel(initialModel);
      onPromptConsumed?.();
    }
  }, [initialPrompt]);

  useEffect(() => {
    listProjects().then(setProjects).catch(() => {});
  }, []);

  async function handleGenerate() {
    setLoading(true);
    setError("");

    try {
      const req: GenerateRequest = { prompt, provider: "replicate", model, size };
      const res = await generateImage(req);

      const result: ExplorerResult = {
        id: res.id,
        prompt,
        model,
        status: res.status === "completed" ? "completed" : res.status === "failed" ? "failed" : "running",
        resultUrl: res.resultUrl,
        storedKey: res.storedKey,
        error: res.error,
      };

      setResults((prev) => [result, ...prev]);

      // Poll if async (Replicate is always async)
      if (res.status !== "completed" && res.status !== "failed" && res.id) {
        pollUntilDone(res.id);
      }

      if (res.status === "completed") {
        onJobCreated(resultToJob(result));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function pollUntilDone(id: string) {
    const maxAttempts = 60;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const res = await pollPrediction(id, { prompt, model });
        const storedKey = res.storedKey;
        setResults((prev) =>
          prev.map((r) =>
            r.id === id
              ? {
                  ...r,
                  status: res.status === "completed" ? "completed" : res.status === "failed" ? "failed" : "running",
                  resultUrl: res.resultUrl,
                  storedKey: storedKey ?? r.storedKey,
                  error: res.error,
                }
              : r
          )
        );

        if (res.status === "completed" || res.status === "failed") {
          if (res.status === "completed") {
            const updated: ExplorerResult = { id, prompt, model, status: "completed", resultUrl: res.resultUrl, storedKey };
            onJobCreated(resultToJob(updated));
          }
          return;
        }
      } catch {
        // Retry on network error
      }
    }
  }

  async function handleSave(r: ExplorerResult, projectName?: string) {
    if (!r.storedKey) return;
    try {
      await saveDrawing({
        imageKey: r.storedKey,
        prompt: r.prompt,
        model: r.model,
        source: projectName ?? "explorer",
        tags: projectName ? [projectName.toLowerCase()] : [],
      });
      setResults((prev) => prev.map((x) => (x.id === r.id ? { ...x, saved: true } : x)));
      setSaveMenuId(null);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("already saved")) {
        setResults((prev) => prev.map((x) => (x.id === r.id ? { ...x, saved: true } : x)));
      }
      setSaveMenuId(null);
    }
  }

  async function handleDeleteResult(r: ExplorerResult) {
    if (r.storedKey) {
      try {
        await deleteImage(r.storedKey);
      } catch {
        // Image may already be gone
      }
    }
    setResults((prev) => prev.filter((x) => x.id !== r.id));
  }

  function resultToJob(r: ExplorerResult): GenerationJob {
    const now = new Date().toISOString();
    return {
      id: r.id,
      packName: "explorer",
      iconName: `explore-${Date.now()}`,
      status: r.status,
      prompt: r.prompt,
      provider: "replicate",
      model,
      resultUrl: r.resultUrl,
      storedKey: r.storedKey,
      error: r.error,
      createdAt: now,
      updatedAt: now,
    };
  }

  return (
    <div className="explorer">
      <div className="prompt-area">
        <div className="settings-row">
          <div className="field">
            <label>Model</label>
            <ModelSelect value={model} onChange={setModel} />
          </div>
          <div className="field">
            <label>Size</label>
            <input value={size} onChange={(e) => setSize(e.target.value)} placeholder="256x256" />
          </div>
        </div>

        <div className="prompt-row">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the icon you want to generate..."
          />
          <button className="primary" onClick={handleGenerate} disabled={loading}>
            {loading ? "..." : "Generate"}
          </button>
        </div>

        {error && <div className="error-msg">{error}</div>}
      </div>

      {results.length === 0 ? (
        <div className="empty-state">
          <p>Try a prompt to explore styles. Good results here become your reference for batch generation.</p>
        </div>
      ) : (
        <div className="results-grid">
          {results.map((r) => (
            <div key={r.id} className="result-card">
              {r.status === "completed" && (r.storedKey || r.resultUrl) ? (
                <img src={r.storedKey ? imageUrl(r.storedKey) : r.resultUrl!} alt={r.prompt} />
              ) : (
                <div style={{ aspectRatio: "1", display: "grid", placeItems: "center" }}>
                  {r.status === "running" && <span className="status-badge running">generating...</span>}
                  {r.status === "failed" && <span className="status-badge failed">failed{r.error ? `: ${r.error}` : ""}</span>}
                </div>
              )}
              <div className="meta">
                <span>{r.prompt.slice(0, 40)}...</span>
                <div className="actions">
                  {r.status === "completed" && r.storedKey && !r.saved && (
                    <div className="save-menu-wrap">
                      <button onClick={() => setSaveMenuId(saveMenuId === r.id ? null : r.id)}>
                        save
                      </button>
                      {saveMenuId === r.id && (
                        <div className="save-menu">
                          <button onClick={() => handleSave(r)}>Save (no project)</button>
                          {projects.map((p) => (
                            <button key={p.id} onClick={() => handleSave(r, p.name)}>
                              {p.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {r.saved && (
                    <button
                      disabled
                      style={{ color: "var(--success)", borderColor: "var(--success)" }}
                    >
                      saved
                    </button>
                  )}
                  {r.resultUrl && (
                    <button onClick={() => window.open(r.resultUrl, "_blank")}>open</button>
                  )}
                  <button onClick={() => setPrompt(r.prompt)}>reuse</button>
                  <button className="danger" onClick={() => handleDeleteResult(r)}>del</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
