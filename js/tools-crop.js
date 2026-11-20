/**
 * Lazy-loaded Crop & Straighten Tool
 */
export async function openCropTool({ page, onApply }) {
  const modal = document.getElementById('toolModal');
  const titleEl = document.getElementById('toolModalTitle');
  const bodyEl = document.getElementById('toolModalBody');
  const footerEl = document.getElementById('toolModalFooter');

  titleEl.textContent = `Crop & Straighten — ${page.name}`;
  let crop = { ...(page.crop || { x: 0, y: 0, w: 1, h: 1 }) };
  let fineRotate = page.fineRotate || 0;
  let flipH = !!page.flipH;
  let flipV = !!page.flipV;
  let ratio = null; // null = free

  bodyEl.innerHTML = `
    <div class="tool-stage" id="cropStage">
      <canvas id="cropCanvas"></canvas>
    </div>
    <div class="tool-controls-bar">
      <div class="segmented" id="cropRatios">
        <button type="button" data-r="" aria-pressed="true">Free</button>
        <button type="button" data-r="0.707">A4</button>
        <button type="button" data-r="1">1:1</button>
        <button type="button" data-r="0.75">3:4</button>
        <button type="button" data-r="1.333">4:3</button>
      </div>
      <button type="button" class="btn btn-secondary btn-sm" id="cropFlipH">Flip H</button>
      <button type="button" class="btn btn-secondary btn-sm" id="cropFlipV">Flip V</button>
      <button type="button" class="btn btn-ghost btn-sm" id="cropReset">Reset</button>
    </div>
    <div class="field" style="margin-top:12px">
      <label class="field-label" for="straightenRange">
        <span>Straighten</span>
        <span id="straightenVal">${fineRotate}°</span>
      </label>
      <input class="range" id="straightenRange" type="range" min="-45" max="45" step="0.5" value="${fineRotate}">
    </div>
  `;

  footerEl.innerHTML = `
    <button type="button" class="btn btn-secondary" id="toolCancelBtn">Cancel</button>
    <button type="button" class="btn btn-primary" id="toolSaveBtn">Apply Crop</button>
  `;
  modal.hidden = false;

  const canvas = document.getElementById('cropCanvas');
  const ctx = canvas.getContext('2d');
  const bmp = await createImageBitmap(page.blob, { imageOrientation: 'from-image' });

  const maxW = 720, maxH = 440;
  const scale = Math.min(1, maxW / bmp.width, maxH / bmp.height);
  canvas.width = Math.max(120, Math.round(bmp.width * scale));
  canvas.height = Math.max(120, Math.round(bmp.height * scale));

  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate((fineRotate * Math.PI) / 180);
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
    ctx.drawImage(bmp, -W / 2, -H / 2, W, H);
    ctx.restore();

    const rx = crop.x * W, ry = crop.y * H, rw = crop.w * W, rh = crop.h * H;
    // Darken outside crop
    ctx.fillStyle = 'rgba(20, 17, 15, 0.55)';
    ctx.fillRect(0, 0, W, ry);
    ctx.fillRect(0, ry + rh, W, H - (ry + rh));
    ctx.fillRect(0, ry, rx, rh);
    ctx.fillRect(rx + rw, ry, W - (rx + rw), rh);

    // Border + Rule of Thirds
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(rx + (rw * i) / 3, ry);
      ctx.lineTo(rx + (rw * i) / 3, ry + rh);
      ctx.moveTo(rx, ry + (rh * i) / 3);
      ctx.lineTo(rx + rw, ry + (rh * i) / 3);
      ctx.stroke();
    }

    // Corner handles
    const handles = [
      [rx, ry], [rx + rw, ry], [rx + rw, ry + rh], [rx, ry + rh]
    ];
    ctx.fillStyle = '#F25C3B';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    for (const [hx, hy] of handles) {
      ctx.beginPath();
      ctx.arc(hx, hy, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
  draw();

  let activeDrag = null; // 'move' | 'tl' | 'tr' | 'br' | 'bl'
  let startPt = null;
  let startCrop = null;

  function toNorm(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  }

  canvas.addEventListener('pointerdown', (e) => {
    const p = toNorm(e);
    const tol = 0.06;
    const corners = [
      ['tl', crop.x, crop.y],
      ['tr', crop.x + crop.w, crop.y],
      ['br', crop.x + crop.w, crop.y + crop.h],
      ['bl', crop.x, crop.y + crop.h],
    ];
    activeDrag = null;
    for (const [name, cx, cy] of corners) {
      if (Math.hypot(p.x - cx, p.y - cy) < tol) {
        activeDrag = name;
        break;
      }
    }
    if (!activeDrag && p.x >= crop.x && p.x <= crop.x + crop.w && p.y >= crop.y && p.y <= crop.y + crop.h) {
      activeDrag = 'move';
    }
    if (activeDrag) {
      canvas.setPointerCapture(e.pointerId);
      startPt = p;
      startCrop = { ...crop };
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!activeDrag) return;
    const p = toNorm(e);
    const dx = p.x - startPt.x;
    const dy = p.y - startPt.y;
    const minSize = 0.08;

    if (activeDrag === 'move') {
      crop.x = Math.max(0, Math.min(1 - startCrop.w, startCrop.x + dx));
      crop.y = Math.max(0, Math.min(1 - startCrop.h, startCrop.y + dy));
    } else {
      let x1 = startCrop.x, y1 = startCrop.y, x2 = startCrop.x + startCrop.w, y2 = startCrop.y + startCrop.h;
      if (activeDrag.includes('l')) x1 = Math.max(0, Math.min(x2 - minSize, startCrop.x + dx));
      if (activeDrag.includes('r')) x2 = Math.min(1, Math.max(x1 + minSize, startCrop.x + startCrop.w + dx));
      if (activeDrag.includes('t')) y1 = Math.max(0, Math.min(y2 - minSize, startCrop.y + dy));
      if (activeDrag.includes('b')) y2 = Math.min(1, Math.max(y1 + minSize, startCrop.y + startCrop.h + dy));
      let nw = x2 - x1, nh = y2 - y1;
      if (ratio) {
        const canvasRatio = canvas.width / canvas.height;
        const targetNormRatio = ratio / canvasRatio;
        nh = Math.min(1 - y1, nw / targetNormRatio);
        nw = nh * targetNormRatio;
      }
      crop = { x: x1, y: y1, w: Math.max(minSize, nw), h: Math.max(minSize, nh) };
    }
    draw();
  });

  canvas.addEventListener('pointerup', () => { activeDrag = null; });

  document.getElementById('cropRatios').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    for (const b of e.currentTarget.querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-pressed', 'true');
    ratio = btn.dataset.r ? parseFloat(btn.dataset.r) : null;
    if (ratio) {
      const canvasRatio = canvas.width / canvas.height;
      const targetNormRatio = ratio / canvasRatio;
      let w = crop.w, h = w / targetNormRatio;
      if (crop.y + h > 1) { h = 1 - crop.y; w = h * targetNormRatio; }
      crop.w = Math.min(1 - crop.x, w);
      crop.h = Math.min(1 - crop.y, h);
      draw();
    }
  });

  document.getElementById('straightenRange').addEventListener('input', (e) => {
    fineRotate = parseFloat(e.target.value);
    document.getElementById('straightenVal').textContent = `${fineRotate}°`;
    draw();
  });

  document.getElementById('cropFlipH').addEventListener('click', () => { flipH = !flipH; draw(); });
  document.getElementById('cropFlipV').addEventListener('click', () => { flipV = !flipV; draw(); });
  document.getElementById('cropReset').addEventListener('click', () => {
    crop = { x: 0, y: 0, w: 1, h: 1 };
    fineRotate = 0; flipH = false; flipV = false;
    document.getElementById('straightenRange').value = '0';
    document.getElementById('straightenVal').textContent = '0°';
    draw();
  });

  const close = () => { bmp.close(); modal.hidden = true; };
  document.getElementById('toolCancelBtn').onclick = close;
  document.getElementById('toolModalClose').onclick = close;
  document.getElementById('toolSaveBtn').onclick = () => {
    onApply({ crop, fineRotate, flipH, flipV });
    close();
  };
}
