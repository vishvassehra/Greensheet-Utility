import * as pdfjs from '../vendor/pdf.min.mjs';
import { extractTable } from './extractor.js';
import { buildWorkbook, classLabel } from './workbook.js';
import { buildPrintPdf, planPrint, unprintable } from './printpdf.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
const ExcelJS = window.ExcelJS;
const { jsPDF } = window.jspdf;

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const entries = [];
let uid = 0;

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}
function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const baseName = f => f.replace(/\.pdf$/i, '');
const numbersOn = () => $('#optNumbers').checked;

// ---------------------------------------------------------------- input
const drop = $('#drop');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => handle([...e.dataTransfer.files]));
$('#pick').addEventListener('change', e => { handle([...e.target.files]); e.target.value = ''; });

async function handle(files) {
  const pdfs = files.filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!pdfs.length) { toast('Please choose PDF files'); return; }
  $('#empty').hidden = true;
  for (const f of pdfs) await addFile(f);
}

async function addFile(file) {
  const id = 'f' + (++uid);
  const card = document.createElement('article');
  card.className = 'file'; card.id = id;
  card.innerHTML = `<div class="busy">Reading <b>${esc(file.name)}</b>…</div>`;
  $('#files').prepend(card);
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
    const result = await extractTable(pdf, pdfjs.OPS);
    const entry = { id, fileName: file.name, result, sheetBase: result.columns ? classLabel(result, baseName(file.name)) : baseName(file.name), override: false };
    entries.push(entry);
    render(entry, card);
  } catch (err) {
    console.error(err);
    card.innerHTML = `<div class="file-head"><div><h2>${esc(file.name)}</h2><div class="src">This file could not be read as a PDF: ${esc(err.message || err)}</div></div><div class="head-right"><span class="status err">Not converted</span><button class="remove" data-role="remove">Remove</button></div></div>`;
    $('[data-role=remove]', card).addEventListener('click', () => removeEntry(id));
  }
  refreshBulk();
}

function removeEntry(id) {
  const i = entries.findIndex(e => e.id === id);
  if (i >= 0) entries.splice(i, 1);
  document.getElementById(id)?.remove();
  if (!$('#files').children.length) $('#empty').hidden = false;
  refreshBulk();
}
$('#clearAll').addEventListener('click', () => {
  entries.length = 0;
  $('#files').innerHTML = '';
  $('#empty').hidden = false;
  $('#pick').value = '';
  refreshBulk();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  toast('Cleared. Add the next PDF.');
});

function refreshBulk() {
  const usable = entries.filter(e => e.result.columns && (e.result.ok || e.override));
  $('#bulk').hidden = entries.length === 0 && !$('#files').children.length;
  $('#allXlsx').disabled = usable.length === 0;
  $('#allXlsx').textContent = usable.length > 1 ? `Download ${usable.length} classes in one workbook` : 'Download Excel';
}

// ---------------------------------------------------------------- card
const ICON = { ok: '✓', error: '✕', warn: '!', info: 'i' };

function render(entry, card) {
  const r = entry.result;
  if (!r.columns) {
    card.innerHTML = `<div class="file-head"><div><h2>${esc(entry.fileName)}</h2><div class="src">No green sheet table was found in this file.</div></div><div class="head-right"><span class="status err">Not converted</span><button class="remove" data-role="remove">Remove</button></div></div>
      <div class="pane"><ul class="checks">${r.checks.map(c => `<li class="${c.level}"><span class="ic">${ICON[c.level]}</span><span>${esc(c.msg)}</span></li>`).join('')}</ul></div>`;
    $('[data-role=remove]', card).addEventListener('click', () => removeEntry(entry.id));
    return;
  }
  const subjects = [...new Set(r.columns.filter(c => c.group).map(c => c.group.label))];
  const status = r.ok ? (r.checks.some(c => c.level === 'warn') ? ['warn', 'Converted, please review'] : ['ok', 'Verified']) : ['err', 'Stopped: needs attention'];
  const bad = unprintable(r);
  card.innerHTML = `
    <div class="file-head">
      <div>
        <h2>${esc(entry.sheetBase)}</h2>
        <div class="src">${esc(r.title[1] && !/class/i.test(r.title[0]) ? r.title[0] : '')}${r.title.length ? ' · ' : ''}${esc(entry.fileName)}</div>
        <div class="stats">
          <div class="stat"><b>${r.grid.length}</b><span>Students</span></div>
          <div class="stat"><b>${subjects.length}</b><span>Subjects</span></div>
          <div class="stat"><b>${r.flatCols.length}</b><span>Excel columns</span></div>
          <div class="stat"><b>${r.stats.pages}</b><span>PDF pages</span></div>
        </div>
      </div>
      <div class="head-right"><span class="status ${status[0]}">${status[1]}</span><button class="remove" data-role="remove" aria-label="Remove ${esc(entry.fileName)}">Remove</button></div>
    </div>
    <div class="body">
      <div class="pane">
        <h3>Accuracy checks</h3>
        <ul class="checks">${r.checks.map(c => `<li class="${c.level}"><span class="ic">${ICON[c.level]}</span><span>${esc(c.msg)}</span></li>`).join('')}
          <li class="info" data-role="xlcheck"><span class="ic">i</span><span>When you download, the Excel file is read back and compared with the PDF, cell by cell.</span></li>
        </ul>
        ${r.ok ? '' : `<label class="override"><input type="checkbox" data-role="override"> I have checked the problems above; allow download anyway</label>`}
        <div class="actions">
          <button class="btn primary" data-role="xlsx">Download Excel</button>
        </div>
      </div>
      <div class="pane">
        <h3>Large-print PDF</h3>
        <div class="printgrid">
          <label class="field">Paper<select id="${entry.id}-orient"><option value="landscape">A4 landscape</option><option value="portrait">A4 portrait</option></select></label>
          <label class="field">Text size<select id="${entry.id}-size">${[8, 9, 10, 11, 12, 13, 14].map(s => `<option value="${s}" ${s === 10 ? 'selected' : ''}>${s} pt${s === 10 ? ' (recommended)' : ''}</option>`).join('')}</select></label>
          <label class="field">Subjects per sheet<select id="${entry.id}-per"><option value="0">As many as fit</option>${[1, 2, 3, 4].map(n => `<option value="${n}">${n}</option>`).join('')}</select></label>
          <label class="field">S.No. and name<select id="${entry.id}-rep"><option value="1">On every sheet</option><option value="0">First sheet only</option></select></label>
        </div>
        <div class="plan" data-role="plan"></div>
        ${bad.length ? `<div class="note">Some characters (${esc(bad.slice(0, 8).join(' '))}) cannot be drawn by the PDF font and will print incorrectly. The Excel file is not affected.</div>` : ''}
        <div class="actions"><button class="btn ghost" data-role="print">Download print PDF</button></div>
      </div>
    </div>
    <details class="preview"><summary>Preview all ${r.grid.length} rows exactly as they will appear in Excel</summary><div class="tablewrap">${previewTable(r)}</div></details>`;

  $('[data-role=remove]', card).addEventListener('click', () => removeEntry(entry.id));
  const opts = () => ({
    orientation: $(`#${entry.id}-orient`, card).value,
    fontSize: +$(`#${entry.id}-size`, card).value,
    subjectsPerPage: +$(`#${entry.id}-per`, card).value,
    repeatFixed: $(`#${entry.id}-rep`, card).value === '1',
  });
  const updatePlan = () => {
    const doc = new jsPDF({ orientation: opts().orientation, unit: 'pt', format: 'a4' });
    const P = planPrint(doc, r, { margin: 8, maxHeaderMM: 32, ...opts() });
    const pages = P.parts.length * P.blocks.length;
    const perBlock = P.blocks.map(([a, b]) => b - a);
    $('[data-role=plan]', card).innerHTML = `
      <b>${P.parts.length}</b> sheet${P.parts.length > 1 ? 's' : ''} side by side × <b>${P.blocks.length}</b> row set${P.blocks.length > 1 ? 's' : ''} (up to ${Math.max(...perBlock)} students each) = <b>${pages}</b> page${pages > 1 ? 's' : ''}.
      Pages print in order: row set 1 parts 1–${P.parts.length}, then row set 2, and so on. Rows line up across parts.
      <div class="sheets">${P.parts.map((p, i) => `<span class="sheet">Part ${i + 1}<em>${esc([...new Set(p.map(ch => ch.label || 'Totals'))].join(', '))}</em></span>`).join('')}</div>`;
  };
  ['orient', 'size', 'per', 'rep'].forEach(k => $(`#${entry.id}-${k}`, card).addEventListener('change', updatePlan));
  updatePlan();

  const ov = $('[data-role=override]', card);
  const xBtn = $('[data-role=xlsx]', card), pBtn = $('[data-role=print]', card);
  const gate = () => { const on = r.ok || entry.override; xBtn.disabled = !on; pBtn.disabled = !on; };
  if (ov) ov.addEventListener('change', () => { entry.override = ov.checked; gate(); refreshBulk(); });
  gate();

  xBtn.addEventListener('click', () => downloadExcel([entry], `${safeFile(entry.sheetBase)}.xlsx`, card));
  pBtn.addEventListener('click', () => {
    try {
      const { doc, plan } = buildPrintPdf(jsPDF, r, { margin: 8, maxHeaderMM: 32, ...opts() });
      save(doc.output('blob'), `${safeFile(entry.sheetBase)} - print ${opts().orientation}.pdf`);
      toast(`Print PDF ready: ${plan.pages} pages`);
    } catch (e) { console.error(e); toast('Could not build the print PDF: ' + e.message); }
  });
}

const safeFile = s => s.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'green-sheet';

function previewTable(r) {
  const fc = r.flatCols;
  const nameW = 190;
  let h0 = '', h1 = '';
  for (let i = 0; i < fc.length;) {
    const c = fc[i].col;
    const stick = i === 0 ? ' class="sticky"' : i === 1 ? ` class="sticky2" style="left:42px;min-width:${nameW}px"` : '';
    if (c.group) {
      let j = i; while (j + 1 < fc.length && fc[j + 1].col.group && fc[j + 1].col.group.id === c.group.id) j++;
      h0 += `<th colspan="${j - i + 1}">${esc(c.group.label)}</th>`;
      for (let k = i; k <= j; k++) h1 += `<th>${esc(fc[k].name)}</th>`;
      i = j + 1;
    } else { h0 += `<th rowspan="2"${stick}>${esc(fc[i].name)}</th>`; i++; }
  }
  const body = r.grid.map(row => `<tr>${row.map((v, i) => i === 0 ? `<td class="sticky" style="min-width:42px">${esc(v)}</td>` : i === 1 ? `<td class="sticky2" style="left:42px;min-width:${nameW}px">${esc(v)}</td>` : `<td>${esc(v)}</td>`).join('')}</tr>`).join('');
  return `<table class="pv"><thead><tr>${h0}</tr><tr>${h1}</tr></thead><tbody>${body}</tbody></table>`;
}

// ---------------------------------------------------------------- excel
async function downloadExcel(list, name, card) {
  try {
    const numbers = numbersOn();
    const { buffer, verify } = await buildWorkbook(ExcelJS, list, { numbers });
    const cards = card ? [card] : list.map(e => document.getElementById(e.id)).filter(Boolean);
    for (const c of cards) {
      const e = list.find(x => x.id === c.id) || list[0];
      const n = e.result.grid.length * e.result.flatCols.length;
      const li = $('[data-role=xlcheck]', c);
      if (li) {
        li.className = verify.ok ? 'ok' : 'error';
        li.innerHTML = `<span class="ic">${verify.ok ? '✓' : '✕'}</span><span>${verify.ok ? `Excel file read back: all ${n.toLocaleString()} cells match the PDF text.` : 'Excel read-back found differences: ' + esc(verify.problems.slice(0, 3).join('; '))}</span>`;
        li.dataset.role = 'xlcheck';
      }
    }
    if (!verify.ok) { toast('Download stopped: the Excel file did not match the PDF'); return; }
    save(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name);
    toast('Excel downloaded and verified');
  } catch (e) { console.error(e); toast('Could not build the Excel file: ' + e.message); }
}

$('#allXlsx').addEventListener('click', () => {
  const usable = entries.filter(e => e.result.columns && (e.result.ok || e.override));
  if (!usable.length) return;
  const name = usable.length === 1 ? `${safeFile(usable[0].sheetBase)}.xlsx` : `Green sheets - ${usable.length} classes.xlsx`;
  downloadExcel(usable, name, null);
});
