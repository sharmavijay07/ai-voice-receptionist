import type { StoreData } from "./types";

export type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

const ROW_ID = "desk";

export class PgJsonStore {
  constructor(private readonly query: QueryFn) {}

  async init(): Promise<void> {
    await this.query(`CREATE TABLE IF NOT EXISTS desk_store (
      id text PRIMARY KEY,
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  }

  async load(): Promise<StoreData | null> {
    const result = await this.query(`SELECT data FROM desk_store WHERE id = $1`, [ROW_ID]);
    const data = result.rows[0]?.data;
    if (!data) return null;
    const parsed = (typeof data === "string" ? JSON.parse(data) : data) as StoreData;
    return {
      calls: parsed.calls ?? [],
      bookings: parsed.bookings ?? [],
      messages: parsed.messages ?? [],
    };
  }

  async save(data: StoreData): Promise<void> {
    await this.query(
      `INSERT INTO desk_store (id, data, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [ROW_ID, JSON.stringify(data)],
    );
  }
}

export async function connectPg(databaseUrl: string): Promise<QueryFn> {
  const pg = (await import("pg")) as unknown as {
    Pool: new (config: Record<string, unknown>) => {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
    };
  };
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? undefined : { rejectUnauthorized: false },
  });
  return async (sql, params) => {
    const result = await pool.query(sql, params);
    return { rows: result.rows };
  };
}
