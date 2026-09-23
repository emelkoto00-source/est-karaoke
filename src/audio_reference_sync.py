#!/usr/bin/env python3
"""EST Karaoke original-reference -> karaoke timeline alignment.

This intentionally does not try to transcribe lyrics. The Node pipeline first
uses Demucs to turn the user's original studio reference into a no-vocals
accompaniment, then this script compares accompaniment structure against the
actual karaoke audio.

Output is a monotonic set of time anchors mapping:
    reference/original seconds -> karaoke seconds

LRCLIB timestamps can then be warped through those anchors.
"""

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np


def decode_audio(path: str, ffmpeg: str, sample_rate: int) -> np.ndarray:
    cmd = [
        ffmpeg, '-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', str(sample_rate),
        '-f', 'f32le', 'pipe:1'
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        err = proc.stderr.decode('utf-8', 'replace')[-4000:]
        raise RuntimeError(f'FFmpeg could not decode {Path(path).name}: {err}')
    audio = np.frombuffer(proc.stdout, dtype=np.float32)
    if audio.size < sample_rate * 5:
        raise RuntimeError('Audio is too short for reference-track synchronization.')
    # Remove DC and scale gently. Absolute loudness is not used for matching.
    audio = audio.astype(np.float32, copy=True)
    audio -= float(np.mean(audio))
    peak = float(np.max(np.abs(audio)))
    if peak > 1e-7:
        audio /= peak
    return audio


def chroma_features(audio: np.ndarray, sr: int, fps: float):
    hop = max(256, int(round(sr / fps)))
    frame = 4096
    if audio.size < frame:
        raise RuntimeError('Audio is too short to analyze.')

    n_frames = 1 + (audio.size - frame) // hop
    window = np.hanning(frame).astype(np.float32)
    freqs = np.fft.rfftfreq(frame, 1.0 / sr)
    useful = (freqs >= 70.0) & (freqs <= min(5000.0, sr / 2 - 1))
    useful_idx = np.where(useful)[0]
    useful_freqs = freqs[useful]

    midi = 69.0 + 12.0 * np.log2(np.maximum(useful_freqs, 1e-6) / 440.0)
    pitch_classes = np.mod(np.rint(midi).astype(np.int32), 12)

    chroma = np.zeros((12, n_frames), dtype=np.float32)
    energy = np.zeros(n_frames, dtype=np.float32)

    for i in range(n_frames):
        start = i * hop
        x = audio[start:start + frame]
        energy[i] = float(np.sqrt(np.mean(x * x) + 1e-12))
        spec = np.abs(np.fft.rfft(x * window)).astype(np.float32)
        # Compress mix/mastering differences. The comparison cares more about
        # pitch-class structure than exact amplitude.
        vals = np.log1p(spec[useful_idx] * 35.0)
        for pc in range(12):
            mask = pitch_classes == pc
            if np.any(mask):
                chroma[pc, i] = float(np.sum(vals[mask]))

    # Center each frame so unrelated dense spectra do not all look similar,
    # then unit-normalize to make the metric robust to loudness/mastering.
    chroma -= np.mean(chroma, axis=0, keepdims=True)
    norms = np.linalg.norm(chroma, axis=0, keepdims=True)
    chroma = np.divide(chroma, np.maximum(norms, 1e-7), out=np.zeros_like(chroma), where=norms > 1e-7)

    log_e = np.log10(np.maximum(energy, 1e-8))
    lo = float(np.percentile(log_e, 15))
    hi = float(np.percentile(log_e, 90))
    active = np.clip((log_e - lo) / max(hi - lo, 1e-4), 0.0, 1.0).astype(np.float32)

    return chroma, active, hop / sr


def overlap_slices(n_ref: int, n_kar: int, lag: int):
    # lag > 0 means the same musical moment occurs later in karaoke.
    r0 = max(0, -lag)
    k0 = max(0, lag)
    n = min(n_ref - r0, n_kar - k0)
    if n <= 0:
        return None
    return slice(r0, r0 + n), slice(k0, k0 + n), n


def similarity_score(ref, kar, ref_active, kar_active, lag, min_frames, stride=1):
    ov = overlap_slices(ref.shape[1], kar.shape[1], lag)
    if not ov or ov[2] < min_frames:
        return -1.0, 0
    rs, ks, n = ov
    a = ref[:, rs][:, ::stride]
    b = kar[:, ks][:, ::stride]
    sim = np.sum(a * b, axis=0)
    weights = np.minimum(ref_active[rs][::stride], kar_active[ks][::stride])
    # Keep quieter sections from overpowering the structural match while still
    # allowing intro/break material to contribute.
    weights = 0.25 + 0.75 * weights
    score = float(np.sum(sim * weights) / max(np.sum(weights), 1e-6))
    return score, n


def find_global_alignment(ref, kar, ref_active, kar_active, fps, max_offset_seconds):
    max_lag = int(round(max_offset_seconds * fps))
    min_overlap = int(round(min(45.0, max(18.0, min(ref.shape[1], kar.shape[1]) / fps * 0.30)) * fps))

    best = None
    all_candidates = []

    # Karaoke versions are sometimes transposed. Chroma permits testing all
    # pitch-class rotations without changing playback speed.
    for pitch_shift in range(-6, 6):
        # If karaoke is +N semitones relative to reference, rolling it by -N
        # places it back into reference pitch classes.
        aligned_kar = np.roll(kar, -pitch_shift, axis=0)
        for lag in range(-max_lag, max_lag + 1):
            score, overlap = similarity_score(
                ref, aligned_kar, ref_active, kar_active, lag, min_overlap, stride=2
            )
            if score <= -0.99:
                continue
            item = (score, lag, pitch_shift, overlap)
            all_candidates.append(item)
            if best is None or score > best[0]:
                best = item

    if best is None:
        raise RuntimeError('No usable overlap was found between the two tracks.')

    best_score, best_lag, pitch_shift, overlap = best
    # Find a genuinely different alternative, not merely the neighboring frame
    # of the same peak. This makes confidence sensitive to ambiguous repeats.
    exclude = max(2, int(round(3.0 * fps)))
    alternatives = [
        c[0] for c in all_candidates
        if not (c[2] == pitch_shift and abs(c[1] - best_lag) <= exclude)
    ]
    second = max(alternatives) if alternatives else -1.0
    margin = best_score - second
    overlap_ratio = overlap / max(1, min(ref.shape[1], kar.shape[1]))

    return {
        'score': float(best_score),
        'lag_frames': int(best_lag),
        'offset_seconds': float(best_lag / fps),
        'pitch_shift': int(pitch_shift),
        'margin': float(margin),
        'overlap_ratio': float(overlap_ratio),
    }


def local_anchors(ref, kar, ref_active, kar_active, fps, global_info):
    pitch_shift = global_info['pitch_shift']
    kar = np.roll(kar, -pitch_shift, axis=0)
    global_lag = int(global_info['lag_frames'])

    window_s = 10.0
    step_s = 12.0
    search_s = 7.0
    half = max(6, int(round(window_s * fps / 2)))
    step = max(1, int(round(step_s * fps)))
    search = max(2, int(round(search_s * fps)))

    anchors = []
    previous_lag = global_lag
    n_ref = ref.shape[1]
    n_kar = kar.shape[1]

    for center in range(half, n_ref - half, step):
        best = None
        local_scores = []
        predicted = previous_lag if anchors else global_lag

        for lag in range(predicted - search, predicted + search + 1):
            k_center = center + lag
            if k_center - half < 0 or k_center + half >= n_kar:
                continue

            rs = slice(center - half, center + half + 1)
            ks = slice(k_center - half, k_center + half + 1)
            sim = np.sum(ref[:, rs] * kar[:, ks], axis=0)
            weights = 0.25 + 0.75 * np.minimum(ref_active[rs], kar_active[ks])
            score = float(np.sum(sim * weights) / max(np.sum(weights), 1e-6))
            local_scores.append((score, lag))
            if best is None or score > best[0]:
                best = (score, lag)

        if not best:
            continue

        score, lag = best
        different = [s for s, l in local_scores if abs(l - lag) > max(1, int(fps))]
        second = max(different) if different else -1.0
        margin = score - second

        # Centered-chroma cosine values are intentionally conservative. These
        # thresholds are chosen to reject weak/ambiguous windows rather than
        # aggressively force a match.
        if score >= 0.10 and margin >= 0.008:
            ref_t = center / fps
            kar_t = (center + lag) / fps
            if not anchors or kar_t > anchors[-1]['karaoke'] + 0.25:
                anchors.append({
                    'reference': float(ref_t),
                    'karaoke': float(kar_t),
                    'score': float(score),
                    'margin': float(margin),
                    'lag': float(lag / fps),
                })
                previous_lag = lag

    if len(anchors) < 2:
        return anchors

    # Smooth only isolated lag spikes. Preserve gradual drift and legitimate
    # section-size changes instead of flattening everything to one offset.
    lags = np.array([a['lag'] for a in anchors], dtype=np.float64)
    smoothed = lags.copy()
    for i in range(1, len(lags) - 1):
        neighborhood = np.array([lags[i - 1], lags[i], lags[i + 1]])
        med = float(np.median(neighborhood))
        if abs(lags[i] - med) > 2.5:
            smoothed[i] = med
    for a, lag in zip(anchors, smoothed):
        a['lag'] = float(lag)
        a['karaoke'] = float(a['reference'] + lag)

    # Enforce monotonic target time after smoothing.
    clean = []
    for a in anchors:
        if a['karaoke'] < 0:
            continue
        if clean and a['karaoke'] <= clean[-1]['karaoke'] + 0.10:
            continue
        clean.append(a)
    return clean


def evaluate(global_info, anchors, ref_duration, kar_duration):
    if anchors:
        scores = np.array([a['score'] for a in anchors], dtype=np.float64)
        margins = np.array([a['margin'] for a in anchors], dtype=np.float64)
        lags = np.array([a['lag'] for a in anchors], dtype=np.float64)
        coverage = (anchors[-1]['reference'] - anchors[0]['reference']) / max(ref_duration, 1.0) if len(anchors) > 1 else 0.0
        median_score = float(np.median(scores))
        median_margin = float(np.median(margins))
        lag_spread = float(np.median(np.abs(lags - np.median(lags))))
        if len(anchors) >= 2:
            x = np.array([a['reference'] for a in anchors], dtype=np.float64)
            y = np.array([a['karaoke'] for a in anchors], dtype=np.float64)
            slope = float(np.polyfit(x, y, 1)[0])
        else:
            slope = 1.0
    else:
        coverage = median_score = median_margin = lag_spread = 0.0
        slope = 1.0

    # Confidence intentionally favors "do nothing" if evidence is weak. Video
    # sync/manual offset remain available as safe fallbacks.
    score_component = np.clip((global_info['score'] - 0.08) / 0.20, 0.0, 1.0)
    local_component = np.clip((median_score - 0.08) / 0.18, 0.0, 1.0)
    anchor_component = np.clip(len(anchors) / 10.0, 0.0, 1.0)
    coverage_component = np.clip(coverage / 0.65, 0.0, 1.0)
    margin_component = np.clip((global_info['margin'] + median_margin) / 0.06, 0.0, 1.0)
    confidence = float(
        0.30 * score_component +
        0.25 * local_component +
        0.20 * anchor_component +
        0.15 * coverage_component +
        0.10 * margin_component
    )

    duration_ratio = kar_duration / max(ref_duration, 1e-6)
    tempo_ok = 0.82 <= slope <= 1.18
    duration_ok = 0.65 <= duration_ratio <= 1.45
    applied = (
        global_info['score'] >= 0.10 and
        len(anchors) >= 5 and
        median_score >= 0.10 and
        coverage >= 0.35 and
        confidence >= 0.72 and
        global_info['margin'] >= 0.010 and
        median_margin >= 0.010 and
        tempo_ok and duration_ok
    )

    if applied:
        reason = (
            f'Original-track accompaniment match accepted: {len(anchors)} anchors, '
            f'{confidence*100:.0f}% confidence, global shift {global_info["offset_seconds"]:+.2f}s.'
        )
    else:
        reason = (
            f'Original-track comparison was not confident enough to auto-apply '
            f'({len(anchors)} anchors, {confidence*100:.0f}% confidence, '
            f'global similarity {global_info["score"]:.3f}). Existing video/manual sync remains available.'
        )

    return {
        'applied': bool(applied),
        'confidence': confidence,
        'anchor_count': int(len(anchors)),
        'coverage': float(coverage),
        'median_anchor_score': float(median_score),
        'median_anchor_margin': float(median_margin),
        'lag_mad_seconds': float(lag_spread),
        'tempo_ratio': float(slope),
        'duration_ratio': float(duration_ratio),
        'reason': reason,
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--reference', required=True, help='Original accompaniment/no_vocals audio')
    p.add_argument('--karaoke', required=True, help='Target karaoke audio')
    p.add_argument('--ffmpeg', default='ffmpeg')
    p.add_argument('--fps', type=float, default=4.0)
    p.add_argument('--max-offset', type=float, default=90.0)
    args = p.parse_args()

    sr = 11025
    fps = max(2.0, min(8.0, float(args.fps)))
    ref_audio = decode_audio(args.reference, args.ffmpeg, sr)
    kar_audio = decode_audio(args.karaoke, args.ffmpeg, sr)
    ref_duration = len(ref_audio) / sr
    kar_duration = len(kar_audio) / sr

    ref, ref_active, ref_step = chroma_features(ref_audio, sr, fps)
    kar, kar_active, kar_step = chroma_features(kar_audio, sr, fps)
    # hop rounding means the real feature rate can be microscopically different.
    actual_fps = 1.0 / ((ref_step + kar_step) / 2.0)

    global_info = find_global_alignment(
        ref, kar, ref_active, kar_active, actual_fps,
        max(5.0, min(180.0, float(args.max_offset))),
    )
    anchors = local_anchors(ref, kar, ref_active, kar_active, actual_fps, global_info)
    quality = evaluate(global_info, anchors, ref_duration, kar_duration)

    out = {
        'method': 'demucs-accompaniment-chroma-anchor-v1',
        'reference_duration': round(ref_duration, 6),
        'karaoke_duration': round(kar_duration, 6),
        'global_offset': round(global_info['offset_seconds'], 6),
        'global_similarity': round(global_info['score'], 6),
        'global_margin': round(global_info['margin'], 6),
        'pitch_shift_semitones': int(global_info['pitch_shift']),
        'anchors': [
            {
                'reference': round(a['reference'], 6),
                'karaoke': round(a['karaoke'], 6),
                'score': round(a['score'], 6),
            }
            for a in anchors
        ],
        **quality,
    }
    print(json.dumps(out, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
        sys.exit(1)
