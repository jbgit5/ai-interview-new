import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "Missing DATABASE_URL in .env.local. Start the local DB with: npm run db:local:up"
  );
}

// DATABASE_POOL_SIZE can be set per environment:
// development: 10 (default), staging: 50, production: 100+
// For 200 parallel interviews, each turn needs ~1 connection, so pool >= 60
// is the safe minimum to handle bursts without queuing.
const poolMax = process.env.DATABASE_POOL_SIZE
  ? parseInt(process.env.DATABASE_POOL_SIZE, 10)
  : 20;

export const pool = new Pool({
  connectionString,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  max: poolMax,
  allowExitOnIdle: false,
  keepAlive: true,
});
