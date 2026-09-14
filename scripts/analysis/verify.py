#!/usr/bin/env python3
"""verify.py "<Session name>" <file> [...more files]
Scores each candidate file against the named default session under
  legacy   = the generator before 2026-09 (global RMS norm, cap 4, no dip)
  current  = the generator now (active RMS norm, cap 40, 12 dB carrier dip)
and prints one verdict line per scenario."""
import json, os, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
SCEN = {"legacy":  {"CAP": "4", "DUCK_DB": "0", "NORM": "global"},     # generator before 2026-09
        "current": {"CAP": "40", "DUCK_DB": "12", "NORM": "active"}}   # generator now

def verdict(r):
    cs = list(r["carriers"].values())
    im = max(c["iso_masked_pct"] for c in cs); bm = max(c["bin_masked_pct"] for c in cs)
    ts = max(c["tonal_strong_pct"] for c in cs)
    conf = sum(len(c["beat_conflicts"]) for c in cs if c["snr_iso_p50_db"] < 20)
    bbam = max([m for f, m, _ in r["mod_bb"] if f <= 8] or [0])
    rms = r["rms_after"]
    iss = []
    if im >= 20: iss.append("mask")
    elif im >= 5: iss.append("mask~")
    if ts >= 10: iss.append("beats")
    elif ts >= 3: iss.append("beats~")
    if conf > 0: iss.append("rhythm")
    elif bbam >= 0.3 and rms >= 0.15: iss.append("rhythm~")
    if rms < 0.15: iss.append("quiet")
    sev = "REAL" if any(i in ("mask", "beats", "rhythm") for i in iss) else ("mild" if iss else "clean")
    sq = r.get("source")
    if sq:
        q = []
        if sq["gain_db"] > 18 and sq["bandwidth_hz"] < 5000 and sq["floor_db"] > -12:
            iss.append(f"poor-source(gain {sq['gain_db']:.0f} dB, bw {sq['bandwidth_hz']/1000:.1f} kHz, floor {sq['floor_db']:.0f} dB)")
        loud = sq.get("hiss_floor_db", -120) > -32 or (sq.get("hiss_floor_db", -120) > -38 and sq.get("active_frame_pct", 100) < 30)
        if loud and sq.get("hiss_const_db", -120) > -6 and sq.get("hiss_flat", 0) > 0.3:
            iss.append(f"steady-hiss({-sq['hiss_floor_db']:.0f} dB below music)")

    bsev = "REAL" if bm >= 40 else ("mild" if bm >= 15 else "clean")
    worst = min(c["snr_iso_p50_db"] for c in cs)
    return f"mask {im:3.0f}%  beats {ts:3.0f}%  bin {bm:3.0f}%  rhythm {conf:2d}  tempo {bbam*100:3.0f}%  mixRMS {rms:.2f}  worstSNR {worst:+5.1f}dB  iso={sev:<5} bin={bsev:<5} {' '.join(iss)}"

def main():
    session, files = sys.argv[1], sys.argv[2:]
    for f in files:
        print(f"\n### {session}  <-  {os.path.basename(f)}")
        for name, env in SCEN.items():
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as c:
                json.dump({session: os.path.abspath(f)}, c); cpath = c.name
            out = os.path.join(HERE, f"_verify_{name}.json")
            e = dict(os.environ, CANDIDATES=cpath, OUT=os.path.basename(out), **env)
            p = subprocess.run([sys.executable, os.path.join(HERE, "analyze_bg.py")], env=e, capture_output=True, text=True)
            if p.returncode != 0:
                print(name, "ERROR", p.stderr[-400:]); continue
            res = json.load(open(out))
            if not res:
                print(name, "no result (session name not found?)"); continue
            r = res[0]
            print(f"  {name:<8} {verdict(r)}")
            if name == "legacy":
                print(f"           src RMS {r['rms']:.3f} active {r['active_pct']:.0f}%  L/R corr {r['iacc_broadband']:.2f}  dur {r['dur_s']/60:.1f} min")
if __name__ == "__main__":
    main()
