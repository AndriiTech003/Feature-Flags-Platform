import {
  ErrorCode,
  OpenFeatureEventEmitter,
  StandardResolutionReasons,
  ProviderEvents,
  type EvaluationContext,
  type JsonValue,
  type Provider,
  type ResolutionDetails,
  type TrackingEventDetails,
} from '@openfeature/server-sdk';
import { FlagsClient, init, type FlagsOptions } from '@ashamrai/flags-node';
import { toFlagsContext, toResolution } from './mapping';

export { toFlagsContext, toResolution } from './mapping';

export interface FlagsProviderOptions extends FlagsOptions {
  initializationTimeoutMs?: number;
}

export class FlagsProvider implements Provider {
  readonly metadata = { name: 'ashamrai-flags-node' } as const;
  readonly runsOn = 'server' as const;
  readonly events = new OpenFeatureEventEmitter();
  readonly client: FlagsClient;
  private readonly timeoutMs: number;
  private stale = false;
  private readonly unsubscribe: Array<() => void> = [];

  constructor(options: FlagsProviderOptions | FlagsClient) {
    this.client = options instanceof FlagsClient ? options : init(options);
    this.timeoutMs = options instanceof FlagsClient ? 5000 : (options.initializationTimeoutMs ?? 5000);
    this.unsubscribe.push(
      this.client.on('update', ({ key }) => {
        if (this.stale) {
          this.stale = false;
          this.events.emit(ProviderEvents.Ready);
        }
        this.events.emit(ProviderEvents.ConfigurationChanged, { flagsChanged: [key] });
      }),
      this.client.on('stale', ({ reason }) => {
        this.stale = true;
        this.events.emit(ProviderEvents.Stale, { message: reason });
      }),
      this.client.on('ready', () => {
        if (this.stale) {
          this.stale = false;
          this.events.emit(ProviderEvents.Ready);
        }
      }),
    );
  }

  async initialize(): Promise<void> {
    const result = await this.client.waitForInitialization({ timeoutMs: this.timeoutMs });
    if (!result.initialized) {
      this.stale = true;
      throw new Error(`flags provider failed to initialize: ${result.error ?? 'timeout'}`);
    }
  }

  private resolve<T>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
    kind: 'boolean' | 'string' | 'number' | 'json',
  ): ResolutionDetails<T> {
    const ctx = toFlagsContext(context);
    const typed =
      kind === 'json'
        ? this.client.jsonVariationDetail(flagKey, ctx, defaultValue)
        : kind === 'boolean'
          ? this.client.boolVariationDetail(flagKey, ctx, defaultValue as boolean)
          : kind === 'string'
            ? this.client.stringVariationDetail(flagKey, ctx, defaultValue as string)
            : this.client.numberVariationDetail(flagKey, ctx, defaultValue as number);
    return toResolution(typed, defaultValue, !context.targetingKey);
  }

  async resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<boolean>> {
    return this.resolve(flagKey, defaultValue, context, 'boolean');
  }

  async resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<string>> {
    return this.resolve(flagKey, defaultValue, context, 'string');
  }

  async resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<number>> {
    return this.resolve(flagKey, defaultValue, context, 'number');
  }

  async resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<T>> {
    const result = this.resolve<unknown>(flagKey, defaultValue, context, 'json');
    if (result.reason !== 'ERROR' && (typeof result.value !== 'object' || result.value === null)) {
      return {
        value: defaultValue,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.TYPE_MISMATCH,
        errorMessage: 'WRONG_TYPE',
      };
    }
    return result as ResolutionDetails<T>;
  }

  track(trackingEventName: string, context: EvaluationContext, details?: TrackingEventDetails): void {
    const { value, ...data } = details ?? {};
    this.client.track(trackingEventName, toFlagsContext(context), {
      value: typeof value === 'number' ? value : undefined,
      data: Object.keys(data).length ? data : undefined,
    });
  }

  async onClose(): Promise<void> {
    for (const off of this.unsubscribe.splice(0)) off();
    await this.client.close();
  }
}
