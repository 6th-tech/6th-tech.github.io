# Audio Quality Implementation Guide

Technical documentation of the audio processing pipeline in `scripts/audio-core.js`, covering the architecture, signal flow, and design decisions made to achieve artifact-free output with consistent perceived loudness.

---

## Architecture Overview

Sessions combine up to four audio layers:
1. **Isochronic tones** — carrier oscillator gated by a sine LFO
2. **Binaural beats** — stereo pair of slightly detuned oscillators (optional)
3. **Background** — either built-in noise (white/pink/brown) or custom music file
4. **Master envelope** — fade in/out applied to all layers

Tone.js v15.1.22 renders layers 1, 2, and (for noise sessions) 3 via `Tone.Offline`. Custom music is mixed in **after** Tone.js rendering using direct sample-by-sample math — this was a critical design decision (see [Why Not Tone.js Player](#why-not-tonejs-player)).

## Signal Flow

### Custom Music Sessions

```
Source file
  │
  ├─ RMS normalization (target = customNoiseVolume or 0.5)
  │    └─ Scale factor capped at 4x to prevent extreme amplification
  │
  ├─ Isochronic volume boost (up to 30% for loud backgrounds)
  │    └─ Gradual ramp based on active RMS (0.10–0.20)
  │
  ├─ True peak limiter (ceiling = 0.85, look-ahead = 10ms)
  │    └─ Only activates if scaled peak > 0.85
  │
  ├─ Safety ceiling (peak ≤ 0.95)
  │    └─ Simple linear scaling if peak still exceeds 0.95
  │
  ├─ Loop boundary fades (3s fade in at start, 3s fade out at end)
  │    └─ Baked into the buffer for click-free looping
  │
  ├─ Tone.js Offline renders isochronic + binaural (NO music)
  │
  ├─ Direct math mixing: music samples added to Tone.js output
  │    └─ Master fade envelope applied per-sample
  │    └─ Linear interpolation for sample rate conversion
  │
  └─ Post-render normalization (scale to 0.95 if peak > 1.0)
```

### Noise Sessions

```
Tone.js Offline renders everything:
  ├─ Isochronic tones (carrier + LFO gate)
  ├─ Binaural beats (optional stereo pair)
  ├─ Built-in noise (white/pink/brown at 0.5 volume)
  │    └─ Optional AutoFilter modulation (8-minute cycle)
  └─ Master fade envelope
       └─ Post-render normalization (if needed)
```

## Signal Levels

| Component | Level | Notes |
|-----------|-------|-------|
| Isochronic tones | 0.35–0.455 | LFO max; boosted up to 30% for loud backgrounds |
| Binaural beats | 0.12 | Per-channel, stereo panned L/R |
| Background noise | 0.70 | `defaultNoiseVolume` — higher than music to match perceived loudness |
| Custom music | 0.50 | Target RMS after normalization |
| Master gain | 0.70 | `mainVolume`, capped at 0.89 headroom |
| Fade in/out | 10s each | Linear ramp on master gain |
| Final buffer | 3s | Silence at end after fade-out |

## Key Processing Steps

### 1. RMS Normalization

Scales custom music so that all sources reach the same target perceived loudness (RMS = 0.5 by default), rather than matching peaks. This ensures a quiet track with low peaks and a loud track with high peaks both sound equally loud in the final mix.

**Scale cap**: Limited to 4x maximum. Some nature sound files (birds, ocean, chimes) have very low global RMS due to silences between sounds. Without the cap, these would be amplified 10-20x, causing massive peak overshoot and artifacts.

```
rmsScale = targetVolume / musicRms
scale = min(rmsScale, 4)
```

### 1b. Carrier Frequency Compensation

Human hearing is less sensitive to lower frequencies (Fletcher-Munson equal-loudness contours). A 174 Hz carrier sounds noticeably quieter than a 528 Hz carrier at the same amplitude. To compensate, isochronic volume is boosted for carriers below 400 Hz:

```
freqBoost = 1 + 0.30 * (1 - carrierFreq / 400)
```

| Carrier | Boost |
|---|---|
| 174 Hz | +17% |
| 285 Hz | +9% |
| 396 Hz | +0.3% |
| 417+ Hz | None |

This applies to all sessions (noise and custom music), before the active-RMS-based boost.

### 1c. Isochronic Volume Boost for Loud Backgrounds

For custom music sessions, if the source file's active RMS exceeds 0.15, the isochronic tone volume is gradually increased so the tones don't get buried under loud background audio. The boost ramps linearly:

- **No boost** when active RMS ≤ 0.10 (quiet or sparse sources)
- **Gradual ramp** from 0% to 30% as active RMS goes from 0.10 to 0.20
- **Full 30% boost** (0.35 → 0.455) when active RMS ≥ 0.20

```
boostFactor = 1 + 0.30 * min((activeRms - 0.10) / 0.10, 1)
isochronicVolume *= boostFactor
```

This maintains the research-recommended ratio between isochronic tones and background (-14 to -16 dB) regardless of source loudness. The gradual ramp avoids any hard threshold discontinuity. No artifact risk — it's simply a higher gain on a clean sine oscillator, and the post-render normalization handles any combined peaks.

### 2. True Peak Limiter

A 4-pass limiter that reduces only the peaks exceeding the ceiling while leaving the rest of the signal untouched:

1. **Instantaneous gain**: For each sample, compute `ceiling / |sample|` if above ceiling, else 1.0
2. **Sliding window minimum** (look-ahead): Find the minimum gain in a 10ms forward window using a monotonic deque — O(n) complexity
3. **Attack/release smoothing**: Prevents gain from changing too abruptly
   - Attack: 2ms (exponential) — smooths the downward gain transition
   - Release: 50ms (exponential) — smooths the return to unity gain
4. **Apply**: Multiply all channels by the smoothed gain curve

**Why 10ms look-ahead**: Must be longer than the attack time (2ms). The look-ahead lets the limiter start reducing gain *before* the peak arrives, so the actual peak sample sees the full attenuation. Without sufficient look-ahead, gain drops happen at the peak itself, causing a click.

**Ceiling = 0.85**: Leaves headroom for the Tone.js layers that get added on top.

### 3. Safety Ceiling

A simple linear scaling fallback: if peak still exceeds 0.95 after limiting (shouldn't happen normally), scale the entire buffer down. This is a safety net, not the primary gain control.

### 4. Loop Boundary Fades

3-second linear fade baked into the music buffer edges (start and end). When the music loops during long sessions, this prevents clicks at the loop seam.

### 5. Direct Math Music Mixing

After Tone.js renders the isochronic/binaural layers, custom music is mixed in by iterating over every output sample and adding the corresponding music sample, with:
- **Master fade envelope** replicated per-sample (same shape as Tone.js master gain)
- **Linear interpolation** for sample rate conversion between music and output buffers
- **Modulo wrapping** for seamless looping of music shorter than the session

### 6. Post-Render Normalization

Final safety check: if the combined output exceeds 1.0 peak, scale everything down to 0.95 peak. Logs when this happens for diagnostics.

## Diagnostics Logging

Every session logs a detailed processing chain to the console:

```
--- Session config ---
  Background: custom music
  Carrier: 200Hz | Isochronic: 0.35
  Binaural: on (0.12) | Main volume: 0.7
  Duration: 30.0min
  Music buffer: RMS=0.1234, peak=0.5678, scale=4.0000, scaledPeak=2.2712
  RMS scale 4.05x capped to 4x (very dynamic source)
  Active RMS=0.1890 (42.3% active), silence gap ratio: 57.7%
  Applying limiter (scaled peak 2.2712 exceeds 0.85)
  Safety ceiling: scaling by 0.9500 (peak was 1.0000)
  After processing: RMS=0.4500, peak=0.8500
  Music mixed directly (bypassed Tone.js Player)
  Peak details: value=0.9200 at 145.32s (sample 6401088, ch0)
  Output peak 0.9200, no scaling needed
```

**Active RMS** measures only samples above a silence threshold (0.01), showing what percentage of the file contains audible content. This helps identify sparse sources (nature sounds with silences) vs. continuous sources (ambient music).

## Problems Encountered and Solutions

### Problem: Inconsistent loudness across sessions

**Cause**: Peak-based scaling gives the same peak level to all files, but a file with one loud spike and quiet average sounds much quieter than a file with consistently moderate levels.

**Solution**: RMS normalization targets consistent *perceived* loudness. The 4x scale cap prevents extreme amplification of sparse nature sounds.

### Problem: Clicks from hard peak clamping

**Cause**: Clamping samples above ±0.9 to ±0.9 creates flat-topped waveforms — effectively square-wave distortion that produces audible clicks and buzzing.

**Solution**: Replaced with true peak limiter that smoothly reduces gain around peaks.

### Problem: Buzzing from tanh soft limiter

**Cause**: A `tanh()` waveshaper was tried as a gentler alternative to hard clamping. But tanh introduces harmonic distortion (it's a nonlinear transfer function), which produces audible buzzing especially on high-pitched or musical content.

**Solution**: Replaced with envelope-based approach (gain modulation, not waveform reshaping).

### Problem: Crackling from envelope compressor

**Cause**: A compressor with threshold=0.5 and 5.5x makeup gain was constantly active, modulating gain with a 1ms attack time. The continuous rapid gain changes created audible artifacts.

**Solution**: Replaced with true peak limiter that only acts on actual peaks and uses much gentler time constants.

### Problem: Clicks from limiter without attack smoothing

**Cause**: The sliding window minimum (look-ahead) creates a step function — gain drops from 1.0 to the target value at exactly `lookAhead` samples before the peak. Without smoothing, this is a discontinuity that clicks.

**Solution**: Added exponential attack smoothing (2ms time constant) so gain transitions are gradual, and increased look-ahead from 5ms to 10ms to give more room for the smooth transition.

### Problem: Crackling from Tone.js Player

**Cause**: Even after all limiter improvements, custom music sessions still crackled. Investigation revealed Tone.js Player/Buffer introduces unpredictable behavior — output peaks were sometimes 2x the theoretical maximum with no clear cause.

**Solution**: Bypassed Tone.js Player entirely. Music is mixed into the output buffer with direct sample math after Tone.js renders only the isochronic/binaural layers. This eliminated all remaining artifacts.

## Constants Reference

| Constant | Value | Purpose |
|----------|-------|---------|
| `fadeIn` | 10s | Session fade-in duration |
| `fadeOut` | 10s | Session fade-out duration |
| `noiseFade` | 3s | Loop boundary fade duration |
| `finalBuffer` | 3s | Silence appended after fade-out |
| `defaultBackgroundVolume` | 0.5 | RMS target for custom music normalization |
| `defaultNoiseVolume` | 0.7 | Gain for built-in noise (higher to match music loudness) |
| `maxScale` | 4 | Maximum RMS normalization multiplier |
| Limiter ceiling | 0.85 | Maximum peak after limiting |
| Safety ceiling | 0.95 | Absolute maximum before Tone.js mix |
| Headroom cap | 0.89 | Master gain never exceeds this |
| Attack time | 2ms | Limiter gain reduction smoothing |
| Release time | 50ms | Limiter gain recovery smoothing |
| Look-ahead | 10ms | Limiter anticipation window |
| Silence threshold | 0.01 | Active RMS measurement cutoff |

## Volume Level Research

Based on a Perplexity deep research query, referencing a peer-reviewed study (PMC8475787 — "Psychophysiological effects of music augmented with isochronic auditory beats"):

**Core finding**: Isochronic tones should be positioned approximately **-14 to -16 dB below the peak level of background sounds** for effective entrainment without listener fatigue.

### Frequency-Band-Specific Recommendations

| Target Band | Frequency Range | Recommended Level (vs background) | Rationale |
|---|---|---|---|
| Delta (sleep) | 0.5–4 Hz | -16 dB | Background masking desirable for sleep |
| Theta (meditation) | 4–8 Hz | -14 to -15 dB | Robust entrainment responses |
| Alpha (relaxed focus) | 8–12 Hz | -13 to -15 dB | Clear but non-dominant presence |
| Beta (concentration) | 13–30 Hz | -12 to -14 dB | Higher to combat attention splitting |

### Thresholds

- **Perceptual disappearance**: tones become ineffective below ~-18 to -20 dB relative to background
- **Habituation**: for 20–30 min sessions, some producers recommend the higher end (-12 to -13 dB)
- **Modulation depth**: isochronic tones produce ~50 dB modulation depth (100,000:1 ratio) vs binaural beats' ~3 dB (2:1), so they remain perceptible even at modest absolute levels

### Applied Values

Isochronic volume was set to **0.35** (linear gain) with background at **0.5**. The sine LFO gating averages ~0.22 RMS for the isochronic content, placing it well below the background level, within the recommended -14 to -16 dB range.

Commit: `ed97c93 - Lower default isochronic tone volume to 0.35 based on research`

---

## Known Behaviors

- **Sparse nature sounds**: Files with large silent gaps (birds, ocean waves, wind chimes) may have very low global RMS but sound fine. The 4x scale cap prevents over-amplification. Active RMS logging helps identify these sources.
- **Sample rate conversion**: Music files at different sample rates than the output (typically 44100 Hz) are handled via linear interpolation during mixing. No resampling step needed.
- **Mono music → stereo output**: When binaural beats are enabled (stereo output) but the music file is mono, the mono channel is duplicated to both output channels.
