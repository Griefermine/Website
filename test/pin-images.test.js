import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');

test('the digest pinning script resolves registry references and preserves .env', () => {
  const temp = mkdtempSync(join(tmpdir(), 'bot-hub-pinning-'));
  try {
    const bin = join(temp, 'bin');
    const envPath = join(temp, '.env');
    const curlPath = join(bin, 'curl');
    const envContent = [
      'BOT_HUB_URL=https://hub.example',
      'BOT_HUB_CONTAINER_IMAGES=\'{"python":"python:3.12-bookworm"}\'',
      'OTHER_VALUE=keep',
      '',
    ].join('\n');
    const fakeCurl = [
      '#!/bin/sh',
      'case " $* " in',
      '  *auth.docker.io/token?*)',
      '    printf \'%s\\n\' \'{"token":"fixture-token"}\'',
      '    ;;',
      '  *Authorization*fixture-token*)',
      "    printf '%s\\n' 'HTTP/1.1 200 OK' 'Docker-Content-Digest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ''",
      '    ;;',
      '  *)',
      "    printf '%s\\n' 'HTTP/1.1 401 Unauthorized' 'WWW-Authenticate: ***"https://auth.docker.io/token\",service=\"registry.docker.io\",scope=\"repository:library/fake:pull\"' ''",
      '    ;;',
      'esac',
      '',
    ].join('\n');

    mkdirSync(bin, { mode: 0o700 });
    writeFileSync(curlPath, fakeCurl, { mode: 0o755 });
    chmodSync(curlPath, 0o755);
    writeFileSync(envPath, envContent, { mode: 0o640 });

    execFileSync(
      process.execPath,
      [join(ROOT, 'scripts', 'pin-images.mjs'), envPath],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: bin + ':' + process.env.PATH,
        },
      },
    );

    const updated = readFileSync(envPath, 'utf8');
    const match = /^BOT_HUB_CONTAINER_IMAGES='(.+)'$/m.exec(updated);
    assert.ok(match, 'The pinned image object must be stored in .env.');
    const pinned = JSON.parse(match[1]);
    assert.equal(Object.keys(pinned).length, 9);
    for (const reference of Object.values(pinned))
      assert.match(reference, /@sha256:[a-f0-9]{64}$/);
    assert.ok(updated.includes('BOT_HUB_URL=https://hub.example'));
    assert.match(updated, /OTHER_VALUE=keep/);
    assert.equal(
      (updated.match(/^BOT_HUB_CONTAINER_IMAGES=/gm) ?? []).length,
      1,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
