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

	// For custom music sessions: generate everything with pure math (no Tone.js artifacts)
	// For built-in noise sessions: use Tone.js (needed for Noise generator and AutoFilter)
	if (decodedNoiseBuffer) {
		return generateWithCustomMusic(options, durationSec, numChannels);
	} else {
		return generateWithNoise(options, durationSec, numChannels);
	}
}

// --------- Pure math generation for custom music sessions ---------
function generateWithCustomMusic(options, durationSec, numChannels) {
	const {
		sequence, carrierFreq, mainVolume = 0.7, useNoiseFade = false,
		decodedNoiseBuffer, customNoiseVolume = null,
		useBinaural = false, binauralVolume = 0.12,
		isochronicVolume = 0.35, muteIsochronic = false
	} = options;

	const sampleRate = 44100;
	const totalSamples = Math.ceil(durationSec * sampleRate);
	const headroom = Math.min(mainVolume, 0.89);

	// Music volume scaling
	const musicPeak = getMaxVolume(decodedNoiseBuffer);
	const musicScale = (customNoiseVolume !== null ? customNoiseVolume : defaultBackgroundVolume) / musicPeak;
	console.log(`  Music buffer: peak=${musicPeak.toFixed(4)}, scale=${musicScale.toFixed(4)}`);
	console.log(`  Music duration: ${decodedNoiseBuffer.duration.toFixed(2)}s, sampleRate: ${decodedNoiseBuffer.sampleRate}`);

	// Build LFO frequency schedule: array of {startTime, endTime, startFreq, endFreq}
	const lfoSchedule = buildLfoSchedule(sequence);

	// Create output buffer
	const ctx = new OfflineAudioContext(numChannels, totalSamples, sampleRate);
	const outputBuffer = ctx.createBuffer(numChannels, totalSamples, sampleRate);

	// Fade envelope params
	const fadeInEnd = Math.min(fadeIn, durationSec);
	const fadeOutStart = Math.max(0, durationSec - Math.max(0, fadeOut + finalBuffer));
	const fadeOutEnd = Math.min(durationSec, fadeOutStart + fadeOut);

	// Music params
	const musicSR = decodedNoiseBuffer.sampleRate;
	const musicLen = decodedNoiseBuffer.length;
	const musicChannels = decodedNoiseBuffer.numberOfChannels;
	const musicLenInSamples = Math.round(musicLen * sampleRate / musicSR);
	const noiseFadeSamples = noiseFade * sampleRate;

	console.log(`  Pure math render: ${numChannels}ch, ${totalSamples} samples, ${(totalSamples/sampleRate/60).toFixed(1)}min`);

	// Get channel data references
	const outChannels = [];
	for (let ch = 0; ch < numChannels; ch++) {
		outChannels.push(outputBuffer.getChannelData(ch));
	}
	const musicDataChannels = [];
	for (let ch = 0; ch < numChannels; ch++) {
		const musicCh = ch < musicChannels ? ch : 0;
		musicDataChannels.push(decodedNoiseBuffer.getChannelData(musicCh));
	}

	// Phase accumulators
	let carrierPhase = 0;
	let lfoPhase = 0;
	let binauralLPhase = 0;
	let binauralRPhase = 0;

	const twoPi = 2 * Math.PI;
	const dCarrier = twoPi * carrierFreq / sampleRate;

	for (let i = 0; i < totalSamples; i++) {
		const t = i / sampleRate;

		// --- Master fade envelope ---
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

		// --- Binaural fade envelope (same timing, different target) ---
		let binGain = 0;
		if (useBinaural && numChannels === 2) {
			if (t < fadeInEnd) {
				binGain = binauralVolume * (t / fadeInEnd);
			} else if (t >= fadeOutStart && t < fadeOutEnd) {
				binGain = binauralVolume * (1 - (t - fadeOutStart) / (fadeOutEnd - fadeOutStart));
			} else if (t >= fadeOutEnd) {
				binGain = 0;
			} else {
				binGain = binauralVolume;
			}
		}

		// --- LFO frequency (with ramps) ---
		const lfoFreq = getLfoFreqAtTime(t, lfoSchedule);

		// --- Accumulate phases ---
		carrierPhase += dCarrier;
		if (carrierPhase > twoPi) carrierPhase -= twoPi;

		lfoPhase += twoPi * lfoFreq / sampleRate;
		if (lfoPhase > twoPi) lfoPhase -= twoPi;

		// --- Isochronic tone: carrier * sine LFO envelope ---
		let isochronicSample = 0;
		if (!muteIsochronic) {
			const carrier = Math.sin(carrierPhase);
			const lfoEnvelope = (Math.sin(lfoPhase) + 1) / 2 * isochronicVolume;
			isochronicSample = carrier * lfoEnvelope;
		}

		// --- Binaural beats ---
		let binauralL = 0, binauralR = 0;
		if (useBinaural && numChannels === 2) {
			binauralLPhase += dCarrier;
			if (binauralLPhase > twoPi) binauralLPhase -= twoPi;
			binauralRPhase += twoPi * (carrierFreq + lfoFreq) / sampleRate;
			if (binauralRPhase > twoPi) binauralRPhase -= twoPi;
			binauralL = Math.sin(binauralLPhase) * binGain;
			binauralR = Math.sin(binauralRPhase) * binGain;
		}

		// --- Music sample (looping, with linear interpolation) ---
		const musicPos = (i * musicSR / sampleRate) % musicLen;
		const idx0 = Math.floor(musicPos);
		const idx1 = (idx0 + 1) % musicLen;
		const frac = musicPos - idx0;

		// Noise fade at loop boundaries
		let nfGain = 1.0;
		if (useNoiseFade) {
			const posInSegment = (i % musicLenInSamples);
			const segmentLen = Math.min(musicLenInSamples, totalSamples - (i - posInSegment));
			if (posInSegment < noiseFadeSamples) {
				nfGain = posInSegment / noiseFadeSamples;
			}
			if (posInSegment > segmentLen - noiseFadeSamples) {
				nfGain = Math.min(nfGain, (segmentLen - posInSegment) / noiseFadeSamples);
			}
		}

		// --- Write to each channel ---
		for (let ch = 0; ch < numChannels; ch++) {
			const musicSample = (musicDataChannels[ch][idx0] * (1 - frac) + musicDataChannels[ch][idx1] * frac) * musicScale * nfGain;
			const binSample = (ch === 0) ? binauralL : binauralR;
			outChannels[ch][i] = (isochronicSample + musicSample) * masterGain + binSample;
		}
	}

	// Log output stats
	const peak = getMaxVolume(outputBuffer, true);
	// Verify: check if any non-music content exists by comparing channels
	let nonZeroIso = 0;
	let nonZeroBin = 0;
	const verifyData = outChannels[0];
	for (let i = 0; i < Math.min(totalSamples, 441000); i++) { // check first 10 seconds
		const musicPos = (i * musicSR / sampleRate) % musicLen;
		const idx0v = Math.floor(musicPos);
		const idx1v = (idx0v + 1) % musicLen;
		const fracv = musicPos - idx0v;
		const t = i / sampleRate;
		let mg;
		if (t < fadeInEnd) mg = headroom * (t / fadeInEnd);
		else if (t >= fadeOutStart && t < fadeOutEnd) mg = headroom * (1 - (t - fadeOutStart) / (fadeOutEnd - fadeOutStart));
		else if (t >= fadeOutEnd) mg = 0;
		else mg = headroom;
		const expectedMusic = (musicDataChannels[0][idx0v] * (1 - fracv) + musicDataChannels[0][idx1v] * fracv) * musicScale * mg;
		const diff = Math.abs(verifyData[i] - expectedMusic);
		if (diff > 0.0001) nonZeroIso++;
	}
	console.log(`  VERIFY: ${nonZeroIso} samples differ from music-only (first 10s of ch0)`);
	console.log(`  Output peak ${peak.toFixed(4)}, no Tone.js involved`);

	return outputBuffer;
}

// Build a schedule of LFO frequencies from the sequence
function buildLfoSchedule(sequence) {
	const schedule = [];
	let currentTime = 0;
	let currentFreq = sequence[0].frequency;

	for (const step of sequence) {
		if (step.rampDuration) {
			// Ramp from current frequency to step frequency
			schedule.push({
				startTime: currentTime,
				endTime: currentTime + step.rampDuration,
				startFreq: currentFreq,
				endFreq: step.frequency
			});
			currentTime += step.rampDuration;
			currentFreq = step.frequency;
		}
		// Hold at step frequency for duration
		schedule.push({
			startTime: currentTime,
			endTime: currentTime + step.duration,
			startFreq: currentFreq,
			endFreq: currentFreq
		});
		currentTime += step.duration;
	}
	return schedule;
}

// Get the LFO frequency at a given time using the schedule
function getLfoFreqAtTime(t, schedule) {
	for (const seg of schedule) {
		if (t >= seg.startTime && t < seg.endTime) {
			if (seg.startFreq === seg.endFreq) return seg.startFreq;
			const frac = (t - seg.startTime) / (seg.endTime - seg.startTime);
			return seg.startFreq + (seg.endFreq - seg.startFreq) * frac;
		}
	}
	// Past end of schedule, use last frequency
	return schedule[schedule.length - 1].endFreq;
}

// --------- Tone.js generation for built-in noise sessions ---------
async function generateWithNoise(options, durationSec, numChannels) {
	const {
		sequence, carrierFreq, noiseType = 'brown', mainVolume = 0.7,
		useNoiseModulation = false, alwaysMono = false,
		useBinaural = false, binauralVolume = 0.12,
		isochronicVolume = 0.35, muteIsochronic = false
	} = options;

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

	// Log output stats
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
function getMaxVolume(audioBuffer, logDetails) {
	if (!audioBuffer) return 0;

	let maxVolume = 0;
	let peakSampleIndex = 0;
	let peakChannel = 0;
	const numberOfChannels = audioBuffer.numberOfChannels;
	const length = audioBuffer.length;

	// Check all channels to find the absolute maximum amplitude
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
		// Count samples exceeding 1.0
		let clippedSamples = 0;
		for (let ch = 0; ch < numberOfChannels; ch++) {
			const data = audioBuffer.getChannelData(ch);
			for (let i = 0; i < length; i++) {
				if (Math.abs(data[i]) > 1.0) clippedSamples++;
			}
		}
		console.log(`  Samples exceeding 1.0: ${clippedSamples} of ${length * numberOfChannels} total`);
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
