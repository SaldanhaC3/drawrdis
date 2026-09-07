#!/usr/bin/env node
/* Geometria + undo por patch, testados em Node puro (sem browser).
   Extrai as funções puras de public/index.html por varredura de chaves
   balanceadas e as executa com stubs mínimos. Falha (exit 1) se a lógica
   regredir. Roda no CI antes do harness de Chromium. */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// captura `function NAME(...) { ... }` com chaves balanceadas
function grab(name) {
  const start = html.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('função não encontrada: ' + name);
  let i = html.indexOf('{', start), depth = 0, j = i;
  for (; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (!depth) break; }
  }
  return html.slice(start, j + 1);
}

const names = ['rot', 'drawBox', 'itemBox', 'rotCorners', 'rotAABB', 'curvePts',
  'borderPoint', 'borderPointFromBind', 'relPoint', 'pruneDanglingBinds',
  'subsetSnap', 'applyPatchMap', 'wrapLines', 'ensureTextSize'];

const src = names.map(grab).join('\n');

// stubs de ambiente
const ctx = { font: '', measureText: s => ({ width: String(s).length * 8 }) };
const scene = { items: [] };
let z = 1;

// eslint-disable-next-line no-new-func
const run = new Function('ctx', 'scene', 'z', src + '\nreturn {' + names.join(',') + '};');
const F = run(ctx, scene, z);
const { curvePts, relPoint, pruneDanglingBinds, subsetSnap, applyPatchMap } = F;

let pass = 0, fail = 0;
const near = (a, b) => Math.abs(a - b) < 1e-6;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, 'got', JSON.stringify(got)); }
}

const shape = { id: 's1', type: 'rect', x: 100, y: 200, w: 80, h: 40 };
scene.items = [shape];

// borda dinâmica (bind sem rx/ry) — retrocompatibilidade
let arr = { id: 'a1', type: 'arrow', x: 0, y: 0, x2: 500, y2: 500, startBind: { id: 's1' } };
let cp = curvePts(arr);
ok('bind sem rx/ry usa borda', near(cp[0][0], 165.71428571428572) && near(cp[0][1], 240), cp[0]);

// ancoragem livre rx/ry
arr = { id: 'a2', type: 'arrow', x: 0, y: 0, x2: 500, y2: 500, startBind: { id: 's1', rx: 0.25, ry: 0.75 } };
cp = curvePts(arr);
ok('bind rx/ry ancoragem livre', near(cp[0][0], 120) && near(cp[0][1], 230), cp[0]);

// endBind rx/ry
arr = { id: 'a3', type: 'arrow', x: 0, y: 0, x2: 500, y2: 500, endBind: { id: 's1', rx: 1, ry: 0 } };
cp = curvePts(arr);
ok('endBind rx/ry', near(cp[cp.length - 1][0], 180) && near(cp[cp.length - 1][1], 200), cp[cp.length - 1]);

// relPoint normaliza e clampa
let rp = relPoint(shape, 140, 220);
ok('relPoint centro', near(rp.rx, 0.5) && near(rp.ry, 0.5), rp);
rp = relPoint(shape, 50, 300);
ok('relPoint clamp', rp.rx === 0 && rp.ry === 1, rp);

// âncora acompanha a forma movida
shape.x = 300; shape.y = 400;
arr = { id: 'a4', type: 'arrow', x: 0, y: 0, x2: 500, y2: 500, startBind: { id: 's1', rx: 0.25, ry: 0.75 } };
cp = curvePts(arr);
ok('ancora acompanha move', near(cp[0][0], 320) && near(cp[0][1], 430), cp[0]);
shape.x = 100; shape.y = 200;

// pruneDanglingBinds: bind órfão é removido e a ponta congela na posição atual
const orphan = { id: 'a5', type: 'arrow', x: 10, y: 20, x2: 90, y2: 90, startBind: { id: 'nao-existe' } };
scene.items.push(orphan);
pruneDanglingBinds();
ok('prune remove bind órfão', !orphan.startBind && orphan.x === 10 && orphan.y === 20, orphan);
scene.items = [shape];

// undo por patch: subsetSnap + applyPatchMap restauram só os itens tocados
const b = { id: 'b', type: 'rect', x: 0, y: 0, w: 10, h: 10 };
const c = { id: 'c', type: 'rect', x: 50, y: 50, w: 10, h: 10 };
scene.items = [b, c];
const before = subsetSnap(['b']);
b.x = 999; // "move"
applyPatchMap(before);
ok('patch restaura item tocado', scene.items[0].x === 0, scene.items[0]);
ok('patch não toca os demais', scene.items[1].x === 50, scene.items[1]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
