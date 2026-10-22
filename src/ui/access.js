import { api } from '../api.js';
import { el, clear } from './dom.js';
import { toast } from './toast.js';

const labels = {
  'bots.read': 'Bots ansehen',
  'bots.manage': 'Bots anlegen und bearbeiten',
  'bots.control': 'Bots starten und stoppen',
  'bots.delete': 'Bots löschen',
  'bots.restart': 'Bots neustarten',
  'logs.read': 'Logs ansehen',
  'panel.read': 'Bot-Seiten ansehen',
  'panel.manage': 'Bot-Seiten verwalten',
  'access.manage': 'Zugriffsrechte verwalten',
  'files.read': 'Dateien ansehen',
  'files.write': 'Dateien bearbeiten',
  'files.upload': 'Dateien hochladen',
  'files.delete': 'Dateien löschen',
};

const roleLabels = {
  owner: 'Eigentümer',
  admin: 'Administrator',
  operator: 'Operator',
  viewer: 'Nur lesen',
};

const roleLevel = { viewer: 1, operator: 2, admin: 3, owner: 4 };

const filePermissionKeys = [
  'files.read',
  'files.write',
  'files.upload',
  'files.delete',
];

export const openAccess = async () => {
  const dialog = el('dialog', { class: 'modal' });
  document.body.append(dialog);

  const body = el(
    'div',
    { class: 'modal__body' },
    el('p', {}, 'Lade Benutzer …'),
  );

  dialog.append(
    el('header', { class: 'modal__head' }, el('h2', {}, 'Zugriffsrechte')),
    body,
    el(
      'footer',
      { class: 'modal__foot' },
      el(
        'button',
        {
          class: 'btn btn--ghost',
          type: 'button',
          onclick: () => dialog.close(),
        },
        'Schließen',
      ),
    ),
  );

  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();

  try {
    const [accessData, botsData] = await Promise.all([
      api.access(),
      api.list(),
    ]);

    const users = accessData.users ?? [];
    const roles = accessData.roles ?? {};
    const bots = botsData.bots ?? [];
    const botMap = new Map(bots.map((bot) => [bot.id, bot]));

    clear(body).append(
      el(
        'p',
        { class: 'panel__text' },
        'Lege für jeden Benutzer eine Rolle, globale Rechte oder bot-spezifische Dateirechte fest.',
      ),
    );

    for (const user of users) {
      const editable =
        roleLevel[accessData.role] > (roleLevel[user.role] ?? 0) &&
        user.role !== 'owner';

      const roleSelect = el(
        'select',
        { class: 'input', disabled: !editable },
        ...Object.keys(roles)
          .filter((value) => value !== 'owner' || user.role === 'owner')
          .map((value) =>
            el(
              'option',
              { value, selected: value === user.role },
              roleLabels[value] ?? value,
            ),
          ),
      );

      const globalPerms = el('div', { class: 'form__grid' });
      for (const permission of Object.keys(labels)) {
        if (permission.startsWith('files.')) continue;
        const allowed = new Set(roles[user.role] ?? []);
        const input = el('input', {
          type: 'checkbox',
          value: permission,
          checked: (user.permissions ?? []).includes(permission),
          disabled: !editable || !allowed.has(permission),
        });
        globalPerms.append(
          el(
            'label',
            { class: 'field' },
            el(
              'span',
              { class: 'field__label' },
              input,
              ` ${labels[permission]}`,
            ),
          ),
        );
      }

      const botPermsWrap = el('div', { class: 'access-bot-perms' });
      const botAddRow = el('div', { class: 'access-bot-add' });

      const botSelect = el('select', { class: 'input', disabled: !editable });
      botSelect.append(el('option', { value: '' }, 'Bot auswählen …'));

      const addBtn = el(
        'button',
        {
          class: 'btn btn--ghost',
          type: 'button',
          disabled: true,
          onclick: () => {
            if (!editable) return;
            const bid = botSelect.value;
            if (!bid) return;
            const userBots =
              user.bots && typeof user.bots === 'object' ? user.bots : {};
            user.bots = { ...userBots, [bid]: { permissions: [] } };
            renderBotList();
            renderBotBlocks();
          },
        },
        'Bot hinzufügen',
      );

      botSelect.onchange = () => {
        addBtn.disabled = !botSelect.value || !editable;
      };

      botAddRow.append(botSelect, addBtn);

      const renderBotList = () => {
        const userBots =
          user.bots && typeof user.bots === 'object' ? user.bots : {};
        clear(botSelect);
        botSelect.append(el('option', { value: '' }, 'Bot auswählen …'));
        for (const bot of bots) {
          if (userBots[bot.id]) continue;
          const label = bot.name ? `${bot.name} (${bot.id})` : bot.id;
          botSelect.append(el('option', { value: bot.id }, label));
        }
        addBtn.disabled = !botSelect.value || !editable;
      };

      const renderBotBlocks = () => {
        clear(botPermsWrap);
        const userBots =
          user.bots && typeof user.bots === 'object' ? user.bots : {};
        const entries = Object.entries(userBots);
        if (entries.length === 0) {
          botPermsWrap.append(
            el(
              'p',
              { class: 'access-empty' },
              'Noch keine bot-spezifischen Rechte vergeben.',
            ),
          );
          return;
        }
        const allowedRole = new Set(roles[roleSelect.value] ?? []);
        for (const [botId, cfg] of entries) {
          const bot = botMap.get(botId);
          const botLabel = bot?.name ? `${bot.name} (${botId})` : botId;
          const perms = Array.isArray(cfg?.permissions) ? cfg.permissions : [];
          const block = el('div', { class: 'access-bot-block' });
          const head = el(
            'div',
            { class: 'access-bot-block__head' },
            el('h4', {}, botLabel),
            el(
              'button',
              {
                class: 'btn btn--ghost btn--small',
                type: 'button',
                disabled: !editable,
                onclick: () => {
                  if (!editable) return;
                  const next = { ...userBots };
                  delete next[botId];
                  user.bots = next;
                  renderBotList();
                  renderBotBlocks();
                },
              },
              'Entfernen',
            ),
          );
          const grid = el('div', { class: 'access-perms' });
          for (const key of filePermissionKeys) {
            const input = el('input', {
              type: 'checkbox',
              value: key,
              'data-bot-id': botId,
              checked: perms.includes(key),
              disabled: !editable || !allowedRole.has(key),
            });
            grid.append(
              el(
                'label',
                { class: 'checkbox' },
                input,
                el('span', {}, labels[key]),
              ),
            );
          }
          block.append(head, grid);
          botPermsWrap.append(block);
        }
      };

      const applyRoleDefaults = () => {
        const allowed = new Set(roles[roleSelect.value] ?? []);
        for (const input of globalPerms.querySelectorAll(
          'input[type="checkbox"]',
        )) {
          input.disabled = !editable || !allowed.has(input.value);
          if (!allowed.has(input.value)) input.checked = false;
        }
        botPermsWrap
          .querySelectorAll('input[type="checkbox"]')
          .forEach((input) => {
            input.disabled = !editable || !allowed.has(input.value);
            if (!allowed.has(input.value)) input.checked = false;
          });
      };

      roleSelect.addEventListener('change', applyRoleDefaults);

      renderBotList();
      renderBotBlocks();
      applyRoleDefaults();

      const saveBtn = el(
        'button',
        {
          class: 'btn btn--primary btn--sm',
          type: 'button',
          disabled: !editable,
          onclick: async () => {
            const role = roleSelect.value;
            const allowed = new Set(roles[role] ?? []);
            const perms = [];
            for (const input of globalPerms.querySelectorAll(
              'input[type="checkbox"]:checked',
            )) {
              if (allowed.has(input.value)) perms.push(input.value);
            }
            const botsPatch = {};
            botPermsWrap
              .querySelectorAll('.access-bot-block')
              .forEach((block) => {
                const inputs = block.querySelectorAll('input[type="checkbox"]');
                if (inputs.length === 0) return;
                const first = inputs[0];
                const bid = first?.dataset.botId;
                if (!bid) return;
                const list = [];
                for (const cb of inputs) {
                  if (cb.checked && allowed.has(cb.value)) list.push(cb.value);
                }
                botsPatch[bid] = { permissions: [...new Set(list)] };
              });
            try {
              await api.updateAccess(user.id, {
                role,
                permissions: perms,
                bots: botsPatch,
              });
              toast('Zugriffsrechte gespeichert', 'success');
            } catch (error) {
              toast(error.message, 'error');
            }
          },
        },
        'Speichern',
      );

      const removeBtn = el(
        'button',
        {
          class: 'btn btn--danger btn--sm',
          type: 'button',
          disabled: !editable,
          onclick: async () => {
            if (
              !confirm(
                `Zugriff für ${
                  user.name || user.username || user.id
                } entfernen?`,
              )
            )
              return;
            try {
              await api.removeAccess(user.id);
              card.remove();
              toast('Zugriff entfernt', 'success');
            } catch (error) {
              toast(error.message, 'error');
            }
          },
        },
        'Zugriff entfernen',
      );

      const card = el(
        'section',
        { class: 'panel access-user' },
        el('strong', {}, user.name || user.username || user.id),
        el('span', { class: 'field__hint' }, `Discord-ID: ${user.id}`),
        el(
          'div',
          { class: 'form__group' },
          el('label', { class: 'field__label' }, 'Rolle'),
          roleSelect,
        ),
        el('h4', { class: 'access-subtitle' }, 'Globale Berechtigungen'),
        globalPerms,
        el(
          'h4',
          { class: 'access-subtitle' },
          'Bot-spezifische Berechtigungen',
        ),
        botPermsWrap,
        botAddRow,
        el('div', { class: 'access-actions' }, saveBtn, removeBtn),
      );

      body.append(card);
    }
  } catch (error) {
    clear(body).append(el('p', { class: 'note__error' }, error.message));
  }
};
