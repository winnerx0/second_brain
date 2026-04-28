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

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
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
      { rel: 'apple-touch-icon', href: '/icon.svg' },
    ],
  }),
  component: RootComponent,
  notFoundComponent: NotFound,
});

function RootComponent() {
  return (
    <RootDocument>
      <SidebarProvider>
        <Outlet />
      </SidebarProvider>
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
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
