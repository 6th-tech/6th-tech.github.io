// --------- Variables ---------
const fadeIn = 10; // sec
const fadeOut = 10; // sec
const noiseFade = 1; // sec
const finalBuffer = 3; // sec
const noiseVolume = 0.15;
let mainVolume = 0.8;
// -----------------------------

const playButton = document.querySelector("#playButton");
const sequenceArea = document.querySelector("#sequence");
const noiseFileInput = document.querySelector("#noiseFile");
const noiseModulationCheckbox = document.querySelector("#noiseModulation");
const noiseFadeCheckbox = document.querySelector("#noiseFade");
const alwaysMonoCheckbox = document.querySelector("#alwaysMono");

let sequence, noiseType, carrierFreq, length;
let isAudioFileLoaded = false;
let decodedNoiseBuffer = null; // holds decoded user noise (AudioBuffer)

// --------- Parsing & UI ---------
function parseSequence() {
	// Sanitize: keep only digits, decimal points, commas, and newlines
	const raw = sequenceArea.value.replace(/[^0-9.,\n]/g, "");

	sequence = raw
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

	length = sequence.reduce(
		(acc, { duration, rampDuration = 0 }) => acc + duration + rampDuration,
		0
	);
}

function setTotalTime() {
	parseSequence();
	document.getElementById("totalTime").textContent = `${length / 60}min`;
}

function initData() {
	parseSequence();
	noiseType = document.getElementById("noiseType").value;
	mainVolume = parseFloat(document.getElementById("mainVolume").value);
	carrierFreq = parseInt(document.getElementById("carrierFreq").value);
}

// --------- Noise file decode (for offline render) ---------
async function maybeDecodeNoiseFile() {
	if (noiseFileInput.files.length === 0) {
		decodedNoiseBuffer = null;
		isAudioFileLoaded = true;
		return;
	}
	const file = noiseFileInput.files[0];
	try {
		const arrayBuf = await file.arrayBuffer();
		const webAudioContext = new (window.AudioContext || window.webkitAudioContext)();
		decodedNoiseBuffer = await webAudioContext.decodeAudioData(arrayBuf.slice(0));
		isAudioFileLoaded = true;
	} catch (e) {
		console.error("Error decoding audio data:", e);
		decodedNoiseBuffer = null;
		isAudioFileLoaded = false;
	}
}

// --------- WAV export (no deps) ---------
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

// --------- OFFLINE render (no playback) ---------
async function renderOfflineToBuffer() {
	const durationSec = Math.max(0.01, Number(length) || 0);
	if (!sequence.length) throw new Error("Sequence is empty or invalid.");

	// NEW: choose channel count dynamically (preserve stereo if input noise is stereo)
	const channels =
		decodedNoiseBuffer && decodedNoiseBuffer.numberOfChannels > 1 ? 2 : 1;

	const rendered = await Tone.Offline(({ transport }) => {
		// Carrier gated by LFO -> master
		const oscGate = new Tone.Gain(0);
		const osc = new Tone.Oscillator(carrierFreq, "sine").connect(oscGate);

		// LFO starts at the first step frequency; later steps only change it if rampDuration is provided
		const firstFreq = sequence[0].frequency;
		const lfo = new Tone.LFO(firstFreq, 0, 1, "square").connect(oscGate.gain);

		// Noise path: user file (looped) or built-in noise
		const noiseGain = new Tone.Gain(
			decodedNoiseBuffer ? parseFloat(document.getElementById("noiseVolume").value) : noiseVolume
		);

		let filter = null;
		if (noiseModulationCheckbox.checked) {
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
			if (noiseFadeCheckbox.checked) {
				const player = new Tone.Player({
					url: toneBuffer,
					loop: false,
					volume: 1,
					fadeIn: noiseFade,
					fadeOut: noiseFade
				}).connect(filter || noiseGain);
		
				const segDur = decodedNoiseBuffer.duration;
				for (let t = 0; t < durationSec; t += segDur) {
					const start = t;
					const stop  = Math.min(t + segDur, durationSec);
					if (stop - start > 0.01) {
						player.start(start);
						player.stop(stop);
					}
				}
			} else {
				const player = new Tone.Player({
					url: toneBuffer,
					loop: true,
					volume: 1
				}).connect(filter || noiseGain);
				player.start(0);
			}
		} else {
			const toneNoise = new Tone.Noise(noiseType.toLowerCase()).connect(filter || noiseGain);
			toneNoise.start(0);
		}

		// Master out
		const master = new Tone.Gain(0).toDestination();
		oscGate.connect(master);
		noiseGain.connect(master);

		// Start sources
		osc.start(0);
		lfo.start(0);

		// Schedule ramps on the OFFLINE transport (matches original semantics)
		let currentTime = 0;
		sequence.forEach(step => {
			if (step.rampDuration) {
				transport.schedule(() => {
					lfo.frequency.linearRampTo(step.frequency, step.rampDuration);
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

		transport.start(0);
	}, durationSec, alwaysMonoCheckbox.checked ? 1 : channels);

	return rendered; // AudioBuffer
}

function downloadWav(buffer) {
	const wav = audioBufferToWav(buffer);
	const blob = new Blob([wav], { type: "audio/wav" });
	const url = URL.createObjectURL(blob);
	const last = sequence[sequence.length - 1] || { frequency: 0 };
	const fileName = (document.getElementById("name").value || `${last.frequency}Hz_${carrierFreq}Hz_${noiseType}`) + ".wav";

	const a = document.createElement("a");
	a.href = url;
	a.download = fileName;
	a.textContent = "Download recording (WAV)";
	document.body.appendChild(a);
}

// --------- Start (render & download immediately) ---------
async function start() {
	playButton.disabled = true;
	try {
		initData();
		await maybeDecodeNoiseFile();

		if (noiseFileInput.files.length > 0 && !isAudioFileLoaded) {
			alert("Could not decode the selected noise file.");
			return;
		}

		const buffer = await renderOfflineToBuffer();
		downloadWav(buffer);
	} catch (e) {
		console.error(e);
		alert("Render failed. Check the console for details.");
	} finally {
		playButton.disabled = false;
	}
}

// --------- Wire up UI ---------
setTotalTime();
sequenceArea.addEventListener("input", setTotalTime);
playButton.addEventListener("click", start);