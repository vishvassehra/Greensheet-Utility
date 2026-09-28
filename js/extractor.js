// Grid-based table extractor for ERP "Green Sheet" style PDFs.
// Every text item is placed into the cell formed by the ruled lines around it.
// Nothing is inferred, re-typed or rounded: cell text is the exact PDF text.
// Any ambiguity (text crossing a border, pages with different columns, text that
// cannot be placed) is reported as an error instead of being guessed.

const LINE_MAX_THICK = 2.0;   // pt – a filled rect thinner than this is a ruled line
const SNAP = 0.8;             // pt – lines closer than this are the same line
const GAP = 1.5;              // pt – join collinear line pieces separated by less than this
const COVER_TOL = 1.2;        // pt – tolerance when asking "does this line reach that point"

// ---------------------------------------------------------------- geometry
const mul = (m, n) => [ // apply n first, then m  (same as pdf.js Util.transform(m, n))
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function mergeLines(raw, key, a0, a1) {
  // raw: [{pos, s0, s1}] ; cluster by pos then merge intervals
  raw.sort((p, q) => p.pos - q.pos);
  const clusters = [];
  for (const r of raw) {
    const c = clusters[clusters.length - 1];
    if (c && r.pos - c.last <= SNAP) { c.items.push(r); c.last = r.pos; }
    else clusters.push({ items: [r], last: r.pos });
  }
  const out = [];
  for (const c of clusters) {
    const pos = c.items.reduce((s, r) => s + r.pos, 0) / c.items.length;
    const iv = c.items.map(r => [r.s0, r.s1]).sort((p, q) => p[0] - q[0]);
    let cur = iv[0].slice();
    for (let i = 1; i < iv.length; i++) {
      if (iv[i][0] <= cur[1] + GAP) cur[1] = Math.max(cur[1], iv[i][1]);
      else { out.push({ [key]: pos, [a0]: cur[0], [a1]: cur[1] }); cur = iv[i].slice(); }
    }
    out.push({ [key]: pos, [a0]: cur[0], [a1]: cur[1] });
  }
  return out;
}

// ---------------------------------------------------------------- page read
async function readPage(page, OPS) {
  const top = page.view[3];
  const fy = y => top - y;                     // PDF y-up  ->  top-down
  const pageW = page.view[2] - page.view[0];

  // ---- ruled lines from the operator list
  const ol = await page.getOperatorList();
  let ctm = [1, 0, 0, 1, 0, 0], lw = 1;
  const stack = [];
  let pending = [];
  const rawV = [], rawH = [];
  const addBox = (x0, y0, x1, y1) => {             // already top-down page coords
    const w = x1 - x0, h = y1 - y0;
    if (w <= LINE_MAX_THICK && h > w * 2 && h > 2) rawV.push({ pos: (x0 + x1) / 2, s0: y0, s1: y1 });
    else if (h <= LINE_MAX_THICK && w > h * 2 && w > 2) rawH.push({ pos: (y0 + y1) / 2, s0: x0, s1: x1 });
  };
  const commit = (stroked) => {
    for (const sp of pending) {
      const pts = sp.pts.map(([x, y]) => { const [a, b] = apply(ctm, x, y); return [a, fy(b)]; });
      if (sp.rect) {
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        if (!stroked) addBox(x0, y0, x1, y1);
        else {
          const t = Math.max(lw * Math.hypot(ctm[0], ctm[1]), 0.1) / 2;
          addBox(x0 - t, y0 - t, x0 + t, y1 + t); addBox(x1 - t, y0 - t, x1 + t, y1 + t);
          addBox(x0 - t, y0 - t, x1 + t, y0 + t); addBox(x0 - t, y1 - t, x1 + t, y1 + t);
        }
      } else {
        // polyline: axis-aligned closed 4-point shapes behave like rects; stroked segments like lines
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        const axis = pts.every((p, i) => i === 0 || Math.abs(p[0] - pts[i - 1][0]) < 0.01 || Math.abs(p[1] - pts[i - 1][1]) < 0.01);
        if (!stroked) { if (axis && pts.length >= 4) addBox(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)); }
        else {
          const t = Math.max(lw * Math.hypot(ctm[0], ctm[1]), 0.1) / 2;
          for (let i = 1; i < pts.length; i++) {
            const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
            if (Math.abs(ax - bx) < 0.01) addBox(ax - t, Math.min(ay, by), ax + t, Math.max(ay, by));
            else if (Math.abs(ay - by) < 0.01) addBox(Math.min(ax, bx), ay - t, Math.max(ax, bx), ay + t);
          }
        }
      }
    }
    pending = [];
  };
  // ---- text state (glyph-level, so touching numbers are never merged)
  const items = [];
  let ts = { cs: 0, ws: 0, hs: 1, lead: 0, rise: 0, size: 0, dirSign: 1, fm: [0.001, 0, 0, 0.001, 0, 0], vertical: false };
  let Tm = [1, 0, 0, 1, 0, 0], tx = 0, ty = 0, lineX = 0, lineY = 0;
  let verticalWarned = false;
  const emitGlyphs = (glyphs) => {
    const M = mul(ctm, Tm);
    const wScale = ts.size * ts.fm[0];
    const dLen = Math.hypot(M[0], M[1]) || 1;
    const dir = [M[0] / dLen, -M[1] / dLen];                        // top-down coords
    const upRaw = [M[2] * ts.dirSign, -M[3] * ts.dirSign];
    const uLen = Math.hypot(upRaw[0], upRaw[1]) || 1;
    const up = [upRaw[0] / uLen, upRaw[1] / uLen];                  // top-down; points up the glyph
    const fs = ts.size * uLen;
    let x = 0;
    for (const g of glyphs) {
      if (typeof g === 'number') { x += -g * ts.size / 1000; continue; }
      if (!g) continue;
      const spacing = (g.isSpace ? ts.ws : 0) + ts.cs;
      const adv = g.width * wScale;
      const charW = adv + spacing * ts.dirSign;
      const lx = tx + x * ts.hs, ly = ty + ts.rise;
      const [px, py] = apply(M, lx, ly);
      const ox = px, oy = fy(py);
      const w = adv * ts.hs * dLen;
      const str = g.unicode ?? '';
      if (str !== '') {
        const corners = [];
        for (const t of [0, Math.max(w, 0.01)]) for (const u of [-0.2 * fs, 0.75 * fs]) corners.push([ox + dir[0] * t + up[0] * u, oy + dir[1] * t + up[1] * u]);
        const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
        items.push({
          str, fs, dir: [dir[0], -dir[1]], up: [up[0], -up[1]], ox, oy,
          cx: ox + dir[0] * w / 2 + up[0] * 0.3 * fs, cy: oy + dir[1] * w / 2 + up[1] * 0.3 * fs,
          x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys),
          upright: Math.abs(dir[0] - 1) < 1e-3, space: !str.trim(),
        });
      }
      x += charW;
    }
    tx += x * ts.hs;
  };
  const F = ol.fnArray, A = ol.argsArray;
  for (let i = 0; i < F.length; i++) {
    const fn = F[i], args = A[i];
    switch (fn) {
      case OPS.save: stack.push([ctm, lw, { ...ts }]); break;
      case OPS.restore: if (stack.length) [ctm, lw, ts] = stack.pop(); break;
      case OPS.transform: ctm = mul(ctm, args); break;
      case OPS.setLineWidth: lw = args[0]; break;
      case OPS.paintFormXObjectBegin: stack.push([ctm, lw, { ...ts }]); if (args[0]) ctm = mul(ctm, args[0]); break;
      case OPS.paintFormXObjectEnd: if (stack.length) [ctm, lw, ts] = stack.pop(); break;
      case OPS.beginText: Tm = [1, 0, 0, 1, 0, 0]; tx = ty = lineX = lineY = 0; break;
      case OPS.setTextMatrix: Tm = args.slice(0, 6); tx = ty = lineX = lineY = 0; break;
      case OPS.moveText: tx = lineX += args[0]; ty = lineY += args[1]; break;
      case OPS.setLeadingMoveText: ts.lead = args[1]; tx = lineX += args[0]; ty = lineY += args[1]; break;
      case OPS.setLeading: ts.lead = -args[0]; break;
      case OPS.nextLine: tx = lineX += 0; ty = lineY += ts.lead; break;
      case OPS.setCharSpacing: ts.cs = args[0]; break;
      case OPS.setWordSpacing: ts.ws = args[0]; break;
      case OPS.setHScale: ts.hs = args[0] / 100; break;
      case OPS.setTextRise: ts.rise = args[0]; break;
      case OPS.setFont: {
        let font = null;
        try { font = page.commonObjs.get(args[0]); } catch (e) { font = null; }
        let size = args[1];
        ts.dirSign = size < 0 ? -1 : 1; ts.size = Math.abs(size);
        ts.fm = (font && font.fontMatrix) || [0.001, 0, 0, 0.001, 0, 0];
        ts.vertical = !!(font && font.vertical);
        break;
      }
      case OPS.showText: case OPS.showSpacedText:
        if (ts.vertical && !verticalWarned) { verticalWarned = true; }
        emitGlyphs(args[0]); break;
      case OPS.nextLineShowText: ty = lineY += ts.lead; tx = lineX; emitGlyphs(args[0]); break;
      case OPS.nextLineSetSpacingShowText: ts.ws = args[0]; ts.cs = args[1]; ty = lineY += ts.lead; tx = lineX; emitGlyphs(args[2]); break;
      case OPS.constructPath: {
        const [ops, coords] = args; let k = 0, cur = null;
        for (const op of ops) {
          if (op === OPS.rectangle) {
            const [x, y, w, h] = coords.slice(k, k + 4); k += 4;
            pending.push({ rect: true, pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] });
          } else if (op === OPS.moveTo) { cur = { pts: [[coords[k], coords[k + 1]]] }; pending.push(cur); k += 2; }
          else if (op === OPS.lineTo) { if (cur) cur.pts.push([coords[k], coords[k + 1]]); k += 2; }
          else if (op === OPS.curveTo) { k += 6; cur = null; }
          else if (op === OPS.curveTo2 || op === OPS.curveTo3) { k += 4; cur = null; }
          else if (op === OPS.closePath) { if (cur && cur.pts.length) cur.pts.push(cur.pts[0].slice()); }
        }
        break;
      }
      case OPS.fill: case OPS.eoFill: commit(false); break;
      case OPS.stroke: case OPS.closeStroke: commit(true); break;
      case OPS.fillStroke: case OPS.eoFillStroke: case OPS.closeFillStroke: case OPS.closeEOFillStroke:
        commit(false); break; // borders of filled+stroked boxes are not needed twice
      case OPS.endPath: pending = []; break;
      default: break;
    }
  }
  const V = mergeLines(rawV, 'x', 'y0', 'y1');
  const H = mergeLines(rawH, 'y', 'x0', 'x1');

  return { V, H, items, pageW, pageH: top - page.view[1], vertical: verticalWarned };
}

// ---------------------------------------------------------------- helpers
const vCovers = (v, y) => v.y0 - COVER_TOL <= y && y <= v.y1 + COVER_TOL;
const hCovers = (h, x) => h.x0 - COVER_TOL <= x && x <= h.x1 + COVER_TOL;

function cellOf(pg, x, y) {
  let L = -Infinity, R = Infinity, T = -Infinity, B = Infinity;
  for (const v of pg.V) if (vCovers(v, y)) { if (v.x < x && v.x > L) L = v.x; if (v.x > x && v.x < R) R = v.x; }
  for (const h of pg.H) if (hCovers(h, x)) { if (h.y < y && h.y > T) T = h.y; if (h.y > y && h.y < B) B = h.y; }
  return { L, R, T, B };
}

// Join items that belong to one cell into text lines, in reading order.
export function linesOf(items) {
  if (!items.length) return [];
  const ref = items[0];
  const down = [-ref.up[0], ref.up[1]];         // top-down coords: "next line" direction
  const along = [ref.dir[0], -ref.dir[1]];
  const k = it => it.ox * down[0] + it.oy * down[1];
  const s = it => it.ox * along[0] + it.oy * along[1];
  const sorted = items.slice().sort((p, q) => k(p) - k(q));
  const groups = [];
  for (const it of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(k(it) - g.key) <= 0.5 * Math.min(it.fs, g.fs)) g.items.push(it);
    else groups.push({ key: k(it), fs: it.fs, items: [it] });
  }
  return groups.map(g => {
    const its = g.items.sort((p, q) => s(p) - s(q));
    let out = '', end = null;
    for (const it of its) {
      const st = s(it);
      const len = Math.hypot(it.x1 - it.x0, it.y1 - it.y0) ? (it.upright ? it.x1 - it.x0 : it.y1 - it.y0) : 0;
      if (end !== null && st - end > 0.2 * it.fs && !out.endsWith(' ') && !it.str.startsWith(' ')) out += ' ';
      out += it.str;
      end = st + len;
    }
    return out.replace(/\s+/g, ' ').trim();
  }).filter(t => t.length);
}

const nonWs = s => s.replace(/\s+/g, '').length;

// ---------------------------------------------------------------- page model
function modelPage(pg, pageNo, checks) {
  const err = m => checks.push({ level: 'error', msg: `Page ${pageNo}: ${m}` });
  const warn = m => checks.push({ level: 'warn', msg: `Page ${pageNo}: ${m}` });

  for (const it of pg.items) it.cell = cellOf(pg, it.cx, it.cy);

  // 1. serial-number column: the leftmost column whose cells hold whole numbers
  const intCells = pg.items.filter(it => it.upright && /^\d+$/.test(it.str.trim()) && isFinite(it.cell.L) && isFinite(it.cell.R) && isFinite(it.cell.T) && isFinite(it.cell.B));
  const byCol = new Map();
  for (const it of intCells) {
    const key = `${it.cell.L.toFixed(1)}|${it.cell.R.toFixed(1)}`;
    if (!byCol.has(key)) byCol.set(key, []);
    byCol.get(key).push(it);
  }
  if (!byCol.size) { err('no table with numbered rows was found.'); return null; }
  const nRows = a => new Set(a.map(it => it.cell.T.toFixed(1))).size;
  const maxN = Math.max(...[...byCol.values()].map(nRows));
  const serial = [...byCol.values()].filter(a => nRows(a) >= Math.max(2, maxN * 0.5) || nRows(a) === maxN)
    .sort((p, q) => p[0].cell.L - q[0].cell.L)[0];
  const sL = serial[0].cell.L, sR = serial[0].cell.R, sMid = (sL + sR) / 2;
  const headerBottom = Math.min(...serial.map(it => it.cell.T));

  // 2. table extent = the ruled line on which the first row sits
  const baseLine = pg.H.filter(h => Math.abs(h.y - headerBottom) <= SNAP && hCovers(h, sMid))
    .sort((p, q) => (q.x1 - q.x0) - (p.x1 - p.x0))[0];
  if (!baseLine) { err('could not find the table border under the header.'); return null; }
  const tL = baseLine.x0, tR = baseLine.x1, tW = tR - tL;
  const wide = h => Math.min(h.x1, tR) - Math.max(h.x0, tL) >= tW * 0.95;

  // 3. column boundaries = vertical lines crossing the first data row
  const firstRowMid = (headerBottom + Math.min(...pg.H.filter(h => h.y > headerBottom + SNAP && hCovers(h, sMid)).map(h => h.y))) / 2;
  const colX = pg.V.filter(v => v.x >= tL - SNAP && v.x <= tR + SNAP && vCovers(v, firstRowMid)).map(v => v.x).sort((a, b) => a - b);
  if (colX.length < 3) { err('could not read the column borders.'); return null; }
  const cols = colX.slice(0, -1).map((x, i) => ({ L: x, R: colX[i + 1] }));

  // 4. body rows: bands between full-width lines below the header that the column borders cross
  const bodyY = [...new Set(pg.H.filter(h => h.y >= headerBottom - SNAP && wide(h)).map(h => h.y))].sort((a, b) => a - b);
  const bands = [];
  for (let i = 0; i + 1 < bodyY.length; i++) {
    const y0 = bodyY[i], y1 = bodyY[i + 1], mid = (y0 + y1) / 2;
    if (y1 - y0 < 2) continue;
    const present = colX.filter(x => pg.V.some(v => Math.abs(v.x - x) <= SNAP && vCovers(v, mid)));
    if (present.length < colX.length * 0.5) continue;            // not a table row (e.g. page frame)
    const missing = colX.filter(x => !present.includes(x));
    bands.push({ y0, y1, mid, missing });
  }
  if (!bands.length) { err('no table rows found.'); return null; }
  const tableBottom = bands[bands.length - 1].y1;

  // 5. header band: from the nearest full-width line above the first row
  const above = pg.H.filter(h => h.y < headerBottom - SNAP && wide(h)).map(h => h.y).sort((a, b) => b - a);
  const inTableX = it => it.cx >= tL - SNAP && it.cx <= tR + SNAP;
  let headerTop = null;
  for (const y of above) {
    if (pg.items.some(it => inTableX(it) && it.cy > y && it.cy < headerBottom)) { headerTop = y; break; }
  }

  const used = new Set();
  const take = it => { used.add(it); return it; };

  // 6. header cells per column
  let header = null;
  if (headerTop !== null) {
    header = cols.map((c, ci) => {
      const mx = (c.L + c.R) / 2;
      const ys = [headerTop, ...pg.H.filter(h => h.y > headerTop + SNAP && h.y < headerBottom - SNAP && hCovers(h, mx) && h.x0 <= c.L + COVER_TOL && h.x1 >= c.R - COVER_TOL).map(h => h.y), headerBottom]
        .sort((a, b) => a - b).filter((y, i, arr) => i === 0 || y - arr[i - 1] > SNAP);
      const levels = [];
      for (let i = 0; i + 1 < ys.length; i++) {
        const y0 = ys[i], y1 = ys[i + 1], my = (y0 + y1) / 2;
        const vs = pg.V.filter(v => vCovers(v, my) && v.y0 <= y0 + COVER_TOL + 2 && v.y1 >= y1 - COVER_TOL - 2);
        const L = Math.max(...vs.filter(v => v.x <= c.L + SNAP).map(v => v.x), tL);
        const R = Math.min(...vs.filter(v => v.x >= c.R - SNAP).map(v => v.x), tR);
        const its = pg.items.filter(it => it.cx > L && it.cx < R && it.cy > y0 && it.cy < y1);
        its.forEach(take);
        const label = linesOf(its).reduce((a, l) => !a ? l : (/[A-Za-z0-9]-$/.test(a) && /^[A-Za-z0-9]/.test(l) ? a + l : a + ' ' + l), '');
        const rotated = its.length > 0 && its.every(it => !it.upright);
        levels.push({ id: `${L.toFixed(1)}|${R.toFixed(1)}|${y0.toFixed(1)}|${y1.toFixed(1)}`, label, rotated, nChars: its.reduce((s, it) => s + nonWs(it.str), 0) });
      }
      return levels;
    });
  }

  // 7. body cells
  const rows = bands.map(b => ({ band: b, cells: cols.map(() => []) }));
  for (const it of pg.items) {
    if (used.has(it)) continue;
    if (it.cy < headerBottom - SNAP || it.cy > tableBottom + SNAP || !inTableX(it)) continue;
    const r = rows.find(r => it.cy > r.band.y0 && it.cy < r.band.y1);
    const ci = cols.findIndex(c => it.cx > c.L && it.cx < c.R);
    if (!r || ci < 0) continue;
    const c = cols[ci];
    // text must sit fully inside its cell unless that border is absent in this row
    const leftOk = it.x0 >= c.L - 0.4 || r.band.missing.some(x => Math.abs(x - c.L) <= SNAP);
    const rightOk = it.x1 <= c.R + 0.4 || r.band.missing.some(x => Math.abs(x - c.R) <= SNAP);
    if (!it.space && (!leftOk || !rightOk)) err(`text "${it.str}" crosses a column border; it cannot be placed safely.`);
    r.cells[ci].push(take(it));
  }
  for (const r of rows) {
    if (r.band.missing.length) warn(`a row has merged cells (a column border is missing); check that row in the preview.`);
  }

  // 8. everything else on the page: title block (above table) and other text (below / beside)
  const rest = pg.items.filter(it => !used.has(it));
  const titleItems = rest.filter(it => it.cy < (headerTop ?? headerBottom));
  const otherItems = rest.filter(it => !titleItems.includes(it));
  // group loose text by visual line
  const looseLines = its => {
    const byLine = [];
    for (const it of its.slice().sort((p, q) => p.cy - q.cy)) {
      const g = byLine[byLine.length - 1];
      if (g && Math.abs(it.cy - g.y) < 0.6 * it.fs) g.items.push(it); else byLine.push({ y: it.cy, items: [it] });
    }
    return byLine.map(g => linesOf(g.items.filter(i => i.upright)).join(' ') + (g.items.some(i => !i.upright) ? ' ' + g.items.filter(i => !i.upright).map(i => i.str).join(' ') : '')).map(s => s.trim()).filter(Boolean);
  };

  const outRows = rows.map(r => ({
    page: pageNo,
    cells: r.cells.map(its => linesOf(its)),
    nChars: r.cells.reduce((s, its) => s + its.reduce((t, it) => t + nonWs(it.str), 0), 0),
  })).filter(r => r.cells.some(c => c.length));

  // no visible character inside the table area may be left unplaced
  const strays = pg.items.filter(it => !it.space && !used.has(it) && inTableX(it) && it.cy > (headerTop ?? headerBottom) && it.cy < tableBottom);
  if (strays.length) err(`${strays.length} character(s) inside the table could not be placed in a cell ("${strays.slice(0, 10).map(i => i.str).join('')}").`);

  // character reconciliation for this page
  const totalChars = pg.items.reduce((s, it) => s + nonWs(it.str), 0);
  const placed = [...used].reduce((s, it) => s + nonWs(it.str), 0) + rest.reduce((s, it) => s + nonWs(it.str), 0);
  if (placed !== totalChars) err('character count mismatch while placing text.');

  return {
    pageNo, cols, header, rows: outRows,
    title: looseLines(titleItems).map(t => t.replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean), other: looseLines(otherItems),
    stats: { totalChars, bodyChars: outRows.reduce((s, r) => s + r.nChars, 0), headerChars: header ? [...new Map(header.flat().map(l => [l.id, l.nChars])).values()].reduce((a, b) => a + b, 0) : 0, looseChars: rest.reduce((s, it) => s + nonWs(it.str), 0) },
  };
}

// ---------------------------------------------------------------- document
export async function extractTable(pdf, OPS) {
  const checks = [];
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const pg = await readPage(page, OPS);
    if (pg.vertical) checks.push({ level: 'warn', msg: `Page ${n} uses vertical-writing fonts; check it carefully.` });
    const m = modelPage(pg, n, checks);
    if (m) pages.push(m);
  }
  if (!pages.length) return { ok: false, checks };

  const first = pages.find(p => p.header);
  if (!first) { checks.push({ level: 'error', msg: 'No column headers were found.' }); return { ok: false, checks }; }
  const header = first.header;
  const nCols = header.length;
  const sig = h => h.map(lv => lv.map(l => l.label).join(' › ')).join(' ‖ ');

  for (const p of pages) {
    if (p.cols.length !== nCols) {
      checks.push({ level: 'error', msg: `Page ${p.pageNo} has ${p.cols.length} columns but page ${first.pageNo} has ${nCols}. Pages cannot be joined safely.` });
    } else if (p.header && sig(p.header) !== sig(header)) {
      checks.push({ level: 'error', msg: `Page ${p.pageNo} column headings differ from page ${first.pageNo}.` });
    } else if (!p.header) {
      const same = p.cols.every((c, i) => Math.abs(c.L - first.cols[i].L) < 1 && Math.abs(c.R - first.cols[i].R) < 1);
      if (!same) checks.push({ level: 'error', msg: `Page ${p.pageNo} has no heading row and its column positions differ from page ${first.pageNo}.` });
      else checks.push({ level: 'warn', msg: `Page ${p.pageNo} has no heading row; used page ${first.pageNo} headings (same column positions).` });
    }
  }

  // header levels normalised
  const depth = Math.max(...header.map(l => l.length));
  const columns = header.map((levels, i) => ({
    index: i,
    levels,
    leaf: levels[levels.length - 1].label || `Column ${i + 1}`,
    group: levels.length > 1 ? levels[0] : null,
    rotated: levels[levels.length - 1].rotated,
  }));
  columns.forEach((c, i) => { if (!c.levels[c.levels.length - 1].label) checks.push({ level: 'warn', msg: `Column ${i + 1} has an empty heading; named "Column ${i + 1}".` }); });

  const rows = pages.flatMap(p => p.rows);

  // Multi-line cells. The ERP prints some values on a second line in brackets,
  // e.g. "44.1" + "(A2)" or "235.3 / 300" + "(78.45%)"; those become their own column.
  // Any other line break is the browser wrapping a long value, so the lines are
  // joined back together. A break right after a hyphen is joined without a space
  // (that is how browsers wrap "SURI-MEHTA") and reported for a manual look.
  const hyphenJoins = [];
  const joinWrapped = (lines, where) => {
    let out = '';
    lines.forEach((ln, i) => {
      if (i === 0) { out = ln; return; }
      if (/[A-Za-z0-9]-$/.test(out) && /^[A-Za-z0-9]/.test(ln)) { out += ln; hyphenJoins.push(where); }
      else out += ' ' + ln;
    });
    return out;
  };
  const isBracket = v => /^\([^()]*\)$/.test(v);
  columns.forEach((c, i) => {
    const filled = rows.filter(r => r.cells[i].length);
    const multi = filled.filter(r => r.cells[i].length > 1);
    c.parts = 1;
    if (!multi.length) return;
    const bracketed = filled.filter(r => r.cells[i].length > 1 && isBracket(r.cells[i][r.cells[i].length - 1]));
    if (bracketed.length >= filled.length * 0.8) {
      c.parts = 2; c.mode = 'bracket';
      const odd = filled.length - bracketed.length;
      if (odd) checks.push({ level: 'warn', msg: `"${c.leaf}"${c.group ? ' (' + c.group.label + ')' : ''}: ${odd} cell(s) have no bracketed second line; the whole cell was kept in the first column.` });
    } else {
      c.mode = 'joined';
      checks.push({ level: 'info', msg: `"${c.leaf}": ${multi.length} cell(s) wrap onto more than one line; the lines were joined back into one value.` });
    }
  });

  // sub-column names for bracketed second lines
  for (const c of columns) {
    c.partNames = [c.leaf];
    if (c.parts === 2) {
      const vals = rows.map(r => r.cells[c.index]).filter(l => l.length > 1 && isBracket(l[l.length - 1])).map(l => l[l.length - 1]);
      let name = `${c.leaf} (2nd line)`;
      if (vals.every(v => /%\)$/.test(v))) name = 'Percentage';
      else if (vals.every(v => /^\([A-Z][A-Z0-9+\-]{0,3}\)$/.test(v))) name = 'Grade';
      c.partNames.push(name);
    }
  }

  // flat output grid
  const flatCols = columns.flatMap(c => c.partNames.map((n, k) => ({ col: c, part: k, name: n })));
  const grid = rows.map(r => {
    const sn = r.cells[0].join(' ');
    return flatCols.map(fc => {
      const lines = r.cells[fc.col.index];
      const where = `S.No ${sn}, ${fc.col.group ? fc.col.group.label + ' › ' : ''}${fc.col.leaf}`;
      if (fc.col.parts === 2) {
        const hasB = lines.length > 1 && isBracket(lines[lines.length - 1]);
        if (fc.part === 1) return hasB ? lines[lines.length - 1] : '';
        return joinWrapped(hasB ? lines.slice(0, -1) : lines, where);
      }
      return joinWrapped(lines, where);
    });
  });
  // printable layout uses the same logical parts (wraps re-joined)
  const printRows = rows.map((r, ri) => ({
    page: r.page,
    cells: columns.map(c => {
      if (c.parts === 2) {
        const i0 = flatCols.findIndex(fc => fc.col === c);
        return [grid[ri][i0], grid[ri][i0 + 1]].filter(v => v !== '');
      }
      const i0 = flatCols.findIndex(fc => fc.col === c);
      return grid[ri][i0] === '' ? [] : [grid[ri][i0]];
    }),
  }));
  if (hyphenJoins.length) checks.push({ level: 'warn', msg: `${hyphenJoins.length} value(s) wrapped after a hyphen and were joined without a space (e.g. "SURI-" + "MEHTA" → "SURI-MEHTA"). Please glance at: ${hyphenJoins.slice(0, 5).join('; ')}${hyphenJoins.length > 5 ? '…' : ''}` });

  // ---- checks
  const serials = rows.map(r => r.cells[0].join(' '));
  const nums = serials.map(s => /^\d+$/.test(s) ? +s : null);
  const nonNum = nums.filter(n => n === null).length;
  if (nonNum) checks.push({ level: 'warn', msg: `${nonNum} row(s) do not start with a serial number; they are kept as-is.` });
  const seq = nums.filter(n => n !== null);
  const gaps = [];
  for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1] + 1) gaps.push(`${seq[i - 1]}→${seq[i]}`);
  if (gaps.length) checks.push({ level: 'warn', msg: `Serial numbers are not continuous: ${gaps.slice(0, 6).join(', ')}${gaps.length > 6 ? '…' : ''}` });
  else checks.push({ level: 'ok', msg: `Serial numbers ${seq[0]}–${seq[seq.length - 1]} are continuous across ${pages.length} page(s); ${rows.length} rows read.` });

  const totalChars = pages.reduce((s, p) => s + p.stats.totalChars, 0);
  const bodyChars = pages.reduce((s, p) => s + p.stats.bodyChars, 0);
  const gridChars = grid.reduce((s, r) => s + r.reduce((t, v) => t + nonWs(v), 0), 0);
  if (gridChars !== bodyChars) checks.push({ level: 'error', msg: `Character check failed: table cells hold ${bodyChars} characters but the export has ${gridChars}.` });
  else checks.push({ level: 'ok', msg: `Character check passed: all ${bodyChars.toLocaleString()} characters inside the table cells are in the export, none added or lost.` });

  const other = pages.flatMap(p => p.other.map(t => ({ page: p.pageNo, text: t })));
  if (other.length) checks.push({ level: 'info', msg: `${other.length} line(s) of text outside the table (e.g. footer) are not part of the data; listed on the Info sheet.` });

  if (!checks.some(c => c.level === 'error')) checks.unshift({ level: 'ok', msg: `Every value was read from a ruled cell; no text crossed a cell border.` });

  return {
    ok: !checks.some(c => c.level === 'error'),
    checks,
    title: first.title.length ? first.title : pages[0].title,
    other,
    depth,
    columns,
    flatCols,
    rows: printRows, // rows[i].cells[col] = [part, part]  (used for printing)
    grid,          // grid[i][flatCol] = exact text     (used for Excel)
    stats: { pages: pdf.numPages, totalChars, bodyChars },
  };
}
