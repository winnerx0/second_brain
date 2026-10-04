import { createRoute, Outlet } from '@tanstack/react-router';
import { Route as RootRoute } from './__root';
export { WORKFLOWS_URL } from '../lib/workflows';
export type { Workflow } from '../lib/workflows';
export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workflows',
  component: () => <Outlet />,
});
