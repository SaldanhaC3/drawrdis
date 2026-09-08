// Servidor MCP (stdio) do quadro Drawrdis — zero dependências.
//
// Ferramentas:
//   drawrdis_get_scene        → quadro em JSON, resumo legível, ou só o diff desde uma rev
//   drawrdis_add_items        → acrescenta itens (marca by:"agent"; retorna ids)
//   drawrdis_update_items     → patch de campos por id (não sobrescreve o item inteiro)
//   drawrdis_delete_items     → remove itens por id
//   drawrdis_replace_scene    → substitui o quadro inteiro (exige a rev lida antes)
//   drawrdis_wait_for_change  → espera a rev mudar; devolve os ids que mudaram
//   drawrdis_layout           → align/distribute/place-right/grid sem conta de pixel
//   drawrdis_user_state       → seleção e viewport atuais do humano
//   drawrdis_render           → PNG do quadro (inteiro, por ids ou por bbox)
//
// Com o server.js no ar, toda leitura/escrita passa pelo HTTP dele (127.0.0.1):
// os updates se serializam com os do editor (nada se perde em escrita
// concorrente) e o push SSE chega aos navegadores em <1s. Sem servidor, modo
// arquivo: leitura/escrita atômica direta em board.json (sem SSE).
//
// Registro no cliente MCP (vale para qualquer cliente que aceite servers stdio):
//   { "mcp": { "servers": { "drawrdis": {
//       "command": "node", "args": ["<caminho-absoluto>/drawrdis/mcp-server.js"] } } } }

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const BOARD = process.env.DRAWRDIS_BOARD ? path.resolve(process.env.DRAWRDIS_BOARD) : path.join(__dirname, 'board.json');
const PORTFILE = process.env.DRAWRDIS_PORTFILE ? path.resolve(process.env.DRAWRDIS_PORTFILE) : path.join(__dirname, '.drawrdis-port');

const uid = () => crypto.randomBytes(8).toString('hex');
const isFin = (v) => typeof v === 'number' && Number.isFinite(v);
const badPts = (arr) => !Array.isArray(arr) || arr.some(p => !Array.isArray(p) || !isFin(p[0]) || !isFin(p[1]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function validateItems(items) {
  // mesmo contrato tolerante do server.js: só barra o que quebraria o render
  for (const it of items) {
    if (!it || typeof it !== 'object') throw new Error('item não-objeto');
    if (it.points !== undefined && badPts(it.points)) throw new Error(`item ${it.id || '?'} tem points inválidas`);
    if (it.mids !== undefined && badPts(it.mids)) throw new Error(`item ${it.id || '?'} tem mids inválidas`);
  }
}

/* ---------- modo arquivo (fallback, quando o server.js não está no ar) ---------- */
function readFileBoard() {
  let raw;
  try {
    raw = fs.readFileSync(BOARD, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, title: 'Drawrdis', rev: 0, items: [] };
    throw new Error('board.json ilegível (' + e.code + '); não vou sobrescrever às cegas');
  }
  // JSON rasgado/corrompido: o erro sobe. Nunca retornar quadro vazio,
  // porque a escrita seguinte apagaria o trabalho do usuário.
  const scene = JSON.parse(raw);
  if (!Array.isArray(scene.items)) throw new Error('items ausente');
  return scene;
}

function writeFileBoard(scene) {
  if (!Array.isArray(scene.items)) throw new Error('quadro inválido: items ausente');
  validateItems(scene.items);
  for (const it of scene.items) if (!it.id) it.id = uid();
  scene.rev = (scene.rev || 0) + 1;
  const tmp = BOARD + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(scene));
  fs.renameSync(tmp, BOARD);
  return scene;
}

/* ---------- modo HTTP (preferido) ---------- */
function serverPort() {
  if (process.env.DRAWRDIS_PORT) return Number(process.env.DRAWRDIS_PORT);
  try { return Number(fs.readFileSync(PORTFILE, 'utf8').trim()) || null; } catch { return null; }
}

function api(method, pathname, body, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const port = serverPort();
    if (!port) return reject(Object.assign(new Error('sem servidor'), { offline: true }));
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, timeout: timeoutMs }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error('http ' + res.statusCode + ': ' + d.slice(0, 200)));
        try { resolve(JSON.parse(d)); } catch { resolve(d); }
      });
    });
    req.on('error', e => reject(Object.assign(e, { offline: e.code === 'ECONNREFUSED' || e.code === 'ENOENT' })));
    req.on('timeout', () => req.destroy(new Error('timeout chamando o servidor')));
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getBoard(since) {
  try {
    return await api('GET', since === undefined || since === null ? '/scene' : '/scene?since=' + Number(since));
  }
  catch (e) { if (!e.offline) throw e; return readFileBoard(); }
}

// Aplica ops {add,update,remove,merge} por item. HTTP: o servidor faz o merge
// sobre o estado atual (merge:true = update é patch de campos, null apaga).
// Arquivo: mesmo merge aqui, com escrita atômica.
async function syncOps(ops) {
  try {
    return await api('POST', '/sync', ops);
  } catch (e) {
    if (!e.offline) throw e;
    const scene = readFileBoard();
    const byId = new Map(scene.items.map(i => [i.id, i]));
    for (const id of ops.remove || []) byId.delete(String(id));
    for (const it of ops.update || []) {
      const id = String(it.id);
      if (ops.merge) {
        const ex = byId.get(id);
        if (!ex) throw new Error(`update: id ${id} não existe`);
        const merged = Object.assign({}, ex);
        for (const [k, v] of Object.entries(it)) {
          if (k === 'id') continue;
          if (v === null) delete merged[k]; else merged[k] = v;
        }
        byId.set(id, merged);
      } else byId.set(id, it);
    }
    for (const it of ops.add || []) byId.set(String(it.id), it);
    scene.items = [...byId.values()];
    return writeFileBoard(scene);
  }
}

function summarize(scene) {
  const lines = [`título: ${scene.title}`, `rev: ${scene.rev || 0}`, `itens: ${scene.items.length}`];
  for (const it of scene.items) {
    const pos = Number.isFinite(it.x) ? `${Math.round(it.x)},${Math.round(it.y)}` : 'livre';
    const size = Number.isFinite(it.w) ? ` ${Math.round(it.w)}×${Math.round(it.h)}` : '';
    const txt = it.text ? ` "${String(it.text).slice(0, 40)}"` : '';
    lines.push(`  ${it.id}  ${it.type}  @${pos}${size}${txt}`);
  }
  return lines.join('\n');
}

/* ---------- render (PNG via Chrome/Edge headless) ---------- */
function findChrome() {
  const env = process.env.CHROME_PATH;
  const cands = [env,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser', '/usr/bin/chromium',
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* next */ } }
  for (const c of (env ? [env] : []).concat(['google-chrome', 'chromium', 'msedge'])) {
    try { const r = spawnSync(c, ['--version'], { timeout: 8000 }); if (!r.error && r.status === 0) return c; } catch { /* next */ }
  }
  throw new Error('nenhum Chrome/Edge encontrado; instale um ou defina CHROME_PATH');
}

async function renderPng(args) {
  const port = serverPort();
  if (!port) throw new Error('drawrdis_render precisa do server.js no ar (é ele quem serve o editor que renderiza o quadro)');
  const chrome = findChrome();
  const w = Math.min(Math.max(Number(args?.w) || 1600, 320), 4096);
  const h = Math.min(Math.max(Number(args?.h) || 900, 240), 4096);
  // recorte: ids (tela/seleção) ou bbox [x0,y0,x1,y1] do mundo. Sem isso, um
  // quadro grande vira um PNG ilegível e o agente não consegue verificar nada.
  let snap = `http://127.0.0.1:${port}/?snap`;
  if (Array.isArray(args?.ids) && args.ids.length) snap += '&ids=' + args.ids.map(encodeURIComponent).join(',');
  else if (Array.isArray(args?.bbox) && args.bbox.length === 4 && args.bbox.every(Number.isFinite)) snap += '&bbox=' + args.bbox.join(',');
  const png = path.join(os.tmpdir(), 'drawrdis-render-' + uid() + '.png');
  try {
    const r = spawnSync(chrome, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      `--window-size=${w},${h}`, `--screenshot=${png}`,
      '--virtual-time-budget=6000',
      snap,
    ], { timeout: 90000, windowsHide: true });
    let data;
    try { data = fs.readFileSync(png); } catch {
      throw new Error('o Chrome não produziu o screenshot' + (r.stderr ? ': ' + String(r.stderr).slice(0, 200) : ''));
    }
    return { content: [
      { type: 'image', data: data.toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: `quadro renderizado em PNG ${w}x${h}` },
    ] };
  } finally {
    try { fs.unlinkSync(png); } catch { /* melhor esforço */ }
  }
}

const TOOLS = [
  {
    name: 'drawrdis_get_scene',
    description: 'Lê o quadro Drawrdis compartilhado (rascunhos de telas de app entre usuário e agente). Use format=summary para uma visão rápida e format=json para a cena completa. O resumo inclui rev (número da versão do quadro), necessário para replace_scene e wait_for_change. Com since=N, devolve só {changed, removed} desde a rev N (barato para acompanhar edições); se vier truncated, leia a cena completa.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['summary', 'json'], description: 'summary = visão compacta; json = cena completa', default: 'summary' },
        since: { type: 'number', description: 'rev já vista; retorna apenas o que mudou desde então' },
      },
    },
  },
  {
    name: 'drawrdis_add_items',
    description: 'Acrescenta itens ao quadro (marca by:"agent" para o humano ver o que você desenhou). Tipos: rect (x,y,w,h,r,fill,fillStyle,stroke,strokeWidth,strokeStyle,roughness,opacity,angle), ellipse/diamond (idem rect), text (x,y,text,fontSize,bold,fontFamily,textAlign), line/arrow (x,y,x2,y2,mids,startBind,endBind), draw (points), image (src). Para posicionar sem sobreposição, use drawrdis_layout op=place-right depois de adicionar.',
    inputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'object' }, description: 'lista de itens a acrescentar' },
      },
      required: ['items'],
    },
  },
  {
    name: 'drawrdis_update_items',
    description: 'Aplica patches de campos por id (merge: só os campos enviados mudam; null apaga um campo). Se o humano moveu o item entre sua leitura e o patch, as coordenadas dele sobrevivem. Só toca nos ids listados. Itens atualizados ficam marcados by:"agent".',
    inputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'object' }, description: 'patches com id' },
      },
      required: ['items'],
    },
  },
  {
    name: 'drawrdis_delete_items',
    description: 'Remove itens do quadro pelos ids.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['ids'],
    },
  },
  {
    name: 'drawrdis_replace_scene',
    description: 'Substitui o quadro inteiro. Apaga o conteúdo atual. Exige rev: passe a rev que você leu em get_scene; se o quadro mudou desde então, a chamada falha com a rev atual e você precisa reler antes de tentar de novo.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        rev: { type: 'number', description: 'a rev lida em get_scene antes de substituir' },
        items: { type: 'array', items: { type: 'object' } },
      },
      required: ['items', 'rev'],
    },
  },
  {
    name: 'drawrdis_wait_for_change',
    description: 'Bloqueia até alguém (o usuário) mudar o quadro, ou até o timeout. Passe a rev que você viu em get_scene; retorna {changed, rev, ids} quando o quadro passar daquela versão — ids são os itens que mudaram, use get_scene since=para ler só eles. Use para acompanhar edição humana sem ficar relendo o quadro a cada passo.',
    inputSchema: {
      type: 'object',
      properties: {
        rev: { type: 'number', description: 'a rev que você já viu (de get_scene)' },
        timeoutMs: { type: 'number', description: 'quanto esperar no máximo (padrão 20000, máx. 120000)' },
      },
      required: ['rev'],
    },
  },
  {
    name: 'drawrdis_layout',
    description: 'Alinha, distribui e posiciona itens sem você calcular coordenadas. op: align-left|align-right|align-top|align-bottom|align-hcenter|align-vcenter (na caixa da seleção), distribute-h|distribute-v (espaços iguais), place-right (move a seleção para a direita de todo o resto do quadro, preservando o layout relativo — use para novo conteúdo sem sobreposição), grid (arranja os ids em grade). gap em px (padrão 40).',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'ids dos itens afetados' },
        op: { type: 'string', description: 'align-left|align-right|align-top|align-bottom|align-hcenter|align-vcenter|distribute-h|distribute-v|place-right|grid' },
        gap: { type: 'number', description: 'espaçamento em px (place-right/grid)' },
      },
      required: ['ids', 'op'],
    },
  },
  {
    name: 'drawrdis_user_state',
    description: 'O que o humano está fazendo no quadro agora: {sel: ids selecionados, view: {x,y,w,h,z} do viewport em coordenadas do mundo, at: timestamp}. Use antes de um "arruma isso aqui" para saber o que ele está marcando, e passe view como bbox de drawrdis_render para ver exatamente o recorte dele.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'drawrdis_render',
    description: 'Renderiza o quadro como PNG e devolve a imagem na resposta. É o seu par de olhos: use depois de desenhar para conferir sobreposição, alinhamento e legibilidade de verdade. Por padrão enquadra o quadro inteiro (ilegível em quadros grandes): passe ids (ex.: a moldura de uma tela) ou bbox [x0,y0,x1,y1] para renderizar um recorte em alta resolução. Precisa do server.js no ar e de um Chrome/Edge instalado.',
    inputSchema: {
      type: 'object',
      properties: {
        w: { type: 'number', description: 'largura do PNG (padrão 1600)' },
        h: { type: 'number', description: 'altura do PNG (padrão 900)' },
        ids: { type: 'array', items: { type: 'string' }, description: 'recorte: ids a enquadrar (com o grupo deles)' },
        bbox: { type: 'array', items: { type: 'number' }, description: 'recorte: [x0,y0,x1,y1] do mundo a enquadrar' },
      },
    },
  },
];

async function callTool(name, args) {
  if (name === 'drawrdis_get_scene') {
    const scene = await getBoard(args?.since);
    if (args?.since !== undefined && args?.since !== null && Array.isArray(scene.changed)) {
      return JSON.stringify(scene); // {rev, since, changed:[itens], removed:[ids], truncated}
    }
    return (args?.format === 'json') ? JSON.stringify(scene, null, 2) : summarize(scene);
  }
  if (name === 'drawrdis_add_items') {
    const add = Array.isArray(args?.items) ? args.items : [];
    if (!add.length) throw new Error('items vazio');
    validateItems(add);
    for (const it of add) { it.id = it.id || uid(); it.by = 'agent'; }
    await syncOps({ add });
    return 'adicionados: ' + add.map(i => i.id).join(', ');
  }
  if (name === 'drawrdis_update_items') {
    const patches = Array.isArray(args?.items) ? args.items : [];
    if (!patches.length) throw new Error('items vazio');
    for (const p of patches) if (!p.id) throw new Error('patch sem id');
    // merge:true = o servidor aplica só os campos do patch sobre o item atual.
    // O que o humano mexeu no meio do caminho não é revertido pelo seu patch.
    const update = patches.map(p => Object.assign({}, p, { by: 'agent' }));
    await syncOps({ update, merge: true });
    return 'atualizados: ' + patches.map(p => p.id).join(', ');
  }
  if (name === 'drawrdis_delete_items') {
    const ids = Array.isArray(args?.ids) ? args.ids.map(String) : [];
    if (!ids.length) throw new Error('ids vazio');
    await syncOps({ remove: ids });
    return 'removidos: ' + ids.join(', ');
  }
  if (name === 'drawrdis_replace_scene') {
    if (!Array.isArray(args?.items)) throw new Error('items ausente');
    if (!Number.isFinite(args?.rev)) throw new Error('replace_scene exige rev: chame get_scene e passe a rev que você leu');
    const scene = { version: 1, title: args?.title ?? 'Drawrdis', items: args.items };
    try {
      await api('POST', '/scene?rev=' + args.rev, scene);
    } catch (e) {
      if (!e.offline) throw e;
      const cur = readFileBoard();
      if ((cur.rev || 0) !== args.rev) throw new Error(`rev desatualizada: você leu ${args.rev}, o quadro está em ${cur.rev || 0}; leia de novo`);
      writeFileBoard(scene);
    }
    return 'quadro substituído';
  }
  if (name === 'drawrdis_wait_for_change') {
    const minRev = Number(args?.rev) || 0;
    const timeout = Math.min(Math.max(Number(args?.timeoutMs) || 20000, 100), 120000);
    try {
      const r = await api('GET', `/wait?rev=${minRev}&timeout=${timeout}`, undefined, timeout + 5000);
      return JSON.stringify(r);
    } catch (e) {
      if (!e.offline) throw e;
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        await sleep(300);
        let rev = 0;
        try { rev = readFileBoard().rev || 0; } catch { continue; }
        if (rev > minRev) return JSON.stringify({ changed: true, rev });
      }
      return JSON.stringify({ changed: false, rev: minRev });
    }
  }
  if (name === 'drawrdis_layout') {
    try {
      const r = await api('POST', '/layout', { ids: args?.ids, op: args?.op, gap: args?.gap });
      return JSON.stringify(r);
    } catch (e) {
      if (!e.offline) throw e;
      throw new Error('drawrdis_layout precisa do server.js no ar (a geometria mora nele)');
    }
  }
  if (name === 'drawrdis_user_state') {
    try { return JSON.stringify(await api('GET', '/state')); }
    catch (e) {
      if (!e.offline) throw e;
      return JSON.stringify({ sel: [], view: null, offline: true });
    }
  }
  if (name === 'drawrdis_render') return renderPng(args);
  throw new Error('ferramenta desconhecida: ' + name);
}

function respond(msg) {
  if (!msg || msg.jsonrpc !== '2.0') return;
  if (typeof msg.method !== 'string') return;
  const isNotification = msg.id === undefined || msg.id === null;

  if (msg.method === 'initialize') {
    send({
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'drawrdis', version: '1.0.0' },
      },
    });
    return;
  }
  if (isNotification) return; // notifications/initialized etc.

  if (msg.method === 'ping') {
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'tools/list') {
    send({ id: msg.id, result: { tools: TOOLS } });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    callTool(name, msg.params?.arguments ?? {}).then(out => {
      const content = typeof out === 'string' ? [{ type: 'text', text: out }] : out.content;
      send({ id: msg.id, result: { content } });
    }).catch(e => {
      send({ id: msg.id, result: { content: [{ type: 'text', text: 'erro: ' + e.message }], isError: true } });
    });
    return;
  }
  send({ id: msg.id, error: { code: -32601, message: 'método não encontrado: ' + msg.method } });
}

function send(obj) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      respond(JSON.parse(line));
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
