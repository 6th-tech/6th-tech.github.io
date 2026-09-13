# Audio Quality Implementation Guide

Technical documentation of the audio processing pipeline in `scripts/audio-core.js`, covering the architecture, signal flow, and design decisions made to achieve artifact-free output with consistent perceived loudness.

---

## Architecture Overview

Sessions combine up to four audio layers:
1. **Isochronic tones** — carrier oscillator gated by a sine LFO
2. **Binaural beats** — stereo pair of slightly detuned oscillators (optional)
3. **Background** — either built-in noise (white/pink/brown) or custom music file
4. **Master envelope** — fade in/out applied to all layers

Tone.js v15.1.22 renders layers 1 and 2 via `Tone.Offline`. The background — custom music **or** built-in noise (rendered up front by a second, tones-free `Tone.Offline`) — goes through one shared chain (active-RMS normalisation → true-peak limiter → carrier-tracking dip) and is mixed in **after** the tone render using direct sample-by-sample math — this was a critical design decision (see [Why Not Tone.js Player](#why-not-tonejs-player)).

A **pre-flight analyzer** (`scripts/audio-analysis.js`, offline twin `scripts/analysis/analyze_bg.py`) measures how a background interacts with a session's carriers before rendering — see [Pre-flight Background Analysis](#1h-pre-flight-background-analysis).

## Signal Flow

### All Sessions (custom music or built-in noise)

```
Background source
  │  custom music: the decoded file
  │  noise: Tone.Offline renders white/pink/brown for the session length,
  │         optionally through a 200–1212 Hz lowpass sweep (16 s cycle, "noise modulation")
  │
  ├─ Isochronic volume boost (custom music only, up to 30% for loudly mastered sources)
  │    └─ Gradual ramp based on the source's active RMS (0.10–0.20)
  │
  ├─ Loop boundary fades (3s fade in at start, 3s fade out at end), unity gain
  │    └─ Baked into the buffer for click-free looping
  │
  ├─ Tone.js Offline renders isochronic + binaural (NO background)
  │
  ├─ Session-length background track (loop + linear-interpolation resampling), unity gain
  │
  ├─ Carrier-tracking dip (−12 dB, one ERB wide, follows the carrier ramps)
  │    └─ Web Audio peaking BiquadFilter with frequency/Q automation; second dip on
  │       the separated binaural base carrier when carrier separation is on
  │
  ├─ Level: active-RMS normalization of the DIPPED track (target = customNoiseVolume, 0.25)
  │    └─ The target is the level the listener hears — after the dip — so every session
  │       lands at the same background loudness whatever the file's mastering or how
  │       much of its energy sat in the carrier band. Scale capped at 40x (guard only).
  │       Musical tracks: additionally capped so the loudest 0.1% of samples exceed the
  │       ceiling by ≤ 6 dB (limiting stays on transients; the console reports the shortfall)
  │
  ├─ Transients, by background character (spectral flatness over 300–8000 Hz ≥ 0.15 = noise-like)
  │    ├─ noise-like (rain, surf, fire, wind, built-in noise): soft clipper (knee 0.6 → 0.85)
  │    │    └─ Touches only samples above the knee; a limiter would turn every raindrop
  │    │       into a 60 ms hole in the gain (AM at 5–20 Hz)
  │    └─ musical: true-peak limiter, 10 ms look-ahead, program-dependent release
  │         └─ Clipping the attack of a plucked or struck note is audible as a click;
  │            short overs release in 15 ms, sustained ones in 80 ms
  │    A second level pass corrects for the energy either treatment removed (within 0.3 dB)
  │
  ├─ Safety limiter (idle by construction; logs if it ever engages)
  │
  ├─ Direct math mixing: background samples added to the tone render
  │    └─ Master fade envelope applied per-sample
  │
  └─ Post-render normalization (scale to 0.95 if peak > 1.0)
```

## Signal Levels

| Component | Level | Notes |
|-----------|-------|-------|
| Isochronic tones | 0.35 base | ×1.0–1.3 carrier-tracked equal-loudness; up to +30% for loudly mastered music; optional pulse-punch shaping |
| Binaural beats | 0.16 base | Per-channel, stereo panned L/R; ×1.0–1.3 carrier-tracked; ×1.4 during SI-DO emphasis; optional carrier separation |
| Background (music or noise) | 0.25 | Target *active* RMS as heard (after the dip and transient treatment) — same chain for both; ≈ 6 dB above the isochronic tone (0.35 × punch-2 envelope ≈ 0.13 RMS) |
| Carrier dip | −12 dB | One ERB wide, centred on the carrier, tracks the carrier ramps (`carrierDipDb`, 0 = off) |
| Master gain | 0.70 | `mainVolume`, capped at 0.89 headroom |
| Fade in/out | 10s each | Linear ramp on master gain |
| Final buffer | 3s | Silence at end after fade-out |

## Key Processing Steps

### 1. Level: Active-RMS Normalization of the Dipped Track

The background's level is set **after** the carrier dip, on the session-length track, so the target (`customNoiseVolume`, default **0.25**) is the active RMS the listener actually hears. The reference is the **active RMS** — the RMS of samples above the 0.01 silence threshold — not the global RMS, so sparse or quietly mastered recordings (rain, streams, birds at RMS ≈ 0.01) reach the same level as dense ones. Two things made the earlier arrangement (normalize the source to 0.5, limit, then dip) inconsistent: a true-peak limiter working on nearly every sample took 3–8 dB off high-crest material, and the dip removed a further chunk from tracks whose energy sits in the carrier band, so the final level varied by several dB between sessions with the same nominal setting.

**Transients** depend on what the background is, decided by its spectral flatness (median Wiener entropy over 300–8000 Hz, so a recording's low rumble cannot hide a broadband crackle; rain 0.49, fire 0.31, surf 0.17–0.21, rock 0.13, birdsong 0.05–0.09, other music 0.000–0.04; threshold 0.15):

- *Noise-like*: a soft clipper (identity below 0.6, tanh curve up to the 0.85 ceiling). Its transients are noise bursts, so rounding them is inaudible, and only the samples above the knee are touched — a gain-riding limiter turned every raindrop into a 60 ms hole in the gain, i.e. amplitude modulation at 5–20 Hz, the last thing an entrainment session needs.
- *Musical*: the true-peak limiter (10 ms look-ahead, 1.5 ms attack) with a program-dependent release — 15 ms after a short over-run such as a plucked note or a drum hit, 80 ms after a sustained one; overs closer than 25 ms count as one run so the cycles of a bass note never get a per-cycle ripple. Clipping the attack of a note is audible as a click, which is why music is not clipped.

Because both treatments remove a little energy, a second pass corrects the scale (converges within 0.3 dB; the passes and the treated percentage are logged). For musical tracks the scale is additionally capped so that the 99.9th percentile of |x| exceeds the ceiling by at most 6 dB: the limiter must stay a transient tool, never the loudness maker. Only very spiky recordings hit the cap (a sparse birdsong file sits about 3.5 dB below target); the console reports the shortfall. The old limiter call after the level stage is a safety net and idle by construction.

**Scale cap**: 40x, a guard against pathological files only.

```
scale = min(targetVolume / activeRms(dippedTrack), 40[, 0.85·2 / p99.9(|dippedTrack|) for music])
track = noiseLike ? softClip(dippedTrack * scale) : limit(dippedTrack * scale)   // then one corrective pass
```

The console reports the character decision, the final background RMS, its active RMS and the isochronic tone's RMS relative to it (≈ −6 dB at the defaults). Built-in noise goes through exactly the same chain (it is rendered up front by a tones-free `Tone.Offline`), so noise sessions and music sessions share one loudness rule. Previously the noise sat inside the tone render at a fixed 0.7 gain and, because of the AutoFilter misconfiguration described in 1i, ended up at 0.065–0.10 RMS — quieter than the tone.

### 1b. Carrier Frequency Compensation

Human hearing is less sensitive to lower frequencies (Fletcher-Munson equal-loudness contours). A 174 Hz carrier sounds noticeably quieter than a 528 Hz carrier at the same amplitude. To compensate, the isochronic and binaural levels are boosted for carriers below 400 Hz — **dynamically**: each tone layer runs through a dedicated level gain that ramps alongside the carrier frequency ramps. A session starting at 852 Hz gets no boost at entry, then gains it progressively as its carrier descends through 285 to 174 Hz. (Previously the boost keyed off the session's *starting* carrier, which meant octave-aligned sessions — whose carriers all start ≥ 528 Hz — never received any compensation.)

```
freqBoost = 1 + 0.30 * (1 - carrierFreq / 400)
```

| Carrier | Boost |
|---|---|
| 174 Hz | +17% |
| 285 Hz | +9% |
| 396 Hz | +0.3% |
| 417+ Hz | None |

This applies to all sessions (noise and custom music). The binaural layer receives the same boost — its carriers (C ± f/2) sit in the same low-frequency region and would otherwise fall below the masked threshold of the low-frequency-heavy background (brown noise) in deep sessions. The active-RMS-based boost (1c) applies to isochronic only.

### 1d. SI-DO Binaural Emphasis

At each octave band crossing, the binaural layer is temporarily boosted to carry the entrainment across the interval where listeners tend to snap back to alertness (the "reconciling force" of the octave framework's Law of Three).

**Detection is fully dynamic** — computed from whatever sequence arrives, with no per-session data:

- Step *i* is a shock lift: its frequency is **above** the previous step's
- Step *i+1* has `rampType=1` (exponential) and a **lower** frequency landing on an octave DO boundary (16 / 8 / 4 / 2 Hz)

Dual-band secondary-band returns never trigger (they use linear ramps), and ascending gamma sequences never trigger (the post-lift step must descend).

**Envelope** (all timing derived from the steps' own durations, so it scales automatically for short sequences):

- **Rise** across the lift step (`ramp + hold`): binaural gain ramps 1.0 → 1.4×
- **Peak** through the exponential ramp
- **Decay** back to 1.0 over `min(half the DO step's hold, 20s)`

The factor is capped so emphasized binaural never exceeds 0.65× the isochronic level (~4 dB below its peak) — the layer hierarchy cannot invert. Since both layers share the same carrier-tracked equal-loudness boost, this ratio holds at every carrier. Crossings that would overlap the session fade-in/fade-out are skipped.

### 1c. Isochronic Volume Boost for Loud Backgrounds

For custom music sessions, if the *source file's* active RMS exceeds 0.10, the isochronic tone volume is gradually increased so the tones don't get buried under loud background audio. (Since the carrier dip now guarantees the tone's band is clear, this boost is a secondary safeguard; it is keyed to the source's mastering level, not to the post-normalization level.) The boost ramps linearly:

- **No boost** when active RMS ≤ 0.10 (quiet or sparse sources)
- **Gradual ramp** from 0% to 30% as active RMS goes from 0.10 to 0.20
- **Full 30% boost** (0.35 → 0.455) when active RMS ≥ 0.20

```
boostFactor = 1 + 0.30 * min((activeRms - 0.10) / 0.10, 1)
isochronicVolume *= boostFactor
```

This maintains the research-recommended ratio between isochronic tones and background (-14 to -16 dB) regardless of source loudness. The gradual ramp avoids any hard threshold discontinuity. No artifact risk — it's simply a higher gain on a clean sine oscillator, and the post-render normalization handles any combined peaks.

### 1e. Isochronic Pulse Punch (optional)

The isochronic pulse is generated by a sine LFO gating the carrier amplitude 0→1 (full modulation depth). The `isochronicPunch` option raises that 0→1 envelope to a power via a `WaveShaper`, sharpening the pulse:

- **1** (default): the original soft sine throb — the shaper is bypassed entirely, output is bit-identical to before.
- **>1**: each pulse narrows and a silence gap opens between pulses, for a tighter, more percussive feel. The generator UI (`generate.html`, `generate_bulk.html`) exposes 1 / 1.5 / 2 / 3 and preselects 2, the setting the shipped default sessions were rendered with (measured from their ±2f sidebands); the `isochronicPunch` option itself still defaults to 1 for callers that omit it.

The shaping stays continuous (C¹), so it adds no clicks or spectral splatter. Note that raising the exponent lowers the *average* level of the tone (the peak stays at 1, but there's less sustained energy per cycle), so a punchier pulse also sounds slightly quieter.

### 1f. Binaural Carrier Separation (optional)

By default the binaural pair shares the isochronic carrier: left = C − f/2, right = C + f/2. Because the mono isochronic carrier C is present in *both* ears, each ear then contains two tones f/2 apart (C and C∓f/2), which produce a **monaural beat at f/2** — half the target frequency. The standing spectral line at C (≈ isochronic level × envelope mean, e.g. 0.175 at punch 1) is close to the binaural carrier level (0.16), so this f/2 beat is deep (~90%).

The `binauralCarrierOffset` option (Hz, default 0) moves the binaural pair onto its **own base carrier** `Cb = C + offset`, so the pair becomes `Cb ∓ f/2`:

- **0** (default): coupled routing — unchanged, bit-identical output.
- **>0** (e.g. 150–250): the within-ear difference between the isochronic carrier C and the binaural carrier Cb is now the offset (well out of the entrainment range and beyond a critical band), so the f/2 monaural beat disappears. The binaural difference Δf = f is unchanged, the pair stays **continuous** (unlike enveloping both carriers, which would break the binaural percept), and it remains independently controllable — so the SI-DO emphasis still applies. The offset tracks the carrier descent, so separation never collapses and the carriers never cross.

Numerically verified: the f/2 component in the within-ear envelope drops from 0.064 (coupled) to 0 (separated), while the isochronic pulse at f is preserved. The dropdown in both generator UIs exposes Off / 150 / 250 Hz and defaults to +150 Hz, the setting the shipped default sessions were rendered with (the `binauralCarrierOffset` option itself still defaults to 0 for callers that omit it). No effect without headphones (binaural requires channel separation).

### 1g. Carrier-Tracking Dip

Why it exists: an audit of the 31 music-backed default sessions (2026-09) showed that RMS normalization cannot see *where* a background's energy sits. Pads, piano and vocals put most of theirs at 150–950 Hz — exactly the carrier range — while rain and waves put theirs elsewhere, so at equal RMS the former masked the isochronic tone inside its own auditory band for up to 64% of a session and sustained notes within ±40 Hz of the carrier produced spurious monaural beats. Boosting the tone cannot fix this without making it dominate the mix; carving the background out of the tone's band can.

The dip is a Web Audio `BiquadFilterNode` of type `peaking` with gain `-carrierDipDb` (default **12 dB**) and `Q = C / ERB(C)`, i.e. one equivalent-rectangular-bandwidth wide (43 Hz at 174 Hz, 82 Hz at 528 Hz, 117 Hz at 852 Hz). Its `frequency` and `Q` AudioParams are automated with the same linear/exponential ramps and the same step times the isochronic carrier follows, so the notch glides with the carrier through the session. It is applied to the session-length background track (after looping/resampling, before the master fade), for music and noise alike. With binaural carrier separation on, a second dip follows the binaural base carrier (`C + offset`).

Measured effect on the audited sessions (normalization fix + 12 dB dip): isochronic masking real problems fell from 15 sessions to 10 — the remaining ten were replaced with nature recordings — and binaural masking problems fell from 8 to 0. A 1-ERB cut at −12 dB is subtle in ambient material; set `carrierDipDb` to 0 to reproduce the previous mix.

### 1h. Pre-flight Background Analysis

`scripts/audio-analysis.js` exposes `AudioAnalysis.analyzeBackground(buffer, sequence, options)`. It mirrors the generator's gain staging (active-RMS normalization, isochronic boost, equal-loudness, the dip) and then measures, inside one ERB around every carrier the sequence uses:

| Metric | What it catches | Real problem when |
|---|---|---|
| masking % | background louder than the tone in its own band | ≥ 20% of session time (mild ≥ 5%) |
| spurious beats % | sustained spectral line within ±40 Hz of the carrier at tone level | ≥ 10% of frames (mild ≥ 3%) |
| rhythm | in-band amplitude modulation at the session's own beat frequencies (≥ 15% depth, background within 20 dB of the tone) | any |
| tempo | broadband modulation peak 0.5–8 Hz ≥ 30% depth | mild |
| level | mix RMS after normalization | mild when < 0.15 |
| binaural | same masking test against the binaural level, in its own (possibly separated) band | masked ≥ 40% (mild ≥ 15%) |
| stereo | L/R correlation in the carrier band below 0.3 | note only, does not change the verdict |
| source quality | gain the file needs to reach the target, its noise floor (5th-percentile 100 ms RMS) relative to its music, and its bandwidth (highest bin within 60 dB of the spectral peak) | mild when all three are bad at once: > 18 dB of gain, bandwidth < 5 kHz and floor less than 12 dB down; a quiet master alone is a note |

Both generator pages run it automatically (checkbox "Pre-flight background analysis"): the single generator prints the verdict under the checkbox, the bulk generator prints it next to each generated file and logs per-carrier detail to the console. The offline Python twin (`scripts/analysis/analyze_bg.py`, `verify.py`) computes the same metrics with the same one-ERB band filter (two cascaded RBJ band-passes, roex-like skirts) for a folder of candidates against `default_sessions.json` — use it to vet new recordings before downloading a whole set.

A quiet, dull, noisy master is a trap the other metrics cannot see: brought up by 20 dB it looks fine on paper but its encoder artefacts, room noise and reverb tails come up with it (Cave of Solitude: +24 dB, 2.5 kHz, floor −4 dB — replaced). Each property alone is common in good files (surf needs 20 dB, soft pads roll off at 4 kHz, sparse recordings have a low floor), so only the combination is flagged.

Selection rules that follow from the metrics: no sustained pitch between 150 and 950 Hz (no drones, pads, bowls, chimes, flute, piano, vocals in that register); no tempo (drums, arpeggios, pulsing synths); broadband textures (rain, wind, stream, surf, fire) pass by construction; centred stereo for binaural sessions; mastered at a sane level (RMS > 0.05, mostly active) so normalization stays moderate.

### 1i. Noise Sessions: AutoFilter Sweep ("noise modulation")

The "modulated noise" option is a `Tone.AutoFilter` lowpass sweep: **200 Hz → 1212 Hz and back, one cycle every 16 s**, Q 1, −12 dB/oct (about 30 dB of level swing in the 1–4 kHz region, 15 dB around 300–600 Hz). Two Tone.js pitfalls made the original code produce this by accident rather than by design: `AutoFilter` reads only `frequency`, `baseFrequency`, `octaves` and `filter`, so the `min: 2000, max: 15000, Q: 0.5` it used to be given were ignored (it swept its defaults, 200 Hz and 2.6 octaves), and the rate `"8m"` means eight *measures* in Tone's notation — 16 s at the default 120 BPM — not eight minutes. A faithful 2–15 kHz sweep over 8 minutes was implemented and shipped briefly, and turned out to be inaudible as modulation: the sessions sounded like a constant bed of noise. Since the 16 s sweep across the low-mid range is the sound every shipped noise session has had, it is now set explicitly (`noiseSweepPeriod`, `noiseSweepLowHz`, `noiseSweepHighHz`) so it is deliberate and stable. Built-in noise always takes the noise-like transient path (soft clipper); the carrier dip keeps the tone's band clear wherever the sweep is.

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

## Sequence Validation

Every step after the first must include a ramp duration > 0. The scheduler applies a step's frequency only through its ramp automation (or an explicit carrier change), so a non-initial step without a ramp would silently keep playing the previous step's frequency for its entire duration. `validateSequenceSteps` enforces this rule:

- `generateAudio` throws on violation (backstop for any caller)
- The single generator (`generate.js`) alerts with the offending step numbers before rendering
- The bulk generator (`generate_bulk.js`) reports violations per configuration during pre-generation validation

The first step is exempt — its frequency is baked in when the oscillators are created. All 72 shipped default-session sequences satisfy the rule (verified 2026-07).

## Diagnostics Logging

Every session logs a detailed processing chain to the console:

```
--- Session config ---
  Background: custom music
  Starting carrier: 200Hz | Isochronic: 0.35 (carrier-tracked equal-loudness ×1.0–1.3, punch ^1)
  Binaural: on (0.16, carrier-tracked) | Main volume: 0.7
  SI-DO emphasis: 1 crossing(s) [187-230s] → binaural ×1.40
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
| `defaultBackgroundVolume` | 0.25 | Target active RMS of the background as heard, after dip and transient treatment (music and noise) |
| `softClipKnee` / `peakCeiling` | 0.6 / 0.85 | Soft clipper (noise-like backgrounds): identity below the knee, tanh up to the ceiling; the ceiling is also the limiter's |
| `noiseSweepPeriod` / `noiseSweepLowHz` / `noiseSweepHighHz` | 16 s / 200 / 1212 | Built-in noise lowpass sweep ("noise modulation") |
| `noiseLikeFlatness` | 0.15 | Spectral flatness (300–8000 Hz) at or above which a background is clipped rather than limited |
| `maxPeakOvershootDb` | 6 | Musical backgrounds: max overshoot of the 99.9th percentile above the ceiling before limiting |
| `defaultNoiseVolume` | 0.7 | Legacy; no longer used for level (noise is normalized like music) |
| `maxNormalisationScale` | 40 | Maximum active-RMS normalization multiplier |
| `defaultCarrierDipDb` | 12 | Depth of the carrier-tracking dip (dB); 0 disables |
| Limiter ceiling | 0.85 | Safety limiter ceiling (normally idle) |
| Safety ceiling | 0.95 | Absolute maximum before Tone.js mix |
| Headroom cap | 0.89 | Master gain never exceeds this |
| Attack time | 1.5ms | Limiter gain reduction smoothing |
| Release time | 15ms / 80ms | Limiter gain recovery after a short (≤ 20 ms) / sustained over-run |
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

- **Sparse nature sounds**: Files with large silent gaps (birds, ocean waves, campfire) have very low global RMS. Normalization is keyed to their active RMS, so the sounding parts reach the target level while the gaps stay quiet; the limiter absorbs the transients and logs how hard it worked. Files that are almost entirely below the silence threshold (a few percent active) still end up quiet — the pre-flight analysis flags them.
- **Sample rate conversion**: Music files at different sample rates than the output (typically 44100 Hz) are handled via linear interpolation during mixing. No resampling step needed.
- **Mono music → stereo output**: When binaural beats are enabled (stereo output) but the music file is mono, the mono channel is duplicated to both output channels.

---

## Batch Regeneration (headless)

`scripts/batch/regen-sessions.js` renders every session of a sessions JSON with the same `generateAudio()` the pages use, in a headless Chromium driven through playwright-core, and writes `<audioFile>.wav` + `<audioFile>.short.wav`. It serves the repo and the sound folders itself, so nothing needs to be uploaded through the bulk page:

```bash
node scripts/batch/regen-sessions.js \
  --sessions ../sixth/sixth-mind/assets/default_sessions.json \
  --sounds "/Users/smanuel/Desktop/Used Sounds - Replacements,/Users/smanuel/Desktop/Used Sounds" \
  --out "/Users/smanuel/Desktop/New Sessions6"
./generate.sh "/Users/smanuel/Desktop/New Sessions6"   # FLAC + ALAC next to each WAV
```

`scripts/batch/preflight.js` runs the same in-page analyzer headlessly for any sessions JSON and sound folder (`--only` to pick sessions), so a verdict can be reproduced outside the page:

```bash
node scripts/batch/preflight.js --sessions ../sixth/sixth-mind/assets/default_sessions.json --sounds "/Users/smanuel/Desktop/New Used Sounds" --only "Sleepy Horizons"
```

Defaults match the shipped default-session renders (binaural on with +150 Hz carrier separation, isochronic 0.35, punch 2, background 0.5, main 0.7, 12 dB carrier dip, 48 kHz stereo 16-bit — the punch and binaural settings were read back from the shipped renders' sideband ratios); every value has a flag. Complete files are skipped, so a run can be restarted. The pre-flight verdict for each music-backed session is printed with the render line.
