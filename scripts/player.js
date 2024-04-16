// --------- Variables ---------
const fadeIn = 10; // sec
const fadeOut = 10; // sec
const testTries = 100;
// -----------------------------

const sequence = [
	{ frequency: 20.3, duration: 30 },
	{ frequency: 14.1, duration: 30, rampDuration: 30 },
	{ frequency: 3.9, duration: 120, rampDuration: 30 },
	{ frequency: 7.83, duration: 120, rampDuration: 30 },
	{ frequency: 2.5, duration: 480, rampDuration: 30 }
];

let averageDuration = sessionStorage.getItem("averageDuration") || 0;
let xSequence;
let audio;

const audioWait = audioReady();

function calculateTimeout(frequency) {
	let timeout = (1000 - averageDuration * frequency) / frequency;
	if (frequency >= 11) {
		timeout = timeout - timeout / (20 - frequency / 2);
	}
	return Math.round(timeout);
}

function addRampSequence(newSequence, item, lastFrequency) {
	for (let i = 0; i < item.rampDuration; i++) {
		const stepFrequency = parseFloat(parseFloat(
			lastFrequency +
			((item.frequency - lastFrequency) * (i + 1) / item.rampDuration)
		).toFixed(2));

		newSequence.push({
			frequency: stepFrequency,
			duration: 1000,
			timeout: calculateTimeout(stepFrequency)
		});
	}
	newSequence.push({
		frequency: item.frequency,
		duration: item.duration * 1000,
		timeout: calculateTimeout(item.frequency)
	});
}

function convertSequence(sequence) {
	const newSequence = [];

	for (let i = 0; i < sequence.length; i++) {
		const current = sequence[i];

		if (!current.rampDuration) {
			newSequence.push({
				frequency: current.frequency,
				duration: current.duration * 1000,
				timeout: calculateTimeout(current.frequency)
			});
			continue;
		}
		addRampSequence(newSequence, current, sequence[i - 1].frequency || 0);
	}
	return newSequence;
}

function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function flicker(track) {
	await track.applyConstraints({ advanced: [{torch: true}] });
	await wait(10);
	await track.applyConstraints({ advanced: [{torch: false}] });
}

async function startFlickering(track, flickers = 0, index = 0, sequenceStart = Date.now()) {
	const sequenceDuration = Date.now() - sequenceStart;

	if (sequenceDuration > xSequence[index].duration) {
		console.log("Flickers in this sequence: " + flickers);
		if (index === xSequence.length - 1) {
			console.log("End: " + new Date().toISOString());
			return;
		}

		console.log("-----------------");
		console.log("Starting next sequence: " + new Date().toISOString());
		console.log("Frequency: " + xSequence[index + 1].frequency);

		flickers = 0;
		index++;
		sequenceStart = Date.now();
	}
	flickers++;
	await flicker(track);

	setTimeout(() => startFlickering(track, flickers, index, sequenceStart), xSequence[index].timeout);
}

async function getTrack() {
	if (!("mediaDevices" in navigator))
		return;

	const devices = await navigator.mediaDevices.enumerateDevices();
	const cameras = devices.filter((device) => device.kind === "videoinput");

	if (!cameras.length) {
		console.error("No cameras found");
		return;
	}

	const camera = cameras[cameras.length - 1];
	const stream = await navigator.mediaDevices.getUserMedia({
		video: {
			deviceId: camera.deviceId,
			facingMode: [ "user", "environment" ],
			height: { ideal: 1080 },
			width: { ideal: 1920 }
		}
	});
	const track = stream.getVideoTracks()[0];
	if (!track) {
		console.error("No video track found");
		return;
	}
	const imageCapture = new ImageCapture(track)
	await imageCapture.getPhotoCapabilities();
	return track;
}

async function calculateAverageDuration(track) {
	const start = Date.now();
	for (let i = 0; i < testTries; i++) {
		await flicker(track);
	}
	const end = Date.now();
	return (end - start) / testTries;
}

function audioReady() {
	return new Promise(resolve => {
		document.addEventListener("DOMContentLoaded", function() {
			const audio = document.getElementById("audio");
		
			audio.oncanplaythrough = function() {
				resolve(audio);
			};
		});
	});
}

async function prepareStart() {
	document.getElementById("loader").style.display = "block";
	audio = await audioWait;
	document.getElementById("loader").style.display = "none";
	document.getElementById("start").style.display = "block";
}

function extractFadeTime() {
	sequence[0].duration = sequence[0].duration - fadeIn;
	sequence[sequence.length - 1].duration = sequence[sequence.length - 1].duration - fadeOut;
}

function main() {
	document.getElementById("start").addEventListener("click", async () => {
		xSequence = convertSequence(sequence);
		const track = await getTrack();
		if (!track)
			return;

		console.log("Start: ", new Date().toISOString());
		console.log("Frequency: " + xSequence[0].frequency);

		audio.play();
		setTimeout(() => startFlickering(track), fadeIn * 1000);
	});

	if (averageDuration) {
		console.log("Average duration: ", averageDuration);
		prepareStart();
		return;
	}

	document.getElementById("test").style.display = "block";
	document.getElementById("test").addEventListener("click", async () => {
		const track = await getTrack();
		if (!track)
			return;

		averageDuration = await calculateAverageDuration(track);
		console.log("Average duration: ", averageDuration);

		if (averageDuration > 50)
			return;

		sessionStorage.setItem("averageDuration", averageDuration);
		document.getElementById("test").style.display = "none";
		prepareStart();
	});
}

main();