# Green Sheet Converter

Static web page that converts ERP "Consolidated Green Sheet" PDFs to Excel and to a
large-print PDF split across A4 sheets. Everything runs in the browser; PDFs are never uploaded.

## Deploy on Vercel
1. Put this folder in a Git repo (or run `npx vercel` inside it).
2. In Vercel: New Project → import the repo → Framework preset **Other** → no build command, output directory `.` → Deploy.

Any static host works (Netlify, GitHub Pages, an IIS/nginx folder). It must be served over http(s);
opening index.html straight from disk will not load the scripts.

## Files
- `index.html` – page and styles
- `js/extractor.js` – rebuilds the table grid from the PDF's ruled lines and places every character in its cell
- `js/workbook.js` – Excel export + read-back verification
- `js/printpdf.js` – large-print PDF (subjects split across sheets, rows aligned for pasting side by side)
- `vendor/` – pdf.js 4.10.38, ExcelJS 4.4.0, jsPDF 2.5.2 (bundled, no CDN needed)

## Accuracy safeguards
- Values are placed by position inside ruled cells, one character at a time; text is never re-typed or rounded.
- Conversion stops if any character crosses a cell border, can't be placed, or pages have different columns.
- Character count check: every character inside the table must appear in the output.
- Serial-number continuity check across pages.
- The Excel file is read back and compared cell by cell before download.
