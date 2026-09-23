import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

function normalizeState(parsed) {
  const state = {
    jobs: Array.isArray(parsed?.jobs) ? parsed.jobs : [],
    library: Array.isArray(parsed?.library) ? parsed.library : [],
    nextSongNumber: 100001,
  };

  const next = Number(parsed?.nextSongNumber);
  if (Number.isInteger(next) && next > 0) {
    state.nextSongNumber = next;
  } else {
    let highest = 100000;
    for (const song of state.library) {
      const n = Number(song?.number ?? song?.Number);
      if (Number.isInteger(n) && n > highest) highest = n;
    }
    state.nextSongNumber = highest + 1;
  }

  return state;
}

function libraryFingerprint(state) {
  const payload = JSON.stringify({
    library: Array.isArray(state?.library) ? state.library : [],
    nextSongNumber: Number(state?.nextSongNumber) || 100001,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export class JsonStore {
  constructor(file) {
    this.file = file;
    this.state = { jobs: [], library: [], nextSongNumber: 100001 };
    this.writeChain = Promise.resolve();

    // IMPORTANT:
    // Use EST_DATABASE_URL for an EXTERNAL Postgres database such as
    // Supabase, Neon, or another provider that is not deleted with Railway.
    this.databaseUrl = String(process.env.EST_DATABASE_URL || '').trim();
    this.databaseRequired = String(process.env.EST_DATABASE_REQUIRED || 'false').toLowerCase() === 'true';
    this.maxSnapshots = Math.max(10, Math.min(1000, Number(process.env.EST_LIBRARY_SNAPSHOTS || 250) || 250));

    this.pool = null;
    this.mode = this.databaseUrl ? 'external-postgres' : 'local-json';
    this.lastLibraryFingerprint = '';
  }

  async readLocalIfPresent() {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      return normalizeState(JSON.parse(raw));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async initPostgres() {
    this.pool = new Pool({
      connectionString: this.databaseUrl,
      max: 4,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    });

    // Fail early if the external DB cannot be reached. We intentionally do
    // NOT silently fall back to a blank local library when EST_DATABASE_URL
    // is configured; that could make a temporary database outage look like
    // "all songs disappeared".
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(`
        CREATE TABLE IF NOT EXISTS est_karaoke_state (
          id SMALLINT PRIMARY KEY CHECK (id = 1),
          state JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS est_karaoke_library_snapshots (
          id BIGSERIAL PRIMARY KEY,
          fingerprint TEXT NOT NULL UNIQUE,
          state JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async load() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });

    if (this.databaseUrl) {
      try {
        await this.initPostgres();

        const result = await this.pool.query(
          'SELECT state FROM est_karaoke_state WHERE id = 1'
        );

        if (result.rows.length) {
          this.state = normalizeState(result.rows[0].state);
        } else {
          // First external-DB startup:
          // migrate an existing local state.json automatically if the runtime
          // still has one. Otherwise initialize a clean state.
          const local = await this.readLocalIfPresent();
          this.state = local || normalizeState({});
          await this.saveToPostgres({ forceSnapshot: true });
        }

        this.lastLibraryFingerprint = libraryFingerprint(this.state);
        return this.state;
      } catch (err) {
        // When an external DB is configured, never pretend an empty local
        // library is authoritative. Surface the error so Railway keeps the
        // previous healthy deployment rather than booting with no songs.
        throw new Error(`EST external library database is unavailable: ${err.message}`);
      }
    }

    if (this.databaseRequired) {
      throw new Error(
        'EST_DATABASE_REQUIRED=true but EST_DATABASE_URL is not configured. ' +
        'Refusing to start with temporary Railway filesystem storage.'
      );
    }

    try {
      const raw = await fs.readFile(this.file, 'utf8');
      this.state = normalizeState(JSON.parse(raw));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.state = normalizeState({});
      await this.saveLocal();
    }

    this.lastLibraryFingerprint = libraryFingerprint(this.state);
    return this.state;
  }

  computeNextSongNumber() {
    let highest = 100000;
    for (const song of this.state.library) {
      const n = Number(song.number ?? song.Number);
      if (Number.isInteger(n) && n > highest) highest = n;
    }
    return highest + 1;
  }

  allocateSongNumber() {
    const value = String(this.state.nextSongNumber || this.computeNextSongNumber());
    this.state.nextSongNumber = Number(value) + 1;
    return value;
  }

  async saveLocal() {
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2));
    await fs.rename(tmp, this.file);
  }

  async saveToPostgres({ forceSnapshot = false } = {}) {
    const fingerprint = libraryFingerprint(this.state);
    const libraryChanged = forceSnapshot || fingerprint !== this.lastLibraryFingerprint;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO est_karaoke_state (id, state, updated_at)
         VALUES (1, $1::jsonb, NOW())
         ON CONFLICT (id)
         DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
        [JSON.stringify(this.state)]
      );

      if (libraryChanged) {
        await client.query(
          `INSERT INTO est_karaoke_library_snapshots (fingerprint, state)
           VALUES ($1, $2::jsonb)
           ON CONFLICT (fingerprint) DO NOTHING`,
          [fingerprint, JSON.stringify({
            library: this.state.library,
            nextSongNumber: this.state.nextSongNumber,
          })]
        );

        await client.query(
          `DELETE FROM est_karaoke_library_snapshots
           WHERE id NOT IN (
             SELECT id
             FROM est_karaoke_library_snapshots
             ORDER BY id DESC
             LIMIT $1
           )`,
          [this.maxSnapshots]
        );
      }

      await client.query('COMMIT');
      this.lastLibraryFingerprint = fingerprint;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  save() {
    this.writeChain = this.writeChain.then(async () => {
      if (this.pool) {
        await this.saveToPostgres();
      } else {
        await this.saveLocal();
        this.lastLibraryFingerprint = libraryFingerprint(this.state);
      }
    });
    return this.writeChain;
  }

  storageInfo() {
    return {
      mode: this.mode,
      durableAcrossRailwayRemoval: Boolean(this.pool),
      snapshotsEnabled: Boolean(this.pool),
      maxSnapshots: this.pool ? this.maxSnapshots : 0,
    };
  }

  async listLibrarySnapshots(limit = 20) {
    if (!this.pool) return [];
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const result = await this.pool.query(
      `SELECT id, created_at,
              jsonb_array_length(COALESCE(state->'library', '[]'::jsonb)) AS song_count
       FROM est_karaoke_library_snapshots
       ORDER BY id DESC
       LIMIT $1`,
      [safeLimit]
    );
    return result.rows;
  }

  async restoreLibrarySnapshot(id) {
    if (!this.pool) throw new Error('External PostgreSQL is not configured.');

    const result = await this.pool.query(
      'SELECT state FROM est_karaoke_library_snapshots WHERE id = $1',
      [String(id)]
    );
    if (!result.rows.length) throw new Error('Library snapshot not found.');

    const snap = result.rows[0].state || {};
    this.state.library = Array.isArray(snap.library) ? snap.library : [];
    const next = Number(snap.nextSongNumber);
    this.state.nextSongNumber =
      Number.isInteger(next) && next > 0 ? next : this.computeNextSongNumber();

    // Force a fresh snapshot for the restored state too.
    this.lastLibraryFingerprint = '';
    await this.save();
    return this.state;
  }

  async importLibraryBackup(payload) {
    const body = payload?.backup && typeof payload.backup === 'object'
      ? payload.backup
      : payload;

    const songs =
      Array.isArray(body?.library) ? body.library :
      Array.isArray(body?.songs) ? body.songs :
      null;

    if (!songs) throw new Error('Backup must contain a library or songs array.');

    this.state.library = songs;

    const requestedNext = Number(body?.nextSongNumber);
    this.state.nextSongNumber =
      Number.isInteger(requestedNext) && requestedNext > 0
        ? requestedNext
        : this.computeNextSongNumber();

    this.lastLibraryFingerprint = '';
    await this.save();
    return this.state;
  }
}
