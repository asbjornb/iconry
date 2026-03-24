import { useState, useEffect } from "react";
import {
  listProjects,
  saveProject,
  deleteProject,
  runProject,
  imageUrl,
} from "../lib/api";
import type { Project, ProjectRun } from "@shared/types";
import { ModelSelect } from "../components/ModelSelect";

interface ProjectsProps {
  onSendToExplore: (prompt: string) => void;
}

export function Projects({ onSendToExplore }: ProjectsProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<Project | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [runProgress, setRunProgress] = useState("");

  // Form state
  const [name, setName] = useState("");
  const [preamble, setPreamble] = useState(
    "minimal flat icon, game asset, resource icon, tropical island theme, clean edges, transparent background"
  );
  const [itemsText, setItemsText] = useState("a coconut | large shell | bamboo");
  const [postfix, setPostfix] = useState(
    "nothing else, only the requested item"
  );
  const [model, setModel] = useState("black-forest-labs/flux-schnell");
  const [size, setSize] = useState("256x256");

  useEffect(() => {
    loadProjects();
  }, []);

  async function loadProjects() {
    setLoading(true);
    try {
      const list = await listProjects();
      setProjects(list);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function selectProject(p: Project) {
    setSelected(p);
    setName(p.name);
    setPreamble(p.preamble);
    setItemsText(p.items.join(" | "));
    setPostfix(p.postfix);
    setModel(p.model);
    setSize(p.size);
  }

  function newProject() {
    setSelected(null);
    setName("");
    setPreamble(
      "minimal flat icon, game asset, resource icon, tropical island theme, clean edges, transparent background"
    );
    setItemsText("a coconut");
    setPostfix("nothing else, only the requested item");
    setModel("black-forest-labs/flux-schnell");
    setSize("256x256");
  }

  function parseItems(text: string): string[] {
    return text
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function handleSave() {
    setError("");
    const items = parseItems(itemsText);
    if (!name.trim()) {
      setError("Project name is required");
      return;
    }
    if (items.length === 0) {
      setError("Add at least one item");
      return;
    }

    const now = new Date().toISOString();
    const project: Project = selected
      ? {
          ...selected,
          name: name.trim(),
          preamble,
          postfix,
          items,
          model,
          size,
          updatedAt: now,
        }
      : {
          id: crypto.randomUUID(),
          name: name.trim(),
          preamble,
          postfix,
          items,
          model,
          size,
          runs: [],
          createdAt: now,
          updatedAt: now,
        };

    try {
      const saved = await saveProject(project);
      setSelected(saved);
      await loadProjects();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleDelete() {
    if (!selected) return;
    if (!window.confirm(`Delete project "${selected.name}"?`)) return;
    try {
      await deleteProject(selected.id);
      newProject();
      await loadProjects();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleRun() {
    if (!selected) {
      setError("Save the project first before running");
      return;
    }

    // Save latest changes first
    await handleSave();

    const items = parseItems(itemsText);
    const cost = items.length * 0.003;
    if (
      !window.confirm(
        `Generate ${items.length} item(s)?\nEstimated cost: ~$${cost.toFixed(3)}\n\nThis may take a while as each item is generated sequentially.`
      )
    )
      return;

    setRunning(true);
    setRunProgress(`Generating ${items.length} item(s)...`);
    setError("");

    try {
      const run = await runProject(selected.id);
      const completed = run.results.filter(
        (r) => r.status === "completed"
      ).length;
      const failed = run.results.filter((r) => r.status === "failed").length;
      setRunProgress(
        `Done: ${completed} completed, ${failed} failed out of ${items.length}`
      );
      // Reload project to get updated runs
      await loadProjects();
      // Re-select to refresh
      const updated = (await listProjects()).find(
        (p) => p.id === selected.id
      );
      if (updated) setSelected(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  function buildPreview(item: string): string {
    return [preamble, item, postfix].filter(Boolean).join(", ");
  }

  const items = parseItems(itemsText);

  return (
    <div className="explorer">
      {/* Project list sidebar + editor */}
      <div className="project-layout">
        <div className="project-sidebar">
          <div className="project-sidebar-header">
            <strong>Projects</strong>
            <button onClick={newProject}>+ New</button>
          </div>
          {loading && (
            <div className="empty-state" style={{ padding: 20 }}>
              Loading...
            </div>
          )}
          {projects.map((p) => (
            <div
              key={p.id}
              className={`project-list-item ${selected?.id === p.id ? "active" : ""}`}
              onClick={() => selectProject(p)}
            >
              <div className="project-list-name">{p.name}</div>
              <div className="project-list-meta">
                {p.items.length} item(s) &middot; {p.runs.length} run(s)
              </div>
            </div>
          ))}
          {!loading && projects.length === 0 && (
            <div
              className="empty-state"
              style={{ padding: 20, fontSize: 12 }}
            >
              No projects yet
            </div>
          )}
        </div>

        <div className="project-editor">
          <div className="field">
            <label>Project Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. tropical-island-icons"
            />
          </div>

          <div className="field">
            <label>Preamble (common prefix for all items)</label>
            <textarea
              value={preamble}
              onChange={(e) => setPreamble(e.target.value)}
              placeholder="Style description prepended to every prompt..."
              style={{ minHeight: 60 }}
            />
          </div>

          <div className="field">
            <label>Items (separated by |)</label>
            <textarea
              value={itemsText}
              onChange={(e) => setItemsText(e.target.value)}
              placeholder="a coconut | large shell | bamboo | bamboo basket trap"
              style={{ minHeight: 40 }}
            />
          </div>

          <div className="field">
            <label>Postfix / Outro (common suffix for all items)</label>
            <textarea
              value={postfix}
              onChange={(e) => setPostfix(e.target.value)}
              placeholder="nothing else, only the requested item"
              style={{ minHeight: 40 }}
            />
          </div>

          <div className="settings-row">
            <div className="field">
              <label>Model</label>
              <ModelSelect value={model} onChange={setModel} />
            </div>
            <div className="field">
              <label>Size</label>
              <input
                value={size}
                onChange={(e) => setSize(e.target.value)}
              />
            </div>
          </div>

          {/* Prompt preview */}
          {items.length > 0 && (
            <div className="prompt-preview">
              <label>Prompt Preview ({items.length} item(s))</label>
              {items.slice(0, 3).map((item, i) => (
                <div key={i} className="prompt-preview-item">
                  <span className="prompt-preview-label">{item}:</span>
                  <span className="prompt-preview-text">
                    {buildPreview(item)}
                  </span>
                </div>
              ))}
              {items.length > 3 && (
                <div className="prompt-preview-item" style={{ opacity: 0.5 }}>
                  ...and {items.length - 3} more
                </div>
              )}
            </div>
          )}

          {error && <div className="error-msg">{error}</div>}

          <div className="batch-controls">
            <button className="primary" onClick={handleRun} disabled={running}>
              {running ? "Generating..." : `Run (${items.length} item${items.length !== 1 ? "s" : ""})`}
            </button>
            <button onClick={handleSave}>Save</button>
            {selected && (
              <button className="danger" onClick={handleDelete}>
                Delete
              </button>
            )}
          </div>

          {runProgress && <div className="batch-progress">{runProgress}</div>}
        </div>
      </div>

      {/* Run history */}
      {selected && selected.runs.length > 0 && (
        <div className="project-runs">
          <h3>Run History</h3>
          {[...selected.runs].reverse().map((run) => (
            <RunCard key={run.id} run={run} onSendToExplore={onSendToExplore} />
          ))}
        </div>
      )}
    </div>
  );
}

function RunCard({ run, onSendToExplore }: { run: ProjectRun; onSendToExplore: (prompt: string) => void }) {
  const [expanded, setExpanded] = useState(true);
  const completed = run.results.filter((r) => r.status === "completed").length;
  const failed = run.results.filter((r) => r.status === "failed").length;

  return (
    <div className="run-card">
      <div className="run-card-header" onClick={() => setExpanded(!expanded)}>
        <div>
          <strong>{new Date(run.createdAt).toLocaleString()}</strong>
          <span className="run-card-stats">
            {completed}/{run.results.length} completed
            {failed > 0 && <span className="run-card-failed"> &middot; {failed} failed</span>}
          </span>
        </div>
        <span>{expanded ? "\u25BC" : "\u25B6"}</span>
      </div>
      {expanded && (
        <>
          <div className="run-card-prompt">
            <span className="prompt-preview-label">preamble:</span> {run.preamble}
            {run.postfix && (
              <>
                <br />
                <span className="prompt-preview-label">postfix:</span> {run.postfix}
              </>
            )}
          </div>
          <div className="results-grid">
            {run.results.map((r, i) => (
              <div key={i} className="result-card">
                {r.status === "completed" && r.storedKey ? (
                  <img src={imageUrl(r.storedKey)} alt={r.item} />
                ) : (
                  <div
                    style={{
                      aspectRatio: "1",
                      display: "grid",
                      placeItems: "center",
                    }}
                  >
                    <span className={`status-badge ${r.status}`}>
                      {r.status}
                      {r.error ? `: ${r.error}` : ""}
                    </span>
                  </div>
                )}
                <div className="meta">
                  <span>{r.item}</span>
                  <div className="actions">
                    <button onClick={() => onSendToExplore(r.prompt)}>explore</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
