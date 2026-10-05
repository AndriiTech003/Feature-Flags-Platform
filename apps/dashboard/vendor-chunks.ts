const vendorGroups: Array<[string, RegExp]> = [
  ['react', /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/],
  ['router', /[\\/]node_modules[\\/]@tanstack[\\/]/],
  [
    'charts',
    /[\\/]node_modules[\\/](recharts|d3-[^\\/]+|victory-vendor|internmap|decimal\.js-light|es-toolkit|@reduxjs|redux|redux-thunk|react-redux|immer|reselect|eventemitter3)[\\/]/,
  ],
  ['dnd', /[\\/]node_modules[\\/]@dnd-kit[\\/]/],
  [
    'radix',
    /[\\/]node_modules[\\/](radix-ui|@radix-ui|@floating-ui|react-remove-scroll[^\\/]*|aria-hidden|react-style-singleton|use-callback-ref|use-sidecar|get-nonce|detect-node-es)[\\/]/,
  ],
  ['forms', /[\\/]node_modules[\\/](react-hook-form|@hookform|zod)[\\/]/],
  ['icons', /[\\/]node_modules[\\/]lucide-react[\\/]/],
];

export function vendorChunk(id: string): string | null {
  for (const [name, pattern] of vendorGroups) if (pattern.test(id)) return `vendor-${name}`;
  return /[\\/]node_modules[\\/]/.test(id) ? 'vendor' : null;
}
