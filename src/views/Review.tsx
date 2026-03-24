import { useState } from "react";
import { generateImage, pollPrediction } from "../lib/api";
import type { GenerationJob, GenerateRequest } from "@shared/types";

interface Props {
  jobs: GenerationJob[];
  onUpdateJob: (id: string, updates: Partial<GenerationJob>) => void;
}

export function Review({ jobs, onUpdateJob }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "completed" | "failed">("all");

  const filtered = jobs.filter((j) => {
    if (filter === "completed") return j.status === "completed";
    if (filter === "failed") return j.status === "failed";
    return true;
  });

  const packs = [...new Set(jobs.map((j) => j.packName))];

  async function handleReroll(job: GenerationJob) {
    onUpdateJob(job.id, { status: "running" });

    try {
      const req: GenerateRequest = {
        prompt: job.prompt,
        provider: "replicate",
        model: job.model,
      };
      const res = await generateImage(req);

      if (res.status === "completed") {
        onUpdateJob(job.id, {
          status: "completed",
          resultUrl: res.resultUrl,
          updatedAt: new Date().toISOString(),
        });
      } else if (res.status === "failed") {
        onUpdateJob(job.id, { status: "failed", error: res.error });
      } else if (res.id) {
        // Poll
        const maxAttempts = 60;
        for (let i = 0; i < maxAttempts; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const poll = await pollPrediction(res.id);
          if (poll.status === "completed") {
            onUpdateJob(job.id, {
              status: "completed",
              resultUrl: poll.resultUrl,
              updatedAt: new Date().toISOString(),
            });
            return;
          }
          if (poll.status === "failed") {
            onUpdateJob(job.id, { status: "failed", error: poll.error });
            return;
          }
        }
      }
    } catch (e) {
      onUpdateJob(job.id, { status: "failed", error: (e as Error).message });
    }
  }

  function downloadAll() {
    const completed = jobs.filter((j) => j.status === "completed" && j.resultUrl);
    completed.forEach((j) => {
      const a = document.createElement("a");
      a.href = j.resultUrl!;
      a.download = `${j.iconName}.png`;
      a.target = "_blank";
      a.click();
    });
  }

  if (jobs.length === 0) {
    return (
      <div className="empty-state">
        <p>No generated images yet. Use Explorer or Batch to create some.</p>
      </div>
    );
  }

  const selectedJob = jobs.find((j) => j.id === selected);

  return (
    <div className="explorer">
      <div className="settings-row">
        <div className="field">
          <label>Filter</label>
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="all">All ({jobs.length})</option>
            <option value="completed">Completed ({jobs.filter((j) => j.status === "completed").length})</option>
            <option value="failed">Failed ({jobs.filter((j) => j.status === "failed").length})</option>
          </select>
        </div>
        <div className="field">
          <label>Packs</label>
          <div style={{ padding: "8px 0", fontSize: 12, color: "var(--text-dim)" }}>
            {packs.join(", ") || "none"}
          </div>
        </div>
        <div className="field" style={{ alignSelf: "end" }}>
          <button onClick={downloadAll}>Download All</button>
        </div>
      </div>

      <div className="review-grid">
        {filtered.map((j) => (
          <div
            key={j.id}
            className={`review-card ${selected === j.id ? "selected" : ""}`}
            onClick={() => setSelected(j.id)}
          >
            {j.status === "completed" && j.resultUrl ? (
              <img src={j.resultUrl} alt={j.iconName} />
            ) : (
              <div style={{ aspectRatio: "1", display: "grid", placeItems: "center" }}>
                <span className={`status-badge ${j.status}`}>{j.status}</span>
              </div>
            )}
            <div className="name">{j.iconName}</div>
          </div>
        ))}
      </div>

      {selectedJob && (
        <div style={{ marginTop: 20, padding: 16, background: "var(--surface)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
            <strong>{selectedJob.iconName}</strong>
            <span className={`status-badge ${selectedJob.status}`}>{selectedJob.status}</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 8 }}>
            {selectedJob.prompt}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 12 }}>
            {selectedJob.provider} / {selectedJob.model}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => handleReroll(selectedJob)}>Reroll</button>
            {selectedJob.resultUrl && (
              <button onClick={() => window.open(selectedJob.resultUrl, "_blank")}>Open Full</button>
            )}
          </div>
          {selectedJob.error && <div className="error-msg" style={{ marginTop: 8 }}>{selectedJob.error}</div>}
        </div>
      )}
    </div>
  );
}
