/**
 * Live PDF Preview modal with page-by-page flip
 */
export function initPreviewModal({ getState }) {
  const modal = document.getElementById('previewModal');
  const canvas = document.getElementById('previewCanvas');
  const ctx = canvas.getContext('2d');
  const indicator = document.getElementById('previewIndicator');
  const prevBtn = document.getElementById('previewPrev');
  const nextBtn = document.getElementById('previewNext');
  const closeBtn = document.getElementById('previewClose');

  let curPage = 0;

  async function renderPage() {
    const { pages, settings } = getState();
    if (!pages.length) return;
    curPage = Math.max(0, Math.min(pages.length - 1, curPage));
    const page = pages[curPage];
    indicator.textContent = `Page ${curPage + 1} of ${pages.length}`;
    prevBtn.disabled = curPage === 0;
    nextBtn.disabled = curPage === pages.length - 1;

    const bmp = await createImageBitmap(page.blob, { imageOrientation: 'from-image' });
    const orient = page.orientation || settings.orientation;
    const baseW = orient === 'landscape' ? 680 : 480;
    const baseH = orient === 'landscape' ? 480 : 680;
    canvas.width = baseW;
    canvas.height = baseH;

    // Background
    ctx.fillStyle = settings.bgColor || '#ffffff';
    ctx.fillRect(0, 0, baseW, baseH);

    // Margins
    const mPx = (Number(settings.marginMm) || 0) * 2.2;
    const boxW = Math.max(20, baseW - mPx * 2);
    const boxH = Math.max(20, baseH - mPx * 2);

    const rot90 = ((page.rotate || 0) % 360 + 360) % 360;
    const swapped = rot90 === 90 || rot90 === 270;
    const iw = swapped ? bmp.height : bmp.width;
    const ih = swapped ? bmp.width : bmp.height;

    let dw = boxW, dh = boxH;
    if (settings.fitMode !== 'stretch') {
      const ir = iw / ih, br = boxW / boxH;
      if (settings.fitMode === 'fill') {
        if (ir > br) { dh = boxH; dw = boxH * ir; } else { dw = boxW; dh = boxW / ir; }
      } else {
        if (ir > br) { dw = boxW; dh = boxW / ir; } else { dh = boxH; dw = boxH * ir; }
      }
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(mPx, mPx, boxW, boxH);
    ctx.clip();
    ctx.translate(baseW / 2, baseH / 2);
    ctx.rotate(((rot90 + (page.fineRotate || 0)) * Math.PI) / 180);
    ctx.scale(page.flipH ? -1 : 1, page.flipV ? -1 : 1);
    const drawW = swapped ? dh : dw;
    const drawH = swapped ? dw : dh;
    ctx.drawImage(bmp, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();
    bmp.close();

    // Watermark preview
    if (settings.watermarkText && settings.watermarkText.trim()) {
      ctx.save();
      ctx.globalAlpha = (Number(settings.watermarkOpacity) || 20) / 100;
      ctx.fillStyle = '#44403c';
      ctx.font = 'bold 34px sans-serif';
      ctx.textAlign = 'center';
      ctx.translate(baseW / 2, baseH / 2);
      if ((settings.watermarkPos || 'diagonal') === 'diagonal') ctx.rotate(-Math.PI / 4);
      ctx.fillText(settings.watermarkText.trim(), 0, 0);
      ctx.restore();
    }

    // Page number preview
    if (settings.pageNumbers) {
      ctx.save();
      ctx.fillStyle = '#57534e';
      ctx.font = '12px sans-serif';
      const lbl = settings.pageNumberFormat === 'n-of-total'
        ? `${curPage + 1} / ${pages.length}`
        : settings.pageNumberFormat === 'page-n'
          ? `Page ${curPage + 1}`
          : `${curPage + 1}`;
      ctx.textAlign = 'center';
      ctx.fillText(lbl, baseW / 2, baseH - 14);
      ctx.restore();
    }
  }

  prevBtn.onclick = () => { curPage--; renderPage(); };
  nextBtn.onclick = () => { curPage++; renderPage(); };
  closeBtn.onclick = () => { modal.hidden = true; };

  return {
    open(startIdx = 0) {
      curPage = startIdx;
      modal.hidden = false;
      renderPage();
    }
  };
}
