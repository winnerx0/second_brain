import { createRoute, Link } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Route as RootRoute } from './__root';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Textarea } from '../components/ui/textarea';

/* ─── Types ──────────────────────────────────────────────────────────────── */
type StreamEvent =
  | { type: 'status'; message: string }
  | { type: 'assistant_delta'; delta: string }
  | { type: 'tool_start'; tool: string; input: string }
  | { type: 'tool_end'; tool: string; output: string }
  | { type: 'error'; message: string }
  | { type: 'final'; text: string };

type ThreadItem =
  | { id: string; kind: 'user'; content: string }
  | { id: string; kind: 'assistant'; content: string }
  | {
      id: string;
      kind: 'tool';
      name: string;
      input: string;
      output?: string;
      status: 'running' | 'done' | 'error';
    };

type Session = {
  id: number;
  title: string;
  createdAt: string;
  updatedAt: string;
};

type SessionsResponse = {
  sessions: Session[];
};

type CreateSessionResponse = {
  session: Session;
};

type HistoryMessage = {
  id: number;
  role: string;
  content: string;
  createdAt: string;
};

type SessionHistoryResponse = {
  messages: HistoryMessage[];
};

/* ─── Constants ──────────────────────────────────────────────────────────── */
const SUGGESTIONS = [
  'What should I focus on today?',
  'Summarize my latest GitHub activity.',
  'What meetings or deadlines are coming up?',
  'Show me a summary of my recent notes.',
];

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const STREAM_URL = `${API_BASE.replace(/\/$/, '')}/chat/stream`;
const SESSIONS_URL = `${API_BASE.replace(/\/$/, '')}/sessions`;

/* ─── Stream reader ──────────────────────────────────────────────────────── */
async function readStream(
  response: Response,
  onEvent: (e: StreamEvent) => void,
) {
  if (!response.body) throw new Error('Missing response body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];

  const flush = () => {
    if (!dataLines.length) return;
    onEvent(JSON.parse(dataLines.join('\n')) as StreamEvent);
    dataLines = [];
  };

  while (true) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });

    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const raw = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (raw === '') flush();
      else if (raw.startsWith('data:'))
        dataLines.push(raw.slice(5).trimStart());
      idx = buffer.indexOf('\n');
    }

    if (done) break;
  }

  if (buffer.trim()) {
    for (const line of buffer.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
  }
  flush();
}

function formatJson(str: string) {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('');
  }

  return '';
}

function mapHistoryToThread(messages: HistoryMessage[]): ThreadItem[] {
  return messages.flatMap((message): ThreadItem[] => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.content);
    } catch {
      return [];
    }

    if (!parsed || typeof parsed !== 'object') return [];

    if (message.role === 'human') {
      const content = extractTextContent(
        (parsed as { content?: unknown }).content,
      ).trim();
      if (!content) return [];
      return [
        {
          id: `h-${message.id}`,
          kind: 'user',
          content,
        },
      ];
    }

    if (message.role === 'ai' || message.role === 'assistant') {
      const content = extractTextContent(
        (parsed as { content?: unknown }).content,
      ).trim();
      if (!content) return [];
      return [
        {
          id: `a-${message.id}`,
          kind: 'assistant',
          content,
        },
      ];
    }

    return [];
  });
}

/* ─── Route ──────────────────────────────────────────────────────────────── */
export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/',
  component: Chat,
});

/* ─── Icons ──────────────────────────────────────────────────────────────── */
function SendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg
      className="tool-spinner"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function BrainIcon() {
  return (
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
  );
}

/** Maps tool names to icons. */
function ToolIcon({ tool }: { tool: string }) {
  const t = tool.toLowerCase();

  if (t.includes('search') || t.includes('grep') || t.includes('find'))
    return (
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" />
      </svg>
    );

  if (
    t.includes('read') ||
    t.includes('file') ||
    t.includes('document') ||
    t.includes('view')
  )
    return (
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14 2z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
    );

  if (
    t.includes('write') ||
    t.includes('edit') ||
    t.includes('create') ||
    t.includes('replace')
  )
    return (
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      >
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    );

  if (
    t.includes('bash') ||
    t.includes('shell') ||
    t.includes('exec') ||
    t.includes('run') ||
    t.includes('command')
  )
    return (
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      >
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" x2="20" y1="19" y2="19" />
      </svg>
    );

  if (
    t.includes('web') ||
    t.includes('fetch') ||
    t.includes('http') ||
    t.includes('url') ||
    t.includes('browse')
  )
    return (
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="2" x2="22" y1="12" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    );

  if (t.includes('notion'))
    return (
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      >
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="M9 9h6M9 12h6M9 15h4" />
      </svg>
    );

  if (t.includes('memory') || t.includes('recall') || t.includes('store'))
    return (
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      >
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
        <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
      </svg>
    );

  if (t.includes('github') || t.includes('git'))
    return (
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      >
        <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.2c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
        <path d="M9 18c-4.51 2-5-2-7-2" />
      </svg>
    );

  if (t.includes('calendar'))
    return (
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      >
        <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
        <line x1="16" x2="16" y1="2" y2="6" />
        <line x1="8" x2="8" y1="2" y2="6" />
        <line x1="3" x2="21" y1="10" y2="10" />
      </svg>
    );

  if (t.includes('gmail') || t.includes('mail') || t.includes('email'))
    return (
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      >
        <rect width="20" height="16" x="2" y="4" rx="2" />
        <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
      </svg>
    );

  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

/* ─── Asterisk icon ──────────────────────────────────────────────────────── */
function AsteriskIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg
      className={spinning ? 'asterisk-spin' : undefined}
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  );
}

/** Pull a short label from tool input JSON to show as a badge chip */
function extractBadge(input: string): string | null {
  try {
    const obj = JSON.parse(input) as Record<string, unknown>;
    for (const key of [
      'path',
      'file',
      'filename',
      'name',
      'query',
      'url',
      'command',
      'script',
      'text',
      'value',
    ]) {
      const val = obj[key];
      if (typeof val === 'string' && val.length > 0) {
        const short = val.split(/[\\/]/).pop() ?? val;
        return short.length > 48 ? short.slice(0, 48) + '…' : short;
      }
    }
    for (const val of Object.values(obj)) {
      if (typeof val === 'string' && val.length > 0) {
        return val.length > 48 ? val.slice(0, 48) + '…' : val;
      }
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/* ─── Markdown message component ─────────────────────────────────────────── */
function MarkdownMessage({
  content,
  isStreaming,
}: {
  content: string;
  isStreaming?: boolean;
}) {
  return (
    <div className={`message-markdown${isStreaming ? ' typing-cursor' : ''}`}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <pre className="code-block">{children}</pre>,
          code: ({ className, children, ...props }) => {
            // Block code is handled by the pre wrapper above
            // Inline code has no pre parent
            const isBlock = String(children).includes('\n');
            if (isBlock) {
              return (
                <code className={className ?? ''} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code className="inline-code" {...props}>
                {children}
              </code>
            );
          },
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}

/* ─── Flat tool row ──────────────────────────────────────────────────────── */
function ToolRow({
  name,
  input,
  status,
}: {
  name: string;
  input: string;
  status: 'running' | 'done' | 'error';
}) {
  const badge = extractBadge(input);

  const isGenericName = name === 'tool' || name.includes('mcp');
  const displayName = isGenericName && badge ? badge : name;
  const showBadge = !isGenericName && badge;

  return (
    <div className={`tool-row ${status}`}>
      <span className="tool-row-icon">
        {status === 'running' ? <Spinner /> : <ToolIcon tool={displayName} />}
      </span>
      <span className="tool-row-body">
        <span className="tool-row-name">{displayName}</span>
        {showBadge && <span className="tool-row-badge">{badge}</span>}
      </span>
    </div>
  );
}

/* ─── Thread grouper ─────────────────────────────────────────────────────── */
type ToolSegment = {
  kind: 'tools';
  key: string;
  items: Extract<ThreadItem, { kind: 'tool' }>[];
};
type UserSegment = {
  kind: 'user';
  item: Extract<ThreadItem, { kind: 'user' }>;
};
type AssistantSegment = {
  kind: 'assistant';
  item: Extract<ThreadItem, { kind: 'assistant' }>;
};
type Segment = ToolSegment | UserSegment | AssistantSegment;

function groupThread(thread: ThreadItem[]): Segment[] {
  const segments: Segment[] = [];
  let i = 0;
  while (i < thread.length) {
    const item = thread[i];
    if (!item) {
      i++;
      continue;
    }

    if (item.kind === 'tool') {
      const tools: Extract<ThreadItem, { kind: 'tool' }>[] = [];
      while (i < thread.length && thread[i]?.kind === 'tool') {
        const t = thread[i];
        if (t?.kind === 'tool') tools.push(t);
        i++;
      }
      if (tools.length > 0) {
        segments.push({
          kind: 'tools',
          key: tools[0]!.id,
          items: tools,
        });
      }
      continue;
    }

    if (item.kind === 'user') {
      segments.push({ kind: 'user', item });
    } else if (item.kind === 'assistant') {
      segments.push({ kind: 'assistant', item });
    }
    i++;
  }
  return segments;
}

/* ─── Main chat component ────────────────────────────────────────────────── */

function Chat() {
  const [thread, setThread] = useState<ThreadItem[]>([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('Ready');
  const [isStreaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<number | null>(null);
  const [isSessionsLoading, setIsSessionsLoading] = useState(true);

  const toolStackRef = useRef<string[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const loadSessions = async () => {
    const response = await fetch(SESSIONS_URL);
    if (!response.ok) {
      throw new Error(`Unable to load sessions (${response.status})`);
    }
    const data = (await response.json()) as SessionsResponse;
    return data.sessions ?? [];
  };

  const createSession = async (title = 'New Chat') => {
    const response = await fetch(SESSIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) {
      throw new Error(`Unable to create session (${response.status})`);
    }
    const data = (await response.json()) as CreateSessionResponse;
    return data.session;
  };

  const removeSession = async (sessionId: number) => {
    const response = await fetch(`${SESSIONS_URL}/${sessionId}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      throw new Error(`Unable to delete session (${response.status})`);
    }
  };

  const loadSessionHistory = async (sessionId: number) => {
    const response = await fetch(`${SESSIONS_URL}/${sessionId}/history`);
    if (!response.ok) {
      throw new Error(`Unable to load chat history (${response.status})`);
    }
    const data = (await response.json()) as SessionHistoryResponse;
    return mapHistoryToThread(data.messages ?? []);
  };

  useEffect(() => {
    let active = true;

    const initSessions = async () => {
      setIsSessionsLoading(true);
      try {
        const existing = await loadSessions();
        if (!active) return;

        if (existing.length > 0) {
          setSessions(existing);
          setCurrentSessionId(existing[0]!.id);
          return;
        }

        const created = await createSession('Session 1');
        if (!active) return;
        setSessions([created]);
        setCurrentSessionId(created.id);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (active) {
          setIsSessionsLoading(false);
        }
      }
    };

    void initSessions();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!currentSessionId) {
      setThread([]);
      return;
    }

    let active = true;
    setError(null);

    const loadHistory = async () => {
      try {
        const history = await loadSessionHistory(currentSessionId);
        if (!active) return;
        setThread(history);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    void loadHistory();
    return () => {
      active = false;
    };
  }, [currentSessionId]);

  /* Auto-resize textarea */
  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
  }, [input]);

  /* Scroll to bottom */
  useEffect(() => {
    endRef.current?.scrollIntoView({
      block: 'end',
      behavior: 'smooth',
    });
  }, [thread, isStreaming]);

  /* Helpers */
  const updateItem = (id: string, fn: (item: ThreadItem) => ThreadItem) =>
    setThread((t) => t.map((i) => (i.id === id ? fn(i) : i)));

  const appendAssistantDelta = (delta: string) => {
    setThread((t) => {
      // Find the last assistant message (it may not be the last item if tools ran)
      const lastAssistantIndex = t.findLastIndex(
        (item): item is Extract<ThreadItem, { kind: 'assistant' }> =>
          item.kind === 'assistant',
      );

      if (lastAssistantIndex >= 0) {
        const next = [...t];
        const assistant = t[lastAssistantIndex]!;
        next[lastAssistantIndex] = {
          ...assistant,
          content: assistant.content + delta,
        };
        return next;
      }

      // No assistant exists yet, create one
      return [
        ...t,
        {
          id: crypto.randomUUID(),
          kind: 'assistant',
          content: delta,
        },
      ];
    });
  };

  const pushTool = (name: string, inputVal: string) => {
    const id = crypto.randomUUID();
    toolStackRef.current.push(id);
    setThread((t) => [
      ...t,
      {
        id,
        kind: 'tool',
        name,
        input: inputVal,
        status: 'running',
      },
    ]);
  };

  const finishTool = (s: 'done' | 'error', output: string) => {
    const id = toolStackRef.current.pop();
    if (!id) return;
    updateItem(id, (item) => {
      if (item.kind !== 'tool') return item;
      return { ...item, status: s, output };
    });
  };

  const handleCreateSession = async () => {
    if (isStreaming) return;
    try {
      const created = await createSession(`Session ${sessions.length + 1}`);
      setSessions((prev) => [created, ...prev]);
      setCurrentSessionId(created.id);
      setThread([]);
      setInput('');
      setError(null);
      setStatus('Ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteSession = async (sessionId: number) => {
    if (isStreaming) return;
    try {
      await removeSession(sessionId);
      const next = sessions.filter((session) => session.id !== sessionId);

      if (next.length > 0) {
        setSessions(next);
        if (currentSessionId === sessionId) {
          setCurrentSessionId(next[0]!.id);
          setThread([]);
        }
        return;
      }

      const created = await createSession('Session 1');
      setSessions([created]);
      setCurrentSessionId(created.id);
      setThread([]);
      setInput('');
      setStatus('Ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSelectSession = (sessionId: number) => {
    if (isStreaming || sessionId === currentSessionId) return;
    setCurrentSessionId(sessionId);
    setInput('');
    setError(null);
    setStatus('Ready');
  };

  /* Submit */
  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    if (!currentSessionId) {
      setError('No active session selected.');
      return;
    }

    setInput('');
    setError(null);
    toolStackRef.current = [];
    setStreaming(true);
    setStatus('Thinking…');

    setThread((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        kind: 'user',
        content: trimmed,
      },
    ]);

    try {
      const res = await fetch(STREAM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: trimmed,
          sessionId: currentSessionId,
        }),
      });

      if (!res.ok) throw new Error(`Request failed: ${res.status}`);

      await readStream(res, (event) => {
        switch (event.type) {
          case 'status':
            setStatus(event.message);
            break;

          case 'assistant_delta':
            appendAssistantDelta(event.delta);
            break;

          case 'tool_start':
            setStatus(`Using ${event.tool}…`);
            pushTool(event.tool, event.input);
            break;

          case 'tool_end':
            setStatus('Done');
            finishTool('done', event.output);
            break;

          case 'error':
            setStatus('Error');
            setError(event.message);
            finishTool('error', event.message);
            appendAssistantDelta(`\n\nSomething went wrong: ${event.message}`);
            break;

          case 'final':
            setStatus('Done');
            break;
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStatus('Error');
      appendAssistantDelta(`\n\nStream failed: ${msg}`);
    } finally {
      setStreaming(false);
    }
  };

  const hasThread = thread.length > 0;

  return (
    <div className="app-shell">
      {/* ── Sidebar ───────────────────────────────────────────────────── */}
      <aside className="sidebar" aria-label="Navigation">
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <div className="sidebar-logo">
              <BrainIcon />
            </div>
            Aira
          </div>
          <button
            type="button"
            className="sidebar-new-btn"
            aria-label="New chat"
            onClick={() => {
              void handleCreateSession();
            }}
          >
            <PlusIcon />
          </button>
        </div>

        <div className="sidebar-section-label">Sessions</div>

        {isSessionsLoading ? (
          <div
            className="sidebar-nav-item"
            style={{
              color: 'var(--fg-muted)',
              fontSize: '0.78rem',
            }}
          >
            Loading…
          </div>
        ) : null}

        {!isSessionsLoading && sessions.length === 0 ? (
          <div
            className="sidebar-nav-item"
            style={{
              color: 'var(--fg-muted)',
            }}
          >
            No sessions
          </div>
        ) : null}

        {sessions.map((session) => (
          <div key={session.id} className="sidebar-session-row">
            <button
              type="button"
              className={`sidebar-nav-item${currentSessionId === session.id ? ' active' : ''}`}
              onClick={() => handleSelectSession(session.id)}
            >
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
              {session.title}
            </button>
            <button
              type="button"
              className="sidebar-session-delete"
              aria-label={`Delete ${session.title}`}
              onClick={() => {
                void handleDeleteSession(session.id);
              }}
            >
              <XIcon />
            </button>
          </div>
        ))}

        <div style={{ height: '12px' }} />

        <div className="sidebar-section-label">Views</div>

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

        <Link to="/connections" className="sidebar-nav-item">
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

      {/* ── Chat area ─────────────────────────────────────────────────── */}
      <div className="chat-container">
        <div className="chat-header">
          <span className="chat-header-title">Aira</span>
          <span className="chat-header-badge">
            <span className={`chat-header-dot${isStreaming ? '' : ' idle'}`} />
            {isStreaming ? status : 'Ready'}
          </span>
        </div>

        {/* Messages */}
        <main className="messages-area">
          {!hasThread ? (
            <div className="welcome-container">
              <h1 className="welcome-title">Good to see you.</h1>
              <p className="welcome-subtitle">
                Ask me about your work, notes, or schedule — I'll pull from your
                tools and think it through with you.
              </p>
              <div className="suggestion-grid">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="suggestion-chip"
                    onClick={() => setInput(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="message-list">
              {groupThread(thread).map((seg) => {
                if (seg.kind === 'tools') {
                  const anyRunning = seg.items.some(
                    (t) => t.status === 'running',
                  );
                  return (
                    <div key={seg.key} className="tools-group">
                      <div className="tools-group-header">
                        <AsteriskIcon spinning={anyRunning} />
                        <span>{anyRunning ? 'Working…' : 'Used tools'}</span>
                      </div>
                      {seg.items.map((t) => (
                        <ToolRow
                          key={t.id}
                          name={t.name}
                          input={t.input}
                          status={t.status}
                        />
                      ))}
                    </div>
                  );
                }

                if (seg.kind === 'user') {
                  return (
                    <div key={seg.item.id} className="message-row user">
                      <div className="user-bubble">{seg.item.content}</div>
                    </div>
                  );
                }

                const item = seg.item;
                const isCurrentlyStreaming =
                  isStreaming && item.id === thread[thread.length - 1]?.id;

                return (
                  <div key={item.id} className="message-row assistant">
                    <div className="assistant-row">
                      <div className="assistant-avatar">
                        <BrainIcon />
                      </div>
                      <div className="assistant-body">
                        <div className="assistant-name">Aira</div>
                        {item.content ? (
                          <MarkdownMessage
                            content={item.content}
                            isStreaming={isCurrentlyStreaming}
                          />
                        ) : (
                          <div className="message-text thinking">Thinking…</div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

              {isStreaming &&
                (!thread.length ||
                  thread[thread.length - 1]?.kind !== 'assistant') && (
                  <div className="message-row assistant">
                    <div className="assistant-row">
                      <div className="assistant-avatar">
                        <BrainIcon />
                      </div>
                      <div className="assistant-body">
                        <div className="assistant-name">Aira</div>
                        <div className="message-text thinking">Thinking…</div>
                      </div>
                    </div>
                  </div>
                )}

              <div ref={endRef} />
            </div>
          )}
        </main>

        {/* Input bar */}
        <div className="input-area flex w-full items-center justify-center">
          <form
            onSubmit={handleSubmit}
            className="input-container w-full max-w-200"
          >
            <div className="input-wrapper max-w-200">
              <label className="sr-only" htmlFor="prompt">
                Message
              </label>
              <Textarea
                ref={textareaRef}
                id="prompt"
                className="input-textarea"
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onInput={(e) => {
                  const t = e.currentTarget;
                  t.style.height = 'auto';
                  t.style.height = `${t.scrollHeight}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (input.trim() && !isStreaming)
                      e.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="Message Aira…"
                disabled={isStreaming}
              />
              <button
                type="submit"
                className="send-button"
                disabled={isStreaming || !input.trim()}
                aria-label="Send message"
              >
                <SendIcon />
              </button>
            </div>
            <div className="input-footer">
              {error
                ? `⚠ ${error}`
                : isStreaming
                  ? status
                  : 'Enter to send · Shift+Enter for new line'}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
