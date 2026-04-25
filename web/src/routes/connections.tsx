import { createRoute, Link } from '@tanstack/react-router';
import React, { useEffect, useState } from 'react';
import { FaCalendarDays, FaGithub, FaSpotify, FaXTwitter } from 'react-icons/fa6';
import { FiCheck, FiFileText, FiFilm, FiMail, FiPlus, FiShare2, FiX } from 'react-icons/fi';
import { SiClickup, SiNotion, SiTodoist } from 'react-icons/si';
import { Route as RootRoute } from './__root';

/* ─── Route ──────────────────────────────────────────────────────────────── */
export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/connections',
  component: ConnectionsPage,
});

/* ─── Types ──────────────────────────────────────────────────────────────── */
type Connection = {
  id: number;
  name: string;
  label: string;
  enabled: boolean;
  oauthConnected: boolean;
  oauthSupported: boolean;
  oauthConfigured: boolean;
  createdAt: string;
  updatedAt: string;
};

type ConnectionsResponse = { connections: Connection[] };

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const CONNECTIONS_URL = `${API_BASE.replace(/\/$/, '')}/connections`;

/* ─── Connection metadata ────────────────────────────────────────────────── */
type ConnMeta = {
  description: string;
  category: 'productivity' | 'communication' | 'entertainment' | 'development';
  icon: React.ComponentType<{ size?: number; className?: string }>;
  iconStyle: React.CSSProperties;
};

const META: Record<string, ConnMeta> = {
  github: {
    description: 'Pull requests, issues, pushes, and code activity',
    category: 'development',
    iconStyle: {
      background: '#f6f8fa',
      color: '#24292f',
      borderColor: '#d0d7de',
    },
    icon: FaGithub,
  },
  gmail: {
    description: 'Read, search, send, and manage emails',
    category: 'communication',
    iconStyle: {
      background: '#fef2f2',
      color: '#dc2626',
      borderColor: '#fca5a5',
    },
    icon: FiMail,
  },
  google_calendar: {
    description: 'Events, scheduling, and meeting management',
    category: 'productivity',
    iconStyle: {
      background: '#eff6ff',
      color: '#2563eb',
      borderColor: '#93c5fd',
    },
    icon: FaCalendarDays,
  },
  notion: {
    description: 'Pages, databases, notes, and workspace',
    category: 'productivity',
    iconStyle: {
      background: '#f5f5f4',
      color: '#374151',
      borderColor: '#d1d5db',
    },
    icon: SiNotion,
  },
  anilist: {
    description: 'Anime & manga tracking and recommendations',
    category: 'entertainment',
    iconStyle: {
      background: '#eef2ff',
      color: '#4338ca',
      borderColor: '#a5b4fc',
    },
    icon: FiFilm,
  },
  google_docs: {
    description: 'Create, read, and edit Google Documents',
    category: 'productivity',
    iconStyle: {
      background: '#f0fdf4',
      color: '#16a34a',
      borderColor: '#86efac',
    },
    icon: FiFileText,
  },
  knowledge_graph: {
    description: 'Entity relationships and knowledge graph context',
    category: 'productivity',
    iconStyle: {
      background: '#fff7ed',
      color: '#a86828',
      borderColor: 'rgba(168,104,40,0.3)',
    },
    icon: FiShare2,
  },
  spotify: {
    description: 'Music playback, playlists, and listening history',
    category: 'entertainment',
    iconStyle: {
      background: '#f0fdf4',
      color: '#16a34a',
      borderColor: '#86efac',
    },
    icon: FaSpotify,
  },
  clickup: {
    description: 'Tasks, projects, and team collaboration',
    category: 'productivity',
    iconStyle: {
      background: '#faf5ff',
      color: '#7c3aed',
      borderColor: '#c4b5fd',
    },
    icon: SiClickup,
  },
  todoist: {
    description: 'Personal tasks and to-do lists',
    category: 'productivity',
    iconStyle: {
      background: '#fef2f2',
      color: '#dc2626',
      borderColor: '#fca5a5',
    },
    icon: SiTodoist,
  },
  twitter: {
    description: 'Posts, mentions, and social media activity',
    category: 'communication',
    iconStyle: {
      background: '#f0f9ff',
      color: '#0284c7',
      borderColor: '#7dd3fc',
    },
    icon: FaXTwitter,
  },
};

const CATEGORY_LABELS: Record<string, string> = {
  productivity: 'Productivity',
  communication: 'Communication',
  development: 'Development',
  entertainment: 'Entertainment',
};

const CATEGORY_ORDER = [
  'development',
  'communication',
  'productivity',
  'entertainment',
];

/* ─── Toggle ─────────────────────────────────────────────────────────────── */
function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="conn-toggle"
      data-checked={checked || undefined}
    >
      <span className="conn-toggle-thumb" />
    </button>
  );
}

/* ─── Connection card ────────────────────────────────────────────────────── */
function ConnectionCard({
  conn,
  onToggle,
  onDisconnect,
}: {
  conn: Connection;
  onToggle: (id: number, enabled: boolean) => void;
  onDisconnect: (name: string) => Promise<void>;
}) {
  const meta = META[conn.name];
  const [loading, setLoading] = useState(false);

  const handleToggle = (val: boolean) => {
    setLoading(true);
    onToggle(conn.id, val);
    setLoading(false);
  };

  const handleDisconnect = async () => {
    setLoading(true);
    await onDisconnect(conn.name);
    setLoading(false);
  };

  return (
    <div
      className="conn-card"
      data-dimmed={(!conn.enabled && !conn.oauthConnected) || undefined}
    >
      {/* Top row: icon + status */}
      <div className="conn-card-top">
        <div
          className="conn-card-icon"
          style={
            meta?.iconStyle ?? {
              background: 'var(--surface-2)',
              color: 'var(--fg-dim)',
              borderColor: 'var(--border)',
            }
          }
        >
          {meta?.icon ? <meta.icon size={18} /> : <FiShare2 size={18} />}
        </div>

        {conn.oauthConnected ? (
          <span className="conn-badge-connected">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              width="9"
              height="9"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
            Connected
          </span>
        ) : (
          <span
            className="conn-status-dot"
            data-active={conn.enabled || undefined}
          />
        )}
      </div>

      {/* Body: name + description */}
      <div className="conn-card-body">
        <div className="conn-card-name">{conn.label}</div>
        {meta?.description && (
          <div className="conn-card-desc">{meta.description}</div>
        )}
      </div>

      {/* Actions */}
      <div className="conn-card-actions">
        {conn.oauthSupported ? (
          conn.oauthConnected ? (
            <button
              type="button"
              disabled={loading}
              onClick={() => {
                void handleDisconnect();
              }}
              className="conn-btn-disconnect"
            >
              Disconnect
            </button>
          ) : conn.oauthConfigured ? (
            <a
              href={`${API_BASE.replace(/\/$/, '')}/connections/${conn.name}/oauth/start`}
              className="conn-btn-connect"
            >
              Connect
            </a>
          ) : (
            <span className="conn-env-label">env not set</span>
          )
        ) : (
          <>
            <span className="conn-active-label">
              {conn.enabled ? 'Active' : 'Off'}
            </span>
            <Toggle
              checked={conn.enabled}
              onChange={(v) => {
                void handleToggle(v);
              }}
              disabled={loading}
            />
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Add connection modal ───────────────────────────────────────────────── */
function AddConnectionModal({
  existing,
  onAdd,
  onClose,
}: {
  existing: Set<string>;
  onAdd: (name: string, label: string) => void;
  onClose: () => void;
}) {
  const available = Object.entries(META).filter(
    ([name]) => !existing.has(name),
  );

  return (
    <div className="conn-modal-overlay" onClick={onClose}>
      <div className="conn-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="conn-modal-header">
          <span className="conn-modal-title">Add Connection</span>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="conn-modal-close"
          >
            <FiX size={13} />
          </button>
        </div>

        {/* List */}
        {available.length === 0 ? (
          <div className="conn-modal-empty">All connections already added</div>
        ) : (
          <ul className="conn-modal-list">
            {available.map(([name, meta]) => (
              <li key={name}>
                <button
                  type="button"
                  className="conn-modal-item"
                  onClick={() => {
                    onAdd(
                      name,
                      name
                        .replace(/_/g, ' ')
                        .replace(/\b\w/g, (c) => c.toUpperCase()),
                    );
                    onClose();
                  }}
                >
                  <span className="conn-modal-item-icon" style={meta.iconStyle}>
                    <meta.icon size={18} />
                  </span>
                  <div className="conn-modal-item-info">
                    <span className="conn-modal-item-name">
                      {name
                        .replace(/_/g, ' ')
                        .replace(/\b\w/g, (c) => c.toUpperCase())}
                    </span>
                    <span className="conn-modal-item-cat">
                      {CATEGORY_LABELS[meta.category]}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ─── Main page ──────────────────────────────────────────────────────────── */
function ConnectionsPage() {
  const [connList, setConnList] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [activeCategory, setActiveCategory] = useState<string>('all');

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(CONNECTIONS_URL);
      if (!res.ok)
        throw new Error(`Failed to load connections (${res.status})`);
      const data = (await res.json()) as ConnectionsResponse;
      setConnList(data.connections);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('oauth_connected');
    const oauthError = params.get('oauth_error');
    if (connected) {
      setNotice(`Successfully connected ${connected.replace(/_/g, ' ')}`);
      window.history.replaceState({}, '', window.location.pathname);
    } else if (oauthError) {
      setError(`OAuth error: ${oauthError}`);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const handleToggle = async (id: number, enabled: boolean) => {
    try {
      const res = await fetch(`${CONNECTIONS_URL}/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok)
        throw new Error(`Failed to update connection (${res.status})`);
      setConnList((prev) =>
        prev.map((c) => (c.id === id ? { ...c, enabled } : c)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDisconnect = async (name: string) => {
    try {
      const res = await fetch(`${CONNECTIONS_URL}/${name}/oauth`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`Failed to disconnect (${res.status})`);
      setConnList((prev) =>
        prev.map((c) =>
          c.name === name
            ? {
                ...c,
                oauthConnected: false,
              }
            : c,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAdd = async (name: string, label: string) => {
    try {
      const res = await fetch(CONNECTIONS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, label }),
      });
      if (!res.ok) throw new Error(`Failed to add connection (${res.status})`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const existingNames = new Set(connList.map((c) => c.name));

  const filtered =
    activeCategory === 'all'
      ? connList
      : connList.filter((c) => META[c.name]?.category === activeCategory);

  const connectedCount = connList.filter((c) => c.oauthConnected).length;

  return (
    <div className="app-shell">
      {/* ── Sidebar (shared layout) ──────────────────────────────────────── */}
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
        <Link to="/memories" className="sidebar-nav-item">
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
        <Link to="/connections" className="sidebar-nav-item active">
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

      {/* ── Main content ─────────────────────────────────────────────────── */}
      <div className="chat-container">
        <div className="chat-header">
          <span className="chat-header-title">Connections</span>
          <div className="conn-header-actions">
            {!loading && (
              <span className="chat-header-badge">
                <span
                  className={`chat-header-dot${connectedCount > 0 ? '' : ' idle'}`}
                />
                {connectedCount} connected
              </span>
            )}
            <button
              type="button"
              onClick={() => setShowModal(true)}
              className="conn-add-btn"
            >
              <FiPlus size={13} />
              Add Connection
            </button>
          </div>
        </div>

        <main className="connections-page">
          {/* Notice */}
          {notice && (
            <div className="conn-notice">
              <FiCheck size={13} />
              {notice}
              <button
                type="button"
                onClick={() => setNotice(null)}
                className="conn-notice-close"
              >
                <FiX size={12} />
              </button>
            </div>
          )}

          {/* Error */}
          {error && <div className="memories-error">{error}</div>}

          {/* Category tabs */}
          <section
            className="memory-category-tabs"
            aria-label="Connection categories"
          >
            {[
              {
                key: 'all',
                label: 'All',
              },
              ...CATEGORY_ORDER.map((k) => ({
                key: k,
                label: CATEGORY_LABELS[k] ?? k,
              })),
            ].map(({ key, label }) => {
              const count =
                key === 'all'
                  ? connList.length
                  : connList.filter((c) => META[c.name]?.category === key)
                      .length;
              if (key !== 'all' && count === 0) return null;
              const isActive = activeCategory === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setActiveCategory(key)}
                  className={`memory-category-tab${isActive ? ' active' : ''}`}
                >
                  <span>{label}</span>
                  <span className="memory-category-count">{count}</span>
                </button>
              );
            })}
          </section>

          {/* Grid */}
          {loading ? (
            <div className="memories-empty">Loading connections…</div>
          ) : connList.length === 0 ? (
            <div className="memories-empty">No connections configured yet.</div>
          ) : (
            <div className="conn-grid">
              {filtered.map((conn) => (
                <ConnectionCard
                  key={conn.id}
                  conn={conn}
                  onToggle={(id, enabled) => {
                    void handleToggle(id, enabled);
                  }}
                  onDisconnect={handleDisconnect}
                />
              ))}
            </div>
          )}
        </main>
      </div>

      {/* Modal */}
      {showModal && (
        <AddConnectionModal
          existing={existingNames}
          onAdd={(name, label) => {
            void handleAdd(name, label);
          }}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}
