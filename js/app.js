import { saveProject, loadProject, clearProject } from './db.js';
import { workerBridge } from './worker-bridge.js';
import { initGrid } from './ui-grid.js';
import { initSettings } from './ui-settings.js';
import { initPreviewModal } from './ui-preview.js';

const DEFAULT_SETTINGS = {
  pageSize: 'a4',
  customW: 210,
  customH: 297,
  customUnit: 'mm',
  orientation: 'portrait',
  marginMm: 10,
  fitMode: 'fit',
  template: 'standard',
  bgColor: '#ffffff',
  compressionMode: 'preset',
  compressionPreset: 'balanced',
  customQuality: 78,
  customMaxDim: 1800,
  targetSizeVal: 2,
  targetSizeUnit: 'MB',
  pageNumbers: false,
  pageNumberFormat: 'n',
  pageNumberPos: 'bottom-center',
  watermarkText: '',
  watermarkOpacity: 20,
  watermarkPos: 'diagonal',
  filename: 'SnapPDF-Document',
  metaTitle: '',
  metaAuthor: '',
  password: '',
};

const state = {
  pages: [],
  selectedIds: new Set(),
  lastSelectedId: null,
  settings: { ...DEFAULT_SETTINGS },
  undoStack: [],
  redoStack: [],
  strippedMetaSet: new Set(),
};

// --- Toast Helper ---
function showToast(msg, type = 'info') {
  const stack = document.getElementById('toastStack');
  const el = document.createElement('div');
  el.className = `toast${type === 'error' ? ' is-error' : type === 'success' ? ' is-success' : ''}`;
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    el.style.transition = 'opacity 180ms ease, transform 180ms ease';
    setTimeout(() => el.remove(), 200);
  }, 3400);
}

// --- Undo / Redo ---
function snapshotPages() {
  return state.pages.map(p => ({ ...p }));
}

function pushUndo() {
  state.undoStack.push(snapshotPages());
  if (state.undoStack.length > 30) state.undoStack.shift();
  state.redoStack.length = 0;
  updateHistoryButtons();
}

function undo() {
  if (!state.undoStack.length) return;
  state.redoStack.push(snapshotPages());
  state.pages = state.undoStack.pop();
  refreshAll();
  showToast('Undid last change');
}

function redo() {
  if (!state.redoStack.length) return;
  state.undoStack.push(snapshotPages());
  state.pages = state.redoStack.pop();
  refreshAll();
  showToast('Redid change');
}

function updateHistoryButtons() {
  document.getElementById('undoBtn').disabled = state.undoStack.length === 0;
  document.getElementById('redoBtn').disabled = state.redoStack.length === 0;
}

// --- Autosave (debounced) ---
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!state.pages.length) {
      clearProject();
      return;
    }
    const pagesToSave = state.pages.map(p => ({
      id: p.id,
      name: p.name,
      blob: p.blob,
      origW: p.origW,
      origH: p.origH,
      rotate: p.rotate,
      fineRotate: p.fineRotate,
      flipH: p.flipH,
      flipV: p.flipV,
      crop: p.crop,
      scanCorners: p.scanCorners,
      scanFilter: p.scanFilter,
      redactions: p.redactions,
      signature: p.signature,
      strippedMeta: p.strippedMeta,
      quality: p.quality,
      orientation: p.orientation,
    }));
    saveProject({ pages: pagesToSave, settings: state.settings });
  }, 700);
}

// --- UI Controllers ---
const grid = initGrid({
  container: document.getElementById('pageGrid'),
  getState: () => state,
  callbacks: {
    onReorder(from, to) {
      pushUndo();
      const [moved] = state.pages.splice(from, 1);
      state.pages.splice(to, 0, moved);
      refreshAll();
    },
    onToggleSelect(id, isShift) {
      if (isShift && state.lastSelectedId) {
        const i1 = state.pages.findIndex(p => p.id === state.lastSelectedId);
        const i2 = state.pages.findIndex(p => p.id === id);
        if (i1 !== -1 && i2 !== -1) {
          const [lo, hi] = i1 < i2 ? [i1, i2] : [i2, i1];
          for (let i = lo; i <= hi; i++) state.selectedIds.add(state.pages[i].id);
        }
      } else {
        if (state.selectedIds.has(id)) state.selectedIds.delete(id);
        else state.selectedIds.add(id);
      }
      state.lastSelectedId = id;
      refreshAll(false);
    },
    onQualityFix(id, fixType) {
      pushUndo();
      const page = state.pages.find(p => p.id === id);
      if (!page) return;
      if (fixType === 'whiten') {
        page.scanFilter = 'whiten';
        showToast('Applied Whiten Paper cleanup');
      } else {
        state.settings.pageSize = 'fit-image';
        document.getElementById('pageSizeSelect').value = 'fit-image';
        showToast('Switched page size to Fit to Image');
      }
      refreshAll();
    },
    async onPageAction(id, act) {
      const idx = state.pages.findIndex(p => p.id === id);
      if (idx === -1) return;
      const page = state.pages[idx];

      if (act === 'rotate') {
        pushUndo();
        page.rotate = ((page.rotate || 0) + 90) % 360;
        refreshAll();
      } else if (act === 'dup') {
        pushUndo();
        const copy = {
          ...page,
          id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          thumbUrl: URL.createObjectURL(page.thumbBlob || page.blob),
        };
        state.pages.splice(idx + 1, 0, copy);
        refreshAll();
      } else if (act === 'del') {
        pushUndo();
        if (page.thumbUrl) URL.revokeObjectURL(page.thumbUrl);
        state.pages.splice(idx, 1);
        state.selectedIds.delete(id);
        refreshAll();
      } else if (act === 'crop') {
        const { openCropTool } = await import('./tools-crop.js');
        openCropTool({
          page,
          onApply: (patch) => {
            pushUndo();
            Object.assign(page, patch);
            refreshAll();
          }
        });
      } else if (act === 'scan') {
        const { openScanTool } = await import('./tools-scan.js');
        openScanTool({
          page,
          onApply: (patch) => {
            pushUndo();
            Object.assign(page, patch);
            refreshAll();
          }
        });
      } else if (act === 'redact') {
        const { openRedactTool } = await import('./tools-redact.js');
        openRedactTool({
          page,
          onApply: (patch) => {
            pushUndo();
            Object.assign(page, patch);
            refreshAll();
          }
        });
      } else if (act === 'sign') {
        const { openSignatureTool } = await import('./tools-extras.js');
        openSignatureTool({
          page,
          onApply: (patch) => {
            pushUndo();
            Object.assign(page, patch);
            refreshAll();
          }
        });
      }
    }
  }
});

const settingsUI = initSettings({
  getState: () => state,
  onChange: (patch) => {
    Object.assign(state.settings, patch);
    refreshAll();
  }
});

const previewModal = initPreviewModal({ getState: () => state });

function updatePrivacyPill() {
  const pill = document.getElementById('privacyPill');
  const txt = document.getElementById('privacyPillText');
  if (state.strippedMetaSet.size > 0) {
    txt.textContent = `Removed: ${Array.from(state.strippedMetaSet).slice(0, 2).join(', ')}`;
  } else {
    txt.textContent = '100% Offline';
  }
  pill.title = state.strippedMetaSet.size
    ? `Privacy Shield will strip: ${Array.from(state.strippedMetaSet).join(', ')}`
    : '100% Offline — no network calls';
}

function refreshAll(save = true) {
  const hasPages = state.pages.length > 0;
  document.getElementById('emptyStage').hidden = hasPages;
  document.getElementById('editorShell').hidden = !hasPages;
  document.getElementById('mobileBar').hidden = !hasPages;

  document.getElementById('pageCountLabel').textContent =
    `${state.pages.length} ${state.pages.length === 1 ? 'page' : 'pages'}`;

  const selCount = state.selectedIds.size;
  const selActions = document.getElementById('selectionActions');
  selActions.hidden = selCount === 0;
  document.getElementById('selCountLabel').textContent = `${selCount} selected`;

  grid.render();
  settingsUI.syncUI();
  updateHistoryButtons();
  updatePrivacyPill();
  if (save) scheduleSave();
}

// --- Image Ingestion (100+ images in smooth chunks) ---
async function ingestFiles(fileList) {
  const files = Array.from(fileList).filter(f =>
    f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(f.name)
  );
  if (!files.length) {
    showToast('No supported image files found.', 'error');
    return;
  }

  pushUndo();
  let failed = 0;
  const CHUNK = 6;

  for (let i = 0; i < files.length; i += CHUNK) {
    const batch = files.slice(i, i + CHUNK);
    const results = await Promise.all(batch.map(async (file) => {
      try {
        const res = await workerBridge.call('analyzeAndThumb', { blob: file });
        for (const m of res.strippedMeta) state.strippedMetaSet.add(m);
        return {
          id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: file.name || 'Image',
          blob: file,
          thumbBlob: res.thumbBlob,
          thumbUrl: URL.createObjectURL(res.thumbBlob),
          origW: res.origW,
          origH: res.origH,
          strippedMeta: res.strippedMeta,
          quality: res.quality,
          rotate: 0,
          fineRotate: 0,
          flipH: false,
          flipV: false,
          crop: { x: 0, y: 0, w: 1, h: 1 },
          scanCorners: null,
          scanFilter: 'original',
          redactions: [],
          signature: null,
        };
      } catch {
        failed++;
        return null;
      }
    }));

    for (const item of results) {
      if (item) state.pages.push(item);
    }
    refreshAll();
  }

  if (failed > 0) {
    showToast(`Added ${files.length - failed} images (${failed} could not be decoded).`, 'error');
  } else {
    showToast(`Added ${files.length} ${files.length === 1 ? 'image' : 'images'}`, 'success');
  }
}

// --- PDF Export & Share ---
let lastPdfBlob = null;
let lastPdfName = 'SnapPDF-Document.pdf';

async function buildAndExport(mode = 'download') {
  if (!state.pages.length) return;
  const barWrap = document.getElementById('exportProgress');
  const bar = document.getElementById('exportProgressBar');
  const createBtns = [document.getElementById('desktopCreateBtn'), document.getElementById('mobileCreateBtn')];
  for (const b of createBtns) b.disabled = true;
  barWrap.hidden = false;
  bar.style.width = '6%';

  try {
    const targetMult = state.settings.targetSizeUnit === 'MB' ? 1048576 : 1024;
    const settingsPayload = {
      ...state.settings,
      targetBytes: (Number(state.settings.targetSizeVal) || 2) * targetMult,
    };
    const pagesPayload = state.pages.map(p => ({
      name: p.name,
      blob: p.blob,
      rotate: p.rotate,
      fineRotate: p.fineRotate,
      flipH: p.flipH,
      flipV: p.flipV,
      crop: p.crop,
      scanCorners: p.scanCorners,
      scanFilter: p.scanFilter,
      redactions: p.redactions,
      signature: p.signature,
      orientation: p.orientation,
    }));

    const res = await workerBridge.call('buildPdf', { pages: pagesPayload, settings: settingsPayload }, (pct) => {
      bar.style.width = `${pct}%`;
    });

    const blob = new Blob([res.pdfBytes], { type: 'application/pdf' });
    const rawName = (state.settings.filename || 'SnapPDF-Document').trim().replace(/\.pdf$/i, '');
    const fname = `${rawName || 'SnapPDF-Document'}.pdf`;
    lastPdfBlob = blob;
    lastPdfName = fname;

    const sizeKB = (blob.size / 1024).toFixed(0);
    const sizeLabel = blob.size >= 1048576 ? `${(blob.size / 1048576).toFixed(2)} MB` : `${sizeKB} KB`;

    if (res.targetWarning) {
      showToast(res.targetWarning, 'error');
    } else if (state.settings.compressionMode === 'target') {
      showToast(`Hit target: ${sizeLabel} (Q${Math.round(res.chosenQ * 100)}, ${res.chosenMaxDim}px)`, 'success');
    } else {
      showToast(`Created ${fname} (${sizeLabel})`, 'success');
    }

    if (mode === 'share' && navigator.canShare) {
      const file = new File([blob], fname, { type: 'application/pdf' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: fname });
        return;
      }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    showToast(`Export failed: ${err.message}`, 'error');
  } finally {
    bar.style.width = '100%';
    setTimeout(() => { barWrap.hidden = true; bar.style.width = '0%'; }, 350);
    for (const b of createBtns) b.disabled = false;
  }
}

// --- Wire Inputs, Drag/Drop, Paste, Theme, Shortcuts ---
const fileInput = document.getElementById('fileInput');
const cameraInput = document.getElementById('cameraInput');

document.getElementById('addImagesHeroBtn').onclick = () => fileInput.click();
document.getElementById('addMoreBtn').onclick = () => fileInput.click();
document.getElementById('cameraHeroBtn').onclick = () => cameraInput.click();

fileInput.onchange = (e) => { if (e.target.files.length) ingestFiles(e.target.files); fileInput.value = ''; };
cameraInput.onchange = (e) => { if (e.target.files.length) ingestFiles(e.target.files); cameraInput.value = ''; };

const dropzone = document.getElementById('dropzone');
['dragenter', 'dragover'].forEach(evt => {
  window.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('is-dragover');
  });
});
['dragleave', 'drop'].forEach(evt => {
  window.addEventListener(evt, (e) => {
    e.preventDefault();
    if (evt === 'drop') {
      dropzone.classList.remove('is-dragover');
      if (e.dataTransfer?.files?.length) ingestFiles(e.dataTransfer.files);
    } else if (e.relatedTarget === null) {
      dropzone.classList.remove('is-dragover');
    }
  });
});

window.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  const imgs = [];
  for (const it of items) {
    if (it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) imgs.push(f);
    }
  }
  if (imgs.length) ingestFiles(imgs);
});

// Toolbar & Multi-select actions
document.getElementById('undoBtn').onclick = undo;
document.getElementById('redoBtn').onclick = redo;
document.getElementById('previewBtn').onclick = () => previewModal.open(0);
document.getElementById('desktopCreateBtn').onclick = () => buildAndExport('download');
document.getElementById('mobileCreateBtn').onclick = () => buildAndExport('download');
document.getElementById('shareBtn').onclick = () => buildAndExport('share');

if (!navigator.canShare) {
  document.getElementById('shareBtn').hidden = true;
}

document.getElementById('selectAllBtn').onclick = () => {
  if (state.selectedIds.size === state.pages.length) state.selectedIds.clear();
  else state.pages.forEach(p => state.selectedIds.add(p.id));
  refreshAll(false);
};

document.getElementById('moveUpBtn').onclick = () => {
  if (!state.selectedIds.size) return;
  pushUndo();
  for (let i = 1; i < state.pages.length; i++) {
    if (state.selectedIds.has(state.pages[i].id) && !state.selectedIds.has(state.pages[i - 1].id)) {
      [state.pages[i - 1], state.pages[i]] = [state.pages[i], state.pages[i - 1]];
    }
  }
  refreshAll();
};

document.getElementById('moveDownBtn').onclick = () => {
  if (!state.selectedIds.size) return;
  pushUndo();
  for (let i = state.pages.length - 2; i >= 0; i--) {
    if (state.selectedIds.has(state.pages[i].id) && !state.selectedIds.has(state.pages[i + 1].id)) {
      [state.pages[i + 1], state.pages[i]] = [state.pages[i], state.pages[i + 1]];
    }
  }
  refreshAll();
};

document.getElementById('dupSelectedBtn').onclick = () => {
  if (!state.selectedIds.size) return;
  pushUndo();
  const next = [];
  for (const p of state.pages) {
    next.push(p);
    if (state.selectedIds.has(p.id)) {
      next.push({
        ...p,
        id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        thumbUrl: URL.createObjectURL(p.thumbBlob || p.blob),
      });
    }
  }
  state.pages = next;
  refreshAll();
};

document.getElementById('delSelectedBtn').onclick = () => {
  if (!state.selectedIds.size) return;
  pushUndo();
  state.pages = state.pages.filter(p => {
    if (state.selectedIds.has(p.id)) {
      if (p.thumbUrl) URL.revokeObjectURL(p.thumbUrl);
      return false;
    }
    return true;
  });
  state.selectedIds.clear();
  refreshAll();
};

// Mobile settings sheet toggle
const settingsPanel = document.getElementById('settingsPanel');
document.getElementById('mobileSettingsBtn').onclick = () => settingsPanel.classList.add('is-open');
document.getElementById('sheetCloseBtn').onclick = () => settingsPanel.classList.remove('is-open');

// Theme Toggle
const themeBtn = document.getElementById('themeToggleBtn');
function applyTheme(t) {
  if (t) document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
  const isDark = t === 'dark' || (!t && window.matchMedia('(prefers-color-scheme: dark)').matches);
  themeBtn.querySelector('use').setAttribute('href', `icons/sprite.svg#${isDark ? 'sun' : 'moon'}`);
}
applyTheme(localStorage.getItem('snappdf-theme'));
themeBtn.onclick = () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const next = cur ? (cur === 'dark' ? 'light' : 'dark') : (sysDark ? 'light' : 'dark');
  localStorage.setItem('snappdf-theme', next);
  applyTheme(next);
};

// Keyboard Shortcuts Modal
const helpModal = document.getElementById('helpModal');
document.getElementById('helpBtn').onclick = () => { helpModal.hidden = false; };
document.getElementById('helpCloseBtn').onclick = () => { helpModal.hidden = true; };

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (mod && ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y')) { e.preventDefault(); redo(); }
  else if (mod && e.key.toLowerCase() === 'a' && state.pages.length) {
    e.preventDefault();
    state.pages.forEach(p => state.selectedIds.add(p.id));
    refreshAll(false);
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedIds.size) {
    e.preventDefault();
    document.getElementById('delSelectedBtn').click();
  } else if (e.key === '?') {
    helpModal.hidden = !helpModal.hidden;
  } else if (e.key === 'Escape') {
    helpModal.hidden = true;
    document.getElementById('previewModal').hidden = true;
    document.getElementById('toolModal').hidden = true;
    settingsPanel.classList.remove('is-open');
  }
});

// Check IndexedDB for saved project on startup (non-blocking banner)
(async () => {
  const saved = await loadProject();
  if (saved && saved.pages?.length) {
    const banner = document.getElementById('resumeBanner');
    const meta = document.getElementById('resumeMeta');
    const when = new Date(saved.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    meta.textContent = `${saved.pages.length} ${saved.pages.length === 1 ? 'page' : 'pages'} saved at ${when}`;
    banner.hidden = false;

    document.getElementById('resumeBtn').onclick = async () => {
      banner.hidden = true;
      state.settings = { ...DEFAULT_SETTINGS, ...(saved.settings || {}) };
      for (const p of saved.pages) {
        try {
          const res = await workerBridge.call('analyzeAndThumb', { blob: p.blob });
          state.pages.push({
            ...p,
            thumbBlob: res.thumbBlob,
            thumbUrl: URL.createObjectURL(res.thumbBlob),
          });
        } catch {}
      }
      refreshAll(false);
      showToast('Restored your previous session', 'success');
    };

    document.getElementById('discardSessionBtn').onclick = () => {
      banner.hidden = true;
      clearProject();
    };
  }
})();

// Register Offline Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
