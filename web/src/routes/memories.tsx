import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

type MemoryRecord = {
  id: number;
  content: string;
  classification: string;
  tier: string;
  importance: number;
  accessCount: number;
  createdAt: string;
  lastAccessedAt: string;
  expiresAt: string | null;
  promotedAt: string | null;
  debateHistory: unknown;
  metadata: unknown;
  updatedAt: string;
};

type CleanupRun = {
  id: number;
  ranAt: string;
  reviewedRows: number;
  mergedRows: number;
  deletedRows: number;
  promotedRows: number;
};

type MemoryResponse = {
  memories: MemoryRecord[];
  cleanupRuns: CleanupRun[];
};

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";
const MEMORIES_URL = `${API_BASE.replace(/\/$/, "")}/memories`;
const PAGE_SIZE = 8;

const CATEGORY_ORDER = [
  "identity",
  "relationships",
  "behavior",
  "preferences",
  "corrections",
  "knowledge",
  "unclassified",
] as const;

type Category = "all" | (typeof CATEGORY_ORDER)[number];

export const Route = createFileRoute("/memories")({
  component: MemoriesRoute,
});

function safeDate(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function categoryLabel(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function MemoriesRoute() {
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [cleanupRuns, setCleanupRuns] = useState<CleanupRun[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<Category>("all");
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    let active = true;

    const load = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch(MEMORIES_URL);
        if (!response.ok) {
          throw new Error(`Unable to load memories (${response.status})`);
        }

        const data = (await response.json()) as MemoryResponse;
        if (active) {
          setMemories(data.memories ?? []);
          setCleanupRuns(data.cleanupRuns ?? []);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    };

    void load();

    return () => {
      active = false;
    };
  }, []);

  const summary = useMemo(() => {
    return {
      total: memories.length,
      shortTerm: memories.filter((m) => m.tier === "short_term").length,
      longTerm: memories.filter((m) => m.tier === "long_term").length,
      lifelong: memories.filter((m) => m.tier === "lifelong").length,
    };
  }, [memories]);

  const categoryCounts = useMemo(() => {
    const base = {
      all: memories.length,
      identity: 0,
      relationships: 0,
      behavior: 0,
      preferences: 0,
      corrections: 0,
      knowledge: 0,
      unclassified: 0,
    };

    for (const memory of memories) {
      if (memory.classification in base) {
        const key = memory.classification as keyof typeof base;
        if (key !== "all") {
          base[key] += 1;
        }
      }
    }

    return base;
  }, [memories]);

  const filteredMemories = useMemo(() => {
    if (selectedCategory === "all") {
      return memories;
    }

    return memories.filter((memory) => memory.classification === selectedCategory);
  }, [memories, selectedCategory]);

  const totalPages = Math.max(1, Math.ceil(filteredMemories.length / PAGE_SIZE));

  const paginatedMemories = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredMemories.slice(start, start + PAGE_SIZE);
  }, [filteredMemories, currentPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [selectedCategory]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const pageStart = filteredMemories.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const pageEnd = Math.min(currentPage * PAGE_SIZE, filteredMemories.length);

  const categoryTabs: Category[] = ["all", ...CATEGORY_ORDER];

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Navigation">
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <div className="sidebar-logo">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.46 2.5 2.5 0 0 1-1.773-4.38A2.5 2.5 0 0 1 4 12a2.5 2.5 0 0 1 .8-1.867 2.5 2.5 0 0 1 1.3-4.602A2.5 2.5 0 0 1 9.5 2Z"/>
                <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.46 2.5 2.5 0 0 0 1.773-4.38 2.5 2.5 0 0 0 .267-3.673 2.5 2.5 0 0 0-1.3-4.602A2.5 2.5 0 0 0 14.5 2Z"/>
              </svg>
            </div>
            Aira
          </div>
        </div>

        <div className="sidebar-section-label">Navigation</div>

        <Link to="/" className="sidebar-nav-item">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          Chat
        </Link>
        <Link to="/memories" className="sidebar-nav-item active">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
          </svg>
          Memories
        </Link>

        <div className="sidebar-spacer" />

        <div className="sidebar-footer">
          <button type="button" className="sidebar-user">
            <div className="sidebar-avatar">EA</div>
            <div className="sidebar-user-info">
              <span className="sidebar-user-name">Eromosele</span>
              <span className="sidebar-user-plan">Personal</span>
            </div>
          </button>
        </div>
      </aside>

      <div className="chat-container">
        <div className="chat-header">
          <span className="chat-header-title">Memory Store</span>
          <span className="chat-header-badge">{summary.total} total</span>
        </div>

        <main className="messages-area memories-page">
          <section className="memories-count-section">
            <div className="memories-count-title">Memory Count</div>
            <div className="memories-count-total">{summary.total}</div>
          </section>

          <div className="memories-top-grid">
            <div className="memory-stat-card">
              <div className="memory-stat-label">Short-term</div>
              <div className="memory-stat-value">{summary.shortTerm}</div>
            </div>
            <div className="memory-stat-card">
              <div className="memory-stat-label">Long-term</div>
              <div className="memory-stat-value">{summary.longTerm}</div>
            </div>
            <div className="memory-stat-card">
              <div className="memory-stat-label">Lifelong</div>
              <div className="memory-stat-value">{summary.lifelong}</div>
            </div>
          </div>

          <section className="memory-category-tabs" aria-label="Memory categories">
            {categoryTabs.map((category) => {
              const active = selectedCategory === category;
              const count = categoryCounts[category];

              return (
                <button
                  key={category}
                  type="button"
                  className={`memory-category-tab${active ? " active" : ""}`}
                  onClick={() => setSelectedCategory(category)}
                >
                  <span>{category === "all" ? "All" : categoryLabel(category)}</span>
                  <span className="memory-category-count">{count}</span>
                </button>
              );
            })}
          </section>

          {isLoading ? <div className="memories-empty">Loading memories...</div> : null}
          {error ? <div className="memories-error">{error}</div> : null}

          {!isLoading && !error && filteredMemories.length === 0 ? (
            <div className="memories-empty">No memories available.</div>
          ) : null}

          {!isLoading && !error && filteredMemories.length > 0 ? (
            <>
              <div className="memories-page-meta">
                Showing {pageStart}-{pageEnd} of {filteredMemories.length}
              </div>

              <div className="memories-list">
                {paginatedMemories.map((memory) => (
                <article key={memory.id} className="memory-card">
                  <header className="memory-card-header">
                    <div className="memory-card-title-row">
                      <span className="memory-id">#{memory.id}</span>
                      <span className="memory-chip">{memory.classification}</span>
                      <span className="memory-chip">{memory.tier}</span>
                      <span className="memory-chip">
                        importance {memory.importance.toFixed(2)}
                      </span>
                    </div>
                    <div className="memory-access">access_count {memory.accessCount}</div>
                  </header>

                  <section className="memory-section">
                    <h3>Content</h3>
                    <p className="memory-content">{memory.content}</p>
                  </section>

                  <section className="memory-section memory-grid">
                    <div>
                      <strong>Created:</strong> {safeDate(memory.createdAt)}
                    </div>
                    <div>
                      <strong>Last Accessed:</strong> {safeDate(memory.lastAccessedAt)}
                    </div>
                    <div>
                      <strong>Expires:</strong> {safeDate(memory.expiresAt)}
                    </div>
                    <div>
                      <strong>Promoted:</strong> {safeDate(memory.promotedAt)}
                    </div>
                    <div>
                      <strong>Updated:</strong> {safeDate(memory.updatedAt)}
                    </div>
                  </section>

                  <section className="memory-section">
                    <h3>Metadata</h3>
                    <pre>{pretty(memory.metadata)}</pre>
                  </section>

                  <section className="memory-section">
                    <h3>Debate History</h3>
                    <pre>{pretty(memory.debateHistory)}</pre>
                  </section>
                </article>
                ))}
              </div>

              <div className="memories-pagination">
                <button
                  type="button"
                  className="memory-pagination-btn"
                  disabled={currentPage === 1}
                  onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                >
                  Previous
                </button>
                <span className="memories-pagination-state">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  type="button"
                  className="memory-pagination-btn"
                  disabled={currentPage === totalPages}
                  onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
                >
                  Next
                </button>
              </div>
            </>
          ) : null}

          <section className="memory-cleanup-section">
            <h2 className="memory-cleanup-title">Memory Cleanup</h2>

            {cleanupRuns.length === 0 ? (
              <div className="memories-empty">No cleanup runs recorded yet.</div>
            ) : (
              <div className="memory-cleanup-table-wrap">
                <table className="memory-cleanup-table">
                  <thead>
                    <tr>
                      <th>Last Clean Up Time</th>
                      <th>Rows Merged</th>
                      <th>Rows Deleted</th>
                      <th>Rows Promoted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cleanupRuns.map((run) => (
                      <tr key={run.id}>
                        <td>{safeDate(run.ranAt)}</td>
                        <td>{run.mergedRows}</td>
                        <td>{run.deletedRows}</td>
                        <td>{run.promotedRows}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
