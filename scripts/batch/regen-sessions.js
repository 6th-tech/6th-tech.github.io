#!/usr/bin/env node
// Batch-render sessions headlessly with the SAME generator code the web pages use.
//
//   node scripts/batch/regen-sessions.js --sessions <sessions.json> --sounds <dir[,dir...]> --out <dir>
//        [--only "Healing vibes,sleep_well"] [--long-only | --short-only]
//        [--binaural 1] [--offset 150] [--dip 12] [--iso 0.35] [--punch 2] [--bg-volume 0.5] [--main 0.7]
//        [--rate 48000] [--playwright <playwright-core dir>] [--chrome <headless_shell executable>]
//
// What it does: starts a small local HTTP server that serves this repo (generate.html +
// scripts), the background sound folders and the sessions JSON; launches headless Chromium through playwright-core; and for every
// session renders the long and the short sequence with generateAudio() exactly as the bulk
// page would, saving <audioFile>.wav / <audioFile>.short.wav into --out through the browser's own download path. Files that already exist with
// the expected size are skipped, so an interrupted run can simply be restarted.
//
// playwright-core and a Chromium build are picked up from the Playwright MCP's npx cache
// (~/.npm/_npx/*/node_modules/playwright-core) and browser cache
// (~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-mac/headless_shell)
// unless --playwright / --chrome are given. Convert the WAVs afterwards with ./generate.sh <dir>.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const url = require('url');

const REPO = path.resolve(__dirname, '..', '..');

function arg(name, def) {
	const i = process.argv.indexOf('--' + name);
	return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes('--' + name);

const SESSIONS = arg('sessions'), SOUNDS = (arg('sounds', '') || '').split(',').filter(Boolean), OUT = arg('out');
if (!SESSIONS || !SOUNDS.length || !OUT) {
	console.error('usage: node scripts/batch/regen-sessions.js --sessions <json> --sounds <dir[,dir]> --out <dir> [options]');
	process.exit(1);
}
const ONLY = (arg('only', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const OPTS = {
	useBinaural: arg('binaural', '1') !== '0',
	binauralCarrierOffset: parseFloat(arg('offset', '150')),
	carrierDipDb: parseFloat(arg('dip', '12')),
	isochronicVolume: parseFloat(arg('iso', '0.35')),
	isochronicPunch: parseFloat(arg('punch', '2')),
	customNoiseVolume: parseFloat(arg('bg-volume', '0.5')),
	mainVolume: parseFloat(arg('main', '0.7')),
	outputSampleRate: parseInt(arg('rate', '48000'), 10)
};
const VARIANTS = has('long-only') ? [false] : (has('short-only') ? [true] : [false, true]);

function findPlaywright() {
	if (arg('playwright')) return arg('playwright');
	const base = path.join(os.homedir(), '.npm', '_npx');
	const hits = fs.existsSync(base) ? fs.readdirSync(base).map(d => path.join(base, d, 'node_modules', 'playwright-core')).filter(p => fs.existsSync(p)) : [];
	if (!hits.length) throw new Error('playwright-core not found; pass --playwright <dir>');
	return hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}
function findChrome() {
	if (arg('chrome')) return arg('chrome');
	const base = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
	const hits = fs.existsSync(base) ? fs.readdirSync(base).filter(d => d.startsWith('chromium_headless_shell-')).map(d => path.join(base, d, 'chrome-mac', 'headless_shell')).filter(p => fs.existsSync(p)) : [];
	if (!hits.length) throw new Error('headless_shell not found; pass --chrome <executable>');
	return hits.sort().pop();
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.svg': 'image/svg+xml' };
function serveFile(res, file) {
	fs.stat(file, (err, st) => {
		if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
		res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
		fs.createReadStream(file).pipe(res);
	});
}
function startServer() {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			const u = url.parse(req.url, true);
			const p = decodeURIComponent(u.pathname);
			if (p === '/sessions.json') return serveFile(res, SESSIONS);
			if (p.startsWith('/sounds/')) {
				const name = path.basename(p.slice('/sounds/'.length));
				for (const dir of SOUNDS) { const f = path.join(dir, name); if (fs.existsSync(f)) return serveFile(res, f); }
				res.writeHead(404); res.end('sound not found'); return;
			}
			const safe = path.normalize(p).replace(/^(\.\.[\/\\])+/, '');
			return serveFile(res, path.join(REPO, safe === '/' ? 'generate.html' : safe));
		});
		server.listen(0, '127.0.0.1', () => resolve(server));
	});
}

(async () => {
	fs.mkdirSync(OUT, { recursive: true });
	const server = await startServer();
	const port = server.address().port;
	const { chromium } = require(findPlaywright());
	const browser = await chromium.launch({ headless: true, executablePath: findChrome() });
	const page = await browser.newPage({ acceptDownloads: true });
	page.setDefaultTimeout(0);
	page.on('console', (msg) => { const t = msg.text(); if (/Pre-flight|Normalisation|Limiter|Output peak|Background source/.test(t)) console.log('   ' + t.trim()); });
	page.on('pageerror', (e) => console.log('   PAGE ERROR ' + e.message));
	await page.goto(`http://127.0.0.1:${port}/generate.html`, { waitUntil: 'load' });
	const ok = await page.evaluate(() => typeof generateAudio === 'function' && typeof AudioAnalysis === 'object' && typeof audioBufferToWav === 'function');
	if (!ok) throw new Error('generate.html did not load the generator scripts');

	const sessions = JSON.parse(fs.readFileSync(SESSIONS, 'utf8'));
	let done = 0, skipped = 0, failed = 0;
	for (const s of sessions) {
		if (ONLY.length && !ONLY.some(o => s.name.toLowerCase().includes(o.toLowerCase()) || s.audioFile.includes(o))) continue;
		for (const short of VARIANTS) {
			const seqText = short ? s.shortSequence : s.sequence;
			if (!seqText) { console.log(`no ${short ? 'short' : 'long'} sequence for ${s.name}`); continue; }
			const fname = s.audioFile + (short ? '.short.wav' : '.wav');
			const target = path.join(OUT, fname);
			const t0 = Date.now();
			try {
				const probe = await page.evaluate(({ seqText }) => parseSequence(seqText).length, { seqText });
				const expected = 44 + Math.round(probe) * OPTS.outputSampleRate * 2 * 2; // stereo 16-bit
				if (fs.existsSync(target) && fs.statSync(target).size === expected) { console.log(`skip ${fname} (complete)`); skipped++; continue; }
				const [download, res] = await Promise.all([page.waitForEvent('download'), page.evaluate(async ({ s, short, OPTS }) => {
					const isNoise = ['white', 'pink', 'brown'].includes(s.backgroundSound.toLowerCase());
					window.__ctx = window.__ctx || new (window.AudioContext || window.webkitAudioContext)();
					window.__bg = window.__bg || {};
					let bg = null;
					if (!isNoise) {
						if (!window.__bg[s.backgroundSound]) {
							const r = await fetch('/sounds/' + encodeURIComponent(s.backgroundSound));
							if (!r.ok) throw new Error('background not found: ' + s.backgroundSound);
							window.__bg = { [s.backgroundSound]: await window.__ctx.decodeAudioData(await r.arrayBuffer()) };
						}
						bg = window.__bg[s.backgroundSound];
					}
					const parsed = parseSequence(short ? s.shortSequence : s.sequence);
					let preflight = null;
					if (bg && !short) preflight = AudioAnalysis.analyzeBackground(bg, parsed.sequence, { targetVolume: OPTS.customNoiseVolume, isochronicVolume: OPTS.isochronicVolume, useBinaural: OPTS.useBinaural, binauralCarrierOffset: OPTS.binauralCarrierOffset, carrierDipDb: OPTS.carrierDipDb }).summary;
					const buf = await generateAudio(Object.assign({
						sequence: parsed.sequence, length: parsed.length,
						noiseType: isNoise ? s.backgroundSound : 'custom',
						useNoiseModulation: isNoise, useNoiseFade: !isNoise, alwaysMono: false,
						decodedNoiseBuffer: bg, muteIsochronic: false
					}, OPTS));
					let peak = 0; const x = buf.getChannelData(0); for (let i = 0; i < x.length; i += 5) { const a = Math.abs(x[i]); if (a > peak) peak = a; }
					const bytes = 44 + buf.length * buf.numberOfChannels * 2;
					downloadWav(buf, s.audioFile + (short ? '.short.wav' : '.wav')); // browser download: bytes never cross the automation pipe
					return { ch: buf.numberOfChannels, fs: buf.sampleRate, sec: Math.round(buf.length / buf.sampleRate), mb: +(bytes / 1048576).toFixed(1), peak: +peak.toFixed(3), preflight };
				}, { s, short, OPTS })]);
				await download.saveAs(target);
				const saved = fs.statSync(target).size;
				console.log(`${fname}: ${res.ch}ch ${res.fs}Hz ${res.sec}s ${res.mb}MB saved=${saved}${saved === expected ? '' : ' SIZE MISMATCH'} peak=${res.peak} in ${((Date.now() - t0) / 1000).toFixed(1)}s${res.preflight ? '\n   pre-flight: ' + res.preflight : ''}`);
				done++;
			} catch (e) {
				console.log(`FAILED ${fname}: ${e.message}`);
				failed++;
			}
		}
	}
	await browser.close();
	server.close();
	console.log(`\nrendered ${done}, skipped ${skipped}, failed ${failed} -> ${OUT}`);
	process.exit(failed ? 2 : 0);
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
