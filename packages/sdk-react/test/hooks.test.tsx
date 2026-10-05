import { act, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Detail, FlagValue } from '@ashamrai/flags-web';
import { FlagsProvider, useFlag, useFlagDetail, type FlagsClientLike } from '../src';

class FakeClient implements FlagsClientLike {
  values: Record<string, FlagValue> = {
    'new-checkout': { value: false, variationId: 'off', reason: { kind: 'FALLTHROUGH' } },
    'banner-text': { value: 'Welcome', variationId: 'A', reason: { kind: 'FALLTHROUGH' } },
  };
  exposures: string[] = [];
  private listeners = new Set<(changes: Record<string, unknown>) => void>();

  getFlag(key: string) {
    return this.values[key];
  }

  variationDetail<T>(key: string, defaultValue: T): Detail<T> {
    const flag = this.values[key];
    this.exposures.push(key);
    if (!flag)
      return {
        value: defaultValue,
        variationId: null,
        reason: { kind: 'ERROR', errorKind: 'FLAG_NOT_FOUND' },
      };
    return { value: flag.value as T, variationId: flag.variationId, reason: flag.reason! };
  }

  on(event: string, listener: (changes: Record<string, unknown>) => void) {
    if (event !== 'change') return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(key: string, value: FlagValue) {
    this.values = { ...this.values, [key]: value };
    for (const listener of this.listeners) listener({ [key]: { current: value.value } });
  }
}

const renders: Record<string, number> = {};

function Checkout() {
  renders.checkout = (renders.checkout ?? 0) + 1;
  const on = useFlag('new-checkout', false);
  return <span data-testid="checkout">{on ? 'new' : 'old'}</span>;
}

function Banner() {
  renders.banner = (renders.banner ?? 0) + 1;
  const { value, reason } = useFlagDetail('banner-text', 'default');
  return <span data-testid="banner">{`${value}|${reason.kind}`}</span>;
}

describe('flags-react', () => {
  it('renders flag values and re-renders only components whose flags changed', () => {
    const client = new FakeClient();
    render(
      <FlagsProvider client={client}>
        <Checkout />
        <Banner />
      </FlagsProvider>,
    );
    expect(screen.getByTestId('checkout').textContent).toBe('old');
    expect(screen.getByTestId('banner').textContent).toBe('Welcome|FALLTHROUGH');
    const before = { ...renders };
    act(() => client.set('new-checkout', { value: true, variationId: 'on', reason: { kind: 'RULE_MATCH' } }));
    expect(screen.getByTestId('checkout').textContent).toBe('new');
    expect(renders.checkout).toBe(before.checkout! + 1);
    expect(renders.banner).toBe(before.banner);
    expect(client.exposures.filter((k) => k === 'new-checkout')).toHaveLength(2);
  });

  it('server-renders from bootstrap values without a client', () => {
    const html = renderToString(
      <FlagsProvider
        bootstrap={{
          flags: {
            'new-checkout': { value: true, variationId: 'on' },
            'banner-text': { value: 'From SSR', variationId: 'B' },
          },
        }}
      >
        <Checkout />
        <Banner />
      </FlagsProvider>,
    );
    expect(html).toContain('new');
    expect(html).toContain('From SSR|BOOTSTRAP');
  });

  it('falls back to defaults for unknown flags', () => {
    const client = new FakeClient();
    function Unknown() {
      return <span data-testid="u">{useFlag('missing', 'fallback')}</span>;
    }
    render(
      <FlagsProvider client={client}>
        <Unknown />
      </FlagsProvider>,
    );
    expect(screen.getByTestId('u').textContent).toBe('fallback');
  });
});
