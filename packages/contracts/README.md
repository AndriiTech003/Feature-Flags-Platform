# @ashamrai/flags-contracts

Zod schemas and pure helpers shared by the management API, the relay and the dashboard of the feature flags platform.

- `flagSchema`, `flagConfigSchema`, `segmentSchema`, `contextSchema`, `rulesetSchema`
- Semantic patch instructions (`turnOn`, `addRule`, `updateRuleClauses`, `reorderRules`, `updateFallthrough`, `addTargets`, …) with `applyInstructions`, `instructionsBetween` and `describeInstruction` for human-readable audit entries
- `jsonDiff` for configuration diffs
- SDK event schemas (`exposure`, `custom`, `summary`, `diagnostic`) and API request schemas

```sh
npm i @ashamrai/flags-contracts zod
```

```ts
import { applyInstructions, describeInstruction, instructionListSchema } from '@ashamrai/flags-contracts';

const instructions = instructionListSchema.parse([
  { kind: 'turnOn' },
  {
    kind: 'addRule',
    rule: { clauses: [{ attribute: 'country', op: 'in', values: ['DE'] }], serve: { variation: 'on' } },
  },
]);
const next = applyInstructions(config, instructions, flag);
instructions.map((i) => describeInstruction(i, flag)); // ['turned flag on', 'added rule: country in [DE] → On']
```

**Why a semantic patch instead of PUT?** Two people editing different rules do not overwrite each other, and the audit log records intent ("added rule: country in [DE]") instead of "config changed".

MIT licensed.
