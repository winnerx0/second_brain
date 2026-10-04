/// <reference types="vite/client" />
import type { ReactNode } from 'react';
import {
  Outlet,
  Link,
  createRootRoute,
  HeadContent,
  Scripts,
} from '@tanstack/react-router';

import '../styles.css';
import { SidebarProvider } from '../contexts/sidebar-context';
import { ThemeProvider } from '../contexts/theme-context';
import { PwaPrompt } from '../components/pwa-prompt';

const THEME_INIT_SCRIPT = `(function(){try{var s=localStorage.getItem('aira:theme');var t=(s==='dark'||s==='light')?s:(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content:
          'width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover',
      },
      { name: 'theme-color', content: '#a86828' },
      { name: 'mobile-web-app-capable', content: 'yes' },
      {
        name: 'apple-mobile-web-app-capable',
        content: 'yes',
      },
      {
        name: 'apple-mobile-web-app-status-bar-style',
        content: 'black-translucent',
      },
      { name: 'apple-mobile-web-app-title', content: 'Aira' },
      { title: 'Aira' },
    ],
    links: [
      { rel: 'manifest', href: '/manifest.webmanifest' },
      {
        rel: 'icon',
        href: '/icon.svg',
        type: 'image/svg+xml',
      },
      {
        rel: 'icon',
        href: '/icon-192.png',
        type: 'image/png',
        sizes: '192x192',
      },
      {
        rel: 'icon',
        href: '/icon-512.png',
        type: 'image/png',
        sizes: '512x512',
      },
      {
        rel: 'apple-touch-icon',
        href: '/apple-touch-icon.png',
        sizes: '180x180',
      },
    ],
  }),
  component: RootComponent,
  notFoundComponent: NotFound,
});

function RootComponent() {
  return (
    <RootDocument>
      <ThemeProvider>
        <SidebarProvider>
          <Outlet />
        </SidebarProvider>
      </ThemeProvider>
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <script
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
        />
      </head>
      <body>
        {children}
        <PwaPrompt />
        <Scripts />
      </body>
    </html>
  );
}

function NotFound() {
  return (
    <div
      style={{
        padding: '2rem',
        fontFamily: 'Inter, sans-serif',
        color: 'hsl(var(--foreground))',
      }}
    >
      <h1 style={{ marginBottom: '0.5rem' }}>Page not found</h1>
      <p
        style={{
          marginBottom: '1rem',
          color: 'hsl(var(--muted-foreground))',
        }}
      >
        The route you requested does not exist.
      </p>
      <Link to="/">Go back to chat</Link>
    </div>
  );
}
