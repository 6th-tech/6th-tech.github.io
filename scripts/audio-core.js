// --------- Shared Audio Generation Core ---------
// This module contains the core audio generation functionality
// that can be used by both generate.js and generate_bulk.js

// --------- Constants ---------
const fadeIn = 10; // sec
const fadeOut = 10; // sec
const noiseFade = 3; // sec
const finalBuffer = 3; // sec
const defaultBackgroundVolume = 0.5;
const defaultNoiseVolume = 0.7;

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
		binauralVolume = 0.12,
		isochronicVolume: isochronicVolumeBase = 0.35,
		muteIsochronic = false
	} = options;

	const durationSec = Math.max(0.01, Number(length) || 0);
	if (!sequence.length) throw new Error("Sequence is empty or invalid.");

	// Derive starting carrier from first step's carrier field
	const startingCarrier = sequence[0].carrierFreq || 174;

	let isochronicVolume = isochronicVolumeBase;

	// Compensate for equal-loudness: lower carriers sound quieter to human ears.
	// Up to 30% boost for carriers well below 400 Hz (based on Fletcher-Munson curves)
	if (startingCarrier < 400) {
		const freqBoost = 1 + 0.30 * (1 - startingCarrier / 400);
		isochronicVolume *= freqBoost;
		console.log(`  Carrier freq compensation: +${((freqBoost - 1) * 100).toFixed(0)}% → isochronic ${isochronicVolume.toFixed(4)} (${startingCarrier}Hz < 400Hz)`);
	}

	// Session details log
	const backgroundType = decodedNoiseBuffer ? 'custom music' : `${noiseType} noise`;
	console.log(`--- Session config ---`);
	console.log(`  Background: ${backgroundType}`);
	console.log(`  Starting carrier: ${startingCarrier}Hz | Isochronic: ${muteIsochronic ? 'muted' : isochronicVolume}`);
	console.log(`  Binaural: ${useBinaural ? `on (${binauralVolume})` : 'off'} | Main volume: ${mainVolume}`);
	console.log(`  Duration: ${(durationSec / 60).toFixed(1)}min`);

	// Choose channel count dynamically
	const numChannels = alwaysMono ? 1 : (useBinaural ? 2 : (decodedNoiseBuffer && decodedNoiseBuffer.numberOfChannels > 1 ? 2 : 1));

	// Pre-scale custom music buffer using RMS normalization (consistent perceived loudness)
	// Cap scale factor to prevent extreme amplification that causes artifacts
	const maxScale = 4;
	let scaledNoiseBuffer = null;
	if (decodedNoiseBuffer) {
		const musicRms = getRms(decodedNoiseBuffer);
		const musicPeak = getMaxVolume(decodedNoiseBuffer);
		const targetVolume = customNoiseVolume !== null ? customNoiseVolume : defaultBackgroundVolume;
		const rmsScale = targetVolume / musicRms;
		const scale = Math.min(rmsScale, maxScale);
		const scaledPeak = musicPeak * scale;
		if (rmsScale > maxScale) {
			console.log(`  RMS scale ${rmsScale.toFixed(2)}x capped to ${maxScale}x (very dynamic source)`);
		}
		console.log(`  Music buffer: RMS=${musicRms.toFixed(4)}, peak=${musicPeak.toFixed(4)}, scale=${scale.toFixed(4)}, scaledPeak=${scaledPeak.toFixed(4)}`);
		const active = getActiveRms(decodedNoiseBuffer);
		console.log(`  Active RMS=${active.rms.toFixed(4)} (${active.activePct.toFixed(1)}% active), silence gap ratio: ${(100 - active.activePct).toFixed(1)}%`);

		// Boost isochronic volume for loud backgrounds so tones don't get buried.
		// Gradual ramp: 0% boost at activeRms=0.10, up to 30% boost at activeRms≥0.20
		if (active.rms > 0.10) {
			const boostFactor = 1 + 0.30 * Math.min((active.rms - 0.10) / 0.10, 1);
			isochronicVolume *= boostFactor;
			console.log(`  Isochronic boost: ${((boostFactor - 1) * 100).toFixed(0)}% → volume ${isochronicVolume.toFixed(4)} (active RMS ${active.rms.toFixed(4)})`);
		}

		// Create a scaled copy
		const ctx = new OfflineAudioContext(decodedNoiseBuffer.numberOfChannels, decodedNoiseBuffer.length, decodedNoiseBuffer.sampleRate);
		scaledNoiseBuffer = ctx.createBuffer(decodedNoiseBuffer.numberOfChannels, decodedNoiseBuffer.length, decodedNoiseBuffer.sampleRate);
		for (let ch = 0; ch < decodedNoiseBuffer.numberOfChannels; ch++) {
			const src = decodedNoiseBuffer.getChannelData(ch);
			const dst = scaledNoiseBuffer.getChannelData(ch);
			for (let i = 0; i < src.length; i++) {
				dst[i] = src[i] * scale;
			}
		}

		// True peak limiter: only touches actual peaks above ceiling,
		// leaves the rest of the signal completely untouched (no artifacts)
		if (scaledPeak > 0.85) {
			console.log(`  Applying limiter (scaled peak ${scaledPeak.toFixed(4)} exceeds 0.85)`);
			truePeakLimiter(scaledNoiseBuffer, 0.85, 0.01);
		}

		// Safety ceiling: guarantee peak ≤ 0.95 before entering Tone.js
		const prePeak = getMaxVolume(scaledNoiseBuffer);
		if (prePeak > 0.95) {
			const safeScale = 0.95 / prePeak;
			console.log(`  Safety ceiling: scaling by ${safeScale.toFixed(4)} (peak was ${prePeak.toFixed(4)})`);
			for (let ch = 0; ch < scaledNoiseBuffer.numberOfChannels; ch++) {
				const data = scaledNoiseBuffer.getChannelData(ch);
				for (let i = 0; i < data.length; i++) data[i] *= safeScale;
			}
		}

		// Apply fade at buffer boundaries for click-free looping
		const loopFadeSamples = Math.round(noiseFade * scaledNoiseBuffer.sampleRate);
		for (let ch = 0; ch < scaledNoiseBuffer.numberOfChannels; ch++) {
			const data = scaledNoiseBuffer.getChannelData(ch);
			const len = data.length;
			for (let i = 0; i < loopFadeSamples && i < len; i++) {
				const gain = i / loopFadeSamples;
				data[i] *= gain;              // fade in at start
				data[len - 1 - i] *= gain;    // fade out at end
			}
		}

		const finalRms = getRms(scaledNoiseBuffer);
		const finalPeak = getMaxVolume(scaledNoiseBuffer);
		console.log(`  After processing: RMS=${finalRms.toFixed(4)}, peak=${finalPeak.toFixed(4)}`);
	}

	// Tone.js renders ONLY isochronic tones, binaural beats, and built-in noise.
	// Custom music is mixed in afterward with simple math — no Tone.Player,
	// no Tone.Buffer conversion, no black-box behavior.
	const rendered = await Tone.Offline(({ transport }) => {
		// Carrier gated by LFO -> master
		const initialCarrier = startingCarrier;
		const oscGate = new Tone.Gain(0);
		const osc = new Tone.Oscillator(initialCarrier, "sine").connect(oscGate);

		const firstFreq = sequence[0].frequency;
		const lfo = new Tone.LFO({ frequency: firstFreq, min: 0, max: isochronicVolume, type: "sine" }).connect(oscGate.gain);

		// Binaural layer
		let binauralL, binauralR, panL, panR, binauralGain;
		if (useBinaural && numChannels === 2) {
			const firstBeatFreq = sequence[0].frequency;
			binauralL = new Tone.Oscillator(initialCarrier, "sine");
			binauralR = new Tone.Oscillator(initialCarrier + firstBeatFreq, "sine");
			panL = new Tone.Panner(-1);
			panR = new Tone.Panner(1);
			binauralGain = new Tone.Gain(0);
			binauralL.connect(panL);
			binauralR.connect(panR);
			panL.connect(binauralGain);
			panR.connect(binauralGain);
			binauralL.start(0);
			binauralR.start(0);
		}

		// Master out
		const master = new Tone.Gain(0).toDestination();
		if (!muteIsochronic) {
			oscGate.connect(master);
		}

		// Built-in noise (only for noise sessions, NOT custom music)
		if (!scaledNoiseBuffer) {
			const noiseGain = new Tone.Gain(defaultNoiseVolume);
			let filter = null;
			if (useNoiseModulation) {
				filter = new Tone.AutoFilter({
					frequency: "8m",
					min: 2000,
					max: 15000,
					Q: 0.5
				}).connect(noiseGain);
				filter.start(0);
			}
			const toneNoise = new Tone.Noise(noiseType.toLowerCase()).connect(filter || noiseGain);
			toneNoise.start(0);
			noiseGain.connect(master);
		}

		if (binauralGain) {
			binauralGain.connect(master);
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
					}
					if (binauralR) {
						if (step.carrierFreq) {
							binauralL.frequency[rampFn](step.carrierFreq, step.rampDuration, time);
						}
						binauralR.frequency[rampFn](stepCarrier + step.frequency, step.rampDuration, time);
					}
				}, currentTime);
			} else if (step.carrierFreq) {
				// No ramp but carrier changes — set immediately
				transport.schedule((time) => {
					osc.frequency.setValueAtTime(step.carrierFreq, time);
					if (binauralL) {
						binauralL.frequency.setValueAtTime(step.carrierFreq, time);
					}
					if (binauralR) {
						binauralR.frequency.setValueAtTime(step.carrierFreq + step.frequency, time);
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
			binauralGain.gain.setValueAtTime(0, 0);
			binauralGain.gain.linearRampToValueAtTime(binauralVolume, Math.min(fadeIn, durationSec));
			binauralGain.gain.setValueAtTime(binauralVolume, fadeOutStart);
			binauralGain.gain.linearRampToValueAtTime(0, Math.min(durationSec, fadeOutStart + fadeOut));
		}

		transport.start(0);
	}, durationSec, alwaysMono ? 1 : numChannels);

	// Mix custom music directly into the rendered output (bypasses Tone.js entirely)
	if (scaledNoiseBuffer) {
		const headroom = Math.min(mainVolume, 0.89);
		const fadeInEnd = Math.min(fadeIn, durationSec);
		const fadeOutStart = Math.max(0, durationSec - Math.max(0, fadeOut + finalBuffer));
		const fadeOutEnd = Math.min(durationSec, fadeOutStart + fadeOut);
		const outSR = rendered.sampleRate;
		const musicSR = scaledNoiseBuffer.sampleRate;
		const musicLen = scaledNoiseBuffer.length;
		const musicChannels = scaledNoiseBuffer.numberOfChannels;

		// Get channel data references
		const musicData = [];
		for (let ch = 0; ch < musicChannels; ch++) {
			musicData.push(scaledNoiseBuffer.getChannelData(ch));
		}

		for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
			const outData = rendered.getChannelData(ch);
			const srcCh = ch < musicChannels ? ch : 0; // mono music → both channels

			for (let i = 0; i < rendered.length; i++) {
				const t = i / outSR;

				// Master fade envelope (same as Tone.js master gain)
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

				// Music sample with linear interpolation (handles sample rate conversion)
				const musicPos = (i * musicSR / outSR) % musicLen;
				const idx0 = Math.floor(musicPos);
				const idx1 = (idx0 + 1) % musicLen;
				const frac = musicPos - idx0;
				const musicSample = musicData[srcCh][idx0] * (1 - frac) + musicData[srcCh][idx1] * frac;

				outData[i] += musicSample * masterGain;
			}
		}
		console.log(`  Music mixed directly (bypassed Tone.js Player)`);
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

