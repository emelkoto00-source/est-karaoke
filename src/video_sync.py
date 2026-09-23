#!/usr/bin/env python3
import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np


def rolling_median(values, window=5):
    if len(values) == 0:
        return values
    window = max(1, int(window))
    radius = window // 2
    out = np.empty_like(values, dtype=np.float64)
    for i in range(len(values)):
        a = max(0, i - radius)
        b = min(len(values), i + radius + 1)
        out[i] = np.median(values[a:b])
    return out


def frame_highlight_score(frame):
    h, w = frame.shape[:2]

    # Central/lower lyric zone. This intentionally avoids most channel logos,
    # top title cards, and bottom-corner watermarks.
    x1, x2 = int(w * 0.10), int(w * 0.90)
    y1, y2 = int(h * 0.48), int(h * 0.88)

    roi = frame[y1:y2, x1:x2]
    if roi.size == 0:
        return 0.0

    target_w = 480
    if roi.shape[1] > target_w:
        scale = target_w / roi.shape[1]
        roi = cv2.resize(
            roi,
            (target_w, max(1, int(roi.shape[0] * scale))),
            interpolation=cv2.INTER_AREA,
        )

    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

    # Highlighted karaoke text is commonly bright + chromatic (green, blue,
    # red, yellow, etc.). Requiring nearby strong edges makes moving colorful
    # background footage count far less than large outlined lyric glyphs.
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]

    edges = cv2.Canny(gray, 70, 150)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)

    bright_color = (sat >= 55) & (val >= 150)
    textlike = bright_color & (edges > 0)

    # Slight horizontal close groups letters/word strokes without turning a
    # colorful background region into one solid blob.
    mask = (textlike.astype(np.uint8) * 255)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 2))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

    return float(np.count_nonzero(mask)) / float(mask.size)


def sample_video(video_path, sample_fps, max_seconds):
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError("OpenCV could not open the downloaded karaoke video.")

    native_fps = cap.get(cv2.CAP_PROP_FPS)
    if not native_fps or not math.isfinite(native_fps) or native_fps <= 0:
        native_fps = 30.0

    frame_step = max(1, int(round(native_fps / sample_fps)))
    max_frames = int(max_seconds * native_fps)

    times = []
    scores = []

    frame_index = 0
    while frame_index <= max_frames:
        ok = cap.grab()
        if not ok:
            break

        if frame_index % frame_step == 0:
            ok, frame = cap.retrieve()
            if not ok:
                break
            t = frame_index / native_fps
            times.append(t)
            scores.append(frame_highlight_score(frame))

        frame_index += 1

    cap.release()

    if len(times) < 12:
        raise RuntimeError("Not enough video frames were available for sync analysis.")

    return np.asarray(times, dtype=np.float64), np.asarray(scores, dtype=np.float64)


def detect_events(times, scores, sample_fps):
    smooth = rolling_median(scores, 5)

    lo = float(np.percentile(smooth, 15))
    hi = float(np.percentile(smooth, 90))
    amplitude = max(hi - lo, 1e-7)

    # Dynamic thresholds let this work across different color intensity,
    # compression, and background footage.
    level_threshold = lo + amplitude * 0.20
    rise_threshold = max(amplitude * 0.08, 0.000015)

    min_spacing = 1.15
    lookback = max(2, int(round(sample_fps * 1.25)))
    events = []
    strengths = []

    for i in range(1, len(smooth)):
        start = max(0, i - lookback)
        recent_low = float(np.min(smooth[start:i])) if i > start else float(smooth[i - 1])
        rise = float(smooth[i] - recent_low)
        derivative = float(smooth[i] - smooth[i - 1])

        qualifies = (
            smooth[i] >= level_threshold
            and rise >= rise_threshold
            and derivative > -rise_threshold * 0.25
        )

        if not qualifies:
            continue

        t = float(times[i])
        strength = rise / amplitude

        if events and t - events[-1] < min_spacing:
            # Keep the stronger candidate inside a single lyric/word burst.
            if strength > strengths[-1]:
                events[-1] = t
                strengths[-1] = strength
            continue

        events.append(t)
        strengths.append(strength)

    # Avoid title-card flashes right at 0:00.
    filtered = [
        (t, s) for t, s in zip(events, strengths)
        if t >= 1.0
    ]

    return [t for t, _ in filtered], [s for _, s in filtered], {
        "baseline": lo,
        "high": hi,
        "amplitude": amplitude,
        "levelThreshold": level_threshold,
        "riseThreshold": rise_threshold,
    }


def nearest_alignment_score(offset, lyric_starts, events, tolerance=1.15):
    used = set()
    errors = []

    for lyric_time in lyric_starts:
        target = lyric_time + offset
        best_idx = None
        best_error = None

        for idx, event in enumerate(events):
            if idx in used:
                continue
            err = abs(event - target)
            if err <= tolerance and (best_error is None or err < best_error):
                best_error = err
                best_idx = idx

        if best_idx is not None:
            used.add(best_idx)
            errors.append(best_error)

    matches = len(errors)
    mean_error = float(np.mean(errors)) if errors else 99.0
    return matches, mean_error


def estimate_offset(lyrics, events):
    lyric_starts = [
        float(x["start"])
        for x in lyrics
        if isinstance(x, dict)
        and isinstance(x.get("start"), (int, float))
        and math.isfinite(float(x["start"]))
    ]

    lyric_starts = lyric_starts[:60]
    events = events[:120]

    if len(lyric_starts) < 2 or len(events) < 2:
        return None

    # Most downloaded karaoke intros are extra seconds before the original
    # timeline. Negative offsets are still allowed for videos that start late.
    min_offset = -30.0
    max_offset = 120.0

    # Pair-difference histogram gives candidate offsets. True lyric/highlight
    # timing creates repeated differences; random background events spread out.
    bins = {}
    bin_size = 0.25

    for e in events:
        for l in lyric_starts:
            d = e - l
            if min_offset <= d <= max_offset:
                key = round(d / bin_size) * bin_size
                bins[key] = bins.get(key, 0) + 1

    if not bins:
        return None

    top_candidates = sorted(
        bins.items(),
        key=lambda item: item[1],
        reverse=True,
    )[:30]

    best = None
    for candidate, histogram_votes in top_candidates:
        # Refine around each histogram peak.
        start = candidate - 0.5
        stop = candidate + 0.5
        offset = start
        while offset <= stop + 1e-9:
            matches, mean_error = nearest_alignment_score(
                offset,
                lyric_starts,
                events,
                tolerance=1.15,
            )

            score = (
                matches * 3.0
                + min(histogram_votes, 15) * 0.12
                - mean_error * 1.25
            )

            current = {
                "offset": offset,
                "matches": matches,
                "meanError": mean_error,
                "score": score,
                "histogramVotes": histogram_votes,
            }

            if best is None or current["score"] > best["score"]:
                best = current

            offset += 0.05

    if not best:
        return None

    best["offset"] = round(best["offset"], 3)
    best["meanError"] = round(best["meanError"], 3)

    # Confidence is intentionally conservative. We auto-apply only when
    # several independent lyric/highlight anchors support the same offset.
    anchor_target = min(10, max(3, len(lyric_starts)))
    anchor_ratio = min(1.0, best["matches"] / anchor_target)
    error_factor = max(0.0, min(1.0, 1.0 - best["meanError"] / 1.15))
    confidence = 0.72 * anchor_ratio + 0.28 * error_factor

    best["confidence"] = round(confidence, 3)
    best["applied"] = (
        best["matches"] >= 3
        and confidence >= 0.52
        and min_offset <= best["offset"] <= max_offset
    )

    return best


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--lyrics", required=True)
    parser.add_argument("--sample-fps", type=float, default=4.0)
    parser.add_argument("--max-seconds", type=float, default=180.0)
    args = parser.parse_args()

    lyrics = json.loads(Path(args.lyrics).read_text(encoding="utf-8"))

    times, scores = sample_video(
        args.video,
        max(1.0, min(8.0, args.sample_fps)),
        max(30.0, args.max_seconds),
    )

    events, strengths, detector = detect_events(
        times,
        scores,
        max(1.0, args.sample_fps),
    )

    estimate = estimate_offset(lyrics, events)

    if not estimate:
        payload = {
            "applied": False,
            "offset": 0,
            "confidence": 0,
            "matchedAnchors": 0,
            "detectedEvents": len(events),
            "reason": "No stable repeated karaoke-highlight timing pattern was found.",
            "detector": detector,
        }
    else:
        payload = {
            "applied": bool(estimate["applied"]),
            "offset": float(estimate["offset"]) if estimate["applied"] else 0,
            "suggestedOffset": float(estimate["offset"]),
            "confidence": float(estimate["confidence"]),
            "matchedAnchors": int(estimate["matches"]),
            "meanAnchorError": float(estimate["meanError"]),
            "detectedEvents": len(events),
            "reason": (
                "Multiple video highlight anchors matched the LRCLIB line-start pattern."
                if estimate["applied"]
                else "A possible offset was found, but confidence was too low to apply automatically."
            ),
            "detector": detector,
        }

    print(json.dumps(payload, separators=(",", ":")))


if __name__ == "__main__":
    main()
