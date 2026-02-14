const test = require('node:test');
const assert = require('node:assert/strict');

const {
  rootHandler,
  convertHandler,
  compressHandler,
  extractHandler,
  unlockHandler,
} = require('../server');

const createRes = () => ({
  statusCode: 200,
  body: '',
  headers: {},
  status(code) {
    this.statusCode = code;
    return this;
  },
  set(name, value) {
    this.headers[name.toLowerCase()] = String(value);
    return this;
  },
  send(payload) {
    this.body = String(payload);
    return this;
  },
  download(filePath, fileName, cb) {
    this.downloadPath = filePath;
    this.downloadName = fileName;
    if (typeof cb === 'function') cb();
    return this;
  },
});

test('GET / handler responds with health text', () => {
  const req = {};
  const res = createRes();

  rootHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'PDF Converter Backend is Running!');
});

test('POST /convert handler requires uploaded file', () => {
  const req = { body: {} };
  const res = createRes();

  convertHandler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body, 'No file uploaded.');
});

test('POST /compress handler requires uploaded file', () => {
  const req = { body: {} };
  const res = createRes();

  compressHandler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body, 'No file uploaded.');
});

test('POST /extract handler requires uploaded file', () => {
  const req = { body: {} };
  const res = createRes();

  extractHandler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body, 'No file uploaded.');
});

test('POST /unlock handler requires uploaded file', () => {
  const req = { body: {} };
  const res = createRes();

  unlockHandler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body, 'No file uploaded.');
});

test('POST /unlock handler requires password when file exists', () => {
  const req = {
    file: { path: '/tmp/not-present.pdf', filename: 'fake' },
    body: {},
  };
  const res = createRes();

  unlockHandler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body, 'Password is required.');
});
