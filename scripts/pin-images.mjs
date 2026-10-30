#!/usr/bin/env node
/**
 * Resolves mutable image tags to registry manifest digests before production
 * startup. This keeps the production preflight strict without requiring an
 * operator to copy digests manually or downloading every language image.
 *
 * The egress setup starts the loopback-only Docker registry proxy on 3130.
 * Registry metadata is resolved through that allowlisted proxy; no image layers
 * are pulled by this script.
 */
import {
  chmodSync,
  chownSync,
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

import { DEFAULT_CONTAINER_IMAGES } from '../server/containers.js';
import { parseDotenv } from '../server/util.js';

const PROXY = 'http://127.0.0.1:3130';
const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');
const IMAGE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}(:[A-Za-z0-9._-]{1,60})?(@sha256:[a-f0-9]{64})?$/;

const curl = (args, { fail = false } = {}) => {
  const result = spawnSync(
    'curl',
    [
      '--silent',
      '--show-error',
      '--proxy',
      PROXY,
      ...(fail ? ['--fail'] : []),
      ...args,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      env: { ...process.env, NO_PROXY: '', no_proxy: '' },
    },
  );
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr ?? '').trim();
    throw new Error(
      'Registry-Anfrage fehlgeschlagen' + (detail ? ': ' + detail : ''),
    );
  }
  return result.stdout;
};

const registryParts = (input) => {
  const reference = String(input ?? '').trim();
  if (!IMAGE_PATTERN.test(reference))
    throw new Error('Ungültige Image-Referenz: ' + (reference || '(leer)'));
  if (/@sha256:[a-f0-9]{64}$/.test(reference))
    return { reference, pinned: true };

  const slash = reference.indexOf('/');
  const first = slash >= 0 ? reference.slice(0, slash) : '';
  const hasRegistry =
    slash >= 0 &&
    (first.includes('.') || first.includes(':') || first === 'localhost');
  const registry =
    hasRegistry && first !== 'docker.io' ? first : 'registry-1.docker.io';
  let remote = hasRegistry ? reference.slice(slash + 1) : reference;
  if (!hasRegistry && !remote.includes('/')) remote = 'library/' + remote;

  const lastSlash = remote.lastIndexOf('/');
  const colon = remote.lastIndexOf(':');
  const hasTag = colon > lastSlash;
  const tag = hasTag ? remote.slice(colon + 1) : 'latest';
  const repository = hasTag ? remote.slice(0, colon) : remote;
  if (!repository || !tag)
    throw new Error('Image-Referenz ist unvollständig: ' + reference);
  return { reference, registry, repository, tag, pinned: false };
};

const statusOf = (headers) => {
  const statuses = [...String(headers).matchAll(/^HTTP\/\S+\s+(\d{3})/gim)];
  return statuses.length ? Number(statuses.at(-1)[1]) : 0;
};

const headerValue = (headers, name) => {
  const match = String(headers).match(
    new RegExp('^' + name + ':\\s*(.*?)\\s*$', 'im'),
  );
  return match?.[1] ?? '';
};

const requestManifestHeaders = (url, token = '') =>
  curl([
    '--dump-header',
    '-',
    '--output',
    '/dev/null',
    '--head',
    '--header',
    'Accept: ' + ACCEPT,
    ...(token ? ['--header', 'Authorization: Bearer ' + token] : []),
    url,
  ]);

const tokenFromChallenge = (challenge, repository) => {
  if (!/^Bearer\s+/i.test(challenge))
    throw new Error(
      'Registry verwendet eine nicht unterstützte Authentisierung',
    );
  const field = (name) =>
    new RegExp(name + '="([^"]+)"', 'i').exec(challenge)?.[1] ?? '';
  const realm = field('realm');
  const service = field('service');
  const scope = field('scope') || 'repository:' + repository + ':pull';
  if (!realm || !/^https:\/\//i.test(realm) || !service)
    throw new Error(
      'Registry lieferte eine ungültige Authentisierungs-Challenge',
    );
  const url = new URL(realm);
  url.searchParams.set('service', service);
  url.searchParams.set('scope', scope);
  const raw = curl([url.toString()], { fail: true });
  const parsed = JSON.parse(raw);
  const token = parsed.token ?? parsed.access_token;
  if (typeof token !== 'string' || !token)
    throw new Error('Registry lieferte kein Zugriffstoken');
  return token;
};

export const resolveImageDigest = (input) => {
  const parsed = registryParts(input);
  if (parsed.pinned) return parsed.reference;
  const url =
    'https://' +
    parsed.registry +
    '/v2/' +
    parsed.repository +
    '/manifests/' +
    encodeURIComponent(parsed.tag);
  let headers = requestManifestHeaders(url);
  let status = statusOf(headers);
  if (status === 401) {
    const challenge = headerValue(headers, 'www-authenticate');
    const token = tokenFromChallenge(challenge, parsed.repository);
    headers = requestManifestHeaders(url, token);
    status = statusOf(headers);
  }
  if (status !== 200)
    throw new Error(
      'Registry-Prüfung für ' +
        parsed.reference +
        ' endete mit HTTP ' +
        (status || 'unbekannt'),
    );
  const digest = headerValue(headers, 'docker-content-digest');
  if (!/^sha256:[a-f0-9]{64}$/.test(digest))
    throw new Error(
      'Registry lieferte keinen gültigen SHA-256-Digest für ' +
        parsed.reference,
    );
  return parsed.reference + '@' + digest;
};

const upsertEnvironment = (path, original, changes) => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(
      '.env muss eine reguläre Datei und darf kein Symlink sein.',
    );
  const keys = new Set(Object.keys(changes));
  const kept = String(original)
    .split(/\r?\n/)
    .filter((line) => {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      return !match || !keys.has(match[1]);
    });
  const assignments = Object.entries(changes).map(
    ([key, value]) => key + "='" + value + "'",
  );
  const next = [...kept, ...assignments].join('\n').replace(/\n*$/, '\n');
  const temporary = dirname(path) + '/.env.pin-' + randomUUID();
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, next, 'utf8');
    closeSync(fd);
    fd = undefined;
    const currentUid = process.getuid?.();
    const currentGid = process.getgid?.();
    if (
      currentUid === 0 ||
      stat.uid !== currentUid ||
      stat.gid !== currentGid
    )
      chownSync(temporary, stat.uid, stat.gid);
    chmodSync(temporary, stat.mode & 0o777);
    renameSync(temporary, path);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      /* Keep the original failure. */
    }
    throw error;
  }
};

const main = () => {
  if (
    typeof process.getuid === 'function' &&
    process.getuid() !== 0
  ) {
    const path = resolve(process.argv[2] ?? '.env');
    const stat = lstatSync(path);
    if (stat.uid !== process.getuid())
      throw new Error('Die .env muss root-eigen sein oder dem aufrufenden Benutzer gehören.');
  }
  const envPath = resolve(process.argv[2] ?? '.env');
  const original = readFileSync(envPath, 'utf8');
  const env = parseDotenv(original);
  let configured = {};
  if (env.BOT_HUB_CONTAINER_IMAGES) {
    try {
      configured = JSON.parse(env.BOT_HUB_CONTAINER_IMAGES);
    } catch {
      throw new Error('BOT_HUB_CONTAINER_IMAGES ist kein gültiges JSON.');
    }
    if (
      !configured ||
      Array.isArray(configured) ||
      typeof configured !== 'object'
    )
      throw new Error('BOT_HUB_CONTAINER_IMAGES muss ein JSON-Objekt sein.');
  }

  const selected = { ...DEFAULT_CONTAINER_IMAGES };
  for (const [key, value] of Object.entries(configured)) {
    if (!(key in DEFAULT_CONTAINER_IMAGES)) continue;
    if (typeof value !== 'string' || !IMAGE_PATTERN.test(value.trim()))
      throw new Error(
        'BOT_HUB_CONTAINER_IMAGES.' +
          key +
          ' ist keine gültige Image-Referenz.',
      );
    selected[key] = value.trim();
  }

  const cache = new Map();
  const pinned = {};
  for (const [key, reference] of Object.entries(selected)) {
    if (!cache.has(reference))
      cache.set(reference, resolveImageDigest(reference));
    pinned[key] = cache.get(reference);
  }

  const changes = {
    BOT_HUB_CONTAINER_IMAGES: JSON.stringify(pinned),
  };
  const database = String(env.BOT_HUB_DB ?? 'sqlite')
    .trim()
    .toLowerCase();
  if (database === 'mysql-container') {
    const mysql = String(env.BOT_HUB_MYSQL_IMAGE ?? '').trim() || 'mysql:8.4';
    changes.BOT_HUB_MYSQL_IMAGE = resolveImageDigest(mysql);
    const phpmyadmin = ['1', 'true', 'ja', 'yes'].includes(
      String(env.BOT_HUB_PHPMYADMIN ?? '')
        .trim()
        .toLowerCase(),
    );
    if (phpmyadmin) {
      const image =
        String(env.BOT_HUB_PHPMYADMIN_IMAGE ?? '').trim() ||
        'phpmyadmin/phpmyadmin:5.2.3';
      changes.BOT_HUB_PHPMYADMIN_IMAGE = resolveImageDigest(image);
    }
  }

  upsertEnvironment(envPath, original, changes);
  console.log(
    '[bot-hub] Image-Digests fixiert: ' +
      Object.keys(pinned).join(', ') +
      (changes.BOT_HUB_MYSQL_IMAGE ? ', mysql' : '') +
      (changes.BOT_HUB_PHPMYADMIN_IMAGE ? ', phpMyAdmin' : ''),
  );
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.dirname, 'pin-images.mjs')
) {
  try {
    main();
  } catch (error) {
    console.error('[bot-hub] Image-Pinning fehlgeschlagen: ' + error.message);
    process.exitCode = 1;
  }
}
