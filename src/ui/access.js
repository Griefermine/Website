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
  'access.manage': 'Zugriffsrechte verwalten',
};
const roleLabels = {
  owner: 'Eigentümer',
  admin: 'Administrator',
  operator: 'Operator',
  viewer: 'Nur lesen',
};
const roleLevel = { viewer: 1, operator: 2, admin: 3, owner: 4 };

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
    const data = await api.access();
    clear(body).append(
      el(
        'p',
        { class: 'panel__text' },
        'Lege für jeden angemeldeten Discord-Nutzer eine Rolle oder individuelle Rechte fest.',
      ),
      ...data.users.map((user) => {
        const editable =
          roleLevel[data.role] > (roleLevel[user.role] ?? 0) &&
          user.role !== 'owner';
        const role = el(
          'select',
          { class: 'input', name: 'role', disabled: !editable },
          ...Object.keys(data.roles)
            .filter((value) => value !== 'owner' || user.role === 'owner')
            .map((value) =>
              el(
                'option',
                { value, selected: value === user.role },
                roleLabels[value] ?? value,
              ),
            ),
        );
        const checks = el(
          'div',
          { class: 'form__grid' },
          ...Object.keys(labels).map((permission) =>
            el(
              'label',
              { class: 'field' },
              el(
                'span',
                { class: 'field__label' },
                el('input', {
                  type: 'checkbox',
                  value: permission,
                  checked: user.permissions.includes(permission),
                  disabled: !editable,
                }),
                ` ${labels[permission]}`,
              ),
            ),
          ),
        );
        const card = el(
          'section',
          { class: 'panel access-user' },
          el('strong', {}, user.name || user.username || user.id),
          el('span', { class: 'field__hint' }, `Discord-ID: ${user.id}`),
          role,
          checks,
          el(
            'button',
            {
              class: 'btn btn--primary btn--sm',
              type: 'button',
              disabled: !editable,
              onclick: async () => {
                const permissions = [
                  ...checks.querySelectorAll('input:checked'),
                ].map((input) => input.value);
                try {
                  await api.updateAccess(user.id, {
                    role: role.value,
                    permissions,
                  });
                  toast('Zugriffsrechte gespeichert', 'success');
                } catch (error) {
                  toast(error.message, 'error');
                }
              },
            },
            'Speichern',
          ),
          el(
            'button',
            {
              class: 'btn btn--danger btn--sm',
              type: 'button',
              disabled: !editable,
              onclick: async () => {
                if (!confirm(`Zugriff für ${user.name || user.id} entfernen?`))
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
          ),
        );
        role.addEventListener('change', () => {
          const defaults = data.roles[role.value] ?? [];
          for (const input of checks.querySelectorAll('input'))
            input.checked = defaults.includes(input.value);
        });
        return card;
      }),
    );
  } catch (error) {
    clear(body).append(el('p', { class: 'note__error' }, error.message));
  }
};
