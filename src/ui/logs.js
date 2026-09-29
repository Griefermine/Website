import { el, clear, time } from './dom.js';
import { getState, visibleLogs } from '../state.js';

export const renderLogs = () => {
  const host = document.getElementById('log-view');
  if (!host) return;
  const state = getState();
  const lines = visibleLogs();
  const bot = state.bots.find((item) => item.id === state.selectedBotId);
  const counter = document.getElementById('log-source');
  if (counter)
    counter.textContent = bot ? `${bot.emoji} ${bot.name}` : 'Alle Bots';

  const pinned = host.scrollTop + host.clientHeight >= host.scrollHeight - 40;
  clear(host);
  for (const line of lines) {
    const owner = state.bots.find((item) => item.id === line.botId);
    host.append(
      el(
        'div',
        { class: `log-line log-line--${line.level}` },
        el('time', { class: 'log-line__time' }, time(line.ts)),
        state.selectedBotId
          ? null
          : el('span', { class: 'log-line__bot' }, owner?.name ?? 'unbekannt'),
        el('span', { class: 'log-line__text' }, line.text),
      ),
    );
  }
  if (!lines.length) {
    host.append(
      el(
        'p',
        { class: 'log-empty' },
        'Noch keine Log-Ausgaben. Starte einen Bot, um Live-Logs zu sehen.',
      ),
    );
  }
  if (pinned) host.scrollTop = host.scrollHeight;
};
