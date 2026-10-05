import type { Logger } from './types';

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function consoleLogger(prefix = '[flags]'): Logger {
  return {
    debug: () => undefined,
    info: (m, ...a) => console.info(prefix, m, ...a),
    warn: (m, ...a) => console.warn(prefix, m, ...a),
    error: (m, ...a) => console.error(prefix, m, ...a),
  };
}

export function safeLogger(logger: Logger | undefined): Logger {
  const base = logger ?? consoleLogger();
  const wrap =
    (fn: (m: string, ...a: unknown[]) => void) =>
    (m: string, ...a: unknown[]) => {
      try {
        fn.call(base, m, ...a);
      } catch {
        return;
      }
    };
  return { debug: wrap(base.debug), info: wrap(base.info), warn: wrap(base.warn), error: wrap(base.error) };
}
