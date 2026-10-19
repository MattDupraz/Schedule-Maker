# Schedule Maker

A small local web app for building a weekly schedule and sharing it as an Excel sheet or PNG image.

## Disclaimer

Written using an LLM, run at your own risk.

## Usage

Open `index.html` in a browser. No server, build step or internet connection is needed.

- Click an empty cell (or **+ Add event**) to add an event; click an event to edit or delete it.
- Click the title or a day heading to rename it. Days can be added and removed under **Settings**.
- **Groups** have a name and a color; events in a group take its color. Click a group chip above the schedule to show or hide it. Overlapping events are placed side by side.
- Drag the schedule's bottom-right corner to resize it; double-click the corner to reset the size.
- **Settings** also has the visible hours, grid interval and theme colors (including the alternate-hour shading).
- **Export PNG** / **Export PDF** / **Export Excel** download what's currently shown (hidden groups are left out). The PDF is one A4 landscape page with the schedule scaled to fit at its own proportions.
- **Export JSON** saves an editable copy. **Import** reads a JSON file or an Excel file exported by this app (the Excel export carries the full schedule in a hidden sheet). The current schedule is also remembered in the browser automatically.

## Libraries

Bundled in `lib/` so the app works offline:

- [ExcelJS](https://github.com/exceljs/exceljs) 4.4.0 for the `.xlsx` export and import
- [html-to-image](https://github.com/bubkoo/html-to-image) 1.11.11 for the PNG and PDF exports
- [jsPDF](https://github.com/parallax/jsPDF) 2.5.1 for the PDF export
