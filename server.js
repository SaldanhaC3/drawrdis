// Drawrdis — quadro compartilhado local, zero dependências.
//
// Rotas:
//   GET  /                → editor (public/index.html, lido a cada request)
//   GET  /scene           → quadro em JSON (inclui rev); ?since=N → só o que mudou desde N
//   POST /scene           → substitui o quadro inteiro (exige ?rev=N; 409 se não bater)
//   POST /sync            → diff por item {add,update,remove,order,merge}; merge=true
//                           trata update como patch de campos (null apaga o campo)
//   POST /items           → adiciona item (objeto) ou itens (array)
//   DELETE /items/<id>    → remove item pelo id
//   GET  /wait            → long-poll ?rev=N&timeout=ms; resolve com {changed, rev, ids}
//   GET  /events          → SSE; eventos `ops` (diff) ou `scene` (completo, fallback)
//   POST /img             → externaliza dataURL → files/<hash>; devolve {src}
//   GET  /img/<arquivo>   → serve a imagem externalizada
//   POST /migrate-images  → move todos os dataURL do quadro para files/
//   POST /state           → editor publica seleção/viewport do humano
//   GET  /state           → agente lê o que o humano está vendo/marcando
//   POST /layout          → align/distribute/place/grid por ids (servidor calcula)
//   GET  /history         → snapshots automáticos (boards/_history)
//   POST /history/revert  → restaura um snapshot
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
const FILES_DIR = path.join(path.dirname(BOARD), 'files');
const HIST_DIR = path.join(BOARDS_DIR, '_history');
const INDEX = path.join(ROOT, 'public', 'index.html');
const PORTFILE = process.env.DRAWRDIS_PORTFILE ? path.resolve(process.env.DRAWRDIS_PORTFILE) : path.join(ROOT, '.drawrdis-port');

const slugify = (name) => String(name)
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/\s+/g, '-')
  .toLowerCase() || 'quadro';

const uid = () => crypto.randomBytes(8).toString('hex');
const isFin = (v) => typeof v === 'number' && Number.isFinite(v);
const badPts = (arr) => !Array.isArray(arr) || arr.some(p => !Array.isArray(p) || !isFin(p[0]) || !isFin(p[1]));

function validateItems(items) {
  // tolerante a dados legados (tipos antigos, campos string/null): só barra o
  // que quebraria o render — item não-objeto e points/mids malformadas.
  // NaN/Infinity não são representáveis em JSON, então o freeze de zoom era
  // runtime (divisão por bbox degenerada), corrigido no editor, não aqui.
  for (const it of items) {
    if (!it || typeof it !== 'object') throw new Error('item não-objeto');
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

/* ---------- geometria para o /layout (espelha o itemBox/rotAABB do editor) ---------- */
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
function rotAabbOf(x, y, w, h, a) {
  if (!a) return { bx: x, by: y, w, h };
  const cx = x + w / 2, cy = y + h / 2, c = Math.cos(a), s = Math.sin(a);
  let x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18;
  for (const [px, py] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]) {
    const dx = px - cx, dy = py - cy;
    const qx = cx + dx * c - dy * s, qy = cy + dx * s + dy * c;
    x0 = Math.min(x0, qx); y0 = Math.min(y0, qy); x1 = Math.max(x1, qx); y1 = Math.max(y1, qy);
  }
  return { bx: x0, by: y0, w: x1 - x0, h: y1 - y0 };
}
function bboxOf(it) {
  if (it.type === 'line' || it.type === 'arrow') {
    const pts = [[it.x, it.y], [it.x2, it.y2], ...(Array.isArray(it.mids) ? it.mids : [])].filter(p => fin(p[0]) && fin(p[1]));
    if (!pts.length) return null;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return { bx: Math.min(...xs), by: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  if (it.type === 'draw') {
    const pts = (it.points || []).filter(p => Array.isArray(p) && fin(p[0]) && fin(p[1]));
    if (!pts.length) return null;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return { bx: Math.min(...xs), by: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  if (it.type === 'text') {
    const fs = fin(it.fontSize) ? it.fontSize : 14;
    // sem o canvas aqui, largura de texto autoW é estimada; suficiente para alinhar
    const w = fin(it.w) ? it.w : String(it.text || '').length * fs * 0.55;
    const lines = String(it.text || '').split('\n').length;
    return rotAabbOf(fin(it.x) ? it.x : 0, fin(it.y) ? it.y : 0, w, fs * 1.3 * lines, it.angle || 0);
  }
  if (fin(it.x) && fin(it.y) && fin(it.w) && fin(it.h)) return rotAabbOf(it.x, it.y, it.w, it.h, it.angle || 0);
  return null;
}
function shiftIt(it, dx, dy) {
  if (fin(it.x)) it.x += dx;
  if (fin(it.y)) it.y += dy;
  if (fin(it.x2)) it.x2 += dx;
  if (fin(it.y2)) it.y2 += dy;
  if (Array.isArray(it.points)) for (const p of it.points) { p[0] += dx; p[1] += dy; }
  if (Array.isArray(it.mids)) for (const p of it.mids) { p[0] += dx; p[1] += dy; }
}

/* ---------- imagens externalizadas ---------- */
// dataURL dentro do item é o que estoura o board.json (3 MB de base64 reescrito
// a cada operação). /img guarda o binário em files/<sha1> e o item fica só com
// a URL. O editor aceita os dois formatos, então dados antigos continuam vivos.
const IMG_EXT = { png: 'png', jpeg: 'jpg', jpg: 'jpg', gif: 'gif', webp: 'webp', 'svg+xml': 'svg' };
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
function externalizeDataUrl(dataUrl) {
  const m = /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('dataURL de imagem inválido');
  const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (!buf.length) throw new Error('imagem vazia');
  const ext = IMG_EXT[m[1]];
  const name = crypto.createHash('sha1').update(buf).digest('hex') + '.' + ext;
  fs.mkdirSync(FILES_DIR, { recursive: true });
  const f = path.join(FILES_DIR, name);
  if (!fs.existsSync(f)) fs.writeFileSync(f, buf);
  return { src: '/img/' + name, bytes: buf.length };
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

// opsLog: anel das últimas escritas ({rev, add, update, remove} por id). É o que
// permite leitura incremental (GET /scene?since=N), ids no /wait e diff no SSE
// sem guardar histórico completo. Perde-se no restart; quem pedir uma rev
// antiga recebe truncated:true e cai para a leitura cheia.
const opsLog = [];
const OPSLOG_MAX = 300;

function diffScenes(prev, next) {
  const before = new Map(prev.items.map(i => [i.id, JSON.stringify(i)]));
  const add = [], update = [];
  const seen = new Set();
  for (const it of next.items) {
    seen.add(it.id);
    const b = before.get(it.id);
    if (b === undefined) add.push(it);
    else if (b !== JSON.stringify(it)) update.push(it);
  }
  const remove = [...before.keys()].filter(id => !seen.has(id));
  return { add, update, remove };
}

function changedSince(sinceRev) {
  const cur = readBoard();
  const rev = cur ? (cur.rev || 0) : 0;
  if (!cur || sinceRev >= rev) return { rev, since: sinceRev, changed: [], removed: [], truncated: false };
  const oldest = opsLog.length ? opsLog[0].rev : rev + 1;
  if (sinceRev < oldest - 1) return { rev, since: sinceRev, truncated: true };
  const state = new Map();
  for (const e of opsLog) {
    if (e.rev <= sinceRev) continue;
    for (const id of e.add) state.set(id, 'c');
    for (const id of e.update) state.set(id, 'c');
    for (const id of e.remove) state.set(id, 'r');
  }
  const byId = new Map(cur.items.map(i => [i.id, i]));
  const changed = [], removed = [];
  for (const [id, st] of state) {
    if (st === 'r') { if (!byId.has(id)) removed.push(id); }
    else if (byId.has(id)) changed.push(byId.get(id));
  }
  return { rev, since: sinceRev, changed, removed, truncated: false };
}

// waiters do long-poll /wait: resolvidos quando a rev passa da esperada
const waiters = new Set();
function flushWaiters(rev, ids) {
  for (const w of [...waiters]) {
    if (rev > w.minRev) {
      waiters.delete(w);
      clearTimeout(w.timer);
      try { w.done({ changed: true, rev, ids }); } catch { /* cliente já foi */ }
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

// snapshot automático em boards/_history: rede de segurança para escrita
// destrutiva (replace total) e para o diálogo "Histórico…" do editor.
function snapshotHistory(scene, tag) {
  try {
    fs.mkdirSync(HIST_DIR, { recursive: true });
    fs.writeFileSync(path.join(HIST_DIR, `rev${String(scene.rev).padStart(6, '0')}-${tag || 'auto'}.json`), JSON.stringify(scene));
    const list = fs.readdirSync(HIST_DIR).filter(x => x.endsWith('.json')).sort();
    while (list.length > 20) { try { fs.unlinkSync(path.join(HIST_DIR, list.shift())); } catch { /* ok */ } }
  } catch { /* histórico é conveniência; nunca derruba um save por causa dele */ }
}

function writeBoard(scene) {
  if (!Array.isArray(scene.items)) throw new Error('quadro inválido: items ausente');
  validateItems(scene.items);
  scene.rev = ((lastGood && lastGood.rev) || 0) + 1;
  lastGood = scene;
  // O diff é contra o índice da última ESCRITA (não contra lastGood): as rotas
  // mutam o objeto que readBoard devolve, e readBoard atualiza lastGood — a
  // comparação sairia sempre idêntica.
  const idx = new Map(scene.items.map(i => [i.id, JSON.stringify(i)]));
  let touched = [];
  if (writtenIndex) {
    const add = [], update = [], remove = [];
    for (const [id, j] of idx) {
      const b = writtenIndex.get(id);
      if (b === undefined) add.push(id);
      else if (b !== j) update.push(id);
    }
    for (const id of writtenIndex.keys()) if (!idx.has(id)) remove.push(id);
    touched = [...add, ...update, ...remove];
    opsLog.push({ rev: scene.rev, add, update, remove });
    while (opsLog.length > OPSLOG_MAX) opsLog.shift();
  }
  writtenIndex = idx;
  // tmp + rename: escrita atômica, nenhum leitor vê JSON pela metade
  const tmp = BOARD + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
  // sem indentação: em um board de centenas de itens, cada escrita re-formatava
  // ~1 MB de espaços que ninguém lê (o editor lê via API, o humano nunca abre
  // o arquivo cru). O diff fica mais barato e o board é mais bonito no git.
  fs.writeFileSync(tmp, JSON.stringify(scene));
  fs.renameSync(tmp, BOARD);
  if (scene.rev % 20 === 0) snapshotHistory(scene);
  flushWaiters(scene.rev, touched);
}

let writtenIndex = null;
if (!readBoard()) writeBoard(SEED);
else writtenIndex = new Map(lastGood.items.map(i => [i.id, JSON.stringify(i)]));

const clients = new Set();

// SSE incremental: quando a mudança é pequena, manda só o diff (evento `ops`);
// o cliente aplica por id. Em mudanças grandes (replace, import) manda a cena.
let lastSent = null;
function broadcast(scene) {
  if (!scene) return;
  if (lastSent && lastSent.rev === scene.rev) return; // essa versão já saiu (rota + watch)
  let payload;
  if (lastSent && Array.isArray(lastSent.items)) {
    const d = diffScenes(lastSent, scene);
    const n = d.add.length + d.update.length + d.remove.length;
    if (n > 0 && n <= 150) payload = `event: ops\ndata: ${JSON.stringify({ rev: scene.rev, ops: d })}\n\n`;
  }
  if (!payload) payload = `event: scene\ndata: ${JSON.stringify(scene)}\n\n`;
  lastSent = scene;
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

// o que o humano está vendo/marcando agora. Não persiste: é presença, não cena.
let userState = { sel: [], view: null, at: 0 };

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
      const since = url.searchParams.get('since');
      const out = since !== null ? changedSince(Number(since) || 0) : (readBoard() ?? SEED);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out));
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
      if (cur && (cur.rev || 0) > minRev) {
        const cs = changedSince(minRev);
        // ids pode ser enorme quando muda meio board; cap é o `since` voltando
        // a por o trabalho pesado no get_scene, não em toda resposta de wait
        const ids = cs.truncated ? undefined : [...cs.changed.map(i => i.id), ...cs.removed].slice(0, 200);
        sendJson({ changed: true, rev: cur.rev, ids });
        return;
      }
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
      // substituição total é a única rota destrutiva: exige a rev lida e tira
      // um snapshot do estado atual antes de gravar. Sem isso, uma chamada
      // errada de agente apagaria o quadro sem rede de segurança.
      if (expect === null) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ erro: 'POST /scene exige ?rev=N; leia GET /scene primeiro' }));
        return;
      }
      const cur = readBoard();
      if (!cur || (cur.rev || 0) !== Number(expect)) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ erro: 'rev desatualizada', rev: cur ? (cur.rev || 0) : 0 }));
        return;
      }
      if (cur) snapshotHistory(cur, 'pre-replace');
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
        if (!body.merge) {
          // update sem merge é o padrão antigo de sobrescrever o item inteiro:
          // reverteria edição concorrente do humano. Só o merge de campos é aceito.
          throw new Error('update exige merge:true (patch de campos)');
        }
        // patch de campos: só o que o agente mandou muda. Se o humano moveu o
        // item entre a leitura e o patch do agente, x/y dele sobrevivem.
        // null num campo apaga o campo (merge raso não expressa "delete").
        const ex = byId.get(String(it.id));
        if (!ex) throw new Error(`update: id ${it.id} não existe`);
        const merged = Object.assign({}, ex);
        for (const [k, v] of Object.entries(it)) {
          if (k === 'id') continue;
          if (v === null) delete merged[k]; else merged[k] = v;
        }
        byId.set(String(it.id), merged);
      }
      for (const it of body.add || []) {
        if (!it || !it.id) throw new Error('add sem id');
        byId.set(String(it.id), it);
      }
      scene.items = [...byId.values()];
      // ordem: se o cliente mandou order explícito, aplica; senão, deriva da
      // lista (add/update entram no fim, em ordem estável) — empurrar um item
      // novo no fim é o caso comum, e assim o save não re-serializa a ordem
      // de 900 itens a cada toque.
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
    if (req.method === 'POST' && url.pathname === '/img') {
      const body = JSON.parse(await readBody(req));
      const r = externalizeDataUrl(body.data);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r));
      return;
    }
    const imgGet = req.method === 'GET' && url.pathname.match(/^\/img\/([a-f0-9]{40}\.(?:png|jpg|gif|webp|svg))$/);
    if (imgGet) {
      const f = path.join(FILES_DIR, imgGet[1]);
      if (!fs.existsSync(f)) { res.writeHead(404); res.end('não encontrada'); return; }
      res.writeHead(200, {
        'content-type': IMG_MIME[imgGet[1].split('.')[1]] || 'application/octet-stream',
        'cache-control': 'public, max-age=31536000, immutable',
      });
      res.end(fs.readFileSync(f));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/migrate-images') {
      const scene = readBoard();
      if (!scene) throw new Error('quadro ilegível');
      let moved = 0, saved = 0;
      for (const it of scene.items) {
        if (it.type !== 'image' || typeof it.src !== 'string' || !it.src.startsWith('data:image/')) continue;
        try {
          const r = externalizeDataUrl(it.src);
          saved += it.src.length - r.src.length;
          it.src = r.src;
          moved++;
        } catch { /* dataURL que o servidor não entende: deixa como está */ }
      }
      if (moved) writeBoard(scene);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, moved, savedBytes: saved, rev: scene.rev }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/state') {
      const body = JSON.parse(await readBody(req));
      const sel = Array.isArray(body.sel) ? body.sel.map(String).slice(0, 200) : [];
      const v = body.view;
      const view = v && fin(v.x) && fin(v.y) && fin(v.w) && fin(v.h)
        ? { x: v.x, y: v.y, w: v.w, h: v.h, z: fin(v.z) ? v.z : 1 } : null;
      userState = { sel, view, at: Date.now() };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/state') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(userState));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/layout') {
      const body = JSON.parse(await readBody(req));
      const scene = readBoard();
      if (!scene) throw new Error('quadro ilegível');
      const ids = new Set((Array.isArray(body.ids) ? body.ids : []).map(String));
      const sel = scene.items.filter(i => ids.has(i.id));
      if (sel.length < 2 && body.op !== 'place-right' && body.op !== 'grid') throw new Error('layout precisa de 2+ ids');
      const boxes = sel.map(i => ({ it: i, b: bboxOf(i) })).filter(e => e.b);
      if (!boxes.length) throw new Error('nenhum item com caixa resolvível');
      const gap = fin(body.gap) ? body.gap : 40;
      const op = body.op;
      if (op === 'align-left' || op === 'align-right' || op === 'align-hcenter') {
        const x0 = Math.min(...boxes.map(e => e.b.bx));
        const x1 = Math.max(...boxes.map(e => e.b.bx + e.b.w));
        for (const e of boxes) {
          const t = op === 'align-left' ? x0 : op === 'align-right' ? x1 - e.b.w : (x0 + x1) / 2 - e.b.w / 2;
          shiftIt(e.it, t - e.b.bx, 0);
        }
      } else if (op === 'align-top' || op === 'align-bottom' || op === 'align-vcenter') {
        const y0 = Math.min(...boxes.map(e => e.b.by));
        const y1 = Math.max(...boxes.map(e => e.b.by + e.b.h));
        for (const e of boxes) {
          const t = op === 'align-top' ? y0 : op === 'align-bottom' ? y1 - e.b.h : (y0 + y1) / 2 - e.b.h / 2;
          shiftIt(e.it, 0, t - e.b.by);
        }
      } else if (op === 'distribute-h' || op === 'distribute-v') {
        const horiz = op === 'distribute-h';
        boxes.sort((a, b) => (horiz ? a.b.bx - b.b.bx : a.b.by - b.b.by));
        const first = boxes[0].b, last = boxes[boxes.length - 1].b;
        const span = (horiz ? last.bx + last.w - first.bx : last.by + last.h - first.by);
        const sum = boxes.reduce((s, e) => s + (horiz ? e.b.w : e.b.h), 0);
        let cursor = horiz ? first.bx : first.by;
        const step = boxes.length > 1 ? (span - sum) / (boxes.length - 1) : 0;
        for (const e of boxes) {
          const pos = horiz ? e.b.bx : e.b.by;
          shiftIt(e.it, horiz ? cursor - pos : 0, horiz ? 0 : cursor - pos);
          cursor += (horiz ? e.b.w : e.b.h) + step;
        }
      } else if (op === 'place-right') {
        // move a seleção para a direita de tudo que NÃO está selecionado,
        // preservando o layout relativo. É o "sem sobreposição" que o skill
        // hoje manda o agente calcular à mão.
        const others = scene.items.filter(i => !ids.has(i.id)).map(bboxOf).filter(Boolean);
        const sel0 = Math.min(...boxes.map(e => e.b.bx));
        const targetX = others.length ? Math.max(...others.map(b => b.bx + b.w)) + gap : sel0;
        const dx = targetX - sel0;
        if (dx !== 0) for (const e of boxes) shiftIt(e.it, dx, 0);
      } else if (op === 'grid') {
        const cols = Math.ceil(Math.sqrt(boxes.length));
        const cw = Math.max(...boxes.map(e => e.b.w)) + gap;
        const ch = Math.max(...boxes.map(e => e.b.h)) + gap;
        const x0 = Math.min(...boxes.map(e => e.b.bx));
        const y0 = Math.min(...boxes.map(e => e.b.by));
        boxes.forEach((e, i) => {
          shiftIt(e.it, x0 + (i % cols) * cw - e.b.bx, y0 + Math.floor(i / cols) * ch - e.b.by);
        });
      } else {
        throw new Error('op inválida: use align-left/right/top/bottom/hcenter/vcenter, distribute-h/v, place-right, grid');
      }
      writeBoard(scene);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rev: scene.rev, moved: boxes.length }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/history') {
      let list = [];
      try {
        list = fs.readdirSync(HIST_DIR).filter(x => /^rev\d+-[\w-]+\.json$/.test(x)).sort().map(x => {
          const st = fs.statSync(path.join(HIST_DIR, x));
          const m = /^rev(\d+)-([\w-]+)\.json$/.exec(x);
          return { file: x, rev: +m[1], tag: m[2], date: st.mtime.toISOString(), bytes: st.size };
        }).reverse();
      } catch { /* sem histórico ainda */ }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(list));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/history/revert') {
      const body = JSON.parse(await readBody(req));
      const file = String(body.file || '');
      if (!/^rev\d+-[\w-]+\.json$/.test(file)) throw new Error('arquivo de histórico inválido');
      const f = path.join(HIST_DIR, file);
      if (!fs.existsSync(f)) throw new Error('snapshot não encontrado');
      const loaded = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!Array.isArray(loaded.items)) throw new Error('snapshot corrompido');
      const cur = readBoard();
      if (cur) snapshotHistory(cur, 'pre-revert');
      delete loaded.rev;
      writeBoard(loaded);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rev: loaded.rev }));
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
