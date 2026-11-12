const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
assert.doesNotMatch(source, /appendSwitch\s*\(\s*(['"`])ignore-certificate-errors\1/);
console.log('TLS tests passed');
