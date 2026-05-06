import { createRoute } from '@tanstack/react-router';
import React, { useEffect, useState } from 'react';
import { AppSidebar, SidebarTrigger } from '../components/app-sidebar';
import { FiCheck, FiPlay, FiPlus, FiX } from 'react-icons/fi';
import { Route as RootRoute } from './__root';

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workflows',
  component: WorkflowsPage,
});

type Workflow = {
  id: number;
  name: string;
  description: string;
  plan: string;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type WorkflowRun = {
  id: number;
  workflowId: number;
  status: 'running' | 'completed' | 'failed';
  output: string | null;
  ranAt: string;
};

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const WORKFLOWS_URL = `${API_BASE.replace(/\/$/, '')}/workflows`;

function WorkflowCard({
  workflow,
  onEdit,
  onRun,
}: {
  workflow: Workflow;
  onEdit: (wf: Workflow) => void;
  onRun: (wf: Workflow) => void;
}) {
  return (
    <div className="conn-card">
      <div className="conn-card-body">
        <div className="conn-card-name">{workflow.name}</div>
        {workflow.description && (
          <div className="conn-card-desc">{workflow.description}</div>
        )}
        <div className="conn-card-meta">
          {workflow.lastRunAt && (
            <span className="text-xs text-gray-500">
              Last run: {new Date(workflow.lastRunAt).toLocaleDateString()}
            </span>
          )}
        </div>
      </div>

      <div className="conn-card-actions">
        <button
          type="button"
          onClick={() => onRun(workflow)}
          className="conn-btn-connect"
          title="Run workflow"
        >
          <FiPlay size={13} style={{ marginRight: '4px' }} /> Run
        </button>
        <button
          type="button"
          onClick={() => onEdit(workflow)}
          className="conn-btn-connect"
          title="Edit workflow"
        >
          Edit
        </button>
      </div>
    </div>
  );
}

function WorkflowModal({
  workflow,
  onSave,
  onClose,
}: {
  workflow?: Workflow;
  onSave: (data: Omit<Workflow, 'id' | 'lastRunAt' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(workflow?.name ?? '');
  const [description, setDescription] = useState(workflow?.description ?? '');
  const [plan, setPlan] = useState(workflow?.plan ?? '');
  const [loading, setLoading] = useState(false);

  const handleSave = async () => {
    if (!name.trim() || !plan.trim()) return;
    setLoading(true);
    try {
      await onSave({ name: name.trim(), description: description.trim(), plan: plan.trim(), enabled: workflow?.enabled ?? true });
      onClose();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="conn-modal-overlay" onClick={onClose}>
      <div className="conn-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
        <div className="conn-modal-header">
          <span className="conn-modal-title">{workflow ? 'Edit Workflow' : 'New Workflow'}</span>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="conn-modal-close"
          >
            <FiX size={13} />
          </button>
        </div>

        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px', fontWeight: 500 }}>
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Workflow name"
              style={{
                width: '100%',
                padding: '8px',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                fontSize: '14px',
              }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px', fontWeight: 500 }}>
              Description (optional)
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description"
              style={{
                width: '100%',
                padding: '8px',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                fontSize: '14px',
              }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px', fontWeight: 500 }}>
              Plan (natural language)
            </label>
            <textarea
              value={plan}
              onChange={(e) => setPlan(e.target.value)}
              placeholder="Describe the workflow steps (e.g., 'Get my GitHub PRs, then summarize them')"
              style={{
                width: '100%',
                padding: '8px',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                fontSize: '14px',
                fontFamily: 'monospace',
                minHeight: '200px',
                resize: 'vertical',
              }}
            />
          </div>

          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={onClose}
              className="conn-btn-disconnect"
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              className="conn-btn-connect"
              disabled={loading || !name.trim() || !plan.trim()}
            >
              {loading ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RunOutputPanel({
  workflow,
  onClose,
}: {
  workflow: Workflow;
  onClose: () => void;
}) {
  const [running, setRunning] = useState(true);
  const [status, setStatus] = useState<string>('Starting workflow...');
  const [tools, setTools] = useState<Array<{ name: string; status: 'running' | 'done' | 'error' }>>([]);
  const [output, setOutput] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const runWorkflow = async () => {
      try {
        const res = await fetch(
          `${WORKFLOWS_URL}/${workflow.id}/run`,
          { method: 'POST' },
        );

        if (!res.ok) {
          setError('Failed to start workflow');
          setRunning(false);
          return;
        }

        if (!res.body) {
          setError('No response body');
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
          buffer = lines[lines.length - 1];

          for (let i = 0; i < lines.length - 1; i++) {
            const line = lines[i];
            if (line.startsWith('event: ')) {
              const type = line.slice(7);
              if (type === 'done') {
                setRunning(false);
              } else if (type === 'error') {
                setRunning(false);
              }
            } else if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data && data !== 'null') {
                try {
                  const event = JSON.parse(data);
                  if (event.type === 'status') {
                    setStatus(event.message);
                  } else if (event.type === 'tool_start') {
                    setTools((prev) => [...prev, { name: event.tool, status: 'running' }]);
                    setStatus(`Using ${event.tool}…`);
                  } else if (event.type === 'tool_end') {
                    setTools((prev) =>
                      prev.map((t) =>
                        t.name === event.tool ? { ...t, status: 'done' } : t,
                      ),
                    );
                  } else if (event.type === 'assistant_delta') {
                    setOutput((prev) => prev + event.delta);
                  } else if (event.type === 'final') {
                    setOutput(event.text);
                  } else if (event.type === 'error') {
                    setError(event.message);
                  }
                } catch (e) {
                  // Ignore parse errors
                }
              }
            }
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
        setRunning(false);
      }
    };

    void runWorkflow();
  }, [workflow.id]);

  return (
    <div className="conn-modal-overlay" onClick={onClose}>
      <div
        className="conn-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '700px', maxHeight: '80vh', overflow: 'auto' }}
      >
        <div className="conn-modal-header">
          <span className="conn-modal-title">Running: {workflow.name}</span>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="conn-modal-close"
            disabled={running}
          >
            <FiX size={13} />
          </button>
        </div>

        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {/* Status */}
          <div style={{ fontSize: '13px', color: 'var(--fg-dim)' }}>{status}</div>

          {/* Tools */}
          {tools.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {tools.map((tool, i) => (
                <div key={i} style={{ fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {tool.status === 'running' && (
                    <span style={{ color: '#f97316', fontWeight: 'bold' }}>→</span>
                  )}
                  {tool.status === 'done' && (
                    <FiCheck size={13} style={{ color: '#22c55e' }} />
                  )}
                  {tool.status === 'error' && (
                    <span style={{ color: '#ef4444' }}>✕</span>
                  )}
                  <span>{tool.name}</span>
                </div>
              ))}
            </div>
          )}

          {/* Output */}
          {output && (
            <div
              style={{
                padding: '8px',
                background: 'var(--surface-2)',
                borderRadius: '6px',
                fontSize: '12px',
                fontFamily: 'monospace',
                maxHeight: '300px',
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {output}
            </div>
          )}

          {/* Error */}
          {error && (
            <div
              style={{
                padding: '8px',
                background: '#fee2e2',
                color: '#991b1b',
                borderRadius: '6px',
                fontSize: '12px',
              }}
            >
              {error}
            </div>
          )}

          {/* Footer */}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={onClose}
              className="conn-btn-disconnect"
              disabled={running}
            >
              {running ? 'Running…' : 'Close'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingWorkflow, setEditingWorkflow] = useState<Workflow | undefined>(undefined);
  const [runningWorkflow, setRunningWorkflow] = useState<Workflow | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(WORKFLOWS_URL);
      if (!res.ok) throw new Error(`Failed to load workflows (${res.status})`);
      const data = (await res.json()) as { workflows: Workflow[] };
      setWorkflows(data.workflows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleCreate = async (data: Omit<Workflow, 'id' | 'lastRunAt' | 'createdAt' | 'updatedAt'>) => {
    try {
      const res = await fetch(WORKFLOWS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`Failed to create workflow (${res.status})`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleUpdate = async (data: Omit<Workflow, 'id' | 'lastRunAt' | 'createdAt' | 'updatedAt'>) => {
    if (!editingWorkflow) return;
    try {
      const res = await fetch(`${WORKFLOWS_URL}/${editingWorkflow.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`Failed to update workflow (${res.status})`);
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
            <span className="chat-header-title">Workflows</span>
          </div>
          <div className="conn-header-actions">
            {!loading && (
              <span className="chat-header-badge">
                <span className={`chat-header-dot${workflows.length > 0 ? '' : ' idle'}`} />
                {workflows.length} workflows
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                setEditingWorkflow(undefined);
                setShowModal(true);
              }}
              className="conn-add-btn"
            >
              <FiPlus size={13} />
              New Workflow
            </button>
          </div>
        </div>

        <main className="connections-page">
          {error && <div className="memories-error">{error}</div>}

          {loading ? (
            <div className="memories-empty">Loading workflows…</div>
          ) : workflows.length === 0 ? (
            <div className="memories-empty">No workflows yet. Create one to get started.</div>
          ) : (
            <div className="conn-grid">
              {workflows.map((wf) => (
                <WorkflowCard
                  key={wf.id}
                  workflow={wf}
                  onEdit={(w) => {
                    setEditingWorkflow(w);
                    setShowModal(true);
                  }}
                  onRun={(w) => setRunningWorkflow(w)}
                />
              ))}
            </div>
          )}
        </main>
      </div>

      {showModal && (
        <WorkflowModal
          workflow={editingWorkflow}
          onSave={editingWorkflow ? handleUpdate : handleCreate}
          onClose={() => {
            setShowModal(false);
            setEditingWorkflow(undefined);
          }}
        />
      )}

      {runningWorkflow && (
        <RunOutputPanel
          workflow={runningWorkflow}
          onClose={() => setRunningWorkflow(null)}
        />
      )}
    </div>
  );
}
