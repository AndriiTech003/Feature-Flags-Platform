import { Link, Navigate, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftRight,
  CalendarClock,
  FlaskConical,
  Flag,
  GitPullRequestArrow,
  KeyRound,
  LogOut,
  ScrollText,
  Settings,
  Users,
  UsersRound,
  Webhook,
} from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { toast } from 'sonner';
import { setToken } from '@/lib/api';
import { useMe, useProjects } from '@/lib/queries';
import { useProjectStream } from '@/lib/realtime';
import type { ChangeNotification } from '@/lib/types';
import { cn } from '@/lib/utils';
import { NativeSelect, Skeleton } from './ui/primitives';

type RealtimeListener = (notification: ChangeNotification) => void;

const RealtimeContext = createContext<{
  subscribe(listener: RealtimeListener): () => void;
  connected: boolean;
}>({
  subscribe: () => () => undefined,
  connected: false,
});

export function useRealtime(listener: RealtimeListener) {
  const { subscribe } = useContext(RealtimeContext);
  const ref = useRef(listener);
  useEffect(() => {
    ref.current = listener;
  }, [listener]);
  useEffect(() => subscribe((n) => ref.current(n)), [subscribe]);
}

export function useRealtimeConnected() {
  return useContext(RealtimeContext).connected;
}

export function RootRedirect() {
  const projects = useProjects();
  if (projects.isLoading)
    return (
      <div className="p-10">
        <Skeleton className="h-8 w-64" />
      </div>
    );
  const first = projects.data?.[0];
  if (!first)
    return (
      <div className="p-10 text-muted-foreground">
        No projects yet. Create one with the API (POST /projects).
      </div>
    );
  return <Navigate to="/projects/$project/flags" params={{ project: first.key }} />;
}

const NAV: Array<{ to: string; label: string; icon: ReactNode; testId: string }> = [
  { to: '/projects/$project/flags', label: 'Flags', icon: <Flag />, testId: 'nav-flags' },
  {
    to: '/projects/$project/compare',
    label: 'Compare environments',
    icon: <ArrowLeftRight />,
    testId: 'nav-compare',
  },
  { to: '/projects/$project/segments', label: 'Segments', icon: <UsersRound />, testId: 'nav-segments' },
  {
    to: '/projects/$project/experiments',
    label: 'Experiments',
    icon: <FlaskConical />,
    testId: 'nav-experiments',
  },
  {
    to: '/projects/$project/change-requests',
    label: 'Change requests',
    icon: <GitPullRequestArrow />,
    testId: 'nav-change-requests',
  },
  {
    to: '/projects/$project/scheduled',
    label: 'Scheduled changes',
    icon: <CalendarClock />,
    testId: 'nav-scheduled',
  },
  { to: '/projects/$project/audit', label: 'Audit log', icon: <ScrollText />, testId: 'nav-audit' },
  { to: '/projects/$project/sdk-keys', label: 'SDK keys', icon: <KeyRound />, testId: 'nav-sdk-keys' },
  { to: '/projects/$project/webhooks', label: 'Webhooks', icon: <Webhook />, testId: 'nav-webhooks' },
  { to: '/projects/$project/members', label: 'Members', icon: <Users />, testId: 'nav-members' },
  { to: '/projects/$project/settings', label: 'Settings', icon: <Settings />, testId: 'nav-settings' },
];

export function ProjectLayout() {
  const { project } = useParams({ from: '/projects/$project' });
  const projects = useProjects();
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const listeners = useRef(new Set<RealtimeListener>());
  const onChange = useCallback(
    (notification: ChangeNotification) => {
      for (const listener of listeners.current) listener(notification);
      if (notification.actor && me.data && notification.actor.id !== me.data.id && notification.flagKey) {
        toast.info(`${notification.actor.name} updated ${notification.flagKey} in ${notification.envKey}`);
      }
    },
    [me.data],
  );
  const connected = useProjectStream(project, onChange);
  const realtime = useMemo(
    () => ({
      connected,
      subscribe: (listener: RealtimeListener) => {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
    }),
    [connected],
  );
  const current = projects.data?.find((p) => p.key === project);
  return (
    <RealtimeContext.Provider value={realtime}>
      <div className="flex min-h-screen">
        <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r bg-card">
          <div className="flex items-center gap-2 px-4 py-4">
            <img src="/favicon.svg" alt="" className="size-7" />
            <div className="leading-tight">
              <div className="text-sm font-semibold">Flags</div>
              <div className="text-xs text-muted-foreground">{current?.organization.name ?? '…'}</div>
            </div>
          </div>
          <div className="px-3 pb-3">
            <NativeSelect
              className="w-full"
              value={project}
              data-testid="project-select"
              onChange={(e) =>
                void navigate({ to: '/projects/$project/flags', params: { project: e.target.value } })
              }
            >
              {projects.data?.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                params={{ project }}
                data-testid={item.testId}
                className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground [&_svg]:size-4"
                activeProps={{ className: 'bg-accent text-accent-foreground font-medium' }}
              >
                {item.icon}
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="border-t p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 text-xs">
                <div className="truncate font-medium" data-testid="current-user">
                  {me.data?.name ?? '…'}
                </div>
                <div className="flex items-center gap-1 text-muted-foreground">
                  <span
                    className={cn('size-1.5 rounded-full', connected ? 'bg-success' : 'bg-muted-foreground')}
                  />
                  {connected ? 'live' : 'offline'} · {current?.role ?? ''}
                </div>
              </div>
              <button
                className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"
                title="Log out"
                onClick={() => {
                  setToken(null);
                  queryClient.clear();
                  void navigate({ to: '/login' });
                }}
              >
                <LogOut className="size-4" />
              </button>
            </div>
          </div>
        </aside>
        <main className="min-w-0 flex-1 px-8 py-6">
          <Outlet />
        </main>
      </div>
    </RealtimeContext.Provider>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function useProjectKey() {
  return useParams({ from: '/projects/$project' }).project;
}
