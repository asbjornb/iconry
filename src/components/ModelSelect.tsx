import { useState } from "react";

export interface ModelPreset {
  id: string;
  label: string;
  description: string;
  /** Approximate cost per image in USD */
  cost?: string;
  /** Tags for filtering/grouping */
  tags: string[];
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "black-forest-labs/flux-schnell",
    label: "Flux Schnell",
    description: "Fast & cheap. Good baseline for iteration.",
    cost: "~$0.003",
    tags: ["fast", "raster"],
  },
  {
    id: "black-forest-labs/flux-1.1-pro",
    label: "Flux 1.1 Pro",
    description: "Higher quality Flux. Better prompt adherence.",
    cost: "~$0.04",
    tags: ["quality", "raster"],
  },
  {
    id: "black-forest-labs/flux-dev",
    label: "Flux Dev",
    description: "Dev variant. Good quality, slower than Schnell.",
    cost: "~$0.025",
    tags: ["quality", "raster"],
  },
  {
    id: "recraft-ai/recraft-v3-svg",
    label: "Recraft V3 SVG",
    description: "Generates vector SVG icons. Great for clean, scalable icons.",
    cost: "~$0.04",
    tags: ["svg", "vector", "icons"],
  },
  {
    id: "recraft-ai/recraft-v3",
    label: "Recraft V3",
    description: "Strong at illustrations, icons, and design assets.",
    cost: "~$0.04",
    tags: ["quality", "raster", "icons"],
  },
  {
    id: "stability-ai/stable-diffusion-3.5-large",
    label: "SD 3.5 Large",
    description: "Stable Diffusion 3.5. Good general-purpose model.",
    cost: "~$0.035",
    tags: ["quality", "raster"],
  },
  {
    id: "ideogram-ai/ideogram-v2",
    label: "Ideogram V2",
    description: "Strong at text rendering and structured compositions.",
    cost: "~$0.04",
    tags: ["quality", "raster", "text"],
  },
  {
    id: "google-deepmind/imagen-4-preview",
    label: "Imagen 4 Preview",
    description: "Google's latest. Excellent prompt understanding.",
    cost: "~$0.04",
    tags: ["quality", "raster"],
  },
];

interface Props {
  value: string;
  onChange: (model: string) => void;
}

export function ModelSelect({ value, onChange }: Props) {
  const [showCustom, setShowCustom] = useState(
    () => !MODEL_PRESETS.some((p) => p.id === value)
  );
  const [customValue, setCustomValue] = useState(
    () => (MODEL_PRESETS.some((p) => p.id === value) ? "" : value)
  );

  const currentPreset = MODEL_PRESETS.find((p) => p.id === value);

  function handleSelect(e: React.ChangeEvent<HTMLSelectElement>) {
    const v = e.target.value;
    if (v === "__custom__") {
      setShowCustom(true);
      if (customValue) onChange(customValue);
    } else {
      setShowCustom(false);
      onChange(v);
    }
  }

  function handleCustomChange(e: React.ChangeEvent<HTMLInputElement>) {
    setCustomValue(e.target.value);
    onChange(e.target.value);
  }

  return (
    <div className="model-select">
      <select
        value={showCustom ? "__custom__" : value}
        onChange={handleSelect}
      >
        {MODEL_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label} {p.cost ? `(${p.cost})` : ""}
          </option>
        ))}
        <option value="__custom__">Custom model...</option>
      </select>
      {showCustom && (
        <input
          className="model-custom-input"
          value={customValue}
          onChange={handleCustomChange}
          placeholder="owner/model-name"
        />
      )}
      {currentPreset && (
        <div className="model-description">
          {currentPreset.description}
          {currentPreset.tags.length > 0 && (
            <span className="model-tags">
              {currentPreset.tags.map((t) => (
                <span key={t} className="model-tag">{t}</span>
              ))}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
