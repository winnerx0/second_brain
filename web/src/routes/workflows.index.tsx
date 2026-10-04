import { createRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { AppSidebar, SidebarTrigger } from '../components/app-sidebar';
import { WorkflowComposer } from '../components/workflow-composer';
import {
  workflowApi,
  scheduleLabel,
  formatTime,
  type Workflow,
} from '../lib/workflows';
import { Route as WorkflowsRoute } from './workflows';
import '../components/workflows.css';

export const Route = createRoute({
  getParentRoute: () => WorkflowsRoute,
  path: '/',
  component: WorkflowsIndexPage,
});
function WorkflowsIndexPage() {
  const navigate = useNavigate();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [creating, setCreating] = useState(false);
  const [health, setHealth] = useState<{
    workers: number;
    overdue: number;
    schedulerEnabled: boolean;
  }>();
  const load = async () => {
    try {
      const [data, status] = await Promise.all([
        workflowApi<{ workflows: Workflow[] }>(),
        workflowApi<typeof health>('/health'),
      ]);
      setWorkflows(data.workflows);
      setHealth(status);
      setError('');
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => clearInterval(timer);
  }, []);
  const open = (w: Workflow) =>
    void navigate({
      to: '/workflows/$workflowId',
      params: { workflowId: String(w.id) },
    });
  const action = async (
    w: Workflow,
    type: 'toggle' | 'duplicate' | 'delete',
  ) => {
    try {
      if (type === 'toggle')
        await workflowApi('/' + w.id, 'PATCH', { enabled: !w.enabled });
      if (type === 'duplicate' && w.definition) {
        const copy = await workflowApi<Workflow>('', 'POST', {
          definition: { ...w.definition, name: w.name + ' (copy)' },
          enabled: false,
        });
        open(copy);
      }
      if (
        type === 'delete' &&
        window.confirm('Delete this workflow and its run history?')
      )
        await workflowApi('/' + w.id, 'DELETE');
      await load();
    } catch (e) {
      setError(String(e));
    }
  };
  const visible = workflows.filter(
    (w) =>
      (w.name + ' ' + w.description)
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === 'all' ||
        (filter === 'paused'
          ? !w.enabled
          : filter === 'failed'
            ? ['failed', 'needs_attention'].includes(w.last_status ?? '')
            : w.enabled)),
  );
  return (
    <div className="app-shell">
      <AppSidebar />
      <div className="chat-container">
        <header className="chat-header">
          <div className="chat-header-left">
            <SidebarTrigger />
            <span className="chat-header-title">Workflows</span>
          </div>
        </header>
        <main className="wf-page">
          <div className="wf-toolbar">
            <div style={{ flex: 1 }}>
              <h1>Your work, on schedule.</h1>
              <p>Give Aira a process. Follow every step from here.</p>
            </div>
            <button
              className="wf-primary"
              onClick={() => setCreating(!creating)}
            >
              {creating ? 'Close composer' : '+ New workflow'}
            </button>
          </div>
          {health && (
            <p role="status">
              {health.workers
                ? 'Worker connected'
                : 'Worker offline — runs will stay queued'}{' '}
              ·{' '}
              {health.schedulerEnabled
                ? 'Scheduling enabled'
                : 'Scheduling paused globally'}{' '}
              · {health.overdue} overdue
            </p>
          )}
          {error && (
            <p role="alert" className="wf-error">
              {error} <button onClick={() => void load()}>Retry</button>
            </p>
          )}
          {(creating || (!loading && !workflows.length)) && (
            <WorkflowComposer onSaved={open} />
          )}
          <div className="wf-toolbar">
            <input
              aria-label="Search workflows"
              placeholder="Search workflows…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              aria-label="Filter workflows"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">All workflows</option>
              <option value="active">Enabled</option>
              <option value="paused">Paused</option>
              <option value="failed">Needs attention</option>
            </select>
            <small>{visible.length} workflows</small>
          </div>
          {loading ? (
            <p>Loading workflows…</p>
          ) : (
            <div className="wf-cards">
              {visible.map((w) => (
                <article className="wf-panel" key={w.id}>
                  <div>
                    <span className={'wf-badge ' + w.lifecycle}>
                      {w.enabled ? w.lifecycle : 'paused'}
                    </span>{' '}
                    {w.last_status && (
                      <span className={'wf-badge ' + w.last_status}>
                        {w.last_status.replaceAll('_', ' ')}
                      </span>
                    )}
                  </div>
                  <button className="wf-card-title" onClick={() => open(w)}>
                    {w.name}
                  </button>
                  <p>{w.description}</p>
                  <small>{scheduleLabel(w)}</small>
                  <small>Next: {formatTime(w.nextRunAt)}</small>
                  <small>Last completed: {formatTime(w.lastRunAt)}</small>
                  <div className="wf-toolbar">
                    <button onClick={() => open(w)}>Open</button>
                    <button onClick={() => void action(w, 'toggle')}>
                      {w.enabled ? 'Pause' : 'Resume'}
                    </button>
                    {w.definition && (
                      <button onClick={() => void action(w, 'duplicate')}>
                        Duplicate
                      </button>
                    )}
                    <button onClick={() => void action(w, 'delete')}>
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
          {!loading && workflows.length > 0 && visible.length === 0 && (
            <p>No workflows match this search.</p>
          )}
        </main>
      </div>
    </div>
  );
}
