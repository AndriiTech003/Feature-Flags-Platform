# @ashamrai/flags-cli

Command line tools for the feature flags platform.

```sh
npx @ashamrai/flags-cli login --api https://api.example.dev --email you@company.com --password …
npx @ashamrai/flags-cli codegen --project web-shop --out src/flags.gen.ts
npx @ashamrai/flags-cli find-stale --project web-shop --dir src --days 30 --fail
```

- `codegen` writes `GeneratedFlagTypes` and augments `@ashamrai/flags-node` and `@ashamrai/flags-web`, so `variation('new-checkout', ctx, false)` is typed `boolean` and unknown keys stand out in review.
- `find-stale` scans `.ts/.tsx/.js/.jsx/.vue/.svelte` files for string literals that match flag keys and reports flags that are archived or were not evaluated for `--days` days, with file and line. `--fail` exits with 1 for CI.
- Credentials are stored in `~/.config/ashamrai-flags/credentials.json`, or pass `FLAGS_TOKEN` and `FLAGS_API_URL`.

MIT licensed.
