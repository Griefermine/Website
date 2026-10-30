import assert from 'node:assert/strict';
import test from 'node:test';

import { createInternalBotApiHandler } from '../server/internalApi.js';

const request = (url) => {
  const response = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
    },
    end(body = '') {
      this.body = body;
    },
  };
  return { req: { url }, res: response };
};

test('interner Listener lässt nur /api/hub und Unterpfade durch', () => {
  let calls = 0;
  const listener = createInternalBotApiHandler((_req, res) => {
    calls += 1;
    res.writeHead(200);
    res.end('runtime-api');
  });

  const allowed = request('/api/hub/db?bot=ignored');
  listener(allowed.req, allowed.res);
  assert.equal(allowed.res.status, 200);
  assert.equal(allowed.res.body, 'runtime-api');

  const root = request('/api/hub');
  listener(root.req, root.res);
  assert.equal(root.res.status, 200);

  for (const path of [
    '/api/auth',
    '/api/bots',
    '/api/access',
    '/api/hub-admin',
    '/dashboard',
    '//api/hub/db',
    '/%61pi/hub/db',
  ]) {
    const blocked = request(path);
    listener(blocked.req, blocked.res);
    assert.equal(blocked.res.status, 404, path);
  }

  assert.equal(calls, 2);
});

test('ungültiger URL-Pfad wird abgewiesen und nicht an den Hub-Handler gereicht', () => {
  let calls = 0;
  const listener = createInternalBotApiHandler(() => {
    calls += 1;
  });
  const invalid = request('http://[invalid');
  listener(invalid.req, invalid.res);
  assert.equal(invalid.res.status, 400);
  assert.equal(calls, 0);
});
