import { el } from './dom.js';

const hold = new Map();

export const toast = (message, kind = 'info') => {
  const host = document.getElementById('toasts');
  const node = el(
    'div',
    { class: `toast toast--${kind}` },
    el('span', {}, message),
  );
  host.append(node);
  requestAnimationFrame(() => node.classList.add('is-visible'));
  const hide = setTimeout(() => dismiss(node), kind === 'error' ? 6000 : 3200);
  hold.set(node, hide);
};

const dismiss = (node) => {
  clearTimeout(hold.get(node));
  node.classList.remove('is-visible');
  node.addEventListener('transitionend', () => node.remove(), { once: true });
  setTimeout(() => node.remove(), 400);
};
