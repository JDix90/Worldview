/**
 * ORRERY pipeline worker. Currently Stage 1 (collector) as BullMQ repeatable
 * jobs; baselines (chunk 4), detectors (chunk 5), and the analyst (chunk 6)
 * join this process as further queues. See PHASES.md.
 */
import { Queue, Worker } from 'bullmq';
import { env } from './env.js';
import { createRedis } from './redis.js';
import { createPool, ensureSchema } from './db.js';
import { log, logError } from './log.js';
import {
  jobPollOpenSky,
  jobPollSquawks,
  jobPollMil,
  jobSweepIntegrity,
  jobCleanRaw,
} from './collector/jobs.js';
import { jobRollupDensity, jobCleanRollups } from './rollup/density.js';
import { jobComputeBaselines } from './rollup/baselines.js';
import { jobDetect } from './detect/jobDetect.js';
import { jobAnalystPoll, jobBriefingCheck, jobOpsWatch } from './analyst/jobs.js';

const COLLECTOR_QUEUE = 'collector';

const SCHEDULES: Record<string, number> = {
  'poll-opensky': 90_000,
  'poll-squawks': 60_000,
  'sweep-integrity': 120_000,
  'poll-mil': 120_000,
  'clean-raw': 15 * 60_000,
  'rollup-density': 5 * 60_000,
  'compute-baselines': 6 * 3600_000,
  'clean-rollups': 24 * 3600_000,
  'detect': 60_000,
  'analyst-poll': 60_000,
  'ops-watch': 5 * 60_000,
  // Briefing rides the interval scheduler like everything else: the handler
  // no-ops until past the local briefing hour, and jobBriefing's
  // ON CONFLICT (date_local) upsert makes repeats harmless. The cron-pattern
  // scheduler (`0 7 * * *` + tz) silently stopped iterating after one firing
  // per worker boot (BullMQ 5.73 job-scheduler; briefings 07-17/19/20 lost —
  // DECISIONS #93). Interval + guard also gives catch-up semantics: an
  // appliance that was off at 07:00 files late instead of never.
  'briefing-check': 15 * 60_000,
};

async function main(): Promise<void> {
  const dataRedis = createRedis();
  const pool = createPool();
  await ensureSchema(pool);

  // fresh database with rollups but no baselines (first boot after chunk 4,
  // or a restored volume) → compute now rather than waiting for the scheduler
  const seed = await pool.query(
    'SELECT (SELECT count(*) FROM baseline)::int AS bins, (SELECT count(*) FROM density_rollup)::int AS rollups',
  );
  if (seed.rows[0].bins === 0 && seed.rows[0].rollups > 0) {
    log('worker', 'baseline table empty — computing from existing rollups');
    await jobComputeBaselines(pool);
  }

  const queue = new Queue(COLLECTOR_QUEUE, { connection: createRedis() });

  for (const [name, every] of Object.entries(SCHEDULES)) {
    await queue.upsertJobScheduler(name, { every }, { name });
  }
  // retire the old cron-pattern scheduler if this Redis still carries it
  // (replaced by the 'briefing-check' interval above — DECISIONS #93)
  await queue.removeJobScheduler('briefing').catch(() => {});

  const worker = new Worker(
    COLLECTOR_QUEUE,
    async (job) => {
      switch (job.name) {
        case 'poll-opensky':
          return jobPollOpenSky(dataRedis);
        case 'poll-squawks':
          return jobPollSquawks(dataRedis);
        case 'sweep-integrity':
          return jobSweepIntegrity(dataRedis, pool);
        case 'poll-mil':
          return jobPollMil(dataRedis);
        case 'clean-raw':
          return jobCleanRaw();
        case 'rollup-density':
          return jobRollupDensity(dataRedis, pool);
        case 'compute-baselines':
          return jobComputeBaselines(pool);
        case 'clean-rollups':
          return jobCleanRollups(pool);
        case 'detect':
          return jobDetect(dataRedis, pool);
        case 'analyst-poll':
          return jobAnalystPoll(dataRedis, pool);
        case 'briefing-check':
          return jobBriefingCheck(pool);
        case 'ops-watch':
          return jobOpsWatch(dataRedis, pool);
        default:
          throw new Error(`unknown job: ${job.name}`);
      }
    },
    // Concurrency 2: an OpenSky poll must not delay squawk polls; adsb.fi
    // calls self-serialize through the rate gate regardless.
    { connection: createRedis(), concurrency: 2 },
  );

  worker.on('failed', (job, err) => logError('worker', `job ${job?.name ?? '?'} failed`, err));
  worker.on('error', (err) => logError('worker', 'worker error', err));

  log('worker', 'collector started', {
    redis: env.redisUrl,
    opensky: env.openskyClientId ? 'authenticated' : env.openskyAllowAnonymous ? 'ANONYMOUS' : 'unconfigured',
    rawDataDir: env.rawDataDir,
    schedules: SCHEDULES,
  });

  const shutdown = async (signal: string) => {
    log('worker', `${signal} — shutting down`);
    await worker.close();
    await queue.close();
    dataRedis.disconnect();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logError('worker', 'fatal on startup', err);
  process.exit(1);
});
