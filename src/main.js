import './styles.css';

import { api } from './api.js';
import {
  clearLogs,
  getState,
  prependLogs,
  removeBot,
  setState,
  subscribe,
  upsertBot,
} from './state.js';
import { renderBots, renderStats } from './ui/dashboard.js';
import { renderLogs } from './ui/logs.js';
import { openBotForm } from './ui/botForm.js';
import { openPanel } from './ui/panel.js';
import { openAccess } from './ui/access.js';
import { toast } from './ui/toast.js';

const $ = (selector) => document.querySelector(selector);

const withBusy = async (button, task) => {
  if (!button) return task();
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '…';
  try {
    return await task();
  } catch (error) {
    toast(error.message, 'error');
    return undefined;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
};

const run = (id, action, button) =>
  withBusy(button, async () => {
    const { bot } = await api[action](id);
    if (bot) upsertBot(bot);
    const checking = bot?.status === 'checking' || bot?.status === 'installing';
    const verb = {
      start: checking ? 'startet (prüft Bibliotheken)' : 'gestartet',
      stop: 'gestoppt',
      kill: 'abgeschossen',
      restart: 'neu gestartet',
    }[action];
    toast(`${bot?.name ?? 'Bot'} ${verb}`, 'success');
  });

const openForm = (bot) => {
  const state = getState();
  openBotForm({
    bot,
    languages: state.languages,
    onSubmit: async (config) => {
      try {
        const { bot: saved } = bot
          ? await api.update(bot.id, config)
          : await api.create(config);
        upsertBot(saved);
        if (bot) {
          toast('Bot aktualisiert', 'success');
          return;
        }
        // Nach dem Anlegen das Formular gleich wieder öffnen, diesmal im
        // Bearbeitungs-Modus: der Startordner ist beim Anlegen noch leer, und
        // ohne diesen Schritt wäre nicht zu sehen, wo die Dateien hingehören.
        toast(
          `${saved.name} angelegt – jetzt die Dateien hochladen`,
          'success',
        );
        openForm(saved);
      } catch (error) {
        toast(error.message, 'error');
      }
    },
  });
};

const wireControls = () => {
  $('#access').addEventListener('click', () => openAccess());
  $('#new-bot').addEventListener('click', () => openForm(null));
  $('#empty-new-bot').addEventListener('click', () => openForm(null));

  $('#search').addEventListener('input', (event) =>
    setState({ query: event.target.value }),
  );

  $('#filters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    setState({ filter: button.dataset.filter });
    for (const item of $('#filters').children) {
      item.classList.toggle('is-active', item === button);
    }
  });

  $('#bot-grid').addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const { action, id } = button.dataset;
    const state = getState();
    const bot = state.bots.find((item) => item.id === id);
    if (!bot) return;
    if (action === 'toggle')
      return run(id, bot.status === 'running' ? 'stop' : 'start', button);
    if (action === 'install')
      return withBusy(button, async () => {
        await api.install(id);
        upsertBot({ ...bot, status: 'checking', depsStatus: 'checking' });
        toast(`Installiere ${bot.framework} für ${bot.name} …`);
      });
    if (action === 'restart') return run(id, 'restart', button);
    if (action === 'panel') return openPanel(bot, getState().permissions);
    if (action === 'logs') {
      setState({ selectedBotId: state.selectedBotId === id ? null : id });
      document
        .getElementById('log-panel')
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return undefined;
    }
    if (action === 'edit') return openForm(bot);
    if (action === 'delete') {
      if (
        !confirm(
          // Der Startordner und der Workspace bleiben auf der Platte – wie
          // bisher. Wer sie mitnimmt, nimmt hochgeladene Quelldateien mit,
          // und das ist eine Entscheidung, die man nicht aus Versehen trifft.
          `"${bot.name}" wirklich löschen? Konfiguration und Logs gehen verloren. ` +
            'Die Dateien im Startordner bleiben liegen.',
        )
      )
        return undefined;
      return withBusy(button, async () => {
        await api.remove(id);
        removeBot(id);
        toast(`${bot.name} gelöscht`);
      });
    }
    return undefined;
  });

  $('#log-scope').addEventListener('change', (event) =>
    setState({ selectedBotId: event.target.value || null }),
  );
  $('#log-level').addEventListener('change', (event) =>
    setState({ logLevelFilter: event.target.value }),
  );
  $('#log-clear').addEventListener('click', () => clearLogs());

  $('#start-all').addEventListener('click', (event) =>
    withBusy(event.target, async () => {
      const stopped = getState().bots.filter((bot) => bot.status !== 'running');
      const results = await Promise.allSettled(
        stopped.map((bot) => api.start(bot.id)),
      );
      const ok = results.filter(
        (result) => result.status === 'fulfilled',
      ).length;
      toast(
        `${ok}/${stopped.length} Bot(s) gestartet`,
        ok ? 'success' : 'error',
      );
    }),
  );

  $('#stop-all').addEventListener('click', (event) =>
    withBusy(event.target, async () => {
      const running = getState().bots.filter((bot) => bot.status === 'running');
      const results = await Promise.allSettled(
        running.map((bot) => api.stop(bot.id)),
      );
      const ok = results.filter(
        (result) => result.status === 'fulfilled',
      ).length;
      toast(`${ok}/${running.length} Bot(s) gestoppt`, 'success');
    }),
  );
};

const renderScopeOptions = () => {
  const state = getState();
  const select = $('#log-scope');
  select.replaceChildren(
    new Option('Alle Bots', ''),
    ...state.bots.map((bot) => new Option(`${bot.emoji} ${bot.name}`, bot.id)),
  );
  select.value = state.selectedBotId ?? '';
};

const renderConnection = () => {
  const pill = $('#connection');
  const connected = getState().connected;
  pill.textContent = connected ? 'Verbunden' : 'Verbindung prüfen …';
  pill.className = `pill ${connected ? 'pill--ok' : 'pill--danger'}`;
};

const bootstrap = async () => {
  const select = $('#log-scope');
  subscribe((state) => {
    renderStats();
    renderBots();
    renderLogs();
    renderConnection();
    if (select.dataset.sig !== String(state.bots.length)) {
      renderScopeOptions();
      select.dataset.sig = String(state.bots.length);
    }
  });
  wireControls();

  try {
    const auth = await api.authSession();
    const accessButton = $('#access');
    accessButton.hidden =
      !auth.authenticated || !auth.permissions?.includes('access.manage');
    setState({ permissions: auth.permissions ?? [] });
    $('#new-bot').hidden = !auth.permissions?.includes('bots.manage');
    $('#start-all').hidden = !auth.permissions?.includes('bots.control');
    $('#stop-all').hidden = !auth.permissions?.includes('bots.control');
    $('#log-panel').hidden = !auth.permissions?.includes('logs.read');
    if (!auth.authenticated) {
      document.body.classList.add('auth-required');
      const account = $('#account');
      account.hidden = false;
      account.replaceChildren(
        Object.assign(document.createElement('a'), {
          className: 'btn btn--primary',
          href: '#',
          textContent: 'Mit Discord einloggen',
          title: auth.configured
            ? 'Mit deinem Discord-Konto anmelden'
            : 'DISCORD_CLIENT_ID und DISCORD_CLIENT_SECRET müssen serverseitig gesetzt werden',
        }),
      );
      account.querySelector('a').addEventListener('click', (event) => {
        event.preventDefault();
        api.authDiscordLogin();
      });
      toast(
        auth.configured
          ? 'Bitte zuerst mit Discord einloggen.'
          : 'Discord-Login ist noch nicht konfiguriert. Der Login-Button ist bereit.',
        'error',
      );
      return;
    }
    const account = $('#account');
    if (auth.authenticated) {
      account.hidden = false;
      account.replaceChildren(
        Object.assign(document.createElement('span'), {
          className: 'account__name',
          textContent: `${auth.user.name} ·`,
        }),
        Object.assign(document.createElement('button'), {
          className: 'btn btn--ghost btn--sm',
          type: 'button',
          textContent: 'Abmelden',
        }),
      );
      account.querySelector('button').addEventListener('click', async () => {
        await api.authLogout();
        location.reload();
      });
    }
    const [{ languages }, { bots }] = await Promise.all([
      api.languages(),
      api.list(),
    ]);
    setState({ languages });
    for (const bot of bots) upsertBot(bot);
    const { lines } = await api.logs(null, 200);
    prependLogs(lines.reverse());
  } catch (error) {
    toast(`Backend nicht erreichbar: ${error.message}`, 'error');
  }

  api.events((type, payload) => {
    if (type === 'snapshot') {
      setState({ connected: true });
      for (const bot of payload.bots) upsertBot(bot);
    } else if (type === 'created' || type === 'bot') {
      upsertBot(payload);
      if (type === 'created') toast(`${payload.name} hinzugefügt`, 'success');
    } else if (type === 'deleted') {
      removeBot(payload.id);
    } else if (type === 'log') {
      prependLogs([payload]);
    } else if (type === 'toast') {
      // Meldung, die der Bot selbst an das Dashboard geschickt hat.
      toast(`${payload.emoji ?? ''} ${payload.message}`.trim(), payload.kind);
    } else if (type === 'open') {
      setState({ connected: true });
    } else if (type === 'error') {
      setState({ connected: false });
    }
  });
  setInterval(() => renderStats(), 5000);
};

bootstrap();
