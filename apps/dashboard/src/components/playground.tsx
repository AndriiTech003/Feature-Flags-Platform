import {
  createStore,
  evaluate,
  type Context,
  type EvaluationDetail,
  type FlagWithConfig,
  type Ruleset,
} from '@ashamrai/flags-evaluator';
import { describeClause, describeServe } from '@ashamrai/flags-contracts';
import { Play } from 'lucide-react';
import { useState } from 'react';
import type { FlagConfig, Variation } from '@/lib/types';
import { displayValue } from '@/lib/utils';
import { variationLabel } from './serve-editor';
import { Button } from './ui/button';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Textarea,
} from './ui/primitives';

export function explain(
  detail: EvaluationDetail,
  config: Pick<FlagConfig, 'rules' | 'fallthrough' | 'targets'>,
  variations: Variation[],
): string {
  const reason = detail.reason;
  switch (reason.kind) {
    case 'OFF':
      return 'The flag is off in this environment, so the off variation is served.';
    case 'TARGET_MATCH':
      return 'The context key is listed in individual targets.';
    case 'RULE_MATCH': {
      const rule = config.rules[reason.ruleIndex];
      const text = rule ? rule.clauses.map(describeClause).join(' AND ') || 'everyone' : reason.ruleId;
      return `Rule ${reason.ruleIndex + 1}${rule?.description ? ` "${rule.description}"` : ''} matched (${text}) and serves ${rule ? describeServe(rule.serve, { variations }) : detail.variationId}.${reason.inExperiment ? ' The context is part of a running experiment.' : ''}`;
    }
    case 'FALLTHROUGH':
      return `No rule matched, the default rule serves ${describeServe(config.fallthrough, { variations })}.${reason.inExperiment ? ' The context is part of a running experiment.' : ''}`;
    case 'PREREQUISITE_FAILED':
      return `Prerequisite flag "${reason.prerequisiteKey}" did not return the required variation, so the off variation is served.`;
    case 'ERROR':
      return `Evaluation error ${reason.errorKind}: the SDK would return the default value.`;
  }
}

export function Playground({
  flagKey,
  ruleset,
  draft,
  original,
  variations,
}: {
  flagKey: string;
  ruleset: Ruleset | undefined;
  draft: FlagConfig;
  original: FlagConfig;
  variations: Variation[];
}) {
  const [input, setInput] = useState(
    '{\n  "kind": "user",\n  "key": "user-42",\n  "plan": "pro",\n  "country": "DE"\n}',
  );
  const [usePending, setUsePending] = useState(true);
  const [result, setResult] = useState<{ detail: EvaluationDetail; explanation: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = () => {
    setError(null);
    let context: Context;
    try {
      context = JSON.parse(input) as Context;
    } catch (e) {
      setError(`Invalid JSON: ${(e as Error).message}`);
      setResult(null);
      return;
    }
    if (!ruleset) return;
    const config = usePending ? draft : original;
    const base = ruleset.flags[flagKey] as FlagWithConfig | undefined;
    if (!base) {
      setError('This flag is not part of the environment ruleset (archived?).');
      return;
    }
    const flag: FlagWithConfig = { ...base, variations, config: { ...base.config, ...config } };
    const store = createStore({ flags: { ...ruleset.flags, [flagKey]: flag }, segments: ruleset.segments });
    const detail = evaluate(flag, flag.config, context, store, { defaultValue: null });
    setResult({ detail, explanation: explain(detail, config, variations) });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Evaluate playground</CardTitle>
        <CardDescription>
          Runs the same evaluator package as the SDKs, locally in your browser.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Textarea
          className="font-mono text-xs"
          rows={8}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          data-testid="playground-context"
        />
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={usePending} onCheckedChange={(v) => setUsePending(v === true)} /> Include
            pending changes
          </label>
          <Button onClick={run} disabled={!ruleset} data-testid="playground-run">
            <Play /> Evaluate
          </Button>
        </div>
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        {result ? (
          <div
            className="grid gap-2 rounded-lg border bg-muted/30 p-3 text-sm"
            data-testid="playground-result"
          >
            <div className="flex flex-wrap items-center gap-2">
              Value
              <code className="rounded bg-card px-1.5 py-0.5 font-mono" data-testid="playground-value">
                {displayValue(result.detail.value)}
              </code>
              {result.detail.variationId ? (
                <Badge>{variationLabel(variations, result.detail.variationId)}</Badge>
              ) : null}
              <Badge variant="outline" data-testid="playground-reason">
                {result.detail.reason.kind}
              </Badge>
            </div>
            <p className="text-muted-foreground" data-testid="playground-explanation">
              {result.explanation}
            </p>
            <pre className="overflow-auto rounded bg-card p-2 font-mono text-xs">
              {JSON.stringify(result.detail.reason, null, 2)}
            </pre>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
