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

	let maxVolume = 1;
	const durationSec = Math.max(0.01, Number(length) || 0);
	if (!sequence.length) throw new Error("Sequence is empty or invalid.");

	// Session details log
	const backgroundType = decodedNoiseBuffer ? 'custom music' : `${noiseType} noise`;
	console.log(`--- Session config ---`);
	console.log(`  Background: ${backgroundType}`);
	console.log(`  Carrier: ${carrierFreq}Hz | Isochronic: ${muteIsochronic ? 'muted' : isochronicVolume}`);
	console.log(`  Binaural: ${useBinaural ? `on (${binauralVolume})` : 'off'} | Main volume: ${mainVolume}`);
	console.log(`  Duration: ${(durationSec / 60).toFixed(1)}min`);

	// Choose channel count dynamically (force stereo if binaural, or preserve stereo if input noise is stereo)
	const channels = alwaysMono ? 1 : (useBinaural ? 2 : (decodedNoiseBuffer && decodedNoiseBuffer.numberOfChannels > 1 ? 2 : 1));

	// Compute music volume scaling factor (used for manual mixing after render)
	let musicScaleFactor = 1;
	if (decodedNoiseBuffer) {
		maxVolume = getMaxVolume(decodedNoiseBuffer);
		musicScaleFactor = (customNoiseVolume !== null ? customNoiseVolume : defaultBackgroundVolume) / maxVolume;
		console.log(`  Music buffer: peak=${maxVolume.toFixed(4)}, scale factor=${musicScaleFactor.toFixed(4)}`);
		console.log(`  Music buffer duration: ${decodedNoiseBuffer.duration.toFixed(2)}s, session: ${durationSec.toFixed(2)}s`);
	}

	const rendered = await Tone.Offline(({ transport }) => {
		// Carrier gated by LFO -> master
		const oscGate = new Tone.Gain(0);
		const osc = new Tone.Oscillator(carrierFreq, "sine").connect(oscGate);

		// LFO starts at the first step frequency; later steps only change it if rampDuration is provided
		const firstFreq = sequence[0].frequency;
		const lfo = new Tone.LFO({ frequency: firstFreq, min: 0, max: isochronicVolume, type: "square" }).connect(oscGate.gain);

		// Binaural layer (two continuous oscillators, hard-panned L/R)
		let binauralL, binauralR, panL, panR, binauralGain;
		if (useBinaural && channels === 2) {
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

		// Built-in noise (white/pink/brown) goes through Tone.js; custom music is mixed manually after render
		if (!decodedNoiseBuffer) {
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

		// Start sources
		osc.start(0);
		lfo.start(0);

		// Schedule ramps on the OFFLINE transport
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

		// Binaural layer fade
		if (binauralGain) {
			binauralGain.gain.setValueAtTime(0, 0);
			binauralGain.gain.linearRampToValueAtTime(binauralVolume, Math.min(fadeIn, durationSec));
			binauralGain.gain.setValueAtTime(binauralVolume, fadeOutStart);
			binauralGain.gain.linearRampToValueAtTime(0, Math.min(durationSec, fadeOutStart + fadeOut));
		}

		transport.start(0);
	}, durationSec, alwaysMono ? 1 : channels);

	// Manual music mixing: bypass Tone.Player entirely to avoid unexplained amplification
	if (decodedNoiseBuffer) {
		const sampleRate = rendered.sampleRate;
		const musicSR = decodedNoiseBuffer.sampleRate;
		const musicLen = decodedNoiseBuffer.length;
		const musicChannels = decodedNoiseBuffer.numberOfChannels;
		const outChannels = rendered.numberOfChannels;
		const totalSamples = rendered.length;

		// Compute the same master fade envelope used by Tone.js render
		const headroom = Math.min(mainVolume, 0.89);
		const fadeInSamples = Math.min(fadeIn, durationSec) * sampleRate;
		const fadeOutStartSec = Math.max(0, durationSec - Math.max(0, fadeOut + finalBuffer));
		const fadeOutStartSample = fadeOutStartSec * sampleRate;
		const fadeOutEndSample = Math.min(durationSec, fadeOutStartSec + fadeOut) * sampleRate;

		// Noise fade envelope (3s fade in/out at loop boundaries)
		const noiseFadeSamples = noiseFade * sampleRate;
		const musicLenInOutputSamples = Math.round(musicLen * sampleRate / musicSR);

		console.log(`  Manual music mix: scale=${musicScaleFactor.toFixed(4)}, musicDur=${(musicLen/musicSR).toFixed(2)}s, segments=${Math.ceil(totalSamples/musicLenInOutputSamples)}`);

		for (let ch = 0; ch < outChannels; ch++) {
			const outData = rendered.getChannelData(ch);
			// Use the corresponding music channel, or channel 0 if music is mono
			const musicCh = ch < musicChannels ? ch : 0;
			const musicData = decodedNoiseBuffer.getChannelData(musicCh);

			for (let i = 0; i < totalSamples; i++) {
				// Get music sample (looping, with sample rate conversion)
				const musicPos = (i * musicSR / sampleRate) % musicLen;
				const musicIdx = Math.floor(musicPos);
				const musicSample = musicData[musicIdx] * musicScaleFactor;

				// Master fade envelope (same as Tone.js render)
				let masterGain;
				if (i < fadeInSamples) {
					masterGain = headroom * (i / fadeInSamples);
				} else if (i >= fadeOutStartSample && i < fadeOutEndSample) {
					masterGain = headroom * (1 - (i - fadeOutStartSample) / (fadeOutEndSample - fadeOutStartSample));
				} else if (i >= fadeOutEndSample) {
					masterGain = 0;
				} else {
					masterGain = headroom;
				}

				// Noise fade at loop boundaries (if useNoiseFade)
				let noiseFadeGain = 1.0;
				if (useNoiseFade) {
					const posInSegment = (i % musicLenInOutputSamples);
					const segmentLen = Math.min(musicLenInOutputSamples, totalSamples - (i - posInSegment));
					// Fade in at start of segment
					if (posInSegment < noiseFadeSamples) {
						noiseFadeGain = posInSegment / noiseFadeSamples;
					}
					// Fade out at end of segment
					if (posInSegment > segmentLen - noiseFadeSamples) {
						noiseFadeGain = Math.min(noiseFadeGain, (segmentLen - posInSegment) / noiseFadeSamples);
					}
				}

				outData[i] += musicSample * masterGain * noiseFadeGain;
			}
		}
	}

	// Prevent clipping: if peaks exceed 1.0, scale everything down
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
