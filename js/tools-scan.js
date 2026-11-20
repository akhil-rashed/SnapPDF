import { workerBridge } from './worker-bridge.js';

/**
 * Lazy-loaded Smart Scan Tool:
 * Auto-detects document corners, allows manual 4-corner adjustment,
 * and selects cleanup filters (Whiten Paper, B&W, Grayscale, Remove Shadows).
 */
export async function openScanTool({ page, onApply }) {
  const modal = document.getElementById('toolModal');
  const titleEl = document.getElementById('toolModalTitle');
  const bodyEl = document.getElementById('toolModalBody');
  const footerEl = document.getElementById('toolModalFooter');

  titleEl.textContent = `Smart Scan — ${page.name}`;
  let corners = page.scanCorners
    ? page.scanCorners.map(c => ({ ...c }))
    : await workerBridge.call('detectCorners', { blob: page.blob });
  let filter = page.scanFilter || 'whiten';

  bodyEl.innerHTML = `
    <div class="info-box is-mint" style="margin-bottom:10px">
      Drag the 4 coral corners to match your document edges. Perspective flattening &amp; cleanup are applied on export.
    </div>
    <div class="tool-stage">
      <canvas id="scanCanvas"></canvas>
    </div>
    <div class="field" style="margin-top:12px">
      <span class="field-label">Cleanup Filter</span>
      <div class="segmented" id="scanFilters" style="grid-template-columns: repeat(auto-fit, minmax(92px, 1fr)); grid-auto-flow: row;">
        <button type="button" data-f="original" aria-pressed="${filter === 'original'}">Original</button>
        <button type="button" data-f="whiten" aria-pressed="${filter === 'whiten'}">Whiten Paper</button>
        <button type="button" data-f="bw" aria-pressed="${filter === 'bw'}">B&amp;W Doc</button>
        <button type="button" data-f="grayscale" aria-pressed="${filter === 'grayscale'}">Grayscale</button>
        <button type="button" data-f="deshadow" aria-pressed="${filter === 'deshadow'}">No Shadows</button>
      </div>
    </div>
  `;

  footerEl.innerHTML = `
    <button type="button" class="btn btn-ghost" id="scanClearBtn" style="margin-right:auto">Disable Scan</button>
    <button type="button" class="btn btn-secondary" id="toolCancelBtn">Cancel</button>
    <button type="button" class="btn btn-primary" id="toolSaveBtn">Apply Smart Scan</button>
  `;
  modal.hidden = false;

  const canvas = document.getElementById('scanCanvas');
  const ctx = canvas.getContext('2d');
  const bmp = await createImageBitmap(page.blob, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 720 / bmp.width, 430 / bmp.height);
  canvas.width = Math.max(120, Math.round(bmp.width * scale));
  canvas.height = Math.max(120, Math.round(bmp.height * scale));

  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    if (filter === 'grayscale') ctx.filter = 'grayscale(1) contrast(1.15)';
    else if (filter === 'bw') ctx.filter = 'grayscale(1) contrast(2.2) brightness(1.08)';
    else if (filter === 'whiten') ctx.filter = 'contrast(1.35) brightness(1.12)';
    else if (filter === 'deshadow') ctx.filter = 'brightness(1.14) contrast(1.1)';
    ctx.drawImage(bmp, 0, 0, W, H);
    ctx.restore();

    const pts = corners.map(c => ({ x: c.x * W, y: c.y * H }));
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(242, 92, 59, 0.14)';
    ctx.fill();
    ctx.strokeStyle = '#F25C3B';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    for (const pt of pts) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 10, 0, Math.PI * 2);
      ctx.fillStyle = '#F25C3B';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }
  }
  draw();

  let activeIdx = -1;
  canvas.addEventListener('pointerdown', (e) => {
    const r = canvas.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width;
    const ny = (e.clientY - r.top) / r.height;
    let bestD = 0.08;
    activeIdx = -1;
    corners.forEach((c, idx) => {
      const d = Math.hypot(c.x - nx, c.y - ny);
      if (d < bestD) { bestD = d; activeIdx = idx; }
    });
    if (activeIdx !== -1) canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (activeIdx === -1) return;
    const r = canvas.getBoundingClientRect();
    corners[activeIdx].x = Math.max(0.01, Math.min(0.99, (e.clientX - r.left) / r.width));
    corners[activeIdx].y = Math.max(0.01, Math.min(0.99, (e.clientY - r.top) / r.height));
    draw();
  });
  canvas.addEventListener('pointerup', () => { activeIdx = -1; });

  document.getElementById('scanFilters').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    for (const b of e.currentTarget.querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-pressed', 'true');
    filter = btn.dataset.f;
    draw();
  });

  const close = () => { bmp.close(); modal.hidden = true; };
  document.getElementById('toolCancelBtn').onclick = close;
  document.getElementById('toolModalClose').onclick = close;
  document.getElementById('scanClearBtn').onclick = () => {
    onApply({ scanCorners: null, scanFilter: 'original' });
    close();
  };
  document.getElementById('toolSaveBtn').onclick = () => {
    onApply({ scanCorners: corners, scanFilter: filter });
    close();
  };
}
