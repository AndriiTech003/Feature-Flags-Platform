import { describeInstruction, jsonDiff, type Instruction } from '@ashamrai/flags-contracts';
import { CalendarClock, GitPullRequestArrow, RotateCcw, Save } from 'lucide-react';
import { useState } from 'react';
import type { Variation } from '@/lib/types';
import { JsonDiff } from './json-diff';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from './ui/overlays';
import { Input, Label, Textarea } from './ui/primitives';

export interface PendingBarProps {
  instructions: Instruction[];
  before: unknown;
  after: unknown;
  variations: Variation[];
  requireApproval: boolean;
  envName: string;
  busy: boolean;
  onDiscard(): void;
  onSave(comment: string): void;
  onRequestApproval(comment: string): void;
  onSchedule(executeAt: string, comment: string): void;
}

export function PendingBar(props: PendingBarProps) {
  const [mode, setMode] = useState<'review' | 'schedule' | null>(null);
  const [comment, setComment] = useState('');
  const [when, setWhen] = useState(() => {
    const d = new Date(Date.now() + 3600000);
    d.setMinutes(0, 0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  if (props.instructions.length === 0) return null;
  const descriptions = props.instructions.map((i) =>
    describeInstruction(i, { variations: props.variations }),
  );
  return (
    <>
      <div
        className="sticky bottom-4 z-30 mt-6 flex items-center justify-between gap-4 rounded-xl border border-primary/30 bg-card px-4 py-3 shadow-lg"
        data-testid="pending-bar"
      >
        <div className="min-w-0 text-sm">
          <b data-testid="pending-count">
            {props.instructions.length} pending change{props.instructions.length === 1 ? '' : 's'}
          </b>{' '}
          in {props.envName}
          <div className="truncate text-xs text-muted-foreground">{descriptions.join(' · ')}</div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" onClick={props.onDiscard} data-testid="discard-changes">
            <RotateCcw /> Discard
          </Button>
          <Button variant="outline" onClick={() => setMode('schedule')} data-testid="schedule-changes">
            <CalendarClock /> Schedule
          </Button>
          <Button onClick={() => setMode('review')} data-testid="review-changes">
            {props.requireApproval ? <GitPullRequestArrow /> : <Save />}
            {props.requireApproval ? 'Review & request approval' : 'Review & save'}
          </Button>
        </div>
      </div>
      <Dialog open={mode !== null} onOpenChange={(open) => !open && setMode(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader
            title={mode === 'schedule' ? 'Schedule changes' : 'Review changes'}
            description={`${props.envName}${props.requireApproval ? ' requires approval: the changes become a change request.' : ''}`}
          />
          <ol className="list-decimal space-y-1 pl-5 text-sm" data-testid="pending-descriptions">
            {descriptions.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ol>
          <JsonDiff entries={jsonDiff(props.before, props.after)} />
          {mode === 'schedule' ? (
            <div className="grid gap-1.5">
              <Label>Execute at (your local time)</Label>
              <Input
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
                data-testid="schedule-at"
              />
            </div>
          ) : null}
          <Textarea
            placeholder="Comment for the audit log"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            data-testid="change-comment"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setMode(null)}>
              Back
            </Button>
            {mode === 'schedule' ? (
              <Button
                disabled={props.busy}
                onClick={() => {
                  props.onSchedule(new Date(when).toISOString(), comment);
                  setMode(null);
                }}
                data-testid="confirm-schedule"
              >
                Schedule
              </Button>
            ) : props.requireApproval ? (
              <Button
                disabled={props.busy}
                onClick={() => {
                  props.onRequestApproval(comment);
                  setMode(null);
                }}
                data-testid="confirm-request-approval"
              >
                Request approval
              </Button>
            ) : (
              <Button
                disabled={props.busy}
                onClick={() => {
                  props.onSave(comment);
                  setMode(null);
                }}
                data-testid="confirm-save"
              >
                Save changes
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
