import { PDFBuilder } from '../vendor/pdf-engine.js';

const MM_TO_PT = 72 / 25.4;

const PAGE_PRESETS_MM = {
  a4: [210, 297],
  a3: [297, 420],
  a5: [148, 210],
  letter: [215.9, 279.4],
  legal: [215.9, 355.6],
};

function customToPt(val, unit) {
  const n = Math.max(10, Number(val) || 210);
  if (unit === 'mm') return n * MM_TO_PT;
  if (unit === 'cm') return n * 10 * MM_TO_PT;
  if (unit === 'in') return n * 72;
  return n * 0.75; // px (96dpi -> 72pt/in)
}

function getPageSizePt(page, settings, imgW, imgH) {
  if (settings.pageSize === 'fit-image') {
    const wPt = (imgW || 800) * 0.75;
    const hPt = (imgH || 1000) * 0.75;
    return [wPt, hPt];
  }
  let wMm, hMm;
  if (settings.pageSize === 'custom') {
    let cw = customToPt(settings.customW, settings.customUnit);
    let ch = customToPt(settings.customH, settings.customUnit);
    const orient = page?.orientation || settings.orientation;
    if (orient === 'landscape' && cw < ch) [cw, ch] = [ch, cw];
    if (orient === 'portrait' && cw > ch) [cw, ch] = [ch, cw];
    return [cw, ch];
  }
  [wMm, hMm] = PAGE_PRESETS_MM[settings.pageSize] || PAGE_PRESETS_MM.a4;
  let wPt = wMm * MM_TO_PT;
  let hPt = hMm * MM_TO_PT;
  const orient = page?.orientation || settings.orientation;
  if (orient === 'landscape' && wPt < hPt) [wPt, hPt] = [hPt, wPt];
  if (orient === 'portrait' && wPt > hPt) [wPt, hPt] = [hPt, wPt];
  return [wPt, hPt];
}

// Inspect JPEG APP1/EXIF & PNG metadata headers without external libs
function inspectMetadata(buffer) {
  const bytes = new Uint8Array(buffer);
  const found = new Set();
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // JPEG: scan markers up to SOS (0xDA)
    let i = 2;
    while (i + 4 < bytes.length) {
      if (bytes[i] !== 0xff) break;
      const marker = bytes[i + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
      if (marker === 0xe1) {
        // APP1 (EXIF or XMP)
        const ascii = String.fromCharCode(...bytes.subarray(i + 4, Math.min(i + 4 + 32, bytes.length)));
        if (ascii.startsWith('Exif')) {
          found.add('device info');
          // Quick scan inside APP1 for GPS IFD tag (0x8825) or DateTime (0x0132)
          const end = Math.min(i + 2 + segLen, bytes.length);
          for (let j = i + 10; j + 1 < end; j++) {
            if ((bytes[j] === 0x88 && bytes[j + 1] === 0x25) || (bytes[j] === 0x25 && bytes[j + 1] === 0x88)) {
              found.add('location');
            }
          }
          found.add('capture date');
        } else if (ascii.includes('http://ns.adobe.com/xap')) {
          found.add('XMP tags');
        }
      } else if (marker === 0xed) {
        found.add('IPTC tags');
      }
      if (segLen < 2) break;
      i += 2 + segLen;
    }
  } else if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    // PNG: scan for tEXt / iTXt / zTXt / eXIf
    let i = 8;
    while (i + 8 < bytes.length) {
      const len = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
      const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
      if (type === 'eXIf') { found.add('device info'); found.add('location'); }
      if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') found.add('text metadata');
      if (type === 'IEND' || len < 0) break;
      i += 12 + len;
    }
  }
  return Array.from(found);
}

// Quality metrics on small canvas (mean luma + Laplacian variance sharpness)
function computeQualityMetrics(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  let sumLuma = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    gray[p] = l;
    sumLuma += l;
  }
  const meanLuma = sumLuma / (w * h);
  let lapSum = 0;
  let lapSq = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const lap = gray[idx - w] + gray[idx + w] + gray[idx - 1] + gray[idx + 1] - 4 * gray[idx];
      lapSum += lap;
      lapSq += lap * lap;
      count++;
    }
  }
  const meanLap = lapSum / Math.max(1, count);
  const lapVar = lapSq / Math.max(1, count) - meanLap * meanLap;
  return { meanLuma, lapVar };
}

// Bilinear perspective warp from 4 normalized source corners [tl, tr, br, bl] -> dst canvas
function warpPerspective(srcData, srcW, srcH, corners, dstW, dstH) {
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  const [tl, tr, br, bl] = corners.map(c => ({ x: c.x * srcW, y: c.y * srcH }));

  // Compute 3x3 homography from unit square (u,v) in [0,1] to (x,y) in src
  const dx1 = tr.x - br.x, dx2 = bl.x - br.x, dx3 = tl.x - tr.x + br.x - bl.x;
  const dy1 = tr.y - br.y, dy2 = bl.y - br.y, dy3 = tl.y - tr.y + br.y - bl.y;
  const det = dx1 * dy2 - dx2 * dy1;
  let a, b, c, d, e, f, g, h;
  if (Math.abs(det) < 1e-6) {
    // Fallback affine
    a = tr.x - tl.x; b = bl.x - tl.x; c = tl.x;
    d = tr.y - tl.y; e = bl.y - tl.y; f = tl.y;
    g = 0; h = 0;
  } else {
    g = (dx3 * dy2 - dx2 * dy3) / det;
    h = (dx1 * dy3 - dx3 * dy1) / det;
    a = tr.x - tl.x + g * tr.x;
    b = bl.x - tl.x + h * bl.x;
    c = tl.x;
    d = tr.y - tl.y + g * tr.y;
    e = bl.y - tl.y + h * bl.y;
    f = tl.y;
  }

  for (let y = 0; y < dstH; y++) {
    const v = y / Math.max(1, dstH - 1);
    for (let x = 0; x < dstW; x++) {
      const u = x / Math.max(1, dstW - 1);
      const denom = g * u + h * v + 1;
      const sx = (a * u + b * v + c) / denom;
      const sy = (d * u + e * v + f) / denom;
      const ix = Math.max(0, Math.min(srcW - 1, Math.round(sx)));
      const iy = Math.max(0, Math.min(srcH - 1, Math.round(sy)));
      const si = (iy * srcW + ix) * 4;
      const di = (y * dstW + x) * 4;
      dst[di] = srcData[si];
      dst[di + 1] = srcData[si + 1];
      dst[di + 2] = srcData[si + 2];
      dst[di + 3] = 255;
    }
  }
  return new ImageData(dst, dstW, dstH);
}

// Smart Scan cleanup filters on ImageData
function applyScanFilter(imgData, filter) {
  if (!filter || filter === 'original') return imgData;
  const { data, width: w, height: h } = imgData;
  const n = w * h;

  if (filter === 'grayscale') {
    for (let i = 0; i < data.length; i += 4) {
      const g = Math.min(255, Math.max(0, (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] - 128) * 1.15 + 132));
      data[i] = data[i + 1] = data[i + 2] = g;
    }
    return imgData;
  }

  // Compute local background illumination via fast box blur on luminance
  const luma = new Float32Array(n);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    luma[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  const rad = Math.max(8, Math.round(Math.min(w, h) * 0.04));
  const bg = new Float32Array(n);
  // Horizontal pass
  const tmp = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    const row = y * w;
    for (let x = -rad; x <= rad; x++) sum += luma[row + Math.max(0, Math.min(w - 1, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / (2 * rad + 1);
      const add = luma[row + Math.min(w - 1, x + rad + 1)];
      const sub = luma[row + Math.max(0, x - rad)];
      sum += add - sub;
    }
  }
  // Vertical pass
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -rad; y <= rad; y++) sum += tmp[Math.max(0, Math.min(h - 1, y)) * w + x];
    for (let y = 0; y < h; y++) {
      bg[y * w + x] = sum / (2 * rad + 1);
      const add = tmp[Math.min(h - 1, y + rad + 1) * w + x];
      const sub = tmp[Math.max(0, y - rad) * w + x];
      sum += add - sub;
    }
  }

  if (filter === 'deshadow') {
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const ratio = 242 / Math.max(25, bg[p]);
      data[i] = Math.min(255, data[i] * ratio);
      data[i + 1] = Math.min(255, data[i + 1] * ratio);
      data[i + 2] = Math.min(255, data[i + 2] * ratio);
    }
  } else if (filter === 'whiten') {
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const diff = bg[p] - luma[p];
      if (diff < 8) {
        data[i] = data[i + 1] = data[i + 2] = 255;
      } else {
        const gain = Math.min(1.4, 245 / Math.max(30, bg[p]));
        data[i] = Math.min(255, Math.max(0, (data[i] * gain - 20) * 1.15));
        data[i + 1] = Math.min(255, Math.max(0, (data[i + 1] * gain - 20) * 1.15));
        data[i + 2] = Math.min(255, Math.max(0, (data[i + 2] * gain - 20) * 1.15));
      }
    }
  } else if (filter === 'bw') {
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const v = luma[p] < bg[p] - 11 ? 20 : 255;
      data[i] = data[i + 1] = data[i + 2] = v;
    }
  }
  return imgData;
}

// Bake redaction boxes directly into the canvas pixels (blur or solid blackout)
function bakeRedactions(ctx, w, h, redactions) {
  if (!redactions || !redactions.length) return;
  for (const r of redactions) {
    const rx = Math.round(r.x * w);
    const ry = Math.round(r.y * h);
    const rw = Math.max(2, Math.round(r.w * w));
    const rh = Math.max(2, Math.round(r.h * h));
    if (r.mode === 'blur') {
      // Pixelate + heavy blur so text/faces are irreversibly destroyed
      const block = Math.max(8, Math.round(Math.min(rw, rh) / 5));
      const smallW = Math.max(1, Math.round(rw / block));
      const smallH = Math.max(1, Math.round(rh / block));
      const tmp = new OffscreenCanvas(smallW, smallH);
      const tctx = tmp.getContext('2d');
      tctx.drawImage(ctx.canvas, rx, ry, rw, rh, 0, 0, smallW, smallH);
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmp, 0, 0, smallW, smallH, rx, ry, rw, rh);
      ctx.restore();
    } else {
      ctx.fillStyle = '#0f0e0d';
      ctx.fillRect(rx, ry, rw, rh);
    }
  }
}

async function processPageToJpeg(page, quality, maxDim, bgColor = '#ffffff') {
  const bitmap = await createImageBitmap(page.blob, { imageOrientation: 'from-image' });
  let srcW = bitmap.width;
  let srcH = bitmap.height;

  // Step 1: Smart Scan perspective warp if corners are set
  let workCanvas = new OffscreenCanvas(srcW, srcH);
  let wctx = workCanvas.getContext('2d');
  wctx.fillStyle = bgColor;
  wctx.fillRect(0, 0, srcW, srcH);
  wctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  if (page.scanCorners && page.scanCorners.length === 4) {
    const [tl, tr, br, bl] = page.scanCorners;
    const topW = Math.hypot((tr.x - tl.x) * srcW, (tr.y - tl.y) * srcH);
    const botW = Math.hypot((br.x - bl.x) * srcW, (br.y - bl.y) * srcH);
    const leftH = Math.hypot((bl.x - tl.x) * srcW, (bl.y - tl.y) * srcH);
    const rightH = Math.hypot((br.x - tr.x) * srcW, (br.y - tr.y) * srcH);
    const dstW = Math.max(64, Math.round(Math.max(topW, botW)));
    const dstH = Math.max(64, Math.round(Math.max(leftH, rightH)));
    const srcImg = wctx.getImageData(0, 0, srcW, srcH);
    const warped = warpPerspective(srcImg.data, srcW, srcH, page.scanCorners, dstW, dstH);
    workCanvas = new OffscreenCanvas(dstW, dstH);
    wctx = workCanvas.getContext('2d');
    wctx.putImageData(warped, 0, 0);
    srcW = dstW;
    srcH = dstH;
  }

  // Step 2: Crop
  const crop = page.crop || { x: 0, y: 0, w: 1, h: 1 };
  const cx = Math.round(crop.x * srcW);
  const cy = Math.round(crop.y * srcH);
  const cw = Math.max(8, Math.round(crop.w * srcW));
  const ch = Math.max(8, Math.round(crop.h * srcH));

  // Step 3: Rotation & Scale
  const rot90 = ((page.rotate || 0) % 360 + 360) % 360;
  const fineRad = ((page.fineRotate || 0) * Math.PI) / 180;
  const swapped = rot90 === 90 || rot90 === 270;
  let outW = swapped ? ch : cw;
  let outH = swapped ? cw : ch;

  if (maxDim && Math.max(outW, outH) > maxDim) {
    const scale = maxDim / Math.max(outW, outH);
    outW = Math.max(16, Math.round(outW * scale));
    outH = Math.max(16, Math.round(outH * scale));
  }

  const outCanvas = new OffscreenCanvas(outW, outH);
  const octx = outCanvas.getContext('2d');
  octx.fillStyle = bgColor;
  octx.fillRect(0, 0, outW, outH);

  octx.save();
  octx.translate(outW / 2, outH / 2);
  octx.rotate((rot90 * Math.PI) / 180 + fineRad);
  octx.scale(page.flipH ? -1 : 1, page.flipV ? -1 : 1);
  const drawW = swapped ? outH : outW;
  const drawH = swapped ? outW : outH;
  octx.drawImage(workCanvas, cx, cy, cw, ch, -drawW / 2, -drawH / 2, drawW, drawH);
  octx.restore();

  // Step 4: Scan Filter
  if (page.scanFilter && page.scanFilter !== 'original') {
    const imgData = octx.getImageData(0, 0, outW, outH);
    applyScanFilter(imgData, page.scanFilter);
    octx.putImageData(imgData, 0, 0);
  }

  // Step 5: Bake Redactions
  if (page.redactions && page.redactions.length) {
    bakeRedactions(octx, outW, outH, page.redactions);
  }

  const outBlob = await outCanvas.convertToBlob({ type: 'image/jpeg', quality });
  const bytes = new Uint8Array(await outBlob.arrayBuffer());
  return { bytes, width: outW, height: outH };
}

function fitRect(imgW, imgH, boxX, boxY, boxW, boxH, fitMode) {
  if (fitMode === 'stretch') {
    return { x: boxX, y: boxY, w: boxW, h: boxH };
  }
  if (fitMode === 'original') {
    const w = imgW * 0.75;
    const h = imgH * 0.75;
    return { x: boxX + (boxW - w) / 2, y: boxY + (boxH - h) / 2, w, h };
  }
  const imgRatio = imgW / imgH;
  const boxRatio = boxW / boxH;
  let w, h;
  if (fitMode === 'fill') {
    if (imgRatio > boxRatio) { h = boxH; w = boxH * imgRatio; }
    else { w = boxW; h = boxW / imgRatio; }
  } else {
    // contain ('fit')
    if (imgRatio > boxRatio) { w = boxW; h = boxW / imgRatio; }
    else { h = boxH; w = boxH * imgRatio; }
  }
  return { x: boxX + (boxW - w) / 2, y: boxY + (boxH - h) / 2, w, h };
}

async function decodeSignatureRgba(dataUrl) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const imgData = ctx.getImageData(0, 0, c.width, c.height);
  return { rgba: new Uint8Array(imgData.data.buffer), width: c.width, height: c.height };
}

async function assemblePdfFromJpegs(pages, processedJpegs, settings) {
  const doc = new PDFBuilder({
    title: settings.metaTitle || settings.filename || 'SnapPDF Document',
    author: settings.metaAuthor || '',
    password: settings.password || '',
  });

  const embedded = processedJpegs.map(j => doc.embedJpeg(j.bytes, j.width, j.height));

  // Pre-embed any unique signatures
  const sigCache = new Map();
  for (const p of pages) {
    if (p.signature?.dataUrl && !sigCache.has(p.signature.dataUrl)) {
      const s = await decodeSignatureRgba(p.signature.dataUrl);
      sigCache.set(p.signature.dataUrl, await doc.embedRgba(s.rgba, s.width, s.height));
    }
  }

  const marginPt = (Number(settings.marginMm) || 0) * MM_TO_PT;
  const tpl = settings.template || 'standard';

  const decoratePage = (pdfPage, pageIdx, totalPages, pageW, pageH) => {
    // Watermark
    if (settings.watermarkText && settings.watermarkText.trim()) {
      const txt = settings.watermarkText.trim();
      const alpha = (Number(settings.watermarkOpacity) || 20) / 100;
      const size = Math.max(18, Math.min(64, pageW * 0.08));
      const pos = settings.watermarkPos || 'diagonal';
      if (pos === 'diagonal') {
        pdfPage.drawText(txt, pageW * 0.22, pageH * 0.35, { size, bold: true, alpha, rotate: 45, color: '#44403c' });
      } else if (pos === 'center') {
        pdfPage.drawText(txt, pageW * 0.2, pageH * 0.48, { size, bold: true, alpha, color: '#44403c' });
      } else {
        pdfPage.drawText(txt, 24, pageH - 42, { size: 16, bold: true, alpha, color: '#44403c' });
      }
    }
    // Page Numbers
    if (settings.pageNumbers) {
      const fmtType = settings.pageNumberFormat || 'n';
      const label = fmtType === 'n-of-total'
        ? `${pageIdx + 1} / ${totalPages}`
        : fmtType === 'page-n'
          ? `Page ${pageIdx + 1}`
          : `${pageIdx + 1}`;
      const pos = settings.pageNumberPos || 'bottom-center';
      let tx = pageW / 2 - label.length * 2.8;
      let ty = 14;
      if (pos === 'bottom-right') { tx = pageW - 24 - label.length * 5.5; ty = 14; }
      else if (pos === 'top-right') { tx = pageW - 24 - label.length * 5.5; ty = pageH - 22; }
      pdfPage.drawText(label, tx, ty, { size: 10, color: '#57534e' });
    }
  };

  if (tpl === 'standard') {
    const total = pages.length;
    for (let i = 0; i < total; i++) {
      const p = pages[i];
      const j = processedJpegs[i];
      const [pw, ph] = getPageSizePt(p, settings, j.width, j.height);
      const pdfPage = doc.addPage(pw, ph, settings.bgColor);
      const boxW = Math.max(20, pw - marginPt * 2);
      const boxH = Math.max(20, ph - marginPt * 2);
      const r = fitRect(j.width, j.height, marginPt, marginPt, boxW, boxH, settings.fitMode);
      pdfPage.drawImage(embedded[i], r.x, r.y, r.w, r.h);

      if (p.signature?.dataUrl) {
        const sigRef = sigCache.get(p.signature.dataUrl);
        const sw = (p.signature.w || 0.26) * pw;
        const sh = sw * (sigRef.height / sigRef.width);
        const sx = (p.signature.x ?? 0.62) * pw;
        const sy = ph - (p.signature.y ?? 0.78) * ph - sh;
        pdfPage.drawImage(sigRef, sx, sy, sw, sh);
      }
      decoratePage(pdfPage, i, total, pw, ph);
    }
  } else if (tpl === 'id-card') {
    // Pairs of images placed side-by-side (or stacked) at real CR80 size: 85.6 x 53.98 mm
    const cardW = 85.6 * MM_TO_PT;
    const cardH = 53.98 * MM_TO_PT;
    const totalSheets = Math.ceil(pages.length / 2);
    for (let s = 0; s < totalSheets; s++) {
      const [pw, ph] = getPageSizePt(null, settings, 800, 1000);
      const pdfPage = doc.addPage(pw, ph, settings.bgColor);
      const idx1 = s * 2;
      const idx2 = s * 2 + 1;
      const gap = 14 * MM_TO_PT;
      const sideBySide = pw >= cardW * 2 + gap + 20;
      if (sideBySide) {
        const startX = (pw - (cardW * 2 + gap)) / 2;
        const y = (ph - cardH) / 2;
        pdfPage.drawImage(embedded[idx1], startX, y, cardW, cardH);
        if (idx2 < pages.length) pdfPage.drawImage(embedded[idx2], startX + cardW + gap, y, cardW, cardH);
      } else {
        const x = (pw - cardW) / 2;
        const startY = ph / 2 + gap / 2;
        pdfPage.drawImage(embedded[idx1], x, startY, cardW, cardH);
        if (idx2 < pages.length) pdfPage.drawImage(embedded[idx2], x, startY - cardH - gap, cardW, cardH);
      }
      decoratePage(pdfPage, s, totalSheets, pw, ph);
    }
  } else if (tpl === 'passport') {
    // 35 x 45 mm passport photo grid per page
    const photoW = 35 * MM_TO_PT;
    const photoH = 45 * MM_TO_PT;
    const gap = 5 * MM_TO_PT;
    const [pw, ph] = getPageSizePt(null, settings, 800, 1000);
    const cols = Math.max(1, Math.floor((pw - marginPt * 2 + gap) / (photoW + gap)));
    const rows = Math.max(1, Math.floor((ph - marginPt * 2 + gap) / (photoH + gap)));
    const startX = (pw - (cols * photoW + (cols - 1) * gap)) / 2;
    const startY = ph - (ph - (rows * photoH + (rows - 1) * gap)) / 2 - photoH;
    for (let i = 0; i < pages.length; i++) {
      const pdfPage = doc.addPage(pw, ph, settings.bgColor);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = startX + c * (photoW + gap);
          const y = startY - r * (photoH + gap);
          pdfPage.drawImage(embedded[i], x, y, photoW, photoH);
        }
      }
      decoratePage(pdfPage, i, pages.length, pw, ph);
    }
  } else {
    // 2-up, 4-up, 6-up, contact-sheet
    const cols = tpl === '2-up' ? 1 : tpl === '4-up' ? 2 : tpl === '6-up' ? 2 : 3;
    const rows = tpl === '2-up' ? 2 : tpl === '4-up' ? 2 : tpl === '6-up' ? 3 : 4;
    const perSheet = cols * rows;
    const totalSheets = Math.ceil(pages.length / perSheet);
    const gap = 8 * MM_TO_PT;
    for (let s = 0; s < totalSheets; s++) {
      const [pw, ph] = getPageSizePt(null, settings, 800, 1000);
      const pdfPage = doc.addPage(pw, ph, settings.bgColor);
      const availW = pw - marginPt * 2 - gap * (cols - 1);
      const availH = ph - marginPt * 2 - gap * (rows - 1);
      const cellW = availW / cols;
      const cellH = availH / rows;
      const labelPad = tpl === 'contact-sheet' ? 14 : 0;

      for (let k = 0; k < perSheet; k++) {
        const idx = s * perSheet + k;
        if (idx >= pages.length) break;
        const r = Math.floor(k / cols);
        const c = k % cols;
        const bx = marginPt + c * (cellW + gap);
        const by = ph - marginPt - (r + 1) * cellH - r * gap;
        const j = processedJpegs[idx];
        const rect = fitRect(j.width, j.height, bx, by + labelPad, cellW, Math.max(10, cellH - labelPad), 'fit');
        pdfPage.drawImage(embedded[idx], rect.x, rect.y, rect.w, rect.h);
        if (tpl === 'contact-sheet') {
          const name = (pages[idx].name || `Image ${idx + 1}`).slice(0, 22);
          pdfPage.drawText(name, bx + 2, by + 2, { size: 8, color: '#57534e' });
        }
      }
      decoratePage(pdfPage, s, totalSheets, pw, ph);
    }
  }

  return await doc.save();
}

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;
  try {
    if (type === 'analyzeAndThumb') {
      const { blob } = payload;
      const buf = await blob.arrayBuffer();
      const strippedMeta = inspectMetadata(buf);
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      const origW = bmp.width;
      const origH = bmp.height;

      // Generate 360px thumbnail
      const maxT = 360;
      const scale = Math.min(1, maxT / Math.max(origW, origH));
      const tw = Math.max(1, Math.round(origW * scale));
      const th = Math.max(1, Math.round(origH * scale));
      const canvas = new OffscreenCanvas(tw, th);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, tw, th);
      ctx.drawImage(bmp, 0, 0, tw, th);
      bmp.close();

      const quality = computeQualityMetrics(ctx, tw, th);
      const thumbBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
      self.postMessage({
        id,
        ok: true,
        result: { origW, origH, thumbBlob, strippedMeta, quality }
      });
    } else if (type === 'detectCorners') {
      const { blob } = payload;
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      const w = 160;
      const h = Math.max(60, Math.round((bmp.height / bmp.width) * w));
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close();
      const d = ctx.getImageData(0, 0, w, h).data;
      const gray = new Float32Array(w * h);
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        gray[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      }
      // Find strongest edge points in each of the 4 quadrants biased toward outer boundary
      const best = [
        { score: -1, x: 0.08, y: 0.08 },
        { score: -1, x: 0.92, y: 0.08 },
        { score: -1, x: 0.92, y: 0.92 },
        { score: -1, x: 0.08, y: 0.92 },
      ];
      for (let y = 4; y < h - 4; y++) {
        for (let x = 4; x < w - 4; x++) {
          const idx = y * w + x;
          const gx = Math.abs(gray[idx + 1] - gray[idx - 1]);
          const gy = Math.abs(gray[idx + w] - gray[idx - w]);
          const mag = gx + gy;
          if (mag < 42) continue;
          const nx = x / w, ny = y / h;
          const q = (ny < 0.5 ? (nx < 0.5 ? 0 : 1) : (nx < 0.5 ? 3 : 2));
          // Cornerness: edge strength + distance from center
          const distCenter = Math.hypot(nx - 0.5, ny - 0.5);
          const score = mag * 0.4 + distCenter * 180;
          if (score > best[q].score) {
            best[q] = { score, x: nx, y: ny };
          }
        }
      }
      const corners = best.map(b => ({
        x: Math.max(0.02, Math.min(0.98, b.x)),
        y: Math.max(0.02, Math.min(0.98, b.y)),
      }));
      self.postMessage({ id, ok: true, result: corners });
    } else if (type === 'buildPdf') {
      const { pages, settings } = payload;
      const presetMap = {
        original: { q: 0.94, maxDim: 4200 },
        high: { q: 0.88, maxDim: 2400 },
        balanced: { q: 0.76, maxDim: 1600 },
        low: { q: 0.55, maxDim: 1100 },
      };

      const renderAll = async (q, maxDim, reportProgress) => {
        const out = [];
        for (let i = 0; i < pages.length; i++) {
          out.push(await processPageToJpeg(pages[i], q, maxDim, settings.bgColor));
          if (reportProgress) {
            self.postMessage({ id, progress: Math.round(((i + 1) / pages.length) * 85) });
          }
        }
        return out;
      };

      let chosenQ, chosenMaxDim, pdfBytes, targetWarning = '';

      if (settings.compressionMode === 'target' && Number(settings.targetBytes) > 0) {
        const target = Number(settings.targetBytes);
        // Binary search across a quality/scale ladder (8 steps)
        const ladder = [
          { q: 0.88, maxDim: 2200 },
          { q: 0.80, maxDim: 1800 },
          { q: 0.72, maxDim: 1500 },
          { q: 0.62, maxDim: 1250 },
          { q: 0.52, maxDim: 1050 },
          { q: 0.42, maxDim: 880 },
          { q: 0.34, maxDim: 720 },
          { q: 0.25, maxDim: 560 },
        ];
        let lo = 0, hi = ladder.length - 1, bestIdx = ladder.length - 1;
        let bestBytes = null;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          self.postMessage({ id, progress: Math.round(15 + (mid / ladder.length) * 65) });
          const jpegs = await renderAll(ladder[mid].q, ladder[mid].maxDim, false);
          const candidate = await assemblePdfFromJpegs(pages, jpegs, settings);
          if (candidate.length <= target) {
            bestIdx = mid;
            bestBytes = candidate;
            hi = mid - 1; // try higher quality
          } else {
            lo = mid + 1;
          }
        }
        if (!bestBytes) {
          const jpegs = await renderAll(ladder[ladder.length - 1].q, ladder[ladder.length - 1].maxDim, false);
          bestBytes = await assemblePdfFromJpegs(pages, jpegs, settings);
          targetWarning = `Target is very tight for ${pages.length} page(s). Delivered smallest readable PDF (${(bestBytes.length / 1024).toFixed(0)} KB).`;
        }
        chosenQ = ladder[bestIdx].q;
        chosenMaxDim = ladder[bestIdx].maxDim;
        pdfBytes = bestBytes;
      } else {
        const cfg = settings.compressionMode === 'custom'
          ? { q: (Number(settings.customQuality) || 78) / 100, maxDim: Number(settings.customMaxDim) || 1800 }
          : (presetMap[settings.compressionPreset] || presetMap.balanced);
        chosenQ = cfg.q;
        chosenMaxDim = cfg.maxDim;
        const jpegs = await renderAll(chosenQ, chosenMaxDim, true);
        self.postMessage({ id, progress: 92 });
        pdfBytes = await assemblePdfFromJpegs(pages, jpegs, settings);
      }

      self.postMessage({ id, progress: 100 });
      self.postMessage({
        id,
        ok: true,
        result: {
          pdfBytes,
          chosenQ,
          chosenMaxDim,
          targetWarning,
        }
      }, [pdfBytes.buffer]);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
};
