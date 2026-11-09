/**
 * Postgres for the worker — rollups in, baselines out. Schema is idempotent
 * DDL applied at boot (a solo instrument doesn't need a migration framework
 * until the schema stops fitting on one screen).
 */
import pg from 'pg';
import { env } from './env.js';

export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export function createPool(): pg.Pool {
  return new pg.Pool({ connectionString: env.databaseUrl, max: 4 });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS density_rollup (
  bucket_ts  timestamptz NOT NULL,
  cell       text        NOT NULL,
  aircraft   integer     NOT NULL,
  PRIMARY KEY (bucket_ts, cell)
);
CREATE INDEX IF NOT EXISTS density_rollup_cell_idx ON density_rollup (cell, bucket_ts);

-- one row per successful rollup run: data-health ground truth (D0) and status
CREATE TABLE IF NOT EXISTS rollup_run (
  bucket_ts       timestamptz PRIMARY KEY,
  total_aircraft  integer     NOT NULL,
  cells           integer     NOT NULL,
  fetched_at      timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS signal (
  id          text        PRIMARY KEY,
  ts          timestamptz NOT NULL,
  source      text        NOT NULL,
  detector    text        NOT NULL,
  severity    text        NOT NULL,
  demoted_from text,
  dedupe_key  text        NOT NULL,
  payload     jsonb       NOT NULL
);
CREATE INDEX IF NOT EXISTS signal_ts_idx ON signal (ts DESC);
CREATE INDEX IF NOT EXISTS signal_severity_idx ON signal (severity, ts DESC);

-- one assessment per signal (only S1/S2 get triaged)
CREATE TABLE IF NOT EXISTS assessment (
  signal_id      text        PRIMARY KEY REFERENCES signal(id),
  ts             timestamptz NOT NULL,
  disposition    text        NOT NULL,
  severity_final text        NOT NULL,
  narrative      text        NOT NULL,
  sources        jsonb       NOT NULL,
  confidence     real        NOT NULL,
  model          text        NOT NULL
);

CREATE TABLE IF NOT EXISTS briefing (
  id         text        PRIMARY KEY,
  date_local date        NOT NULL UNIQUE,
  ts         timestamptz NOT NULL,
  body_md    text        NOT NULL,
  quiet      boolean     NOT NULL,
  model      text        NOT NULL
);

-- what WOULD have pushed (FOUNDATION §4 calibration gate): full signal +
-- everything the analyst saw, so the weekly review judges the real artifact
CREATE TABLE IF NOT EXISTS shadow_push (
  id         text        PRIMARY KEY,
  ts         timestamptz NOT NULL,
  signal_id  text        NOT NULL REFERENCES signal(id),
  signal     jsonb       NOT NULL,
  assessment jsonb,
  would_send text        NOT NULL,
  pushed     boolean     NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS analyst_usage (
  id            text        PRIMARY KEY,
  ts            timestamptz NOT NULL,
  kind          text        NOT NULL, -- 'triage' | 'briefing'
  model         text        NOT NULL,
  input_tokens  integer     NOT NULL,
  output_tokens integer     NOT NULL,
  web_searches  integer     NOT NULL DEFAULT 0,
  est_cost_usd  real        NOT NULL
);
CREATE INDEX IF NOT EXISTS analyst_usage_ts_idx ON analyst_usage (ts DESC);

-- per-watch-region nav-integrity rollups (D3's history; written by the sweep job)
CREATE TABLE IF NOT EXISTS integrity_rollup (
  bucket_ts  timestamptz NOT NULL,
  region     text        NOT NULL,
  aircraft   integer     NOT NULL, -- aircraft carrying NIC data
  low_nic    integer     NOT NULL, -- of those, NIC <= 4
  PRIMARY KEY (bucket_ts, region)
);

CREATE TABLE IF NOT EXISTS baseline (
  cell        text        NOT NULL,
  hour        smallint    NOT NULL,
  daytype     text        NOT NULL,
  median      real        NOT NULL,
  mad         real        NOT NULL,
  samples     integer     NOT NULL,
  days        integer     NOT NULL,
  computed_at timestamptz NOT NULL,
  PRIMARY KEY (cell, hour, daytype)
);

-- home briefing (FOUNDATION §12). Crime near home from Denver Open Data, keyed
-- by the city's OFFENSE_ID (incident + offense code, stable across republishes;
-- OBJECTID is not). first_seen = when this collector first saw the row, the
-- nearest thing to a publication time the city exposes.
CREATE TABLE IF NOT EXISTS home_crime (
  id            text             PRIMARY KEY,
  reported_at   timestamptz      NOT NULL,
  occurred_at   timestamptz,
  category      text             NOT NULL,
  offense_type  text             NOT NULL,
  address       text             NOT NULL DEFAULT '',
  neighborhood  text             NOT NULL DEFAULT '',
  lat           double precision NOT NULL,
  lon           double precision NOT NULL,
  first_seen    timestamptz      NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS home_crime_reported_idx ON home_crime (reported_at DESC);

-- home detector output (Stage 3): the only home data the writer may see.
-- dedupe_key makes every rule fire once per condition (one offense, one
-- cluster crossing). noted_at is set when a home note carried the event.
CREATE TABLE IF NOT EXISTS home_event (
  id          text        PRIMARY KEY,
  ts          timestamptz NOT NULL,
  rule        text        NOT NULL,
  dedupe_key  text        NOT NULL UNIQUE,
  payload     jsonb       NOT NULL,
  noted_at    timestamptz
);
CREATE INDEX IF NOT EXISTS home_event_ts_idx ON home_event (ts DESC);

-- Stage 4 output: the morning home note and the Monday roundup. One row per
-- kind per local day; quiet = nothing to say (no push). model is null when
-- the text was rendered in code (no API key, spend cap, refusal or failure).
CREATE TABLE IF NOT EXISTS home_note (
  id          text        PRIMARY KEY,
  date_local  date        NOT NULL,
  kind        text        NOT NULL,
  ts          timestamptz NOT NULL,
  body        text        NOT NULL,
  quiet       boolean     NOT NULL DEFAULT false,
  items       integer     NOT NULL DEFAULT 0,
  model       text,
  pushed      boolean     NOT NULL DEFAULT false,
  UNIQUE (date_local, kind)
);
`;

export async function ensureSchema(db: Queryable): Promise<void> {
  await db.query(SCHEMA);
}
