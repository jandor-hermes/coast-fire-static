const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dir = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(dir, 'coast-fire.html'), 'utf8');
const js = fs.readFileSync(path.join(dir, 'coast-fire.js'), 'utf8');

test('public static page offers a local JSON file import', () => {
  assert.match(html, /id="import-json"[^>]*type="file"/);
  assert.match(html, /coast-fire-import\.js/);
  assert.match(js, /parseImportedProfile/);
});

test('public static app does not send imported data to an API or persist in localStorage', () => {
  assert.doesNotMatch(js, /fetch\(/);
  assert.doesNotMatch(js, /localStorage\./);
  assert.doesNotMatch(js, /navigator\.clipboard/);
  assert.match(html, /No upload/i);
});
