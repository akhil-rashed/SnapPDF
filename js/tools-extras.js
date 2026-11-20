import { saveSignature, listSignatures, deleteSignature } from './db.js';

/**
 * Lazy-loaded Signature Pad & Page Placement Tool
 */
export async function openSignatureTool({ page, onApply }) {
  const modal = document.getElementById('toolModal');
  const titleEl = document.getElementById('toolModalTitle');
  const bodyEl = document.getElementById('toolModalBody');
  const footerEl = document.getElementById('toolModalFooter');

  titleEl.textContent = `Signature — ${page.name}`;
  let sigDataUrl = page.signature?.dataUrl || null;
  let posX = page.signature?.x ?? 0.62;
  let posY = page.signature?.y ?? 0.78;
  let sigW = page.signature?.w ?? 0.28;
  let tab = 'draw';

  bodyEl.innerHTML = `
    <div class="segmented" id="sigTabs" style="margin-bottom:10px">
      <button type="button" data-t="draw" aria-pressed="true">Draw Signature</button>
      <button type="button" data-t="type" aria-pressed="false">Type Signature</button>
    </div>
    <div id="sigDrawPane">
      <canvas id="sigPad" class="sig-pad-canvas" width="600" height="180"></canvas>
      <div class="tool-controls-bar">
        <button type="button" class="btn btn-secondary btn-sm" id="sigClearPad">Clear</button>
        <button type="button" class="btn btn-mint btn-sm" id="sigUseDrawn">Use &amp; Save Locally</button>
      </div>
    </div>
    <div id="sigTypePane" hidden>
      <div class="two-col">
        <input type="text" class="input" id="sigTypeInput" placeholder="Type your name...">
        <button type="button" class="btn btn-mint" id="sigUseTyped">Use &amp; Save</button>
      </div>
    </div>
    <div id="savedSigsWrap" class="saved-sigs"></div>
    <div class="field" style="margin-top:12px">
      <label class="field-label" for="sigSizeRange">
        <span>Placement on Page (drag to move)</span>
        <span id="sigSizeVal">${Math.round(sigW * 100)}% width</span>
      </label>
      <input class="range" id="sigSizeRange" type="range" min="12" max="60" value="${Math.round(sigW * 100)}">
    </div>
    <div class="tool-stage" style="min-height:220px; margin-top:8px">
      <canvas id="sigPreviewCanvas"></canvas>
    </div>
  `;

  footerEl.innerHTML = `
    <button type="button" class="btn btn-ghost" id="sigRemoveBtn" style="margin-right:auto">Remove Signature</button>
    <button type="button" class="btn btn-secondary" id="toolCancelBtn">Cancel</button>
    <button type="button" class="btn btn-primary" id="toolSaveBtn">Place on Page</button>
  `;
  modal.hidden = false;

  // Draw Pad
  const pad = document.getElementById('sigPad');
  const pctx = pad.getContext('2d');
  pctx.strokeStyle = '#1C1917';
  pctx.lineWidth = 3.2;
  pctx.lineCap = 'round';
  pctx.lineJoin = 'round';
  let drawing = false;
  let hasDrawn = false;

  pad.addEventListener('pointerdown', (e) => {
    drawing = true;
    hasDrawn = true;
    const r = pad.getBoundingClientRect();
    pctx.beginPath();
    pctx.moveTo(((e.clientX - r.left) / r.width) * pad.width, ((e.clientY - r.top) / r.height) * pad.height);
    pad.setPointerCapture(e.pointerId);
  });
  pad.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const r = pad.getBoundingClientRect();
    pctx.lineTo(((e.clientX - r.left) / r.width) * pad.width, ((e.clientY - r.top) / r.height) * pad.height);
    pctx.stroke();
  });
  pad.addEventListener('pointerup', () => { drawing = false; });

  document.getElementById('sigClearPad').onclick = () => {
    pctx.clearRect(0, 0, pad.width, pad.height);
    hasDrawn = false;
  };

  // Preview Canvas
  const prevCanvas = document.getElementById('sigPreviewCanvas');
  const prevCtx = prevCanvas.getContext('2d');
  const bmp = await createImageBitmap(page.blob, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 520 / bmp.width, 280 / bmp.height);
  prevCanvas.width = Math.max(120, Math.round(bmp.width * scale));
  prevCanvas.height = Math.max(120, Math.round(bmp.height * scale));

  let sigImg = null;
  function loadSigImg(url) {
    if (!url) { sigImg = null; drawPreview(); return; }
    const im = new Image();
    im.onload = () => { sigImg = im; drawPreview(); };
    im.src = url;
  }

  function drawPreview() {
    const W = prevCanvas.width, H = prevCanvas.height;
    prevCtx.clearRect(0, 0, W, H);
    prevCtx.drawImage(bmp, 0, 0, W, H);
    if (sigImg) {
      const sw = sigW * W;
      const sh = sw * (sigImg.height / Math.max(1, sigImg.width));
      const sx = posX * W;
      const sy = posY * H;
      prevCtx.drawImage(sigImg, sx, sy, sw, sh);
      prevCtx.strokeStyle = '#F25C3B';
      prevCtx.setLineDash([4, 3]);
      prevCtx.strokeRect(sx, sy, sw, sh);
      prevCtx.setLineDash([]);
    }
  }
  loadSigImg(sigDataUrl);

  // Drag signature on preview
  let dragSig = false;
  prevCanvas.addEventListener('pointerdown', (e) => {
    if (!sigImg) return;
    dragSig = true;
    prevCanvas.setPointerCapture(e.pointerId);
  });
  prevCanvas.addEventListener('pointermove', (e) => {
    if (!dragSig) return;
    const r = prevCanvas.getBoundingClientRect();
    posX = Math.max(0, Math.min(1 - sigW, (e.clientX - r.left) / r.width - sigW / 2));
    posY = Math.max(0, Math.min(0.92, (e.clientY - r.top) / r.height));
    drawPreview();
  });
  prevCanvas.addEventListener('pointerup', () => { dragSig = false; });

  document.getElementById('sigSizeRange').addEventListener('input', (e) => {
    sigW = parseInt(e.target.value, 10) / 100;
    document.getElementById('sigSizeVal').textContent = `${e.target.value}% width`;
    drawPreview();
  });

  async function renderSavedChips() {
    const list = await listSignatures();
    const wrap = document.getElementById('savedSigsWrap');
    wrap.innerHTML = '';
    for (const s of list) {
      const chip = document.createElement('div');
      chip.className = 'saved-sig-chip';
      chip.innerHTML = `<img src="${s.dataUrl}" alt="Saved signature"><button type="button" class="btn btn-ghost btn-sm" data-use="${s.id}">Use</button><button type="button" class="btn btn-ghost btn-sm" data-del="${s.id}" aria-label="Delete signature">&times;</button>`;
      chip.querySelector('[data-use]').onclick = () => { sigDataUrl = s.dataUrl; loadSigImg(sigDataUrl); };
      chip.querySelector('[data-del]').onclick = async () => { await deleteSignature(s.id); renderSavedChips(); };
      wrap.appendChild(chip);
    }
  }
  renderSavedChips();

  document.getElementById('sigTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    tab = btn.dataset.t;
    for (const b of e.currentTarget.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === btn));
    document.getElementById('sigDrawPane').hidden = tab !== 'draw';
    document.getElementById('sigTypePane').hidden = tab !== 'type';
  });

  document.getElementById('sigUseDrawn').onclick = async () => {
    if (!hasDrawn) return;
    sigDataUrl = pad.toDataURL('image/png');
    await saveSignature({ id: `sig_${Date.now()}`, dataUrl: sigDataUrl, createdAt: Date.now() });
    loadSigImg(sigDataUrl);
    renderSavedChips();
  };

  document.getElementById('sigUseTyped').onclick = async () => {
    const name = document.getElementById('sigTypeInput').value.trim();
    if (!name) return;
    const c = document.createElement('canvas');
    c.width = 480; c.height = 140;
    const cx = c.getContext('2d');
    cx.fillStyle = '#1C1917';
    cx.font = 'italic 54px Georgia, "Times New Roman", serif';
    cx.textBaseline = 'middle';
    cx.fillText(name, 20, 72);
    sigDataUrl = c.toDataURL('image/png');
    await saveSignature({ id: `sig_${Date.now()}`, dataUrl: sigDataUrl, createdAt: Date.now() });
    loadSigImg(sigDataUrl);
    renderSavedChips();
  };

  const close = () => { bmp.close(); modal.hidden = true; };
  document.getElementById('toolCancelBtn').onclick = close;
  document.getElementById('toolModalClose').onclick = close;
  document.getElementById('sigRemoveBtn').onclick = () => { onApply({ signature: null }); close(); };
  document.getElementById('toolSaveBtn').onclick = () => {
    if (sigDataUrl) {
      onApply({ signature: { dataUrl: sigDataUrl, x: posX, y: posY, w: sigW } });
    }
    close();
  };
}
