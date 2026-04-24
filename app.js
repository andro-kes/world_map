'use strict';
/* =============================================================
   WORLD MAP EDITOR — app.js
   =============================================================
   Features:
     • Draw continents, countries, seas (polygons)
     • Draw rivers (polylines)
     • Place mountain symbols
     • Place text labels
     • Select, move, and reshape any item (drag control points)
     • Color / stroke / opacity / font properties panel
     • Items list with visibility toggle
     • Z-order control (move up/down)
     • Undo / Redo (Ctrl+Z / Ctrl+Y)
     • Auto-save to localStorage every ~1 s after change
     • Export / Import JSON backup
     • Zoom (scroll wheel, + / −) and Pan (Space+drag / MMB)
============================================================= */

/* ─────────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────────── */
const STORAGE_KEY = 'world_map_v1';
const MIN_ZOOM    = 0.05;
const MAX_ZOOM    = 12;
const CP_R        = 6;    // control-point screen-pixel radius
const MAX_HIST    = 60;   // max undo steps

const TYPE = Object.freeze({
  CONTINENT: 'continent',
  COUNTRY:   'country',
  SEA:       'sea',
  RIVER:     'river',
  MOUNTAIN:  'mountain',
  LABEL:     'label',
});

const TYPE_LABEL = {
  continent: 'Континент',
  country:   'Страна',
  sea:       'Море / Озеро',
  river:     'Река',
  mountain:  'Горы',
  label:     'Надпись',
};

const TOOL_LABEL = { select: 'Выбор', ...TYPE_LABEL };

const TYPE_ICON = {
  continent: '🗺️',
  country:   '🏳️',
  sea:       '🌊',
  river:     '〰️',
  mountain:  '⛰️',
  label:     'T',
};

// drawing tools that create shapes by clicking
const DRAW_TOOLS = new Set(['continent', 'country', 'sea', 'river']);

/* ─────────────────────────────────────────────
   STATE
───────────────────────────────────────────── */
const S = {
  items:      [],       // ordered array of all map items
  selectedId: null,
  tool:       'select',
  zoom:       1,
  panX:       0,
  panY:       0,

  // drawing
  drawing:    false,
  drawPts:    [],       // committed points
  previewPt:  null,     // live mouse position

  // dragging a whole item
  dragging:     false,
  dragId:       null,
  dragStartPts: null,   // snapshot of points before drag
  dragStartPos: null,   // world pos at drag start
  dragOffX:     0,      // for mountains/labels (x offset)
  dragOffY:     0,

  // dragging a control point
  editCp:    false,
  editCpIdx: -1,

  // panning
  panning:      false,
  panStartSvg:  null,
  panStartOff:  null,

  // pending label placement
  pendingLabelPos: null,
};

/* ─────────────────────────────────────────────
   UTILITIES
───────────────────────────────────────────── */
let _uid = Date.now();
function uid()        { return 'i' + (_uid++).toString(36); }
function deepClone(x) { return JSON.parse(JSON.stringify(x)); }

const COUNTRY_PALETTE = [
  '#e8c88b','#8ecf8e','#8ecfcf','#cf8e8e','#cfb68e',
  '#b8d4a8','#d4a8b8','#a8b8d4','#d4d4a8','#a8d4d4',
  '#e8d4b0','#b0d4e8','#d4b0e8','#b0e8d4','#e8b0d4',
  '#c8e8a0','#a0c8e8','#e8a0c8','#c8a0e8','#a0e8c8',
  '#f0d080','#80d0f0','#f080d0','#80f0d0','#d080f0',
];
function randCountryColor() {
  return COUNTRY_PALETTE[Math.floor(Math.random() * COUNTRY_PALETTE.length)];
}

/* ─────────────────────────────────────────────
   SVG HELPERS
───────────────────────────────────────────── */
const NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/* ─────────────────────────────────────────────
   COORDINATE HELPERS
───────────────────────────────────────────── */
function svgBCR()           { return document.getElementById('map-svg').getBoundingClientRect(); }
function svgPosFromEvent(e) { const r = svgBCR(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function svgToWorld(sx, sy) { return { x: (sx - S.panX) / S.zoom, y: (sy - S.panY) / S.zoom }; }
function worldToSvg(wx, wy) { return { x: wx * S.zoom + S.panX,  y: wy * S.zoom + S.panY  }; }
function worldFromEvent(e)  { const p = svgPosFromEvent(e); return svgToWorld(p.x, p.y); }

/* ─────────────────────────────────────────────
   STORAGE
───────────────────────────────────────────── */
let _saveTimer = null;
function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveNow, 900);
}

function saveNow() {
  const data = {
    version: 2,
    items: S.items,
    zoom:  S.zoom,
    panX:  S.panX,
    panY:  S.panY,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    showSaved('Сохранено ✓');
  } catch (e) {
    console.error('Save failed:', e);
  }
}

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.items)) return false;
    S.items = d.items;
    if (typeof d.zoom === 'number') S.zoom = d.zoom;
    if (typeof d.panX === 'number') S.panX = d.panX;
    if (typeof d.panY === 'number') S.panY = d.panY;
    return true;
  } catch (e) {
    console.error('Load failed:', e);
    return false;
  }
}

function doExportJSON() {
  const blob = new Blob([JSON.stringify({ version: 2, exportDate: new Date().toISOString(), items: S.items }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `world_map_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function doImportJSON(file) {
  const fr = new FileReader();
  fr.onload = e => {
    try {
      const d = JSON.parse(e.target.result);
      if (!d || !Array.isArray(d.items)) throw new Error('Неверный формат');
      histPush();
      S.items = d.items;
      S.selectedId = null;
      renderAll();
      updateItemsList();
      updateProps();
      saveNow();
      showSaved('Импорт выполнен ✓');
    } catch (err) {
      alert('Ошибка при импорте: ' + err.message);
    }
  };
  fr.readAsText(file);
}

/* ─────────────────────────────────────────────
   HISTORY (UNDO / REDO)
───────────────────────────────────────────── */
const hist = { stack: [], idx: -1 };

function histPush() {
  hist.stack = hist.stack.slice(0, hist.idx + 1);
  hist.stack.push(deepClone(S.items));
  if (hist.stack.length > MAX_HIST) hist.stack.shift();
  else hist.idx++;
  scheduleSave();
}

function undo() {
  if (hist.idx <= 0) return;
  hist.idx--;
  S.items = deepClone(hist.stack[hist.idx]);
  S.selectedId = null;
  renderAll(); updateItemsList(); updateProps();
}

function redo() {
  if (hist.idx >= hist.stack.length - 1) return;
  hist.idx++;
  S.items = deepClone(hist.stack[hist.idx]);
  S.selectedId = null;
  renderAll(); updateItemsList(); updateProps();
}

/* ─────────────────────────────────────────────
   ITEM FACTORIES
───────────────────────────────────────────── */
function mkContinent(pts) {
  return { id: uid(), type: TYPE.CONTINENT, name: 'Континент', points: pts,
           fillColor: '#c9b98a', strokeColor: '#7a6540', strokeWidth: 2, visible: true };
}
function mkCountry(pts) {
  return { id: uid(), type: TYPE.COUNTRY, name: 'Страна', points: pts,
           fillColor: randCountryColor(), strokeColor: '#444', strokeWidth: 1, visible: true };
}
function mkSea(pts) {
  return { id: uid(), type: TYPE.SEA, name: 'Море', points: pts,
           fillColor: '#4a9fd4', strokeColor: '#1a6fa0', strokeWidth: 1, fillOpacity: 0.65, visible: true };
}
function mkRiver(pts) {
  return { id: uid(), type: TYPE.RIVER, name: 'Река', points: pts,
           strokeColor: '#2a80c8', strokeWidth: 2, visible: true };
}
function mkMountain(x, y) {
  return { id: uid(), type: TYPE.MOUNTAIN, name: 'Горы', x, y,
           size: 24, fillColor: '#9a8060', strokeColor: '#5a4020', visible: true };
}
function mkLabel(x, y, text) {
  return { id: uid(), type: TYPE.LABEL, name: text, text, x, y,
           fontSize: 14, fontStyle: 'normal', fontWeight: 'normal',
           fillColor: '#ffffff', textShadow: true, visible: true };
}

function addItem(item) {
  S.items.push(item);
  histPush();
  renderAll();
  updateItemsList();
}

function updateItem(id, props) {
  const it = getItem(id);
  if (!it) return;
  Object.assign(it, props);
  scheduleSave();
  renderAll();
  updateItemsList();
  if (S.selectedId === id) updateProps();
}

function removeItem(id) {
  const idx = S.items.findIndex(i => i.id === id);
  if (idx === -1) return;
  S.items.splice(idx, 1);
  if (S.selectedId === id) { S.selectedId = null; updateProps(); }
  histPush();
  renderAll();
  updateItemsList();
}

function getItem(id) { return S.items.find(i => i.id === id) || null; }

function moveItemUp(id) {
  const idx = S.items.findIndex(i => i.id === id);
  if (idx < S.items.length - 1) {
    [S.items[idx], S.items[idx + 1]] = [S.items[idx + 1], S.items[idx]];
    histPush(); renderAll(); updateItemsList();
  }
}
function moveItemDown(id) {
  const idx = S.items.findIndex(i => i.id === id);
  if (idx > 0) {
    [S.items[idx], S.items[idx - 1]] = [S.items[idx - 1], S.items[idx]];
    histPush(); renderAll(); updateItemsList();
  }
}

/* ─────────────────────────────────────────────
   RENDERING
───────────────────────────────────────────── */
const LAYER_ID = {
  [TYPE.CONTINENT]: 'layer-continents',
  [TYPE.COUNTRY]:   'layer-countries',
  [TYPE.SEA]:       'layer-seas',
  [TYPE.RIVER]:     'layer-rivers',
  [TYPE.MOUNTAIN]:  'layer-mountains',
  [TYPE.LABEL]:     'layer-labels',
};

function renderAll() {
  // clear layers
  ['layer-continents','layer-seas','layer-countries','layer-rivers',
   'layer-mountains','layer-labels','layer-overlay'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });

  // update world transform
  document.getElementById('world').setAttribute('transform',
    `translate(${S.panX},${S.panY}) scale(${S.zoom})`);

  // render items
  S.items.forEach(it => {
    if (!it.visible) return;
    const layer = document.getElementById(LAYER_ID[it.type]);
    if (!layer) return;
    const el = renderItem(it);
    if (el) layer.appendChild(el);
  });

  renderOverlay();
  renderDrawingPreview();
}

function renderItem(it) {
  let el;
  const sel = it.id === S.selectedId;
  const sw  = (it.strokeWidth || 1) / S.zoom;   // constant screen width

  switch (it.type) {
    case TYPE.CONTINENT:
    case TYPE.COUNTRY: {
      if (!it.points || it.points.length < 2) return null;
      el = svgEl('polygon', {
        points:        it.points.map(p => `${p[0]},${p[1]}`).join(' '),
        fill:          it.fillColor  || '#ccc',
        stroke:        sel ? '#ffdd00' : (it.strokeColor || '#333'),
        'stroke-width': sel ? 2.5 / S.zoom : sw,
      });
      break;
    }
    case TYPE.SEA: {
      if (!it.points || it.points.length < 2) return null;
      el = svgEl('polygon', {
        points:        it.points.map(p => `${p[0]},${p[1]}`).join(' '),
        fill:          it.fillColor  || '#4a9fd4',
        'fill-opacity': it.fillOpacity !== undefined ? it.fillOpacity : 0.65,
        stroke:        sel ? '#ffdd00' : (it.strokeColor || '#1a6fa0'),
        'stroke-width': sel ? 2.5 / S.zoom : sw,
      });
      break;
    }
    case TYPE.RIVER: {
      if (!it.points || it.points.length < 2) return null;
      el = svgEl('polyline', {
        points:          it.points.map(p => `${p[0]},${p[1]}`).join(' '),
        fill:            'none',
        stroke:          sel ? '#ffdd00' : (it.strokeColor || '#2a80c8'),
        'stroke-width':  sel ? 3 / S.zoom : sw,
        'stroke-linecap':  'round',
        'stroke-linejoin': 'round',
      });
      break;
    }
    case TYPE.MOUNTAIN: {
      el = renderMountain(it, sel);
      break;
    }
    case TYPE.LABEL: {
      el = renderLabel(it, sel);
      break;
    }
    default: return null;
  }

  if (el) {
    el.setAttribute('data-id', it.id);
    el.classList.add('map-item');
  }
  return el;
}

function renderMountain(it, sel) {
  const s   = (it.size || 24) / 24;
  const g   = svgEl('g', { transform: `translate(${it.x},${it.y})` });

  // main peak
  const peak = svgEl('polygon', {
    points: `${-10*s},${9*s} ${0},${-12*s} ${10*s},${9*s}`,
    fill:   it.fillColor   || '#9a8060',
    stroke: it.strokeColor || '#5a4020',
    'stroke-width': 1 / S.zoom,
    'stroke-linejoin': 'round',
  });
  // snow cap
  const snow = svgEl('polygon', {
    points: `${-3.5*s},${-2*s} ${0},${-12*s} ${3.5*s},${-2*s}`,
    fill:   '#e8f0ff',
    stroke: 'none',
  });
  // second smaller peak (offset to right)
  const peak2 = svgEl('polygon', {
    points: `${4*s},${9*s} ${12*s},${-4*s} ${20*s},${9*s}`,
    fill:   it.fillColor   || '#9a8060',
    stroke: it.strokeColor || '#5a4020',
    'stroke-width': 1 / S.zoom,
    'stroke-linejoin': 'round',
  });

  g.appendChild(peak2);
  g.appendChild(peak);
  g.appendChild(snow);

  if (sel) {
    const box = svgEl('rect', {
      x: `${-14*s}`, y: `${-15*s}`,
      width: `${36*s}`, height: `${27*s}`,
      fill: 'none',
      stroke: '#ffdd00',
      'stroke-width': 1.5 / S.zoom,
      'stroke-dasharray': `${4/S.zoom},${2/S.zoom}`,
    });
    g.appendChild(box);
  }
  return g;
}

function renderLabel(it, sel) {
  const g   = svgEl('g');
  const fs  = (it.fontSize || 14) / S.zoom;

  if (it.textShadow) {
    const shadow = svgEl('text', {
      x: it.x, y: it.y,
      'font-size':   fs,
      'font-family': 'Georgia, "Times New Roman", serif',
      'font-style':  it.fontStyle  || 'normal',
      'font-weight': it.fontWeight || 'normal',
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
      fill: 'none',
      stroke: 'rgba(0,0,0,0.7)',
      'stroke-width': 3 / S.zoom,
      'paint-order': 'stroke',
    });
    shadow.textContent = it.text || it.name;
    g.appendChild(shadow);
  }

  const txt = svgEl('text', {
    x: it.x, y: it.y,
    'font-size':   fs,
    'font-family': 'Georgia, "Times New Roman", serif',
    'font-style':  it.fontStyle  || 'normal',
    'font-weight': it.fontWeight || 'normal',
    'text-anchor': 'middle',
    'dominant-baseline': 'middle',
    fill: sel ? '#ffdd00' : (it.fillColor || '#ffffff'),
  });
  txt.textContent = it.text || it.name;
  g.appendChild(txt);
  return g;
}

/* overlay: control points for selected item */
function renderOverlay() {
  const layer = document.getElementById('layer-overlay');
  if (!layer || !S.selectedId) return;
  const it = getItem(S.selectedId);
  if (!it || !it.points) return;

  const r    = CP_R   / S.zoom;
  const rmid = r * 0.6;

  // vertex points
  it.points.forEach((pt, i) => {
    const c = svgEl('circle', {
      cx: pt[0], cy: pt[1], r,
      fill:   '#ffffff',
      stroke: '#89b4fa',
      'stroke-width': 1.5 / S.zoom,
    });
    c.classList.add('cp-vertex');
    c.setAttribute('data-cp-idx', i);
    c.setAttribute('data-cp-type', 'vertex');
    layer.appendChild(c);
  });

  // midpoints (to add new vertices)
  const len  = it.points.length;
  const endI = it.type === TYPE.RIVER ? len - 1 : len;
  for (let i = 0; i < endI; i++) {
    const p1 = it.points[i];
    const p2 = it.points[(i + 1) % len];
    const mx = (p1[0] + p2[0]) / 2;
    const my = (p1[1] + p2[1]) / 2;
    const c  = svgEl('circle', {
      cx: mx, cy: my, r: rmid,
      fill:   '#89b4fa',
      stroke: '#ffffff',
      'stroke-width': 1 / S.zoom,
    });
    c.classList.add('cp-mid');
    c.setAttribute('data-cp-after', i);
    c.setAttribute('data-cp-type', 'mid');
    layer.appendChild(c);
  }
}

/* preview polygon/polyline while drawing */
function renderDrawingPreview() {
  const layer = document.getElementById('layer-overlay');
  if (!layer || !S.drawing || S.drawPts.length === 0) return;

  const pts = S.previewPt ? [...S.drawPts, S.previewPt] : [...S.drawPts];

  if (pts.length >= 2) {
    const line = svgEl('polyline', {
      points: pts.map(p => `${p[0]},${p[1]}`).join(' '),
      fill:   'none',
      stroke: '#89b4fa',
      'stroke-width': 1.5 / S.zoom,
      'stroke-dasharray': `${6/S.zoom},${3/S.zoom}`,
      opacity: 0.85,
    });
    layer.appendChild(line);
  }

  const r = CP_R / S.zoom;
  S.drawPts.forEach((pt, i) => {
    const c = svgEl('circle', {
      cx: pt[0], cy: pt[1],
      r:  i === 0 ? r * 1.35 : r * 0.85,
      fill:   i === 0 ? '#f9e000' : '#89b4fa',
      stroke: '#ffffff',
      'stroke-width': 1 / S.zoom,
    });
    layer.appendChild(c);
  });
}

/* ─────────────────────────────────────────────
   HIT TESTING
───────────────────────────────────────────── */
function hitTest(wx, wy) {
  // reverse order: top item first
  for (let i = S.items.length - 1; i >= 0; i--) {
    const it = S.items[i];
    if (!it.visible) continue;
    if (hitTestItem(it, wx, wy)) return it;
  }
  return null;
}

function hitTestItem(it, x, y) {
  const tol = 8 / S.zoom;
  switch (it.type) {
    case TYPE.CONTINENT:
    case TYPE.COUNTRY:
    case TYPE.SEA:
      return pointInPolygon(x, y, it.points);
    case TYPE.RIVER:
      return pointNearPolyline(x, y, it.points, tol);
    case TYPE.MOUNTAIN: {
      const s = (it.size || 24) / 24;
      return Math.abs(x - it.x) < 22 * s && Math.abs(y - it.y) < 16 * s;
    }
    case TYPE.LABEL: {
      const fs   = it.fontSize || 14;
      const half = (it.text || it.name).length * fs * 0.33;
      return Math.abs(x - it.x) < half + tol && Math.abs(y - it.y) < fs + tol;
    }
  }
  return false;
}

function pointInPolygon(px, py, pts) {
  if (!pts || pts.length < 3) return false;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1];
    const xj = pts[j][0], yj = pts[j][1];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi))
      inside = !inside;
  }
  return inside;
}

function pointNearPolyline(px, py, pts, tol) {
  if (!pts || pts.length < 2) return false;
  for (let i = 0; i < pts.length - 1; i++)
    if (distToSeg(px, py, pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1]) < tol) return true;
  return false;
}

function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx*dx + dy*dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px-x1)*dx + (py-y1)*dy) / len2));
  return Math.hypot(px - (x1+t*dx), py - (y1+t*dy));
}

/* hit-test overlay control points */
function hitTestCp(wx, wy) {
  if (!S.selectedId) return null;
  const it = getItem(S.selectedId);
  if (!it || !it.points) return null;

  const tol = CP_R * 1.6 / S.zoom;

  for (let i = 0; i < it.points.length; i++) {
    const p = it.points[i];
    if (Math.hypot(wx - p[0], wy - p[1]) < tol)
      return { type: 'vertex', idx: i };
  }

  // midpoints
  const len  = it.points.length;
  const endI = it.type === TYPE.RIVER ? len - 1 : len;
  for (let i = 0; i < endI; i++) {
    const p1 = it.points[i];
    const p2 = it.points[(i + 1) % len];
    const mx = (p1[0] + p2[0]) / 2;
    const my = (p1[1] + p2[1]) / 2;
    if (Math.hypot(wx - mx, wy - my) < tol * 0.75)
      return { type: 'mid', afterIdx: i };
  }
  return null;
}

/* ─────────────────────────────────────────────
   DRAWING TOOL LOGIC
───────────────────────────────────────────── */
function startDrawing(wp) {
  S.drawing  = true;
  S.drawPts  = [[wp.x, wp.y]];
  setHint('Кликайте для добавления точек. Двойной клик / Enter — завершить. Esc — отмена.');
  renderAll();
}

function addDrawPoint(wp) {
  const last = S.drawPts[S.drawPts.length - 1];
  if (Math.abs(wp.x - last[0]) < 1 && Math.abs(wp.y - last[1]) < 1) return;
  S.drawPts.push([wp.x, wp.y]);
  renderAll();
}

function finishDrawing() {
  if (!S.drawing) return;
  const type = S.tool;
  const pts  = [...S.drawPts];
  const min  = type === 'river' ? 2 : 3;

  if (pts.length < min) {
    setHint(`Нужно минимум ${min} точки. Рисование отменено.`);
    cancelDrawing();
    return;
  }

  let newItem;
  if      (type === 'continent') newItem = mkContinent(pts);
  else if (type === 'country')   newItem = mkCountry(pts);
  else if (type === 'sea')       newItem = mkSea(pts);
  else if (type === 'river')     newItem = mkRiver(pts);

  if (newItem) {
    addItem(newItem);
    S.selectedId = newItem.id;
    updateItemsList();
    updateProps();
  }
  cancelDrawing();
}

function cancelDrawing() {
  S.drawing   = false;
  S.drawPts   = [];
  S.previewPt = null;
  clearHint();
  renderAll();
}

/* ─────────────────────────────────────────────
   EVENTS
───────────────────────────────────────────── */
let _spaceDown = false;
let _mouseDownBtn = -1;

function initEvents() {
  const svg = document.getElementById('map-svg');

  svg.addEventListener('mousedown',    onMouseDown);
  svg.addEventListener('mousemove',    onMouseMove);
  svg.addEventListener('mouseup',      onMouseUp);
  svg.addEventListener('click',        onClick);
  svg.addEventListener('dblclick',     onDblClick);
  svg.addEventListener('wheel',        onWheel, { passive: false });
  svg.addEventListener('contextmenu',  e => { e.preventDefault(); if (S.drawing) cancelDrawing(); });

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup',   onKeyUp);
}

function onMouseDown(e) {
  _mouseDownBtn = e.button;

  // Pan: middle mouse OR space + left mouse
  if (e.button === 1 || (e.button === 0 && _spaceDown)) {
    e.preventDefault();
    S.panning        = true;
    S.panStartSvg    = svgPosFromEvent(e);
    S.panStartOff    = { x: S.panX, y: S.panY };
    document.getElementById('map-svg').classList.add('panning');
    return;
  }

  if (e.button !== 0) return;
  const wp = worldFromEvent(e);

  if (S.tool === 'select') {
    handleSelectMouseDown(e, wp);
  }
  // drawing tools: we use click (not mousedown) to add points
  // mountain / label: handled on click too
}

function onClick(e) {
  if (e.button !== 0) return;
  if (S.panning) return;
  if (_spaceDown) return;

  const wp = worldFromEvent(e);

  if (DRAW_TOOLS.has(S.tool)) {
    handleDrawClick(e, wp);
    return;
  }
  if (S.tool === 'mountain') {
    const m = mkMountain(wp.x, wp.y);
    addItem(m);
    S.selectedId = m.id;
    updateItemsList();
    updateProps();
    return;
  }
  if (S.tool === 'label') {
    S.pendingLabelPos = wp;
    showLabelDialog();
    return;
  }
}

function handleSelectMouseDown(e, wp) {
  // Control-point interaction takes priority
  if (S.selectedId) {
    const cp = hitTestCp(wp.x, wp.y);
    if (cp) {
      if (cp.type === 'vertex') {
        S.editCp    = true;
        S.editCpIdx = cp.idx;
        return;
      }
      if (cp.type === 'mid') {
        // Insert new vertex at midpoint
        const it  = getItem(S.selectedId);
        const len = it.points.length;
        const i   = cp.afterIdx;
        const p1  = it.points[i];
        const p2  = it.points[(i + 1) % len];
        const np  = [(p1[0]+p2[0])/2, (p1[1]+p2[1])/2];
        it.points.splice(i + 1, 0, np);
        S.editCp    = true;
        S.editCpIdx = i + 1;
        renderAll();
        return;
      }
    }
  }

  // Hit-test items
  const hit = hitTest(wp.x, wp.y);
  if (hit) {
    S.selectedId = hit.id;
    // Prepare drag
    if (hit.type === TYPE.MOUNTAIN || hit.type === TYPE.LABEL) {
      S.dragging  = true;
      S.dragId    = hit.id;
      S.dragOffX  = wp.x - hit.x;
      S.dragOffY  = wp.y - hit.y;
    } else if (hit.points) {
      S.dragging      = true;
      S.dragId        = hit.id;
      S.dragStartPts  = deepClone(hit.points);
      S.dragStartPos  = { x: wp.x, y: wp.y };
    }
    renderAll();
    updateProps();
    updateItemsList();
  } else {
    // Deselect
    S.selectedId = null;
    renderAll();
    updateProps();
    updateItemsList();
  }
}

function handleDrawClick(e, wp) {
  if (!S.drawing) {
    startDrawing(wp);
    return;
  }
  // Close polygon if clicking near first point (snapping)
  if (S.tool !== 'river' && S.drawPts.length >= 3) {
    const fp   = S.drawPts[0];
    const dist = Math.hypot(wp.x - fp[0], wp.y - fp[1]);
    if (dist < 14 / S.zoom) {
      finishDrawing();
      return;
    }
  }
  addDrawPoint(wp);
}

function onMouseMove(e) {
  const sp = svgPosFromEvent(e);
  const wp = svgToWorld(sp.x, sp.y);

  // update coords display
  document.getElementById('st-coords').textContent = `X: ${Math.round(wp.x)}  Y: ${Math.round(wp.y)}`;

  if (S.panning) {
    S.panX = S.panStartOff.x + (sp.x - S.panStartSvg.x);
    S.panY = S.panStartOff.y + (sp.y - S.panStartSvg.y);
    renderAll();
    updateZoomStatus();
    return;
  }

  if (S.editCp && S.selectedId) {
    const it = getItem(S.selectedId);
    if (it && it.points && S.editCpIdx >= 0) {
      it.points[S.editCpIdx] = [wp.x, wp.y];
      scheduleSave();
      renderAll();
    }
    return;
  }

  if (S.dragging && S.dragId) {
    const it = getItem(S.dragId);
    if (!it) return;
    if (it.type === TYPE.MOUNTAIN || it.type === TYPE.LABEL) {
      it.x = wp.x - S.dragOffX;
      it.y = wp.y - S.dragOffY;
    } else if (it.points && S.dragStartPts) {
      const dx = wp.x - S.dragStartPos.x;
      const dy = wp.y - S.dragStartPos.y;
      it.points = S.dragStartPts.map(p => [p[0] + dx, p[1] + dy]);
    }
    scheduleSave();
    renderAll();
    return;
  }

  if (S.drawing) {
    S.previewPt = [wp.x, wp.y];
    renderAll();
  }
}

function onMouseUp(e) {
  if (S.panning) {
    S.panning = false;
    document.getElementById('map-svg').classList.remove('panning');
    return;
  }
  if (S.editCp) {
    S.editCp    = false;
    S.editCpIdx = -1;
    histPush();
    return;
  }
  if (S.dragging) {
    S.dragging     = false;
    S.dragId       = null;
    S.dragStartPts = null;
    histPush();
    return;
  }
}

function onDblClick(e) {
  if (S.drawing) {
    // remove the point added by the second click of the double-click
    if (S.drawPts.length > 1) S.drawPts.pop();
    finishDrawing();
    e.preventDefault();
    return;
  }

  // double-click on a vertex to DELETE it
  if (S.tool === 'select' && S.selectedId) {
    const wp  = worldFromEvent(e);
    const cp  = hitTestCp(wp.x, wp.y);
    if (cp && cp.type === 'vertex') {
      const it  = getItem(S.selectedId);
      const min = it.type === TYPE.RIVER ? 2 : 3;
      if (it.points.length > min) {
        it.points.splice(cp.idx, 1);
        histPush();
        renderAll();
      }
    }
  }
}

function onWheel(e) {
  e.preventDefault();
  const sp  = svgPosFromEvent(e);
  const fac = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const nz  = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, S.zoom * fac));
  S.panX    = sp.x - (sp.x - S.panX) * (nz / S.zoom);
  S.panY    = sp.y - (sp.y - S.panY) * (nz / S.zoom);
  S.zoom    = nz;
  renderAll();
  updateZoomStatus();
}

function onKeyDown(e) {
  // don't intercept when typing in inputs
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

  if (e.code === 'Space') {
    _spaceDown = true;
    e.preventDefault();
    if (!S.panning) document.getElementById('map-svg').style.cursor = 'grab';
    return;
  }

  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'z' && !e.shiftKey) { undo(); e.preventDefault(); return; }
    if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) { redo(); e.preventDefault(); return; }
    if (e.key === 's') { saveNow(); e.preventDefault(); return; }
  }

  if (e.key === 'Escape') {
    if (S.drawing) cancelDrawing();
    else { S.selectedId = null; renderAll(); updateProps(); updateItemsList(); }
    return;
  }

  if (e.key === 'Enter' && S.drawing) { finishDrawing(); e.preventDefault(); return; }

  if ((e.key === 'Delete' || e.key === 'Backspace') && S.selectedId && !S.drawing) {
    removeItem(S.selectedId);
    e.preventDefault();
    return;
  }

  // tool shortcuts (no ctrl)
  if (!e.ctrlKey && !e.metaKey) {
    const map = { v:'select', V:'select', c:'continent', C:'continent',
                  s:'country', S:'country', o:'sea', O:'sea',
                  r:'river', R:'river', m:'mountain', M:'mountain',
                  l:'label', L:'label' };
    if (map[e.key]) { setTool(map[e.key]); return; }
  }

  if (e.key === '+' || e.key === '=') { zoomStep(1.2); return; }
  if (e.key === '-' || e.key === '_') { zoomStep(1/1.2); return; }
  if (e.key === '0') { zoomFit(); return; }
}

function onKeyUp(e) {
  if (e.code === 'Space') {
    _spaceDown = false;
    if (!S.panning) {
      const cur = S.tool === 'select' ? 'default' : (DRAW_TOOLS.has(S.tool) ? 'crosshair' : 'default');
      document.getElementById('map-svg').style.cursor = '';
    }
  }
}

/* ─────────────────────────────────────────────
   ZOOM HELPERS
───────────────────────────────────────────── */
function zoomStep(factor) {
  const svg = document.getElementById('map-svg');
  const cx  = svg.clientWidth / 2;
  const cy  = svg.clientHeight / 2;
  const nz  = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, S.zoom * factor));
  S.panX    = cx - (cx - S.panX) * (nz / S.zoom);
  S.panY    = cy - (cy - S.panY) * (nz / S.zoom);
  S.zoom    = nz;
  renderAll();
  updateZoomStatus();
}

function zoomFit() {
  const svg = document.getElementById('map-svg');
  S.zoom = 1;
  S.panX = svg.clientWidth  / 2;
  S.panY = svg.clientHeight / 2;
  renderAll();
  updateZoomStatus();
}

/* ─────────────────────────────────────────────
   UI — TOOLBAR & TOOL SWITCHING
───────────────────────────────────────────── */
function setTool(tool) {
  if (S.drawing) cancelDrawing();
  S.tool = tool;

  document.querySelectorAll('.tool-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === tool));

  const svg = document.getElementById('map-svg');
  svg.className = '';
  if (DRAW_TOOLS.has(tool)) svg.classList.add('tool-draw');
  else if (tool === 'mountain') svg.classList.add('tool-mountain');
  else if (tool === 'label')    svg.classList.add('tool-label');

  document.getElementById('st-tool').textContent = 'Инструмент: ' + (TOOL_LABEL[tool] || tool);
}

/* ─────────────────────────────────────────────
   UI — ITEMS LIST (LEFT PANEL)
───────────────────────────────────────────── */
function updateItemsList() {
  const list = document.getElementById('items-list');
  list.innerHTML = '';

  // Show top item first
  const reversed = [...S.items].reverse();
  reversed.forEach(it => {
    const row = document.createElement('div');
    row.className = 'item-row' + (it.id === S.selectedId ? ' sel' : '');

    // icon
    const ico = document.createElement('span');
    ico.className = 'iico';
    ico.textContent = TYPE_ICON[it.type] || '?';

    // color dot
    const dot = document.createElement('div');
    dot.className = 'idot';
    dot.style.background = (it.fillColor && it.fillColor !== 'none') ? it.fillColor : (it.strokeColor || '#888');

    // name
    const nm = document.createElement('span');
    nm.className = 'iname';
    nm.textContent = it.name || it.text || 'Без названия';

    // visibility toggle
    const vis = document.createElement('span');
    vis.className = 'ivis';
    vis.textContent = it.visible ? '👁' : '👁‍🗨';
    vis.title = it.visible ? 'Скрыть' : 'Показать';
    vis.addEventListener('click', ev => {
      ev.stopPropagation();
      updateItem(it.id, { visible: !it.visible });
    });

    row.appendChild(ico);
    row.appendChild(dot);
    row.appendChild(nm);
    row.appendChild(vis);

    row.addEventListener('click', () => {
      S.selectedId = it.id;
      renderAll();
      updateProps();
      updateItemsList();
    });

    list.appendChild(row);
  });
}

/* ─────────────────────────────────────────────
   UI — PROPERTIES PANEL (RIGHT PANEL)
───────────────────────────────────────────── */
function updateProps() {
  const panel = document.getElementById('props');

  if (!S.selectedId) {
    panel.innerHTML = '<p class="no-sel">Ничего не выбрано</p>';
    return;
  }
  const it = getItem(S.selectedId);
  if (!it) {
    panel.innerHTML = '<p class="no-sel">Ничего не выбрано</p>';
    return;
  }

  panel.innerHTML = '';

  // helper to create a property row
  function row(label, content) {
    const d = document.createElement('div');
    d.className = 'pr';
    if (label) {
      const l = document.createElement('label');
      l.textContent = label;
      d.appendChild(l);
    }
    if (content) d.appendChild(content);
    panel.appendChild(d);
    return d;
  }

  function textInput(val, onChange) {
    const inp = document.createElement('input');
    inp.type  = 'text';
    inp.value = val || '';
    inp.addEventListener('input', () => onChange(inp.value));
    return inp;
  }

  function numInput(val, min, max, step, onChange) {
    const inp  = document.createElement('input');
    inp.type   = 'number';
    inp.value  = val;
    inp.min    = min;
    inp.max    = max;
    inp.step   = step;
    inp.addEventListener('input', () => onChange(Number(inp.value)));
    return inp;
  }

  function colorInput(val, onChange) {
    const inp = document.createElement('input');
    inp.type  = 'color';
    inp.value = (val && val !== 'none') ? val : '#888888';
    inp.addEventListener('input', () => onChange(inp.value));
    return inp;
  }

  function selectInput(options, val, onChange) {
    const sel = document.createElement('select');
    options.forEach(([v, lbl]) => {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = lbl;
      if (v === val) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  function btn(text, cls, onClick) {
    const b = document.createElement('button');
    b.className  = 'prop-btn' + (cls ? ' ' + cls : '');
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  function sep() {
    const d = document.createElement('div');
    d.className = 'prop-sep';
    panel.appendChild(d);
  }

  // ── type label ──
  const typeDiv = document.createElement('div');
  typeDiv.className = 'pr';
  typeDiv.innerHTML = `<label>Тип</label><span style="font-size:12px">${TYPE_ICON[it.type]} ${TYPE_LABEL[it.type] || it.type}</span>`;
  panel.appendChild(typeDiv);

  // ── name ──
  row('Название', textInput(it.name, v => updateItem(it.id, { name: v })));

  // ── label text ──
  if (it.type === TYPE.LABEL) {
    row('Текст надписи', textInput(it.text, v => updateItem(it.id, { text: v, name: v })));
  }

  sep();

  // ── fill color ──
  if (it.type !== TYPE.RIVER) {
    row('Цвет заливки', colorInput(it.fillColor, v => updateItem(it.id, { fillColor: v })));
  }

  // ── stroke color ──
  if (it.type !== TYPE.LABEL) {
    row('Цвет контура', colorInput(it.strokeColor, v => updateItem(it.id, { strokeColor: v })));
  }

  // ── stroke width ──
  if (it.type !== TYPE.LABEL) {
    row('Толщина контура', numInput(it.strokeWidth || 1, 0.5, 20, 0.5,
      v => updateItem(it.id, { strokeWidth: v })));
  }

  // ── sea opacity ──
  if (it.type === TYPE.SEA) {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex'; wrap.style.gap = '6px'; wrap.style.alignItems = 'center';
    const rng = document.createElement('input');
    rng.type  = 'range'; rng.min = 0.1; rng.max = 1; rng.step = 0.05;
    rng.value = it.fillOpacity !== undefined ? it.fillOpacity : 0.65;
    rng.style.flex = '1';
    const lbl = document.createElement('span');
    lbl.style.fontSize = '11px'; lbl.style.minWidth = '32px';
    lbl.textContent = Math.round(rng.value * 100) + '%';
    rng.addEventListener('input', () => {
      lbl.textContent = Math.round(rng.value * 100) + '%';
      updateItem(it.id, { fillOpacity: parseFloat(rng.value) });
    });
    wrap.appendChild(rng);
    wrap.appendChild(lbl);
    row('Прозрачность', wrap);
  }

  // ── label font ──
  if (it.type === TYPE.LABEL) {
    row('Цвет текста', colorInput(it.fillColor, v => updateItem(it.id, { fillColor: v })));
    row('Размер шрифта', numInput(it.fontSize || 14, 6, 120, 1,
      v => updateItem(it.id, { fontSize: v })));

    const fontStyleOpts = [
      ['normal',       'Обычный'],
      ['italic',       'Курсив'],
      ['bold_normal',  'Жирный'],
      ['bold_italic',  'Жирный курсив'],
    ];
    let curFS = it.fontWeight === 'bold'
      ? (it.fontStyle === 'italic' ? 'bold_italic' : 'bold_normal')
      : (it.fontStyle === 'italic' ? 'italic' : 'normal');

    row('Стиль', selectInput(fontStyleOpts, curFS, v => {
      const bold   = v.startsWith('bold');
      const italic = v.endsWith('italic');
      updateItem(it.id, { fontWeight: bold ? 'bold' : 'normal', fontStyle: italic ? 'italic' : 'normal' });
    }));

    const shadowWrap = document.createElement('div');
    shadowWrap.style.display = 'flex'; shadowWrap.style.gap = '6px'; shadowWrap.style.alignItems = 'center';
    const shadowCb = document.createElement('input');
    shadowCb.type    = 'checkbox';
    shadowCb.checked = it.textShadow !== false;
    shadowCb.style.accentColor = '#89b4fa';
    shadowCb.addEventListener('change', () => updateItem(it.id, { textShadow: shadowCb.checked }));
    const shadowLbl = document.createElement('span');
    shadowLbl.textContent = 'Тень текста';
    shadowLbl.style.fontSize = '12px';
    shadowWrap.appendChild(shadowCb);
    shadowWrap.appendChild(shadowLbl);
    row(null, shadowWrap);
  }

  // ── mountain size ──
  if (it.type === TYPE.MOUNTAIN) {
    row('Размер', numInput(it.size || 24, 8, 200, 2, v => updateItem(it.id, { size: v })));
  }

  sep();

  // ── z-order ──
  const orderRow = document.createElement('div');
  orderRow.className = 'pr';
  orderRow.innerHTML = '<label>Порядок</label>';
  const orderBtns = document.createElement('div');
  orderBtns.className = 'pr-row2';

  const upD = document.createElement('div'); upD.className = 'pr';
  upD.appendChild(btn('▲ Выше',  '', () => moveItemUp(it.id)));
  const downD = document.createElement('div'); downD.className = 'pr';
  downD.appendChild(btn('▼ Ниже', '', () => moveItemDown(it.id)));
  orderBtns.appendChild(upD);
  orderBtns.appendChild(downD);
  orderRow.appendChild(orderBtns);
  panel.appendChild(orderRow);

  sep();

  // ── delete ──
  row(null, btn('🗑️  Удалить', 'danger', () => {
    if (confirm(`Удалить «${it.name || it.text}»?`)) removeItem(it.id);
  }));

  // ── info ──
  if (it.points) {
    const info = document.createElement('div');
    info.className = 'pr';
    info.innerHTML = `<label>Вершин: ${it.points.length}</label>`;
    panel.appendChild(info);
  }
}

/* ─────────────────────────────────────────────
   UI — LABEL DIALOG
───────────────────────────────────────────── */
function showLabelDialog() {
  const dlg = document.getElementById('dlg-label');
  const inp = document.getElementById('dlg-label-input');
  dlg.classList.remove('hidden');
  inp.value = '';
  inp.focus();
}

function hideLabelDialog() {
  document.getElementById('dlg-label').classList.add('hidden');
}

function initLabelDialog() {
  document.getElementById('dlg-label-ok').addEventListener('click', () => {
    const text = document.getElementById('dlg-label-input').value.trim();
    if (text && S.pendingLabelPos) {
      const lbl = mkLabel(S.pendingLabelPos.x, S.pendingLabelPos.y, text);
      addItem(lbl);
      S.selectedId = lbl.id;
      updateItemsList();
      updateProps();
    }
    S.pendingLabelPos = null;
    hideLabelDialog();
  });
  document.getElementById('dlg-label-cancel').addEventListener('click', () => {
    S.pendingLabelPos = null;
    hideLabelDialog();
  });
  document.getElementById('dlg-label-input').addEventListener('keydown', e => {
    if (e.key === 'Enter')  document.getElementById('dlg-label-ok').click();
    if (e.key === 'Escape') document.getElementById('dlg-label-cancel').click();
  });
}

/* ─────────────────────────────────────────────
   UI — STATUS BAR HELPERS
───────────────────────────────────────────── */
function updateZoomStatus() {
  document.getElementById('st-zoom').textContent = `Масштаб: ${Math.round(S.zoom * 100)}%`;
}

let _savedTimer = null;
function showSaved(msg) {
  const el = document.getElementById('st-saved');
  el.textContent = msg;
  clearTimeout(_savedTimer);
  _savedTimer = setTimeout(() => { el.textContent = ''; }, 3000);
}

function setHint(msg) {
  document.getElementById('hint-text').textContent = msg;
}
function clearHint() {
  document.getElementById('hint-text').textContent = '';
}

/* ─────────────────────────────────────────────
   TOOLBAR WIRING
───────────────────────────────────────────── */
function initToolbar() {
  document.querySelectorAll('.tool-btn').forEach(b =>
    b.addEventListener('click', () => setTool(b.dataset.tool)));

  document.getElementById('btn-undo').addEventListener('click', undo);
  document.getElementById('btn-redo').addEventListener('click', redo);

  document.getElementById('btn-zoom-in').addEventListener('click',  () => zoomStep(1.25));
  document.getElementById('btn-zoom-out').addEventListener('click', () => zoomStep(1/1.25));
  document.getElementById('btn-zoom-fit').addEventListener('click', zoomFit);

  document.getElementById('btn-save').addEventListener('click', saveNow);
  document.getElementById('btn-export').addEventListener('click', doExportJSON);
  document.getElementById('btn-import').addEventListener('click', () =>
    document.getElementById('file-import').click());
  document.getElementById('file-import').addEventListener('change', e => {
    if (e.target.files[0]) doImportJSON(e.target.files[0]);
    e.target.value = '';
  });
}

/* ─────────────────────────────────────────────
   INITIALISATION
───────────────────────────────────────────── */
function init() {
  initToolbar();
  initLabelDialog();
  initEvents();

  // Center the world after layout is ready
  requestAnimationFrame(() => {
    const svg = document.getElementById('map-svg');
    S.panX = svg.clientWidth  / 2;
    S.panY = svg.clientHeight / 2;

    const loaded = loadSaved();

    histPush();           // baseline history entry
    renderAll();
    updateItemsList();
    updateProps();
    updateZoomStatus();

    setTool('select');

    if (loaded) showSaved('Данные загружены ✓');
    else         showSaved('Новая карта');
  });

  // Periodic autosave
  setInterval(saveNow, 15000);
}

document.addEventListener('DOMContentLoaded', init);
