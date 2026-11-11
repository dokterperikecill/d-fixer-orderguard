const test = require('node:test');
const assert = require('node:assert/strict');
const Evidence = require('./evidence');

function dataUri(mime, bytes) {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20];

test('accepts valid JPEG, PNG, and WebP evidence', () => {
  for (const [mime, bytes] of [['image/jpeg', JPEG], ['image/png', PNG], ['image/webp', WEBP]]) {
    const result = Evidence.validateEvidenceDataUri(dataUri(mime, bytes));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.mimeType, mime);
    assert.equal(result.dataUri, dataUri(mime, bytes));
  }
});

test('rejects JavaScript, HTML, and SVG payloads', () => {
  const payloads = [
    'javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+',
    'data:image/svg+xml,<svg onload="alert(1)"></svg>',
    'data:image/png;base64,AAAA" onerror="alert(1)',
    'data:image/png;base64,AAAA\' onerror=\'alert(1)',
    'data:image/png;base64,AAAA<script>alert(1)</script>',
  ];
  for (const payload of payloads) {
    const result = Evidence.validateEvidenceDataUri(payload);
    assert.equal(result.ok, false, payload);
  }
});

test('rejects a declared MIME type that does not match the decoded bytes', () => {
  const result = Evidence.validateEvidenceDataUri(dataUri('image/png', JPEG));
  assert.equal(result.ok, false);
  assert.match(result.error, /tidak cocok/i);
});

test('rejects empty, oversized, and malformed evidence', () => {
  assert.equal(Evidence.validateEvidenceDataUri('').ok, false);
  assert.equal(Evidence.validateEvidenceDataUri('data:image/png;base64,').ok, false);
  assert.equal(Evidence.validateEvidenceDataUri('data:image/png;base64,not base64!!').ok, false);
  assert.equal(Evidence.validateEvidenceDataUri(dataUri('image/png', PNG), { maxBytes: 4 }).ok, false);
  const oversized = dataUri('image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(2 * 1024 * 1024).fill(0)]);
  assert.equal(Evidence.validateEvidenceDataUri(oversized).ok, false);
});

test('creates an img element through the DOM API and never returns an element for invalid data', () => {
  const created = [];
  const document = {
    createElement(tagName) {
      const element = { tagName };
      created.push(element);
      return element;
    },
  };
  const valid = Evidence.createEvidenceImage(document, dataUri('image/png', PNG), 'Bukti uji');
  assert.equal(valid.ok, true);
  assert.equal(created.length, 1);
  assert.equal(created[0].tagName, 'img');
  assert.equal(created[0].src, dataUri('image/png', PNG));
  assert.equal(created[0].alt, 'Bukti uji');
  assert.equal(created[0].className, 'evidence-image');

  const invalid = Evidence.createEvidenceImage(document, 'data:image/png;base64,AAAA" onerror="alert(1)', 'XSS');
  assert.equal(invalid.ok, false);
  assert.equal(created.length, 1);
});
