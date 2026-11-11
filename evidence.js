/*
 * Shared evidence validation for the browser and the Node.js server.
 *
 * Evidence is stored as a data URI. Validation is intentionally strict:
 * - only JPEG, PNG, and WebP
 * - base64 characters only (so quotes/HTML cannot break out of an attribute)
 * - a decoded size limit
 * - magic-byte checks so a declared MIME type cannot be spoofed
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrderGuardEvidence = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
  const DATA_URI_PATTERN = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
  const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

  function fail(error) {
    return { ok: false, error, element: null };
  }

  function decodeBase64(value) {
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
      return Uint8Array.from(Buffer.from(value, 'base64'));
    }
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function encodeBase64(bytes) {
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
      return Buffer.from(bytes).toString('base64');
    }
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  function startsWithBytes(bytes, expected) {
    if (bytes.length < expected.length) return false;
    for (let index = 0; index < expected.length; index += 1) {
      if (bytes[index] !== expected[index]) return false;
    }
    return true;
  }

  function matchesMagicBytes(bytes, mimeType) {
    if (mimeType === 'image/jpeg') return startsWithBytes(bytes, [0xff, 0xd8, 0xff]);
    if (mimeType === 'image/png') return startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (mimeType === 'image/webp') {
      return startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWithBytes(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]);
    }
    return false;
  }

  function validateEvidenceDataUri(value, options = {}) {
    const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES;
    const maxLength = Number.isInteger(options.maxLength) && options.maxLength > 0
      ? options.maxLength
      : Math.ceil((maxBytes * 4) / 3) + 128;

    if (typeof value !== 'string' || !value) return fail('Bukti foto tidak valid.');
    if (value.length > maxLength) return fail(`Ukuran bukti foto melebihi batas ${Math.round(maxBytes / 1024)} KB.`);
    if (value !== value.trim()) return fail('Bukti foto mengandung karakter yang tidak diizinkan.');

    const match = DATA_URI_PATTERN.exec(value);
    if (!match) return fail('Format bukti foto tidak valid. Gunakan JPEG, PNG, atau WebP.');

    const mimeType = match[1];
    if (!ALLOWED_MIME_TYPES.has(mimeType)) return fail('Tipe bukti foto tidak diizinkan.');

    let bytes;
    try {
      bytes = decodeBase64(match[2]);
    } catch (error) {
      return fail('Bukti foto tidak dapat dibaca.');
    }
    if (!bytes.length) return fail('Bukti foto kosong.');
    if (bytes.length > maxBytes) return fail(`Ukuran bukti foto melebihi batas ${Math.round(maxBytes / 1024)} KB.`);
    if (!matchesMagicBytes(bytes, mimeType)) return fail('Isi bukti foto tidak cocok dengan tipe yang dinyatakan.');

    const dataUri = `data:${mimeType};base64,${encodeBase64(bytes)}`;
    return { ok: true, error: '', dataUri, mimeType, bytes: bytes.length, element: null };
  }

  function isSafeEvidenceDataUri(value, options) {
    return validateEvidenceDataUri(value, options).ok;
  }

  function createEvidenceImage(doc, value, alt = 'Bukti foto') {
    const result = validateEvidenceDataUri(value);
    if (!result.ok) return result;
    if (!doc || typeof doc.createElement !== 'function') return fail('Dokumen tidak tersedia untuk menampilkan bukti foto.');

    const element = doc.createElement('img');
    element.src = result.dataUri;
    element.alt = String(alt || 'Bukti foto');
    element.className = 'evidence-image';
    element.loading = 'lazy';
    element.decoding = 'async';
    element.referrerPolicy = 'no-referrer';
    return { ...result, element };
  }

  return {
    DEFAULT_MAX_BYTES,
    validateEvidenceDataUri,
    isSafeEvidenceDataUri,
    createEvidenceImage,
  };
});
