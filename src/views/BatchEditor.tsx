import { useState } from "react";
import { submitBatch } from "../lib/api";
import type { PackSpec, GenerationJob } from "@shared/types";
import { EXAMPLE_PACK } from "@shared/types";

interface Props {
  onJobsCreated: (jobs: GenerationJob[]) => void;
}

export function BatchEditor({ onJobsCreated }: Props) {
  const [specText, setSpecText] = useState(JSON.stringify(EXAMPLE_PACK, null, 2));
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  function validate(): PackSpec | null {
    try {
      const parsed = JSON.parse(specText) as PackSpec;
      if (!parsed.name || !parsed.style || !parsed.icons?.length) {
        setError("Pack must have name, style, and at least one icon");
        return null;
      }
      return parsed;
    } catch (e) {
      setError(`Invalid JSON: ${(e as Error).message}`);
      return null;
    }
  }

  async function handleSubmit() {
    setError("");
    const pack = validate();
    if (!pack) return;

    const iconCount = pack.icons.length;
    const estimatedCost = iconCount * 0.003; // rough estimate for flux-schnell
    if (
      !window.confirm(
        `Generate ${iconCount} icons?\nEstimated cost: ~$${estimatedCost.toFixed(2)}\n\nThis runs sequentially to respect rate limits.`
      )
    ) {
      return;
    }

    setRunning(true);
    setProgress(`Submitting ${iconCount} icons...`);

    try {
      const res = await submitBatch(pack);
      const completed = res.jobs.filter((j) => j.status === "completed").length;
      const failed = res.jobs.filter((j) => j.status === "failed").length;
      setProgress(`Done: ${completed} completed, ${failed} failed out of ${iconCount}`);
      onJobsCreated(res.jobs);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  function loadExample() {
    setSpecText(JSON.stringify(EXAMPLE_PACK, null, 2));
  }

  return (
    <div className="explorer">
      <div className="field">
        <label>Pack Specification (JSON)</label>
        <textarea
          className="batch-editor"
          value={specText}
          onChange={(e) => setSpecText(e.target.value)}
          style={{ minHeight: 400, fontFamily: "var(--font)", fontSize: 12, lineHeight: 1.6 }}
          spellCheck={false}
        />
      </div>

      {error && <div className="error-msg">{error}</div>}

      <div className="batch-controls">
        <button className="primary" onClick={handleSubmit} disabled={running}>
          {running ? "Generating..." : "Submit Batch"}
        </button>
        <button onClick={loadExample}>Load Example</button>
        <button
          onClick={() => {
            const pack = validate();
            if (pack) setProgress(`Valid: ${pack.icons.length} icons in "${pack.name}"`);
          }}
        >
          Validate
        </button>
      </div>

      {progress && <div className="batch-progress">{progress}</div>}
    </div>
  );
}
