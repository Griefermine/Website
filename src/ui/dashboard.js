import { el, clear, uptime } from './dom.js';
import { getState, visibleBots, stats } from '../state.js';

const STATUS_META = {
  running: { label: 'Läuft', tone: 'ok' },
  checking: { label: 'Prüfe Libs', tone: 'warn' },
  installing: { label: 'Installiert', tone: 'warn' },
  restarting: { label: 'Startet neu', tone: 'warn' },
  stopped: { label: 'Gestoppt', tone: 'idle' },
  crashed: { label: 'Abgestürzt', tone: 'danger' },
  error: { label: 'Fehler', tone: 'danger' },
};

const DEPS_META = {
  ready: { label: 'Libs ok', tone: 'ok' },
  checking: { label: 'Prüfe…', tone: 'warn' },
  installing: { label: 'Installation läuft', tone: 'warn' },
  missing: { label: 'Lib fehlt', tone: 'danger' },
  failed: { label: 'Installation fehlgeschlagen', tone: 'danger' },
  unknown: { label: 'Libs ungeprüft', tone: 'idle' },
};

const BUSY = new Set(['checking', 'installing', 'restarting']);
const can = (permissions, permission) => permissions.includes(permission);

const statCard = (label, value, hint, tone = '') =>
  el(
    'article',
    { class: `stat ${tone ? `stat--${tone}` : ''}` },
    el('span', { class: 'stat__value' }, value),
    el('span', { class: 'stat__label' }, label),
    el('span', { class: 'stat__hint' }, hint),
  );

const botCard = (bot, language, selected) => {
  const status = STATUS_META[bot.status] ?? STATUS_META.stopped;
  const deps = DEPS_META[bot.depsStatus] ?? DEPS_META.unknown;
  const busy = BUSY.has(bot.status);
  const permissions = getState().permissions;
  return el(
    'article',
    {
      class: `bot-card tone-${status.tone}${selected ? ' is-selected' : ''}`,
      dataset: { id: bot.id, status: bot.status },
    },
    el(
      'header',
      { class: 'bot-card__head' },
      el('span', { class: 'bot-card__emoji' }, bot.emoji),
      el(
        'div',
        { class: 'bot-card__title' },
        el('strong', {}, bot.name),
        el(
          'span',
          { class: 'bot-card__framework' },
          bot.framework || 'ohne Library',
        ),
      ),
      el(
        'div',
        { class: 'bot-card__pills' },
        deps.tone === 'idle'
          ? null
          : el('span', { class: `pill pill--${deps.tone}` }, deps.label),
        el('span', { class: `pill pill--${status.tone}` }, status.label),
      ),
    ),
    bot.description
      ? el('p', { class: 'bot-card__desc' }, bot.description)
      : null,
    bot.panel?.available && can(permissions, 'panel.read')
      ? el(
          'button',
          {
            class: 'bot-card__page',
            type: 'button',
            dataset: { action: 'panel', id: bot.id },
            title: 'Eigene Seite des Bots öffnen',
          },
          `${bot.panel.icon} ${bot.panel.title || 'Eigene Seite'}`,
        )
      : null,
    el(
      'div',
      { class: 'bot-card__meta' },
      el(
        'span',
        {
          class: 'tag',
          style: { '--tag-color': language?.color ?? '#8b949e' },
        },
        language?.label ?? bot.language,
      ),
      el(
        'span',
        { class: 'bot-card__deps' },
        `📦 ${bot.framework || 'ohne Library'}`,
      ),
      el(
        'code',
        { class: 'bot-card__cmd', title: bot.commandResolved || bot.command },
        bot.commandResolved || bot.command,
      ),
    ),
    el(
      'dl',
      { class: 'bot-card__stats' },
      el(
        'div',
        {},
        el('dt', {}, 'Laufzeit'),
        el('dd', {}, bot.status === 'running' ? uptime(bot.startedAt) : '–'),
      ),
      el('div', {}, el('dt', {}, 'PID'), el('dd', {}, bot.pid ?? '–')),
      el(
        'div',
        {},
        el('dt', {}, 'Neustarts'),
        el('dd', {}, bot.restartCount ?? 0),
      ),
      el('div', {}, el('dt', {}, 'Exit'), el('dd', {}, bot.exitCode ?? '–')),
    ),
    el(
      'footer',
      { class: 'bot-card__actions' },
      can(permissions, 'bots.control')
        ? el(
            'button',
            {
              class: `btn btn--sm ${bot.status === 'running' ? 'btn--danger' : 'btn--primary'}`,
              dataset: { action: 'toggle', id: bot.id },
            },
            bot.status === 'running' ? 'Stoppen' : 'Starten',
          )
        : null,
      language?.check && can(permissions, 'bots.manage')
        ? el(
            'button',
            {
              class: 'btn btn--sm btn--ghost',
              dataset: { action: 'install', id: bot.id },
              disabled: busy,
            },
            'Libs installieren',
          )
        : null,
      can(permissions, 'bots.restart')
        ? el(
            'button',
            {
              class: 'btn btn--sm btn--ghost',
              dataset: { action: 'restart', id: bot.id },
            },
            'Neustart',
          )
        : null,
      can(permissions, 'logs.read')
        ? el(
            'button',
            {
              class: 'btn btn--sm btn--ghost',
              dataset: { action: 'logs', id: bot.id },
            },
            'Logs',
          )
        : null,
      can(permissions, 'panel.read')
        ? el(
            'button',
            {
              class: 'btn btn--sm btn--ghost',
              dataset: { action: 'panel', id: bot.id },
            },
            'Eigene Seite',
          )
        : null,
      can(permissions, 'bots.manage')
        ? el(
            'button',
            {
              class: 'btn btn--sm btn--ghost',
              dataset: { action: 'edit', id: bot.id },
            },
            'Bearbeiten',
          )
        : null,
      can(permissions, 'bots.delete')
        ? el(
            'button',
            {
              class: 'btn btn--sm btn--ghost btn--danger-ghost',
              dataset: { action: 'delete', id: bot.id },
            },
            'Löschen',
          )
        : null,
    ),
  );
};

export const renderStats = () => {
  const host = document.getElementById('stats');
  if (!host) return;
  const { total, running, stopped, languages, errors } = stats();
  clear(host).append(
    statCard('Bots gesamt', total, `${languages} Sprache(n)`),
    statCard(
      'Aktiv',
      running,
      stopped ? `${stopped} gestoppt` : 'alles läuft',
      'ok',
    ),
    statCard('Sprachen', languages, 'Python · Java · JS · …'),
    statCard(
      'Log-Fehler',
      errors,
      errors ? 'in der Sitzung' : 'keine Fehler',
      errors ? 'danger' : '',
    ),
  );
};

export const renderBots = () => {
  const host = document.getElementById('bot-grid');
  const empty = document.getElementById('empty-state');
  if (!host) return;
  const state = getState();
  const bots = visibleBots();
  const languageById = new Map(
    state.languages.map((language) => [language.id, language]),
  );

  clear(host);
  for (const bot of bots) {
    host.append(
      botCard(
        bot,
        languageById.get(bot.language),
        state.selectedBotId === bot.id,
      ),
    );
  }
  if (empty) {
    empty.hidden =
      bots.length > 0 || !state.permissions.includes('bots.manage');
    const emptyButton = document.getElementById('empty-new-bot');
    if (emptyButton)
      emptyButton.hidden = !state.permissions.includes('bots.manage');
  }
};
