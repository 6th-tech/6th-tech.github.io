// --------- Shared Audio Generation Core ---------
// This module contains the core audio generation functionality
// that can be used by both generate.js and generate_bulk.js

// --------- Constants ---------
const fadeIn = 10; // sec
const fadeOut = 10; // sec
const noiseFade = 3; // sec
const finalBuffer = 3; // sec
const defaultBackgroundVolume = 0.3;   // target ACTIVE RMS of the background as heard (after dip and clipping)
const defaultNoiseVolume = 0.7; // legacy: built-in noise now goes through the same normalisation as music
const defaultCarrierDipDb = 12;      // dB carved out of the background around the carrier (one ERB wide)
const maxNormalisationScale = 40;   // cap on active-RMS normalisation gain (was 4 on global RMS)
const softClipKnee = 0.6;           // samples above this are rounded off smoothly …
const peakCeiling = 0.85;           // … and never exceed this

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
			// Slow lowpass sweep 2000 Hz -> 15000 Hz and back, one full cycle every
			// 8 minutes. NOTE: Tone.AutoFilter only reads frequency / baseFrequency /
			// octaves / filter — the previous `min/max/Q` options were silently
			// ignored (it swept 200–1212 Hz), and "8m" meant 8 *measures* (16 s).
			filter = new Tone.AutoFilter({
				frequency: 1 / 480,
				baseFrequency: 2000,
				octaves: Math.log2(15000 / 2000),
				filter: { type: "lowpass", rolloff: -12, Q: 0.5 }
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
	const backgroundType = isCustomMusic ? 'custom music' : `${noiseType} noise${useNoiseModulation ? ' (2–15 kHz lowpass sweep, 8 min cycle)' : ''}`;
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

		// 3. Level: normalise the DIPPED track so its active RMS hits the target, with
		//    transients rounded off by a soft clipper instead of a gain-riding limiter.
		//    (A limiter with a 50 ms release turns every raindrop into a 60 ms hole in the
		//    gain — amplitude modulation at 5–20 Hz, which is the last thing an
		//    entrainment session needs. The clipper only touches the samples above the
		//    knee, so the surrounding signal is left alone.) Two passes converge on the
		//    target because clipping itself removes a little energy.
		const unity = [];
		for (let ch = 0; ch < track.numberOfChannels; ch++) unity.push(Float32Array.from(track.getChannelData(ch)));
		const dipActive = getActiveRms(track);
		let scale = Math.min(targetVolume / Math.max(dipActive.rms, 1e-6), maxNormalisationScale);
		if (targetVolume / Math.max(dipActive.rms, 1e-6) > maxNormalisationScale) {
			console.log(`  Normalisation scale ${(targetVolume / dipActive.rms).toFixed(1)}x capped to ${maxNormalisationScale}x (extremely quiet source)`);
		}
		let clipStats = null;
		for (let pass = 0; pass < 2; pass++) {
			for (let ch = 0; ch < track.numberOfChannels; ch++) {
				const dst = track.getChannelData(ch), src = unity[ch];
				for (let i = 0; i < dst.length; i++) dst[i] = src[i] * scale;
			}
			clipStats = softClipBuffer(track, softClipKnee, peakCeiling);
			const got = getActiveRms(track).rms;
			const errDb = 20 * Math.log10(got / targetVolume);
			console.log(`  Level pass ${pass + 1}: x${scale.toFixed(3)} → active RMS ${got.toFixed(4)} (${errDb >= 0 ? '+' : ''}${errDb.toFixed(2)} dB from target ${targetVolume}); soft clip on ${clipStats.clippedPct.toFixed(2)}% of samples, max input ${clipStats.maxIn.toFixed(2)}`);
			if (Math.abs(errDb) < 0.3 || pass === 1) break;
			scale = Math.min(scale * targetVolume / Math.max(got, 1e-6), maxNormalisationScale);
		}

		// 4. Safety limiter (idle by construction: the clipper never exceeds the ceiling)
		const prePeak = getMaxVolume(track);
		if (prePeak > peakCeiling + 0.001) {
			const st = truePeakLimiter(track, peakCeiling, 0.01);
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
	const attackCoeff = Math.exp(-1 / (0.002 * sampleRate));  // 2ms attack
	const releaseCoeff = Math.exp(-1 / (0.05 * sampleRate));  // 50ms release

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

	// Pass 3: smooth the gain curve with attack AND release to avoid clicks
	// Attack smoothing prevents the hard edge at the look-ahead boundary
	// (without this, gain drops from 1.0 to 0.2 in one sample = click)
	for (let i = 1; i < length; i++) {
		if (lookaheadGain[i] < lookaheadGain[i - 1]) {
			// Attack: smooth downward transition (2ms)
			lookaheadGain[i] = attackCoeff * lookaheadGain[i - 1] + (1 - attackCoeff) * lookaheadGain[i];
		} else if (lookaheadGain[i] > lookaheadGain[i - 1]) {
			// Release: smooth upward transition (50ms)
			lookaheadGain[i] = releaseCoeff * lookaheadGain[i - 1] + (1 - releaseCoeff) * lookaheadGain[i];
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

