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
	const backgroundVolume = customNoiseVolume !== null ? customNoiseVolume : defaultBackgroundVolume;
	console.log(`--- Session config ---`);
	console.log(`  Background: ${backgroundType} (volume: ${backgroundVolume})`);
	console.log(`  Carrier: ${carrierFreq}Hz | Isochronic: ${muteIsochronic ? 'muted' : isochronicVolume}`);
	console.log(`  Binaural: ${useBinaural ? `on (${binauralVolume})` : 'off'} | Main volume: ${mainVolume}`);
	console.log(`  Duration: ${(durationSec / 60).toFixed(1)}min | Channels: ${alwaysMono ? 'mono (forced)' : 'auto'}`);
	if (decodedNoiseBuffer) {
		console.log(`  Noise fade: ${useNoiseFade} | Noise modulation: ${useNoiseModulation}`);
	} else {
		console.log(`  Noise modulation: ${useNoiseModulation}`);
	}

	// Choose channel count dynamically (force stereo if binaural, or preserve stereo if input noise is stereo)
	const channels = alwaysMono ? 1 : (useBinaural ? 2 : (decodedNoiseBuffer && decodedNoiseBuffer.numberOfChannels > 1 ? 2 : 1));

	// Normalize custom audio files by RMS for consistent perceived loudness, then limit peaks
	if (decodedNoiseBuffer) {
		const peakBefore = getMaxVolume(decodedNoiseBuffer);
		const rmsBefore = getRMS(decodedNoiseBuffer);
		console.log(`Music buffer before normalization: peak=${peakBefore.toFixed(4)}, RMS=${rmsBefore.toFixed(4)}`);
		normalizeAndLimitBuffer(decodedNoiseBuffer, 0.15, 0.9);
	}

	const rendered = await Tone.Offline(({ transport }) => {
		// Carrier gated by LFO -> master
		const oscGate = new Tone.Gain(0);
		const osc = new Tone.Oscillator(carrierFreq, "sine").connect(oscGate);

		// LFO starts at the first step frequency; later steps only change it if rampDuration is provided
		const firstFreq = sequence[0].frequency;
		const lfo = new Tone.LFO(firstFreq, 0, isochronicVolume, "square").connect(oscGate.gain);

		// Noise path: user file (looped) or built-in noise
		// Custom audio files are already RMS-normalized, so apply volume directly
		const effectiveNoiseVolume = customNoiseVolume !== null ? customNoiseVolume : defaultBackgroundVolume;
		console.log("Background sound volume: ", effectiveNoiseVolume);
		const noiseGain = new Tone.Gain(effectiveNoiseVolume);

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

		if (decodedNoiseBuffer) {
			const toneBuffer = new Tone.Buffer(decodedNoiseBuffer);
			console.log("Using noise fade: ", useNoiseFade);
			if (useNoiseFade) {
				const segDur = decodedNoiseBuffer.duration;
				for (let t = 0; t < durationSec; t += segDur) {
					const start = t;
					const stop  = Math.min(t + segDur, durationSec);
					if (stop - start > 0.01) {
						// Create a separate player instance for each segment to ensure fade works
						const player = new Tone.Player({
							url: toneBuffer,
							loop: false,
							volume: 0,
							fadeIn: noiseFade,
							fadeOut: noiseFade
						}).connect(filter || noiseGain);
						
						player.start(start);
						player.stop(stop);
					}
				}
			} else {
				const player = new Tone.Player({
					url: toneBuffer,
					loop: true,
					volume: 0
				}).connect(filter || noiseGain);
				player.start(0);
			}
		} else {
			const toneNoise = new Tone.Noise(noiseType.toLowerCase()).connect(filter || noiseGain);
			toneNoise.start(0);
		}

		// Binaural layer (two continuous oscillators, hard-panned L/R)
		let binauralL, binauralR, panL, panR, binauralGain;
		if (useBinaural && channels === 2) {
			const firstBeatFreq = sequence[0].frequency;

			// Left channel: carrier frequency
			// Right channel: carrier frequency + beat frequency
			binauralL = new Tone.Oscillator(carrierFreq, "sine");
			binauralR = new Tone.Oscillator(carrierFreq + firstBeatFreq, "sine");

			// Hard-pan left and right
			panL = new Tone.Panner(-1);
			panR = new Tone.Panner(1);

			// Binaural bus with its own gain control
			binauralGain = new Tone.Gain(0); // Start at 0 for fade-in

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
		noiseGain.connect(master);
		if (binauralGain) {
			binauralGain.connect(master);
		}

		// Start sources
		osc.start(0);
		lfo.start(0);

		// Schedule ramps on the OFFLINE transport (matches original semantics)
		let currentTime = 0;
		sequence.forEach(step => {
			if (step.rampDuration) {
				transport.schedule(() => {
					lfo.frequency.linearRampTo(step.frequency, step.rampDuration);
					// Also ramp binaural beat frequency (right oscillator) to follow the sequence
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

		// Binaural layer fade (follows master fade timing)
		if (binauralGain) {
			binauralGain.gain.setValueAtTime(0, 0);
			binauralGain.gain.linearRampToValueAtTime(binauralVolume, Math.min(fadeIn, durationSec));
			binauralGain.gain.setValueAtTime(binauralVolume, fadeOutStart);
			binauralGain.gain.linearRampToValueAtTime(0, Math.min(durationSec, fadeOutStart + fadeOut));
		}

		transport.start(0);
	}, durationSec, alwaysMono ? 1 : channels);

	// Normalize all output to a consistent peak level (0.95)
	// This ensures consistent volume across all sessions and prevents clipping
	const targetPeak = 0.95;
	const peak = getMaxVolume(rendered);
	if (peak > 0) {
		const scale = targetPeak / peak;
		console.log(`Normalizing output: peak was ${peak.toFixed(4)}, target ${targetPeak}, scaling by ${scale.toFixed(4)}`);
		for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
			const data = rendered.getChannelData(ch);
			for (let i = 0; i < data.length; i++) {
				data[i] *= scale;
			}
		}
	}

	return rendered; // AudioBuffer
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
function getMaxVolume(audioBuffer) {
	if (!audioBuffer) return 0;
	
	let maxVolume = 0;
	const numberOfChannels = audioBuffer.numberOfChannels;
	const length = audioBuffer.length;
	
	// Check all channels to find the absolute maximum amplitude
	for (let channel = 0; channel < numberOfChannels; channel++) {
		const channelData = audioBuffer.getChannelData(channel);
		for (let i = 0; i < length; i++) {
			const absoluteValue = Math.abs(channelData[i]);
			if (absoluteValue > maxVolume) {
				maxVolume = absoluteValue;
			}
		}
	}
	
	return maxVolume;
}

// --------- Audio Normalization Functions ---------
function getRMS(audioBuffer) {
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

function normalizeAndLimitBuffer(audioBuffer, targetRMS, peakLimit) {
	const currentRMS = getRMS(audioBuffer);
	if (currentRMS === 0) return;

	const currentPeak = getMaxVolume(audioBuffer);
	const rmsScale = targetRMS / currentRMS;
	const peakScale = peakLimit / currentPeak;
	// Use whichever scale is smaller to avoid exceeding peak limit
	const scale = Math.min(rmsScale, peakScale);
	const wasPeakLimited = peakScale < rmsScale;

	console.log(`RMS normalization: RMS scale=${rmsScale.toFixed(4)}, peak scale=${peakScale.toFixed(4)}, using=${scale.toFixed(4)}${wasPeakLimited ? ' (peak-limited)' : ''}`);

	for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
		const data = audioBuffer.getChannelData(ch);
		for (let i = 0; i < data.length; i++) {
			data[i] *= scale;
		}
	}

	const newPeak = getMaxVolume(audioBuffer);
	const newRMS = getRMS(audioBuffer);
	console.log(`After normalization: RMS=${newRMS.toFixed(4)}, peak=${newPeak.toFixed(4)}`);
}

// --------- Utility Functions ---------
function isNoiseType(backgroundSound) {
	return ['white', 'pink', 'brown'].includes(backgroundSound.toLowerCase());
}

function generateFileName(audioFile, carrierFreq, backgroundSound) {
	const noiseType = isNoiseType(backgroundSound) ? backgroundSound : 'custom';
	return `${audioFile}_${carrierFreq}Hz_${noiseType}.wav`;
}
