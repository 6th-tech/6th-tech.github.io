#!/usr/bin/env python3
"""Offline background analysis (same metrics as scripts/audio-analysis.js).

Measures how each background file interacts with the isochronic / binaural
layers of the session that uses it. Mimics the audio-core.js gain staging
(active-RMS normalisation to 0.5 capped at 40x, isochronic boost, carrier
equal-loudness boost, 12 dB carrier dip) and then looks at:

  1. in-band masking : music RMS inside one ERB around each carrier vs tone RMS
  2. tonal collisions: stable spectral peaks within +-40 Hz of a carrier
  3. modulation      : amplitude-modulation spectrum of the music (broadband and
                       in-band) vs the session's beat frequencies
  4. interaural corr.: L/R correlation inside the carrier band (binaural cue)

Usage:
  python3 analyze_bg.py [substring ...]        # all music-backed default sessions (or those matching)
  CANDIDATES=map.json python3 analyze_bg.py    # {"Session name": "/path/to/candidate.mp3", ...}
Env: SOUNDS (folder with the session files), SESSIONS (default_sessions.json),
     CAP / DUCK_DB / NORM to simulate other generator settings, OUT (json report).
Needs ffmpeg on PATH, numpy and scipy. See verify.py for a per-file wrapper.
"""
import json, subprocess, sys, os
import numpy as np
from scipy import signal

SR = 44100
DEC = 11                      # 44100/11 = 4009 Hz for band analysis (carriers <= 852 Hz)
FS = SR / DEC
ENV_DEC = 20                  # envelope rate 4009/20 = 200 Hz
FS_ENV = FS / ENV_DEC

SOUNDS = os.environ.get("SOUNDS", "/Users/smanuel/Desktop/Used Sounds")
SESSIONS = os.environ.get("SESSIONS", "/Users/smanuel/Work/sixth/sixth-mind/assets/default_sessions.json")

ISO_VOL = float(os.environ.get("ISO", 0.35)); BIN_VOL = 0.16; TARGET_RMS = float(os.environ.get("TARGET", 0.25))  # target ACTIVE RMS after dip + transient treatment
PUNCH = float(os.environ.get("PUNCH", 2)); SOFT_KNEE, PEAK_CEIL = 0.6, 0.85
MAX_SCALE = float(os.environ.get("CAP", 40))       # normalisation scale cap (generator: 40)
DUCK_DB = float(os.environ.get("DUCK_DB", 12))      # carrier-tracking dip carved out of the music (generator: 12)
NORM = os.environ.get("NORM", "active")             # 'active' (generator) or 'global' RMS as normalisation reference
OUT = os.environ.get("OUT", "bg_analysis.json")

def peaking(f0, fs, gain_db, Q):
    A = 10 ** (gain_db / 40); w0 = 2 * np.pi * f0 / fs; al = np.sin(w0) / (2 * Q)
    b = np.array([1 + al * A, -2 * np.cos(w0), 1 - al * A]); a = np.array([1 + al / A, -2 * np.cos(w0), 1 - al / A])
    return b / a[0], a / a[0]

def duck(x, C, fs):
    """Peaking-EQ dip of DUCK_DB centred on the carrier, one ERB wide (what a carrier-tracking notch in the generator would do)."""
    b, a = peaking(C, fs, -abs(DUCK_DB), C / erb(C))
    return signal.lfilter(b, a, x, axis=-1)
_t = np.linspace(0, 1, 4096, endpoint=False)
ISO_ENV_RMS = float(np.sqrt(np.mean((0.5 * (1 + np.sin(2 * np.pi * _t))) ** (2 * PUNCH))))  # rms of the pulse envelope (0.5(1+sin))^punch
SINE_RMS = 0.7071

def erb(f):  return 24.7 * (4.37 * f / 1000 + 1)
def elb(c):  return 1 + 0.30 * (1 - c / 400) if c < 400 else 1.0
def db(x):   return 20 * np.log10(max(x, 1e-9))

def decode(path):
    cmd = ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-acodec", "pcm_f32le",
           "-ac", "2", "-ar", str(SR), "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T.astype(np.float64)

def active_rms(x, thr=0.01):
    m = np.abs(x) > thr
    return (float(np.sqrt(np.mean(x[m] ** 2))) if m.any() else 0.0), float(m.mean() * 100)

def bandpass(x, lo, hi, fs, order=None):
    """One-ERB band around the carrier: two cascaded RBJ bandpass biquads whose combined
    equivalent noise bandwidth is one ERB, with roex-like skirts (~10 dB one ERB away).
    Identical to bandpassErb() in scripts/audio-analysis.js so both analyzers agree."""
    C = 0.5 * (lo + hi); bw = hi - lo
    Q = C / (1.27 * bw)
    w0 = 2 * np.pi * C / fs; al = np.sin(w0) / (2 * Q)
    b = np.array([al, 0.0, -al]) / (1 + al); a = np.array([1 + al, -2 * np.cos(w0), 1 - al]) / (1 + al)
    return signal.lfilter(b, a, signal.lfilter(b, a, x))

def soft_clip(x, knee=SOFT_KNEE, ceil=PEAK_CEIL):
    a = np.abs(x); r = ceil - knee
    return np.where(a > knee, np.sign(x) * (knee + r * np.tanh((a - knee) / r)), x)

def active_rms_mono(x2):
    m = 0.5 * (x2[0] + x2[1]); sel = np.abs(m) > 0.01
    return float(np.sqrt(np.mean(m[sel] ** 2))) if sel.any() else 0.0

def stage(x2):
    """Generator level staging on a (2, N) unity-gain, already-dipped signal: normalise the
    active RMS to TARGET_RMS (cap MAX_SCALE), soft-clip, one corrective pass."""
    scale = min(TARGET_RMS / max(active_rms_mono(x2), 1e-6), MAX_SCALE)
    y = soft_clip(x2 * scale); got = active_rms_mono(y)
    if abs(20 * np.log10(max(got, 1e-9) / TARGET_RMS)) >= 0.3:
        scale = min(scale * TARGET_RMS / max(got, 1e-6), MAX_SCALE); y = soft_clip(x2 * scale)
    return y, scale

def lowpass(x, fc, fs, order=4):
    sos = signal.butter(order, fc, btype="low", fs=fs, output="sos")
    return signal.sosfiltfilt(sos, x)

def frame_rms(x, fs, win=1.0):
    n = int(fs * win)
    k = len(x) // n
    return np.sqrt(np.mean(x[: k * n].reshape(k, n) ** 2, axis=1))

def mod_spectrum(band, fs):
    """Normalised AM spectrum of a band-limited signal. Returns (freqs, mod index)."""
    env = np.abs(signal.hilbert(band))
    env = lowpass(env, 60, fs)
    env = signal.resample_poly(env, 1, ENV_DEC)
    mean = env.mean()
    if mean <= 0:
        return None, None
    envn = env / mean - 1.0
    nper = int(FS_ENV * 20)                      # 20 s windows -> 0.05 Hz resolution
    if len(envn) < nper:
        nper = len(envn)
    f, p = signal.welch(envn, fs=FS_ENV, nperseg=nper, scaling="spectrum", window="hann")
    return f, np.sqrt(2 * p)                     # sinusoidal modulation index

def mod_peaks(f, m, lo=0.5, hi=45, top=6):
    sel = (f >= lo) & (f <= hi)
    fs_, ms_ = f[sel], m[sel]
    if len(ms_) == 0:
        return []
    base = np.median(ms_)
    idx, props = signal.find_peaks(ms_, prominence=base * 1.0)
    order = np.argsort(ms_[idx])[::-1][:top]
    return [(float(fs_[i]), float(ms_[i]), float(ms_[i] / base)) for i in idx[order]]

def tonal_collisions(xd_mono, fs, carrier, tone_rms):
    """Per 1-s frame: strongest spectral line within +-40 Hz of carrier."""
    nper = 4096
    f, t, S = signal.spectrogram(xd_mono, fs=fs, nperseg=nper, noverlap=nper // 2,
                                 scaling="spectrum", mode="psd", window="hann")
    near = (f >= carrier - 40) & (f <= carrier + 40)
    wide = (f >= carrier - 150) & (f <= carrier + 150)
    fr = f[near]
    res = {"frames": S.shape[1], "tonal": 0, "strong": 0, "offsets": [], "levels_db": []}
    for j in range(S.shape[1]):
        col = S[:, j]
        base = np.median(col[wide]) + 1e-14
        k = np.argmax(col[near])
        pk = col[near][k]
        prom = 10 * np.log10(pk / base)
        if prom >= 10:
            # sum 3 bins for the line's power -> rms amplitude
            kk = np.where(near)[0][k]
            pw = col[max(0, kk - 1): kk + 2].sum()
            line_rms = np.sqrt(pw)
            rel = 20 * np.log10(line_rms / tone_rms)
            res["tonal"] += 1
            res["offsets"].append(float(fr[k] - carrier))
            res["levels_db"].append(float(rel))
            if rel >= -6:
                res["strong"] += 1
    return res

def parse_seq(seq):
    carriers, beats = [], []
    for line in seq.split("\n"):
        p = [q.strip() for q in line.split(",")]
        beats.append(float(p[0]))
        if len(p) > 4 and p[4]:
            carriers.append(float(p[4]))
    if not carriers or (len(seq.split("\n")[0].split(",")) < 5):
        carriers.insert(0, 174.0)
    return sorted(set(carriers)), sorted(set(beats))

def analyse(path, carriers, beats, iso_extra=1.0):
    x = decode(path)
    n = x.shape[1]
    rms_all = float(np.sqrt(np.mean(x ** 2)))
    peak = float(np.abs(x).max())
    a_rms, a_pct = active_rms(x)
    boost = 1 + 0.30 * min((a_rms - 0.10) / 0.10, 1) if a_rms > 0.10 else 1.0
    iacc_bb = float(np.corrcoef(x[0], x[1])[0, 1])

    xd0 = signal.resample_poly(x, 1, DEC, axis=1)          # unity gain
    # broadband level as heard: dip at the first carrier, then the generator's level staging
    xbb = duck(xd0, carriers[0], FS) if DUCK_DB else xd0
    xbb, scale = stage(xbb)
    mono = xbb.mean(axis=0)

    # source quality: gain needed, noise floor vs active level, bandwidth (see audio-analysis.js)
    fr = frame_rms(x.mean(axis=0), SR, 0.1); floor = float(np.percentile(fr, 5)) if len(fr) else 0.0
    gain_db = 20 * np.log10(TARGET_RMS / max(a_rms, 1e-6)); floor_db = 20 * np.log10(max(floor, 1e-6) / max(a_rms, 1e-6))
    fq, Pq = signal.welch(x.mean(axis=0), fs=SR, nperseg=8192); bw = float(fq[np.where(Pq > Pq.max() * 1e-6)[0][-1]])
    out = {"file": os.path.basename(path), "dur_s": n / SR, "rms": rms_all, "peak": peak,
           "source": {"gain_db": float(gain_db), "floor_db": float(floor_db), "bandwidth_hz": bw},
           "active_rms": a_rms, "active_pct": a_pct, "scale": scale, "iso_boost_1c": boost,
           "rms_after": active_rms_mono(xbb), "iacc_broadband": iacc_bb, "carriers": {}}

    # broadband modulation spectrum (0-2 kHz after decimation)
    f, m = mod_spectrum(mono, FS)
    out["mod_bb"] = mod_peaks(f, m) if f is not None else []

    for C in carriers:
        half = erb(C) / 2
        xc = duck(xd0, C, FS) if DUCK_DB else xd0
        xc, _ = stage(xc)
        mono = xc.mean(axis=0)
        bl = bandpass(xc[0], C - half, C + half, FS)
        br = bandpass(xc[1], C - half, C + half, FS)
        iso_rms = ISO_VOL * boost * elb(C) * ISO_ENV_RMS * SINE_RMS
        bin_rms = BIN_VOL * elb(C) * SINE_RMS
        frl, frr = frame_rms(bl, FS), frame_rms(br, FS)
        band = (frl + frr) / 2
        p50, p90 = float(np.median(band)), float(np.percentile(band, 90))
        masked_pct = float(np.mean(band > iso_rms) * 100)
        bin_masked_pct = float(np.mean(band > bin_rms) * 100)
        iacc = float(np.corrcoef(bl, br)[0, 1]) if bl.std() > 0 and br.std() > 0 else 1.0
        tc = tonal_collisions(mono, FS, C, ISO_VOL * boost * elb(C) * SINE_RMS)
        fb, mb = mod_spectrum((bl + br) / 2, FS)
        conflicts = []
        if fb is not None:
            for bt in beats:
                tol = max(0.3, 0.08 * bt)
                sel = (fb >= bt - tol) & (fb <= bt + tol)
                if sel.any():
                    mi = float(mb[sel].max())
                    if mi >= 0.15:
                        conflicts.append((bt, mi))
        out["carriers"][C] = {
            "erb": erb(C), "iso_rms": iso_rms, "bin_rms": bin_rms,
            "band_p50": p50, "band_p90": p90,
            "snr_iso_p50_db": db(iso_rms) - db(p50), "snr_iso_p90_db": db(iso_rms) - db(p90),
            "snr_bin_p50_db": db(bin_rms) - db(p50),
            "iso_masked_pct": masked_pct, "bin_masked_pct": bin_masked_pct,
            "iacc": iacc,
            "tonal_pct": 100 * tc["tonal"] / tc["frames"],
            "tonal_strong_pct": 100 * tc["strong"] / tc["frames"],
            "tonal_med_offset": float(np.median(np.abs(tc["offsets"]))) if tc["offsets"] else None,
            "tonal_med_level_db": float(np.median(tc["levels_db"])) if tc["levels_db"] else None,
            "inband_mod_peaks": mod_peaks(fb, mb, top=4) if fb is not None else [],
            "beat_conflicts": conflicts,
        }
    return out

def main():
    sessions = json.load(open(SESSIONS))
    only = sys.argv[1:]  # optional substrings to restrict files
    # CANDIDATES: JSON file mapping session name -> candidate audio path (overrides the session's own file)
    cand = json.load(open(os.environ["CANDIDATES"])) if os.environ.get("CANDIDATES") else None
    results = []
    for s in sessions:
        bg = s["backgroundSound"]
        if cand is not None:
            if s["name"] not in cand:
                continue
            bg = os.path.basename(cand[s["name"]])
            path = cand[s["name"]]
        else:
            if bg in ("white", "pink", "brown"):
                continue
            path = os.path.join(SOUNDS, bg)
        if only and not any(o in bg for o in only):
            continue
        if not os.path.exists(path):
            print("MISSING", bg); continue
        carriers, beats = parse_seq(s["sequence"])
        r = analyse(path, carriers, beats)
        r["session"] = s["name"]; r["band"] = s.get("mainFrequency"); r["beats"] = beats
        results.append(r)
        # ---- report ----
        print(f"\n=== {s['name']} [{s.get('mainFrequency')}]  <-  {bg}")
        print(f"  dur {r['dur_s']/60:.1f} min | src RMS {r['rms']:.3f} peak {r['peak']:.2f} | active RMS {r['active_rms']:.3f} ({r['active_pct']:.0f}% active)"
              f" | scale x{r['scale']:.2f} -> mix RMS {r['rms_after']:.3f} | iso boost(1c) x{r['iso_boost_1c']:.2f} | L/R corr {r['iacc_broadband']:.2f}")
        print(f"  beats: {', '.join(f'{b:g}' for b in beats)}")
        sq = r["source"]; print(f"  source: needs {sq['gain_db']:+.1f} dB, floor {sq['floor_db']:+.1f} dB vs active, bandwidth {sq['bandwidth_hz']/1000:.1f} kHz")
        bb = ", ".join(f"{f_:.2f}Hz m={m_*100:.0f}%" for f_, m_, _ in r["mod_bb"][:5])
        print(f"  broadband AM peaks: {bb}")
        print(f"  {'carrier':>7} {'ERB':>5} {'SNRiso p50':>10} {'p90':>6} {'iso masked%':>11} {'SNRbin':>7} {'bin masked%':>11} {'IACC':>5} {'tonal%':>6} {'strong%':>7} {'|off|':>5} {'lvl dB':>6}  in-band AM peaks / beat conflicts")
        for C, c in r["carriers"].items():
            am = ", ".join(f"{f_:.2f}:{m_*100:.0f}%" for f_, m_, _ in c["inband_mod_peaks"][:3])
            conf = "; ".join(f"beat {b:g}Hz<->m={mi*100:.0f}%" for b, mi in c["beat_conflicts"])
            off = f"{c['tonal_med_offset']:.1f}" if c["tonal_med_offset"] is not None else "-"
            lvl = f"{c['tonal_med_level_db']:+.0f}" if c["tonal_med_level_db"] is not None else "-"
            print(f"  {C:>7.0f} {c['erb']:>5.0f} {c['snr_iso_p50_db']:>+10.1f} {c['snr_iso_p90_db']:>+6.1f} {c['iso_masked_pct']:>11.0f} {c['snr_bin_p50_db']:>+7.1f} {c['bin_masked_pct']:>11.0f} {c['iacc']:>5.2f} {c['tonal_pct']:>6.0f} {c['tonal_strong_pct']:>7.0f} {off:>5} {lvl:>6}  {am} {('| ' + conf) if conf else ''}")
    json.dump(results, open(os.path.join(os.path.dirname(__file__), OUT), "w"), indent=1, default=float)

if __name__ == "__main__":
    main()
