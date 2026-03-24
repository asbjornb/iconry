import { useState, useEffect } from "react";
import { Explorer } from "./views/Explorer";
import { BatchEditor } from "./views/BatchEditor";
import { Projects } from "./views/Projects";
import { Review } from "./views/Review";
import { Settings } from "./components/Settings";
import { listJobs } from "./lib/api";
import type { GenerationJob } from "@shared/types";

type Tab = "explore" | "projects" | "batch" | "review" | "settings";
const TABS: Tab[] = ["explore", "projects", "batch", "review", "settings"];

function getTabFromHash(): Tab {
  const hash = window.location.hash.slice(1);
  return TABS.includes(hash as Tab) ? (hash as Tab) : "explore";
}

export function App() {
  const [tab, setTab] = useState<Tab>(getTabFromHash);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [explorePrompt, setExplorePrompt] = useState<string | null>(null);

  const sendToExplore = (prompt: string) => {
    setExplorePrompt(prompt);
    setTab("explore");
  };

  // Sync tab ↔ URL hash
  useEffect(() => {
    window.location.hash = tab;
  }, [tab]);

  useEffect(() => {
    const onHashChange = () => setTab(getTabFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    listJobs()
      .then((stored) => setJobs((prev) => {
        // Merge: keep existing in-progress jobs, add stored ones not already present
        const existingIds = new Set(prev.map((j) => j.id));
        const newOnes = stored.filter((j) => !existingIds.has(j.id));
        return [...prev, ...newOnes];
      }))
      .catch(() => {}); // auth not set yet, ignore
  }, []);

  const addJobs = (newJobs: GenerationJob[]) => {
    setJobs((prev) => [...prev, ...newJobs]);
  };

  const updateJob = (id: string, updates: Partial<GenerationJob>) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...updates } : j)));
  };

  const deleteJob = (id: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== id));
  };

  return (
    <div className="app">
      <div className="header">
        <h1>iconry</h1>
        <div className="tabs">
          {TABS.map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>
      </div>

      {tab === "explore" && <Explorer onJobCreated={(j) => addJobs([j])} initialPrompt={explorePrompt} onPromptConsumed={() => setExplorePrompt(null)} />}
      {tab === "projects" && <Projects onSendToExplore={sendToExplore} />}
      {tab === "batch" && <BatchEditor onJobsCreated={addJobs} />}
      {tab === "review" && <Review jobs={jobs} onUpdateJob={updateJob} onDeleteJob={deleteJob} />}
      {tab === "settings" && <Settings />}
    </div>
  );
}
