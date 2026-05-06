import { createRoute, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppSidebar, SidebarTrigger } from '../components/app-sidebar';
import { FiArrowLeft, FiCheck, FiPlay, FiX, FiZap } from 'react-icons/fi';
import { Route as RootRoute } from './__root';
import type { Workflow } from './workflows';
import { WORKFLOWS_URL } from './workflows';

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workflows/$workflowId',
  component: WorkflowDetailPage,
});

type ToolStatus = 'pending' | 'running' | 'done' | 'error';
type FlowNode = { id: string; label: string; kind: 'trigger' | 'tool'; status: ToolStatus };

const STATUS_STYLES: Record<ToolStatus, { color: string; bg: string; border: string; label: string }> = {
  pending: { color: '#9ca3af', bg: '#ffffff', border: '#e5e7eb', label: 'Idle' },
  running: { color: '#f97316', bg: '#fff7ed', border: '#fdba74', label: 'Pending' },
  done: { color: '#16a34a', bg: '#f0fdf4', border: '#86efac', label: 'Passed' },
  error: { color: '#dc2626', bg: '#fef2f2', border: '#fca5a5', label: 'Failed' },
};

const NODE_W = 220;
const NODE_H = 76;
const COL_GAP = 80;
const ROW_GAP = 60;
const COLS = 3;
const PAD_X = 80;
const PAD_Y = 60;

function nodePosition(index: number): { x: number; y: number } {
  const row = Math.floor(index / COLS);
  const colInRow = index % COLS;
  const col = row % 2 === 0 ? colInRow : COLS - 1 - colInRow;
  return {
    x: PAD_X + col * (NODE_W + COL_GAP),
    y: PAD_Y + row * (NODE_H + ROW_GAP),
  };
}

function edgePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const ax = a.x + NODE_W / 2;
  const ay = a.y + NODE_H;
  const bx = b.x + NODE_W / 2;
  const by = b.y;
  const dy = Math.max(40, (by - ay) / 2);
  return `M ${ax} ${ay} C ${ax} ${ay + dy}, ${bx} ${by - dy}, ${bx} ${by}`;
}

function StatusBadge({ status }: { status: ToolStatus }) {
  const s = STATUS_STYLES[status];
  if (status === 'done') {
    return (
      <span style={badgeStyle(s.color)}>
        <FiCheck size={13} color="#fff" />
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span style={badgeStyle(s.color)}>
        <FiX size={13} color="#fff" />
      </span>
    );
  }
  if (status === 'running') {
    return (
      <span style={badgeStyle(s.color)}>
        <span
          style={{
            width: 12,
            height: 12,
            border: '2px solid #fff',
            borderTopColor: 'transparent',
            borderRadius: '50%',
            display: 'inline-block',
            animation: 'wf-spin 0.8s linear infinite',
          }}
        />
      </span>
    );
  }
  return <span style={{ ...badgeStyle('#e5e7eb'), border: '1px solid #d1d5db' }} />;
}

function badgeStyle(bg: string): React.CSSProperties {
  return {
    width: 24,
    height: 24,
    borderRadius: '50%',
    background: bg,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  };
}

function FlowCanvas({ nodes }: { nodes: FlowNode[] }) {
  const positions = nodes.map((_, i) => nodePosition(i));
  const lastPos = positions[positions.length - 1] ?? { x: 0, y: 0 };
  const width = PAD_X * 2 + COLS * NODE_W + (COLS - 1) * COL_GAP;
  const height = lastPos.y + NODE_H + PAD_Y;

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'auto',
        background:
          'radial-gradient(circle, #d1d5db 1px, transparent 1px) 0 0 / 20px 20px, #fafafa',
      }}
    >
      <style>{`@keyframes wf-spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ position: 'relative', width, height, minHeight: '100%' }}>
        <svg
          width={width}
          height={height}
          style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
        >
          {nodes.slice(0, -1).map((_, i) => {
            const a = positions[i]!;
            const b = positions[i + 1]!;
            const next = nodes[i + 1]!;
            const stroke =
              next.status === 'done'
                ? '#16a34a'
                : next.status === 'error'
                ? '#dc2626'
                : next.status === 'running'
                ? '#f97316'
                : '#cbd5e1';
            const dashed = next.status === 'pending';
            return (
              <path
                key={i}
                d={edgePath(a, b)}
                stroke={stroke}
                strokeWidth={2}
                strokeDasharray={dashed ? '6 6' : undefined}
                fill="none"
              />
            );
          })}
        </svg>

        {nodes.map((node, i) => {
          const pos = positions[i]!;
          const s = STATUS_STYLES[node.status];
          const isTrigger = node.kind === 'trigger';
          return (
            <div
              key={node.id}
              style={{
                position: 'absolute',
                left: pos.x,
                top: pos.y,
                width: NODE_W,
                height: NODE_H,
                background: s.bg,
                border: `1px solid ${s.border}`,
                borderRadius: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '0 14px',
                boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
              }}
            >
              <StatusBadge status={node.status} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {node.label}
                </div>
                <div style={{ fontSize: 10, color: s.color, fontWeight: 600, textTransform: 'uppercase' }}>
                  {isTrigger ? 'Trigger' : s.label}
                </div>
              </div>
              {isTrigger && <FiZap size={14} color="#f97316" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WorkflowDetailPage() {
  const { workflowId } = useParams({ from: '/workflows/$workflowId' });
  const navigate = useNavigate();
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string>('Idle');
  const [tools, setTools] = useState<FlowNode[]>([]);
  const [output, setOutput] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`${WORKFLOWS_URL}/${workflowId}`);
        if (!res.ok) throw new Error(`Failed to load workflow (${res.status})`);
        const data = (await res.json()) as Workflow;
        setWorkflow(data);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    return () => abortRef.current?.abort();
  }, [workflowId]);

  const flowNodes: FlowNode[] = useMemo(() => {
    const trigger: FlowNode = {
      id: 'trigger',
      label: 'Manual Trigger',
      kind: 'trigger',
      status: running || tools.length > 0 ? 'done' : 'pending',
    };
    return [trigger, ...tools];
  }, [tools, running]);

  const runWorkflow = async () => {
    setRunning(true);
    setStatus('Starting workflow…');
    setTools([]);
    setOutput('');
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`${WORKFLOWS_URL}/${workflowId}/run`, {
        method: 'POST',
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        setError('Failed to start workflow');
        setRunning(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines[lines.length - 1] ?? '';

        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i];
          if (!line) continue;
          if (line.startsWith('event: ')) {
            const type = line.slice(7);
            if (type === 'done' || type === 'error') setRunning(false);
          } else if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (!data || data === 'null') continue;
            try {
              const event = JSON.parse(data);
              if (event.type === 'status') {
                setStatus(event.message);
              } else if (event.type === 'tool_start') {
                setTools((prev) => [
                  ...prev,
                  { id: `${event.tool}-${prev.length}`, label: event.tool, kind: 'tool', status: 'running' },
                ]);
                setStatus(`Using ${event.tool}…`);
              } else if (event.type === 'tool_end') {
                const nextStatus: ToolStatus = event.success === false ? 'error' : 'done';
                setTools((prev) => {
                  const idx = [...prev].reverse().findIndex((t) => t.label === event.tool && t.status === 'running');
                  if (idx === -1) return prev;
                  const realIdx = prev.length - 1 - idx;
                  return prev.map((t, i) => (i === realIdx ? { ...t, status: nextStatus } : t));
                });
              } else if (event.type === 'assistant_delta') {
                setOutput((prev) => prev + event.delta);
              } else if (event.type === 'final') {
                setOutput(event.text);
                setStatus('Completed');
              } else if (event.type === 'error') {
                setError(event.message);
                setStatus('Failed');
              }
            } catch {
              // ignore
            }
          }
        }
      }
      setRunning(false);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : 'Unknown error');
      }
      setRunning(false);
    }
  };

  if (loadError) {
    return (
      <div className="app-shell">
        <AppSidebar />
        <div className="wf-detail-container">
          <div className="chat-header">
            <div className="chat-header-left">
              <SidebarTrigger />
              <span className="chat-header-title">Workflow</span>
            </div>
          </div>
          <main className="connections-page">
            <div className="memories-error">{loadError}</div>
          </main>
        </div>
      </div>
    );
  }

  if (!workflow) {
    return (
      <div className="app-shell">
        <AppSidebar />
        <div className="wf-detail-container">
          <div className="chat-header">
            <div className="chat-header-left">
              <SidebarTrigger />
              <span className="chat-header-title">Workflow</span>
            </div>
          </div>
          <main className="connections-page">
            <div className="memories-empty">Loading…</div>
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <AppSidebar />

      <div className="wf-detail-container">
        <div className="chat-header">
          <div className="chat-header-left">
            <SidebarTrigger />
            <button
              type="button"
              onClick={() => void navigate({ to: '/workflows' })}
              className="conn-btn-disconnect"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <FiArrowLeft size={13} /> Back
            </button>
            <span className="chat-header-title">{workflow.name}</span>
            <span style={{ fontSize: 12, color: 'var(--fg-dim)' }}>{status}</span>
          </div>
          <div className="conn-header-actions">
            <button
              type="button"
              onClick={() => void runWorkflow()}
              disabled={running}
              className="conn-btn-connect"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <FiPlay size={13} /> {running ? 'Running…' : 'Run'}
            </button>
          </div>
        </div>

        <main
          style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) 320px',
            minHeight: 0,
          }}
        >
          <div style={{ position: 'relative', minHeight: 0 }}>
            <FlowCanvas nodes={flowNodes} />
          </div>

          <aside
            style={{
              borderLeft: '1px solid var(--border)',
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              overflow: 'auto',
              background: 'var(--bg)',
            }}
          >
            <div>
              <div style={{ fontSize: 11, color: 'var(--fg-dim)', textTransform: 'uppercase', fontWeight: 600 }}>
                Plan
              </div>
              <div
                style={{
                  marginTop: 6,
                  fontSize: 13,
                  whiteSpace: 'pre-wrap',
                  background: 'var(--surface-2)',
                  padding: 10,
                  borderRadius: 6,
                  fontFamily: 'monospace',
                }}
              >
                {workflow.plan}
              </div>
            </div>

            {output && (
              <div>
                <div style={{ fontSize: 11, color: 'var(--fg-dim)', textTransform: 'uppercase', fontWeight: 600 }}>
                  Output
                </div>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 12,
                    whiteSpace: 'pre-wrap',
                    background: 'var(--surface-2)',
                    padding: 10,
                    borderRadius: 6,
                    fontFamily: 'monospace',
                    maxHeight: 400,
                    overflow: 'auto',
                  }}
                >
                  {output}
                </div>
              </div>
            )}

            {error && (
              <div
                style={{
                  fontSize: 12,
                  background: '#fee2e2',
                  color: '#991b1b',
                  padding: 10,
                  borderRadius: 6,
                }}
              >
                {error}
              </div>
            )}
          </aside>
        </main>
      </div>
    </div>
  );
}
