const MAX_LINES = 600;

const state = {
  bots: [],
  languages: [],
  logs: [],
  connected: false,
  filter: 'all',
  query: '',
  selectedBotId: null,
  logLevelFilter: 'all',
};

const subscribers = new Set();

export const getState = () => state;

export const subscribe = (fn) => {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
};

const notify = () => {
  for (const fn of subscribers) fn(state);
};

export const setState = (patch) => {
  Object.assign(state, patch);
  notify();
};

export const upsertBot = (bot) => {
  const index = state.bots.findIndex((item) => item.id === bot.id);
  if (index === -1) {
    state.bots = [bot, ...state.bots];
  } else {
    state.bots[index] = { ...state.bots[index], ...bot };
  }
  if (!state.selectedBotId && state.bots.length)
    state.selectedBotId = state.bots[0].id;
  notify();
};

export const removeBot = (id) => {
  state.bots = state.bots.filter((bot) => bot.id !== id);
  state.logs = state.logs.filter((line) => line.botId !== id);
  if (state.selectedBotId === id)
    state.selectedBotId = state.bots[0]?.id ?? null;
  notify();
};

export const prependLogs = (lines) => {
  if (!lines?.length) return;
  const known = new Set(state.logs.map((line) => line.id));
  const fresh = lines.filter((line) => !known.has(line.id));
  state.logs = [...fresh, ...state.logs].slice(0, MAX_LINES);
  notify();
};

export const clearLogs = () => {
  state.logs = [];
  notify();
};

export const visibleBots = () => {
  const query = state.query.trim().toLowerCase();
  return state.bots.filter((bot) => {
    const matchesStatus = state.filter === 'all' || bot.status === state.filter;
    const matchesQuery =
      !query ||
      [bot.name, bot.language, bot.framework, bot.description]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(query));
    return matchesStatus && matchesQuery;
  });
};

export const visibleLogs = () =>
  state.logs.filter((line) => {
    if (state.logLevelFilter !== 'all' && line.level !== state.logLevelFilter)
      return false;
    if (state.selectedBotId && line.botId !== state.selectedBotId) return false;
    return true;
  });

export const stats = () => {
  const total = state.bots.length;
  const running = state.bots.filter((bot) => bot.status === 'running').length;
  const languages = new Set(state.bots.map((bot) => bot.language)).size;
  const errors = state.logs.filter((line) => line.level === 'error').length;
  return { total, running, stopped: total - running, languages, errors };
};
