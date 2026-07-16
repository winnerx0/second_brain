import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AppSidebar, SidebarTrigger } from '../components/app-sidebar';
import {
  apiUrl,
  classificationColor,
  categoryLabel,
} from '../lib/memory-utils';

type GraphNode = {
  id: number;
  kind: string;
  name: string;
  key: string | null;
  value: string | null;
  classification: string | null;
  tier: string | null;
  importance: number;
  status: string;
  recallCount: number;
  source: string | null;
  confidence: number;
};

type GraphEdge = {
  id: number;
  fromNodeId: number;
  toNodeId: number;
  relation: string;
  weight: number;
  confidence: number;
  createdBy: string;
};

type GraphResponse = { nodes: GraphNode[]; edges: GraphEdge[] };

export const Route = createFileRoute('/graph')({
  component: GraphRoute,
});

// Entity kinds (non-memory) get a steady palette distinct from memory classifications.
const KIND_COLORS: Record<string, string> = {
  person: '#c97e54',
  project: '#6b8caf',
  document: '#7a9e7e',
  task: '#c8a96a',
  decision: '#b85c5c',
  topic: '#a86828',
  episode: '#9b6baf',
  other: '#8a8175',
};

function nodeColor(n: GraphNode): string {
  if (n.kind === 'memory') return classificationColor(n.classification ?? 'unclassified');
  return KIND_COLORS[n.kind] ?? '#8a8175';
}

function nodeLabel(n: GraphNode): string {
  if (n.kind === 'memory') return n.key ?? n.name;
  return n.name;
}

// Deterministic radial layout: more important nodes sit closer to the centre.
function layout(nodes: GraphNode[]): Record<number, { x: number; y: number }> {
  const positions: Record<number, { x: number; y: number }> = {};
  const count = Math.max(nodes.length, 1);
  nodes.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / count;
    const radius = 180 + (1 - Math.min(Math.max(n.importance, 0), 1)) * 360;
    positions[n.id] = {
      x: 600 + radius * Math.cos(angle),
      y: 450 + radius * Math.sin(angle),
    };
  });
  return positions;
}

function nodeSize(importance: number): number {
  return 26 + Math.min(Math.max(importance, 0), 1) * 40;
}

const KIND_FILTERS = ['memory', 'episode', 'person', 'project', 'document', 'task', 'decision', 'topic', 'other'];

function GraphRoute() {
  const [data, setData] = useState<GraphResponse>({ nodes: [], edges: [] });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [showSuperseded, setShowSuperseded] = useState(false);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [maintenanceMsg, setMaintenanceMsg] = useState<string | null>(null);
  const [isMaintaining, setIsMaintaining] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [isEditing, setIsEditing] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/graph?status=${showSuperseded ? 'all' : 'active'}`));
      if (!res.ok) throw new Error(`Unable to load graph (${res.status})`);
      setData((await res.json()) as GraphResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [showSuperseded]);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleNodes = useMemo(
    () => (kindFilter ? data.nodes.filter((n) => n.kind === kindFilter) : data.nodes),
    [data.nodes, kindFilter],
  );

  const flowNodes: Node[] = useMemo(() => {
    const positions = layout(visibleNodes);
    return visibleNodes.map((n) => {
      const size = nodeSize(n.importance);
      const superseded = n.status === 'superseded';
      return {
        id: String(n.id),
        position: positions[n.id] ?? { x: 0, y: 0 },
        data: { label: nodeLabel(n) },
        style: {
          background: nodeColor(n),
          color: '#fff',
          border: selected?.id === n.id ? '2px solid #fff' : '1px solid rgba(0,0,0,0.2)',
          borderRadius: n.kind === 'memory' ? '8px' : '50%',
          width: size,
          height: size,
          fontSize: 9,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center' as const,
          padding: 2,
          opacity: superseded ? 0.35 : 1,
          overflow: 'hidden',
        },
      };
    });
  }, [visibleNodes, selected]);

  const flowEdges: Edge[] = useMemo(() => {
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    return data.edges
      .filter((e) => visibleIds.has(e.fromNodeId) && visibleIds.has(e.toNodeId))
      .map((e) => ({
        id: String(e.id),
        source: String(e.fromNodeId),
        target: String(e.toNodeId),
        label: e.relation,
        animated: e.createdBy === 'inference',
        style: { stroke: e.createdBy === 'inference' ? '#6b8caf' : 'var(--fg-muted, #888)' },
        labelStyle: { fontSize: 8, fill: 'var(--fg-muted, #888)' },
      }));
  }, [data.edges, visibleNodes]);

  const nodeById = useMemo(
    () => new Map(data.nodes.map((n) => [n.id, n])),
    [data.nodes],
  );

  const selectedEdges = useMemo(() => {
    if (!selected) return [];
    return data.edges
      .filter((e) => e.fromNodeId === selected.id || e.toNodeId === selected.id)
      .map((e) => {
        const otherId = e.fromNodeId === selected.id ? e.toNodeId : e.fromNodeId;
        const dir = e.fromNodeId === selected.id ? '→' : '←';
        return { id: e.id, relation: e.relation, dir, other: nodeById.get(otherId) };
      });
  }, [selected, data.edges, nodeById]);

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      const found = data.nodes.find((n) => String(n.id) === node.id) ?? null;
      setSelected(found);
      setIsEditing(false);
      setEditValue(found?.value ?? '');
    },
    [data.nodes],
  );

  const runMaintenance = async () => {
    setIsMaintaining(true);
    setMaintenanceMsg(null);
    try {
      const res = await fetch(apiUrl('/graph/maintenance'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`Maintenance failed (${res.status})`);
      const json = (await res.json()) as { summary: Record<string, number> };
      const s = json.summary;
      setMaintenanceMsg(
        `Merged ${s.merged}, resolved ${s.resolved}, pruned ${s.pruned}, +${s.edgesAdded} edges, re-embedded ${s.embedded}.`,
      );
      await load();
    } catch (err) {
      setMaintenanceMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setIsMaintaining(false);
    }
  };

  const saveEdit = async () => {
    if (!selected || !editValue.trim()) return;
    try {
      const res = await fetch(apiUrl(`/memories/${selected.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: editValue.trim() }),
      });
      if (!res.ok) throw new Error(`Update failed (${res.status})`);
      setIsEditing(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteNode = async () => {
    if (!selected) return;
    if (!confirm(`Delete "${nodeLabel(selected)}"?`)) return;
    try {
      const res = await fetch(apiUrl(`/memories/${selected.id}`), { method: 'DELETE' });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      setSelected(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="app-shell">
      <AppSidebar />

      <div className="chat-container">
        <div className="chat-header">
          <div className="chat-header-left">
            <SidebarTrigger />
            <span className="chat-header-title">Memory Graph</span>
          </div>
          <span className="chat-header-badge">
            {data.nodes.length} nodes · {data.edges.length} edges
          </span>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 8,
            padding: '8px 12px',
            flexWrap: 'wrap',
            alignItems: 'center',
            borderBottom: '1px solid var(--border, #2a2a2a)',
          }}
        >
          <button
            type="button"
            className={`memory-category-tab${kindFilter === null ? ' active' : ''}`}
            onClick={() => setKindFilter(null)}
          >
            All
          </button>
          {KIND_FILTERS.map((k) => (
            <button
              key={k}
              type="button"
              className={`memory-category-tab${kindFilter === k ? ' active' : ''}`}
              onClick={() => setKindFilter(k)}
            >
              {categoryLabel(k)}
            </button>
          ))}
          <label style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
            <input
              type="checkbox"
              checked={showSuperseded}
              onChange={(e) => setShowSuperseded(e.target.checked)}
            />
            Show superseded
          </label>
          <button
            type="button"
            className="memories-pagination-btn"
            disabled={isMaintaining}
            onClick={runMaintenance}
          >
            {isMaintaining ? 'Running…' : 'Run maintenance'}
          </button>
        </div>

        {maintenanceMsg ? (
          <div style={{ padding: '6px 12px', fontSize: 12, color: 'var(--fg-muted, #888)' }}>
            {maintenanceMsg}
          </div>
        ) : null}
        {error ? <div className="memories-error">{error}</div> : null}

        <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          {isLoading ? (
            <div className="memories-empty">Loading graph…</div>
          ) : (
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              onNodeClick={onNodeClick}
              fitView
              minZoom={0.1}
              proOptions={{ hideAttribution: true }}
            >
              <Background />
              <Controls />
            </ReactFlow>
          )}

          {selected ? (
            <aside
              style={{
                position: 'absolute',
                top: 12,
                right: 12,
                width: 280,
                maxHeight: 'calc(100% - 24px)',
                overflowY: 'auto',
                background: 'var(--bg-elevated, #1b1b1b)',
                border: '1px solid var(--border, #2a2a2a)',
                borderRadius: 10,
                padding: 14,
                fontSize: 13,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>{nodeLabel(selected)}</strong>
                <button type="button" className="memories-pagination-btn" onClick={() => setSelected(null)}>
                  ✕
                </button>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
                <span className="memory-chip">{categoryLabel(selected.kind)}</span>
                {selected.classification ? (
                  <span className="memory-chip">{categoryLabel(selected.classification)}</span>
                ) : null}
                {selected.tier ? (
                  <span className="memory-chip">{selected.tier.replace(/_/g, ' ')}</span>
                ) : null}
                {selected.status !== 'active' ? (
                  <span className="memory-chip">{selected.status}</span>
                ) : null}
              </div>

              {selected.kind === 'episode' && selected.value ? (
                <div
                  style={{
                    margin: '6px 0',
                    whiteSpace: 'pre-wrap',
                    color: 'var(--fg, #ddd)',
                    fontSize: 12,
                  }}
                >
                  {selected.value}
                </div>
              ) : null}

              {selected.kind !== 'memory' ? (
                <div style={{ fontSize: 11, color: 'var(--fg-muted, #888)' }}>
                  source: {selected.source ?? 'unknown'} · confidence {selected.confidence.toFixed(2)}
                </div>
              ) : null}

              {selected.kind === 'memory' ? (
                isEditing ? (
                  <div>
                    <textarea
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      rows={3}
                      className="memory-edit-textarea"
                      style={{ width: '100%' }}
                    />
                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      <button type="button" className="memories-pagination-btn" onClick={saveEdit}>
                        Save
                      </button>
                      <button type="button" className="memories-pagination-btn" onClick={() => setIsEditing(false)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div style={{ margin: '6px 0', color: 'var(--fg, #ddd)' }}>{selected.value}</div>
                    <div style={{ fontSize: 11, color: 'var(--fg-muted, #888)' }}>
                      importance {selected.importance.toFixed(2)} · recalled {selected.recallCount}×
                      {' · '}confidence {selected.confidence.toFixed(2)}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--fg-muted, #888)', marginTop: 2 }}>
                      source: {selected.source ?? 'unknown'}
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <button
                        type="button"
                        className="memories-pagination-btn"
                        onClick={() => {
                          setIsEditing(true);
                          setEditValue(selected.value ?? '');
                        }}
                      >
                        Edit
                      </button>
                      <button type="button" className="memories-pagination-btn" onClick={deleteNode}>
                        Delete
                      </button>
                    </div>
                  </>
                )
              ) : null}

              <div style={{ marginTop: 12 }}>
                <div className="sidebar-section-label">Relationships</div>
                {selectedEdges.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--fg-muted, #888)' }}>None</div>
                ) : (
                  selectedEdges.map((e) => (
                    <div key={e.id} style={{ fontSize: 12, padding: '2px 0' }}>
                      {e.dir} <em>{e.relation}</em> {e.other ? nodeLabel(e.other) : '?'}
                    </div>
                  ))
                )}
              </div>
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  );
}
