import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { after, describe, it } from 'node:test';
import {
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from 'undici';
import { configureProductionEgress } from '../server/egress.js';

describe('Produktions-Ausgangsproxy', () => {
  const originalHttpAgent = http.globalAgent;
  const originalHttpsAgent = https.globalAgent;
  const originalDispatcher = getGlobalDispatcher();
  const originalFetch = globalThis.fetch;
  const originalEnv = Object.fromEntries(
    [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'http_proxy',
      'https_proxy',
      'NO_PROXY',
      'no_proxy',
      'NODE_USE_ENV_PROXY',
    ].map((key) => [key, process.env[key]]),
  );
  let dispatcher;

  after(async () => {
    http.globalAgent.destroy();
    https.globalAgent.destroy();
    http.globalAgent = originalHttpAgent;
    https.globalAgent = originalHttpsAgent;
    globalThis.fetch = originalFetch;
    setGlobalDispatcher(originalDispatcher);
    await dispatcher?.close();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('konfiguriert node:http, node:https und Fetch auf denselben Loopback-Proxy', () => {
    dispatcher = configureProductionEgress();

    assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:3129');
    assert.equal(process.env.HTTPS_PROXY, 'http://127.0.0.1:3129');
    assert.equal(process.env.NO_PROXY, 'localhost,127.0.0.1,::1');
    assert.equal(process.env.NODE_USE_ENV_PROXY, '1');
    assert.equal(http.globalAgent.options.proxyEnv, process.env);
    assert.equal(https.globalAgent.options.proxyEnv, process.env);
    assert.ok(getGlobalDispatcher() instanceof EnvHttpProxyAgent);
    assert.equal(globalThis.fetch, undiciFetch);
  });
});
