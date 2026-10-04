import { useState } from 'react';
import {
  workflowApi,
  type Workflow,
  type WorkflowDefinition,
} from '../lib/workflows';

export function WorkflowComposer({
  onSaved,
  existing,
}: {
  onSaved: (workflow: Workflow) => void;
  existing?: Workflow;
}) {
  const [instructions, setInstructions] = useState(existing?.plan ?? '');
  const [questions, setQuestions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await workflowApi<{
        definition: WorkflowDefinition | null;
        clarifications: string[];
      }>('/plan', 'POST', { instructions });
      setQuestions(result.clarifications);
      if (result.definition) {
        const saved = await workflowApi<Workflow>(
          existing ? `/${existing.id}` : '',
          existing ? 'PATCH' : 'POST',
          {
            definition: result.definition,
            expectedRevision: existing?.activeRevision,
            enabled: existing?.enabled ?? true,
          },
        );
        onSaved(saved);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="wf-panel wf-composer">
      <h2>
        {existing ? 'Revise this automation' : 'What should Aira take care of?'}
      </h2>
      <p>
        Describe the task and when it should happen. Aira will build the steps
        and activate clear requests.
      </p>
      {!existing && (
        <div className="wf-examples">
          {[
            'Every weekday at 8am, summarize my GitHub PRs and calendar, then send it to Telegram.',
            'Every Friday at 5pm, summarize my open GitHub issues.',
          ].map((example) => (
            <button key={example} onClick={() => setInstructions(example)}>
              {example}
            </button>
          ))}
        </div>
      )}
      <label htmlFor="workflow-instructions">Instructions</label>
      <textarea
        id="workflow-instructions"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        rows={5}
        placeholder="Every morning at 8am…"
        disabled={busy}
      />
      {questions.length > 0 && (
        <div className="wf-notice">
          <strong>A few details are needed</strong>
          <ul>
            {questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
          <p>Add your answers to the instructions above, then submit again.</p>
        </div>
      )}
      {error && (
        <p role="alert" className="wf-error">
          {error}
        </p>
      )}
      <button
        className="wf-primary"
        disabled={busy || !instructions.trim()}
        onClick={() => void submit()}
      >
        {busy
          ? 'Building workflow…'
          : existing
            ? 'Save revised workflow'
            : 'Create & activate'}
      </button>
    </section>
  );
}
