import { createRoute, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AppSidebar, SidebarTrigger } from '../components/app-sidebar';
import { WorkflowComposer } from '../components/workflow-composer';
import { WorkflowGraph } from '../components/workflow-graph';
import {
  workflowApi,
  WORKFLOWS_URL,
  scheduleLabel,
  formatTime,
  type Workflow,
  type WorkflowDefinition,
  type Run,
} from '../lib/workflows';
import { Route as RootRoute } from './__root';
import '../components/workflows.css';

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workflows/$workflowId',
  component: WorkflowDetailPage,
});
type Learning = {
  lessons: { id: number; lesson: string; confidence: number; run_id: number }[];
  proposals: {
    id: number;
    reason: string;
    status: string;
    base_revision: number;
    definition: WorkflowDefinition;
    run_id: number;
  }[];
  revisions: { version: number; definition: WorkflowDefinition }[];
};
function WorkflowDetailPage() {
  const { workflowId } = useParams({ from: '/workflows/$workflowId' });
  const navigate = useNavigate();
  const [workflow, setWorkflow] = useState<Workflow>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [learning, setLearning] = useState<Learning>({
    lessons: [],
    proposals: [],
    revisions: [],
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const [stepId, setStepId] = useState('');
  const [events, setEvents] = useState<{ id: string; text: string }[]>([]);
  const [connected, setConnected] = useState(true);
  const [feedback, setFeedback] = useState('');
  const [notice, setNotice] = useState('');
  const [trigger, setTrigger] = useState<WorkflowDefinition['trigger']>();
  const load = async () => {
    const [w, history, learned] = await Promise.all([
      workflowApi<Workflow>('/' + workflowId),
      workflowApi<{ runs: Run[] }>('/' + workflowId + '/runs'),
      workflowApi<Learning>('/' + workflowId + '/learning'),
    ]);
    setWorkflow(w);
    setRuns(history.runs);
    setLearning(learned);
    setTrigger(w.definition?.trigger);
    return history.runs;
  };
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    setRun(null);
    void load()
      .then((history) => {
        if (history[0]) void selectRun(history[0].id);
      })
      .catch((e) => setError(String(e)));
  }, [workflowId]);
  const selectRun = async (id: number) => {
    setRun(await workflowApi<Run>('/runs/' + id));
    setEvents([]);
  };
  useEffect(() => {
    if (!run || !['running', 'queued'].includes(run.status)) return;
    const source = new EventSource(
      WORKFLOWS_URL + '/runs/' + run.id + '/events',
    );
    let alive = true;
    const refresh = async () => {
      try {
        const next = await workflowApi<Run>('/runs/' + run.id);
        if (alive) setRun(next);
      } catch (e) {
        if (alive) setError(String(e));
      }
    };
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data);
      setEvents((old) =>
        old.some((e) => e.id === message.lastEventId)
          ? old
          : [
              ...old,
              {
                id: message.lastEventId,
                text: [
                  event.type,
                  event.stepId,
                  event.tool,
                  event.status,
                  event.message,
                ]
                  .filter(Boolean)
                  .join(' · '),
              },
            ].slice(-100),
      );
      void refresh();
    };
    source.addEventListener('done', () => {
      void refresh();
      void load().catch((e) => setError(String(e)));
      source.close();
    });
    const poll = setInterval(() => void refresh(), 5000);
    return () => {
      alive = false;
      source.close();
      clearInterval(poll);
    };
  }, [run?.id, run?.status]);
  const definition = run?.definition ?? workflow?.definition;
  const step = definition?.steps.find((s) => s.id === stepId);
  const stepRun = run?.steps?.find((s) => s.step_id === stepId);
  return (
    <div className="app-shell">
      <AppSidebar />
      <div className="chat-container">
        <header className="chat-header">
          <div className="chat-header-left">
            <SidebarTrigger />
            <span className="chat-header-title">Workflow</span>
          </div>
        </header>
        <main className="wf-page">
          <div className="wf-toolbar">
            <button onClick={() => void navigate({ to: '/workflows' })}>
              ← Workflows
            </button>
            <h1>{workflow?.name ?? 'Loading…'}</h1>
            {workflow && (
              <>
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await workflowApi('/' + workflowId, 'PATCH', {
                        enabled: !workflow.enabled,
                      });
                      await load();
                    })
                  }
                >
                  {workflow.enabled ? 'Pause schedule' : 'Resume schedule'}
                </button>
                <button onClick={() => setEditing(!editing)}>
                  Edit instructions
                </button>
                <button
                  className="wf-primary"
                  disabled={
                    busy ||
                    !workflow.definition ||
                    (!!run && ['running', 'queued'].includes(run.status))
                  }
                  onClick={() =>
                    void act(async () => {
                      const next = await workflowApi<{ runId: number }>(
                        '/' + workflowId + '/run',
                        'POST',
                      );
                      await selectRun(next.runId);
                      setTab('overview');
                      await load();
                    })
                  }
                >
                  Run now
                </button>
              </>
            )}
          </div>
          {error && (
            <p role="alert" className="wf-error">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="wf-notice">
              {notice}
            </p>
          )}
          {workflow && (
            <>
              <p>{workflow.description}</p>
              <div className="wf-toolbar">
                <span className="wf-badge">
                  {workflow.enabled ? workflow.lifecycle : 'paused'}
                </span>
                <small>{scheduleLabel(workflow)}</small>
                <small>Next: {formatTime(workflow.nextRunAt)}</small>
                <small>Revision {workflow.activeRevision}</small>
              </div>
              {workflow.connectionIssues?.map((issue) => (
                <p key={issue} className="wf-notice">
                  {issue} <a href="/connections">Manage connections</a>
                </p>
              ))}
              {(editing || !workflow.definition) && (
                <WorkflowComposer
                  key={workflow.activeRevision}
                  existing={workflow}
                  onSaved={(w) => {
                    setWorkflow(w);
                    setEditing(false);
                    setRun(null);
                    void load();
                  }}
                />
              )}
              <div
                className="wf-tabs"
                role="tablist"
                aria-label="Workflow sections"
              >
                {['overview', 'runs', 'schedule', 'learning'].map((t) => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={tab === t}
                    onClick={() => setTab(t)}
                  >
                    {t[0]!.toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
              {tab === 'overview' && (
                <div className="wf-detail-grid">
                  <div>
                    <div className="wf-toolbar">
                      <h2>{run ? 'Run #' + run.id : 'Saved workflow'}</h2>
                      {run && (
                        <>
                          <span className={'wf-badge ' + run.status}>
                            {run.status.replaceAll('_', ' ')}
                          </span>
                          <button onClick={() => setRun(null)}>
                            Show saved plan
                          </button>
                          {['running', 'queued'].includes(run.status) && (
                            <button
                              disabled={busy}
                              onClick={() =>
                                void act(async () => {
                                  await workflowApi(
                                    '/runs/' + run.id + '/cancel',
                                    'POST',
                                  );
                                  setNotice(
                                    'Cancellation requested. An action already sent cannot be undone.',
                                  );
                                })
                              }
                            >
                              Cancel run
                            </button>
                          )}
                        </>
                      )}
                    </div>
                    {!connected &&
                      run &&
                      ['running', 'queued'].includes(run.status) && (
                        <p className="wf-notice">
                          Live connection interrupted. Reconnecting; execution
                          continues.
                        </p>
                      )}
                    {definition && (
                      <WorkflowGraph
                        definition={definition}
                        run={run}
                        onSelect={setStepId}
                      />
                    )}
                    {run?.error && <p className="wf-error">{run.error}</p>}
                    {run?.output && (
                      <section className="wf-panel wf-markdown">
                        <h2>Result</h2>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {run.output}
                        </ReactMarkdown>
                      </section>
                    )}
                    {events.length > 0 && (
                      <details>
                        <summary>Live activity</summary>
                        <div className="wf-events">
                          {events.map((e) => (
                            <p key={e.id}>{e.text}</p>
                          ))}
                        </div>
                      </details>
                    )}
                    {run && !['queued', 'running'].includes(run.status) && (
                      <section className="wf-panel">
                        <h2>Help Aira improve</h2>
                        <label htmlFor="run-feedback">
                          What worked, or what should change?
                        </label>
                        <textarea
                          id="run-feedback"
                          value={feedback}
                          onChange={(e) => setFeedback(e.target.value)}
                        />
                        <button
                          disabled={busy || !feedback.trim()}
                          onClick={() =>
                            void act(async () => {
                              await workflowApi(
                                '/runs/' + run.id + '/feedback',
                                'POST',
                                { feedback },
                              );
                              setFeedback('');
                              setNotice(
                                'Feedback saved. Aira will review it in the background.',
                              );
                            })
                          }
                        >
                          Save feedback
                        </button>
                      </section>
                    )}
                  </div>
                  <aside className="wf-panel">
                    <h2>{step ? step.title : 'Step inspector'}</h2>
                    {step ? (
                      <>
                        <p>{step.instruction}</p>
                        <small>
                          {step.specialist} · {stepRun?.status ?? 'Not run'}
                        </small>
                        <h3>Authorized actions</h3>
                        {step.permissions.length ? (
                          step.permissions.map((p) => (
                            <pre key={p.tool}>
                              {p.tool +
                                '\n' +
                                JSON.stringify(p.constraints, null, 2)}
                            </pre>
                          ))
                        ) : (
                          <p>Read-only</p>
                        )}
                        {stepRun?.error && (
                          <p className="wf-error">{stepRun.error}</p>
                        )}
                        {stepRun?.output && (
                          <div className="wf-markdown">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {stepRun.output}
                            </ReactMarkdown>
                          </div>
                        )}
                      </>
                    ) : (
                      <p>
                        Select a step to inspect its instructions, permissions,
                        and result.
                      </p>
                    )}
                    <details>
                      <summary>Original instructions</summary>
                      <p>{definition?.instructions ?? workflow.plan}</p>
                    </details>
                  </aside>
                </div>
              )}
              {tab === 'runs' && (
                <section className="wf-panel">
                  <h2>Run history</h2>
                  {runs.length ? (
                    <>
                      <table className="wf-runs">
                        <thead>
                          <tr>
                            <th>Run</th>
                            <th>Status</th>
                            <th>Trigger</th>
                            <th>Scheduled</th>
                            <th>Created</th>
                          </tr>
                        </thead>
                        <tbody>
                          {runs.map((r) => (
                            <tr key={r.id}>
                              <td>
                                <button
                                  onClick={() =>
                                    void act(async () => {
                                      await selectRun(r.id);
                                      setTab('overview');
                                    })
                                  }
                                >
                                  #{r.id}
                                </button>
                              </td>
                              <td>
                                <span className={'wf-badge ' + r.status}>
                                  {r.status.replaceAll('_', ' ')}
                                </span>
                              </td>
                              <td>{r.trigger}</td>
                              <td>{formatTime(r.scheduled_for)}</td>
                              <td>{formatTime(r.ran_at)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            const older = await workflowApi<{ runs: Run[] }>(
                              '/' +
                                workflowId +
                                '/runs?before=' +
                                runs.at(-1)!.id,
                            );
                            setRuns((old) => [...old, ...older.runs]);
                            if (!older.runs.length) setNotice('No older runs.');
                          })
                        }
                      >
                        Load older runs
                      </button>
                    </>
                  ) : (
                    <p>
                      No runs yet. Run this workflow or wait for its schedule.
                    </p>
                  )}
                </section>
              )}
              {tab === 'schedule' && trigger && workflow.definition && (
                <section className="wf-panel">
                  <h2>Schedule</h2>
                  <label htmlFor="trigger-kind">Trigger</label>
                  <select
                    id="trigger-kind"
                    value={trigger.kind}
                    onChange={(e) =>
                      setTrigger({
                        ...trigger,
                        kind: e.target.value as typeof trigger.kind,
                      })
                    }
                  >
                    <option value="manual">Manual</option>
                    <option value="once">One time</option>
                    <option value="cron">Recurring cron</option>
                  </select>
                  {trigger.kind === 'cron' && (
                    <>
                      <label htmlFor="cron">Five-field cron</label>
                      <input
                        id="cron"
                        value={trigger.cron ?? ''}
                        onChange={(e) =>
                          setTrigger({ ...trigger, cron: e.target.value })
                        }
                        placeholder="0 8 * * 1-5"
                      />
                    </>
                  )}
                  {trigger.kind === 'once' && (
                    <>
                      <label htmlFor="once">
                        ISO date and time, including UTC offset
                      </label>
                      <input
                        id="once"
                        value={trigger.at ?? ''}
                        onChange={(e) =>
                          setTrigger({ ...trigger, at: e.target.value })
                        }
                        placeholder="2026-10-04T08:00:00+01:00"
                      />
                    </>
                  )}
                  <label htmlFor="timezone">Timezone</label>
                  <input
                    id="timezone"
                    value={trigger.timezone}
                    onChange={(e) =>
                      setTrigger({ ...trigger, timezone: e.target.value })
                    }
                    placeholder="Africa/Lagos"
                  />
                  <p>
                    Missed occurrences are combined into one catch-up run. Runs
                    never overlap this workflow.
                  </p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await workflowApi('/' + workflowId, 'PATCH', {
                          definition: { ...workflow.definition!, trigger },
                          expectedRevision: workflow.activeRevision,
                          enabled: workflow.enabled,
                        });
                        await load();
                        setNotice('Schedule saved.');
                      })
                    }
                  >
                    Save schedule
                  </button>
                  <h3>Next executions (saved schedule)</h3>
                  <ul>
                    {workflow.preview?.map((date) => (
                      <li key={date}>
                        {new Date(date).toLocaleString(undefined, {
                          timeZone: workflow.definition!.trigger.timezone,
                        })}{' '}
                        · {workflow.definition!.trigger.timezone}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {tab === 'learning' && (
                <>
                  <section className="wf-panel">
                    <h2>Execution lessons</h2>
                    <p>
                      Lessons guide execution. Changes to this workflow require
                      your review.
                    </p>
                    {learning.lessons.length === 0 && <p>No lessons yet.</p>}
                    {learning.lessons.map((l) => (
                      <article key={l.id}>
                        <p>{l.lesson}</p>
                        <small>
                          Evidence: run #{l.run_id} · confidence{' '}
                          {Math.round(l.confidence * 100)}%
                        </small>
                        <div className="wf-toolbar">
                          <button
                            onClick={() =>
                              void act(async () => {
                                const lesson = window.prompt(
                                  'Correct this lesson',
                                  l.lesson,
                                );
                                if (lesson?.trim()) {
                                  await workflowApi(
                                    '/lessons/' + l.id,
                                    'PATCH',
                                    { lesson },
                                  );
                                  await load();
                                }
                              })
                            }
                          >
                            Correct
                          </button>
                          <button
                            onClick={() =>
                              void act(async () => {
                                await workflowApi('/lessons/' + l.id, 'PATCH', {
                                  active: false,
                                });
                                await load();
                              })
                            }
                          >
                            Forget
                          </button>
                        </div>
                      </article>
                    ))}
                  </section>
                  <section className="wf-panel">
                    <h2>Proposed improvements</h2>
                    {learning.proposals.length === 0 && (
                      <p>No proposals yet.</p>
                    )}
                    {learning.proposals.map((p) => (
                      <article key={p.id}>
                        <p>{p.reason}</p>
                        <small>
                          Run #{p.run_id} · based on revision {p.base_revision}{' '}
                          · {p.status}
                        </small>
                        <details>
                          <summary>Compare current and proposed plan</summary>
                          <h3>Current</h3>
                          <pre>
                            {JSON.stringify(workflow.definition, null, 2)}
                          </pre>
                          <h3>Proposed</h3>
                          <pre>{JSON.stringify(p.definition, null, 2)}</pre>
                        </details>
                        {p.status === 'pending' && (
                          <div className="wf-toolbar">
                            <button
                              disabled={
                                busy ||
                                p.base_revision !== workflow.activeRevision
                              }
                              onClick={() =>
                                void act(async () => {
                                  await workflowApi(
                                    '/proposals/' + p.id + '/accept',
                                    'POST',
                                  );
                                  await load();
                                })
                              }
                            >
                              Accept revision
                            </button>
                            <button
                              disabled={busy}
                              onClick={() =>
                                void act(async () => {
                                  await workflowApi(
                                    '/proposals/' + p.id + '/reject',
                                    'POST',
                                  );
                                  await load();
                                })
                              }
                            >
                              Reject
                            </button>
                            {p.base_revision !== workflow.activeRevision && (
                              <small>
                                This proposal is stale; it cannot replace newer
                                edits.
                              </small>
                            )}
                          </div>
                        )}
                      </article>
                    ))}
                  </section>
                  <section className="wf-panel">
                    <h2>Revision history</h2>
                    {learning.revisions.map((r) => (
                      <div className="wf-toolbar" key={r.version}>
                        <span>Revision {r.version}</span>
                        <button
                          disabled={
                            busy || r.version === workflow.activeRevision
                          }
                          onClick={() =>
                            void act(async () => {
                              await workflowApi('/' + workflowId, 'PATCH', {
                                definition: r.definition,
                                expectedRevision: workflow.activeRevision,
                                enabled: workflow.enabled,
                              });
                              await load();
                              setNotice('Restored as a new revision.');
                            })
                          }
                        >
                          Restore
                        </button>
                      </div>
                    ))}
                  </section>
                </>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
