// --------- Variables ---------
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
function parseSequenceFromTextArea() {
	const parsed = parseSequence(sequenceArea.value);
	sequence = parsed.sequence;
	length = parsed.length;
}

function setTotalTime() {
	parseSequenceFromTextArea();
	document.getElementById("totalTime").textContent = `${length / 60}min`;
}

function initData() {
	parseSequenceFromTextArea();
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
		decodedNoiseBuffer = await decodeAudioFile(file);
		isAudioFileLoaded = true;
	} catch (e) {
		console.error("Error decoding audio data:", e);
		decodedNoiseBuffer = null;
		isAudioFileLoaded = false;
	}
}

// WAV export functions are now in audio-core.js

// --------- OFFLINE render (no playback) ---------
async function renderOfflineToBuffer() {
	const audioOptions = {
		sequence,
		length,
		carrierFreq,
		noiseType,
		mainVolume,
		useNoiseModulation: noiseModulationCheckbox.checked,
		useNoiseFade: noiseFadeCheckbox.checked,
		alwaysMono: alwaysMonoCheckbox.checked,
		decodedNoiseBuffer,
		customNoiseVolume: decodedNoiseBuffer ? parseFloat(document.getElementById("noiseVolume").value) : null
	};
	
	return await generateAudio(audioOptions);
}

function downloadWavFromUI(buffer) {
	const last = sequence[sequence.length - 1] || { frequency: 0 };
	const fileName = (document.getElementById("name").value || `${last.frequency}Hz_${carrierFreq}Hz_${noiseType}`) + ".wav";
	downloadWav(buffer, fileName);
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
		downloadWavFromUI(buffer);
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