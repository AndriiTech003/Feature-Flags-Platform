import { init } from '@ashamrai/flags-node';

const flags = init({ sdkKey: 'srv-x' });
const ctx = { kind: 'user', key: 'u' };
export const a = flags.boolVariation('legacy-search', ctx, false);
export const b = flags.boolVariation('dark-mode', ctx, false);
export const c = flags.boolVariation('new-checkout', ctx, false);
