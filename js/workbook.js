// Excel export. Values are written exactly as read. Numbers such as "5.0" are
// stored as numbers with a matching display format (so Excel shows "5.0", and
// sums/sorting work); everything else ("AB", "(A2)", "235.3 / 300") stays text.

const NUM = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const HEAD_FILL = 'FF0B6E63';
const GROUP_FILL = 'FF0E8577';
const BORDER = { style: 'thin', color: { argb: 'FFB9C4C2' } };
const BOX = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };

export function toCell(v, numbers) {
  if (numbers && NUM.test(v) && !(v.startsWith('-') && Number(v) === 0) && v.replace(/[^0-9]/g, '').length <= 15) {
    const dec = (v.split('.')[1] || '').length;
    return { value: Number(v), numFmt: dec ? '0.' + '0'.repeat(dec) : '0' };
  }
  return { value: v, numFmt: '@' };
}

export function classLabel(result, fallback) {
  const line = result.title.find(t => /class\s*[:\-]/i.test(t));
  if (line) {
    const m = line.match(/class\s*[:\-]\s*(.+)$/i);
    if (m) return ('Class ' + m[1].trim()).replace(/\s+/g, ' ');
  }
  return fallback;
}

export function safeSheetName(name, taken) {
  let base = name.replace(/[\[\]\*\?\/\\:]/g, '-').slice(0, 31).trim() || 'Sheet';
  let n = base, k = 2;
  while (taken.has(n.toLowerCase())) { const suf = ` (${k++})`; n = base.slice(0, 31 - suf.length) + suf; }
  taken.add(n.toLowerCase());
  return n;
}

export function addResultSheet(wb, result, name, opts = {}) {
  const numbers = opts.numbers !== false;
  const ws = wb.addWorksheet(name, { views: [] });
  const fc = result.flatCols;
  const nC = fc.length;
  let r = 1;

  // title block
  result.title.forEach((t, i) => {
    ws.mergeCells(r, 1, r, nC);
    const c = ws.getCell(r, 1);
    c.value = t;
    c.font = { bold: i === 0, size: i === 0 ? 14 : 10, color: { argb: 'FF1F2A30' } };
    c.alignment = { horizontal: 'center' };
    r++;
  });
  if (result.title.length) r++;

  // headers: level 0 = group (subject), level 1 = column
  const h0 = r, h1 = r + 1;
  const style = (cell, fill, rot) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    cell.alignment = { horizontal: 'center', vertical: rot ? 'bottom' : 'middle', wrapText: !rot, textRotation: rot ? 90 : 0 };
    cell.border = BOX;
  };
  let i = 0;
  while (i < nC) {
    const col = fc[i].col;
    if (col.group) {
      let j = i;
      while (j + 1 < nC && fc[j + 1].col.group && fc[j + 1].col.group.id === col.group.id) j++;
      if (j > i) ws.mergeCells(h0, i + 1, h0, j + 1);
      ws.getCell(h0, i + 1).value = col.group.label;
      for (let k = i; k <= j; k++) { style(ws.getCell(h0, k + 1), GROUP_FILL); ws.getCell(h1, k + 1).value = fc[k].name; style(ws.getCell(h1, k + 1), HEAD_FILL, true); }
      i = j + 1;
    } else {
      ws.mergeCells(h0, i + 1, h1, i + 1);
      ws.getCell(h0, i + 1).value = fc[i].name;
      style(ws.getCell(h0, i + 1), HEAD_FILL); style(ws.getCell(h1, i + 1), HEAD_FILL);
      i++;
    }
  }
  const longest = Math.max(...fc.filter(f => f.col.group).map(f => f.name.length), 4);
  ws.getRow(h0).height = 20;
  ws.getRow(h1).height = Math.min(170, 12 + longest * 6.2);

  // data
  let dr = h1 + 1;
  for (const row of result.grid) {
    row.forEach((v, ci) => {
      const cell = ws.getCell(dr, ci + 1);
      const t = toCell(v, numbers);
      cell.value = v === '' ? null : t.value;
      cell.numFmt = t.numFmt;
      cell.border = BOX;
      cell.alignment = { horizontal: fc[ci].col.index === 1 ? 'left' : 'center', vertical: 'middle' };
      cell.font = { size: 10 };
    });
    dr++;
  }

  // widths
  fc.forEach((f, ci) => {
    const maxLen = Math.max(...result.grid.map(r => (r[ci] || '').length), f.col.group ? 3 : Math.min(f.name.length, 14));
    ws.getColumn(ci + 1).width = Math.max(5.5, Math.min(40, maxLen + 2));
  });

  const fixed = fc.findIndex(f => f.col.group);
  ws.views = [{ state: 'frozen', xSplit: fixed > 0 ? fixed : 0, ySplit: h1 }];
  ws.autoFilter = { from: { row: h1, column: 1 }, to: { row: dr - 1, column: nC } };
  ws.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${h0}:${h1}` };

  return { ws, dataStartRow: h1 + 1 };
}

export function addInfoSheet(wb, entries, opts = {}) {
  const ws = wb.addWorksheet(opts.name || 'Info');
  ws.getColumn(1).width = 22; ws.getColumn(2).width = 110;
  let r = 1;
  const put = (a, b, bold) => { ws.getCell(r, 1).value = a; ws.getCell(r, 2).value = b; if (bold) ws.getRow(r).font = { bold: true }; ws.getCell(r, 2).alignment = { wrapText: true, vertical: 'top' }; r++; };
  put('Converted', new Date().toLocaleString(), false);
  put('Number cells', opts.numbers === false ? 'Kept as text exactly as in the PDF' : 'Plain numbers stored as numbers with the same decimals shown as in the PDF; everything else kept as text', false);
  r++;
  for (const e of entries) {
    put('Sheet', e.sheet, true);
    put('Source PDF', e.fileName);
    put('Pages', String(e.result.stats.pages));
    put('Students (rows)', String(e.result.grid.length));
    put('Columns', String(e.result.flatCols.length));
    for (const c of e.result.checks) put(c.level === 'ok' ? '✓ Check' : c.level === 'error' ? '✗ Problem' : c.level === 'warn' ? '⚠ Please check' : 'Note', c.msg);
    if (e.verified) put('✓ Check', e.verified);
    for (const o of e.result.other) put(`Not in table (p.${o.page})`, o.text);
    r++;
  }
  return ws;
}

// Read the workbook back and compare every cell with the extracted text.
export async function verifyWorkbook(ExcelJS, buffer, entries, opts = {}) {
  const numbers = opts.numbers !== false;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const problems = [];
  let cells = 0;
  for (const e of entries) {
    const ws = wb.getWorksheet(e.sheet);
    if (!ws) { problems.push(`Sheet ${e.sheet} missing`); continue; }
    e.result.grid.forEach((row, ri) => {
      row.forEach((v, ci) => {
        const cell = ws.getCell(e.dataStartRow + ri, ci + 1);
        let got = cell.value;
        if (got === null || got === undefined) got = '';
        else if (typeof got === 'number') {
          const dec = (v.split('.')[1] || '').length;
          got = got.toFixed(dec);
        } else if (typeof got === 'object' && got.richText) got = got.richText.map(t => t.text).join('');
        else got = String(got);
        cells++;
        if (got !== v) problems.push(`${e.sheet} row ${ri + 1} col ${ci + 1}: "${v}" became "${got}"`);
      });
    });
  }
  return { ok: problems.length === 0, cells, problems };
}

export async function buildWorkbook(ExcelJS, entries, opts = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Green Sheet to Excel';
  const taken = new Set(['info']);
  for (const e of entries) {
    e.sheet = safeSheetName(e.sheetBase, taken);
    const { dataStartRow } = addResultSheet(wb, e.result, e.sheet, opts);
    e.dataStartRow = dataStartRow;
  }
  // verify the data sheets first, then record the result on the Info sheet
  let buffer = await wb.xlsx.writeBuffer();
  const v = await verifyWorkbook(ExcelJS, buffer, entries, opts);
  for (const e of entries) e.verified = v.ok ? `Excel read back and compared: all ${e.result.grid.length * e.result.flatCols.length} cells identical to the PDF text.` : null;
  addInfoSheet(wb, entries, opts);
  buffer = await wb.xlsx.writeBuffer();
  const v2 = await verifyWorkbook(ExcelJS, buffer, entries, opts);
  return { buffer, verify: v2 };
}
