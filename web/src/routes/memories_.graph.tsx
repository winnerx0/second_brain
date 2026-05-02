import { createFileRoute, Link } from '@tanstack/react-router';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
} from 'react-force-graph-2d';
import { AppSidebar, SidebarTrigger } from '../components/app-sidebar';
import {
  apiUrl,
  categoryLabel,
  classificationColor,
  tierColor,
} from '../lib/memory-utils';

type GraphNode = {
  id: number;
  content: string;
  classification: string;
  tier: string;
  importance: number;
  accessCount: number;
};

type GraphLink = {
  source: number | GraphNode;
  target: number | GraphNode;
  similarity: number;
};

type GraphResponse = {
  nodes: GraphNode[];
  links: GraphLink[];
  threshold: number;
  topK: number;
};

export const Route = createFileRoute('/memories_/graph')({
  component: MemoryGraphRoute,
});

function nodeId(n: number | GraphNode): number {
  return typeof n === 'object' ? n.id : n;
}

function MemoryGraphRoute() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const [data, setData] = useState<{ nodes: GraphNode[]; links: GraphLink[] }>({
    nodes: [],
    links: [],
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(0.75);
  const [topK, setTopK] = useState(5);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [hoverId, setHoverId] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setSize({
        width: Math.max(320, Math.floor(rect.width)),
        height: Math.max(400, Math.floor(rect.height)),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    const handle = setTimeout(() => {
      const load = async () => {
        setIsLoading(true);
        setError(null);
        try {
          const url = apiUrl(
            `/memories/graph?threshold=${threshold}&topK=${topK}`,
          );
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error(`Unable to load graph (${response.status})`);
          }
          const json = (await response.json()) as GraphResponse;
          if (active) {
            setData({
              nodes: json.nodes ?? [],
              links: (json.links ?? []).map((l) => ({ ...l })),
            });
          }
        } catch (err) {
          if (active) {
            setError(err instanceof Error ? err.message : String(err));
          }
        } finally {
          if (active) setIsLoading(false);
        }
      };
      void load();
    }, 300);
    return () => {
      active = false;
      clearTimeout(handle);
    };
  }, [threshold, topK]);

  const adjacency = useMemo(() => {
    const map = new Map<number, Set<number>>();
    for (const link of data.links) {
      const s = nodeId(link.source);
      const t = nodeId(link.target);
      if (!map.has(s)) map.set(s, new Set());
      if (!map.has(t)) map.set(t, new Set());
      map.get(s)!.add(t);
      map.get(t)!.add(s);
    }
    return map;
  }, [data.links]);

  const isHighlighted = useCallback(
    (id: number): boolean => {
      if (hoverId === null) return true;
      if (id === hoverId) return true;
      return adjacency.get(hoverId)?.has(id) ?? false;
    },
    [hoverId, adjacency],
  );

  const nodeRadius = useCallback((node: GraphNode): number => {
    const base = 4;
    return base + Math.sqrt(Math.max(0, node.importance)) * 8;
  }, []);

  const handleZoomToFit = useCallback(() => {
    fgRef.current?.zoomToFit(400, 60);
  }, []);

  useEffect(() => {
    if (!isLoading && data.nodes.length > 0) {
      const t = setTimeout(handleZoomToFit, 600);
      return () => clearTimeout(t);
    }
  }, [isLoading, data.nodes.length, handleZoomToFit]);

  return (
    <div className="app-shell">
      <AppSidebar />

      <div className="chat-container">
        <div className="chat-header">
          <div className="chat-header-left">
            <SidebarTrigger />
            <span className="chat-header-title">Memory Graph</span>
          </div>
          <Link to="/memories" className="chat-header-badge" style={{ textDecoration: 'none' }}>
            ← List view
          </Link>
        </div>

        <main
          className="memories-page"
          style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
        >
          <div className="memory-graph-controls">
            <div className="memory-graph-control">
              <label htmlFor="threshold">
                Similarity ≥ <strong>{threshold.toFixed(2)}</strong>
              </label>
              <input
                id="threshold"
                type="range"
                min={0.5}
                max={0.95}
                step={0.01}
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
              />
            </div>
            <div className="memory-graph-control">
              <label htmlFor="topk">
                Top-K neighbors <strong>{topK}</strong>
              </label>
              <input
                id="topk"
                type="range"
                min={1}
                max={10}
                step={1}
                value={topK}
                onChange={(e) => setTopK(Number(e.target.value))}
              />
            </div>
            <div className="memory-graph-control">
              <button
                type="button"
                className="memories-pagination-btn"
                onClick={handleZoomToFit}
              >
                Fit view
              </button>
            </div>
            <div className="memory-graph-stats">
              {data.nodes.length} nodes · {data.links.length} edges
            </div>
          </div>

          <div className="memory-graph-legend">
            {(
              [
                'identity',
                'relationships',
                'behavior',
                'preferences',
                'corrections',
                'knowledge',
                'unclassified',
              ] as const
            ).map((c) => (
              <span key={c} className="memory-graph-legend-item">
                <span
                  className="memory-graph-legend-dot"
                  style={{ background: classificationColor(c) }}
                />
                {categoryLabel(c)}
              </span>
            ))}
          </div>

          {error ? <div className="memories-error">{error}</div> : null}

          <div
            ref={containerRef}
            className="memory-graph-canvas"
            style={{ flex: 1, position: 'relative', minHeight: 480 }}
          >
            {isLoading && data.nodes.length === 0 ? (
              <div className="memories-empty">Loading graph…</div>
            ) : null}
            {!isLoading && data.nodes.length === 0 && !error ? (
              <div className="memories-empty">No memories to graph.</div>
            ) : null}
            {data.nodes.length > 0 ? (
              <ForceGraph2D
                ref={fgRef}
                width={size.width}
                height={size.height}
                graphData={data}
                backgroundColor="transparent"
                nodeRelSize={4}
                cooldownTicks={120}
                linkColor={(link) => {
                  const l = link as LinkObject<GraphNode, GraphLink>;
                  const sId = nodeId(
                    (l.source as unknown as number | GraphNode) ?? 0,
                  );
                  const tId = nodeId(
                    (l.target as unknown as number | GraphNode) ?? 0,
                  );
                  const dim =
                    hoverId !== null &&
                    sId !== hoverId &&
                    tId !== hoverId;
                  const sim = (l as unknown as GraphLink).similarity ?? 0.75;
                  const alpha = dim ? 0.05 : Math.max(0.15, sim - 0.4);
                  return `rgba(120, 110, 100, ${alpha})`;
                }}
                linkWidth={(link) => {
                  const sim = (link as unknown as GraphLink).similarity ?? 0.75;
                  return 0.5 + (sim - 0.5) * 4;
                }}
                onNodeClick={(node) => setSelected(node as GraphNode)}
                onNodeHover={(node) => {
                  setHoverId(node ? (node as GraphNode).id : null);
                }}
                nodeCanvasObject={(node, ctx, globalScale) => {
                  const n = node as GraphNode & { x?: number; y?: number };
                  if (n.x === undefined || n.y === undefined) return;
                  const r = nodeRadius(n);
                  const highlighted = isHighlighted(n.id);
                  const color = classificationColor(n.classification);

                  ctx.globalAlpha = highlighted ? 1 : 0.18;

                  ctx.beginPath();
                  ctx.arc(n.x, n.y, r, 0, 2 * Math.PI, false);
                  ctx.fillStyle = color;
                  ctx.fill();
                  ctx.lineWidth = 0.8;
                  ctx.strokeStyle = 'rgba(40, 32, 24, 0.4)';
                  ctx.stroke();

                  if (globalScale > 1.2 || hoverId === n.id) {
                    const label =
                      n.content.length > 40
                        ? `${n.content.slice(0, 40)}…`
                        : n.content;
                    const fontSize = Math.max(8, 11 / globalScale);
                    ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'top';
                    ctx.fillStyle = 'rgba(40, 32, 24, 0.85)';
                    ctx.fillText(label, n.x, n.y + r + 2);
                  }

                  ctx.globalAlpha = 1;
                }}
                nodePointerAreaPaint={(node, color, ctx) => {
                  const n = node as GraphNode & { x?: number; y?: number };
                  if (n.x === undefined || n.y === undefined) return;
                  const r = nodeRadius(n);
                  ctx.fillStyle = color;
                  ctx.beginPath();
                  ctx.arc(n.x, n.y, r + 2, 0, 2 * Math.PI, false);
                  ctx.fill();
                }}
              />
            ) : null}

            {selected ? (
              <aside className="memory-graph-panel">
                <div className="memory-graph-panel-header">
                  <div className="memory-card-title-row">
                    <span className="memory-chip accent">#{selected.id}</span>
                    <span
                      className="memory-chip"
                      style={{
                        borderColor: classificationColor(selected.classification),
                        color: classificationColor(selected.classification),
                      }}
                    >
                      {categoryLabel(selected.classification)}
                    </span>
                    <span
                      className="memory-chip"
                      style={{
                        borderColor: tierColor(selected.tier),
                        color: tierColor(selected.tier),
                      }}
                    >
                      {selected.tier.replace(/_/g, ' ')}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="memories-pagination-btn"
                    onClick={() => setSelected(null)}
                  >
                    Close
                  </button>
                </div>
                <div className="memory-content">{selected.content}</div>
                <div className="memory-details-grid">
                  <div className="memory-detail">
                    <span className="memory-detail-label">Importance</span>
                    <span className="memory-detail-value">
                      {selected.importance.toFixed(2)}
                    </span>
                  </div>
                  <div className="memory-detail">
                    <span className="memory-detail-label">Access count</span>
                    <span className="memory-detail-value">
                      {selected.accessCount}
                    </span>
                  </div>
                  <div className="memory-detail">
                    <span className="memory-detail-label">Neighbors</span>
                    <span className="memory-detail-value">
                      {adjacency.get(selected.id)?.size ?? 0}
                    </span>
                  </div>
                </div>
                <div className="memory-detail-label" style={{ marginTop: 12 }}>
                  Open list view for full metadata.
                </div>
              </aside>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}
