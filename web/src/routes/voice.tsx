import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { AppSidebar, SidebarTrigger } from '../components/app-sidebar';
import { AiraMark } from '../components/aira-mark';
import { VoiceSession, type VoiceState } from '../lib/deepgram-voice';

export const Route = createFileRoute('/voice')({
  component: Voice,
});

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const SESSIONS_URL = `${API_BASE.replace(/\/$/, '')}/sessions`;

type Line = { id: string; role: 'user' | 'assistant'; content: string };

const STATE_LABEL: Record<VoiceState, string> = {
  idle: 'Tap to talk',
  connecting: 'Connecting…',
  listening: 'Listening…',
  thinking: 'Aira is thinking…',
  speaking: 'Aira is speaking…',
  error: 'Something went wrong',
};

async function createSession(): Promise<number> {
  const res = await fetch(SESSIONS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Voice chat' }),
  });
  if (!res.ok) throw new Error(`Unable to create session (${res.status})`);
  const data = (await res.json()) as { session: { id: number } };
  return data.session.id;
}

function Voice() {
  const [state, setState] = useState<VoiceState>('idle');
  const [transcript, setTranscript] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<VoiceSession | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() =>
      endRef.current?.scrollIntoView({ behavior: 'smooth' }),
    );
    return () => cancelAnimationFrame(id);
  }, [transcript]);

  useEffect(() => {
    return () => sessionRef.current?.stop();
  }, []);

  const active = state !== 'idle' && state !== 'error';

  const start = async () => {
    setError(null);
    setTranscript([]);
    try {
      const sessionId = await createSession();
      const session = new VoiceSession(API_BASE, sessionId, {
        onState: setState,
        onError: (msg) => setError(msg),
        onTranscript: (role, content) =>
          setTranscript((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role, content },
          ]),
      });
      sessionRef.current = session;
      await session.start();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState('error');
    }
  };

  const stop = () => {
    sessionRef.current?.stop();
    sessionRef.current = null;
    setState('idle');
  };

  const toggle = () => {
    if (active) stop();
    else void start();
  };

  return (
    <div className="app-shell">
      <AppSidebar />

      <div className="chat-container">
        <div className="chat-header">
          <div className="chat-header-left">
            <SidebarTrigger />
            <span className="chat-header-title">Aira · Voice</span>
          </div>
          <span className="chat-header-badge">
            <span className={`chat-header-dot${active ? '' : ' idle'}`} />
            {STATE_LABEL[state]}
          </span>
        </div>

        <main className="messages-area">
          <div className="voice-stage">
            <button
              type="button"
              className={`voice-orb voice-orb-${state}`}
              onClick={toggle}
              aria-label={active ? 'End voice conversation' : 'Start voice conversation'}
            >
              <span className="voice-orb-inner">
                <AiraMark />
              </span>
            </button>
            <p className="voice-status">{STATE_LABEL[state]}</p>
            <p className="voice-hint">
              {active
                ? 'Just talk — interrupt any time and Aira will stop and listen.'
                : 'Start a hands-free conversation with Aira.'}
            </p>
            {error ? <p className="voice-error">⚠ {error}</p> : null}
          </div>

          {transcript.length > 0 ? (
            <div className="voice-transcript">
              {transcript.map((line) => (
                <div key={line.id} className={`voice-line voice-line-${line.role}`}>
                  <span className="voice-line-role">
                    {line.role === 'user' ? 'You' : 'Aira'}
                  </span>
                  <span className="voice-line-text">{line.content}</span>
                </div>
              ))}
              <div ref={endRef} />
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}
