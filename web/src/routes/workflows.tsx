import { createRoute, Outlet } from '@tanstack/react-router';
import { Route as RootRoute } from './__root';

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workflows',
  component: WorkflowsLayout,
});

export type Workflow = {
  id: number;
  name: string;
  description: string;
  plan: string;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
export const WORKFLOWS_URL = `${API_BASE.replace(/\/$/, '')}/workflows`;

function WorkflowsLayout() {
  return <Outlet />;
}
