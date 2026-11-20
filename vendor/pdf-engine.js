/**
 * SnapPDF Pure-JS PDF 1.4 Engine (Zero-dependency ES Module)
 * Supports: Multi-page, DCTDecode (JPEG), Flate/Raw RGBA + SMask (PNG/Signatures),
 * Helvetica/Helvetica-Bold Type1 text, ExtGState alpha, rotation, Metadata,
 * and PDF 1.4 Standard Security Handler RC4-128 password encryption.
 */

const enc = new TextEncoder();

function hexToRgb01(hex) {
  const h = (hex || '#ffffff').replace('#', '');
  const n = h.length === 3
    ? h.split('').map(c => c + c).join('')
    : h.padEnd(6, 'f').slice(0, 6);
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  return [
    Number.isFinite(r) ? r : 1,
    Number.isFinite(g) ? g : 1,
    Number.isFinite(b) ? b : 1,
  ];
}

function pdfEscapeString(str) {
  // Escape backslashes and parens for PDF literal strings; strip non-Latin1 safely
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 0x5c) out += '\\\\';
    else if (code === 0x28) out += '\\(';
    else if (code === 0x29) out += '\\)';
    else if (code >= 0x20 && code <= 0xff) out += str[i];
    else out += '?';
  }
  return out;
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, '');
}

// --- Pure JS MD5 (RFC 1321) for PDF RC4-128 Encryption ---
function md5(bytes) {
  const len = bytes.length;
  const bitLen = len * 8;
  const padLen = ((len + 8) >> 6) * 64 + 64;
  const buf = new Uint8Array(padLen);
  buf.set(bytes);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(padLen - 8, bitLen >>> 0, true);
  view.setUint32(padLen - 4, Math.floor(bitLen / 0x100000000), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const s = [
    7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
    5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
    4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
    6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;

  for (let off = 0; off < padLen; off += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) M[j] = view.getUint32(off + j * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | ((~B) & D); g = i; }
      else if (i < 32) { F = (D & B) | ((~D) & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | (~D)); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << s[i]) | (F >>> (32 - s[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true); ov.setUint32(4, b0, true); ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
  return out;
}

function rc4(key, data) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 255;
    const t = S[i]; S[i] = S[j]; S[j] = t;
  }
  const out = new Uint8Array(data.length);
  let i = 0; j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + S[i]) & 255;
    const t = S[i]; S[i] = S[j]; S[j] = t;
    out[k] = data[k] ^ S[(S[i] + S[j]) & 255];
  }
  return out;
}

const PDF_PADDING = new Uint8Array([
  0x28,0xbf,0x4e,0x5e,0x4e,0x75,0x8a,0x41,0x64,0x00,0x4e,0x56,0xff,0xfa,0x01,0x08,
  0x2e,0x2e,0x00,0xb6,0xd0,0x68,0x3e,0x80,0x2f,0x0c,0xa9,0xfe,0x64,0x53,0x69,0x7a
]);

function padPassword(pw) {
  const bytes = enc.encode(pw || '');
  const out = new Uint8Array(32);
  const copyLen = Math.min(32, bytes.length);
  out.set(bytes.subarray(0, copyLen), 0);
  if (copyLen < 32) out.set(PDF_PADDING.subarray(0, 32 - copyLen), copyLen);
  return out;
}

function computeEncryption(userPassword, fileIdBytes) {
  const P = -4; // Allow printing, copying, etc. (standard 0xFFFFFFFC)
  const paddedUser = padPassword(userPassword);
  const paddedOwner = padPassword(userPassword + '_owner');

  // Algorithm 3: Owner key (O)
  let oHash = md5(paddedOwner);
  for (let i = 0; i < 50; i++) oHash = md5(oHash);
  let O = new Uint8Array(paddedUser);
  for (let i = 0; i < 20; i++) {
    const k = oHash.map(b => b ^ i);
    O = rc4(k, O);
  }

  // Algorithm 2: File encryption key
  const pBytes = new Uint8Array(4);
  new DataView(pBytes.buffer).setInt32(0, P, true);
  const keyInput = new Uint8Array(32 + 32 + 4 + fileIdBytes.length);
  keyInput.set(paddedUser, 0);
  keyInput.set(O, 32);
  keyInput.set(pBytes, 64);
  keyInput.set(fileIdBytes, 68);
  let encKey = md5(keyInput);
  for (let i = 0; i < 50; i++) encKey = md5(encKey.subarray(0, 16));

  // Algorithm 5: User key (U)
  const uInput = new Uint8Array(32 + fileIdBytes.length);
  uInput.set(PDF_PADDING, 0);
  uInput.set(fileIdBytes, 32);
  let U = rc4(encKey, md5(uInput));
  for (let i = 1; i <= 19; i++) {
    const k = encKey.map(b => b ^ i);
    U = rc4(k, U);
  }
  const uFull = new Uint8Array(32);
  uFull.set(U, 0); // 16-byte hash + 16-byte arbitrary padding

  return { O, U: uFull, P, encKey };
}

function encryptObjectBytes(encKey, objNum, genNum, data) {
  const input = new Uint8Array(encKey.length + 5);
  input.set(encKey, 0);
  input[encKey.length] = objNum & 0xff;
  input[encKey.length + 1] = (objNum >> 8) & 0xff;
  input[encKey.length + 2] = (objNum >> 16) & 0xff;
  input[encKey.length + 3] = genNum & 0xff;
  input[encKey.length + 4] = (genNum >> 8) & 0xff;
  const objKey = md5(input);
  return rc4(objKey.subarray(0, 16), data);
}

function toHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

async function deflateBytes(uint8) {
  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('deflate');
    const writer = cs.writable.getWriter();
    writer.write(uint8);
    writer.close();
    const res = await new Response(cs.readable).arrayBuffer();
    return { bytes: new Uint8Array(res), compressed: true };
  }
  return { bytes: uint8, compressed: false };
}

export class PDFBuilder {
  constructor(options = {}) {
    this.title = options.title || '';
    this.author = options.author || '';
    this.password = options.password || '';
    this.objects = []; // { id, dictStr, streamBytes }
    this.nextId = 1;
    this.pages = [];
    this.fontRegularId = null;
    this.fontBoldId = null;
    this.extGStates = new Map(); // alpha -> objId
  }

  _allocId() {
    return this.nextId++;
  }

  _ensureFonts() {
    if (!this.fontRegularId) {
      this.fontRegularId = this._allocId();
      this.objects.push({
        id: this.fontRegularId,
        raw: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`
      });
    }
    if (!this.fontBoldId) {
      this.fontBoldId = this._allocId();
      this.objects.push({
        id: this.fontBoldId,
        raw: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`
      });
    }
  }

  _getExtGState(alpha) {
    const key = fmt(Math.max(0, Math.min(1, alpha)));
    if (this.extGStates.has(key)) return this.extGStates.get(key);
    const id = this._allocId();
    const name = `GS${this.extGStates.size + 1}`;
    this.objects.push({
      id,
      raw: `<< /Type /ExtGState /ca ${key} /CA ${key} >>`
    });
    const entry = { id, name };
    this.extGStates.set(key, entry);
    return entry;
  }

  embedJpeg(jpegBytes, width, height) {
    const id = this._allocId();
    this.objects.push({
      id,
      dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>`,
      streamBytes: jpegBytes
    });
    return { id, width, height };
  }

  async embedRgba(rgbaBytes, width, height) {
    // Splits RGBA into RGB + Alpha SMask so transparent signatures/overlays render crisply
    const pixelCount = width * height;
    const rgb = new Uint8Array(pixelCount * 3);
    const alpha = new Uint8Array(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
      rgb[i * 3] = rgbaBytes[i * 4];
      rgb[i * 3 + 1] = rgbaBytes[i * 4 + 1];
      rgb[i * 3 + 2] = rgbaBytes[i * 4 + 2];
      alpha[i] = rgbaBytes[i * 4 + 3];
    }
    const rgbDef = await deflateBytes(rgb);
    const alphaDef = await deflateBytes(alpha);

    const smaskId = this._allocId();
    const smaskFilter = alphaDef.compressed ? '/Filter /FlateDecode ' : '';
    this.objects.push({
      id: smaskId,
      dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 ${smaskFilter}/Length ${alphaDef.bytes.length} >>`,
      streamBytes: alphaDef.bytes
    });

    const imgId = this._allocId();
    const imgFilter = rgbDef.compressed ? '/Filter /FlateDecode ' : '';
    this.objects.push({
      id: imgId,
      dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask ${smaskId} 0 R ${imgFilter}/Length ${rgbDef.bytes.length} >>`,
      streamBytes: rgbDef.bytes
    });
    return { id: imgId, width, height };
  }

  addPage(widthPt, heightPt, bgColor = '#ffffff') {
    this._ensureFonts();
    const page = {
      width: widthPt,
      height: heightPt,
      ops: [],
      xobjects: new Map(), // name -> objId
      gstates: new Map(),  // name -> objId
    };
    const [r, g, b] = hexToRgb01(bgColor);
    if (r < 0.999 || g < 0.999 || b < 0.999) {
      page.ops.push(`q ${fmt(r)} ${fmt(g)} ${fmt(b)} rg 0 0 ${fmt(widthPt)} ${fmt(heightPt)} re f Q`);
    }
    this.pages.push(page);

    return {
      drawImage(imgRef, x, y, w, h) {
        const name = `Im${page.xobjects.size + 1}`;
        page.xobjects.set(name, imgRef.id);
        page.ops.push(`q ${fmt(w)} 0 0 ${fmt(h)} ${fmt(x)} ${fmt(y)} cm /${name} Do Q`);
      },
      drawText: (text, x, y, opts = {}) => {
        const size = opts.size || 12;
        const bold = !!opts.bold;
        const color = opts.color || '#1c1917';
        const alpha = opts.alpha !== undefined ? opts.alpha : 1;
        const rotateDeg = opts.rotate || 0;
        const [tr, tg, tb] = hexToRgb01(color);

        let gsOp = '';
        if (alpha < 0.999) {
          const gs = this._getExtGState(alpha);
          page.gstates.set(gs.name, gs.id);
          gsOp = `/${gs.name} gs `;
        }
        const fontRef = bold ? '/F2' : '/F1';
        const rad = (rotateDeg * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const tm = rotateDeg !== 0
          ? `${fmt(cos)} ${fmt(sin)} ${fmt(-sin)} ${fmt(cos)} ${fmt(x)} ${fmt(y)} Tm`
          : `1 0 0 1 ${fmt(x)} ${fmt(y)} Tm`;

        page.ops.push(
          `q ${gsOp}${fmt(tr)} ${fmt(tg)} ${fmt(tb)} rg BT ${fontRef} ${fmt(size)} Tf ${tm} (${pdfEscapeString(text)}) Tj ET Q`
        );
      }
    };
  }

  async save() {
    this._ensureFonts();
    const catalogId = this._allocId();
    const pagesId = this._allocId();
    const pageIds = [];

    for (const p of this.pages) {
      const contentStr = p.ops.join('\n');
      const rawBytes = enc.encode(contentStr);
      const def = await deflateBytes(rawBytes);
      const contentId = this._allocId();
      const filterStr = def.compressed ? '/Filter /FlateDecode ' : '';
      this.objects.push({
        id: contentId,
        dict: `<< ${filterStr}/Length ${def.bytes.length} >>`,
        streamBytes: def.bytes
      });

      const pageId = this._allocId();
      pageIds.push(pageId);

      const xobjParts = [];
      for (const [name, id] of p.xobjects.entries()) xobjParts.push(`/${name} ${id} 0 R`);
      const gsParts = [];
      for (const [name, id] of p.gstates.entries()) gsParts.push(`/${name} ${id} 0 R`);

      const resParts = [`/Font << /F1 ${this.fontRegularId} 0 R /F2 ${this.fontBoldId} 0 R >>`];
      if (xobjParts.length) resParts.push(`/XObject << ${xobjParts.join(' ')} >>`);
      if (gsParts.length) resParts.push(`/ExtGState << ${gsParts.join(' ')} >>`);

      this.objects.push({
        id: pageId,
        raw: `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${fmt(p.width)} ${fmt(p.height)}] /Resources << ${resParts.join(' ')} >> /Contents ${contentId} 0 R >>`
      });
    }

    this.objects.push({
      id: pagesId,
      raw: `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`
    });

    this.objects.push({
      id: catalogId,
      raw: `<< /Type /Catalog /Pages ${pagesId} 0 R >>`
    });

    const infoId = this._allocId();
    const now = new Date();
    const dStr = `D:${now.getUTCFullYear()}${String(now.getUTCMonth()+1).padStart(2,'0')}${String(now.getUTCDate()).padStart(2,'0')}${String(now.getUTCHours()).padStart(2,'0')}${String(now.getUTCMinutes()).padStart(2,'0')}${String(now.getUTCSeconds()).padStart(2,'0')}Z`;
    const infoFields = [
      `/Producer (SnapPDF Offline Engine)`,
      `/Creator (SnapPDF)`,
      `/CreationDate (${dStr})`
    ];
    if (this.title) infoFields.push(`/Title (${pdfEscapeString(this.title)})`);
    if (this.author) infoFields.push(`/Author (${pdfEscapeString(this.author)})`);

    // File ID
    const fileIdBytes = md5(enc.encode(`${dStr}-${pageIds.length}-${this.title}-${Math.random()}`));
    const fileIdHex = toHex(fileIdBytes);

    let encryptId = null;
    let encKey = null;
    if (this.password && this.password.length > 0) {
      const encData = computeEncryption(this.password, fileIdBytes);
      encKey = encData.encKey;
      encryptId = this._allocId();
      this.objects.push({
        id: encryptId,
        raw: `<< /Filter /Standard /V 2 /R 3 /Length 128 /P ${encData.P} /O <${toHex(encData.O)}> /U <${toHex(encData.U)}> >>`
      });
      // Encrypt Info strings if password is set
      const encInfoFields = [
        `/Producer <${toHex(encryptObjectBytes(encKey, infoId, 0, enc.encode('SnapPDF Offline Engine')))}>`,
        `/Creator <${toHex(encryptObjectBytes(encKey, infoId, 0, enc.encode('SnapPDF')))}>`,
        `/CreationDate <${toHex(encryptObjectBytes(encKey, infoId, 0, enc.encode(dStr)))}>`
      ];
      if (this.title) encInfoFields.push(`/Title <${toHex(encryptObjectBytes(encKey, infoId, 0, enc.encode(this.title)))}>`);
      if (this.author) encInfoFields.push(`/Author <${toHex(encryptObjectBytes(encKey, infoId, 0, enc.encode(this.author)))}>`);
      this.objects.push({ id: infoId, raw: `<< ${encInfoFields.join(' ')} >>` });
    } else {
      this.objects.push({ id: infoId, raw: `<< ${infoFields.join(' ')} >>` });
    }

    // Sort objects by id
    this.objects.sort((a, b) => a.id - b.id);

    const chunks = [];
    let offset = 0;
    const pushBytes = (b) => { chunks.push(b); offset += b.length; };
    const pushStr = (s) => pushBytes(enc.encode(s));

    pushBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    const offsets = new Map();
    for (const obj of this.objects) {
      offsets.set(obj.id, offset);
      pushStr(`${obj.id} 0 obj\n`);
      if (obj.streamBytes) {
        pushStr(`${obj.dict}\nstream\n`);
        const payload = (encKey && obj.id !== encryptId)
          ? encryptObjectBytes(encKey, obj.id, 0, obj.streamBytes)
          : obj.streamBytes;
        pushBytes(payload);
        pushStr(`\nendstream\nendobj\n`);
      } else {
        pushStr(`${obj.raw}\nendobj\n`);
      }
    }

    const xrefOffset = offset;
    const maxId = this.nextId - 1;
    pushStr(`xref\n0 ${maxId + 1}\n0000000000 65535 f \n`);
    for (let id = 1; id <= maxId; id++) {
      const off = offsets.get(id) || 0;
      pushStr(`${String(off).padStart(10, '0')} 00000 n \n`);
    }

    const encRef = encryptId ? ` /Encrypt ${encryptId} 0 R` : '';
    pushStr(`trailer\n<< /Size ${maxId + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R${encRef} /ID [<${fileIdHex}><${fileIdHex}>] >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

    const total = new Uint8Array(offset);
    let pos = 0;
    for (const c of chunks) {
      total.set(c, pos);
      pos += c.length;
    }
    return total;
  }
}
