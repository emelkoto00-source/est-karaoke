#!/usr/bin/env python3
import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np


def rolling_median(values, window=3):
    values = np.asarray(values, dtype=np.float64)
    if values.size == 0:
        return values
    radius = max(0, int(window) // 2)
    out = np.empty_like(values)
    for i in range(len(values)):
        a = max(0, i - radius)
        b = min(len(values), i + radius + 1)
        out[i] = np.median(values[a:b])
    return out


def karaoke_band_features(frame, band_count=6):
    h, w = frame.shape[:2]

    # Karaoke lyrics are typically centered in the lower half. This region is
    # intentionally wider/lower than v1 so two-line KTV text near the bottom is
    # not clipped out.
    x1, x2 = int(w * 0.04), int(w * 0.96)
    y1, y2 = int(h * 0.48), int(h * 0.96)
    roi = frame[y1:y2, x1:x2]

    if roi.size == 0:
        return np.zeros(band_count, dtype=np.float64)

    target_w = 560
    if roi.shape[1] > target_w:
        scale = target_w / roi.shape[1]
        roi = cv2.resize(
            roi,
            (target_w, max(1, int(roi.shape[0] * scale))),
            interpolation=cv2.INTER_AREA,
        )

    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]

    # Karaoke highlight text is usually a bright chromatic fill over outlined
    # glyphs. Restricting to strong text-like edges greatly reduces moving
    # colorful background footage.
    edges = cv2.Canny(gray, 70, 155)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)

    chromatic = (sat >= 48) & (val >= 145)
    mask = (chromatic & (edges > 0)).astype(np.uint8) * 255

    # Join letter strokes slightly, but don't flood-fill the background.
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (5, 2)),
    )

    height, width = mask.shape
    left_width = max(1, int(width * 0.42))
    features = []

    for band in range(band_count):
        by1 = int(height * band / band_count)
        by2 = int(height * (band + 1) / band_count)
        strip = mask[by1:by2, :]
        left = strip[:, :left_width]

        if strip.size == 0:
            features.append(0.0)
            continue

        left_ratio = np.count_nonzero(left) / max(1, left.size)
        full_ratio = np.count_nonzero(strip) / max(1, strip.size)

        # Weight the left side heavily. A real karaoke line highlight normally
        # starts from the left edge; word-by-word changes later in the line
        # should not look like a fresh line start.
        features.append(float(left_ratio * 0.82 + full_ratio * 0.18))

    return np.asarray(features, dtype=np.float64)


def sample_video(video_path, sample_fps, max_seconds):
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError("OpenCV could not open the karaoke video.")

    native_fps = cap.get(cv2.CAP_PROP_FPS)
    if not native_fps or not math.isfinite(native_fps) or native_fps <= 0:
        native_fps = 30.0

    sample_fps = max(2.0, min(12.0, float(sample_fps)))
    frame_step = max(1, int(round(native_fps / sample_fps)))
    max_frames = int(max_seconds * native_fps)

    times = []
    features = []
    frame_index = 0

    while frame_index <= max_frames:
        ok = cap.grab()
        if not ok:
            break

        if frame_index % frame_step == 0:
            ok, frame = cap.retrieve()
            if not ok:
                break

            times.append(frame_index / native_fps)
            features.append(karaoke_band_features(frame))

        frame_index += 1

    cap.release()

    if len(times) < 20:
        raise RuntimeError("Not enough video frames were available for sync analysis.")

    return (
        np.asarray(times, dtype=np.float64),
        np.asarray(features, dtype=np.float64),
    )


def detect_band_onsets(times, features, sample_fps):
    if features.ndim != 2:
        return [], {"bands": 0}

    all_events = []
    band_debug = []

    for band in range(features.shape[1]):
        raw = features[:, band]
        smooth = rolling_median(raw, 3)

        lo = float(np.percentile(smooth, 18))
        hi = float(np.percentile(smooth, 94))
        amplitude = hi - lo

        # Skip bands that never show meaningful chromatic text activity.
        if amplitude < 0.000012:
            band_debug.append({
                "band": band,
                "usable": False,
                "amplitude": amplitude,
            })
            continue

        reset_level = lo + amplitude * 0.14
        trigger_level = lo + amplitude * 0.32
        strong_level = lo + amplitude * 0.46

        armed = False
        low_run = 0
        above_run = 0
        last_event = -999.0
        band_events = []

        low_needed = max(2, int(round(sample_fps * 0.28)))
        above_needed = max(1, int(round(sample_fps * 0.12)))

        for i, value in enumerate(smooth):
            if value <= reset_level:
                low_run += 1
            else:
                low_run = 0

            if low_run >= low_needed:
                armed = True

            if value >= trigger_level:
                above_run += 1
            else:
                above_run = 0

            if not armed or above_run < above_needed:
                continue

            lookback = max(1, int(round(sample_fps * 0.55)))
            a = max(0, i - lookback)
            recent_low = float(np.min(smooth[a:i + 1]))
            rise = float(value - recent_low)

            if rise < amplitude * 0.20 and value < strong_level:
                continue

            t = float(times[max(0, i - above_needed + 1)])

            # One line onset per band until that band resets to a low-highlight
            # state. This is the key difference from v1: it avoids treating
            # every colored word change as a fresh lyric-line anchor.
            if t - last_event >= 1.0:
                strength = max(0.0, rise / max(amplitude, 1e-9))
                band_events.append((t, strength, band))
                last_event = t

            armed = False
            low_run = 0
            above_run = 0

        all_events.extend(band_events)
        band_debug.append({
            "band": band,
            "usable": True,
            "amplitude": round(amplitude, 8),
            "events": len(band_events),
        })

    # Merge simultaneous detections from neighboring horizontal bands.
    all_events.sort(key=lambda item: item[0])
    merged = []

    for t, strength, band in all_events:
        if merged and t - merged[-1]["time"] <= 0.42:
            existing = merged[-1]
            total = existing["strength"] + strength + 1e-9
            existing["time"] = (
                existing["time"] * existing["strength"] + t * strength
            ) / total
            existing["strength"] = max(existing["strength"], strength)
            existing["bands"].add(band)
        else:
            merged.append({
                "time": t,
                "strength": strength,
                "bands": {band},
            })

    # Remove title-card / channel-logo flashes right at the beginning.
    events = [
        item["time"]
        for item in merged
        if item["time"] >= 1.0
    ]

    return events, {
        "bands": features.shape[1],
        "bandDebug": band_debug,
        "rawBandEvents": len(all_events),
        "mergedEvents": len(events),
    }


def monotonic_matches(offset, lyric_starts, events, tolerance=0.72):
    matches = []
    event_index = 0

    for lyric_index, lyric_time in enumerate(lyric_starts):
        target = lyric_time + offset

        while (
            event_index < len(events)
            and events[event_index] < target - tolerance
        ):
            event_index += 1

        candidates = []
        for idx in (event_index, event_index + 1):
            if 0 <= idx < len(events):
                error = events[idx] - target
                if abs(error) <= tolerance:
                    candidates.append((abs(error), idx, error))

        if not candidates:
            continue

        _, chosen_idx, error = min(candidates, key=lambda item: item[0])
        matches.append({
            "lyricIndex": lyric_index,
            "eventIndex": chosen_idx,
            "lyric": lyric_time,
            "event": events[chosen_idx],
            "error": error,
            "rawOffset": events[chosen_idx] - lyric_time,
        })
        event_index = chosen_idx + 1

    return matches


def score_alignment(offset, lyric_starts, events):
    matches = monotonic_matches(
        offset,
        lyric_starts,
        events,
        tolerance=0.72,
    )

    if not matches:
        return {
            "offset": offset,
            "matches": 0,
            "meanError": 99.0,
            "medianAbsError": 99.0,
            "offsetMad": 99.0,
            "intervalError": 99.0,
            "score": -999.0,
            "pairs": [],
        }

    abs_errors = np.asarray(
        [abs(item["error"]) for item in matches],
        dtype=np.float64,
    )
    offsets = np.asarray(
        [item["rawOffset"] for item in matches],
        dtype=np.float64,
    )

    median_offset = float(np.median(offsets))
    offset_mad = float(np.median(np.abs(offsets - median_offset)))

    interval_errors = []
    for a, b in zip(matches, matches[1:]):
        lyric_gap = b["lyric"] - a["lyric"]
        event_gap = b["event"] - a["event"]
        if lyric_gap > 0.25 and event_gap > 0.25:
            interval_errors.append(abs(event_gap - lyric_gap))

    interval_error = (
        float(np.median(interval_errors))
        if interval_errors
        else 0.0
    )

    mean_error = float(np.mean(abs_errors))
    median_abs_error = float(np.median(abs_errors))
    count = len(matches)

    score = (
        count * 5.0
        - mean_error * 4.0
        - median_abs_error * 3.0
        - offset_mad * 4.0
        - interval_error * 2.5
    )

    return {
        "offset": offset,
        "matches": count,
        "meanError": mean_error,
        "medianAbsError": median_abs_error,
        "offsetMad": offset_mad,
        "intervalError": interval_error,
        "score": score,
        "pairs": matches,
        "medianOffset": median_offset,
    }


def estimate_offset(lyrics, events, max_seconds):
    lyric_starts = [
        float(x["start"])
        for x in lyrics
        if isinstance(x, dict)
        and isinstance(x.get("start"), (int, float))
        and math.isfinite(float(x["start"]))
        and float(x["start"]) <= max_seconds
    ]

    lyric_starts = lyric_starts[:80]
    events = [float(x) for x in events if x <= max_seconds][:160]

    if len(lyric_starts) < 3 or len(events) < 3:
        return None

    min_offset = -30.0
    max_offset = 120.0

    # Candidate offsets from event/lyric pairs.
    bins = {}
    bin_size = 0.20

    for event in events:
        for lyric in lyric_starts:
            delta = event - lyric
            if min_offset <= delta <= max_offset:
                key = round(delta / bin_size) * bin_size
                bins[key] = bins.get(key, 0) + 1

    if not bins:
        return None

    seeds = sorted(
        bins.items(),
        key=lambda item: item[1],
        reverse=True,
    )[:40]

    candidates = []
    seen = set()

    for seed, votes in seeds:
        # 20 ms refinement.
        value = seed - 0.50
        while value <= seed + 0.50 + 1e-9:
            rounded = round(value, 3)
            if rounded not in seen:
                seen.add(rounded)
                result = score_alignment(
                    rounded,
                    lyric_starts,
                    events,
                )
                result["histogramVotes"] = votes
                candidates.append(result)
            value += 0.02

    if not candidates:
        return None

    candidates.sort(key=lambda item: item["score"], reverse=True)
    best = candidates[0]

    # Refine with the median of the actual matched event-line offsets.
    if best["matches"] >= 2:
        refined = score_alignment(
            round(best["medianOffset"], 3),
            lyric_starts,
            events,
        )
        if refined["score"] >= best["score"] - 0.25:
            best = refined

    # Find a genuinely different competing solution for ambiguity testing.
    second = next(
        (
            item for item in candidates[1:]
            if abs(item["offset"] - best["offset"]) >= 0.80
        ),
        None,
    )

    match_factor = min(1.0, best["matches"] / 8.0)
    precision_factor = max(
        0.0,
        min(1.0, 1.0 - best["meanError"] / 0.55),
    )
    stability_factor = max(
        0.0,
        min(1.0, 1.0 - best["offsetMad"] / 0.40),
    )
    interval_factor = max(
        0.0,
        min(1.0, 1.0 - best["intervalError"] / 0.60),
    )

    if second is None:
        uniqueness = 1.0
        score_gap = 999.0
    else:
        score_gap = best["score"] - second["score"]
        uniqueness = max(0.0, min(1.0, score_gap / 8.0))

    confidence = (
        0.30 * match_factor
        + 0.25 * precision_factor
        + 0.20 * stability_factor
        + 0.15 * interval_factor
        + 0.10 * uniqueness
    )

    applied = (
        best["matches"] >= 5
        and best["meanError"] <= 0.45
        and best["medianAbsError"] <= 0.38
        and best["offsetMad"] <= 0.35
        and best["intervalError"] <= 0.55
        and confidence >= 0.78
        and min_offset <= best["offset"] <= max_offset
    )

    return {
        "applied": applied,
        "offset": round(float(best["offset"]), 3),
        "matches": int(best["matches"]),
        "meanError": round(float(best["meanError"]), 3),
        "medianAbsError": round(float(best["medianAbsError"]), 3),
        "offsetMad": round(float(best["offsetMad"]), 3),
        "intervalError": round(float(best["intervalError"]), 3),
        "confidence": round(float(confidence), 3),
        "scoreGap": round(float(score_gap), 3)
        if math.isfinite(score_gap)
        else 999.0,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--lyrics", required=True)
    parser.add_argument("--sample-fps", type=float, default=8.0)
    parser.add_argument("--max-seconds", type=float, default=240.0)
    args = parser.parse_args()

    lyrics = json.loads(
        Path(args.lyrics).read_text(encoding="utf-8")
    )

    sample_fps = max(2.0, min(12.0, args.sample_fps))
    max_seconds = max(30.0, args.max_seconds)

    times, features = sample_video(
        args.video,
        sample_fps,
        max_seconds,
    )

    events, detector = detect_band_onsets(
        times,
        features,
        sample_fps,
    )

    estimate = estimate_offset(
        lyrics,
        events,
        max_seconds,
    )

    if not estimate:
        payload = {
            "applied": False,
            "offset": 0,
            "suggestedOffset": 0,
            "confidence": 0,
            "matchedAnchors": 0,
            "detectedEvents": len(events),
            "reason": (
                "No stable karaoke line-highlight sequence matched LRCLIB. "
                "Use the manual Global Lyric Offset in Review."
            ),
            "detector": detector,
            "method": "band-line-onset-v2",
        }
    else:
        payload = {
            "applied": bool(estimate["applied"]),
            "offset": float(estimate["offset"])
            if estimate["applied"]
            else 0,
            "suggestedOffset": float(estimate["offset"]),
            "confidence": float(estimate["confidence"]),
            "matchedAnchors": int(estimate["matches"]),
            "meanAnchorError": float(estimate["meanError"]),
            "medianAnchorError": float(
                estimate["medianAbsError"]
            ),
            "offsetMad": float(estimate["offsetMad"]),
            "intervalError": float(
                estimate["intervalError"]
            ),
            "detectedEvents": len(events),
            "reason": (
                "Repeated karaoke line-start highlights matched LRCLIB "
                "with a stable constant offset."
                if estimate["applied"]
                else
                "A possible video offset was found, but the line-start "
                "anchors were not consistent enough to auto-apply it. "
                "Use the suggestion only as a manual starting point."
            ),
            "detector": detector,
            "method": "band-line-onset-v2",
        }

    print(json.dumps(payload, separators=(",", ":")))


if __name__ == "__main__":
    main()
