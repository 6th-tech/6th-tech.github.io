#!/usr/bin/env node
// Run the in-page pre-flight analyzer (scripts/audio-analysis.js) headlessly — the exact
// code path the generator pages use — for one or more sessions of a sessions JSON.
//
//   node scripts/batch/preflight.js --sessions <sessions.json> --sounds <dir[,dir...]> [--only "name,name"]
//        [--binaural 1] [--offset 150] [--dip 12] [--iso 0.35] [--bg-volume 0.5] [--json]
//
// Prints the summary and the per-carrier lines for each session (or the raw report with --json).
// Uses playwright-core and the headless_shell from the Playwright caches, like regen-sessions.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const url = require('url');

const REPO = path.resolve(__dirname, '..', '..');
function arg(name, def) { const i = process.argv.indexOf('--' + name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const has = (name) => process.argv.includes('--' + name);
const SESSIONS = arg('sessions'), SOUNDS = (arg('sounds', '') || '').split(',').filter(Boolean);
if (!SESSIONS || !SOUNDS.length) { console.error('usage: node scripts/batch/preflight.js --sessions <json> --sounds <dir[,dir]> [--only names]'); process.exit(1); }
const ONLY = (arg('only', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const OPTS = {
	useBinaural: arg('binaural', '1') !== '0',
	binauralCarrierOffset: parseFloat(arg('offset', '150')),
	carrierDipDb: parseFloat(arg('dip', '12')),
	isochronicVolume: parseFloat(arg('iso', '0.35')),
	targetVolume: parseFloat(arg('bg-volume', '0.25'))
};

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
			const p = decodeURIComponent(url.parse(req.url).pathname);
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
	const server = await startServer();
	const port = server.address().port;
	const { chromium } = require(findPlaywright());
	const browser = await chromium.launch({ headless: true, executablePath: findChrome() });
	const page = await browser.newPage();
	page.setDefaultTimeout(0);
	await page.goto(`http://127.0.0.1:${port}/generate.html`, { waitUntil: 'load' });
	const sessions = JSON.parse(fs.readFileSync(SESSIONS, 'utf8'));
	const out = [];
	for (const s of sessions) {
		if (ONLY.length && !ONLY.some(o => s.name.toLowerCase().includes(o.toLowerCase()) || (s.audioFile || '').includes(o))) continue;
		if (['white', 'pink', 'brown'].includes(String(s.backgroundSound).toLowerCase())) continue;
		const report = await page.evaluate(async ({ s, OPTS }) => {
			window.__ctx = window.__ctx || new (window.AudioContext || window.webkitAudioContext)();
			const r = await fetch('/sounds/' + encodeURIComponent(s.backgroundSound));
			if (!r.ok) throw new Error('background not found: ' + s.backgroundSound);
			const buf = await window.__ctx.decodeAudioData(await r.arrayBuffer());
			const parsed = parseSequence(s.sequence);
			return AudioAnalysis.analyzeBackground(buf, parsed.sequence, OPTS);
		}, { s, OPTS });
		out.push({ session: s.name, file: s.backgroundSound, report });
		if (!has('json')) {
			console.log(`\n${s.name}  <-  ${s.backgroundSound}\n  ${report.summary}`);
			report.lines.forEach(l => console.log('   ' + l));
		}
	}
	if (has('json')) console.log(JSON.stringify(out, null, 1));
	await browser.close();
	server.close();
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
