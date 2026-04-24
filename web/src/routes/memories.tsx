import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';

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

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const MEMORIES_URL = `${API_BASE.replace(/\/$/, '')}/memories`;
const PAGE_SIZE = 8;

const CATEGORY_ORDER = [
  'identity',
  'relationships',
  'behavior',
  'preferences',
  'corrections',
  'knowledge',
  'unclassified',
] as const;

type Category = 'all' | (typeof CATEGORY_ORDER)[number];

export const Route = createFileRoute('/memories')({
  component: MemoriesRoute,
});

function safeDate(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function categoryLabel(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function tierColor(tier: string): string {
  switch (tier) {
    case 'short_term':
      return 'var(--fg-muted)';
    case 'long_term':
      return 'var(--accent)';
    case 'lifelong':
      return 'var(--green)';
    default:
      return 'var(--fg-muted)';
  }
}

function MemoriesRoute() {
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [cleanupRuns, setCleanupRuns] = useState<CleanupRun[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<Category>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedId, setExpandedId] = useState<number | null>(null);

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
      shortTerm: memories.filter((m) => m.tier === 'short_term').length,
      longTerm: memories.filter((m) => m.tier === 'long_term').length,
      lifelong: memories.filter((m) => m.tier === 'lifelong').length,
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
        if (key !== 'all') {
          base[key] += 1;
        }
      }
    }

    return base;
  }, [memories]);

  const filteredMemories = useMemo(() => {
    if (selectedCategory === 'all') {
      return memories;
    }

    return memories.filter(
      (memory) => memory.classification === selectedCategory,
    );
  }, [memories, selectedCategory]);

  const totalPages = Math.max(
    1,
    Math.ceil(filteredMemories.length / PAGE_SIZE),
  );

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

  const pageStart =
    filteredMemories.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const pageEnd = Math.min(currentPage * PAGE_SIZE, filteredMemories.length);

  const categoryTabs: Category[] = ['all', ...CATEGORY_ORDER];

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Navigation">
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <div className="sidebar-logo">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.46 2.5 2.5 0 0 1-1.773-4.38A2.5 2.5 0 0 1 4 12a2.5 2.5 0 0 1 .8-1.867 2.5 2.5 0 0 1 1.3-4.602A2.5 2.5 0 0 1 9.5 2Z" />
                <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.46 2.5 2.5 0 0 0 1.773-4.38 2.5 2.5 0 0 0 .267-3.673 2.5 2.5 0 0 0-1.3-4.602A2.5 2.5 0 0 0 14.5 2Z" />
              </svg>
            </div>
            Aira
          </div>
        </div>

        <div className="sidebar-section-label">Views</div>

        <Link to="/" className="sidebar-nav-item">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          Chat
        </Link>
        <Link to="/memories" className="sidebar-nav-item active">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
          </svg>
          Memories
        </Link>
        <Link to="/connections" className="sidebar-nav-item">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
          Connections
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

        <main className="memories-page">
          {/* Stats grid */}
          <div className="memories-top-grid">
            <div className="memories-stat-card">
              <div className="memories-stat-number">{summary.total}</div>
              <div className="memory-stat-label">Total</div>
            </div>
            <div className="memories-stat-card">
              <div className="memories-stat-number">{summary.shortTerm}</div>
              <div className="memory-stat-label">Short-term</div>
            </div>
            <div className="memories-stat-card">
              <div className="memories-stat-number">{summary.longTerm}</div>
              <div className="memory-stat-label">Long-term</div>
            </div>
            <div className="memories-stat-card">
              <div className="memories-stat-number">{summary.lifelong}</div>
              <div className="memory-stat-label">Lifelong</div>
            </div>
          </div>

          {/* Category tabs */}
          <section
            className="memory-category-tabs"
            aria-label="Memory categories"
          >
            {categoryTabs.map((category) => {
              const active = selectedCategory === category;
              const count = categoryCounts[category];

              return (
                <button
                  key={category}
                  type="button"
                  className={`memory-category-tab${active ? ' active' : ''}`}
                  onClick={() => setSelectedCategory(category)}
                >
                  <span>
                    {category === 'all' ? 'All' : categoryLabel(category)}
                  </span>
                  <span className="memory-category-count">{count}</span>
                </button>
              );
            })}
          </section>

          {isLoading ? (
            <div className="memories-empty">Loading memories...</div>
          ) : null}
          {error ? <div className="memories-error">{error}</div> : null}

          {!isLoading && !error && filteredMemories.length === 0 ? (
            <div className="memories-empty">No memories available.</div>
          ) : null}

          {!isLoading && !error && filteredMemories.length > 0 ? (
            <>
              <div className="memories-pagination">
                <span className="memories-pagination-info">
                  Showing {pageStart}–{pageEnd} of {filteredMemories.length}
                </span>
                <div className="memories-pagination-btns">
                  <button
                    type="button"
                    className="memories-pagination-btn"
                    disabled={currentPage === 1}
                    onClick={() =>
                      setCurrentPage((prev) => Math.max(1, prev - 1))
                    }
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    >
                      <path d="M15 18l-6-6 6-6" />
                    </svg>
                    Prev
                  </button>
                  <button
                    type="button"
                    className="memories-pagination-btn"
                    disabled={currentPage === totalPages}
                    onClick={() =>
                      setCurrentPage((prev) => Math.min(totalPages, prev + 1))
                    }
                  >
                    Next
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    >
                      <path d="M9 18l6-6-6-6" />
                    </svg>
                  </button>
                </div>
              </div>

              <div className="memory-grid">
                {paginatedMemories.map((memory) => (
                  <article
                    key={memory.id}
                    className="memory-card"
                    onClick={() =>
                      setExpandedId(expandedId === memory.id ? null : memory.id)
                    }
                  >
                    <header className="memory-card-header">
                      <div className="memory-card-title-row">
                        <span className="memory-chip accent">#{memory.id}</span>
                        <span className="memory-chip">
                          {categoryLabel(memory.classification)}
                        </span>
                        <span
                          className="memory-chip"
                          style={{
                            borderColor: tierColor(memory.tier),
                            color: tierColor(memory.tier),
                          }}
                        >
                          {memory.tier.replace(/_/g, ' ')}
                        </span>
                      </div>
                      <div className="memory-card-meta">
                        <span className="memory-chip">
                          ★ {memory.importance.toFixed(2)}
                        </span>
                        <span className="memory-chip">
                          ↻ {memory.accessCount}
                        </span>
                      </div>
                    </header>

                    <div className="memory-content">{memory.content}</div>

                    {expandedId === memory.id && (
                      <div className="memory-expanded">
                        <div className="memory-details-grid">
                          <div className="memory-detail">
                            <span className="memory-detail-label">Created</span>
                            <span className="memory-detail-value">
                              {safeDate(memory.createdAt)}
                            </span>
                          </div>
                          <div className="memory-detail">
                            <span className="memory-detail-label">
                              Last Accessed
                            </span>
                            <span className="memory-detail-value">
                              {safeDate(memory.lastAccessedAt)}
                            </span>
                          </div>
                          <div className="memory-detail">
                            <span className="memory-detail-label">Expires</span>
                            <span className="memory-detail-value">
                              {safeDate(memory.expiresAt)}
                            </span>
                          </div>
                          <div className="memory-detail">
                            <span className="memory-detail-label">
                              Promoted
                            </span>
                            <span className="memory-detail-value">
                              {safeDate(memory.promotedAt)}
                            </span>
                          </div>
                          <div className="memory-detail">
                            <span className="memory-detail-label">Updated</span>
                            <span className="memory-detail-value">
                              {safeDate(memory.updatedAt)}
                            </span>
                          </div>
                        </div>

                        {memory.metadata &&
                        Object.keys(memory.metadata as Record<string, unknown>)
                          .length > 0 ? (
                          <div className="memory-section">
                            <h3>Metadata</h3>
                            <pre className="memory-pre">
                              {pretty(memory.metadata)}
                            </pre>
                          </div>
                        ) : null}

                        {memory.debateHistory &&
                        (Array.isArray(memory.debateHistory)
                          ? (memory.debateHistory as unknown[]).length > 0
                          : true) ? (
                          <div className="memory-section">
                            <h3>Debate History</h3>
                            <pre className="memory-pre">
                              {pretty(memory.debateHistory)}
                            </pre>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </>
          ) : null}

          {/* Cleanup section */}
          {cleanupRuns.length > 0 && (
            <section className="memory-cleanup-section">
              <h2 className="memory-section-title">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                </svg>
                Memory Cleanup Log
              </h2>
              <div className="cleanup-table-wrap">
                <table className="cleanup-table">
                  <thead>
                    <tr>
                      <th>Last Clean Up</th>
                      <th>Reviewed</th>
                      <th>Merged</th>
                      <th>Deleted</th>
                      <th>Promoted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cleanupRuns.map((run) => (
                      <tr key={run.id}>
                        <td>{safeDate(run.ranAt)}</td>
                        <td>{run.reviewedRows}</td>
                        <td>{run.mergedRows}</td>
                        <td>{run.deletedRows}</td>
                        <td>{run.promotedRows}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
