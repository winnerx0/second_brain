import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { Button } from './ui/button';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function PwaPrompt() {
  const [mounted, setMounted] = useState(false);
  const [installEvent, setInstallEvent] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [installDismissed, setInstallDismissed] = useState(false);

  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(error) {
      console.error('SW registration failed', error);
    },
  });

  useEffect(() => {
    setMounted(true);
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    const onInstalled = () => setInstallEvent(null);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!mounted) return null;

  const showUpdate = needRefresh;
  const showInstall = !!installEvent && !installDismissed;
  if (!showUpdate && !showInstall) return null;

  return (
    <div
      role="region"
      aria-label="App notifications"
      style={{
        position: 'fixed',
        bottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        maxWidth: 'min(28rem, calc(100vw - 2rem))',
        width: 'calc(100vw - 2rem)',
      }}
    >
      {showUpdate && (
        <div
          style={{
            background: '#1a1a1a',
            color: 'white',
            borderRadius: '0.75rem',
            padding: '0.75rem 1rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.75rem',
            boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
          }}
        >
          <span style={{ fontSize: '0.875rem' }}>A new version is ready.</span>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <Button
              variant="ghost"
              onClick={() => setNeedRefresh(false)}
              style={{ color: 'white' }}
            >
              Later
            </Button>
            <Button onClick={() => updateServiceWorker(true)}>Reload</Button>
          </div>
        </div>
      )}

      {showInstall && (
        <div
          style={{
            background: '#1a1a1a',
            color: 'white',
            borderRadius: '0.75rem',
            padding: '0.75rem 1rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.75rem',
            boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
          }}
        >
          <span style={{ fontSize: '0.875rem' }}>Install Aira on this device?</span>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <Button
              variant="ghost"
              onClick={() => setInstallDismissed(true)}
              style={{ color: 'white' }}
            >
              Not now
            </Button>
            <Button
              onClick={async () => {
                if (!installEvent) return;
                await installEvent.prompt();
                await installEvent.userChoice;
                setInstallEvent(null);
              }}
            >
              Install
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
