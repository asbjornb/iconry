import { useState } from "react";
import { Explorer } from "./views/Explorer";
import { BatchEditor } from "./views/BatchEditor";
import { Review } from "./views/Review";
import { Settings } from "./components/Settings";
import type { GenerationJob } from "@shared/types";

type Tab = "explore" | "batch" | "review" | "settings";

export function App() {
  const [tab, setTab] = useState<Tab>("explore");
  const [jobs, setJobs] = useState<GenerationJob[]>([]);

  const addJobs = (newJobs: GenerationJob[]) => {
    setJobs((prev) => [...prev, ...newJobs]);
  };

  const updateJob = (id: string, updates: Partial<GenerationJob>) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...updates } : j)));
  };

  return (
    <div className="app">
      <div className="header">
        <h1>iconry</h1>
        <div className="tabs">
          {(["explore", "batch", "review", "settings"] as const).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>
      </div>

      {tab === "explore" && <Explorer onJobCreated={(j) => addJobs([j])} />}
      {tab === "batch" && <BatchEditor onJobsCreated={addJobs} />}
      {tab === "review" && <Review jobs={jobs} onUpdateJob={updateJob} />}
      {tab === "settings" && <Settings />}
    </div>
  );
}
