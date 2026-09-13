// --------- Background Pre-flight Analysis ---------
// Measures how a background recording interacts with the isochronic / binaural
// layers of a given sequence, mirroring the generator's gain staging so the
// verdict reflects what will actually be rendered. Four things are measured
// inside one ERB (auditory filter width) around every carrier the sequence uses:
//
//   1. masking     — share of time the background is louder than the tone in its band
//   2. tonal lines — sustained spectral lines within ±40 Hz of the carrier at tone
//                    level (they beat against the carrier at the difference frequency)
//   3. rhythm      — amplitude modulation of the background at the session's own beat
//                    frequencies (a competing pulse), plus a broadband tempo check
//   4. stereo      — left/right correlation in the carrier band (binaural cue quality)
//
// plus the resulting mix level. Usage:
//   const report = AudioAnalysis.analyzeBackground(audioBuffer, parsedSequence, options);
//   report.severity  -> "clean" | "mild" | "real"
//   report.summary   -> one-line text, report.lines -> per-carrier detail lines
//
// Offline equivalent (Python, same metrics): scripts/analysis/analyze_bg.py

const AudioAnalysis = (() => {
	const ERB = f => 24.7 * (4.37 * f / 1000 + 1);
	const ELB = c => c < 400 ? 1 + 0.30 * (1 - c / 400) : 1; // equal-loudness boost, as in audio-core.js
	const ISO_ENV_RMS = 0.6124; // rms of the 0.5(1+sin) pulse envelope
	const SINE_RMS = 0.7071;
	const db = x => 20 * Math.log10(Math.max(x, 1e-9));

	// ---- biquads (RBJ cookbook) ----
	function biquad(type, f0, fs, Q, gainDb) {
		const w0 = 2 * Math.PI * f0 / fs, cw = Math.cos(w0), sw = Math.sin(w0);
		const al = sw / (2 * Q);
		let b0, b1, b2, a0, a1, a2;
		if (type === "lowpass") {
			b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al;
		} else if (type === "bandpass") { // constant 0 dB peak gain
			b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al;
		} else { // peaking
			const A = Math.pow(10, gainDb / 40);
			b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A;
		}
		return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
	}
	function run(x, c, out) {
		const y = out || new Float32Array(x.length);
		let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
		for (let i = 0; i < x.length; i++) {
			const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
			x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
		}
		return y;
	}
	function bandpassErb(x, C, fs) {
		// two cascaded RBJ bandpasses whose equivalent noise bandwidth ≈ one ERB
		const q = C / (1.27 * ERB(C));
		const c = biquad("bandpass", C, fs, q);
		return run(run(x, c), c);
	}
	function decimate(x, fs, factor) {
		const fc = 0.4 * (fs / factor);
		const c = biquad("lowpass", fc, fs, 0.7071);
		const y = run(run(x, c), c);
		const n = Math.floor(y.length / factor);
		const out = new Float32Array(n);
		for (let i = 0; i < n; i++) out[i] = y[i * factor];
		return out;
	}

	// ---- FFT (iterative radix-2, in place) ----
	function fft(re, im) {
		const n = re.length;
		for (let i = 1, j = 0; i < n; i++) {
			let bit = n >> 1;
			for (; j & bit; bit >>= 1) j ^= bit;
			j ^= bit;
			if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
		}
		for (let len = 2; len <= n; len <<= 1) {
			const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
			const half = len >> 1;
			for (let i = 0; i < n; i += len) {
				let cr = 1, ci = 0;
				for (let k = 0; k < half; k++) {
					const a = i + k, b = a + half;
					const vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
					re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
					const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
				}
			}
		}
	}
	function hann(n) { const w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); return w; }
	// One-sided power spectrum, 'spectrum' scaling: a sinusoid of amplitude A -> peak ≈ A²/2
	function powerSpectrum(frame, w, wsum, re, im) {
		const n = frame.length;
		for (let i = 0; i < n; i++) { re[i] = frame[i] * w[i]; im[i] = 0; }
		fft(re, im);
		const p = new Float64Array(n / 2 + 1);
		for (let k = 0; k <= n / 2; k++) p[k] = 2 * (re[k] * re[k] + im[k] * im[k]) / (wsum * wsum);
		return p;
	}
	function median(arr) { const a = Array.from(arr).sort((p, q) => p - q); return a.length ? a[a.length >> 1] : 0; }

	function frameRms(x, fs, win) {
		const n = Math.max(1, Math.round(fs * win)), k = Math.floor(x.length / n), out = new Float64Array(k);
		for (let j = 0; j < k; j++) { let s = 0; for (let i = j * n; i < (j + 1) * n; i++) s += x[i] * x[i]; out[j] = Math.sqrt(s / n); }
		return out;
	}

	// Normalised amplitude-modulation spectrum of a signal: envelope -> 200 Hz ->
	// averaged Hann FFTs (~20 s windows) -> modulation index per 0.05 Hz bin.
	function modulationSpectrum(x, fs) {
		const envLp = biquad("lowpass", 60, fs, 0.7071);
		const abs = new Float32Array(x.length);
		for (let i = 0; i < x.length; i++) abs[i] = Math.abs(x[i]);
		const env = run(run(abs, envLp), envLp);
		const factor = Math.max(1, Math.round(fs / 200));
		const fsEnv = fs / factor;
		const n = Math.floor(env.length / factor);
		const e = new Float64Array(n);
		let mean = 0;
		for (let i = 0; i < n; i++) { e[i] = env[i * factor]; mean += e[i]; }
		mean /= Math.max(n, 1);
		if (mean <= 0) return null;
		for (let i = 0; i < n; i++) e[i] = e[i] / mean - 1;
		let N = 4096;
		while (N > n && N > 256) N >>= 1;
		const w = hann(N); let wsum = 0; for (let i = 0; i < N; i++) wsum += w[i];
		const re = new Float64Array(N), im = new Float64Array(N);
		const acc = new Float64Array(N / 2 + 1);
		let frames = 0;
		for (let s = 0; s + N <= n; s += N >> 1) {
			const p = powerSpectrum(e.subarray(s, s + N), w, wsum, re, im);
			for (let k = 0; k < acc.length; k++) acc[k] += p[k];
			frames++;
		}
		if (!frames) return null;
		const m = new Float64Array(acc.length);
		for (let k = 0; k < acc.length; k++) m[k] = Math.sqrt(2 * acc[k] / frames); // modulation index
		return { freqs: k => k * fsEnv / N, m, N, fsEnv };
	}
	function modPeaks(ms, lo, hi) {
		if (!ms) return [];
		const out = [];
		const kLo = Math.max(1, Math.ceil(lo * ms.N / ms.fsEnv)), kHi = Math.min(ms.m.length - 2, Math.floor(hi * ms.N / ms.fsEnv));
		const base = median(ms.m.subarray(kLo, kHi + 1));
		for (let k = kLo; k <= kHi; k++) {
			if (ms.m[k] > ms.m[k - 1] && ms.m[k] >= ms.m[k + 1] && ms.m[k] >= 2 * base) out.push({ f: ms.freqs(k), m: ms.m[k] });
		}
		return out.sort((a, b) => b.m - a.m);
	}

	function analyzeBackground(buffer, sequence, options) {
		const o = Object.assign({
			targetVolume: 0.3, maxScale: 40, isochronicVolume: 0.35, isochronicPunch: 1, binauralVolume: 0.16,
			useBinaural: false, binauralCarrierOffset: 0, carrierDipDb: 12, isCustomMusic: true,
			softClipKnee: 0.6, peakCeiling: 0.85
		}, options || {});
		const fs0 = buffer.sampleRate;
		const nCh = buffer.numberOfChannels;

		// ---- source statistics ----
		let rms = 0, active = 0, activeSum = 0, total = 0;
		for (let ch = 0; ch < nCh; ch++) {
			const d = buffer.getChannelData(ch);
			for (let i = 0; i < d.length; i++) { const v = d[i] * d[i]; rms += v; total++; if (Math.abs(d[i]) > 0.01) { activeSum += v; active++; } }
		}
		rms = Math.sqrt(rms / Math.max(total, 1));
		const activeRms = active ? Math.sqrt(activeSum / active) : 0;
		const activePct = 100 * active / Math.max(total, 1);
		let isoVol = o.isochronicVolume;
		if (o.isCustomMusic && activeRms > 0.10) isoVol *= 1 + 0.30 * Math.min((activeRms - 0.10) / 0.10, 1);
		// rms of the pulse envelope (0.5(1+sin))^punch
		let envRms = 0; { const n = 2048; let s = 0; for (let i = 0; i < n; i++) { const e = Math.pow(0.5 * (1 + Math.sin(2 * Math.PI * i / n)), o.isochronicPunch || 1); s += e * e; } envRms = Math.sqrt(s / n); }

		// ---- decimated working copies at unity gain (~4.4 kHz is plenty for carriers ≤ 852 Hz) ----
		const factor = Math.max(1, Math.round(fs0 / 4400));
		const fs = fs0 / factor;
		const chans = [];
		for (let ch = 0; ch < Math.min(nCh, 2); ch++) chans.push(decimate(buffer.getChannelData(ch), fs0, factor));
		const L0 = chans[0], R0 = chans[1] || chans[0];

		// ---- level staging, mirroring generateAudio: the DIPPED signal is normalised to
		//      the target active RMS and its transients are soft-clipped. Done per carrier
		//      (the generator's dip tracks the carrier through the session).
		const activeRmsOf = (a, b) => { let s = 0, n = 0; for (let i = 0; i < a.length; i++) { const x = 0.5 * (a[i] + b[i]); if (Math.abs(x) > 0.01) { s += x * x; n++; } } return n ? Math.sqrt(s / n) : 0; };
		const clip = (x) => { const k = o.softClipKnee, r = o.peakCeiling - k; const a = Math.abs(x); return a > k ? (x < 0 ? -1 : 1) * (k + r * Math.tanh((a - k) / r)) : x; };
		const stage = (l, r) => { // returns scaled+clipped copies and the scale used
			const dipRms = activeRmsOf(l, r);
			let scale = Math.min(o.targetVolume / Math.max(dipRms, 1e-6), o.maxScale);
			const out = () => { const L = new Float32Array(l.length), R = new Float32Array(r.length); for (let i = 0; i < l.length; i++) { L[i] = clip(l[i] * scale); R[i] = clip(r[i] * scale); } return [L, R]; };
			let [L, R] = out();
			const got = activeRmsOf(L, R);
			if (Math.abs(20 * Math.log10(got / o.targetVolume)) >= 0.3) { scale = Math.min(scale * o.targetVolume / Math.max(got, 1e-6), o.maxScale); [L, R] = out(); }
			return { L, R, scale, rms: activeRmsOf(L, R) };
		};
		// broadband level as it will be heard: dip at the first carrier is representative enough for the tempo check
		const firstC = sequence[0] && sequence[0].carrierFreq ? sequence[0].carrierFreq : 174;
		let bbL = L0, bbR = R0;
		if (o.carrierDipDb > 0) { const dip0 = biquad("peaking", firstC, fs, firstC / ERB(firstC), -Math.abs(o.carrierDipDb)); bbL = run(L0, dip0); bbR = run(R0, dip0); }
		const bbStage = stage(bbL, bbR);
		const scale = bbStage.scale, mixRms = bbStage.rms;
		const L = bbStage.L, R = bbStage.R;
		const monoAll = new Float32Array(L.length);
		for (let i = 0; i < L.length; i++) monoAll[i] = 0.5 * (L[i] + R[i]);

		// broadband tempo (0.5–8 Hz)
		const bbPeaks = modPeaks(modulationSpectrum(monoAll, fs), 0.5, 8);
		const tempo = bbPeaks.length ? bbPeaks[0] : { f: 0, m: 0 };

		// carriers and beat frequencies used by this sequence
		const carriers = [];
		const first = sequence[0] && sequence[0].carrierFreq ? sequence[0].carrierFreq : 174;
		carriers.push(first);
		sequence.forEach(s => { if (s.carrierFreq && !carriers.includes(s.carrierFreq)) carriers.push(s.carrierFreq); });
		const beats = [...new Set(sequence.map(s => s.frequency))];

		// ---- per-carrier measurements ----
		const N = 4096, w = hann(N); let wsum = 0; for (let i = 0; i < N; i++) wsum += w[i];
		const re = new Float64Array(N), im = new Float64Array(N);
		const perCarrier = carriers.map(C => {
			// dip at this carrier on the unity signal, then the same level staging the generator applies
			let dl = L0, dr = R0;
			if (o.carrierDipDb > 0) {
				const dip = biquad("peaking", C, fs, C / ERB(C), -Math.abs(o.carrierDipDb));
				dl = run(L0, dip); dr = run(R0, dip);
			}
			const st = stage(dl, dr);
			const xl = st.L, xr = st.R;
			const bl = bandpassErb(xl, C, fs), br = bandpassErb(xr, C, fs);
			const fl = frameRms(bl, fs, 1), fr = frameRms(br, fs, 1);
			const band = new Float64Array(fl.length);
			for (let i = 0; i < band.length; i++) band[i] = 0.5 * (fl[i] + fr[i]);
			const isoRms = isoVol * ELB(C) * envRms * SINE_RMS;
			let isoMasked = 0;
			for (let i = 0; i < band.length; i++) if (band[i] > isoRms) isoMasked++;
			const p50 = median(band);
			const snr = db(isoRms) - db(p50);

			// Binaural pair sits at C ± f/2 (coupled) or at C + offset ± f/2 (separated):
			// measure its own band, with its own dip, against the binaural level.
			const Cb = C + (o.binauralCarrierOffset > 0 ? o.binauralCarrierOffset : 0);
			let binBand = band;
			if (Cb !== C) {
				let yl = xl, yr = xr;
				if (o.carrierDipDb > 0) { const dipB = biquad("peaking", Cb, fs, Cb / ERB(Cb), -Math.abs(o.carrierDipDb)); yl = run(xl, dipB); yr = run(xr, dipB); }
				const fbl = frameRms(bandpassErb(yl, Cb, fs), fs, 1), fbr = frameRms(bandpassErb(yr, Cb, fs), fs, 1);
				binBand = new Float64Array(fbl.length);
				for (let i = 0; i < binBand.length; i++) binBand[i] = 0.5 * (fbl[i] + fbr[i]);
			}
			const binRms = o.binauralVolume * ELB(Cb) * SINE_RMS;
			let binMasked = 0;
			for (let i = 0; i < binBand.length; i++) if (binBand[i] > binRms) binMasked++;

			// stereo correlation in band
			let sxy = 0, sxx = 0, syy = 0;
			for (let i = 0; i < bl.length; i++) { sxy += bl[i] * br[i]; sxx += bl[i] * bl[i]; syy += br[i] * br[i]; }
			const iacc = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 1;

			// tonal lines within ±40 Hz of the carrier (per ~0.5 s frame)
			const mono = new Float32Array(xl.length);
			for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (xl[i] + xr[i]);
			const binHz = fs / N;
			const kC = Math.round(C / binHz), kNear = Math.round(40 / binHz), kWide = Math.round(150 / binHz);
			const toneLineRms = isoVol * ELB(C) * SINE_RMS; // the carrier line itself
			let frames = 0, tonal = 0, strong = 0;
			const offsets = [];
			for (let s = 0; s + N <= mono.length; s += N >> 1) {
				const p = powerSpectrum(mono.subarray(s, s + N), w, wsum, re, im);
				const wide = p.subarray(Math.max(1, kC - kWide), Math.min(p.length, kC + kWide + 1));
				const base = median(wide) + 1e-14;
				let kMax = -1, pMax = 0;
				for (let k = Math.max(1, kC - kNear); k <= Math.min(p.length - 2, kC + kNear); k++) if (p[k] > pMax) { pMax = p[k]; kMax = k; }
				frames++;
				if (kMax > 0 && 10 * Math.log10(pMax / base) >= 10) {
					tonal++;
					const lineRms = Math.sqrt(p[kMax - 1] + p[kMax] + p[kMax + 1]);
					if (db(lineRms) - db(toneLineRms) >= -6) { strong++; offsets.push(Math.abs(kMax * binHz - C)); }
				}
			}

			// in-band rhythm vs the session's beat frequencies
			const bandMono = new Float32Array(bl.length);
			for (let i = 0; i < bl.length; i++) bandMono[i] = 0.5 * (bl[i] + br[i]);
			const ms = modulationSpectrum(bandMono, fs);
			const conflicts = [];
			if (ms && snr < 20) {
				beats.forEach(b => {
					const tol = Math.max(0.3, 0.08 * b);
					let mi = 0;
					const kLo = Math.max(1, Math.floor((b - tol) * ms.N / ms.fsEnv)), kHi = Math.min(ms.m.length - 1, Math.ceil((b + tol) * ms.N / ms.fsEnv));
					for (let k = kLo; k <= kHi; k++) if (ms.m[k] > mi) mi = ms.m[k];
					if (mi >= 0.15) conflicts.push({ beat: b, m: mi });
				});
			}

			return {
				carrier: C, snrDb: snr, isoMaskedPct: 100 * isoMasked / Math.max(band.length, 1),
				binMaskedPct: 100 * binMasked / Math.max(binBand.length, 1), iacc,
				tonalPct: 100 * tonal / Math.max(frames, 1), strongPct: 100 * strong / Math.max(frames, 1),
				medianOffsetHz: offsets.length ? median(offsets) : null, conflicts
			};
		});

		// ---- verdict ----
		const maxIso = Math.max(...perCarrier.map(c => c.isoMaskedPct));
		const maxBin = Math.max(...perCarrier.map(c => c.binMaskedPct));
		const maxStrong = Math.max(...perCarrier.map(c => c.strongPct));
		const nConflicts = perCarrier.reduce((a, c) => a + c.conflicts.length, 0);
		const minIacc = Math.min(...perCarrier.map(c => c.iacc));
		const issues = [];
		if (maxIso >= 20) issues.push(`masking ${maxIso.toFixed(0)}%`); else if (maxIso >= 5) issues.push(`mild masking ${maxIso.toFixed(0)}%`);
		if (maxStrong >= 10) issues.push(`spurious beats ${maxStrong.toFixed(0)}%`); else if (maxStrong >= 3) issues.push(`mild tonal ${maxStrong.toFixed(0)}%`);
		if (nConflicts > 0) issues.push(`rhythm at ${nConflicts} beat freq${nConflicts > 1 ? 's' : ''}`);
		else if (tempo.m >= 0.30 && mixRms >= 0.15) issues.push(`rhythmic (${tempo.f.toFixed(1)} Hz, ${(tempo.m * 100).toFixed(0)}% depth)`);
		if (mixRms < 0.15) issues.push(`background too quiet (mix RMS ${mixRms.toFixed(2)})`);
		const notes = [];
		if (o.useBinaural) {
			if (maxBin >= 40) issues.push(`binaural masked ${maxBin.toFixed(0)}%`); else if (maxBin >= 15) issues.push(`binaural mild ${maxBin.toFixed(0)}%`);
			// Informational only: a wide stereo image adds uncorrelated noise around the binaural
			// pair, but the masking test above already measures whether the pair stays audible.
			if (minIacc < 0.3) notes.push(`wide stereo in carrier band`);
		}
		const real = maxIso >= 20 || maxStrong >= 10 || nConflicts > 0 || (o.useBinaural && maxBin >= 40);
		const severity = real ? "real" : (issues.length ? "mild" : "clean");

		const lines = perCarrier.map(c =>
			`C=${c.carrier} Hz: SNR ${c.snrDb >= 0 ? '+' : ''}${c.snrDb.toFixed(1)} dB, masked ${c.isoMaskedPct.toFixed(0)}% (binaural ${c.binMaskedPct.toFixed(0)}%), tonal lines ${c.tonalPct.toFixed(0)}% / strong ${c.strongPct.toFixed(0)}%` +
			(c.medianOffsetHz !== null ? ` (≈${c.medianOffsetHz.toFixed(1)} Hz off)` : '') +
			`, L/R corr ${c.iacc.toFixed(2)}` +
			(c.conflicts.length ? `, rhythm: ${c.conflicts.map(k => `${k.beat} Hz@${(k.m * 100).toFixed(0)}%`).join(' ')}` : ''));
		const summary = `${severity.toUpperCase()}${issues.length ? ': ' + issues.join('; ') : ' (no interference found)'}${notes.length ? ' (note: ' + notes.join('; ') + ')' : ''} — src RMS ${rms.toFixed(3)} (${activePct.toFixed(0)}% active) ×${scale.toFixed(1)} → mix ${mixRms.toFixed(2)}`;
		return { severity, issues, notes, summary, lines, mixRms, scale, activePct, tempo, perCarrier };
	}

	return { analyzeBackground };
})();
