import { makeSortable } from '../vendor/sort-helper.js';

function svgIcon(name, cls = 'icon icon-sm') {
  return `<svg class="${cls}" aria-hidden="true"><use href="icons/sprite.svg#${name}"></use></svg>`;
}

const PAGE_INCHES = {
  a4: [8.27, 11.69],
  a3: [11.69, 16.54],
  a5: [5.83, 8.27],
  letter: [8.5, 11],
  legal: [8.5, 14],
};

function evaluatePageQuality(page, settings) {
  if (!page.quality) return null;
  const dims = PAGE_INCHES[settings.pageSize] || PAGE_INCHES.a4;
  const swapped = (page.rotate === 90 || page.rotate === 270);
  const w = swapped ? page.origH : page.origW;
  const h = swapped ? page.origW : page.origH;
  const estDpi = settings.pageSize === 'fit-image'
    ? 150
    : Math.round(Math.min(w / dims[0], h / dims[1]));

  if (estDpi < 110) {
    return { label: `Low res (~${estDpi} DPI)`, fixType: 'fit-size', fixLabel: 'Fix: A5 / Fit' };
  }
  if (page.quality.meanLuma < 48 && (!page.scanFilter || page.scanFilter === 'original')) {
    return { label: 'Too dark', fixType: 'whiten', fixLabel: 'Brighten' };
  }
  if (page.quality.lapVar < 42) {
    return { label: 'Soft / blurry', fixType: 'fit-size', fixLabel: 'Smaller page' };
  }
  return null;
}

export function initGrid({ container, getState, callbacks }) {
  makeSortable(container, {
    itemSelector: '.page-card',
    onReorder: (from, to) => callbacks.onReorder(from, to),
  });

  function render() {
    const { pages, selectedIds, settings } = getState();
    container.innerHTML = '';
    const frag = document.createDocumentFragment();

    pages.forEach((page, idx) => {
      const card = document.createElement('article');
      card.className = `page-card${selectedIds.has(page.id) ? ' is-selected' : ''}`;
      card.dataset.id = page.id;
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', `Page ${idx + 1}: ${page.name}`);

      const qWarn = evaluatePageQuality(page, settings);
      const rot = (page.rotate || 0) + (page.fineRotate || 0);
      const sx = page.flipH ? -1 : 1;
      const sy = page.flipV ? -1 : 1;
      const thumbTransform = `rotate(${rot}deg) scale(${sx}, ${sy})`;

      card.innerHTML = `
        <div class="page-thumb-wrap">
          <img src="${page.thumbUrl}" alt="${page.name}" loading="lazy" style="transform:${thumbTransform}">
          <span class="page-num-badge">${idx + 1}</span>
          <button type="button" class="page-select-check" data-act="select" aria-label="Select page ${idx + 1}" aria-pressed="${selectedIds.has(page.id)}">
            ${svgIcon('check')}
          </button>
          ${qWarn ? `<div class="quality-badge"><span>${qWarn.label}</span><button type="button" data-act="fix" data-fix="${qWarn.fixType}">${qWarn.fixLabel}</button></div>` : ''}
        </div>
        <div class="page-meta-row">
          <span class="page-filename" title="${page.name}">${page.name}</span>
          <span class="page-dims">${page.origW}×${page.origH}</span>
        </div>
        <div class="page-actions">
          <button type="button" class="btn-icon" data-act="rotate" title="Rotate 90°">${svgIcon('rotate-cw')}</button>
          <button type="button" class="btn-icon" data-act="crop" title="Crop & Straighten">${svgIcon('crop')}</button>
          <button type="button" class="btn-icon" data-act="scan" title="Smart Scan">${svgIcon('scan')}</button>
          <button type="button" class="btn-icon" data-act="redact" title="Privacy Redact">${svgIcon('redact')}</button>
          <button type="button" class="btn-icon" data-act="sign" title="Add Signature">${svgIcon('pen')}</button>
          <button type="button" class="btn-icon" data-act="dup" title="Duplicate">${svgIcon('copy')}</button>
          <button type="button" class="btn-icon" data-act="del" title="Remove">${svgIcon('trash')}</button>
        </div>
      `;

      card.addEventListener('click', (e) => {
        const actEl = e.target.closest('[data-act]');
        if (!actEl) return;
        e.stopPropagation();
        const act = actEl.dataset.act;
        if (act === 'select') callbacks.onToggleSelect(page.id, e.shiftKey);
        else if (act === 'fix') callbacks.onQualityFix(page.id, actEl.dataset.fix);
        else callbacks.onPageAction(page.id, act);
      });

      frag.appendChild(card);
    });

    container.appendChild(frag);
  }

  return { render };
}
