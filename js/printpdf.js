// Printable, readable version of the sheet. Subjects are spread over several A4
// sheets ("parts") at a comfortable font size. Every part uses the same row
// heights, header height and rows-per-page, so printed parts line up exactly
// when placed side by side. Values are printed exactly as extracted.

const MM = 72 / 25.4;

function wrapWords(doc, text, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (!cur || doc.getTextWidth(t) <= maxW) cur = t;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

export function planPrint(doc, result, opts) {
  const fs = opts.fontSize;
  const hfs = Math.max(6, fs - 1);
  const pad = Math.max(2.5, fs * 0.35);
  const lineH = fs * 1.18;
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const m = opts.margin * MM;
  const cols = result.columns;
  const rows = result.rows;

  // column widths from the widest value
  doc.setFont('helvetica', 'normal'); doc.setFontSize(fs);
  const bodyW = cols.map(c => Math.max(0, ...rows.map(r => Math.max(0, ...r.cells[c.index].map(v => doc.getTextWidth(v))))) + 2 * pad);

  // rotated leaf headers for subject columns, horizontal headers otherwise
  doc.setFont('helvetica', 'bold'); doc.setFontSize(hfs);
  const maxRot = opts.maxHeaderMM * MM;
  const leaf = cols.map((c, i) => {
    if (c.group) {
      const lines = wrapWords(doc, c.leaf, maxRot);
      const len = Math.max(...lines.map(l => doc.getTextWidth(l)));
      return { rotated: true, lines, len, minW: lines.length * hfs * 1.15 + 2 * pad };
    }
    return { rotated: false };
  });
  const widths = cols.map((c, i) => {
    let w = bodyW[i];
    if (leaf[i].rotated) w = Math.max(w, leaf[i].minW);
    else {
      const longestWord = Math.max(...c.leaf.split(/\s+/).map(t => doc.getTextWidth(t))) + 2 * pad;
      w = Math.max(w, longestWord, Math.min(doc.getTextWidth(c.leaf) + 2 * pad, 60));
    }
    return Math.max(w, fs * 1.6);
  });

  // fixed columns (S.No., Name…) and chunks (a subject, or trailing columns)
  const firstGroup = cols.findIndex(c => c.group);
  const fixed = firstGroup > 0 ? cols.slice(0, firstGroup).map(c => c.index) : [0];
  const chunks = [];
  for (const c of cols) {
    if (fixed.includes(c.index)) continue;
    const key = c.group ? c.group.id : '__rest';
    const last = chunks[chunks.length - 1];
    if (last && last.key === key) last.cols.push(c.index);
    else chunks.push({ key, label: c.group ? c.group.label : '', cols: [c.index] });
  }
  const fixedW = fixed.reduce((s, i) => s + widths[i], 0);
  const availFirst = W - 2 * m - fixedW;
  const availNext = W - 2 * m - (opts.repeatFixed ? fixedW : 0);

  const parts = [];
  let cur = [], curW = 0;
  const avail = () => (parts.length === 0 ? availFirst : availNext);
  const chunkW = ch => ch.cols.reduce((s, i) => s + widths[i], 0);
  const perPage = opts.subjectsPerPage || 0;
  const pieces = [];
  for (const ch of chunks) {   // a subject wider than a page is split into pieces
    if (chunkW(ch) <= Math.min(availFirst, availNext)) { pieces.push(ch); continue; }
    let p = { ...ch, cols: [] }, pw = 0;
    for (const i of ch.cols) {
      if (p.cols.length && pw + widths[i] > Math.min(availFirst, availNext)) { pieces.push(p); p = { ...ch, cols: [], cont: true }; pw = 0; }
      p.cols.push(i); pw += widths[i];
    }
    pieces.push(p);
  }
  for (const ch of pieces) {
    const w = chunkW(ch);
    const countSubjects = cur.filter(c => c.key !== '__rest').length;
    const full = cur.length && (curW + w > avail() || (perPage && ch.key !== '__rest' && countSubjects >= perPage));
    if (full) { parts.push(cur); cur = []; curW = 0; }
    cur.push(ch); curW += w;
  }
  if (cur.length) parts.push(cur);

  // spread the pieces evenly over the same number of sheets (keeps order)
  if (parts.length > 1 && !perPage) {
    const P = parts.length, n = pieces.length, w = pieces.map(chunkW);
    const pre = [0]; w.forEach(x => pre.push(pre[pre.length - 1] + x));
    const span = (a, b) => pre[b] - pre[a];
    const INF = 1e18;
    const best = Array.from({ length: P + 1 }, () => Array(n + 1).fill(INF));
    const cut = Array.from({ length: P + 1 }, () => Array(n + 1).fill(-1));
    best[0][0] = 0;
    for (let p = 1; p <= P; p++) for (let b = 1; b <= n; b++) for (let a = p - 1; a < b; a++) {
      const cap = p === 1 ? availFirst : availNext;
      if (span(a, b) > cap || best[p - 1][a] === INF) continue;
      const v = Math.max(best[p - 1][a], span(a, b));
      if (v < best[p][b]) { best[p][b] = v; cut[p][b] = a; }
    }
    if (best[P][n] < INF) {
      const out = []; let b = n;
      for (let p = P; p >= 1; p--) { const a = cut[p][b]; out.unshift(pieces.slice(a, b)); b = a; }
      parts.length = 0; parts.push(...out);
    }
  }

  // vertical layout — identical on every part
  doc.setFont('helvetica', 'bold'); doc.setFontSize(hfs);
  // stretch columns so each sheet uses the page width (at most 1.5x); rows stay aligned
  for (const part of parts) {
    const ids = part.flatMap(ch => ch.cols);
    const used = ids.reduce((a, i) => a + widths[i], 0);
    const room = (parts.indexOf(part) === 0 ? availFirst : availNext);
    const f = Math.min(1.5, room / used);
    if (f > 1) ids.forEach(i => { widths[i] *= f; });
  }
  // subject names may wrap (e.g. "Artificial Intelligence" over three narrow columns)
  const groupLines = {};
  for (const part of parts) for (const ch of part) if (ch.label) {
    const span = ch.cols.reduce((a, i) => a + widths[i], 0);
    const lines = wrapWords(doc, ch.label + (ch.cont ? ' (contd.)' : ''), span - 2 * pad);
    groupLines[ch.key + (ch.cont ? '+' : '')] = lines;
  }
  const maxGL = Math.max(1, ...Object.values(groupLines).map(l => l.length));
  const groupH = maxGL * hfs * 1.2 + 2 * pad;
  const leafH = Math.max(hfs * 2.4 + 2 * pad, ...leaf.filter(l => l.rotated).map(l => l.len + 2 * pad));
  const flatHead = cols.filter((c, i) => !leaf[i].rotated).map(c => wrapWords(doc, c.leaf, widths[c.index] - 2 * pad).length * hfs * 1.15 + 2 * pad);
  const headH = Math.max(groupH + leafH, ...flatHead);
  // compact title: school name + one line with report name and class
  const t = result.title;
  const key = t.slice(1).filter(l => /sheet|class|term|session|exam|report/i.test(l));
  const titleLines = t.length ? [t[0], ...(key.length ? [key.join('   ·   ')] : [])] : [];
  const titleH = (titleLines.length ? fs * 1.5 + (titleLines.length - 1) * (fs * 1.2) : 0) + fs * 0.7;
  const footH = fs * 1.6;
  const rowH = rows.map(r => Math.max(1, ...r.cells.map(c => c.length)) * lineH + 2 * pad * 0.6);
  const bodyAvail = H - 2 * m - titleH - headH - footH;
  const blocks = [];
  let start = 0;
  while (start < rows.length) {
    let h = 0, end = start;
    while (end < rows.length && h + rowH[end] <= bodyAvail) { h += rowH[end]; end++; }
    if (end === start) end = start + 1;
    blocks.push([start, end]);
    start = end;
  }
  return { fs, hfs, pad, lineH, W, H, m, cols, rows, widths, fixed, parts, groupH, groupLines, leafH, headH, titleLines, titleH, footH, rowH, blocks, leaf };
}

export function buildPrintPdf(jsPDF, result, userOpts = {}) {
  const opts = { orientation: 'portrait', fontSize: 10, margin: 8, repeatFixed: true, maxHeaderMM: 32, subjectsPerPage: 0, ...userOpts };
  const doc = new jsPDF({ orientation: opts.orientation, unit: 'pt', format: 'a4', compress: true });
  const P = planPrint(doc, result, opts);
  const { fs, hfs, pad, lineH, W, H, m, widths } = P;
  const total = P.blocks.length * P.parts.length;
  const clsLine = result.title.find(t => /class\s*[:\-]/i.test(t)) || '';
  let pageNo = 0;

  const INK = [31, 42, 48], GRID = [150, 162, 160], HEAD_BG = [226, 240, 237], GROUP_BG = [205, 229, 224], ZEBRA = [246, 249, 248];

  P.blocks.forEach(([r0, r1], bi) => {
    P.parts.forEach((part, pi) => {
      if (pageNo++) doc.addPage();
      const colsHere = [...((pi === 0 || opts.repeatFixed) ? P.fixed : []), ...part.flatMap(ch => ch.cols)];
      const tableW = colsHere.reduce((s, i) => s + widths[i], 0);
      const x0 = m;
      let y = m;

      // title block
      doc.setTextColor(...INK);
      P.titleLines.forEach((t, i) => {
        doc.setFont('helvetica', i === 0 ? 'bold' : 'normal');
        doc.setFontSize(i === 0 ? fs + 2 : fs);
        doc.text(t, W / 2, y + (i === 0 ? fs + 1 : fs * 1.5 + i * fs * 1.2), { align: 'center' });
      });
      // part marker, top right
      doc.setFont('helvetica', 'bold'); doc.setFontSize(fs);
      doc.text(`Part ${pi + 1} of ${P.parts.length}`, W - m, y + fs, { align: 'right' });
      y += P.titleH;

      // header
      const hy = y;
      doc.setLineWidth(0.5); doc.setDrawColor(...GRID);
      let x = x0;
      const drawn = new Set();
      for (const ci of colsHere) {
        const c = P.cols[ci], w = widths[ci];
        if (P.leaf[ci].rotated) {
          // group cell spanning this subject's columns on this part
          const gid = c.group.id;
          if (!drawn.has(gid)) {
            drawn.add(gid);
            const span = colsHere.filter(k => P.cols[k].group && P.cols[k].group.id === gid).reduce((s, k) => s + widths[k], 0);
            doc.setFillColor(...GROUP_BG); doc.rect(x, hy, span, P.groupH, 'FD');
            doc.setFont('helvetica', 'bold'); doc.setFontSize(hfs); doc.setTextColor(...INK);
            const piece = part.find(ch => ch.cols.includes(ci));
            const label = c.group.label + (piece && piece.cont ? ' (contd.)' : '');
            const gl = P.groupLines[(piece ? piece.key : gid) + (piece && piece.cont ? '+' : '')] || wrapWords(doc, label, span - 2 * pad);
            const gb = gl.length * hfs * 1.2;
            gl.forEach((ln, li) => doc.text(ln, x + span / 2, hy + (P.groupH - gb) / 2 + (li + 0.8) * hfs * 1.2, { align: 'center' }));
          }
          doc.setFillColor(...HEAD_BG); doc.rect(x, hy + P.groupH, w, P.headH - P.groupH, 'FD');
          doc.setFont('helvetica', 'bold'); doc.setFontSize(hfs); doc.setTextColor(...INK);
          const lines = P.leaf[ci].lines;
          const block = lines.length * hfs * 1.15;
          lines.forEach((ln, li) => {
            const tx = x + (w - block) / 2 + (li + 1) * hfs * 1.15 - hfs * 0.25;
            doc.text(ln, tx, hy + P.headH - pad, { angle: 90 });
          });
        } else {
          doc.setFillColor(...HEAD_BG); doc.rect(x, hy, w, P.headH, 'FD');
          doc.setFont('helvetica', 'bold'); doc.setFontSize(hfs); doc.setTextColor(...INK);
          const lines = wrapWords(doc, c.leaf, w - 2 * pad);
          const block = lines.length * hfs * 1.15;
          lines.forEach((ln, li) => doc.text(ln, x + w / 2, hy + (P.headH - block) / 2 + (li + 0.8) * hfs * 1.15, { align: 'center' }));
        }
        x += w;
      }
      y = hy + P.headH;

      // body
      doc.setFont('helvetica', 'normal'); doc.setFontSize(fs); doc.setTextColor(...INK);
      for (let ri = r0; ri < r1; ri++) {
        const rh = P.rowH[ri];
        if ((ri - r0) % 2 === 1) { doc.setFillColor(...ZEBRA); doc.rect(x0, y, tableW, rh, 'F'); }
        x = x0;
        for (const ci of colsHere) {
          const w = widths[ci];
          doc.rect(x, y, w, rh, 'S');
          const vals = P.rows[ri].cells[ci];
          const block = vals.length * lineH;
          const left = ci === 1 && !P.cols[ci].group;
          vals.forEach((v, li) => {
            const ty = y + (rh - block) / 2 + li * lineH + fs * 0.88;
            if (left) doc.text(v, x + pad, ty); else doc.text(v, x + w / 2, ty, { align: 'center' });
          });
          x += w;
        }
        y += rh;
      }

      // footer
      doc.setFont('helvetica', 'normal'); doc.setFontSize(fs - 2); doc.setTextColor(90, 100, 105);
      const subj = part.map(ch => ch.label || 'Totals').filter((v, i, a) => a.indexOf(v) === i).join(', ');
      const sn = k => (P.rows[k].cells[0] || [])[0] || String(k + 1);
      doc.text([clsLine, `Students ${sn(r0)}–${sn(r1 - 1)}`, `Part ${pi + 1} of ${P.parts.length}: ${subj}`, pi > 0 ? `place to the right of Part ${pi}` : ''].filter(Boolean).join('   ·   '), m, H - m + 2);
      doc.text(`Page ${pageNo} of ${total}`, W - m, H - m + 2, { align: 'right' });
    });
  });
  return { doc, plan: { parts: P.parts.length, blocks: P.blocks.length, pages: total, partLabels: P.parts.map(p => p.map(ch => ch.label || 'Totals').filter((v, i, a) => a.indexOf(v) === i)) } };
}

export function unprintable(result) {
  const bad = new Set();
  for (const r of result.rows) for (const c of r.cells) for (const v of c) for (const ch of v) if (ch.charCodeAt(0) > 255) bad.add(ch);
  return [...bad];
}
