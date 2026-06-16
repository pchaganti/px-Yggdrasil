const { createCanvas } = require('canvas');
const GIFEncoder = require('gifencoder');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'docs', 'public', 'demo.gif');

const W = 960, H = 540, FPS = 5;

const encoder = new GIFEncoder(W, H);
const stream = encoder.createReadStream().pipe(fs.createWriteStream(OUTPUT));
encoder.start();
encoder.setRepeat(0);
encoder.setDelay(Math.round(1000 / FPS));
encoder.setQuality(10);

const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

const BG = '#050508';
const TERM_BG = '#0d1117';
const TERM_BORDER = '#1a1e26';
const TEXT = '#c9d1d9';
const DIM = '#768390';
const GREEN = '#7ee787';
const RED = '#f85149';
const BLUE = '#58a6ff';
const PURPLE = '#bc8cff';
const YELLOW = '#d29922';
const WHITE = '#e6e6e6';
const OUTPUT_C = '#adbac7';

const TX = 30, TY = 20, TW = W - 60, TH = H - 40;
const HEAD_H = 38;
const CONTENT_X = TX + 16;
const LINE_H = 20;
const FONT = '13px monospace';
const FONT_BOLD = 'bold 13px monospace';

let lines = [];
let termTitle = 'terminal';
let bigText = null;

function drawBackground() {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawTerminal() {
  roundRect(TX, TY, TW, TH, 10);
  ctx.fillStyle = TERM_BG;
  ctx.fill();
  ctx.strokeStyle = TERM_BORDER;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = '#151920';
  ctx.fillRect(TX + 1, TY + HEAD_H, TW - 2, 1);

  const dots = [['#ff5f57', TX+16], ['#febc2e', TX+33], ['#28c840', TX+50]];
  for (const [c, x] of dots) {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(x, TY + 19, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = '#8b949e';
  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(termTitle, TX + TW / 2, TY + 23);
  ctx.textAlign = 'left';

  const contentY = TY + HEAD_H + 8;
  const maxLines = Math.floor((TH - HEAD_H - 16) / LINE_H);
  const startLine = Math.max(0, lines.length - maxLines);

  ctx.save();
  ctx.beginPath();
  ctx.rect(TX + 4, contentY - 4, TW - 8, TH - HEAD_H - 8);
  ctx.clip();

  for (let i = startLine; i < lines.length; i++) {
    const y = contentY + (i - startLine) * LINE_H + 14;
    if (y > TY + TH) break;
    const line = lines[i];
    ctx.font = line.bold ? FONT_BOLD : FONT;
    ctx.fillStyle = line.color || TEXT;
    ctx.fillText(line.text, CONTENT_X, y);
  }
  ctx.restore();
}

function drawBigText() {
  if (!bigText) return;
  ctx.textAlign = 'center';
  for (let i = 0; i < bigText.length; i++) {
    const bt = bigText[i];
    ctx.font = bt.font || 'bold 42px sans-serif';
    ctx.fillStyle = bt.color || WHITE;
    ctx.fillText(bt.text, W / 2, H / 2 + i * 50 - ((bigText.length - 1) * 25));
  }
  ctx.textAlign = 'left';
}

function frame() {
  drawBackground();
  if (bigText) drawBigText();
  else drawTerminal();
  encoder.addFrame(ctx);
}

function frames(n) { for (let i = 0; i < n; i++) frame(); }
function add(text, color, bold) { lines.push({ text, color: color || TEXT, bold: !!bold }); }
function clear() { lines = []; }

// ===== SCENE SCRIPT =====
// Narrative (rebalanced from real adopter feedback): the proven value is
// (1) scoped rules BEFORE the agent writes — prevention via `yg context`, and
// (2) the deterministic + relation gate that is free, live, and un-ignorable.
// The LLM reviewer is ONE beat, not the axis. Keep this weighting on edits.
console.log('Rendering...');

// Scene 1: Init
termTitle = '~/payments-api';
add('$ npm install -g @chrisdudek/yg', WHITE); frames(2);
add('added 6 packages in 2s', OUTPUT_C); frames(3);
add('', TEXT);
add('$ yg init', WHITE); frames(2);
add('  platform  > claude-code', GREEN); frames(2);
add('  reviewer  > Claude Code  CLI (sonnet)', GREEN); frames(2);
add('  ✓ Yggdrasil initialized.', GREEN); frames(5);

// Scene 2: User task
clear(); termTitle = 'claude code'; frames(2);
add('You: Add a charge endpoint. Payments must emit an', BLUE, true);
add('     audit event and record to the ledger.', BLUE); frames(8);
add('', TEXT);

// Scene 3: Rules BEFORE writing — the prevention beat (the proven value)
add('Agent: Pulling the rules for this file before I write.', PURPLE); frames(4);
add('', TEXT);
add('▶ yg context --file src/payments/charge.ts', WHITE); frames(2);
add('  node: payments/service', DIM);
add('  requires-audit    [llm]  read: aspects/requires-audit/content.md', OUTPUT_C);
add('  input-validation  [llm]  read: aspects/input-validation/content.md', OUTPUT_C);
add('  no-direct-db      [det]  read: aspects/no-direct-db/check.mjs', OUTPUT_C); frames(9);
add('', TEXT);
add('Agent: 3 rules. Writing to them up front.', PURPLE); frames(5);

// Scene 4: Agent writes code that already fits the rules it was handed
add('', TEXT);
add('  src/payments/charge.ts        created', GREEN); frames(1);
add('  src/payments/charge.schema.ts created', GREEN); frames(3);

// Scene 5: The un-ignorable gate — deterministic relation check, live + FREE
add('', TEXT);
add('▶ yg check --approve', WHITE); frames(2);
add('  relation-undeclared-dependency  payments/service', RED, true);
add('    charge.ts:14 → undeclared dependency on ledger/service', OUTPUT_C);
add('    Why: code calls another node it declares no relation to.', OUTPUT_C);
add('    Fix: add the relation in payments/service/yg-node.yaml.', OUTPUT_C); frames(10);
add('', TEXT);
add('  (deterministic — no LLM, no cost, runs every check)', DIM); frames(5);
add('', TEXT);
add('Agent: Right — declaring the calls relation to ledger.', PURPLE); frames(3);
add('  payments/service/yg-node.yaml  modified', YELLOW); frames(4);

// Scene 6: One LLM beat — the semantic catch a script can't make
add('', TEXT);
add('▶ yg check --approve', WHITE); frames(2);
add('  Filling 3 unverified pairs across 1 node —', DIM);
add('  1 deterministic (no cost), 2 reviewer calls (consensus included)', DIM); frames(7);
add('', TEXT);
add('  [det] no-direct-db on payments/service — approved', GREEN); frames(1);
add('  [llm] input-validation on payments/service — approved', GREEN); frames(1);
add('  [llm] requires-audit on payments/service — refused', RED, true);
add('    charge() mutates state but never calls emitAudit().', OUTPUT_C);
add('    Every mutation must emit an audit event.', OUTPUT_C); frames(10);

// Scene 7: Agent fixes, passes, CI green without keys
add('', TEXT);
add('Agent: Audit event missing. Adding it.', PURPLE); frames(3);
add('  src/payments/charge.ts  modified', YELLOW); frames(3);
add('', TEXT);
add('▶ yg check --approve', WHITE); frames(2);
add('  [llm] requires-audit on payments/service — approved', GREEN); frames(2);
add('  yg check: PASS  2 nodes · 5/5 files · 3 aspects · 0 flows', GREEN, true); frames(7);
add('', TEXT);
add('$ yg check   # the CI gate — no LLM, no keys', WHITE); frames(2);
add('  yg check: PASS  2 nodes · 5/5 files · 3 aspects · 0 flows', GREEN, true); frames(8);

// Scene 8: Punchline — rebalanced toward prevention + un-ignorable enforcement
clear();
bigText = [
  { text: 'The rules reach the agent before it writes a line.', color: GREEN, font: 'bold 29px sans-serif' },
  { text: 'Not in a PR review, after.', color: '#888', font: '22px sans-serif' },
]; frames(15);

bigText = [
  { text: 'The checks run on every change.', color: WHITE, font: 'bold 30px sans-serif' },
  { text: 'Your agent can’t optimize them away.', color: '#888', font: '22px sans-serif' },
]; frames(16);

bigText = [
  { text: 'YGGDRASIL', color: WHITE, font: '900 52px sans-serif' },
  { text: 'Your agent will ignore CLAUDE.md.', color: '#888', font: '20px sans-serif' },
  { text: 'Yggdrasil makes sure it doesn’t.', color: WHITE, font: 'bold 22px sans-serif' },
  { text: 'npm install -g @chrisdudek/yg', color: GREEN, font: '14px monospace' },
]; frames(20);

encoder.finish();
console.log('Done. Waiting for file write...');
stream.on('finish', () => {
  const size = fs.statSync(OUTPUT).size;
  console.log(`GIF saved: ${(size / 1024 / 1024).toFixed(1)}MB`);
});
