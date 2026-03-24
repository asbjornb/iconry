import { useEffect, useState } from "react";
import { checkHealth, testReplicate, setAuthToken, getAuthToken } from "../lib/api";

export function Settings() {
  const [token, setToken] = useState(getAuthToken());
  const [health, setHealth] = useState<{
    ok: boolean;
    replicate: boolean;
    r2: boolean;
    auth: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  const [replicateStatus, setReplicateStatus] = useState<{
    ok: boolean;
    username?: string;
    error?: string;
  } | null>(null);
  const [testingReplicate, setTestingReplicate] = useState(false);

  useEffect(() => {
    checkHealth()
      .then(setHealth)
      .catch((e) => setError((e as Error).message));
  }, []);

  function saveToken() {
    setAuthToken(token);
    setError("");
    // Re-check health with new token
    checkHealth()
      .then(setHealth)
      .catch((e) => setError((e as Error).message));
  }

  return (
    <div className="explorer">
      <div className="field">
        <label>Auth Token</label>
        <div className="prompt-row">
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Bearer token for worker auth"
          />
          <button className="primary" onClick={saveToken}>
            Save
          </button>
        </div>
      </div>

      {error && <div className="error-msg">{error}</div>}

      {health && (
        <div style={{ marginTop: 20 }}>
          <h3 style={{ fontSize: 14, marginBottom: 12 }}>Backend Status</h3>
          <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
            <div>
              API:{" "}
              <span className={`status-badge ${health.ok ? "completed" : "failed"}`}>
                {health.ok ? "connected" : "error"}
              </span>
            </div>
            <div>
              Auth:{" "}
              <span className={`status-badge ${health.auth ? "completed" : "failed"}`}>
                {health.auth ? "configured" : "not configured"}
              </span>
            </div>
            <div>
              R2 Storage:{" "}
              <span className={`status-badge ${health.r2 ? "completed" : "pending"}`}>
                {health.r2 ? "configured" : "not configured"}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>
                Replicate:{" "}
                <span className={`status-badge ${health.replicate ? "completed" : "pending"}`}>
                  {health.replicate ? "key set" : "no key"}
                </span>
              </span>
              {health.replicate && (
                <button
                  style={{ fontSize: 12, padding: "2px 8px" }}
                  disabled={testingReplicate}
                  onClick={async () => {
                    setTestingReplicate(true);
                    setReplicateStatus(null);
                    try {
                      const result = await testReplicate();
                      setReplicateStatus(result);
                    } catch (e) {
                      setReplicateStatus({ ok: false, error: (e as Error).message });
                    } finally {
                      setTestingReplicate(false);
                    }
                  }}
                >
                  {testingReplicate ? "testing..." : "Test Connection"}
                </button>
              )}
            </div>
            {replicateStatus && (
              <div style={{ marginLeft: 8 }}>
                {replicateStatus.ok ? (
                  <span className="status-badge completed">
                    valid (account: {replicateStatus.username})
                  </span>
                ) : (
                  <span className="status-badge failed">
                    invalid: {replicateStatus.error}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{ marginTop: 24, fontSize: 12, color: "var(--text-dim)" }}>
        <p>Set secrets in Cloudflare Dashboard → Pages → iconry → Settings → Environment Variables</p>
      </div>
    </div>
  );
}
