import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { FlagInsights } from '@ashamrai/flags-contracts';
import { AccessService } from '../access/access.service';
import { CurrentUser, type AuthUser } from '../common/auth';
import { iso } from '../db/db';
import { FlagsService, STALE_DAYS } from '../flags/flags.service';
import { Database } from '../infra/database';

@Controller()
export class InsightsController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(FlagsService) private readonly flags: FlagsService,
  ) {}

  @Get('projects/:p/flags/:key/insights')
  async insights(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @Param('key') key: string,
    @Query('env') envKey: string | undefined,
  ): Promise<FlagInsights> {
    const project = await this.access.project(user, p);
    const flag = await this.flags.flagRow(project.id, key);
    const envs = await this.access.envs(project.id);
    const env = envs.find((e) => e.key === envKey) ?? envs.find((e) => e.key === 'production') ?? envs[0]!;
    const totals = async (interval: string) =>
      (
        await this.db.query<{ variation_id: string; count: number }>(
          `SELECT variation_id, sum(count)::bigint AS count FROM flag_eval_counts
           WHERE env_id = $1 AND flag_key = $2 AND hour >= date_trunc('hour', now() - $3::interval) GROUP BY variation_id ORDER BY variation_id`,
          [env.id, key, interval],
        )
      ).map((r) => ({ variationId: r.variation_id === '' ? null : r.variation_id, count: r.count }));
    const series = await this.db.query<{ hour: Date; variation_id: string; count: number }>(
      `SELECT hour, variation_id, count FROM flag_eval_counts WHERE env_id = $1 AND flag_key = $2 AND hour >= date_trunc('hour', now() - interval '7 days') ORDER BY hour`,
      [env.id, key],
    );
    const lastSeen = await this.db.maybe<{ last_evaluated_at: Date }>(
      'SELECT last_evaluated_at FROM flag_last_seen WHERE env_id = $1 AND flag_key = $2',
      [env.id, key],
    );
    const reference = lastSeen?.last_evaluated_at ?? flag.created_at;
    return {
      flagKey: key,
      envKey: env.key,
      last24h: await totals('24 hours'),
      last7d: await totals('7 days'),
      series: series.map((s) => ({
        bucket: iso(s.hour)!,
        variationId: s.variation_id === '' ? null : s.variation_id,
        count: s.count,
      })),
      lastEvaluatedAt: iso(lastSeen?.last_evaluated_at ?? null),
      stale: new Date(reference).getTime() < Date.now() - STALE_DAYS * 86400000,
    };
  }
}
