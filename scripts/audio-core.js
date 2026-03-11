// --------- Shared Audio Generation Core ---------
// This module contains the core audio generation functionality
// that can be used by both generate.js and generate_bulk.js

// --------- Constants ---------
const fadeIn = 10; // sec
const fadeOut = 10; // sec
const noiseFade = 3; // sec
const finalBuffer = 3; // sec
const defaultBackgroundVolume = 0.5;

// --------- Parsing Functions ---------
function parseSequence(sequenceText) {
	// Sanitize: keep only digits, decimal points, commas, and newlines
	const raw = sequenceText.replace(/[^0-9.,\n]/g, "");

	const sequence = raw
		.trim()
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => {
			const [frequency, duration, rampDuration] = line
				.split(",")
				.map(v => (v !== undefined && v !== null ? parseFloat(v.trim()) : undefined));
			return { frequency, duration, rampDuration };
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
		carrierFreq,
		noiseType = 'brown',
		mainVolume = 0.7,
		useNoiseModulation = false,
		useNoiseFade = false,
		alwaysMono = false,
		decodedNoiseBuffer = null,
		customNoiseVolume = null,
		useBinaural = false,
		binauralVolume = 0.12,
		isochronicVolume = 0.35,
		muteIsochronic = false
	} = options;

	const durationSec = Math.max(0.01, Number(length) || 0);
	if (!sequence.length) throw new Error("Sequence is empty or invalid.");

	// Session details log
	const backgroundType = decodedNoiseBuffer ? 'custom music' : `${noiseType} noise`;
	console.log(`--- Session config ---`);
	console.log(`  Background: ${backgroundType}`);
	console.log(`  Carrier: ${carrierFreq}Hz | Isochronic: ${muteIsochronic ? 'muted' : isochronicVolume}`);
	console.log(`  Binaural: ${useBinaural ? `on (${binauralVolume})` : 'off'} | Main volume: ${mainVolume}`);
	console.log(`  Duration: ${(durationSec / 60).toFixed(1)}min`);

	// Choose channel count dynamically
	const numChannels = alwaysMono ? 1 : (useBinaural ? 2 : (decodedNoiseBuffer && decodedNoiseBuffer.numberOfChannels > 1 ? 2 : 1));

	// Pre-scale custom music buffer using RMS normalization (consistent perceived loudness)
	let scaledNoiseBuffer = null;
	if (decodedNoiseBuffer) {
		const musicRms = getRms(decodedNoiseBuffer);
		const musicPeak = getMaxVolume(decodedNoiseBuffer);
		const targetVolume = customNoiseVolume !== null ? customNoiseVolume : defaultBackgroundVolume;
		const scale = targetVolume / musicRms;
		const scaledPeak = musicPeak * scale;
		console.log(`  Music buffer: RMS=${musicRms.toFixed(4)}, peak=${musicPeak.toFixed(4)}, scale=${scale.toFixed(4)}, scaledPeak=${scaledPeak.toFixed(4)}`);

		// Create a scaled copy: RMS normalize then compress peaks
		const ctx = new OfflineAudioContext(decodedNoiseBuffer.numberOfChannels, decodedNoiseBuffer.length, decodedNoiseBuffer.sampleRate);
		scaledNoiseBuffer = ctx.createBuffer(decodedNoiseBuffer.numberOfChannels, decodedNoiseBuffer.length, decodedNoiseBuffer.sampleRate);
		for (let ch = 0; ch < decodedNoiseBuffer.numberOfChannels; ch++) {
			const src = decodedNoiseBuffer.getChannelData(ch);
			const dst = scaledNoiseBuffer.getChannelData(ch);
			for (let i = 0; i < src.length; i++) {
				dst[i] = src[i] * scale;
			}
		}

		// Apply look-ahead compressor to tame peaks without distortion
		if (scaledPeak > 0.7) {
			console.log(`  Applying compressor (scaled peak ${scaledPeak.toFixed(4)} exceeds 0.7)`);
			compressBuffer(scaledNoiseBuffer, 0.5, 6, 0.001, 0.05, 0.005);
		}

		const finalRms = getRms(scaledNoiseBuffer);
		const finalPeak = getMaxVolume(scaledNoiseBuffer);
		console.log(`  After processing: RMS=${finalRms.toFixed(4)}, peak=${finalPeak.toFixed(4)}`);
	}

	const rendered = await Tone.Offline(({ transport }) => {
		// Carrier gated by LFO -> master
		const oscGate = new Tone.Gain(0);
		const osc = new Tone.Oscillator(carrierFreq, "sine").connect(oscGate);

		const firstFreq = sequence[0].frequency;
		const lfo = new Tone.LFO({ frequency: firstFreq, min: 0, max: isochronicVolume, type: "sine" }).connect(oscGate.gain);

		// Binaural layer
		let binauralL, binauralR, panL, panR, binauralGain;
		if (useBinaural && numChannels === 2) {
			const firstBeatFreq = sequence[0].frequency;
			binauralL = new Tone.Oscillator(carrierFreq, "sine");
			binauralR = new Tone.Oscillator(carrierFreq + firstBeatFreq, "sine");
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

		// Background sound
		if (scaledNoiseBuffer) {
			// Custom music via Tone.Player (pre-scaled buffer)
			const toneBuffer = new Tone.Buffer().fromArray(
				scaledNoiseBuffer.numberOfChannels === 1
					? scaledNoiseBuffer.getChannelData(0)
					: [scaledNoiseBuffer.getChannelData(0), scaledNoiseBuffer.getChannelData(1)]
			);
			const player = new Tone.Player(toneBuffer).connect(master);
			player.loop = true;
			player.volume.value = 0; // 0 dB = unity gain (volume already pre-scaled)
			if (useNoiseFade) {
				player.fadeIn = noiseFade;
				player.fadeOut = noiseFade;
			}
			player.start(0);
		} else {
			// Built-in noise
			const noiseGain = new Tone.Gain(defaultBackgroundVolume);
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
		sequence.forEach(step => {
			if (step.rampDuration) {
				transport.schedule(() => {
					lfo.frequency.linearRampTo(step.frequency, step.rampDuration);
					if (binauralR) {
						binauralR.frequency.linearRampTo(carrierFreq + step.frequency, step.rampDuration);
					}
				}, currentTime);
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

// Look-ahead envelope compressor. Adjusts gain smoothly based on signal level,
// without distorting the waveform shape (no harmonics, no buzzing).
// The look-ahead ensures gain reduction starts BEFORE transients arrive.
// threshold: level above which compression starts (linear amplitude)
// ratio: compression ratio (e.g., 6 means 6:1 compression)
// attackSec: how fast gain reduction kicks in (1ms recommended)
// releaseSec: how fast gain reduction releases (50ms recommended)
// lookAheadSec: how far ahead to look for upcoming transients (5ms recommended)
function compressBuffer(audioBuffer, threshold, ratio, attackSec, releaseSec, lookAheadSec) {
	const sampleRate = audioBuffer.sampleRate;
	const numChannels = audioBuffer.numberOfChannels;
	const length = audioBuffer.length;
	const attackCoeff = Math.exp(-1 / (attackSec * sampleRate));
	const releaseCoeff = Math.exp(-1 / (releaseSec * sampleRate));
	const lookAheadSamples = Math.max(1, Math.round(lookAheadSec * sampleRate));

	// Pass 1 (forward): compute gain reduction with envelope follower
	const gainReduction = new Float32Array(length);
	let envelope = 0;

	for (let i = 0; i < length; i++) {
		// Find max absolute value across all channels at this sample
		let maxAbs = 0;
		for (let ch = 0; ch < numChannels; ch++) {
			const abs = Math.abs(audioBuffer.getChannelData(ch)[i]);
			if (abs > maxAbs) maxAbs = abs;
		}

		// Smooth envelope follower
		if (maxAbs > envelope) {
			envelope = attackCoeff * envelope + (1 - attackCoeff) * maxAbs;
		} else {
			envelope = releaseCoeff * envelope + (1 - releaseCoeff) * maxAbs;
		}

		// Calculate gain reduction
		if (envelope > threshold) {
			const targetLevel = threshold + (envelope - threshold) / ratio;
			gainReduction[i] = targetLevel / envelope;
		} else {
			gainReduction[i] = 1.0;
		}
	}

	// Pass 2 (backward): look-ahead — propagate gain reduction backward so it
	// starts before the transient arrives. Uses exponential decay so the
	// look-ahead doesn't extend indefinitely.
	const decay = 1 / lookAheadSamples;
	let minGain = 1.0;
	for (let i = length - 1; i >= 0; i--) {
		minGain = Math.min(gainReduction[i], minGain);
		gainReduction[i] = minGain;
		// Decay toward 1.0 over ~lookAheadSamples distance
		minGain += (1.0 - minGain) * decay;
	}

	// Pass 3: apply gain reduction to all channels
	for (let ch = 0; ch < numChannels; ch++) {
		const data = audioBuffer.getChannelData(ch);
		for (let i = 0; i < length; i++) {
			data[i] *= gainReduction[i];
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

function generateFileName(audioFile, carrierFreq, backgroundSound) {
	const noiseType = isNoiseType(backgroundSound) ? backgroundSound : 'custom';
	return `${audioFile}_${carrierFreq}Hz_${noiseType}.wav`;
}
