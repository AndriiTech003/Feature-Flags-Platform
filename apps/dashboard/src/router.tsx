import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { getToken } from './lib/api';
import { ProjectLayout, RootRedirect } from './components/layout';
import { Skeleton } from './components/ui/primitives';
import { LoginPage } from './pages/login';

const rootRoute = createRootRoute({ component: Outlet });

const requireAuth = () => {
  if (!getToken()) throw redirect({ to: '/login' });
};

const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login', component: LoginPage });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: requireAuth,
  component: RootRedirect,
});
export const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$project',
  beforeLoad: requireAuth,
  component: ProjectLayout,
});

const envSearch = (search: Record<string, unknown>): { env?: string } =>
  typeof search.env === 'string' ? { env: search.env } : {};

export const flagsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/flags',
  component: lazyRouteComponent(() => import('./pages/flags-list'), 'FlagsListPage'),
});
export const flagRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/flags/$flag',
  validateSearch: (search: Record<string, unknown>): { env?: string; tab?: string } => ({
    ...envSearch(search),
    ...(typeof search.tab === 'string' ? { tab: search.tab } : {}),
  }),
  component: lazyRouteComponent(() => import('./pages/flag-detail'), 'FlagDetailPage'),
});
export const compareRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/compare',
  component: lazyRouteComponent(() => import('./pages/compare'), 'ComparePage'),
});
export const segmentsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/segments',
  validateSearch: envSearch,
  component: lazyRouteComponent(() => import('./pages/segments'), 'SegmentsPage'),
});
export const experimentsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/experiments',
  component: lazyRouteComponent(() => import('./pages/experiments'), 'ExperimentsPage'),
});
export const experimentRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/experiments/$experiment',
  component: lazyRouteComponent(() => import('./pages/experiment-detail'), 'ExperimentDetailPage'),
});
export const changeRequestsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/change-requests',
  validateSearch: (search: Record<string, unknown>): { id?: string } =>
    typeof search.id === 'string' ? { id: search.id } : {},
  component: lazyRouteComponent(() => import('./pages/change-requests'), 'ChangeRequestsPage'),
});
export const scheduledRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/scheduled',
  component: lazyRouteComponent(() => import('./pages/scheduled'), 'ScheduledPage'),
});
export const auditRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/audit',
  component: lazyRouteComponent(() => import('./pages/audit'), 'AuditPage'),
});
export const sdkKeysRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/sdk-keys',
  validateSearch: envSearch,
  component: lazyRouteComponent(() => import('./pages/sdk-keys'), 'SdkKeysPage'),
});
export const settingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/settings',
  component: lazyRouteComponent(() => import('./pages/settings'), 'SettingsPage'),
});
export const webhooksRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/webhooks',
  component: lazyRouteComponent(() => import('./pages/webhooks'), 'WebhooksPage'),
});
export const membersRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/members',
  component: lazyRouteComponent(() => import('./pages/members'), 'MembersPage'),
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  indexRoute,
  projectRoute.addChildren([
    flagsRoute,
    flagRoute,
    compareRoute,
    segmentsRoute,
    experimentsRoute,
    experimentRoute,
    changeRequestsRoute,
    scheduledRoute,
    auditRoute,
    sdkKeysRoute,
    settingsRoute,
    webhooksRoute,
    membersRoute,
  ]),
]);

export function RoutePending() {
  return (
    <div className="space-y-3 p-6" data-testid="route-pending">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultPendingComponent: RoutePending,
  defaultPendingMs: 150,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
