// --------- Shared Audio Generation Core ---------
// This module contains the core audio generation functionality
// that can be used by both generate.js and generate_bulk.js

// --------- Constants ---------
const fadeIn = 10; // sec
const fadeOut = 10; // sec
const noiseFade = 3; // sec
const finalBuffer = 3; // sec
const defaultBackgroundVolume = 0.25;  // target ACTIVE RMS of the background as heard (after dip and limiting); ≈ 5.7 dB above the isochronic tone
const defaultNoiseVolume = 0.7; // legacy: built-in noise now goes through the same normalisation as music
const defaultCarrierDipDb = 12;      // dB carved out of the background around the carrier (one ERB wide)
const maxNormalisationScale = 40;   // cap on active-RMS normalisation gain (was 4 on global RMS)
const softClipKnee = 0.6;           // samples above this are rounded off smoothly …
const peakCeiling = 0.85;           // … and never exceed this
const noiseSweepPeriod = 16;        // s per full lowpass sweep cycle of the built-in noise ("noise modulation")
const noiseSweepLowHz = 200;        // sweep bottom …
const noiseSweepHighHz = 1212;      // … and top (2.6 octaves above)
const noiseLikeFlatness = 0.15;     // spectral flatness (300–8000 Hz) at or above which a background counts as noise-like (clipper instead of limiter)
const maxPeakOvershootDb = 6;       // musical backgrounds: the loudest 0.1% of samples may exceed the ceiling by at most this much before limiting (keeps the limiter on transients only; rare spikes are left to it)

// --------- Parsing Functions ---------
function parseSequence(sequenceText) {
	// Sanitize: keep only digits, decimal points, commas, and newlines
	const raw = sequenceText.replace(/[^0-9.,\n]/g, "");

	const sequence = raw
		.trim()
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => {
			const [frequency, duration, rampDuration, rampType, stepCarrier] = line
				.split(",")
				.map(v => (v !== undefined && v !== null ? parseFloat(v.trim()) : undefined));
			return { frequency, duration, rampDuration, rampType: rampType || 0, carrierFreq: stepCarrier };
		})
		.filter(step => Number.isFinite(step.frequency) && Number.isFinite(step.duration));

	const length = sequence.reduce(
		(acc, { duration, rampDuration = 0 }) => acc + duration + rampDuration,
		0
	);

	return { sequence, length };
}

// --------- Sequence Validation ---------
// Every step after the first must have a ramp duration > 0. The scheduler only
// applies a step's frequency through its ramp (or an explicit carrier change),
// so a non-initial step without one would silently keep playing the PREVIOUS
// step's frequency for its whole duration. The first step needs no ramp — its
// frequency is set when the oscillators are created.
function validateSequenceSteps(sequence) {
	const errors = [];
	sequence.forEach((step, i) => {
		if (i === 0) return;
		if (!(Number.isFinite(step.rampDuration) && step.rampDuration > 0)) {
			errors.push(`Step ${i + 1} (${step.frequency} Hz): missing ramp duration — every step after the first needs one (frequency,duration,rampDuration[,rampType[,carrier]])`);
		}
	});
	return errors;
}

// --------- Audio File Decoding ---------
async function decodeAudioFile(file) {
	try {
		const arrayBuf = await file.arrayBuffer();
		const webAudioContext = new (window.AudioContext || window.webkitAudioContext)();
		const decodedBuffer = await webAudioContext.decodeAudioData(arrayBuf.slice(0));
		return decodedBuffer;
	} catch (e) {
		console.error("Error decoding audio data:", e);
		throw new Error("Failed to decode audio file");
	}
}

// --------- WAV Export Functions ---------
function audioBufferToWav(audioBuffer) {
	const numCh = audioBuffer.numberOfChannels;
	const sampleRate = audioBuffer.sampleRate;
	const numFrames = audioBuffer.length;
	const bytesPerSample = 2;
	const dataBytes = numFrames * numCh * bytesPerSample;
	const buffer = new ArrayBuffer(44 + dataBytes);
	const view = new DataView(buffer);

	// RIFF
	writeString(view, 0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	writeString(view, 8, "WAVE");
	// fmt
	writeString(view, 12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, numCh, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * numCh * bytesPerSample, true);
	view.setUint16(32, numCh * bytesPerSample, true);
	view.setUint16(34, 16, true);
	// data
	writeString(view, 36, "data");
	view.setUint32(40, dataBytes, true);

	const channels = [];
	for (let ch = 0; ch < numCh; ch++) channels.push(audioBuffer.getChannelData(ch));

	let offset = 44;
	for (let i = 0; i < numFrames; i++) {
		for (let ch = 0; ch < numCh; ch++) {
			let sample = Math.max(-1, Math.min(1, channels[ch][i]));
			sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
			view.setInt16(offset, sample | 0, true);
			offset += 2;
		}
	}
	return buffer;
}

function writeString(view, offset, str) {
	for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

// --------- Background Helpers ---------

// Equivalent rectangular bandwidth (Glasberg & Moore) of the auditory filter at
// frequency f. Everything "in-band" in this file means "inside one ERB".
function erbWidth(f) {
	return 24.7 * (4.37 * f / 1000 + 1);
}

// Render the built-in noise (white/pink/brown) into a plain AudioBuffer so it can
// go through exactly the same background chain as a custom music file
// (normalisation -> limiter -> carrier dip -> mix). Previously the noise lived
// inside the tone render at a fixed gain, which left it far quieter than music.
async function renderNoiseBackground(noiseType, useNoiseModulation, durationSec, numChannels, sampleRate) {
	const rendered = await Tone.Offline(() => {
		const out = new Tone.Gain(1).toDestination();
		let filter = null;
		if (useNoiseModulation) {
			// Audible lowpass sweep 200 Hz -> 1212 Hz and back, one full cycle every 16 s.
			// This is the modulation the shipped sessions have always had: Tone.AutoFilter
			// silently ignored the min/max/Q options it used to be given and swept its
			// defaults (200 Hz, 2.6 octaves) at "8m" = 8 measures = 16 s. Those values are
			// now set explicitly so the behaviour is deliberate and stable. (A 2–15 kHz
			// sweep over 8 minutes was tried and is inaudible as modulation.)
			filter = new Tone.AutoFilter({
				frequency: 1 / noiseSweepPeriod,
				baseFrequency: noiseSweepLowHz,
				octaves: Math.log2(noiseSweepHighHz / noiseSweepLowHz),
				filter: { type: "lowpass", rolloff: -12, Q: 1 }
			}).connect(out);
			filter.start(0);
		}
		const noise = new Tone.Noise(noiseType.toLowerCase()).connect(filter || out);
		noise.start(0);
	}, durationSec, numChannels, sampleRate || Tone.getContext().sampleRate);
	return rendered;
}

// Loop / resample the (already normalised) background into a session-length
// track with the same sample rate and channel count as the tone render.
function buildBackgroundTrack(source, outSampleRate, outLength, outChannels) {
	const ctx = new OfflineAudioContext(outChannels, outLength, outSampleRate);
	const track = ctx.createBuffer(outChannels, outLength, outSampleRate);
	const musicSR = source.sampleRate;
	const musicLen = source.length;
	const musicChannels = source.numberOfChannels;
	for (let ch = 0; ch < outChannels; ch++) {
		const src = source.getChannelData(ch < musicChannels ? ch : 0); // mono -> both channels
		const dst = track.getChannelData(ch);
		for (let i = 0; i < outLength; i++) {
			// Linear interpolation handles sample-rate conversion; modulo wraps the loop
			const pos = (i * musicSR / outSampleRate) % musicLen;
			const idx0 = Math.floor(pos);
			const idx1 = (idx0 + 1) % musicLen;
			const frac = pos - idx0;
			dst[i] = src[idx0] * (1 - frac) + src[idx1] * frac;
		}
	}
	return track;
}

// Carrier-tracking dip: a peaking-EQ cut of `dipDb`, one ERB wide, centred on the
// isochronic carrier and automated with the SAME ramps the carrier follows
// through the session. It carves the tone's own band out of the background so
// the tone is never masked and sustained notes near the carrier cannot beat
// against it. `offsets` adds further dips at carrier+offset (used for the
// separated binaural base carrier).
async function applyCarrierDip(track, sequence, startingCarrier, dipDb, offsets) {
	const ctx = new OfflineAudioContext(track.numberOfChannels, track.length, track.sampleRate);
	const source = ctx.createBufferSource();
	source.buffer = track;
	const centres = [0].concat(offsets || []);
	let node = source;
	const filters = centres.map(off => {
		const f = ctx.createBiquadFilter();
		f.type = "peaking";
		f.gain.value = -Math.abs(dipDb);
		node.connect(f);
		node = f;
		return { f, off };
	});
	node.connect(ctx.destination);

	const qFor = c => c / erbWidth(c);
	const setAt = (t, c) => filters.forEach(({ f, off }) => {
		f.frequency.setValueAtTime(c + off, t);
		f.Q.setValueAtTime(qFor(c + off), t);
	});
	const rampTo = (t0, from, to, dur, exponential) => filters.forEach(({ f, off }) => {
		const fn = exponential ? "exponentialRampToValueAtTime" : "linearRampToValueAtTime";
		f.frequency.setValueAtTime(from + off, t0);
		f.Q.setValueAtTime(qFor(from + off), t0);
		f.frequency[fn](to + off, t0 + dur);
		f.Q[fn](qFor(to + off), t0 + dur);
	});

	setAt(0, startingCarrier);
	let t = 0;
	let current = startingCarrier;
	sequence.forEach(step => {
		if (step.carrierFreq && step.carrierFreq !== current) {
			if (step.rampDuration) {
				rampTo(t, current, step.carrierFreq, step.rampDuration, step.rampType === 1);
			} else {
				setAt(t, step.carrierFreq);
			}
			current = step.carrierFreq;
		}
		t += step.duration + (step.rampDuration || 0);
	});

	source.start(0);
	return await ctx.startRendering();
}

// Smooth soft clipper: identity below the knee, then a tanh curve that approaches the
// ceiling asymptotically (C¹-continuous at the knee). Only the samples above the knee
// are touched, so — unlike a limiter — nothing around a transient is modulated.
function softClipBuffer(buffer, knee, ceiling) {
	const range = ceiling - knee;
	let clipped = 0, total = 0, maxIn = 0;
	for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
		const d = buffer.getChannelData(ch);
		for (let i = 0; i < d.length; i++) {
			const a = Math.abs(d[i]);
			if (a > maxIn) maxIn = a;
			if (a > knee) {
				clipped++;
				const y = knee + range * Math.tanh((a - knee) / range);
				d[i] = d[i] < 0 ? -y : y;
			}
			total++;
		}
	}
	return { clippedPct: 100 * clipped / Math.max(total, 1), maxIn };
}

// Spectral flatness (Wiener entropy) of a buffer over 300–8000 Hz, 0..1: white noise ≈ 1,
// rain ≈ 0.5, fire ≈ 0.3, surf ≈ 0.2, music ≈ 0.00–0.13 (the band starts at 300 Hz so a
// recording's low rumble cannot mask a broadband crackle). Used to pick the transient treatment: noise-like
// backgrounds are soft-clipped (their transients are noise bursts, clipping is inaudible
// and never pumps), musical ones go through the limiter (clipping a plucked or struck
// note's attack is audible as a click).
function spectralFlatness(buffer) {
	const n = 4096, sr = buffer.sampleRate, ch0 = buffer.getChannelData(0);
	const frames = 24, hop = Math.max(n, Math.floor((buffer.length - n) / frames));
	const re = new Float64Array(n), im = new Float64Array(n);
	const kLo = Math.max(1, Math.round(300 / sr * n)), kHi = Math.min(n / 2, Math.round(8000 / sr * n));
	const vals = [];
	for (let f = 0; f < frames; f++) {
		const s0 = f * hop;
		if (s0 + n > buffer.length) break;
		let energy = 0;
		for (let i = 0; i < n; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); re[i] = ch0[s0 + i] * w; im[i] = 0; energy += re[i] * re[i]; }
		if (energy < 1e-6) continue; // skip silence
		fftInPlace(re, im);
		let logSum = 0, linSum = 0, cnt = 0;
		for (let k = kLo; k < kHi; k++) { const pw = re[k] * re[k] + im[k] * im[k] + 1e-12; logSum += Math.log(pw); linSum += pw; cnt++; }
		vals.push(Math.exp(logSum / cnt) / (linSum / cnt));
	}
	if (!vals.length) return 0;
	vals.sort((a, b) => a - b);
	return vals[vals.length >> 1];
}

function fftInPlace(re, im) {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
	}
	for (let len = 2; len <= n; len <<= 1) {
		const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
		for (let i = 0; i < n; i += len) {
			let cr = 1, ci = 0;
			for (let k = 0; k < half; k++) {
				const a = i + k, b = a + half;
				const vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
				re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
				const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
			}
		}
	}
}

// p-th quantile of |x| over all channels (sub-sampled every 4th sample; plenty for a
// level decision and keeps the sort cheap on an 11-minute stereo track).
function percentileAbs(buffer, p) {
	const step = 4;
	let n = 0;
	for (let ch = 0; ch < buffer.numberOfChannels; ch++) n += Math.floor(buffer.length / step);
	const a = new Float32Array(n);
	let k = 0;
	for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
		const d = buffer.getChannelData(ch);
		for (let i = 0; i < buffer.length; i += step) a[k++] = Math.abs(d[i]);
	}
	a.sort();
	return a[Math.min(a.length - 1, Math.floor(p * a.length))];
}

// RMS of the isochronic pulse envelope (0.5(1+sin))^p, used for level reporting
function punchEnvelopeRms(p) {
	let s = 0; const n = 4096;
	for (let i = 0; i < n; i++) { const e = Math.pow(0.5 * (1 + Math.sin(2 * Math.PI * i / n)), p); s += e * e; }
	return Math.sqrt(s / n);
}

// --------- Core Audio Generation Function ---------
async function generateAudio(options) {
	const {
		sequence,
		length,
		noiseType = 'brown',
		mainVolume = 0.7,
		useNoiseModulation = false,
		useNoiseFade = false,
		alwaysMono = false,
		decodedNoiseBuffer = null,
		customNoiseVolume = null,
		useBinaural = false,
		binauralVolume: binauralVolumeBase = 0.16,
		binauralCarrierOffset = 0,
		isochronicVolume: isochronicVolumeBase = 0.35,
		isochronicPunch = 1,
		muteIsochronic = false,
		carrierDipDb = defaultCarrierDipDb,
		outputSampleRate = null
	} = options;

	// Output sample rate: defaults to the browser's audio context rate (44.1 kHz on
	// most machines, 48 kHz on some). Pass explicitly for reproducible batch output.
	const outSampleRate = Number.isFinite(outputSampleRate) && outputSampleRate > 0 ? outputSampleRate : Tone.getContext().sampleRate;

	// Isochronic "punch": exponent applied to the 0..1 pulse envelope.
	// 1 = original soft sine throb; >1 narrows each pulse and opens a silence gap
	// for a tighter, more percussive feel. Guard against bad/absent values.
	const punchExponent = Number.isFinite(isochronicPunch) && isochronicPunch >= 1 ? isochronicPunch : 1;

	// Binaural carrier separation: offset (Hz) placing the binaural pair on its OWN
	// base carrier = isochronic carrier + offset, instead of sharing it (C ± f/2).
	// 0 = coupled (original). A large offset (e.g. 200 Hz) moves the within-ear
	// difference between the isochronic carrier and the binaural carrier out of the
	// entrainment range, eliminating the f/2 monaural beat, while keeping the
	// binaural pair continuous (Δf = f preserved) and independently controllable.
	// The offset tracks the carrier descent, so separation never collapses.
	const binOffset = Number.isFinite(binauralCarrierOffset) && binauralCarrierOffset > 0 ? binauralCarrierOffset : 0;
	const binBase = (carrier) => carrier + binOffset;

	// Carrier dip depth (dB) carved out of the background around the carrier. 0 = off.
	const dipDb = Number.isFinite(carrierDipDb) && carrierDipDb > 0 ? carrierDipDb : 0;

	const durationSec = Math.max(0.01, Number(length) || 0);
	if (!sequence.length) throw new Error("Sequence is empty or invalid.");
	const stepErrors = validateSequenceSteps(sequence);
	if (stepErrors.length) {
		throw new Error("Invalid sequence:\n" + stepErrors.join("\n"));
	}

	// Derive starting carrier from first step's carrier field
	const startingCarrier = sequence[0].carrierFreq || 174;

	let isochronicVolume = isochronicVolumeBase;
	let binauralVolume = binauralVolumeBase;

	// Equal-loudness compensation (Fletcher-Munson): lower carriers sound quieter to
	// human ears, so tone-layer gains are boosted up to 30% for carriers below 400 Hz.
	// Applied DYNAMICALLY — the gains follow the carrier as it descends through the
	// session, so a session starting at 852 Hz still gets compensated once its carrier
	// reaches 285/174. Applies to both isochronic and binaural (whose carriers C ± f/2
	// sit in the same low range and would otherwise be masked by the background).
	const equalLoudnessBoost = (carrier) => carrier < 400 ? 1 + 0.30 * (1 - carrier / 400) : 1;

	// Choose channel count dynamically
	const numChannels = alwaysMono ? 1 : (useBinaural ? 2 : (decodedNoiseBuffer && decodedNoiseBuffer.numberOfChannels > 1 ? 2 : 1));

	// Session details log
	const isCustomMusic = !!decodedNoiseBuffer;
	const backgroundType = isCustomMusic ? 'custom music' : `${noiseType} noise${useNoiseModulation ? ` (lowpass sweep ${noiseSweepLowHz}–${noiseSweepHighHz} Hz, ${noiseSweepPeriod} s cycle)` : ''}`;
	console.log(`--- Session config ---`);
	console.log(`  Background: ${backgroundType}`);
	console.log(`  Starting carrier: ${startingCarrier}Hz | Isochronic: ${muteIsochronic ? 'muted' : isochronicVolume} (carrier-tracked equal-loudness ×1.0–1.3, punch ^${punchExponent})`);
	console.log(`  Binaural: ${useBinaural ? `on (${binauralVolume}, carrier-tracked${binOffset ? `, +${binOffset}Hz separated` : ', coupled C±f/2'})` : 'off'} | Main volume: ${mainVolume}`);
	console.log(`  Carrier dip: ${dipDb ? `-${dipDb} dB, one ERB wide, tracking the carrier${useBinaural && binOffset ? ` (+ second dip at carrier+${binOffset}Hz)` : ''}` : 'off'}`);
	console.log(`  Duration: ${(durationSec / 60).toFixed(1)}min`);

	// --------- Background: custom music OR built-in noise, same chain ---------
	// The background is prepared at unity gain here; its LEVEL is set later, after the
	// carrier dip has been applied to the session-length track, so that the target
	// is the level the listener actually hears (post-dip, post-clipping) and every
	// session lands at the same background loudness regardless of crest factor or
	// how much of the file's energy sat inside the carrier band.
	const backgroundSource = isCustomMusic
		? decodedNoiseBuffer
		: await renderNoiseBackground(noiseType, useNoiseModulation, durationSec, numChannels, outSampleRate);

	const targetVolume = customNoiseVolume !== null ? customNoiseVolume : defaultBackgroundVolume;
	const musicRms = getRms(backgroundSource);
	const musicPeak = getMaxVolume(backgroundSource);
	const active = getActiveRms(backgroundSource);
	console.log(`  Background source: RMS=${musicRms.toFixed(4)}, active RMS=${active.rms.toFixed(4)} (${active.activePct.toFixed(1)}% active), peak=${musicPeak.toFixed(4)}, crest ${(20 * Math.log10(musicPeak / Math.max(musicRms, 1e-6))).toFixed(1)} dB`);

	// Boost isochronic volume for loudly mastered custom music so tones don't get
	// buried. Gradual ramp: 0% boost at source activeRms=0.10, up to 30% at ≥0.20.
	// (Custom music only, as before; the carrier dip now does most of this work.)
	if (isCustomMusic && active.rms > 0.10) {
		const boostFactor = 1 + 0.30 * Math.min((active.rms - 0.10) / 0.10, 1);
		isochronicVolume *= boostFactor;
		console.log(`  Isochronic boost: ${((boostFactor - 1) * 100).toFixed(0)}% → volume ${isochronicVolume.toFixed(4)} (source active RMS ${active.rms.toFixed(4)})`);
	}

	// Unity-gain copy with fades baked into the buffer boundaries for click-free looping
	const bgCtx = new OfflineAudioContext(backgroundSource.numberOfChannels, backgroundSource.length, backgroundSource.sampleRate);
	const scaledNoiseBuffer = bgCtx.createBuffer(backgroundSource.numberOfChannels, backgroundSource.length, backgroundSource.sampleRate);
	const loopFadeSamples = Math.round(noiseFade * backgroundSource.sampleRate);
	for (let ch = 0; ch < backgroundSource.numberOfChannels; ch++) {
		const src = backgroundSource.getChannelData(ch);
		const dst = scaledNoiseBuffer.getChannelData(ch);
		dst.set(src);
		const len = dst.length;
		for (let i = 0; i < loopFadeSamples && i < len; i++) {
			const gain = i / loopFadeSamples;
			dst[i] *= gain;              // fade in at start
			dst[len - 1 - i] *= gain;    // fade out at end
		}
	}

	// SI-DO binaural emphasis: at each band crossing (a lift step followed by an
	// exponential ramp landing on an octave DO boundary), the binaural layer is
	// temporarily boosted — the "reconciling force" carries the process across the
	// interval where listeners tend to snap back to alertness. Detected from the
	// sequence itself; envelope timing derives entirely from the steps' durations.
	// The boost is a multiplicative factor on the carrier-tracked base level, capped
	// so emphasized binaural stays at least ~4 dB below the isochronic peak — the
	// layer hierarchy (isochronic dominant) can never invert. Since both layers get
	// the same equal-loudness boost, the ratio guard holds at every carrier.
	const OCTAVE_DO_BOUNDARIES = [16, 8, 4, 2];
	const binauralEmphasisFactor = Math.min(1.4, (0.65 * isochronicVolume) / binauralVolume);
	const sidoWindows = [];
	if (useBinaural) {
		const fadeOutStartSec = Math.max(0, durationSec - (fadeOut + finalBuffer));
		let stepStart = sequence[0].duration + (sequence[0].rampDuration || 0);
		for (let i = 1; i < sequence.length - 1; i++) {
			const prev = sequence[i - 1];
			const lift = sequence[i];
			const next = sequence[i + 1];
			const isShockLift = lift.frequency > prev.frequency;
			const landsOnDo = next.rampType === 1 &&
				next.frequency < lift.frequency &&
				OCTAVE_DO_BOUNDARIES.some(d => Math.abs(next.frequency - d) < 0.01);
			if (isShockLift && landsOnDo) {
				const riseStart = stepStart;
				const riseEnd = riseStart + (lift.rampDuration || 0) + lift.duration;
				const peakEnd = riseEnd + (next.rampDuration || 0);
				const decayEnd = peakEnd + Math.min(next.duration / 2, 20);
				// Skip crossings that would collide with the session fade envelope
				if (riseStart > fadeIn && decayEnd < fadeOutStartSec) {
					sidoWindows.push({ riseStart, riseEnd, peakEnd, decayEnd });
				}
			}
			stepStart += lift.duration + (lift.rampDuration || 0);
		}
		if (sidoWindows.length) {
			const at = sidoWindows.map(w => `${w.riseStart.toFixed(0)}-${w.decayEnd.toFixed(0)}s`).join(', ');
			console.log(`  SI-DO emphasis: ${sidoWindows.length} crossing(s) [${at}] → binaural ×${binauralEmphasisFactor.toFixed(2)}`);
		}
	}

	// Tone.js renders ONLY the isochronic tones and binaural beats. The background
	// (music or noise) is mixed in afterward with plain sample math.
	const rendered = await Tone.Offline(({ transport }) => {
		// Carrier gated by LFO (0..1) -> carrier-tracked level gain -> master
		const initialCarrier = startingCarrier;
		const oscGate = new Tone.Gain(0);
		const isoLevel = new Tone.Gain(isochronicVolume * equalLoudnessBoost(initialCarrier));
		const osc = new Tone.Oscillator(initialCarrier, "sine").connect(oscGate);
		oscGate.connect(isoLevel);

		const firstFreq = sequence[0].frequency;
		const lfo = new Tone.LFO({ frequency: firstFreq, min: 0, max: 1, type: "sine" });
		if (punchExponent === 1) {
			lfo.connect(oscGate.gain);
		} else {
			// Sharpen the pulse: raise the 0..1 envelope to a power. Peak stays at 1
			// (no clipping); stays C¹-continuous so no clicks / spectral splatter.
			const punchShaper = new Tone.WaveShaper((x) => (x <= 0 ? 0 : Math.pow(x, punchExponent)), 2048);
			lfo.connect(punchShaper);
			punchShaper.connect(oscGate.gain);
		}

		// Binaural layer: fade/emphasis gain (0..1..emphasisFactor) -> carrier-tracked level gain
		let binauralL, binauralR, panL, panR, binauralGain, binauralLevel;
		if (useBinaural && numChannels === 2) {
			const firstBeatFreq = sequence[0].frequency;
			// Symmetric carriers around the binaural base Cb: L = Cb - f/2, R = Cb + f/2.
			// Cb = isochronic carrier + binOffset. With binOffset=0 this is the original
			// coupled routing; with a separation offset, Cb sits out of band from the
			// isochronic carrier so the f/2 monaural beat disappears. Δf = f either way.
			const firstBinBase = binBase(initialCarrier);
			binauralL = new Tone.Oscillator(firstBinBase - firstBeatFreq / 2, "sine");
			binauralR = new Tone.Oscillator(firstBinBase + firstBeatFreq / 2, "sine");
			panL = new Tone.Panner(-1);
			panR = new Tone.Panner(1);
			binauralGain = new Tone.Gain(0);
			binauralLevel = new Tone.Gain(binauralVolume * equalLoudnessBoost(firstBinBase));
			binauralL.connect(panL);
			binauralR.connect(panR);
			panL.connect(binauralGain);
			panR.connect(binauralGain);
			binauralGain.connect(binauralLevel);
			binauralL.start(0);
			binauralR.start(0);
		}

		// Master out
		const master = new Tone.Gain(0).toDestination();
		if (!muteIsochronic) {
			isoLevel.connect(master);
		}

		if (binauralLevel) {
			binauralLevel.connect(master);
		}

		osc.start(0);
		lfo.start(0);

		// Schedule frequency ramps
		let currentTime = 0;
		let currentCarrier = initialCarrier;
		sequence.forEach(step => {
			if (step.rampDuration) {
				const stepCarrier = step.carrierFreq || currentCarrier;
				transport.schedule((time) => {
					const rampFn = step.rampType === 1 ? 'exponentialRampTo' : 'linearRampTo';
					lfo.frequency[rampFn](step.frequency, step.rampDuration, time);
					if (step.carrierFreq) {
						osc.frequency[rampFn](step.carrierFreq, step.rampDuration, time);
						// Equal-loudness gains track the carrier descent (binaural uses
						// its own base carrier, which may be offset out of band).
						isoLevel.gain[rampFn](isochronicVolume * equalLoudnessBoost(step.carrierFreq), step.rampDuration, time);
						if (binauralLevel) {
							binauralLevel.gain[rampFn](binauralVolume * equalLoudnessBoost(binBase(step.carrierFreq)), step.rampDuration, time);
						}
					}
					if (binauralR) {
						// Ramp both sides symmetrically around the binaural base (Cb ± f/2)
						// every step — the beat f changes per-step even when Cb does not.
						binauralL.frequency[rampFn](binBase(stepCarrier) - step.frequency / 2, step.rampDuration, time);
						binauralR.frequency[rampFn](binBase(stepCarrier) + step.frequency / 2, step.rampDuration, time);
					}
				}, currentTime);
			} else if (step.carrierFreq) {
				// No ramp but carrier changes — set immediately
				transport.schedule((time) => {
					lfo.frequency.setValueAtTime(step.frequency, time);
					osc.frequency.setValueAtTime(step.carrierFreq, time);
					isoLevel.gain.setValueAtTime(isochronicVolume * equalLoudnessBoost(step.carrierFreq), time);
					if (binauralLevel) {
						binauralLevel.gain.setValueAtTime(binauralVolume * equalLoudnessBoost(binBase(step.carrierFreq)), time);
					}
					if (binauralL) {
						binauralL.frequency.setValueAtTime(binBase(step.carrierFreq) - step.frequency / 2, time);
					}
					if (binauralR) {
						binauralR.frequency.setValueAtTime(binBase(step.carrierFreq) + step.frequency / 2, time);
					}
				}, currentTime);
			}
			if (step.carrierFreq) {
				currentCarrier = step.carrierFreq;
			}
			currentTime += step.duration + (step.rampDuration || 0);
		});

		// Fades & headroom
		const headroom = Math.min(mainVolume, 0.89);
		master.gain.setValueAtTime(0, 0);
		master.gain.linearRampToValueAtTime(headroom, Math.min(fadeIn, durationSec));
		const fadeOutStart = Math.max(0, durationSec - Math.max(0, fadeOut + finalBuffer));
		master.gain.setValueAtTime(headroom, fadeOutStart);
		master.gain.linearRampToValueAtTime(0, Math.min(durationSec, fadeOutStart + fadeOut));

		if (binauralGain) {
			// binauralGain is normalized (0..1): session fades and SI-DO emphasis factor.
			// The absolute level lives in binauralLevel (carrier-tracked equal-loudness).
			binauralGain.gain.setValueAtTime(0, 0);
			binauralGain.gain.linearRampToValueAtTime(1, Math.min(fadeIn, durationSec));
			binauralGain.gain.setValueAtTime(1, fadeOutStart);
			binauralGain.gain.linearRampToValueAtTime(0, Math.min(durationSec, fadeOutStart + fadeOut));

			// SI-DO emphasis envelopes: rise across the lift step, hold through the
			// exponential ramp, decay into the DO hold. Windows are pre-filtered to
			// never overlap the fade-in/fade-out automation above.
			sidoWindows.forEach(w => {
				binauralGain.gain.setValueAtTime(1, w.riseStart);
				binauralGain.gain.linearRampToValueAtTime(binauralEmphasisFactor, w.riseEnd);
				binauralGain.gain.setValueAtTime(binauralEmphasisFactor, w.peakEnd);
				binauralGain.gain.linearRampToValueAtTime(1, w.decayEnd);
			});
		}

		transport.start(0);
	}, durationSec, alwaysMono ? 1 : numChannels, outSampleRate);

	// --------- Level, dynamics and mix of the background ---------
	{
		const headroom = Math.min(mainVolume, 0.89);
		const fadeInEnd = Math.min(fadeIn, durationSec);
		const fadeOutStart = Math.max(0, durationSec - Math.max(0, fadeOut + finalBuffer));
		const fadeOutEnd = Math.min(durationSec, fadeOutStart + fadeOut);
		const outSR = rendered.sampleRate;

		// 1. Session-length background track (looped + resampled to the output format), unity gain
		let track = buildBackgroundTrack(scaledNoiseBuffer, outSR, rendered.length, rendered.numberOfChannels);

		// 2. Carrier-tracking dip (and a second dip on the separated binaural base)
		if (dipDb) {
			const offsets = (useBinaural && numChannels === 2 && binOffset) ? [binOffset] : [];
			track = await applyCarrierDip(track, sequence, startingCarrier, dipDb, offsets);
		}

		// 3. Level: normalise the DIPPED track so its active RMS hits the target. The
		//    transient treatment depends on what the background is:
		//    - noise-like (rain, surf, fire, wind, built-in noise): soft clipper. Its
		//      transients are noise bursts, so rounding them off is inaudible, and a
		//      clipper never modulates the surrounding signal (a limiter with a 50 ms
		//      release turned every raindrop into a 60 ms hole in the gain — amplitude
		//      modulation at 5–20 Hz).
		//    - musical: true-peak limiter with a program-dependent release (fast after a
		//      short peak such as a plucked note, slow after a sustained one), because
		//      clipping the attack of a note is audible as a click.
		//    Two passes converge on the target because both treatments remove energy.
		const unity = [];
		for (let ch = 0; ch < track.numberOfChannels; ch++) unity.push(Float32Array.from(track.getChannelData(ch)));
		// Built-in noise is noise-like by definition (its sweep and spectral tilt would fool
		// the flatness measure); custom files are classified by spectral flatness.
		const flatness = isCustomMusic ? spectralFlatness(track) : 1;
		const noiseLike = !isCustomMusic || flatness >= noiseLikeFlatness;
		console.log(`  Background character: ${isCustomMusic ? `spectral flatness ${flatness.toFixed(3)} → ` : 'built-in noise → '}${noiseLike ? 'noise-like, transients soft-clipped' : 'musical, transients limited'}`);
		const dipActive = getActiveRms(track);
		// Musical material: the limiter must stay a transient tool, so the 99.9th percentile
		// of |x| may exceed the ceiling by at most maxPeakOvershootDb before limiting (the max
		// would let a single spike decide the level of the whole session). A track with a
		// very high crest factor therefore lands somewhat below the target instead of being
		// crushed, and the console says by how much.
		const dipPeak = noiseLike ? getMaxVolume(track) : percentileAbs(track, 0.999);
		const overshootCap = noiseLike ? Infinity : (peakCeiling * Math.pow(10, maxPeakOvershootDb / 20)) / Math.max(dipPeak, 1e-6);
		const wanted = targetVolume / Math.max(dipActive.rms, 1e-6);
		let scale = Math.min(wanted, maxNormalisationScale, overshootCap);
		if (wanted > maxNormalisationScale) {
			console.log(`  Normalisation scale ${wanted.toFixed(1)}x capped to ${maxNormalisationScale}x (extremely quiet source)`);
		}
		if (scale === overshootCap && overshootCap < wanted) {
			console.log(`  Normalisation scale ${wanted.toFixed(2)}x capped to ${overshootCap.toFixed(2)}x so the loudest 0.1% of samples exceed the ceiling by ≤ ${maxPeakOvershootDb} dB (crest factor at p99.9: ${(20 * Math.log10(dipPeak / Math.max(dipActive.rms, 1e-6))).toFixed(1)} dB) — background will sit ${(20 * Math.log10(overshootCap / wanted)).toFixed(1)} dB below the target`);
		}
		for (let pass = 0; pass < 2; pass++) {
			for (let ch = 0; ch < track.numberOfChannels; ch++) {
				const dst = track.getChannelData(ch), src = unity[ch];
				for (let i = 0; i < dst.length; i++) dst[i] = src[i] * scale;
			}
			let treat;
			if (noiseLike) {
				const c = softClipBuffer(track, softClipKnee, peakCeiling);
				treat = `soft clip on ${c.clippedPct.toFixed(2)}% of samples, max input ${c.maxIn.toFixed(2)}`;
			} else {
				const st = truePeakLimiter(track, peakCeiling, 0.02);
				treat = `limiter on ${st.reducedPct.toFixed(2)}% of samples, mean ${st.meanReductionDb.toFixed(1)} dB, max ${st.maxReductionDb.toFixed(1)} dB`;
			}
			const got = getActiveRms(track).rms;
			const errDb = 20 * Math.log10(got / targetVolume);
			console.log(`  Level pass ${pass + 1}: x${scale.toFixed(3)} → active RMS ${got.toFixed(4)} (${errDb >= 0 ? '+' : ''}${errDb.toFixed(2)} dB from target ${targetVolume}); ${treat}`);
			if (Math.abs(errDb) < 0.3 || pass === 1) break;
			scale = Math.min(scale * targetVolume / Math.max(got, 1e-6), maxNormalisationScale, overshootCap);
		}

		// 4. Safety: nothing above may exceed the ceiling, but check anyway
		const prePeak = getMaxVolume(track);
		if (prePeak > peakCeiling + 0.01) {
			const st = truePeakLimiter(track, peakCeiling, 0.02);
			console.log(`  Safety limiter: peak ${prePeak.toFixed(3)} → reduced on ${st.reducedPct.toFixed(1)}% of samples, max ${st.maxReductionDb.toFixed(1)} dB`);
		}
		const finalRms = getRms(track), finalActive = getActiveRms(track).rms;
		const toneRms = isochronicVolume * punchEnvelopeRms(punchExponent) * Math.SQRT1_2;
		console.log(`  Background final: RMS=${finalRms.toFixed(4)}, active RMS=${finalActive.toFixed(4)}, peak=${getMaxVolume(track).toFixed(3)} | isochronic tone RMS ${toneRms.toFixed(4)} → tone is ${(20 * Math.log10(toneRms / Math.max(finalActive, 1e-6))).toFixed(1)} dB relative to the background`);

		// 5. Add with the master fade envelope (same shape as the Tone.js master gain)
		for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
			const outData = rendered.getChannelData(ch);
			const bg = track.getChannelData(ch);
			for (let i = 0; i < rendered.length; i++) {
				const t = i / outSR;
				let masterGain;
				if (t < fadeInEnd) {
					masterGain = headroom * (t / fadeInEnd);
				} else if (t >= fadeOutStart && t < fadeOutEnd) {
					masterGain = headroom * (1 - (t - fadeOutStart) / (fadeOutEnd - fadeOutStart));
				} else if (t >= fadeOutEnd) {
					masterGain = 0;
				} else {
					masterGain = headroom;
				}
				outData[i] += bg[i] * masterGain;
			}
		}
		console.log(`  Background mixed directly${dipDb ? ' after carrier dip' : ''} (bypassed Tone.js Player)`);
	}

	// Post-render: normalize to 0.95 peak if clipping
	const peak = getMaxVolume(rendered, true);
	if (peak > 1.0) {
		const scale = 0.95 / peak;
		console.log(`  Output peak ${peak.toFixed(4)} exceeds 1.0, scaling down by ${scale.toFixed(4)}`);
		for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
			const data = rendered.getChannelData(ch);
			for (let i = 0; i < data.length; i++) {
				data[i] *= scale;
			}
		}
	} else {
		console.log(`  Output peak ${peak.toFixed(4)}, no scaling needed`);
	}

	return rendered;
}

// --------- Download Function ---------
function downloadWav(buffer, fileName) {
	const wav = audioBufferToWav(buffer);
	const blob = new Blob([wav], { type: "audio/wav" });
	const url = URL.createObjectURL(blob);

	const a = document.createElement("a");
	a.href = url;
	a.download = fileName;
	a.click();

	// Clean up the URL after a short delay
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --------- Audio Analysis Functions ---------

// True peak limiter: computes gain from ACTUAL sample levels (not smoothed envelope),
// so no peak can escape. Uses sliding window minimum for look-ahead and
// attack/release smoothing to avoid clicks.
// ceiling: maximum allowed amplitude (e.g., 0.85)
// lookAheadSec: look-ahead window (10ms — must be longer than attack for clean limiting)
function truePeakLimiter(audioBuffer, ceiling, lookAheadSec) {
	const sampleRate = audioBuffer.sampleRate;
	const numChannels = audioBuffer.numberOfChannels;
	const length = audioBuffer.length;
	const lookAheadSamples = Math.max(1, Math.round(lookAheadSec * sampleRate));
	// Timing is deliberately gentle: an abrupt gain move on a ringing transient (a water
	// drop, a struck key) is itself audible as a crack. With 6 ms attack over 20 ms of
	// look-ahead and 60/150 ms release the gain never moves faster than ~0.8 dB/ms
	// (it was up to 3 dB/ms with 1.5 ms / 15 ms), at the cost of ~5% more samples
	// under mild reduction.
	const attackCoeff = Math.exp(-1 / (0.006 * sampleRate));        // 6 ms attack
	// Program-dependent release: a short over (a plucked note, a drum hit, a raindrop)
	// is released faster so the gain does not leave a long hole behind it; a sustained
	// over is released slowly so the gain does not ripple with the waveform.
	const fastReleaseCoeff = Math.exp(-1 / (0.06 * sampleRate));    // 60 ms
	const slowReleaseCoeff = Math.exp(-1 / (0.15 * sampleRate));    // 150 ms
	const shortRunSamples = Math.round(0.02 * sampleRate);          // an over-run ≤ 20 ms counts as short
	const runGapSamples = Math.round(0.025 * sampleRate);           // overs closer than this belong to the same run

	// Pass 1: compute instantaneous gain needed at each sample
	const gainNeeded = new Float32Array(length);
	for (let i = 0; i < length; i++) {
		let maxAbs = 0;
		for (let ch = 0; ch < numChannels; ch++) {
			const abs = Math.abs(audioBuffer.getChannelData(ch)[i]);
			if (abs > maxAbs) maxAbs = abs;
		}
		gainNeeded[i] = maxAbs > ceiling ? ceiling / maxAbs : 1.0;
	}

	// Pass 2: sliding window minimum (look-ahead) using monotonic deque, O(n)
	// For each sample i, find the minimum gain in [i, i+lookAheadSamples)
	const lookaheadGain = new Float32Array(length);
	const deque = []; // indices with monotonically increasing gain values
	let dqStart = 0;
	for (let i = length - 1; i >= 0; i--) {
		// Remove indices outside window
		while (dqStart < deque.length && deque[dqStart] >= i + lookAheadSamples) {
			dqStart++;
		}
		// Remove from back any indices with gain >= current
		while (deque.length > dqStart && gainNeeded[deque[deque.length - 1]] >= gainNeeded[i]) {
			deque.pop();
		}
		deque.push(i);
		lookaheadGain[i] = gainNeeded[deque[dqStart]];
	}

	// Pass 3: smooth the gain curve with attack AND release to avoid clicks.
	// Attack smoothing prevents the hard edge at the look-ahead boundary
	// (without this, gain drops from 1.0 to 0.2 in one sample = click). The release
	// speed depends on how long the signal had been over the ceiling.
	// An "over-run" is a group of overs separated by gaps shorter than runGapSamples
	// (so the individual cycles of a bass note that pokes above the ceiling count as one
	// sustained run and get the slow release, not a per-cycle ripple).
	let runLen = 0, sinceOver = runGapSamples + 1;
	for (let i = 1; i < length; i++) {
		const target = lookaheadGain[i];
		if (target < 0.999) { runLen = (sinceOver > runGapSamples) ? 1 : runLen + sinceOver + 1; sinceOver = 0; }
		else { sinceOver++; if (sinceOver > runGapSamples) runLen = 0; }
		const prev = lookaheadGain[i - 1];
		if (target < prev) {
			lookaheadGain[i] = attackCoeff * prev + (1 - attackCoeff) * target;
		} else if (target > prev) {
			const rc = (runLen > 0 && runLen <= shortRunSamples) ? fastReleaseCoeff : slowReleaseCoeff;
			lookaheadGain[i] = rc * prev + (1 - rc) * target;
		}
	}

	// Pass 4: apply gain to all channels
	for (let ch = 0; ch < numChannels; ch++) {
		const data = audioBuffer.getChannelData(ch);
		for (let i = 0; i < length; i++) {
			data[i] *= lookaheadGain[i];
		}
	}

	// Stats: how hard the limiter worked (logged so heavy, audible limiting is visible)
	let reduced = 0, sumDb = 0, minGain = 1;
	for (let i = 0; i < length; i++) {
		const g = lookaheadGain[i];
		if (g < 0.99) { reduced++; sumDb += 20 * Math.log10(g); }
		if (g < minGain) minGain = g;
	}
	return {
		reducedPct: 100 * reduced / length,
		meanReductionDb: reduced ? -sumDb / reduced : 0,
		maxReductionDb: -20 * Math.log10(Math.max(minGain, 1e-6))
	};
}

function getRms(audioBuffer) {
	if (!audioBuffer) return 0;
	let sumSquares = 0;
	let totalSamples = 0;
	for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
		const data = audioBuffer.getChannelData(ch);
		for (let i = 0; i < data.length; i++) {
			sumSquares += data[i] * data[i];
		}
		totalSamples += data.length;
	}
	return Math.sqrt(sumSquares / totalSamples);
}

// Active RMS: only measures samples above a silence threshold,
// ignoring gaps between sounds (birds, waves, chimes, etc.)
function getActiveRms(audioBuffer, silenceThreshold) {
	if (!audioBuffer) return { rms: 0, activePct: 0 };
	const thresh = silenceThreshold || 0.01;
	let sumSquares = 0;
	let activeSamples = 0;
	let totalSamples = 0;
	for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
		const data = audioBuffer.getChannelData(ch);
		for (let i = 0; i < data.length; i++) {
			totalSamples++;
			if (Math.abs(data[i]) > thresh) {
				sumSquares += data[i] * data[i];
				activeSamples++;
			}
		}
	}
	const rms = activeSamples > 0 ? Math.sqrt(sumSquares / activeSamples) : 0;
	const activePct = (activeSamples / totalSamples) * 100;
	return { rms, activePct };
}

function getMaxVolume(audioBuffer, logDetails) {
	if (!audioBuffer) return 0;

	let maxVolume = 0;
	let peakSampleIndex = 0;
	let peakChannel = 0;
	const numberOfChannels = audioBuffer.numberOfChannels;
	const length = audioBuffer.length;

	for (let channel = 0; channel < numberOfChannels; channel++) {
		const channelData = audioBuffer.getChannelData(channel);
		for (let i = 0; i < length; i++) {
			const absoluteValue = Math.abs(channelData[i]);
			if (absoluteValue > maxVolume) {
				maxVolume = absoluteValue;
				peakSampleIndex = i;
				peakChannel = channel;
			}
		}
	}

	if (logDetails) {
		const peakTimeSec = peakSampleIndex / audioBuffer.sampleRate;
		console.log(`  Peak details: value=${maxVolume.toFixed(4)} at ${peakTimeSec.toFixed(2)}s (sample ${peakSampleIndex}, ch${peakChannel})`);
	}

	return maxVolume;
}

// --------- Utility Functions ---------
function isNoiseType(backgroundSound) {
	return ['white', 'pink', 'brown'].includes(backgroundSound.toLowerCase());
}

