"use strict";

const STORAGE_KEY = "schedule-maker:v1";
const DATA_SHEET = "Schedule data"; // hidden sheet in Excel exports that holds the JSON for re-import
const UNIT = 15; // minutes per grid row; event times snap to this
const SLOT_HEIGHT_REM = 3.5; // height of one interval when the schedule isn't resized
const MIN_WIDTH = 360;
const MIN_HEIGHT = 240;
const PALETTE = ["#4f46e5", "#0891b2", "#059669", "#65a30d", "#ca8a04", "#ea580c", "#dc2626", "#db2777", "#7c3aed", "#64748b"];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const THEME_FIELDS = [
  ["background", "Background"],
  ["shade", "Alternate hour shading"],
  ["text", "Text"],
  ["headerBg", "Header background"],
  ["headerText", "Header text"],
  ["gridLine", "Grid lines"],
];

const $ = (sel) => document.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 10);
const isColor = (c) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);

let state = load();
let editingId = null;
let lastGroup = null; // group picked for the previous new event
let drag = null; // event currently being moved or resized with the mouse
let suppressClick = false; // swallows the click that ends a drag

// ---------- State ----------

function defaultTheme() {
  return {
    background: "#ffffff",
    shade: "#f1f3f6",
    text: "#374151",
    headerBg: "#3d3846",
    headerText: "#ffffff",
    gridLine: "#e5e7eb",
  };
}

function defaultState() {
  return {
    title: "Weekly Schedule",
    days: WEEKDAYS.slice(0, 5).map((name) => ({ id: uid(), name })),
    startHour: 8,
    endHour: 18,
    step: 60,
    showLegend: true,
    size: null, // {width, height} in px once the user drags the corner
    theme: defaultTheme(),
    groups: [],
    blocks: [],
  };
}

// Validates anything loaded from storage or a file, filling gaps with defaults.
function normalize(raw) {
  const d = defaultState();
  if (!raw || typeof raw !== "object") return d;

  const theme = d.theme;
  for (const [key] of THEME_FIELDS) if (isColor(raw.theme?.[key])) theme[key] = raw.theme[key];

  const days = Array.isArray(raw.days) && raw.days.length
    ? raw.days.map((day) => ({ id: String(day?.id ?? uid()), name: String(day?.name ?? "") }))
    : d.days;

  const groups = (Array.isArray(raw.groups) ? raw.groups : [])
    .filter((g) => g && typeof g === "object")
    .map((g) => ({
      id: String(g.id ?? uid()),
      name: String(g.name ?? ""),
      color: isColor(g.color) ? g.color : PALETTE[0],
      visible: g.visible !== false,
    }));

  const snap = (m) => Math.round(m / UNIT) * UNIT;
  const blocks = (Array.isArray(raw.blocks) ? raw.blocks : [])
    .filter((b) => b && Number.isFinite(b.start) && Number.isFinite(b.end))
    .map((b) => ({
      id: String(b.id ?? uid()),
      day: String(b.day),
      start: snap(b.start),
      end: snap(b.end),
      title: String(b.title ?? ""),
      subtitle: String(b.subtitle ?? ""),
      group: typeof b.group === "string" ? b.group : "",
      color: isColor(b.color) ? b.color : PALETTE[0],
    }))
    .filter((b) => b.end > b.start);

  const hour = (h, fallback, min, max) => (Number.isInteger(h) && h >= min && h <= max ? h : fallback);
  const startHour = hour(raw.startHour, d.startHour, 0, 23);
  let endHour = hour(raw.endHour, d.endHour, 1, 24);
  if (endHour <= startHour) endHour = startHour + 1;

  const size = Number.isFinite(raw.size?.width) && Number.isFinite(raw.size?.height)
    ? { width: Math.max(MIN_WIDTH, Math.round(raw.size.width)), height: Math.max(MIN_HEIGHT, Math.round(raw.size.height)) }
    : null;

  return {
    title: typeof raw.title === "string" ? raw.title : d.title,
    days,
    startHour,
    endHour,
    step: [15, 30, 60].includes(raw.step) ? raw.step : d.step,
    showLegend: raw.showLegend !== false,
    size,
    theme,
    groups,
    blocks,
  };
}

function load() {
  try {
    return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  } catch {
    return defaultState();
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable (private mode etc.): the app still works, it just won't remember.
  }
}

// ---------- Helpers ----------

const pad = (n) => String(n).padStart(2, "0");
const fmt = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const range = () => ({ s0: state.startHour * 60, s1: state.endHour * 60 });
const groupOf = (block) => state.groups.find((g) => g.id === block.group);
const blockColor = (block) => groupOf(block)?.color ?? block.color;
const isShown = (block) => groupOf(block)?.visible !== false;

// Picks black or white text, whichever contrasts more with the background.
function contrastText(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum < 0.179 ? "#ffffff" : "#111827";
}

// Lays out the shown events, clipped to the visible hours. Overlapping events on the
// same day go into separate lanes (sub-columns); an event widens into lanes to its
// right that are free for its whole duration.
function layout() {
  const { s0, s1 } = range();
  const perDay = state.days.map(() => []);
  for (const block of state.blocks) {
    const dayIndex = state.days.findIndex((d) => d.id === block.day);
    const start = Math.max(block.start, s0);
    const end = Math.min(block.end, s1);
    if (dayIndex >= 0 && end > start && isShown(block)) perDay[dayIndex].push({ block, start, end });
  }

  let col = 2; // column 1 holds the time labels
  let shown = 0;
  const days = perDay.map((items) => {
    items.sort((a, b) => a.start - b.start || b.end - a.end);
    const laneEnds = [];
    for (const item of items) {
      let lane = laneEnds.findIndex((end) => end <= item.start);
      if (lane < 0) lane = laneEnds.push(0) - 1;
      laneEnds[lane] = item.end;
      item.lane = lane;
    }
    const lanes = Math.max(1, laneEnds.length);
    const overlaps = (a, b) => a.start < b.end && b.start < a.end;
    for (const item of items) {
      let span = 1;
      while (item.lane + span < lanes && !items.some((o) => o.lane === item.lane + span && overlaps(o, item))) span++;
      item.span = span;
    }
    const day = { col, lanes, items };
    col += lanes;
    shown += items.length;
    return day;
  });
  return { days, lastCol: col - 1, shown };
}

function textEl(className, text) {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  return el;
}

function fileBase() {
  const slug = state.title.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return slug || "schedule";
}

function download(href, filename) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  download(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Rendering ----------

function render() {
  const sched = $("#schedule");
  const theme = state.theme;
  sched.style.setProperty("--bg", theme.background);
  sched.style.setProperty("--shade", theme.shade);
  sched.style.setProperty("--text", theme.text);
  sched.style.setProperty("--header-bg", theme.headerBg);
  sched.style.setProperty("--header-text", theme.headerText);
  sched.style.setProperty("--grid-line", theme.gridLine);
  sched.style.setProperty("--slot-height", `${SLOT_HEIGHT_REM}rem`);
  sched.classList.toggle("sized", Boolean(state.size));
  sched.style.width = state.size ? `${state.size.width}px` : "";
  sched.style.height = state.size ? `${state.size.height}px` : "";

  const titleEl = $("#schedule-title");
  if (document.activeElement !== titleEl) titleEl.textContent = state.title;

  const grid = $("#grid");
  grid.replaceChildren();
  const { s0, s1 } = range();
  const perStep = state.step / UNIT;
  const lay = layout();
  const minCol = (lanes) => (state.size ? "0px" : `${8 / lanes}rem`);
  grid.style.gridTemplateColumns = ["auto", ...lay.days.map((d) => `repeat(${d.lanes}, minmax(${minCol(d.lanes)}, ${1 / d.lanes}fr))`)].join(" ");
  grid.style.gridTemplateRows = state.size
    ? `auto repeat(${(s1 - s0) / UNIT}, minmax(0, 1fr))`
    : `auto repeat(${(s1 - s0) / UNIT}, calc(var(--slot-height) / ${perStep}))`;

  const add = (className, col, row, text) => {
    const el = textEl(className, text ?? "");
    el.style.gridColumn = col;
    el.style.gridRow = row;
    grid.append(el);
    return el;
  };

  add("corner", 1, 1);
  lay.days.forEach((d, i) => {
    const head = add("day-head", `${d.col} / span ${d.lanes}`, 1, state.days[i].name);
    head.contentEditable = "true";
    head.spellcheck = false;
    head.dataset.index = i;
    if (i === lay.days.length - 1) head.classList.add("last");
  });

  for (let t = s0; t < s1; t += state.step) {
    const row = `${(t - s0) / UNIT + 2} / span ${perStep}`;
    const shaded = Math.floor((t - s0) / 60) % 2 === 1;
    add("time", 1, row, fmt(t));
    lay.days.forEach((d, i) => {
      const cell = add(shaded ? "cell shaded" : "cell", `${d.col} / span ${d.lanes}`, row);
      if (t === s0) cell.classList.add("first");
      cell.dataset.day = state.days[i].id;
      cell.dataset.start = t;
    });
  }

  for (const d of lay.days) {
    for (const { block, start, end, lane, span } of d.items) {
      const el = add("block", `${d.col + lane} / span ${span}`, `${(start - s0) / UNIT + 2} / ${(end - s0) / UNIT + 2}`);
      const color = blockColor(block);
      el.dataset.id = block.id;
      el.style.background = color;
      el.style.color = contrastText(color);
      const body = textEl("block-body", "");
      body.append(textEl("block-title", block.title));
      if (block.subtitle) body.append(textEl("block-sub", block.subtitle));
      el.append(body);
      for (const edge of ["top", "bottom"]) {
        const handle = textEl(`block-resize ${edge}`, "");
        handle.dataset.edge = edge;
        el.append(handle);
      }
      if (drag?.moved && !drag.cancelled && drag.block === block) {
        el.classList.add("dragging");
        el.append(textEl("drag-time", `${fmt(block.start)}–${fmt(block.end)}`));
      }
    }
  }

  // "+" button that follows the hovered cell, so events can be added under existing ones.
  const plus = document.createElement("button");
  plus.className = "cell-add";
  plus.title = "Add event here";
  plus.textContent = "+";
  grid.append(plus);

  const legend = $("#legend");
  const legendGroups = state.groups.filter((g) => g.visible);
  legend.hidden = !state.showLegend || legendGroups.length === 0;
  legend.replaceChildren(...legendGroups.map((g) => {
    const item = textEl("legend-item", "");
    const swatch = textEl("legend-swatch", "");
    swatch.style.background = g.color;
    item.append(swatch, g.name);
    return item;
  }));

  renderGroupBar();

  const hidden = state.blocks.filter(isShown).length - lay.shown;
  $("#hidden-note").textContent = hidden
    ? `${hidden} event${hidden > 1 ? "s are" : " is"} outside the visible hours, so ${hidden > 1 ? "they" : "it"} won't be shown or exported.`
    : "";
}

function renderGroupBar() {
  const bar = $("#group-bar");
  const label = textEl("group-bar-label", state.groups.length ? "Groups:" : "No groups yet.");
  const chips = state.groups.map((g) => {
    const chip = document.createElement("button");
    chip.className = "group-chip";
    chip.style.setProperty("--c", g.color);
    chip.setAttribute("aria-pressed", String(g.visible));
    chip.title = g.visible ? "Click to hide this group" : "Click to show this group";
    chip.append(textEl("dot", ""), g.name || "(unnamed)");
    chip.addEventListener("click", () => {
      g.visible = !g.visible;
      save();
      render();
    });
    return chip;
  });
  const addBtn = document.createElement("button");
  addBtn.className = "group-add";
  addBtn.textContent = "+ Add group";
  addBtn.addEventListener("click", addGroup);
  bar.replaceChildren(label, ...chips, addBtn);
}

function renderSettings() {
  $("#start-hour").value = state.startHour;
  $("#end-hour").value = state.endHour;
  $("#step").value = state.step;
  $("#show-legend").checked = state.showLegend;

  const removeButton = (title, onClick) => {
    const b = document.createElement("button");
    b.textContent = "✕";
    b.title = title;
    b.addEventListener("click", onClick);
    return b;
  };

  $("#group-list").replaceChildren(...state.groups.map((group, i) => {
    const li = document.createElement("li");
    const color = document.createElement("input");
    color.type = "color";
    color.value = group.color;
    color.title = "Group color";
    color.addEventListener("input", () => {
      group.color = color.value;
      save();
      render();
    });
    const name = document.createElement("input");
    name.value = group.name;
    name.setAttribute("aria-label", `Group ${i + 1} name`);
    name.addEventListener("input", () => {
      group.name = name.value;
      save();
      render();
    });
    li.append(color, name, removeButton("Delete group", () => removeGroup(group)));
    return li;
  }));

  $("#day-list").replaceChildren(...state.days.map((day, i) => {
    const li = document.createElement("li");
    const input = document.createElement("input");
    input.value = day.name;
    input.setAttribute("aria-label", `Day ${i + 1} name`);
    input.addEventListener("input", () => {
      day.name = input.value;
      save();
      render();
    });
    li.append(input, removeButton("Remove day", () => removeDay(day)));
    return li;
  }));

  for (const input of document.querySelectorAll("#theme-fields input")) {
    input.value = state.theme[input.dataset.key];
  }
}

function update() {
  save();
  render();
  renderSettings();
}

function setSettingsOpen(open) {
  $("#settings").hidden = !open;
  $("#settings-btn").setAttribute("aria-pressed", String(open));
}

// ---------- Days and groups ----------

function addDay() {
  const used = new Set(state.days.map((d) => d.name));
  const name = WEEKDAYS.find((n) => !used.has(n)) ?? `Day ${state.days.length + 1}`;
  state.days.push({ id: uid(), name });
  update();
}

function removeDay(day) {
  if (state.days.length === 1) {
    alert("A schedule needs at least one day.");
    return;
  }
  const count = state.blocks.filter((b) => b.day === day.id).length;
  if (count && !confirm(`Remove "${day.name}" and its ${count} event${count > 1 ? "s" : ""}?`)) return;
  state.days = state.days.filter((d) => d !== day);
  state.blocks = state.blocks.filter((b) => b.day !== day.id);
  update();
}

function addGroup() {
  const n = state.groups.length;
  state.groups.push({ id: uid(), name: `Group ${n + 1}`, color: PALETTE[n % PALETTE.length], visible: true });
  update();
  setSettingsOpen(true);
  const input = document.querySelector("#group-list li:last-child input:not([type])");
  input.focus();
  input.select();
}

function removeGroup(group) {
  const members = state.blocks.filter((b) => b.group === group.id);
  if (members.length && !confirm(`Delete "${group.name}"? Its ${members.length} event${members.length > 1 ? "s" : ""} will stay, without a group.`)) return;
  for (const b of members) {
    b.group = "";
    b.color = group.color;
  }
  state.groups = state.groups.filter((g) => g !== group);
  update();
}

// ---------- Event dialog ----------

const dialog = $("#slot-dialog");
const form = $("#slot-form");
const fields = form.elements;

function fillTimes(select, from, to, value) {
  select.replaceChildren();
  for (let t = from; t <= to; t += UNIT) select.add(new Option(fmt(t), t));
  select.value = value;
}

function setColor(color) {
  fields.color.value = color;
  for (const s of document.querySelectorAll(".swatch")) {
    s.classList.toggle("selected", s.dataset.color.toLowerCase() === color.toLowerCase());
  }
}

function syncColorRow() {
  $("#color-row").hidden = fields.group.value !== "";
}

function openDialog(block, defaults = {}) {
  editingId = block?.id ?? null;
  const { s0, s1 } = range();
  const from = Math.min(s0, block?.start ?? s0);
  const to = Math.max(s1, block?.end ?? s1);
  const start = block?.start ?? defaults.start ?? s0;
  const end = block?.end ?? Math.min(start + state.step, to);

  fields.day.replaceChildren(...state.days.map((d) => new Option(d.name || "(unnamed)", d.id)));
  fields.day.value = block?.day ?? defaults.day ?? state.days[0].id;
  fillTimes(fields.start, from, to - UNIT, start);
  fillTimes(fields.end, from + UNIT, to, end);
  fields.title.value = block?.title ?? "";
  fields.subtitle.value = block?.subtitle ?? "";

  fields.group.replaceChildren(
    ...state.groups.map((g) => new Option(`${g.name || "(unnamed)"}${g.visible ? "" : " (hidden)"}`, g.id)),
    new Option("No group (custom color)", ""),
  );
  const fallbackGroup = state.groups.some((g) => g.id === lastGroup) ? lastGroup : (state.groups[0]?.id ?? "");
  fields.group.value = block ? (groupOf(block) ? block.group : "") : fallbackGroup;
  setColor(block?.color ?? PALETTE[state.blocks.length % PALETTE.length]);
  syncColorRow();

  $("#dialog-heading").textContent = block ? "Edit event" : "New event";
  $("#delete-slot").hidden = !block;
  $("#slot-error").textContent = "";
  dialog.showModal();
  fields.title.focus();
}

function submitSlot(event) {
  event.preventDefault();
  const data = {
    day: fields.day.value,
    start: Number(fields.start.value),
    end: Number(fields.end.value),
    title: fields.title.value.trim(),
    subtitle: fields.subtitle.value.trim(),
    group: fields.group.value,
    color: fields.color.value,
  };
  const error = $("#slot-error");
  if (!data.title) {
    error.textContent = "Give the event a title.";
    return;
  }
  if (data.end <= data.start) {
    error.textContent = "The end time must be after the start time.";
    return;
  }

  const existing = state.blocks.find((b) => b.id === editingId);
  if (existing) Object.assign(existing, data);
  else state.blocks.push({ id: uid(), ...data });
  if (!existing) lastGroup = data.group;
  // Make sure the event is visible after saving it.
  const group = state.groups.find((g) => g.id === data.group);
  if (group) group.visible = true;
  save();
  render();
  dialog.close();
}

function deleteSlot() {
  state.blocks = state.blocks.filter((b) => b.id !== editingId);
  save();
  render();
  dialog.close();
}

// ---------- Resizing ----------

// ---------- Dragging events ----------

const cellAt = (x, y) => document.elementsFromPoint(x, y).find((el) => el.classList.contains("cell"));

// Day and time (in minutes, unsnapped) under the pointer, or null outside the grid.
function slotAt(x, y) {
  const cell = cellAt(x, y);
  if (!cell) return null;
  const rect = cell.getBoundingClientRect();
  return { day: cell.dataset.day, minutes: Number(cell.dataset.start) + ((y - rect.top) / rect.height) * state.step };
}

function setupDrag() {
  const grid = $("#grid");
  const snap = (m) => Math.round(m / UNIT) * UNIT;

  grid.addEventListener("pointerdown", (e) => {
    const el = e.target.closest(".block");
    if (!el || e.button !== 0) return;
    e.preventDefault();
    const block = state.blocks.find((b) => b.id === el.dataset.id);
    const slot = slotAt(e.clientX, e.clientY);
    drag = {
      block,
      original: { ...block },
      mode: e.target.closest(".block-resize")?.dataset.edge ?? "move",
      grabOffset: slot ? slot.minutes - block.start : 0,
      x: e.clientX,
      y: e.clientY,
      moved: false,
    };
  });

  window.addEventListener("pointermove", (e) => {
    if (!drag || drag.cancelled) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
    drag.moved = true;
    const slot = slotAt(e.clientX, e.clientY);
    if (!slot) return;
    const { s0, s1 } = range();
    const b = drag.block;
    if (drag.mode === "move") {
      const length = b.end - b.start;
      b.start = Math.min(Math.max(snap(slot.minutes - drag.grabOffset), s0), Math.max(s0, s1 - length));
      b.end = b.start + length;
      b.day = slot.day;
    } else if (drag.mode === "top") {
      b.start = Math.min(Math.max(snap(slot.minutes), s0), b.end - UNIT);
    } else {
      b.end = Math.max(Math.min(snap(slot.minutes), s1), b.start + UNIT);
    }
    render();
  });

  const finish = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (!moved) return; // a plain click: let the click handler open the dialog
    suppressClick = true;
    setTimeout(() => (suppressClick = false));
    save();
    render();
  };
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !drag?.moved || drag.cancelled) return;
    Object.assign(drag.block, drag.original);
    drag.cancelled = true; // keep the drag until the button is released so that release isn't a click
    render();
  });
}

function setupResize() {
  const handle = $("#resize-handle");
  const sched = $("#schedule");
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const rect = sched.getBoundingClientRect();
    const onMove = (ev) => {
      state.size = {
        width: Math.max(MIN_WIDTH, Math.round(rect.width + ev.clientX - e.clientX)),
        height: Math.max(MIN_HEIGHT, Math.round(rect.height + ev.clientY - e.clientY)),
      };
      render();
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      save();
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  });
  handle.addEventListener("dblclick", () => {
    state.size = null;
    update();
  });
}

// ---------- Export / import ----------

async function exportPng() {
  if (!window.htmlToImage) {
    alert("The image library didn't load. Make sure the lib/ folder is next to index.html.");
    return;
  }
  document.activeElement?.blur();
  const sched = $("#schedule");
  sched.classList.add("exporting");
  try {
    const url = await htmlToImage.toPng(sched, {
      pixelRatio: 2,
      backgroundColor: state.theme.background,
      skipFonts: true,
      filter: (node) => !node.classList?.contains("resize-handle") && !node.classList?.contains("cell-add"),
    });
    download(url, `${fileBase()}.png`);
  } catch (err) {
    alert(`PNG export failed: ${err?.message ?? err}`);
  } finally {
    sched.classList.remove("exporting");
  }
}

async function exportExcel() {
  if (!window.ExcelJS) {
    alert("The Excel library didn't load. Make sure the lib/ folder is next to index.html.");
    return;
  }
  const theme = state.theme;
  const argb = (hex) => `FF${hex.slice(1).toUpperCase()}`;
  const fill = (hex) => ({ type: "pattern", pattern: "solid", fgColor: { argb: argb(hex) } });
  const line = { style: "thin", color: { argb: argb(theme.gridLine) } };
  const box = { top: line, left: line, bottom: line, right: line };
  // Excel column widths are in characters (~7px), row heights in points (0.75pt per px).
  const measure = (sel, prop, fallback) => document.querySelector(sel)?.getBoundingClientRect()[prop] || fallback;
  const toWidth = (px) => Math.max(2, (px - 5) / 7);
  const toHeight = (px) => Math.max(10, px * 0.75);

  const { s0, s1 } = range();
  const lay = layout();
  const items = lay.days.flatMap((d) => d.items.map((item) => ({ ...item, col: d.col })));
  // Use one row per interval when every event lines up with it, otherwise fall back to 15-minute rows.
  const aligned = items.every(({ start, end }) => (start - s0) % state.step === 0 && (end - s0) % state.step === 0);
  const unit = aligned ? state.step : UNIT;
  const stepPx = measure(".cell", "height", 56);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Schedule", {
    views: [{ showGridLines: false }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.columns = [
    { width: toWidth(measure(".time", "width", 72)) },
    ...lay.days.flatMap((d, i) => {
      const dayPx = measure(`.day-head[data-index="${i}"]`, "width", 160);
      return Array.from({ length: d.lanes }, () => ({ width: toWidth(dayPx / d.lanes) }));
    }),
  ];

  ws.mergeCells(1, 1, 1, lay.lastCol);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = state.title;
  titleCell.font = { bold: true, size: 18, color: { argb: argb(theme.text) } };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  titleCell.fill = fill(theme.background);
  ws.getRow(1).height = 34;

  const header = ws.getRow(2);
  header.height = toHeight(measure(".day-head", "height", 40));
  for (let c = 1; c <= lay.lastCol; c++) header.getCell(c).fill = fill(theme.headerBg);
  lay.days.forEach((d, i) => {
    if (d.lanes > 1) ws.mergeCells(2, d.col, 2, d.col + d.lanes - 1);
    const cell = header.getCell(d.col);
    cell.value = state.days[i].name;
    cell.font = { bold: true, size: 14, color: { argb: argb(theme.headerText) } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });

  let r = 3;
  for (let t = s0; t < s1; t += unit, r++) {
    const row = ws.getRow(r);
    row.height = toHeight((stepPx * unit) / state.step);
    const bg = fill(Math.floor((t - s0) / 60) % 2 === 1 ? theme.shade : theme.background);
    const timeCell = row.getCell(1);
    const intervalStart = (t - s0) % state.step === 0;
    // With 15-minute rows, merge each time label over its whole interval so it centers vertically.
    if (intervalStart && unit < state.step) ws.mergeCells(r, 1, r + state.step / unit - 1, 1);
    if (intervalStart) timeCell.value = fmt(t);
    timeCell.font = { bold: true, size: 14, color: { argb: argb(theme.text) } };
    timeCell.alignment = { horizontal: "right", vertical: "middle", indent: 1 };
    timeCell.fill = fill(theme.background);
    for (const d of lay.days) {
      for (let lane = 0; lane < d.lanes; lane++) {
        const cell = row.getCell(d.col + lane);
        cell.fill = bg;
        const border = {};
        if (lane === 0) border.left = line;
        if (lane === d.lanes - 1) border.right = line;
        if ((t - s0) % state.step === 0) border.top = line;
        if (t + unit >= s1) border.bottom = line;
        cell.border = border;
      }
    }
  }

  for (const { block, start, end, lane, span, col } of items) {
    const left = col + lane;
    const top = 3 + (start - s0) / unit;
    const bottom = 2 + (end - s0) / unit;
    if (bottom > top || span > 1) ws.mergeCells(top, left, bottom, left + span - 1);
    const color = blockColor(block);
    const font = { color: { argb: argb(contrastText(color)) } };
    const parts = [{ text: block.title, font: { ...font, bold: true, size: 14 } }];
    if (block.subtitle) parts.push({ text: `\n${block.subtitle}`, font: { ...font, size: 12 } });
    const cell = ws.getCell(top, left);
    cell.value = { richText: parts };
    cell.fill = fill(color);
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = box;
  }

  const legendGroups = state.groups.filter((g) => g.visible);
  if (state.showLegend && legendGroups.length) {
    const row = ws.getRow(r + 1);
    row.height = 22;
    legendGroups.forEach((g, i) => {
      const cell = row.getCell(i + 2);
      cell.value = g.name;
      cell.font = { bold: true, color: { argb: argb(contrastText(g.color)) } };
      cell.fill = fill(g.color);
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });
  }

  // The full schedule as JSON, split to stay under Excel's 32767-character cell limit.
  const data = wb.addWorksheet(DATA_SHEET, { state: "veryHidden" });
  const json = JSON.stringify(state);
  for (let i = 0; i * 30000 < json.length; i++) data.getCell(i + 1, 1).value = json.slice(i * 30000, (i + 1) * 30000);

  try {
    const buffer = await wb.xlsx.writeBuffer();
    downloadBlob(
      new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
      `${fileBase()}.xlsx`,
    );
  } catch (err) {
    alert(`Excel export failed: ${err?.message ?? err}`);
  }
}

function exportJson() {
  downloadBlob(new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }), `${fileBase()}.json`);
}

async function readImport(file) {
  if (!file.name.toLowerCase().endsWith(".xlsx")) return JSON.parse(await file.text());
  if (!window.ExcelJS) throw new Error("The Excel library didn't load. Make sure the lib/ folder is next to index.html.");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const sheet = wb.getWorksheet(DATA_SHEET);
  if (!sheet) throw new Error("This Excel file wasn't exported by Schedule Maker, so there's no schedule data in it to import.");
  const chunks = [];
  sheet.eachRow((row) => chunks.push(String(row.getCell(1).value ?? "")));
  return JSON.parse(chunks.join(""));
}

async function importFile(event) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  if (state.blocks.length && !confirm("Importing replaces the current schedule. Continue?")) return;
  try {
    state = normalize(await readImport(file));
    update();
  } catch (err) {
    alert(err instanceof SyntaxError ? "That file couldn't be read as a schedule." : `Import failed: ${err?.message ?? err}`);
  }
}

// ---------- Inline editing (title and day headings) ----------

function finishOnEnter(event) {
  if (event.key === "Enter") {
    event.preventDefault();
    event.target.blur();
  }
}

function setupInlineEditing() {
  const titleEl = $("#schedule-title");
  titleEl.addEventListener("input", () => {
    state.title = titleEl.textContent;
    save();
  });
  titleEl.addEventListener("keydown", finishOnEnter);
  titleEl.addEventListener("blur", () => {
    state.title = titleEl.textContent.trim();
    save();
    render();
  });

  const grid = $("#grid");
  grid.addEventListener("input", (e) => {
    const head = e.target.closest(".day-head");
    if (!head) return;
    state.days[head.dataset.index].name = head.textContent;
    save();
  });
  grid.addEventListener("keydown", (e) => {
    if (e.target.closest(".day-head")) finishOnEnter(e);
  });
  grid.addEventListener("focusout", (e) => {
    const head = e.target.closest(".day-head");
    if (!head) return;
    state.days[head.dataset.index].name = head.textContent.trim();
    update();
  });
  grid.addEventListener("mousemove", (e) => {
    const plus = grid.querySelector(".cell-add");
    const cell = !drag && cellAt(e.clientX, e.clientY);
    plus.classList.toggle("visible", Boolean(cell));
    if (!cell) return;
    plus.style.gridColumn = cell.style.gridColumn;
    plus.style.gridRow = cell.style.gridRow;
    plus.dataset.day = cell.dataset.day;
    plus.dataset.start = cell.dataset.start;
  });
  grid.addEventListener("mouseleave", () => grid.querySelector(".cell-add").classList.remove("visible"));
  grid.addEventListener("click", (e) => {
    if (suppressClick) return;
    const plus = e.target.closest(".cell-add");
    if (plus) {
      openDialog(null, { day: plus.dataset.day, start: Number(plus.dataset.start) });
      return;
    }
    const block = e.target.closest(".block");
    if (block) {
      openDialog(state.blocks.find((b) => b.id === block.dataset.id));
      return;
    }
    const cell = e.target.closest(".cell");
    if (cell) openDialog(null, { day: cell.dataset.day, start: Number(cell.dataset.start) });
  });
}

// ---------- Setup ----------

function init() {
  for (let h = 0; h < 24; h++) $("#start-hour").add(new Option(fmt(h * 60), h));
  for (let h = 1; h <= 24; h++) $("#end-hour").add(new Option(fmt(h * 60), h));

  $("#theme-fields").replaceChildren(...THEME_FIELDS.map(([key, label]) => {
    const wrap = document.createElement("label");
    const input = document.createElement("input");
    input.type = "color";
    input.dataset.key = key;
    input.addEventListener("input", () => {
      state.theme[key] = input.value;
      save();
      render();
    });
    wrap.append(label, input);
    return wrap;
  }));

  $("#swatches").replaceChildren(...PALETTE.map((color) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.dataset.color = color;
    b.style.background = color;
    b.title = color;
    b.addEventListener("click", () => setColor(color));
    return b;
  }));

  $("#start-hour").addEventListener("change", (e) => {
    state.startHour = Number(e.target.value);
    if (state.endHour <= state.startHour) state.endHour = state.startHour + 1;
    update();
  });
  $("#end-hour").addEventListener("change", (e) => {
    state.endHour = Number(e.target.value);
    if (state.startHour >= state.endHour) state.startHour = state.endHour - 1;
    update();
  });
  $("#step").addEventListener("change", (e) => {
    state.step = Number(e.target.value);
    update();
  });
  $("#show-legend").addEventListener("change", (e) => {
    state.showLegend = e.target.checked;
    update();
  });
  $("#add-day").addEventListener("click", addDay);
  $("#add-group").addEventListener("click", addGroup);
  $("#reset-theme").addEventListener("click", () => {
    state.theme = defaultTheme();
    update();
  });
  $("#reset-btn").addEventListener("click", () => {
    if (confirm("Clear the whole schedule and start over? This can't be undone.")) {
      state = defaultState();
      update();
    }
  });

  $("#settings-btn").addEventListener("click", () => setSettingsOpen($("#settings").hidden));
  $("#add-btn").addEventListener("click", () => openDialog(null));
  $("#png-btn").addEventListener("click", exportPng);
  $("#xlsx-btn").addEventListener("click", exportExcel);
  $("#json-btn").addEventListener("click", exportJson);
  $("#import-input").addEventListener("change", importFile);

  form.addEventListener("submit", submitSlot);
  fields.color.addEventListener("input", () => setColor(fields.color.value));
  fields.group.addEventListener("change", syncColorRow);
  fields.start.addEventListener("change", () => {
    const start = Number(fields.start.value);
    if (Number(fields.end.value) <= start) {
      const max = Number(fields.end.options[fields.end.options.length - 1].value);
      fields.end.value = Math.min(start + state.step, max);
    }
  });
  $("#cancel-slot").addEventListener("click", () => dialog.close());
  $("#delete-slot").addEventListener("click", deleteSlot);

  setupInlineEditing();
  setupResize();
  setupDrag();
  render();
  renderSettings();
}

init();
