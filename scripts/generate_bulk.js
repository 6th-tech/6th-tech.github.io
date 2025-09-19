// --------- Bulk Generation Script ---------
// This script handles bulk audio generation from JSON configuration

let jsonConfig = null;
let audioFiles = new Map(); // filename -> File object
let isGenerating = false;

// DOM elements
const jsonFileInput = document.querySelector("#jsonFile");
const audioFolderInput = document.querySelector("#audioFolder");
const alwaysMonoCheckbox = document.querySelector("#alwaysMono");
const generateButton = document.querySelector("#generateButton");
const statusText = document.querySelector("#statusText");
const progressContainer = document.querySelector("#progressContainer");
const progressFill = document.querySelector("#progressFill");
const progressText = document.querySelector("#progressText");
const downloadsList = document.querySelector("#downloadsList");

// --------- File Handling ---------
function handleJsonFile() {
	const file = jsonFileInput.files[0];
	if (!file) {
		jsonConfig = null;
		updateUI();
		return;
	}

	const reader = new FileReader();
	reader.onload = function(e) {
		try {
			jsonConfig = JSON.parse(e.target.result);
			if (!Array.isArray(jsonConfig)) {
				throw new Error("JSON must be an array");
			}
			
			// Validate each config item
			jsonConfig.forEach((config, index) => {
				if (!config.carrierFrequency || !config.backgroundSound || !config.audioFile || !config.sequence) {
					throw new Error(`Invalid configuration at index ${index}: missing required fields`);
				}
			});
			
			statusText.textContent = `Loaded ${jsonConfig.length} configurations from JSON file.`;
			updateUI();
		} catch (error) {
			jsonConfig = null;
			statusText.innerHTML = `<div class="error-message">Error reading JSON file: ${error.message}</div>`;
			updateUI();
		}
	};
	reader.readAsText(file);
}

function handleAudioFolder() {
	const files = Array.from(audioFolderInput.files);
	audioFiles.clear();
	
	files.forEach(file => {
		if (file.type.startsWith('audio/') || file.name.toLowerCase().endsWith('.mp3')) {
			audioFiles.set(file.name, file);
		}
	});
	
	if (audioFiles.size > 0) {
		statusText.textContent = `Loaded ${audioFiles.size} audio files from directory.`;
	} else {
		statusText.innerHTML = `<div class="error-message">No audio files found in selected directory.</div>`;
	}
	updateUI();
}

function updateUI() {
	const canGenerate = jsonConfig && jsonConfig.length > 0 && audioFiles.size > 0 && !isGenerating;
	generateButton.disabled = !canGenerate;
	
	if (canGenerate && !isGenerating) {
		statusText.textContent = `Ready to generate ${jsonConfig.length} audio files.`;
	}
}

// --------- Validation Functions ---------
function validateJsonConfig() {
	if (!jsonConfig || !jsonConfig.length) {
		throw new Error("No JSON configuration loaded");
	}

	const errors = [];

	jsonConfig.forEach((config, index) => {
		// Check sequence duration (should be 11 minutes = 660 seconds)
		try {
			const { length } = parseSequence(config.sequence);
			const durationMinutes = length / 60;
			if (Math.abs(durationMinutes - 11) > 0.1) { // Allow small tolerance
				errors.push(`Configuration ${index + 1} (${config.audioFile}): Sequence duration is ${durationMinutes.toFixed(1)} minutes, should be 11 minutes`);
			}
		} catch (e) {
			errors.push(`Configuration ${index + 1} (${config.audioFile}): Invalid sequence format`);
		}

		// Check if background sound file exists (when not white/pink/brown)
		if (!isNoiseType(config.backgroundSound)) {
			if (!audioFiles.has(config.backgroundSound)) {
				errors.push(`Configuration ${index + 1} (${config.audioFile}): Background sound file '${config.backgroundSound}' not found in selected directory`);
			}
		}
	});

	if (errors.length > 0) {
		throw new Error("Validation failed:\n" + errors.join("\n"));
	}
}

// --------- Audio Generation ---------
function getBulkGenerationRules(backgroundSound) {
	const isNoise = isNoiseType(backgroundSound);
	
	return {
		useNoiseModulation: isNoise,
		useNoiseFade: !isNoise,
		customNoiseVolume: isNoise ? null : 0.2
	};
}

async function generateSingleAudio(config, index) {
	const { carrierFrequency, backgroundSound, audioFile, sequence } = config;
	console.log(`--------- Generating audio file ${audioFile} ---------`);
	// Create download item in UI
	const downloadItem = document.createElement('div');
	downloadItem.className = 'download-item generating';
	downloadItem.innerHTML = `
		<span>${audioFile} (${carrierFrequency}Hz, ${backgroundSound})</span>
		<span>Generating...</span>
	`;
	downloadsList.appendChild(downloadItem);
	
	try {
		// Parse sequence
		const { sequence: parsedSequence, length } = parseSequence(sequence);
		
		// Get generation rules
		const rules = getBulkGenerationRules(backgroundSound);
		
		// Handle background sound
		let decodedNoiseBuffer = null;
		let noiseType = backgroundSound;
		
		if (!isNoiseType(backgroundSound)) {
			// It's a custom audio file
			const audioFile = audioFiles.get(backgroundSound);
			if (!audioFile) {
				throw new Error(`Audio file not found: ${backgroundSound}`);
			}
			decodedNoiseBuffer = await decodeAudioFile(audioFile);
			noiseType = 'custom';
		}
		
		// Generate audio
		const audioOptions = {
			sequence: parsedSequence,
			length,
			carrierFreq: carrierFrequency,
			noiseType,
			mainVolume: 0.7,
			useNoiseModulation: rules.useNoiseModulation,
			useNoiseFade: rules.useNoiseFade,
			alwaysMono: alwaysMonoCheckbox.checked,
			decodedNoiseBuffer,
			customNoiseVolume: rules.customNoiseVolume
		};
		
		const audioBuffer = await generateAudio(audioOptions);
		
		// Generate filename and download
		const fileName = `${config.audioFile}.wav`;
		downloadWav(audioBuffer, fileName);
		
		// Update UI
		downloadItem.className = 'download-item completed';
		downloadItem.innerHTML = `
			<span>${audioFile} (${carrierFrequency}Hz, ${backgroundSound})</span>
			<span class="success-message">&#10003; Generated: ${fileName}</span>
		`;
		
		return true;
		
	} catch (error) {
		console.error(`Error generating ${audioFile}:`, error);
		downloadItem.className = 'download-item error';
		downloadItem.innerHTML = `
			<span>${audioFile} (${carrierFrequency}Hz, ${backgroundSound})</span>
			<span class="error-message">&#10007; Error: ${error.message}</span>
		`;
		return false;
	}
}

async function generateAll() {
	if (isGenerating || !jsonConfig || !jsonConfig.length) return;
	
	// Validate configuration before starting
	try {
		validateJsonConfig();
	} catch (error) {
		statusText.innerHTML = `<div class="error-message">${error.message.replace(/\n/g, '<br>')}</div>`;
		return;
	}
	
	isGenerating = true;
	generateButton.disabled = true;
	
	// Clear previous downloads
	downloadsList.innerHTML = '';
	
	// Show progress
	progressContainer.style.display = 'block';
	progressFill.style.width = '0%';
	progressText.textContent = `0 / ${jsonConfig.length}`;
	
	let completed = 0;
	let successful = 0;
	
	statusText.textContent = 'Generating audio files...';
	
	// Generate each audio file sequentially
	for (let i = 0; i < jsonConfig.length; i++) {
		const config = jsonConfig[i];
		
		try {
			const success = await generateSingleAudio(config, i);
			if (success) successful++;
		} catch (error) {
			console.error(`Failed to generate audio for config ${i}:`, error);
		}
		
		completed++;
		
		// Update progress
		const progress = (completed / jsonConfig.length) * 100;
		progressFill.style.width = `${progress}%`;
		progressText.textContent = `${completed} / ${jsonConfig.length}`;
		
		// Small delay to prevent UI blocking
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	
	// Final status
	statusText.innerHTML = `
		<div class="success-message">
			Generation complete! ${successful} of ${jsonConfig.length} files generated successfully.
		</div>
	`;
	
	isGenerating = false;
	updateUI();
}

// --------- Event Listeners ---------
jsonFileInput.addEventListener('change', handleJsonFile);
audioFolderInput.addEventListener('change', handleAudioFolder);
generateButton.addEventListener('click', generateAll);

// Initial UI update
updateUI();
