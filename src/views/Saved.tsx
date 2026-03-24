import { useState, useEffect, useRef } from "react";
import { listSaved, updateSaved, removeSaved, imageUrl } from "../lib/api";
import type { SavedDrawing } from "@shared/types";

interface Props {
  onSendToExplore: (prompt: string, model?: string) => void;
}

export function Saved({ onSendToExplore }: Props) {
  const [drawings, setDrawings] = useState<SavedDrawing[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [editingTags, setEditingTags] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [noteInput, setNoteInput] = useState("");
  const [saving, setSaving] = useState(false);
  const tagInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadDrawings();
  }, []);

  async function loadDrawings() {
    setLoading(true);
    try {
      const data = await listSaved();
      setDrawings(data);
    } catch {
      // Not loaded yet
    } finally {
      setLoading(false);
    }
  }

  const allTags = [...new Set(drawings.flatMap((d) => d.tags))].sort();

  const filtered = tagFilter
    ? drawings.filter((d) => d.tags.includes(tagFilter))
    : drawings;

  const selectedDrawing = drawings.find((d) => d.id === selected);

  function startEditTags(drawing: SavedDrawing) {
    setEditingTags(true);
    setTagInput(drawing.tags.join(", "));
    setTimeout(() => tagInputRef.current?.focus(), 0);
  }

  function startEditNote(drawing: SavedDrawing) {
    setEditingNote(true);
    setNoteInput(drawing.note);
  }

  async function saveTags(drawing: SavedDrawing) {
    setSaving(true);
    const tags = tagInput
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    try {
      const updated = await updateSaved(drawing.id, { tags });
      setDrawings((prev) => prev.map((d) => (d.id === drawing.id ? updated : d)));
      setEditingTags(false);
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  }

  async function saveNote(drawing: SavedDrawing) {
    setSaving(true);
    try {
      const updated = await updateSaved(drawing.id, { note: noteInput });
      setDrawings((prev) => prev.map((d) => (d.id === drawing.id ? updated : d)));
      setEditingNote(false);
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(drawing: SavedDrawing) {
    try {
      await removeSaved(drawing.id);
      setDrawings((prev) => prev.filter((d) => d.id !== drawing.id));
      if (selected === drawing.id) setSelected(null);
    } catch {
      // ignore
    }
  }

  function downloadAll() {
    const toDownload = tagFilter ? filtered : drawings;
    toDownload.forEach((d) => {
      const a = document.createElement("a");
      a.href = imageUrl(d.imageKey);
      a.download = `${d.tags[0] || "icon"}-${d.id.slice(0, 8)}.png`;
      a.target = "_blank";
      a.click();
    });
  }

  if (loading) {
    return <div className="empty-state"><p>Loading saved drawings...</p></div>;
  }

  if (drawings.length === 0) {
    return (
      <div className="empty-state">
        <p>No saved drawings yet. Use the save button in Explorer or Review to save drawings you like.</p>
      </div>
    );
  }

  return (
    <div className="explorer">
      <div className="settings-row">
        <div className="field">
          <label>Filter by tag</label>
          <select value={tagFilter ?? ""} onChange={(e) => setTagFilter(e.target.value || null)}>
            <option value="">All ({drawings.length})</option>
            {allTags.map((tag) => (
              <option key={tag} value={tag}>
                {tag} ({drawings.filter((d) => d.tags.includes(tag)).length})
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Tags</label>
          <div className="saved-tags-bar">
            {allTags.map((tag) => (
              <button
                key={tag}
                className={`saved-tag ${tagFilter === tag ? "active" : ""}`}
                onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>
        <div className="field" style={{ alignSelf: "end" }}>
          <button onClick={downloadAll}>
            Download {tagFilter ? "Filtered" : "All"} ({filtered.length})
          </button>
        </div>
      </div>

      <div className="review-grid">
        {filtered.map((d) => (
          <div
            key={d.id}
            className={`review-card ${selected === d.id ? "selected" : ""}`}
            onClick={() => {
              setSelected(d.id);
              setEditingTags(false);
              setEditingNote(false);
            }}
          >
            <img src={imageUrl(d.imageKey)} alt={d.prompt.slice(0, 40)} />
            <div className="name">
              {d.tags.length > 0 ? d.tags.join(", ") : <span style={{ opacity: 0.5 }}>no tags</span>}
            </div>
          </div>
        ))}
      </div>

      {selectedDrawing && (
        <div className="saved-detail">
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
            <strong>{selectedDrawing.source}</strong>
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {new Date(selectedDrawing.createdAt).toLocaleDateString()}
            </span>
          </div>

          <div className="saved-detail-content">
            <div className="saved-detail-image">
              <img
                src={imageUrl(selectedDrawing.imageKey)}
                alt={selectedDrawing.prompt.slice(0, 40)}
              />
            </div>

            <div className="saved-detail-info">
              {/* Tags */}
              <div className="saved-section">
                <label>Tags</label>
                {editingTags ? (
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      ref={tagInputRef}
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      placeholder="comma-separated tags"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveTags(selectedDrawing);
                        if (e.key === "Escape") setEditingTags(false);
                      }}
                    />
                    <button className="primary" onClick={() => saveTags(selectedDrawing)} disabled={saving}>
                      {saving ? "..." : "Save"}
                    </button>
                    <button onClick={() => setEditingTags(false)}>Cancel</button>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    {selectedDrawing.tags.length > 0 ? (
                      selectedDrawing.tags.map((tag) => (
                        <span key={tag} className="saved-tag">{tag}</span>
                      ))
                    ) : (
                      <span style={{ fontSize: 12, color: "var(--text-dim)" }}>no tags</span>
                    )}
                    <button style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => startEditTags(selectedDrawing)}>
                      edit
                    </button>
                  </div>
                )}
              </div>

              {/* Note */}
              <div className="saved-section">
                <label>Note</label>
                {editingNote ? (
                  <div style={{ display: "grid", gap: 8 }}>
                    <textarea
                      value={noteInput}
                      onChange={(e) => setNoteInput(e.target.value)}
                      placeholder="Add a note about this drawing..."
                      style={{ minHeight: 60 }}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setEditingNote(false);
                      }}
                    />
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="primary" onClick={() => saveNote(selectedDrawing)} disabled={saving}>
                        {saving ? "..." : "Save"}
                      </button>
                      <button onClick={() => setEditingNote(false)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 8, alignItems: "start" }}>
                    <span style={{ fontSize: 12, color: selectedDrawing.note ? "var(--text)" : "var(--text-dim)", whiteSpace: "pre-wrap", flex: 1 }}>
                      {selectedDrawing.note || "no note"}
                    </span>
                    <button style={{ padding: "2px 8px", fontSize: 11, flexShrink: 0 }} onClick={() => startEditNote(selectedDrawing)}>
                      edit
                    </button>
                  </div>
                )}
              </div>

              {/* Prompt */}
              <div className="saved-section">
                <label>Prompt</label>
                <div style={{ fontSize: 12, color: "var(--text-dim)", wordBreak: "break-word" }}>
                  {selectedDrawing.prompt}
                </div>
              </div>

              {/* Model */}
              <div className="saved-section">
                <label>Model</label>
                <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                  {selectedDrawing.provider} / {selectedDrawing.model}
                </div>
              </div>

              {/* Actions */}
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button onClick={() => onSendToExplore(selectedDrawing.prompt, selectedDrawing.model)}>
                  Explore
                </button>
                <button onClick={() => window.open(imageUrl(selectedDrawing.imageKey), "_blank")}>
                  Open Full
                </button>
                <button className="danger" onClick={() => handleRemove(selectedDrawing)}>
                  Unsave
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
