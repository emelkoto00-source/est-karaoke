EST KARAOKE AUTOMATION v1
======================

This package is built specifically for the EST game and around the Karaoke.rbxm you uploaded.
It keeps the existing KaraokeBookStand, KaraokeScreen, KaraokeGui,
KaraokeEditorGui and ServerStorage.KaraokeMic model, but replaces the
catalog/playback logic with a live website-managed KTV system.

WHAT IS IMPLEMENTED
-------------------

WEBSITE / RAILWAY
- Upload karaoke audio.
- Title + Artist.
- Playback Speed selector from 1.0x through 2.9x.
- Upload account selector: WAN / WAN 2ND.
- Roblox Open Cloud upload using the existing API-key pattern.
- Real Roblox moderation gate.
- Automatic synchronized-lyrics provider adapter.
- LRC parser.
- If the provider has line timing only, word timing is generated automatically
  across each timed line so the KTV highlight can sweep across the text.
- Review page with actual audio player and live KTV-style lyric highlighting.
- Global lyric offset controls (-0.5 / +0.5 seconds) for karaoke versions with
  a longer/shorter intro.
- Explicit "Yes - add to KTV library" review gate.
- Roblox Open Cloud permission grant to EST_UNIVERSE_ID.
- Automatic song number allocation starting at 100001.
- Live /api/game/library endpoint for Roblox.
- Persistent JSON state designed for a Railway volume mounted at /app/data.

ROBLOX
- Railway -> Roblox live library synchronization with DataStore last-good cache.
- Existing song book reads the live website catalog.
- Existing queue/booth architecture remains.
- PlaybackSpeed support.
- Lyric timing follows source TimePosition correctly at different playback speeds.
- KTV progressive lyric highlight on the existing KaraokeScreen.
- Song requester is the lead singer.
- Only authorized singers receive the ServerStorage.KaraokeMic tool.
- Other players can request to join the current singer.
- Lead singer can Approve or Decline the join request.
- Approved guest singer receives an authorized mic for that song.
- Mic removed/authorization disabled when the song finishes.
- Per-player persistent mic settings:
    Bass:   -12 dB to +12 dB
    Treble: -12 dB to +12 dB
    Echo:   0% to 100%
- MIC SETTINGS top button appears only while the authorized Karaoke Mic is equipped.
- Audio API bridge attempts:
    AudioDeviceInput -> AudioEqualizer -> AudioEcho -> AudioEmitter
  so Bass/Treble/Echo affect the authorized singer's KTV voice path.

IMPORTANT ABOUT THE MIC
-----------------------
The KaraokeMic inside the uploaded RBXM is geometry only. It does not contain a
live voice audio graph. KaraokeMicAudio.server.lua adds that graph at runtime.

The live DSP path depends on Roblox Voice Chat + the newer Audio API being
available/enabled in your experience. The script fails safely if those classes
or properties are unavailable, so the queue/mic authorization system still works.
You must test the actual voice DSP in a published voice-enabled Roblox server.

Also: remove/disable any public Mic Tool from StarterPack. Keep the authoritative
KaraokeMic template in ServerStorage only. Otherwise everybody may still hold the
old visual mic tool even though they are not authorized for the KTV voice graph.

IMPORTANT ABOUT AUTOMATIC LYRICS
--------------------------------
This package does NOT scrape lyric websites.
It expects an authorized/licensed synchronized-lyrics provider configured with:

  LYRICS_PROVIDER_URL=https://your-provider.example/api/lyrics
  LYRICS_PROVIDER_TOKEN=optional-private-token

The backend sends:
  GET <LYRICS_PROVIDER_URL>?title=<title>&artist=<artist>
  Authorization: Bearer <token>    (only when token is configured)

Supported provider responses include:

1) Synchronized LRC:
  {"syncedLyrics":"[00:12.30]First line\n[00:17.50]Second line"}

2) LRC alias:
  {"lrc":"[00:12.30]First line"}

3) Timed lines:
  {
    "lines": [
      {"start":12.3,"end":17.5,"text":"First line"}
    ]
  }

4) Word-level timing:
  {
    "lines": [
      {
        "start":12.3,
        "end":17.5,
        "text":"Oh oh oh yeah",
        "words":[
          {"text":"Oh","start":12.3,"end":13.0}
        ]
      }
    ]
  }

If only line timing exists, the backend generates word spans automatically.
If the provider has real word timing, it is preserved.

A pure instrumental karaoke file does not contain sung words, so exact lyric
recognition cannot be recovered from that audio alone. That is why the system
uses title + artist to get synchronized lyrics first, then gives you the KTV
preview + global offset before publishing.

RAILWAY SETUP
-------------
Use a completely NEW Railway project/service for EST Karaoke. Keep it separate from every existing Railway app.

1. Upload this website folder to a new GitHub repository.
2. Deploy it on Railway.
3. Add a Railway volume mounted at:
     /app/data
4. Set the variables from .env.example.

Required before live use:
  ADMIN_PASSWORD
  GAME_SYNC_TOKEN
  PUBLIC_BASE_URL
  EST_UNIVERSE_ID

WAN:
  ROBLOX_API_KEY
  ROBLOX_CREATOR_ID=790418153
  ROBLOX_CREATOR_TYPE=group

WAN 2ND:
  ROBLOX_API_KEY_WAN2
  ROBLOX_CREATOR_ID_WAN2=401704136
  ROBLOX_CREATOR_TYPE_WAN2=group

Lyrics:
  LYRICS_PROVIDER_URL
  LYRICS_PROVIDER_TOKEN   (only if provider needs one)

Do not send API keys, tokens or passwords in chat.

The Roblox API-key identities need permission to manage the source community and
permission to grant Use access to the target EST universe, using the same cross-community permission pattern.

ROBLOX STUDIO INSTALL
---------------------
Start from the Karaoke.rbxm already in your game.

1. ReplicatedStorage > KaraokeSongs
   Replace the entire ModuleScript source with:
     roblox/KaraokeSongs.v2.lua

2. ServerScriptService > KaraokeServer
   Replace the entire Script source with:
     roblox/KaraokeServer.v2.lua

3. StarterPlayer > StarterPlayerScripts > KaraokeClient
   Replace the entire LocalScript source with:
     roblox/KaraokeClient.v2.lua

4. Create a new Script in ServerScriptService named:
     KaraokeSync
   Paste:
     roblox/KaraokeSync.server.lua

   Add Script Attributes:
     BaseUrl        String  https://YOUR-EST-KARAOKE-SERVICE.up.railway.app
     GameSyncToken  String  <same private GAME_SYNC_TOKEN as Railway>
     PollSeconds    Number  20

5. Create another Script in ServerScriptService named:
     KaraokeMicAudio
   Paste:
     roblox/KaraokeMicAudio.server.lua

6. Keep:
     ServerStorage > KaraokeMic

7. Disable/remove any general-public Mic tool from StarterPack.

8. KaraokeEditor can remain, but the new KaraokeServer makes it read-only.
   The website becomes the authoritative song manager.

9. Game Settings > Security:
   Enable HTTP Requests.

10. Publish the place.

TEST ORDER
----------

A) WEBSITE WITHOUT REAL ROBLOX / LYRICS
For UI testing only, Railway/local env can use:
  SIMULATE_ROBLOX=true
  LYRICS_SIMULATION=true

Upload a short audio file. It should flow:
  Processing -> Upload -> Lyrics -> Review

The review should show a highlighted KTV lyric preview.

B) REAL ROBLOX
Set:
  SIMULATE_ROBLOX=false
  EST_UNIVERSE_ID=<your EST universe id>
  real API keys

Upload one test audio.
Expected:
  Upload -> Moderation -> Lyrics -> Review -> Access -> KTV

C) ROBLOX LIVE SYNC
Start a fresh published server.
Expected Output:
  [KaraokeSync] synced N song(s)

Open the song book. The website song should appear without editing Studio.

D) JOIN SINGER
1. Player A requests a song.
2. Song starts; Player A receives Karaoke Mic.
3. Player B opens the booth and presses "Request to join singer".
4. Player A gets Approve / Decline.
5. Approve -> Player B receives Karaoke Mic.
6. Song ends -> both authorized KTV mics disappear.

E) MIC EQ
While an authorized Karaoke Mic is equipped:
  MIC SETTINGS appears at the top.
Change Bass / Treble / Echo.
Settings are saved per Roblox user.

If the tool authorization works but Bass/Treble/Echo has no audible effect,
check Roblox voice chat / Audio API availability for the published experience and
Studio output for [KaraokeMicAudio] warnings.

DESIGN DECISIONS
----------------
- Speed is FINAL KTV PlaybackSpeed. The uploaded/moderated audio is not secretly
  transformed and then restored to something different after moderation.
- The website only publishes a song after a review step.
- The song requester controls guest-singer approval.
- Co-singers cannot skip the lead requester's song.
- The website/Railway catalog is authoritative; the old in-game song editor is
  no longer allowed to overwrite it.


EST PROJECT SEPARATION
----------------------
Recommended names:
  GitHub repo:     est-karaoke-live
  Railway project: est-karaoke-live
  Website title:   EST Karaoke

This package is for the EST Roblox experience/map only.

Use:
  EST_UNIVERSE_ID=<EST Roblox Universe ID>

When Railway gives this project its domain, set the KaraokeSync Script Attribute:
  BaseUrl = https://YOUR-EST-KARAOKE-DOMAIN

Use a new ADMIN_PASSWORD and a new GAME_SYNC_TOKEN for this EST service.
Do not reuse another game's Universe ID or sync endpoint.
