EST Karaoke — Durable Library Persistence
===========================================

WHY THIS PATCH EXISTS

Before this patch, EST stored all jobs and KTV songs in:

  data/state.json

That is local application filesystem storage. It is not sufficient for a
library that must survive Railway redeployments or complete Railway removal.

NEW STORAGE MODEL

When EST_DATABASE_URL is configured, PostgreSQL becomes the authoritative
source of truth for:

  - KTV library entries
  - lyric timing
  - Global Lyric Offset
  - editable Source
  - Roblox asset IDs
  - speed
  - song numbers
  - job state

The application automatically creates:

  est_karaoke_state
  est_karaoke_library_snapshots

AUTOMATIC SNAPSHOTS

Whenever the actual KTV library changes, EST stores a historical snapshot.
By default it retains the latest 250 unique library states.

Set:
  EST_LIBRARY_SNAPSHOTS=250

The snapshots protect against accidental library edits/deletes in addition to
Railway deployment loss.

IMPORTANT: USE A DATABASE OUTSIDE RAILWAY

If your requirement is:

  "songs must survive even if my whole Railway project is deleted"

then do NOT make Railway PostgreSQL your only copy.

Use an external PostgreSQL provider/account that is independent of Railway.
Examples include Supabase, Neon, or another PostgreSQL host.

The exact provider is your choice.

RAILWAY VARIABLES

Add these to Railway Variables:

  EST_DATABASE_URL=<external PostgreSQL connection string>
  EST_DATABASE_REQUIRED=true
  EST_LIBRARY_SNAPSHOTS=250

Never commit the real EST_DATABASE_URL to GitHub.

SAFETY BEHAVIOR

If EST_DATABASE_URL is configured but the database is temporarily unreachable,
EST FAILS STARTUP instead of silently starting with an empty temporary library.

This is intentional.

It prevents a database/network problem from looking like:
  "all songs disappeared"

Railway can keep the previous healthy deployment active until the database
connection works again.

BACKUP BUTTON

The KTV Library tab now contains:

  Download Backup
  Restore Backup

Download Backup creates a JSON file containing:
  - library songs
  - lyric timing
  - Roblox asset IDs
  - next song number

No API keys, passwords, cookies, Railway secrets, or original uploaded audio
are included.

RESTORE

Restore Backup accepts one of these EST JSON backup files and restores the
library into the currently configured persistence backend.

EXISTING SONGS — IMPORTANT FIRST MIGRATION

Before your FIRST deploy of this patch, download/export your existing library
from the currently running EST service.

Because the old version uses local state.json, you must not assume that state
will automatically appear in a newly built Railway deployment.

After the new persistent version is online:
  1. verify External PostgreSQL is shown in the KTV Library tab
  2. if your library is empty, use Restore Backup
  3. confirm songs are visible
  4. restart/redeploy Railway and confirm songs remain

ROBLOX AUDIO

The database does not store audio binaries.
Your song entries point at the Roblox audio asset IDs already created by EST.

So if Railway disappears:
  - Roblox audio assets remain on Roblox
  - external PostgreSQL keeps EST metadata/lyrics/IDs
  - redeploy EST anywhere
  - reconnect EST_DATABASE_URL
  - KTV library returns

FILES CHANGED

  package.json
  public/index.html
  src/server.js
  src/store.js
  .env.example

No Roblox Studio scripts need changing.
