import { useState, useEffect, useMemo } from "react";
import { zipSync, strToU8 } from "fflate";
import {
  listGameProjects,
  getGameProject,
  saveGameProject,
  generateGameIcons,
  updateGameIconStatuses,
  uploadGameIconImage,
  useImageForGameIcon,
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
  onSendToExplore: (prompt: string, model?: string, gameIconContext?: { projectId: string; iconId: string }, inputImageKey?: string) => void;
}

export function GameIcons({ onSendToExplore }: GameIconsProps) {
  const [projects, setProjects] = useState<GameProjectSummary[]>([]);
  const [project, setProject] = useState<GameProject | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Cache-busting timestamp — updated after image uploads to force
  // the browser to fetch the new image even though the R2 key is unchanged.
  const [imgCacheBust, setImgCacheBust] = useState(() => Date.now());
  const gameImageUrl = (key: string) => `${imageUrl(key)}?t=${imgCacheBust}`;

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

  // New project mode
  const [showNew, setShowNew] = useState(false);
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");

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

    // Process one icon at a time to avoid Cloudflare Worker timeout
    // and to persist progress incrementally (important on mobile where
    // the screen may close at any time).
    let ok = 0;
    let fail = 0;

    for (let i = 0; i < targets.length; i++) {
      setGenProgress(`Generating ${i + 1} of ${targets.length} (${ok} done, ${fail} failed)...`);

      try {
        const res = await generateGameIcons(project.id, { ids: [targets[i]] });
        if (res.results[0]?.status === "generated") ok++;
        else fail++;
      } catch {
        fail++;
      }

      // Refresh UI after each icon so the user sees progress
      setImgCacheBust(Date.now());
      await loadProject(project.id);
    }

    setGenProgress(`Done: ${ok} generated, ${fail} failed`);
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

  async function handleRestoreImage(iconId: string, imageKey: string) {
    if (!project) return;
    try {
      await useImageForGameIcon(project.id, iconId, imageKey);
      setImgCacheBust(Date.now());
      await loadProject(project.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleUploadImage(iconId: string, file: File) {
    if (!project) return;
    try {
      await uploadGameIconImage(project.id, iconId, file);
      setImgCacheBust(Date.now());
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

  async function handleCreateNew() {
    setError("");
    const id = newId.trim();
    const name = newName.trim();
    if (!id || !name) {
      setError("Need an id and a name");
      return;
    }
    if (!/^[a-z0-9][a-z0-9-_]*$/i.test(id)) {
      setError("id must be alphanumeric (dashes/underscores allowed)");
      return;
    }
    if (projects.some((p) => p.id === id)) {
      setError(`Project "${id}" already exists`);
      return;
    }
    const now = new Date().toISOString();
    const fresh: GameProject = {
      id,
      name,
      styleGuide: {
        approach: "",
        resolution: "",
        paletteConstraints: [],
        composition: [],
        consistency: [],
        phaseTinting: {},
      },
      icons: [],
      states: {},
      defaultModel: "black-forest-labs/flux-schnell",
      defaultSize: "256x256",
      createdAt: now,
      updatedAt: now,
    };
    try {
      await saveGameProject(fresh);
      setShowNew(false);
      setNewId("");
      setNewName("");
      await loadProjects();
      await loadProject(id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function downloadIcons(icons: GameIconSpec[], fileLabel: string) {
    if (!project || icons.length === 0) return;

    setLoading(true);
    setError("");
    try {
      const MAX_ZIP_BYTES = 24 * 1024 * 1024; // 24 MB to leave headroom under 25 MB

      type IconEntry = {
        icon: GameIconSpec;
        data: Uint8Array;
        manifest: {
          id: string;
          filename: string;
          prompt: string;
          model: string;
          category: string;
          object: string;
          description: string;
          theme: string;
          size: number;
          tags: string[];
        };
      };

      const allEntries: IconEntry[] = await Promise.all(
        icons.map(async (icon) => {
          const state = project.states[icon.id]!;
          const res = await fetch(gameImageUrl(state.currentImageKey!));
          if (!res.ok) throw new Error(`Failed to fetch image for ${icon.id}`);
          const buf = await res.arrayBuffer();
          const data = new Uint8Array(buf);
          const filename = `images/${icon.id}.png`;
          return {
            icon,
            data,
            manifest: {
              id: icon.id,
              filename,
              prompt: state.currentPrompt ?? "",
              model: state.currentModel ?? "",
              category: icon.category,
              object: icon.object,
              description: icon.description,
              theme: icon.theme,
              size: icon.size,
              tags: icon.tags,
            },
          };
        })
      );

      // Partition into chunks that fit under the size limit
      const chunks: IconEntry[][] = [];
      let currentChunk: IconEntry[] = [];
      let currentSize = 0;
      for (const entry of allEntries) {
        const entrySize = entry.data.byteLength + (entry.manifest.prompt.length * 2) + 512;
        if (currentChunk.length > 0 && currentSize + entrySize > MAX_ZIP_BYTES) {
          chunks.push(currentChunk);
          currentChunk = [];
          currentSize = 0;
        }
        currentChunk.push(entry);
        currentSize += entrySize;
      }
      if (currentChunk.length > 0) chunks.push(currentChunk);

      const multiPart = chunks.length > 1;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const entries: Record<string, Uint8Array> = {};
        const manifest = chunk.map((e) => e.manifest);

        for (const e of chunk) {
          entries[e.manifest.filename] = e.data;
          if (e.manifest.prompt) {
            entries[`prompts/${e.manifest.id}.txt`] = strToU8(e.manifest.prompt);
          }
        }
        entries["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));

        const zip = zipSync(entries);
        const blob = new Blob([zip.buffer as ArrayBuffer], { type: "application/zip" });
        const suffix = multiPart ? `-part${i + 1}` : "";
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${project.name}-${fileLabel}${suffix}.zip`;
        a.click();
        URL.revokeObjectURL(a.href);
      }
    } catch (e) {
      setError(`Download failed: ${(e as Error).message}`);
    } finally {
      setLoading(false);
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
    await downloadIcons(approved, "icons");
  }

  async function handleDownloadSelected() {
    if (!project || selected.size === 0) return;
    const withImages = project.icons.filter((i) => {
      return selected.has(i.id) && project.states[i.id]?.currentImageKey;
    });
    if (withImages.length === 0) {
      setError("No selected icons have images to download");
      return;
    }
    await downloadIcons(withImages, "selected");
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
            Create an empty project, or import a full spec (JSON).
          </p>
          <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 12 }}>
            <button onClick={() => { setShowNew(true); setShowImport(false); }}>
              New Project
            </button>
            <button onClick={() => { setShowImport(true); setShowNew(false); }}>
              Import Project
            </button>
          </div>
        </div>
        {showNew && (
          <NewProjectPanel
            id={newId}
            name={newName}
            onIdChange={setNewId}
            onNameChange={setNewName}
            onCreate={handleCreateNew}
            onCancel={() => { setShowNew(false); setError(""); }}
            error={error}
          />
        )}
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
          <div className="gi-header-actions">
            <button onClick={() => { setShowNew(!showNew); setShowImport(false); setError(""); }}>
              {showNew ? "cancel" : "+ new"}
            </button>
            <button onClick={() => { setShowImport(!showImport); setShowNew(false); setError(""); }}>
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

      {showNew && (
        <NewProjectPanel
          id={newId}
          name={newName}
          onIdChange={setNewId}
          onNameChange={setNewName}
          onCreate={handleCreateNew}
          onCancel={() => { setShowNew(false); setError(""); }}
          error={error}
        />
      )}

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
            <button onClick={handleDownloadSelected}>download ({selected.size})</button>
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
                <img src={gameImageUrl(state.currentImageKey)} alt={icon.id} />
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
          gameImageUrl={gameImageUrl}
          onClose={() => setDetailIcon(null)}
          onGenerate={(id) => handleGenerate([id])}
          onStatus={(id, s) => handleSingleStatus(id, s)}
          onExplore={onSendToExplore}
          onUpload={handleUploadImage}
          onRestore={handleRestoreImage}
          generating={generating}
        />
      )}
    </div>
  );
}

// ── New Project Panel ────────────────────────────────────────────

function NewProjectPanel({
  id,
  name,
  onIdChange,
  onNameChange,
  onCreate,
  onCancel,
  error,
}: {
  id: string;
  name: string;
  onIdChange: (v: string) => void;
  onNameChange: (v: string) => void;
  onCreate: () => void;
  onCancel: () => void;
  error: string;
}) {
  return (
    <div className="gi-import">
      <div className="field">
        <label>Project id (slug, used as filename)</label>
        <input
          type="text"
          value={id}
          onChange={(e) => onIdChange(e.target.value)}
          placeholder="my-new-game"
        />
      </div>
      <div className="field">
        <label>Display name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="My New Game"
        />
      </div>
      {error && <div className="error-msg">{error}</div>}
      <div className="batch-controls">
        <button className="primary" onClick={onCreate}>Create</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
        Creates an empty project. Add icons later via import.
      </div>
    </div>
  );
}

// ── Import Panel ─────────────────────────────────────────────────

const EXAMPLE_GAME_PROJECT: GameProject = {
  id: "my-game",
  name: "My Game",
  styleGuide: {
    approach: "flat vector icons, crisp edges, transparent background",
    resolution: "256x256",
    paletteConstraints: ["limited palette (max 6 colors per icon)"],
    composition: ["centered subject", "consistent light from top-left"],
    consistency: ["uniform line weight across all icons"],
    phaseTinting: { day: "warm tones", night: "cool blue tones" },
  },
  icons: [
    {
      id: "sword",
      object: "a short steel sword",
      description: "diagonal, hilt at bottom-left, blade pointing top-right",
      use: "weapon inventory slot",
      theme: "day",
      category: "weapons",
      chain: "blades",
      chainRole: "base",
      size: 256,
      tags: ["melee", "starter"],
    },
    {
      id: "dagger",
      object: "a small steel dagger",
      description: "similar silhouette to sword but shorter blade",
      use: "weapon inventory slot",
      theme: "day",
      category: "weapons",
      chain: "blades",
      chainRole: "derived",
      chainNote: "shorter blade, same hilt style as sword",
      size: 256,
      tags: ["melee"],
    },
    {
      id: "potion_red",
      object: "a red healing potion",
      description: "round flask with cork stopper, red liquid inside",
      use: "consumable inventory slot",
      theme: "day",
      category: "consumables",
      chain: null,
      chainRole: "standalone",
      size: 256,
      tags: ["consumable", "healing"],
    },
  ],
  states: {},
  defaultModel: "black-forest-labs/flux-schnell",
  defaultSize: "256x256",
  createdAt: "",
  updatedAt: "",
};

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
  const [showSpec, setShowSpec] = useState(false);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") onChange(reader.result);
    };
    reader.readAsText(file);
  }

  function loadExample() {
    onChange(JSON.stringify(EXAMPLE_GAME_PROJECT, null, 2));
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
        <button onClick={loadExample}>Load Example</button>
        <button onClick={() => setShowSpec((s) => !s)}>
          {showSpec ? "Hide Spec" : "Show Spec"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
      {value && (
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
          {value.length.toLocaleString()} characters
        </div>
      )}
      {showSpec && (
        <div style={{ marginTop: 12, padding: 12, background: "var(--surface)", borderRadius: 4, fontSize: 12 }}>
          <strong>GameProject fields</strong>
          <ul style={{ marginTop: 6, paddingLeft: 18, lineHeight: 1.6 }}>
            <li><code>id</code> (string, slug): unique project id, used as filename</li>
            <li><code>name</code> (string): display name</li>
            <li><code>defaultModel</code> (string): e.g. <code>black-forest-labs/flux-schnell</code></li>
            <li><code>defaultSize</code> (string): e.g. <code>256x256</code></li>
            <li><code>styleGuide</code>: approach, resolution, paletteConstraints[], composition[], consistency[], phaseTinting (object)</li>
            <li><code>icons[]</code>: each has
              <ul style={{ paddingLeft: 16 }}>
                <li><code>id</code>, <code>object</code>, <code>description</code>, <code>use</code>, <code>theme</code>, <code>category</code>: text fields</li>
                <li><code>chain</code>: string or null — icons sharing a chain look consistent</li>
                <li><code>chainRole</code>: <code>"base"</code> | <code>"derived"</code> | <code>"standalone"</code></li>
                <li><code>chainNote</code> (optional): how a derived icon differs from its base</li>
                <li><code>size</code> (number): e.g. 256</li>
                <li><code>tags</code> (string[])</li>
              </ul>
            </li>
            <li><code>states</code>: leave as <code>{"{}"}</code> — the server fills this with per-icon generation state</li>
            <li><code>createdAt</code>, <code>updatedAt</code>: ISO timestamps — server will set these if empty</li>
          </ul>
          <div style={{ marginTop: 8, color: "var(--text-dim)" }}>
            Re-importing a project with the same <code>id</code> merges icons and preserves existing generation history.
          </div>
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
  gameImageUrl,
  onClose,
  onGenerate,
  onStatus,
  onExplore,
  onUpload,
  onRestore,
  generating,
}: {
  icon: GameIconSpec;
  state: GameIconState | undefined;
  project: GameProject;
  gameImageUrl: (key: string) => string;
  onClose: () => void;
  onGenerate: (id: string) => void;
  onStatus: (id: string, status: GameIconStatus) => void;
  onExplore: (prompt: string, model?: string, gameIconContext?: { projectId: string; iconId: string }, inputImageKey?: string) => void;
  onUpload: (iconId: string, file: File) => void;
  onRestore: (iconId: string, imageKey: string) => void;
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
            <img src={gameImageUrl(state.currentImageKey)} alt={icon.id} />
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
          <button onClick={() => {
            // For chain icons, pass the base icon's image as input for img2img
            let inputImageKey: string | undefined;
            if (icon.chain && icon.chainRole === "derived") {
              const baseIcon = project.icons.find(
                (i) => i.chain === icon.chain && i.chainRole === "base"
              );
              if (baseIcon) {
                const baseState = project.states[baseIcon.id];
                if (baseState?.currentImageKey) {
                  inputImageKey = baseState.currentImageKey;
                }
              }
            }
            onExplore(state.currentPrompt!, state.currentModel, { projectId: project.id, iconId: icon.id }, inputImageKey);
          }}>
            explore in editor
          </button>
        )}
        {state?.currentImageKey && (
          <a
            href={gameImageUrl(state.currentImageKey)}
            download={`${icon.id}.png`}
            style={{ display: "contents" }}
          >
            <button>download</button>
          </a>
        )}
        <label className="gi-upload-btn">
          upload image
          <input
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onUpload(icon.id, file);
              e.target.value = "";
            }}
          />
        </label>
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
                      <img src={gameImageUrl(sibState.currentImageKey)} alt={sibling.id} />
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
            {[...state.history].reverse().map((h, i) => {
              const isCurrent = h.imageKey === state.currentImageKey;
              return (
                <div key={i} className="gi-history-item">
                  <img src={gameImageUrl(h.imageKey)} alt={`attempt ${state.history.length - i}`} />
                  <div>
                    <span style={{ fontSize: 11 }}>
                      {new Date(h.timestamp).toLocaleString()}
                      {h.approved && <strong style={{ color: "var(--success)", marginLeft: 6 }}>approved</strong>}
                      {isCurrent && <strong style={{ color: "var(--accent)", marginLeft: 6 }}>current</strong>}
                    </span>
                    <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{h.model}</span>
                  </div>
                  {!isCurrent && (
                    <button
                      style={{ fontSize: 10, padding: "2px 6px" }}
                      title="Restore this version"
                      onClick={() => onRestore(icon.id, h.imageKey)}
                    >
                      Restore
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
