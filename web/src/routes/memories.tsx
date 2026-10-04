import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { AppSidebar, SidebarTrigger } from '../components/app-sidebar';

type MemoryRecord = {
  id: number;
  key: string;
  value: string;
  classification: string;
  tier: string;
  importance: number;
  createdAt: string;
  updatedAt: string;
};

type MemoryResponse = {
  memories: MemoryRecord[];
};

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3005';
const MEMORIES_URL = `${API_BASE.replace(/\/$/, '')}/memories`;
const PAGE_SIZE = 12;

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
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<Category>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(MEMORIES_URL);
      if (!response.ok) throw new Error(`Unable to load memories (${response.status})`);
      const data = (await response.json()) as MemoryResponse;
      setMemories(data.memories ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const summary = useMemo(() => ({
    total: memories.length,
    shortTerm: memories.filter((m) => m.tier === 'short_term').length,
    longTerm: memories.filter((m) => m.tier === 'long_term').length,
    lifelong: memories.filter((m) => m.tier === 'lifelong').length,
  }), [memories]);

  const categoryCounts = useMemo(() => {
    const base: Record<Category, number> = {
      all: memories.length,
      identity: 0,
      relationships: 0,
      behavior: 0,
      preferences: 0,
      corrections: 0,
      knowledge: 0,
      unclassified: 0,
    };
    for (const m of memories) {
      const k = m.classification as Category;
      if (k !== 'all' && k in base) base[k] += 1;
    }
    return base;
  }, [memories]);

  const filteredMemories = useMemo(() => {
    if (selectedCategory === 'all') return memories;
    return memories.filter((m) => m.classification === selectedCategory);
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
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

  const pageStart = filteredMemories.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const pageEnd = Math.min(currentPage * PAGE_SIZE, filteredMemories.length);

  const categoryTabs: Category[] = ['all', ...CATEGORY_ORDER];

  const startEdit = (memory: MemoryRecord) => {
    setEditingId(memory.id);
    setEditValue(memory.value);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValue('');
  };

  const saveEdit = async (memory: MemoryRecord) => {
    if (!editValue.trim() || editValue === memory.value) {
      cancelEdit();
      return;
    }
    setBusyId(memory.id);
    try {
      const res = await fetch(`${MEMORIES_URL}/${memory.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: editValue.trim() }),
      });
      if (!res.ok) throw new Error(`Update failed (${res.status})`);
      await load();
      cancelEdit();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const deleteMemory = async (memory: MemoryRecord) => {
    if (!confirm(`Delete memory "${memory.key}"?`)) return;
    setBusyId(memory.id);
    try {
      const res = await fetch(`${MEMORIES_URL}/${memory.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="app-shell">
      <AppSidebar />

      <div className="chat-container">
        <div className="chat-header">
          <div className="chat-header-left">
            <SidebarTrigger />
            <span className="chat-header-title">Memory Store</span>
          </div>
          <span className="chat-header-badge">{summary.total} total</span>
        </div>

        <main className="memories-page">
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

          <section className="memory-category-tabs" aria-label="Memory categories">
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
                  <span>{category === 'all' ? 'All' : categoryLabel(category)}</span>
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
              <div className="memories-pagination">
                <span className="memories-pagination-info">
                  Showing {pageStart}–{pageEnd} of {filteredMemories.length}
                </span>
                <div className="memories-pagination-btns">
                  <button
                    type="button"
                    className="memories-pagination-btn"
                    disabled={currentPage === 1}
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  >
                    Prev
                  </button>
                  <button
                    type="button"
                    className="memories-pagination-btn"
                    disabled={currentPage === totalPages}
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  >
                    Next
                  </button>
                </div>
              </div>

              <div className="memory-grid">
                {paginatedMemories.map((memory) => (
                  <article key={memory.id} className="memory-card">
                    <header className="memory-card-header">
                      <div className="memory-card-title-row">
                        <span className="memory-chip accent">{memory.key}</span>
                        <span className="memory-chip">{categoryLabel(memory.classification)}</span>
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
                    </header>

                    {editingId === memory.id ? (
                      <div className="memory-edit">
                        <textarea
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          rows={3}
                          className="memory-edit-textarea"
                        />
                        <div className="memory-edit-actions">
                          <button
                            type="button"
                            className="memories-pagination-btn"
                            disabled={busyId === memory.id}
                            onClick={() => saveEdit(memory)}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className="memories-pagination-btn"
                            onClick={cancelEdit}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="memory-content">{memory.value}</div>
                        <div className="memory-edit-actions">
                          <button
                            type="button"
                            className="memories-pagination-btn"
                            disabled={busyId === memory.id}
                            onClick={() => startEdit(memory)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="memories-pagination-btn"
                            disabled={busyId === memory.id}
                            onClick={() => deleteMemory(memory)}
                          >
                            Delete
                          </button>
                        </div>
                      </>
                    )}
                  </article>
                ))}
              </div>
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}
