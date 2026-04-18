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
console.log('Rendering...');

// Scene 1: Init
termTitle = '~/my-project';
add('$ npm install -g @chrisdudek/yg', WHITE); frames(2);
add('added 6 packages in 2s', OUTPUT_C); frames(3);
add('', TEXT);
add('$ yg init', WHITE); frames(2);
add('', TEXT);
add('Yggdrasil Setup', WHITE, true); frames(1);
add('', TEXT);
add('Step 1: AI coding platform', OUTPUT_C); frames(2);
for (const p of ['cursor','claude-code','copilot','codex','cline','windsurf','aider','gemini-cli']) {
  add('  ' + p, OUTPUT_C); frames(1);
}
frames(1);
add('  > claude-code', GREEN); frames(3);
add('', TEXT);
add('Step 2: Reviewer provider', OUTPUT_C); frames(2);
add('  > Claude Code  CLI', GREEN); frames(2);
add('  > sonnet', GREEN); frames(2);
add('  \u2713 claude found.', GREEN); frames(3);
add('', TEXT);
add('\u2713 Yggdrasil initialized.', GREEN); frames(6);

// Scene 2: User task
clear(); termTitle = 'claude code'; frames(2);
add('You: Add a payment endpoint to the API. All payment', BLUE, true);
add('     operations must emit audit events and validate', BLUE);
add('     input with zod schemas.', BLUE); frames(8);
add('', TEXT);
add('Agent: I\'ll set up the architecture rules first,', PURPLE);
add('       then implement.', PURPLE); frames(5);

// Scene 3: Agent builds graph
add('', TEXT);
add('\u25b6 Creating aspect: requires-audit', WHITE); frames(2);
add('  aspects/requires-audit/content.md', DIM);
add('  "Every mutation must emit an audit event with', YELLOW);
add('   operation, timestamp, and entity ID"', YELLOW); frames(3);
add('', TEXT);
add('\u25b6 Creating aspect: zod-validation', WHITE); frames(2);
add('  aspects/zod-validation/content.md', DIM);
add('  "All endpoint handlers must validate input', YELLOW);
add('   using zod schemas before processing"', YELLOW); frames(3);
add('', TEXT);
add('\u25b6 Creating node: payments/service', WHITE); frames(2);
add('  type: service', OUTPUT_C);
add('  aspects: [requires-audit, zod-validation]', OUTPUT_C);
add('  mapping: [src/payments/]', OUTPUT_C); frames(3);
add('', TEXT);
add('\u25b6 Implementing payment endpoint...', WHITE); frames(2);
add('  src/payments/payment.service.ts    created', GREEN); frames(1);
add('  src/payments/payment.controller.ts created', GREEN); frames(1);
add('  src/payments/payment.schema.ts     created', GREEN); frames(4);

// Scene 4: Approve fails
add('', TEXT);
add('\u25b6 Running yg approve --node payments/service', WHITE); frames(2);
add('  Verifying aspects with reviewer...', DIM); frames(8);
add('', TEXT);
add('ERROR: Reviewer found aspect violations.', RED, true); frames(2);
add('', TEXT);
add('Aspect verification:', OUTPUT_C);
add('  \u2713 zod-validation \u2014 SATISFIED', GREEN); frames(2);
add('  \u2717 requires-audit \u2014 NOT SATISFIED', RED, true);
add('    charge() and refund() mutate state but do not', OUTPUT_C);
add('    call emitAudit(). Must emit audit events with', OUTPUT_C);
add('    operation, timestamp, and entityId.', OUTPUT_C); frames(12);

// Scene 5: Agent fixes
add('', TEXT);
add('Agent: Audit logging missing. Fixing.', PURPLE); frames(4);
add('', TEXT);
add('\u25b6 Adding audit events to payment service...', WHITE); frames(2);
add('  src/payments/payment.service.ts  modified', YELLOW); frames(1);
add('  src/payments/audit.ts            created', GREEN); frames(4);

// Scene 6: Approve passes
add('', TEXT);
add('\u25b6 Running yg approve --node payments/service', WHITE); frames(2);
add('  Verifying aspects with reviewer...', DIM); frames(6);
add('', TEXT);
add('Approved: payments/service \u2014 2 aspects satisfied.', GREEN, true); frames(4);
add('', TEXT);
add('\u25b6 Running yg check', WHITE); frames(2);
add('  PASS (0 errors, 0 warnings)', GREEN); frames(8);

// Scene 7: Punchline
clear();
bigText = [
  { text: 'Rules defined once.', color: GREEN, font: 'bold 42px sans-serif' },
  { text: 'Enforced on every change, automatically.', color: '#888', font: '22px sans-serif' },
]; frames(15);

bigText = [
  { text: 'The agent caught its own mistake', color: '#888', font: '20px sans-serif' },
  { text: 'before it reached your PR.', color: WHITE, font: 'bold 30px sans-serif' },
]; frames(16);

bigText = [
  { text: 'YGGDRASIL', color: WHITE, font: '900 52px sans-serif' },
  { text: 'Continuous code review for AI-assisted development', color: '#888', font: '18px sans-serif' },
  { text: 'npm install -g @chrisdudek/yg', color: GREEN, font: '14px monospace' },
]; frames(20);

encoder.finish();
console.log('Done. Waiting for file write...');
stream.on('finish', () => {
  const size = fs.statSync(OUTPUT).size;
  console.log(`GIF saved: ${(size / 1024 / 1024).toFixed(1)}MB`);
});
