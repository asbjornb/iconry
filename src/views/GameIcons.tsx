import { useState, useEffect, useMemo } from "react";
import {
  listGameProjects,
  getGameProject,
  saveGameProject,
  generateGameIcons,
  updateGameIconStatuses,
  imageUrl,
} from "../lib/api";
import { ModelSelect } from "../components/ModelSelect";
import type {
  GameProject,
  GameProjectSummary,
  GameIconSpec,
  GameIconState,
  GameIconStatus,
} from "@shared/types";

interface GameIconsProps {
  onSendToExplore: (prompt: string, model?: string) => void;
}

export function GameIcons({ onSendToExplore }: GameIconsProps) {
  const [projects, setProjects] = useState<GameProjectSummary[]>([]);
  const [project, setProject] = useState<GameProject | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Filters
  const [filterStatus, setFilterStatus] = useState<GameIconStatus | "all">("all");
  const [filterChain, setFilterChain] = useState<string>("all");
  const [filterCategory, setFilterCategory] = useState<string>("all");

  // Generation state
  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState("");

  // Selection for bulk actions
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Detail view
  const [detailIcon, setDetailIcon] = useState<string | null>(null);

  // Import mode
  const [showImport, setShowImport] = useState(false);
  const [importJson, setImportJson] = useState("");

  useEffect(() => {
    loadProjects();
  }, []);

  async function loadProjects() {
    setLoading(true);
    try {
      const list = await listGameProjects();
      setProjects(list);
      // Auto-load first project
      if (list.length > 0 && !project) {
        await loadProject(list[0].id);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function loadProject(id: string) {
    try {
      const p = await getGameProject(id);
      setProject(p);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Derived data
  const chains = useMemo(() => {
    if (!project) return [];
    const set = new Set<string>();
    for (const icon of project.icons) {
      if (icon.chain) set.add(icon.chain);
    }
    return [...set].sort();
  }, [project]);

  const categories = useMemo(() => {
    if (!project) return [];
    const set = new Set<string>();
    for (const icon of project.icons) {
      set.add(icon.category);
    }
    return [...set].sort();
  }, [project]);

  const filteredIcons = useMemo(() => {
    if (!project) return [];
    return project.icons.filter((icon) => {
      const state = project.states[icon.id];
      const status = state?.status ?? "pending";
      if (filterStatus !== "all" && status !== filterStatus) return false;
      if (filterChain !== "all" && (icon.chain ?? "(standalone)") !== filterChain) return false;
      if (filterCategory !== "all" && icon.category !== filterCategory) return false;
      return true;
    });
  }, [project, filterStatus, filterChain, filterCategory]);

  const counts = useMemo(() => {
    if (!project) return { total: 0, pending: 0, generated: 0, approved: 0, rejected: 0 };
    const states = Object.values(project.states);
    return {
      total: project.icons.length,
      pending: project.icons.length - states.length + states.filter((s) => s.status === "pending").length,
      generated: states.filter((s) => s.status === "generated").length,
      approved: states.filter((s) => s.status === "approved").length,
      rejected: states.filter((s) => s.status === "rejected").length,
    };
  }, [project]);

  function getState(iconId: string): GameIconState | undefined {
    return project?.states[iconId];
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(filteredIcons.map((i) => i.id)));
  }

  function selectNone() {
    setSelected(new Set());
  }

  async function handleGenerate(ids?: string[]) {
    if (!project) return;
    const targets = ids ?? [...selected];
    if (targets.length === 0) {
      setError("Select icons to generate");
      return;
    }

    const cost = targets.length * 0.003;
    if (!window.confirm(`Generate ${targets.length} icon(s)?\nEstimated cost: ~$${cost.toFixed(3)}`)) return;

    setGenerating(true);
    setError("");

    // Process in small batches to avoid Cloudflare Worker timeout
    const BATCH_SIZE = 3;
    const allResults: Array<{ id: string; status: string; error?: string; imageKey?: string }> = [];
    let ok = 0;
    let fail = 0;

    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      const batch = targets.slice(i, i + BATCH_SIZE);
      setGenProgress(`Generating ${i + 1}–${Math.min(i + batch.length, targets.length)} of ${targets.length} (${ok} done, ${fail} failed)...`);

      try {
        const res = await generateGameIcons(project.id, { ids: batch });
        for (const r of res.results) {
          allResults.push(r);
          if (r.status === "generated") ok++;
          else fail++;
        }
      } catch (e) {
        // Mark entire batch as failed, continue with next batch
        fail += batch.length;
        for (const id of batch) {
          allResults.push({ id, status: "failed", error: (e as Error).message });
        }
      }
    }

    setGenProgress(`Done: ${ok} generated, ${fail} failed`);
    await loadProject(project.id);
    setGenerating(false);
  }

  async function handleBulkStatus(status: GameIconStatus) {
    if (!project || selected.size === 0) return;
    try {
      const updates = [...selected].map((iconId) => ({ iconId, status }));
      await updateGameIconStatuses(project.id, updates);
      await loadProject(project.id);
      setSelected(new Set());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleSingleStatus(iconId: string, status: GameIconStatus) {
    if (!project) return;
    try {
      await updateGameIconStatuses(project.id, [{ iconId, status }]);
      await loadProject(project.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleImport() {
    setError("");
    try {
      const data = JSON.parse(importJson) as GameProject;
      if (!data.id || !data.name || !data.icons) {
        setError("Invalid project JSON — needs id, name, icons");
        return;
      }
      await saveGameProject(data);
      setShowImport(false);
      setImportJson("");
      await loadProjects();
      await loadProject(data.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleDownloadApproved() {
    if (!project) return;
    const approved = project.icons.filter((i) => {
      const s = project.states[i.id];
      return s?.status === "approved" && s.currentImageKey;
    });
    if (approved.length === 0) {
      setError("No approved icons to download");
      return;
    }

    // Build a manifest and trigger individual downloads
    const manifest: Array<{ id: string; prompt: string; model: string; url: string }> = [];
    for (const icon of approved) {
      const state = project.states[icon.id]!;
      manifest.push({
        id: icon.id,
        prompt: state.currentPrompt ?? "",
        model: state.currentModel ?? "",
        url: imageUrl(state.currentImageKey!),
      });
    }

    // Download manifest as JSON
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${project.name}-icons-manifest.json`;
    a.click();
    URL.revokeObjectURL(a.href);

    // Also trigger image downloads
    for (const item of manifest) {
      const link = document.createElement("a");
      link.href = item.url;
      link.download = `${item.id}.png`;
      link.click();
    }
  }

  const detail = detailIcon ? project?.icons.find((i) => i.id === detailIcon) : null;
  const detailState = detailIcon ? getState(detailIcon) : undefined;

  // ── No project loaded ──────────────────────────────────────────
  if (!project && !loading) {
    return (
      <div className="explorer">
        <div className="gi-empty">
          <p>No game projects yet.</p>
          <p style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 8 }}>
            Import a project spec (JSON) to start tracking icons.
          </p>
          <button onClick={() => setShowImport(true)} style={{ marginTop: 12 }}>
            Import Project
          </button>
        </div>
        {showImport && (
          <ImportPanel
            value={importJson}
            onChange={setImportJson}
            onImport={handleImport}
            onCancel={() => setShowImport(false)}
            error={error}
          />
        )}
      </div>
    );
  }

  if (loading && !project) {
    return <div className="empty-state">Loading...</div>;
  }

  // ── Main view ──────────────────────────────────────────────────
  return (
    <div className="explorer">
      {/* Header: project picker + summary */}
      <div className="gi-header">
        <div className="gi-header-top">
          {projects.length > 1 ? (
            <select
              value={project?.id}
              onChange={(e) => loadProject(e.target.value)}
              style={{ width: "auto", flex: "0 0 auto" }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : (
            <strong>{project?.name}</strong>
          )}
          <div className="gi-header-actions">
            <button onClick={() => setShowImport(!showImport)}>
              {showImport ? "cancel" : "import"}
            </button>
            <button onClick={handleDownloadApproved} className="primary">
              download approved
            </button>
          </div>
        </div>

        {/* Summary bar */}
        <div className="gi-summary">
          <span className="gi-count" onClick={() => setFilterStatus("all")}>
            {counts.total} total
          </span>
          <span className="gi-count gi-pending" onClick={() => setFilterStatus("pending")}>
            {counts.pending} pending
          </span>
          <span className="gi-count gi-generated" onClick={() => setFilterStatus("generated")}>
            {counts.generated} generated
          </span>
          <span className="gi-count gi-approved" onClick={() => setFilterStatus("approved")}>
            {counts.approved} approved
          </span>
          {counts.rejected > 0 && (
            <span className="gi-count gi-rejected" onClick={() => setFilterStatus("rejected")}>
              {counts.rejected} rejected
            </span>
          )}
        </div>
      </div>

      {showImport && (
        <ImportPanel
          value={importJson}
          onChange={setImportJson}
          onImport={handleImport}
          onCancel={() => setShowImport(false)}
          error={error}
        />
      )}

      {/* Filters */}
      <div className="gi-filters">
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as GameIconStatus | "all")}>
          <option value="all">all statuses</option>
          <option value="pending">pending</option>
          <option value="generated">generated</option>
          <option value="approved">approved</option>
          <option value="rejected">rejected</option>
        </select>
        <select value={filterChain} onChange={(e) => setFilterChain(e.target.value)}>
          <option value="all">all chains</option>
          <option value="(standalone)">(standalone)</option>
          {chains.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
          <option value="all">all categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <span className="gi-filter-count">{filteredIcons.length} shown</span>
      </div>

      {/* Bulk actions */}
      <div className="gi-bulk">
        <button onClick={selectAll}>select all ({filteredIcons.length})</button>
        {selected.size > 0 && (
          <>
            <button onClick={selectNone}>deselect</button>
            <button
              className="primary"
              onClick={() => handleGenerate()}
              disabled={generating}
            >
              {generating ? "generating..." : `generate (${selected.size})`}
            </button>
            <button onClick={() => handleBulkStatus("approved")}>approve</button>
            <button onClick={() => handleBulkStatus("rejected")}>reject</button>
          </>
        )}
        {genProgress && <span className="gi-progress">{genProgress}</span>}
      </div>

      {error && <div className="error-msg">{error}</div>}

      {/* Icon grid */}
      <div className="gi-grid">
        {filteredIcons.map((icon) => {
          const state = getState(icon.id);
          const status = state?.status ?? "pending";
          return (
            <div
              key={icon.id}
              className={`gi-card gi-card-${status} ${selected.has(icon.id) ? "gi-card-selected" : ""}`}
              onClick={() => setDetailIcon(icon.id)}
            >
              <div className="gi-card-select" onClick={(e) => { e.stopPropagation(); toggleSelect(icon.id); }}>
                <input type="checkbox" checked={selected.has(icon.id)} readOnly />
              </div>
              {state?.currentImageKey ? (
                <img src={imageUrl(state.currentImageKey)} alt={icon.id} />
              ) : (
                <div className="gi-card-empty">
                  <span>{icon.object}</span>
                </div>
              )}
              <div className="gi-card-footer">
                <span className="gi-card-name">{icon.id}</span>
                <span className={`gi-status gi-status-${status}`}>{status}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Detail panel */}
      {detail && (
        <IconDetail
          icon={detail}
          state={detailState}
          project={project!}
          onClose={() => setDetailIcon(null)}
          onGenerate={(id) => handleGenerate([id])}
          onStatus={(id, s) => handleSingleStatus(id, s)}
          onExplore={onSendToExplore}
          generating={generating}
        />
      )}
    </div>
  );
}

// ── Import Panel ─────────────────────────────────────────────────

function ImportPanel({
  value,
  onChange,
  onImport,
  onCancel,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  onImport: () => void;
  onCancel: () => void;
  error: string;
}) {
  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") onChange(reader.result);
    };
    reader.readAsText(file);
  }

  return (
    <div className="gi-import">
      <div className="field">
        <label>Paste GameProject JSON or load from file</label>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={'{\n  "id": "my-game",\n  "name": "My Game",\n  "icons": [...],\n  "styleGuide": {...},\n  ...\n}'}
          style={{ minHeight: 200, fontSize: 11 }}
        />
      </div>
      {error && <div className="error-msg">{error}</div>}
      <div className="batch-controls">
        <button className="primary" onClick={onImport}>Import</button>
        <label className="file-upload-btn">
          Load File
          <input type="file" accept=".json" onChange={handleFile} style={{ display: "none" }} />
        </label>
        <button onClick={onCancel}>Cancel</button>
      </div>
      {value && (
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
          {value.length.toLocaleString()} characters
        </div>
      )}
    </div>
  );
}

// ── Icon Detail Panel ────────────────────────────────────────────

function IconDetail({
  icon,
  state,
  project,
  onClose,
  onGenerate,
  onStatus,
  onExplore,
  generating,
}: {
  icon: GameIconSpec;
  state: GameIconState | undefined;
  project: GameProject;
  onClose: () => void;
  onGenerate: (id: string) => void;
  onStatus: (id: string, status: GameIconStatus) => void;
  onExplore: (prompt: string, model?: string) => void;
  generating: boolean;
}) {
  const status = state?.status ?? "pending";

  // Find chain siblings
  const chainSiblings = icon.chain
    ? project.icons.filter((i) => i.chain === icon.chain && i.id !== icon.id)
    : [];

  return (
    <div className="gi-detail">
      <div className="gi-detail-header">
        <div>
          <strong>{icon.id}</strong>
          <span className={`gi-status gi-status-${status}`} style={{ marginLeft: 8 }}>{status}</span>
        </div>
        <button onClick={onClose}>close</button>
      </div>

      <div className="gi-detail-body">
        {/* Image */}
        <div className="gi-detail-image">
          {state?.currentImageKey ? (
            <img src={imageUrl(state.currentImageKey)} alt={icon.id} />
          ) : (
            <div className="gi-card-empty" style={{ height: 200 }}>
              <span>not yet generated</span>
            </div>
          )}
        </div>

        {/* Spec info */}
        <div className="gi-detail-info">
          <div className="saved-section">
            <label>Object</label>
            <span>{icon.object}</span>
          </div>
          <div className="saved-section">
            <label>Description</label>
            <span style={{ fontSize: 12 }}>{icon.description}</span>
          </div>
          <div className="saved-section">
            <label>Details</label>
            <span style={{ fontSize: 12 }}>
              Theme: {icon.theme} | Category: {icon.category} | Size: {icon.size}px
              {icon.chain && <> | Chain: {icon.chain} ({icon.chainRole})</>}
            </span>
          </div>
          {icon.chainNote && (
            <div className="saved-section">
              <label>Chain Note</label>
              <span style={{ fontSize: 12 }}>{icon.chainNote}</span>
            </div>
          )}
          {state?.currentPrompt && (
            <div className="saved-section">
              <label>Last Prompt</label>
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{state.currentPrompt}</span>
            </div>
          )}
          <div className="saved-section">
            <label>Tags</label>
            <div className="saved-tags-bar">
              {icon.tags.map((t) => (
                <span key={t} className="saved-tag">{t}</span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="gi-detail-actions">
        <button
          className="primary"
          onClick={() => onGenerate(icon.id)}
          disabled={generating}
        >
          {generating ? "generating..." : status === "pending" ? "generate" : "re-generate"}
        </button>
        {(status === "generated" || status === "rejected") && (
          <button onClick={() => onStatus(icon.id, "approved")}>approve</button>
        )}
        {(status === "generated" || status === "approved") && (
          <button onClick={() => onStatus(icon.id, "rejected")}>reject</button>
        )}
        {state?.currentPrompt && (
          <button onClick={() => onExplore(state.currentPrompt!, state.currentModel)}>
            explore in editor
          </button>
        )}
        {state?.currentImageKey && (
          <a
            href={imageUrl(state.currentImageKey)}
            download={`${icon.id}.png`}
            style={{ display: "contents" }}
          >
            <button>download</button>
          </a>
        )}
      </div>

      {/* Chain context */}
      {chainSiblings.length > 0 && (
        <div className="gi-detail-chain">
          <label>Chain: {icon.chain}</label>
          <div className="gi-chain-row">
            {[icon, ...chainSiblings]
              .sort((a, b) => {
                const order = { base: 0, standalone: 1, derived: 2 };
                return order[a.chainRole] - order[b.chainRole];
              })
              .map((sibling) => {
                const sibState = project.states[sibling.id];
                return (
                  <div key={sibling.id} className={`gi-chain-item ${sibling.id === icon.id ? "gi-chain-current" : ""}`}>
                    {sibState?.currentImageKey ? (
                      <img src={imageUrl(sibState.currentImageKey)} alt={sibling.id} />
                    ) : (
                      <div className="gi-chain-placeholder" />
                    )}
                    <span>{sibling.id}</span>
                    <span className={`gi-status gi-status-${sibState?.status ?? "pending"}`}>
                      {sibling.chainRole}
                    </span>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* History */}
      {state && state.history.length > 0 && (
        <div className="gi-detail-history">
          <label>Generation History ({state.history.length})</label>
          <div className="gi-history-list">
            {[...state.history].reverse().map((h, i) => (
              <div key={i} className="gi-history-item">
                <img src={imageUrl(h.imageKey)} alt={`attempt ${state.history.length - i}`} />
                <div>
                  <span style={{ fontSize: 11 }}>
                    {new Date(h.timestamp).toLocaleString()}
                    {h.approved && <strong style={{ color: "var(--success)", marginLeft: 6 }}>approved</strong>}
                  </span>
                  <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{h.model}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
