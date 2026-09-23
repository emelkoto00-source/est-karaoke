EST Karaoke — Original Track Reference / Enhanced Sync
======================================================

WHAT THIS ADDS
--------------
Karaoke Audio, Video Upload, and YouTube Karaoke Link now have an OPTIONAL
Enhanced Sync mode.

KARAOKE AUDIO
  karaoke/instrumental upload
  + optional original studio audio
  -> Demucs removes vocals from original reference
  -> LRCLIB is matched against original studio duration
  -> accompaniment fingerprints are compared
  -> EST builds original-time -> karaoke-time anchors
  -> LRCLIB line + estimated word timings are remapped
  -> Roblox upload/moderation
  -> Review

VIDEO UPLOAD
  karaoke video
  + optional original studio audio
  -> extract karaoke video audio
  -> original-reference AI comparison
  -> remap LRCLIB to target timeline
  -> existing visible karaoke-highlight detector cross-checks the result
  -> only modest residual video corrections are auto-applied after a strong
     original-reference map; large disagreements are left for Review
  -> Roblox upload/moderation

YOUTUBE KARAOKE LINK
  karaoke YouTube URL
  + optional original-studio YouTube URL
  -> download both
  -> extract karaoke audio
  -> Demucs original reference
  -> LRCLIB against studio-reference duration
  -> original-reference timeline mapping
  -> existing video highlight cross-check
  -> Roblox

HOW THE COMPARISON WORKS
------------------------
This is AI-assisted but intentionally not an ASR/Whisper dependency.

1. Demucs htdemucs removes the lead vocal from the original studio track.
2. src/audio_reference_sync.py decodes both accompaniments without trimming.
3. It extracts pitch-class/chroma fingerprints at multiple time points.
4. It searches for the strongest global timeline shift, including key changes.
5. It gathers local anchors throughout the song.
6. Only a high-confidence, non-ambiguous map is auto-applied.
7. Local anchors create a piecewise timeline map, so the system can handle more
   than a single constant Global Lyric Offset when the tracks drift slightly.
8. If confidence is weak, EST does NOT force a match. Existing video sync and
   manual Global Lyric Offset remain available.

WHY THIS IS BETTER THAN ONLY A GLOBAL OFFSET
--------------------------------------------
A constant offset can fix an added intro but cannot fix local drift or modest
arrangement/timing differences. Enhanced Sync can map different points in the
original track to different points in the karaoke track.

SAFETY / FALLBACK
-----------------
- Existing modes still work when Enhanced Sync is OFF.
- Weak reference matches are not auto-applied.
- Video highlight sync remains active for video/YouTube modes.
- Manual Global Lyric Offset remains authoritative in Review.
- The final editable Source field is unchanged.

FILES ADDED
-----------
src/audio_reference_sync.py
src/reference_sync.js

FILES UPDATED
-------------
public/index.html
src/server.js
src/youtube.js
Dockerfile
package.json
.env.example

NO ROBLOX STUDIO SCRIPT CHANGES ARE REQUIRED.

YOUTUBE NOTE
------------
Both YouTube links use the same existing yt-dlp/cookie infrastructure. If
Railway is challenged by YouTube, YOUTUBE_COOKIES_B64 may still be required.
Never commit YouTube cookies to GitHub.

RESOURCE NOTE
-------------
Enhanced Sync deliberately takes longer because the original reference is run
through Demucs before the comparison. Demucs is serialized to reduce peak RAM.
The fingerprint comparison itself is much lighter than Demucs.
