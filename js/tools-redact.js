/**
 * Lazy-loaded Privacy Shield & Pixel-Baked Redaction Tool
 */
export async function openRedactTool({ page, onApply }) {
  const modal = document.getElementById('toolModal');
  const titleEl = document.getElementById('toolModalTitle');
  const bodyEl = document.getElementById('toolModalBody');
  const footerEl = document.getElementById('toolModalFooter');

  titleEl.textContent = `Privacy Shield & Redact — ${page.name}`;
  let boxes = (page.redactions || []).map(b => ({ ...b }));
  let mode = 'blackout';

  const metaText = page.strippedMeta?.length
    ? `Automatically stripped on export: ${page.strippedMeta.join(', ')}.`
    : 'No GPS or camera EXIF metadata found in this file.';

  bodyEl.innerHTML = `
    <div class="info-box is-mint" style="margin-bottom:10px">
      <strong>EXIF Stripper:</strong> ${metaText} Redaction boxes below are permanently baked into the output pixels.
    </div>
    <div class="tool-stage">
      <canvas id="redactCanvas" style="cursor:crosshair"></canvas>
    </div>
    <div class="tool-controls-bar">
      <div class="segmented" id="redactMode">
        <button type="button" data-m="blackout" aria-pressed="true">Solid Blackout</button>
        <button type="button" data-m="blur" aria-pressed="false">Heavy Blur</button>
      </div>
      <button type="button" class="btn btn-secondary btn-sm" id="redactUndo">Undo Box</button>
      <button type="button" class="btn btn-ghost btn-sm" id="redactClear">Clear All</button>
    </div>
  `;

  footerEl.innerHTML = `
    <button type="button" class="btn btn-secondary" id="toolCancelBtn">Cancel</button>
    <button type="button" class="btn btn-primary" id="toolSaveBtn">Save Redactions</button>
  `;
  modal.hidden = false;

  const canvas = document.getElementById('redactCanvas');
  const ctx = canvas.getContext('2d');
  const bmp = await createImageBitmap(page.blob, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 720 / bmp.width, 430 / bmp.height);
  canvas.width = Math.max(120, Math.round(bmp.width * scale));
  canvas.height = Math.max(120, Math.round(bmp.height * scale));

  let draftBox = null;

  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(bmp, 0, 0, W, H);
    const all = draftBox ? [...boxes, draftBox] : boxes;
    for (const b of all) {
      const rx = b.x * W, ry = b.y * H, rw = b.w * W, rh = b.h * H;
      if (b.mode === 'blur') {
        ctx.fillStyle = 'rgba(28, 25, 23, 0.35)';
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle = '#F25C3B';
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = '#0f0e0d';
        ctx.fillRect(rx, ry, rw, rh);
      }
    }
  }
  draw();

  let start = null;
  canvas.addEventListener('pointerdown', (e) => {
    const r = canvas.getBoundingClientRect();
    start = {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!start) return;
    const r = canvas.getBoundingClientRect();
    const cx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const cy = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    draftBox = {
      x: Math.min(start.x, cx),
      y: Math.min(start.y, cy),
      w: Math.abs(cx - start.x),
      h: Math.abs(cy - start.y),
      mode,
    };
    draw();
  });

  canvas.addEventListener('pointerup', () => {
    if (draftBox && draftBox.w > 0.015 && draftBox.h > 0.015) {
      boxes.push(draftBox);
    }
    draftBox = null;
    start = null;
    draw();
  });

  document.getElementById('redactMode').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    for (const b of e.currentTarget.querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-pressed', 'true');
    mode = btn.dataset.m;
  });

  document.getElementById('redactUndo').onclick = () => { boxes.pop(); draw(); };
  document.getElementById('redactClear').onclick = () => { boxes = []; draw(); };

  const close = () => { bmp.close(); modal.hidden = true; };
  document.getElementById('toolCancelBtn').onclick = close;
  document.getElementById('toolModalClose').onclick = close;
  document.getElementById('toolSaveBtn').onclick = () => {
    onApply({ redactions: boxes });
    close();
  };
}
