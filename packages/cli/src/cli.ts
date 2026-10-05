import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fetchFlags, loadCredentials, login, saveCredentials } from './api';
import { generateTypes } from './codegen';
import { findStale } from './stale';

const HELP = `flags <command> [options]

Commands:
  login       --api <url> --email <email> --password <password>
  codegen     --project <key> --out <file>
  find-stale  --project <key> [--dir <path>] [--days 30] [--fail] [--json]
`;

export async function run(argv: string[], out: (line: string) => void = console.log): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      api: { type: 'string' },
      email: { type: 'string' },
      password: { type: 'string' },
      project: { type: 'string' },
      out: { type: 'string' },
      dir: { type: 'string' },
      days: { type: 'string' },
      fail: { type: 'boolean' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  if (command === 'login') {
    if (!values.api || !values.email || !values.password)
      throw new Error('login requires --api, --email and --password');
    const credentials = await login(values.api, values.email, values.password);
    out(`logged in, credentials saved to ${await saveCredentials(credentials)}`);
    return 0;
  }
  if (command === 'codegen' || command === 'find-stale') {
    if (!values.project) throw new Error('--project is required');
    const credentials = await loadCredentials();
    if (!credentials) throw new Error('not logged in: run `flags login` or set FLAGS_TOKEN');
    const flags = await fetchFlags(credentials, values.project);
    if (command === 'codegen') {
      const target = resolve(values.out ?? 'src/flags.gen.ts');
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, generateTypes(values.project, flags));
      out(`wrote ${flags.filter((f) => !f.archivedAt).length} flag types to ${target}`);
      return 0;
    }
    const references = await findStale(resolve(values.dir ?? '.'), flags, {
      days: values.days ? Number(values.days) : 30,
    });
    if (values.json) out(JSON.stringify(references, null, 2));
    else if (references.length === 0) out('no stale or archived flags referenced in code');
    else {
      for (const ref of references) {
        out(
          `${ref.key} (${ref.status}${ref.lastEvaluatedAt ? `, last evaluated ${ref.lastEvaluatedAt}` : ', never evaluated'})`,
        );
        for (const loc of ref.locations) out(`  ${loc.file}:${loc.line}`);
      }
    }
    return values.fail && references.length > 0 ? 1 : 0;
  }
  out(HELP);
  return command ? 1 : 0;
}
