// Drawrdis — quadro compartilhado local, zero dependências.
//
// Rotas:
//   GET  /                → editor (public/index.html, lido a cada request)
//   GET  /scene           → quadro em JSON (inclui rev, o número da versão)
//   POST /scene           → substitui o quadro inteiro (409 se ?rev=N não bater)
//   POST /sync            → aplica diff por item {add,update,remove,order}; merge seguro com o agente
//   POST /items           → adiciona item (objeto) ou itens (array)
//   DELETE /items/<id>    → remove item pelo id
//   GET  /wait            → long-poll ?rev=N&timeout=ms; resolve quando a rev mudar
//   GET  /events          → SSE; avisa quando board.json muda
//
// O quadro vive em board.json (ou DRAWRDIS_BOARD). Toda escrita incrementa
// `rev` e é feita via tmp+rename (leitores nunca veem JSON pela metade).
// Quem escrever no arquivo (editor, curl, agente) dispara atualização ao vivo
// em todo navegador aberto.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const BOARD = process.env.DRAWRDIS_BOARD ? path.resolve(process.env.DRAWRDIS_BOARD) : path.join(ROOT, 'board.json');
const BOARDS_DIR = path.join(path.dirname(BOARD), 'boards');
const INDEX = path.join(ROOT, 'public', 'index.html');
const PORTFILE = process.env.DRAWRDIS_PORTFILE ? path.resolve(process.env.DRAWRDIS_PORTFILE) : path.join(ROOT, '.drawrdis-port');

const slugify = (name) => String(name)
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/\s+/g, '-')
  .toLowerCase() || 'quadro';

const uid = () => crypto.randomBytes(8).toString('hex');
const KNOWN = new Set(['rect', 'ellipse', 'diamond', 'text', 'line', 'arrow', 'draw', 'image']);
const isFin = (v) => typeof v === 'number' && Number.isFinite(v);
const GEOM = ['x', 'y', 'w', 'h', 'x2', 'y2', 'fontSize', 'angle', 'strokeWidth', 'opacity', 'r'];
const badPts = (arr) => !Array.isArray(arr) || arr.some(p => !Array.isArray(p) || !isFin(p[0]) || !isFin(p[1]));

function validateItems(items) {
  // rejeita na origem: board.json nunca guarda NaN/Infinity, então nenhum
  // cliente (editor, agente, curl) pode travar o zoom ao carregar o quadro
  for (const it of items) {
    if (!KNOWN.has(it.type)) throw new Error(`item com type desconhecido: ${it.type}`);
    for (const k of GEOM) {
      if (it[k] !== undefined && !isFin(it[k])) throw new Error(`item ${it.id || '?'} tem ${k} não-numérico (${it[k]})`);
    }
    if (it.points !== undefined && badPts(it.points)) throw new Error(`item ${it.id || '?'} tem points inválidas`);
    if (it.mids !== undefined && badPts(it.mids)) throw new Error(`item ${it.id || '?'} tem mids inválidas`);
  }
}

function frame(x, label) {
  return [
    { id: uid(), type: 'rect', x, y: 0, w: 340, h: 660, r: 24, strokeWidth: 3, stroke: '#1f1a17', fill: '#ffffff' },
    { id: uid(), type: 'text', text: label, x: x + 170, y: -52, fontSize: 20, bold: true, stroke: '#1f1a17', align: 'center' },
  ];
}

const buildSeed = () => ({
  version: 1,
  title: 'Drawrdis',
  items: [
    { id: uid(), type: 'text', text: 'Drawrdis', x: 510, y: -120, fontSize: 28, bold: true, stroke: '#1f1a17', align: 'center' },
    ...frame(0, 'Tela 1'),
    ...frame(420, 'Tela 2'),
    ...frame(840, 'Tela 3'),
  ],
});
const SEED = buildSeed();

let lastGood = null;

// waiters do long-poll /wait: resolvidos quando a rev passa da esperada
const waiters = new Set();
function flushWaiters(rev) {
  for (const w of [...waiters]) {
    if (rev > w.minRev) {
      waiters.delete(w);
      clearTimeout(w.timer);
      try { w.done({ changed: true, rev }); } catch { /* cliente já foi */ }
    }
  }
}

function readBoard() {
  try {
    const scene = JSON.parse(fs.readFileSync(BOARD, 'utf8'));
    if (!Array.isArray(scene.items)) throw new Error('items ausente');
    lastGood = scene;
    return scene;
  } catch {
    return lastGood;
  }
}

function writeBoard(scene) {
  if (!Array.isArray(scene.items)) throw new Error('quadro inválido: items ausente');
  validateItems(scene.items);
  scene.rev = ((lastGood && lastGood.rev) || 0) + 1;
  lastGood = scene;
  // tmp + rename: escrita atômica, nenhum leitor vê JSON pela metade
  const tmp = BOARD + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(scene, null, 2));
  fs.renameSync(tmp, BOARD);
  flushWaiters(scene.rev);
}

if (!readBoard()) writeBoard(SEED);

const clients = new Set();

function broadcast(scene) {
  const payload = `event: scene\ndata: ${JSON.stringify(scene)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

let watchTimer = null;
const BOARD_BASE = path.basename(BOARD);
fs.watch(path.dirname(BOARD), (_event, filename) => {
  if (filename && filename !== BOARD_BASE) return;
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    const scene = readBoard();
    if (scene) broadcast(scene);
  }, 120);
});

setInterval(() => {
  for (const res of clients) {
    try { res.write(': ping\n\n'); } catch { clients.delete(res); }
  }
}, 25000).unref();

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > 25e6) {
        reject(new Error('corpo grande demais'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  try {
    // anti DNS-rebinding: só aceita requisições endereçadas a localhost
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]' && host !== '::1') {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('proibido');
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(INDEX));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico')) {
      const file = path.join(ROOT, 'public', url.pathname === '/favicon.ico' ? 'favicon.ico' : 'favicon.svg');
      const data = fs.readFileSync(file);
      res.writeHead(200, { 'content-type': url.pathname === '/favicon.ico' ? 'image/x-icon' : 'image/svg+xml' });
      res.end(data);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/scene') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(readBoard() ?? SEED));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write('retry: 1500\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/wait') {
      const minRev = Number(url.searchParams.get('rev')) || 0;
      const timeout = Math.min(Math.max(Number(url.searchParams.get('timeout')) || 20000, 100), 120000);
      const sendJson = (obj) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };
      const cur = readBoard();
      if (cur && (cur.rev || 0) > minRev) { sendJson({ changed: true, rev: cur.rev }); return; }
      const w = {
        minRev,
        done: sendJson,
        timer: setTimeout(() => {
          waiters.delete(w);
          const c = readBoard();
          try { sendJson({ changed: false, rev: c ? (c.rev || 0) : 0 }); } catch { /* cliente foi */ }
        }, timeout),
      };
      waiters.add(w);
      req.on('close', () => { if (waiters.delete(w)) clearTimeout(w.timer); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/scene') {
      const scene = JSON.parse(await readBody(req));
      const expect = url.searchParams.get('rev');
      if (expect !== null) {
        const cur = readBoard();
        if (!cur || (cur.rev || 0) !== Number(expect)) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ erro: 'rev desatualizada', rev: cur ? (cur.rev || 0) : 0 }));
          return;
        }
      }
      writeBoard(scene);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/sync') {
      const body = JSON.parse(await readBody(req));
      const scene = readBoard() ?? buildSeed();
      const byId = new Map(scene.items.map(i => [i.id, i]));
      for (const id of body.remove || []) byId.delete(String(id));
      for (const it of body.update || []) {
        if (!it || !it.id) throw new Error('update sem id');
        byId.set(String(it.id), it);
      }
      for (const it of body.add || []) {
        if (!it || !it.id) throw new Error('add sem id');
        byId.set(String(it.id), it);
      }
      scene.items = [...byId.values()];
      if (Array.isArray(body.order)) {
        const pos = new Map(body.order.map((id, i) => [String(id), i]));
        scene.items.sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : 1e9) - (pos.has(b.id) ? pos.get(b.id) : 1e9));
      }
      writeBoard(scene);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rev: scene.rev }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/items') {
      const body = JSON.parse(await readBody(req));
      const scene = readBoard() ?? buildSeed();
      const add = Array.isArray(body) ? body : [body];
      for (const it of add) {
        it.id = it.id || uid();
        scene.items.push(it);
      }
      writeBoard(scene);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ids: add.map((i) => i.id) }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/boards') {
      fs.mkdirSync(BOARDS_DIR, { recursive: true });
      const list = fs.readdirSync(BOARDS_DIR)
        .filter(f => f.endsWith('.json') && !f.startsWith('_'))
        .map(f => {
          try {
            const st = fs.statSync(path.join(BOARDS_DIR, f));
            const sc = JSON.parse(fs.readFileSync(path.join(BOARDS_DIR, f), 'utf8'));
            return { file: f.replace(/\.json$/, ''), title: sc.title || f.replace(/\.json$/, ''), date: st.mtime.toISOString(), items: Array.isArray(sc.items) ? sc.items.length : 0 };
          } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => b.date.localeCompare(a.date));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(list));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/boards') {
      const body = JSON.parse(await readBody(req));
      const slug = slugify(body.name || 'quadro');
      if (!body.scene || !Array.isArray(body.scene.items)) throw new Error('cena inválida');
      fs.mkdirSync(BOARDS_DIR, { recursive: true });
      fs.writeFileSync(path.join(BOARDS_DIR, slug + '.json'), JSON.stringify({ ...body.scene, title: body.name }, null, 2));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, file: slug }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/open') {
      const scene = JSON.parse(await readBody(req));
      if (!Array.isArray(scene.items)) throw new Error('cena inválida: items ausente');
      fs.mkdirSync(BOARDS_DIR, { recursive: true });
      try {
        const cur = fs.readFileSync(BOARD, 'utf8');
        fs.writeFileSync(path.join(BOARDS_DIR, '_auto-backup.json'), cur);
      } catch { /* sem quadro anterior */ }
      writeBoard(scene);
      broadcast(scene);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    const bget = req.method === 'GET' && url.pathname.match(/^\/boards\/([\w-]+)$/);
    if (bget) {
      const f = path.join(BOARDS_DIR, bget[1] + '.json');
      if (!fs.existsSync(f)) { res.writeHead(404); res.end('{"erro":"quadro não encontrado"}'); return; }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(fs.readFileSync(f, 'utf8'));
      return;
    }
    const bdel = req.method === 'DELETE' && url.pathname.match(/^\/boards\/([\w-]+)$/);
    if (bdel) {
      const f = path.join(BOARDS_DIR, bdel[1] + '.json');
      if (fs.existsSync(f)) fs.unlinkSync(f);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    const del = req.method === 'DELETE' && url.pathname.match(/^\/items\/([\w-]+)$/);
    if (del) {
      const scene = readBoard() ?? buildSeed();
      scene.items = scene.items.filter((i) => i.id !== del[1]);
      writeBoard(scene);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('não encontrado');
  } catch (e) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('erro: ' + e.message);
  }
});

const BASE_PORT = Number(process.env.DRAWRDIS_PORT) || 3750;
let port = BASE_PORT;
server.on('error', e => {
  if (e.code === 'EADDRINUSE' && port < BASE_PORT + 10) {
    port += 1;
    server.listen(port, '127.0.0.1');
    return;
  }
  console.error('servidor:', e.message);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  try { fs.writeFileSync(PORTFILE, String(port)); } catch { /* melhor esforço */ }
  console.log('Drawrdis no ar em http://127.0.0.1:' + port);
  console.log('Quadro: ' + BOARD);
});
