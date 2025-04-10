// --------- Variables ---------
const fadeIn = 10; // sec
const fadeOut = 10; // sec
const finalBuffer = 3; // sec
const noiseVolume = 0.15;
const mainVolume = 0.8;
// -----------------------------

const playButton = document.querySelector("#playButton");
const sequenceArea = document.querySelector("#sequence");
const noiseFileInput = document.querySelector("#noiseFile");
const noiseModulationCheckbox = document.querySelector("#noiseModulation");

let sequence, noiseType, carrierFreq, length;
let oscillator, lfo, noiseFilter, noise, masterGain, recorder;
let audioFilePlayer;
let isAudioFileLoaded = false;

function parseSequence() {
	sequence = sequenceArea.value
		.trim().split("\n")
		.map(x => {
			const [ frequency, duration, rampDuration ] = x.split(",").map(x => x && parseFloat(x.trim()));
			return { frequency, duration, rampDuration };
		});
	length = sequence.reduce((acc, { duration, rampDuration = 0 }) => acc + duration + rampDuration, 0);
}

function setTotalTime() {
	parseSequence();
	document.getElementById("totalTime").textContent = `${length / 60}min`;
}

function initData() {
	parseSequence();
	noiseType = document.getElementById("noiseType").value;
	carrierFreq = parseInt(document.getElementById("carrierFreq").value);
}

function initAudio() {
	const oscillatorGain = new Tone.Gain(0);
	oscillator = new Tone.Oscillator(carrierFreq, "sine")
		.connect(oscillatorGain);
	lfo = new Tone.LFO(sequence[0].frequency, 0, 1, "square")
		.connect(oscillatorGain.gain);

	const useNoiseFile = noiseFileInput.files.length > 0;
	const noiseGain = new Tone.Gain(useNoiseFile ? mainVolume : noiseVolume);
	
	// Only create noise filter if modulation is enabled
	if (noiseModulationCheckbox.checked) {
		noiseFilter = new Tone.AutoFilter(
			{
				"frequency": "8m",
				"min": 800,
				"max": 15000
			})
			.connect(noiseGain);
	} else {
		noiseFilter = null;
	}

	// Check if a file is selected
	if (useNoiseFile) {
		const file = noiseFileInput.files[0];
		const reader = new FileReader();
		reader.onload = (e) => {
			const webAudioContext = new (window.AudioContext || window.webkitAudioContext)();
			webAudioContext.decodeAudioData(e.target.result, (buffer) => {
				const toneBuffer = new Tone.Buffer(buffer);
				audioFilePlayer = new Tone.Player({
					url: toneBuffer,
					loop: true,
					volume: 1
				}).connect(noiseFilter || noiseGain);
				isAudioFileLoaded = true;
				console.log("Audio file loaded successfully");
			}, (error) => {
				console.error("Error decoding audio data:", error);
				isAudioFileLoaded = false;
			});
		};
		reader.onerror = (error) => {
			console.error("Error reading file:", error);
			isAudioFileLoaded = false;
		};
		reader.readAsArrayBuffer(file);
	} else {
		noise = new Tone.Noise(noiseType.toLowerCase())
			.connect(noiseFilter || noiseGain);
		isAudioFileLoaded = true;
	}

	masterGain = new Tone.Gain(0).toDestination();
	oscillatorGain.connect(masterGain);
	noiseGain.connect(masterGain);

	recorder = new Tone.Recorder();
	masterGain.connect(recorder);
}

function init() {
	initData();
	initAudio();
}

function scheduleRamp(currentTime, step) {
	Tone.Transport.schedule(time => {
		console.log(`${time} - ${time + step.rampDuration}: ${step.frequency}`);

		lfo.frequency.linearRampTo(step.frequency, step.rampDuration);
	}, currentTime);
}

function scheduleFrequncyChanges() {
	let currentTime = 0;
	sequence.forEach(step => {
		if (step.rampDuration) {
			scheduleRamp(currentTime, step);
		}
		currentTime += step.duration + (step.rampDuration || 0);
	});
}

async function stopRecording() {
	const recording = await recorder.stop();

	const url = URL.createObjectURL(recording);
	const downloadLink = document.createElement("a");
	downloadLink.href = url;
	const fileName = `${sequence[sequence.length - 1].frequency}Hz_${carrierFreq}Hz_${noiseType}.webm`;
	downloadLink.download = fileName;
	downloadLink.textContent = "Download recording";
	document.body.appendChild(downloadLink);
}

function setFadeInAndOut() {
	masterGain.gain.rampTo(mainVolume, fadeIn);

	setTimeout(() => {
		masterGain.gain.rampTo(0, fadeOut);
	}, (length - fadeOut - finalBuffer) * 1000);
}

function start() {
	playButton.disabled = true;

	if (audioFilePlayer) {
		audioFilePlayer.start();
	} else {
		noise.start();
	}
	if (noiseFilter) {
		noiseFilter.start();
	}
	oscillator.start();
	lfo.start();

	scheduleFrequncyChanges();
	Tone.Transport.start();

	recorder.start();

	setFadeInAndOut();
}

function stop() {
	Tone.Transport.stop();

	if (audioFilePlayer) {
		audioFilePlayer.stop();
	} else {
		noise.stop();
	}
	if (noiseFilter) {
		noiseFilter.stop();
	}
	oscillator.stop();
	lfo.stop();

	stopRecording();
}

setTotalTime();

sequenceArea.addEventListener("input", async () => {
	setTotalTime();
});

playButton.addEventListener("click", async () => {
	init();
	
	// Wait for audio file to be loaded if one is selected
	if (noiseFileInput.files.length > 0) {
		while (!isAudioFileLoaded) {
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	}

	start();

	setTimeout(() => {
		stop();
	}, length * 1000);
});