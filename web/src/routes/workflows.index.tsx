import { createRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { AppSidebar, SidebarTrigger } from '../components/app-sidebar';
import { FiPlay, FiPlus, FiX } from 'react-icons/fi';
import { Route as WorkflowsRoute, WORKFLOWS_URL, type Workflow } from './workflows';

export const Route = createRoute({
  getParentRoute: () => WorkflowsRoute,
  path: '/',
  component: WorkflowsIndexPage,
});

function WorkflowCard({
  workflow,
  onOpen,
}: {
  workflow: Workflow;
  onOpen: (wf: Workflow) => void;
}) {
  return (
    <div
      className="conn-card"
      onClick={() => onOpen(workflow)}
      style={{ cursor: 'pointer' }}
    >
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
          onClick={(e) => {
            e.stopPropagation();
            onOpen(workflow);
          }}
          className="conn-btn-connect"
          title="Open workflow"
        >
          <FiPlay size={13} style={{ marginRight: '4px' }} /> Open
        </button>
      </div>
    </div>
  );
}

function WorkflowModal({
  onSave,
  onClose,
}: {
  onSave: (data: { name: string; description: string; plan: string; enabled: boolean }) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [plan, setPlan] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSave = async () => {
    if (!name.trim() || !plan.trim()) return;
    setLoading(true);
    try {
      await onSave({ name: name.trim(), description: description.trim(), plan: plan.trim(), enabled: true });
      onClose();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="conn-modal-overlay" onClick={onClose}>
      <div className="conn-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
        <div className="conn-modal-header">
          <span className="conn-modal-title">New Workflow</span>
          <button type="button" aria-label="Close" onClick={onClose} className="conn-modal-close">
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

function WorkflowsIndexPage() {
  const navigate = useNavigate();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);

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

  const handleCreate = async (data: { name: string; description: string; plan: string; enabled: boolean }) => {
    const res = await fetch(WORKFLOWS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`Failed to create workflow (${res.status})`);
    const created = (await res.json()) as Workflow;
    await load();
    if (created?.id) {
      void navigate({ to: '/workflows/$workflowId', params: { workflowId: String(created.id) } });
    }
  };

  const openWorkflow = (wf: Workflow) => {
    void navigate({ to: '/workflows/$workflowId', params: { workflowId: String(wf.id) } });
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
              onClick={() => setShowModal(true)}
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
                <WorkflowCard key={wf.id} workflow={wf} onOpen={openWorkflow} />
              ))}
            </div>
          )}
        </main>
      </div>

      {showModal && (
        <WorkflowModal
          onSave={handleCreate}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}
