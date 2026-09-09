#!/usr/bin/env node
/* Runs the in-app e2e harness (/?test=1) against a throwaway server using
   headless Chromium. Exits 1 if any test fails.

   Chromium lookup order: $CHROME_PATH, common Windows/macOS install paths,
   then google-chrome/chromium/msedge on PATH. GitHub-hosted runners ship
   google-chrome preinstalled. */
const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = process.env.DRAWRDIS_PORT || 3999;
const BASE = `http://127.0.0.1:${PORT}`;
// Board e portfile descartáveis: o harness nunca toca no board.json nem no
// .drawrdis-port reais (o servidor em teste compartilha o código com o do usuário).
const TMP_BOARD = path.join(os.tmpdir(), 'drawrdis-e2e-board.json');
const TMP_PORT = path.join(os.tmpdir(), 'drawrdis-e2e.port');
const cleanup = () => { try { fs.rmSync(TMP_BOARD, { force: true }); fs.rmSync(TMP_PORT, { force: true }); } catch { /* ok */ } };
cleanup();
const env = { ...process.env, DRAWRDIS_PORT: String(PORT), DRAWRDIS_BOARD: TMP_BOARD, DRAWRDIS_PORTFILE: TMP_PORT };

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });

function get(u) {
  return new Promise((res, rej) => {
    http.get(u, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res(b)); }).on('error', rej);
  });
}

async function waitServer() {
  for (let i = 0; i < 40; i++) {
    try { await get(BASE + '/scene'); return; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error('server did not start on port ' + PORT);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium', 'msedge',
  ].filter(Boolean);
  for (const c of candidates) {
    // on Windows, `chrome.exe --version` launches the browser and never returns.
    // For absolute paths just check the file exists; only probe bare PATH names.
    if (path.isAbsolute(c)) { if (fs.existsSync(c)) return c; continue; }
    try { execSync(`"${c}" --version`, { stdio: 'ignore', timeout: 5000 }); return c; } catch { /* next */ }
  }
  throw new Error('no Chromium found; install Google Chrome or set CHROME_PATH');
}

(async () => {
  await waitServer();
  const chrome = findChrome();
  const dom = execSync(
    `"${chrome}" --headless=new --disable-gpu --no-sandbox --virtual-time-budget=18000 --dump-dom "${BASE}/?snap&test=1"`,
    { maxBuffer: 1e8 }
  ).toString();

  const m = dom.match(/<pre id="testout"[^>]*>([\s\S]*?)<\/pre>/);
  if (!m) { console.error('harness did not run'); process.exit(1); }
  const txt = m[1].replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').trim();
  console.log(txt);
  const fails = txt.split('\n').filter(l => l.startsWith('FAIL'));
  process.exit(fails.length ? 1 : 0);
})().catch(err => { console.error(err.message); process.exitCode = 1; }).finally(() => { server.kill(); cleanup(); });
