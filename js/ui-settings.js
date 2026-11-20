/**
 * Settings panel controller (Layout, Compress, Extras, Export) + Live Size Estimate
 */
export function initSettings({ getState, onChange }) {
  const tabs = document.getElementById('settingsTabs');
  const panes = document.querySelectorAll('.settings-pane');

  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    const target = btn.dataset.tab;
    for (const b of tabs.querySelectorAll('button')) b.setAttribute('aria-selected', String(b === btn));
    for (const p of panes) p.hidden = p.dataset.pane !== target;
  });

  // Helper to bind inputs cleanly
  function bind(id, key, transform = v => v) {
    const el = document.getElementById(id);
    if (!el) return;
    const evt = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(evt, () => {
      const val = el.type === 'checkbox' ? el.checked : transform(el.value);
      onChange({ [key]: val });
    });
  }

  bind('pageSizeSelect', 'pageSize');
  bind('customW', 'customW', Number);
  bind('customH', 'customH', Number);
  bind('customUnit', 'customUnit');
  bind('marginRange', 'marginMm', Number);
  bind('fitModeSelect', 'fitMode');
  bind('templateSelect', 'template');
  bind('bgColorInput', 'bgColor');
  bind('compressionMode', 'compressionMode');
  bind('compressionPreset', 'compressionPreset');
  bind('customQuality', 'customQuality', Number);
  bind('customMaxDim', 'customMaxDim', Number);
  bind('targetSizeVal', 'targetSizeVal', Number);
  bind('targetSizeUnit', 'targetSizeUnit');
  bind('pageNumbersToggle', 'pageNumbers');
  bind('pageNumberFormat', 'pageNumberFormat');
  bind('pageNumberPos', 'pageNumberPos');
  bind('watermarkText', 'watermarkText');
  bind('watermarkOpacity', 'watermarkOpacity', Number);
  bind('watermarkPos', 'watermarkPos');
  bind('pdfFilename', 'filename');
  bind('metaTitle', 'metaTitle');
  bind('metaAuthor', 'metaAuthor');
  bind('pdfPassword', 'password');

  // Orientation segmented control
  document.getElementById('orientGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-v]');
    if (!btn) return;
    onChange({ orientation: btn.dataset.v });
  });

  // Background color swatches
  document.getElementById('bgSwatches').addEventListener('click', (e) => {
    const sw = e.target.closest('button[data-color]');
    if (!sw) return;
    onChange({ bgColor: sw.dataset.color });
  });

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1048576).toFixed(2)} MB`;
  }

  function syncUI() {
    const { pages, settings } = getState();
    document.getElementById('customSizeRow').hidden = settings.pageSize !== 'custom';
    document.getElementById('marginVal').textContent = `${settings.marginMm} mm`;
    document.getElementById('qualityVal').textContent = `${settings.customQuality}%`;
    document.getElementById('wmOpacityVal').textContent = `${settings.watermarkOpacity}%`;

    document.getElementById('presetGroup').hidden = settings.compressionMode !== 'preset';
    document.getElementById('customCompressGroup').hidden = settings.compressionMode !== 'custom';
    document.getElementById('targetSizeGroup').hidden = settings.compressionMode !== 'target';

    for (const b of document.querySelectorAll('#orientGroup button')) {
      b.setAttribute('aria-pressed', String(b.dataset.v === settings.orientation));
    }
    for (const sw of document.querySelectorAll('#bgSwatches button')) {
      sw.setAttribute('aria-pressed', String(sw.dataset.color.toLowerCase() === settings.bgColor.toLowerCase()));
    }

    // Estimate original vs final size
    const origBytes = pages.reduce((acc, p) => acc + (p.blob?.size || 0), 0);
    let factor = 0.42;
    if (settings.compressionMode === 'preset') {
      factor = settings.compressionPreset === 'original' ? 0.92
        : settings.compressionPreset === 'high' ? 0.65
        : settings.compressionPreset === 'low' ? 0.22 : 0.42;
    } else if (settings.compressionMode === 'custom') {
      factor = Math.max(0.12, (settings.customQuality / 100) * 0.72);
    } else if (settings.compressionMode === 'target') {
      const mult = settings.targetSizeUnit === 'MB' ? 1048576 : 1024;
      const targetB = (settings.targetSizeVal || 2) * mult;
      document.getElementById('sizeEstimateText').textContent =
        `Original: ${formatBytes(origBytes)} → Goal: ≤ ${formatBytes(targetB)}`;
      return;
    }
    const estBytes = Math.round(origBytes * factor) + pages.length * 1400;
    document.getElementById('sizeEstimateText').textContent =
      `Original: ${formatBytes(origBytes)} → Est. PDF: ~${formatBytes(estBytes)}`;
  }

  return { syncUI };
}
