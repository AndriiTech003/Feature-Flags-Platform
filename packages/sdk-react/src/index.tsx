import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  createClient,
  type Detail,
  type FlagValue,
  type FlagValues,
  type WebClient,
  type WebClientOptions,
} from '@ashamrai/flags-web';

export interface FlagsClientLike {
  getFlag(key: string): FlagValue | undefined;
  variationDetail<T>(key: string, defaultValue: T): Detail<T>;
  on(event: 'change', listener: (changes: Record<string, unknown>) => void): () => void;
  on(event: 'ready', listener: () => void): () => void;
}

interface FlagsContextValue {
  client: FlagsClientLike | null;
  bootstrap: FlagValues;
}

const FlagsContext = createContext<FlagsContextValue>({ client: null, bootstrap: {} });

export interface FlagsProviderProps {
  client?: FlagsClientLike;
  options?: WebClientOptions;
  bootstrap?: FlagValues | { flags: FlagValues };
  children?: ReactNode;
}

function normalize(bootstrap: FlagsProviderProps['bootstrap']): FlagValues {
  if (!bootstrap) return {};
  return ((bootstrap as { flags?: FlagValues }).flags ?? bootstrap) as FlagValues;
}

export function FlagsProvider({ client, options, bootstrap, children }: FlagsProviderProps) {
  const [owned, setOwned] = useState<WebClient | null>(null);
  useEffect(() => {
    if (client || !options) return undefined;
    const created = createClient({ ...options, bootstrap: options.bootstrap ?? bootstrap });
    setOwned(created);
    return () => {
      void created.close();
    };
  }, [client, options, bootstrap]);
  const value = useMemo<FlagsContextValue>(
    () => ({ client: client ?? owned, bootstrap: normalize(bootstrap) }),
    [client, owned, bootstrap],
  );
  return <FlagsContext.Provider value={value}>{children}</FlagsContext.Provider>;
}

export function useFlagsClient(): FlagsClientLike | null {
  return useContext(FlagsContext).client;
}

function bootstrapDetail<T>(bootstrap: FlagValues, key: string, defaultValue: T): Detail<T> {
  const flag = bootstrap[key];
  if (!flag || flag.variationId === null)
    return {
      value: defaultValue,
      variationId: null,
      reason: { kind: 'ERROR', errorKind: 'CLIENT_NOT_READY' },
    };
  return {
    value: flag.value as T,
    variationId: flag.variationId,
    reason: flag.reason ?? { kind: 'BOOTSTRAP' },
  };
}

const noop = () => () => undefined;

export function useFlagDetail<T>(key: string, defaultValue: T): Detail<T> {
  const { client, bootstrap } = useContext(FlagsContext);
  const subscribe = useMemo(
    () =>
      client
        ? (notify: () => void) =>
            client.on('change', (changes) => {
              if (Object.prototype.hasOwnProperty.call(changes, key)) notify();
            })
        : noop,
    [client, key],
  );
  const raw = useSyncExternalStore(
    subscribe,
    () => (client ? client.getFlag(key) : bootstrap[key]),
    () => bootstrap[key],
  );
  return useMemo(
    () =>
      client && raw !== undefined
        ? client.variationDetail(key, defaultValue)
        : bootstrapDetail(bootstrap, key, defaultValue),
    [client, raw, key, defaultValue, bootstrap],
  );
}

export function useFlag<T>(key: string, defaultValue: T): T {
  return useFlagDetail(key, defaultValue).value;
}

export function useFlagsReady(): boolean {
  const client = useFlagsClient();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!client) return undefined;
    const done = () => setReady(true);
    const off = client.on('ready', done);
    if (typeof (client as { ready?: () => Promise<void> }).ready === 'function')
      void (client as WebClient).ready().then(done);
    return off;
  }, [client]);
  return ready;
}
