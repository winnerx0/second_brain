import { Link } from '@tanstack/react-router';
import { type ReactNode } from 'react';
import { useSidebar } from '../contexts/sidebar-context';
import { ThemeToggle } from './theme-toggle';

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

function PanelLeftIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
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

function ChatIcon() {
  return (
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
  );
}

function MemoriesIcon() {
  return (
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
  );
}

function ConnectionsIcon() {
  return (
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
  );
}

function WorkflowsIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
    </svg>
  );
}

interface AppSidebarProps {
  children?: ReactNode;
  onNewChat?: () => void;
}

export function AppSidebar({ children, onNewChat }: AppSidebarProps) {
  const { open, toggle } = useSidebar();

  return (
    <>
      {open && (
        <div
          className="sidebar-backdrop"
          onClick={toggle}
          aria-hidden="true"
        />
      )}

      <aside
        className="sidebar"
        data-state={open ? 'expanded' : 'collapsed'}
        aria-label="Navigation"
        aria-hidden={!open}
      >
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <div className="sidebar-logo">
              <BrainIcon />
            </div>
            <span className="sidebar-brand-name">Aira</span>
          </div>
          <div className="sidebar-header-actions">
            <ThemeToggle className="sidebar-new-btn" />
            {onNewChat && (
              <button
                type="button"
                className="sidebar-new-btn"
                aria-label="New chat"
                onClick={onNewChat}
              >
                <PlusIcon />
              </button>
            )}
            <button
              type="button"
              className="sidebar-close-btn"
              aria-label="Toggle sidebar"
              onClick={toggle}
            >
              <PanelLeftIcon />
            </button>
          </div>
        </div>

        {children}

        <div style={{ height: '12px' }} />
        <div className="sidebar-section-label">Views</div>

        <Link
          to="/"
          className="sidebar-nav-item"
          activeProps={{ className: 'sidebar-nav-item active' }}
          activeOptions={{ exact: true }}
        >
          <ChatIcon />
          Chat
        </Link>

        <Link
          to="/memories"
          className="sidebar-nav-item"
          activeProps={{ className: 'sidebar-nav-item active' }}
        >
          <MemoriesIcon />
          Memories
        </Link>

        <Link
          to="/connections"
          className="sidebar-nav-item"
          activeProps={{ className: 'sidebar-nav-item active' }}
        >
          <ConnectionsIcon />
          Connections
        </Link>

        <Link
          to="/workflows"
          className="sidebar-nav-item"
          activeProps={{ className: 'sidebar-nav-item active' }}
        >
          <WorkflowsIcon />
          Workflows
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
    </>
  );
}

export function SidebarTrigger() {
  const { open, toggle } = useSidebar();

  if (open) return null;

  return (
    <button
      type="button"
      className="sidebar-trigger"
      onClick={toggle}
      aria-label="Open sidebar"
      title="Open sidebar (⌘B)"
    >
      <PanelLeftIcon />
    </button>
  );
}
