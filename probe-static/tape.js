// Live transaction tape in the header: one character block per recent network transaction.
// The data layer (data.js) drives it through window.ProbeTape. For development only, and only on
// localhost, ?mock in the URL simulates one new transaction every 3 seconds instead of loading real data.
(() => {
  'use strict';
  const box = document.querySelector('[data-tape]');
  const row = box && box.querySelector('[data-tape-row]');
  if (!row) return;
  const MAX = 40;
  const EXPLORER = 'https://explorer-bradbury.genlayer.com/tx/';
  const CLASS = { first: 'tb-g', retry: 'tb-a', none: 'tb-r', pending: 'tb-x' };
  const LABEL = { first: 'accepted at first attempt', retry: 'accepted after retry', none: 'no consensus', pending: 'in progress' };
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const short = h => h.slice(0, 8) + '…' + h.slice(-6);
  const byHash = new Map();

  function paint(el, tx) {
    el.className = 'tb ' + (CLASS[tx.status] || CLASS.pending);
    const tip = `${short(tx.hash)} · contract ${short(tx.contract)} · ${LABEL[tx.status] || LABEL.pending}`;
    el.title = tip;
    el.setAttribute('aria-label', 'Transaction ' + tip);
    el.dataset.status = tx.status;
  }

  function block(tx) {
    const a = document.createElement('a');
    a.textContent = '▮';
    a.href = EXPLORER + tx.hash;
    a.target = '_blank';
    a.rel = 'noopener';
    a.setAttribute('role', 'listitem');
    a.dataset.hash = tx.hash;
    byHash.set(tx.hash, { tx, el: a });
    paint(a, tx);
    return a;
  }

  // empty places: with fewer than MAX transactions the row is completed on the left with faint
  // blocks (no tooltip, no link), so the tape always looks full
  function pad(n) {
    for (let i = 0; i < n; i++) {
      const el = document.createElement('span');
      el.className = 'tb tb-e';
      el.textContent = '▮';
      el.setAttribute('aria-hidden', 'true');
      row.appendChild(el);
    }
  }

  // newest transaction on the right; the row slides one place to the left when one enters
  function push(tx) {
    if (!byHash.size) { row.textContent = ''; pad(MAX - 1); }   // replaces a message
    const el = block(tx);
    el.classList.add('tb-new');
    row.appendChild(el);
    while (row.children.length > MAX) {
      byHash.delete(row.firstElementChild.dataset.hash);
      row.removeChild(row.firstElementChild);
    }
    if (still || !row.animate) return;
    const step = el.getBoundingClientRect().width;
    row.animate([{ transform: `translateX(${step}px)` }, { transform: 'translateX(0)' }], { duration: 260, easing: 'ease-out' });
  }

  function set(list) {
    row.textContent = '';
    byHash.clear();
    const shown = list.slice(-MAX);
    pad(MAX - shown.length);
    shown.forEach(tx => row.appendChild(block(tx)));
  }

  function update(hash, status) {
    const it = byHash.get(hash);
    if (!it) return;
    it.tx.status = status;
    paint(it.el, it.tx);
  }

  // a text in place of the blocks: loading, or data that could not be loaded
  function message(text) {
    row.textContent = '';
    byHash.clear();
    const el = document.createElement('span');
    el.className = 'tape-msg';
    el.setAttribute('role', 'status');
    el.textContent = text;
    row.appendChild(el);
  }

  // the simulation only exists on a development address: the published page never shows sample data
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const mock = local && new URLSearchParams(location.search).has('mock');
  window.ProbeTape = { set, push, update, message, mock };

  // ---- development only: sample transactions
  if (!mock) { message('Loading...'); return; }
  const hex = n => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  const CONTRACTS = ['0x27490261a2d0BEfb37A136C7eabE38f402aDB008', '0xC8Cc6AD350F462d8d87b7AeC787e6bDc1a7da30E',
    '0xB7BD7c379c0d7410E7deaB1f5A1E631CfC94adAC', '0x32d82f9ef5d28481482dB59628eA4Bc668Eb4Ed0', '0xd4abbd5166fa6163e2531b5067c949194de35bd9'];
  const outcome = () => { const x = Math.random(); return x < 0.78 ? 'first' : x < 0.92 ? 'retry' : 'none'; };
  const make = status => ({ hash: '0x' + hex(64), contract: CONTRACTS[Math.floor(Math.random() * CONTRACTS.length)], status });
  set(Array.from({ length: MAX }, () => make(outcome())));
  setInterval(() => {
    if (document.hidden) return;
    const tx = make('pending');
    push(tx);
    setTimeout(() => update(tx.hash, outcome()), 4500);
  }, 3000);
})();
