import {
  ErrorCode,
  OpenFeatureEventEmitter,
  ProviderEvents,
  StandardResolutionReasons,
  type EvaluationContext,
  type JsonValue,
  type Provider,
  type ResolutionDetails,
  type TrackingEventDetails,
} from '@openfeature/web-sdk';
import { createClient, type ExpectedKind, type WebClient, type WebClientOptions } from '@ashamrai/flags-web';
import { toFlagsContext, toResolution } from './mapping';

export { toFlagsContext, toResolution } from './mapping';

export interface WebFlagsProviderOptions extends Omit<WebClientOptions, 'context'> {
  initializationTimeoutMs?: number;
}

export class WebFlagsProvider implements Provider {
  readonly metadata = { name: 'ashamrai-flags-web' } as const;
  readonly runsOn = 'client' as const;
  readonly events = new OpenFeatureEventEmitter();
  client: WebClient | null = null;
  private stale = false;

  constructor(private readonly options: WebFlagsProviderOptions) {}

  async initialize(context: EvaluationContext = {}): Promise<void> {
    const client = createClient({
      ...this.options,
      context: toFlagsContext(context) as WebClientOptions['context'],
    });
    this.client = client;
    client.on('change', (changes) => {
      if (this.stale) {
        this.stale = false;
        this.events.emit(ProviderEvents.Ready);
      }
      this.events.emit(ProviderEvents.ConfigurationChanged, { flagsChanged: Object.keys(changes) });
    });
    client.on('error', (error) => {
      if (!this.stale) {
        this.stale = true;
        this.events.emit(ProviderEvents.Stale, { message: error.message });
      }
    });
    const result = await client.waitForInitialization({
      timeoutMs: this.options.initializationTimeoutMs ?? 5000,
    });
    if (!result.initialized) throw new Error('flags web provider failed to initialize');
  }

  async onContextChange(_oldContext: EvaluationContext, newContext: EvaluationContext): Promise<void> {
    await this.client?.identify(toFlagsContext(newContext) as WebClientOptions['context']);
  }

  private resolve<T>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
    kind: ExpectedKind,
  ): ResolutionDetails<T> {
    if (!this.client) {
      return {
        value: defaultValue,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.PROVIDER_NOT_READY,
      };
    }
    return toResolution(
      this.client.variationDetail(flagKey, defaultValue, kind),
      defaultValue,
      !context.targetingKey,
    );
  }

  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
  ): ResolutionDetails<boolean> {
    return this.resolve(flagKey, defaultValue, context, 'boolean');
  }

  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
  ): ResolutionDetails<string> {
    return this.resolve(flagKey, defaultValue, context, 'string');
  }

  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
  ): ResolutionDetails<number> {
    return this.resolve(flagKey, defaultValue, context, 'number');
  }

  resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
  ): ResolutionDetails<T> {
    const result = this.resolve<unknown>(flagKey, defaultValue, context, 'json');
    if (
      result.reason !== StandardResolutionReasons.ERROR &&
      (typeof result.value !== 'object' || result.value === null)
    ) {
      return {
        value: defaultValue,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.TYPE_MISMATCH,
        errorMessage: 'WRONG_TYPE',
      };
    }
    return result as ResolutionDetails<T>;
  }

  track(trackingEventName: string, _context: EvaluationContext, details?: TrackingEventDetails): void {
    const { value, ...data } = details ?? {};
    this.client?.track(trackingEventName, {
      value: typeof value === 'number' ? value : undefined,
      data: Object.keys(data).length ? data : undefined,
    });
  }

  async onClose(): Promise<void> {
    await this.client?.close();
  }
}
