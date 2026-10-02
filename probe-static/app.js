// Probe.EXE interface behavior. No data loading.
// The data layer can listen for `probe:viewchange` on document to swap the view.
(() => {
  'use strict';
  const TITLES = ['F1 Overview', 'F2 Contracts', 'F3 Operators', 'F4 Events', 'F5 Model validation', 'F6 How it works'];
  const ZEBRA = ['#0b0f0c', '#111712'];
  const ON = '#c9d1c9', OFF = '#5b6b5e';
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const own = (row, sel) => $$(sel, row).filter(el => el.closest('[data-row]') === row);
  const state = { tab: 0, sort: { ref: ['fa', -1], net: ['tx', -1], ops: ['to', -1] }, net: 'llm', ev: 'all', q: '' };

  function setTab(i) {
    state.tab = i;
    $$('[data-tab-show]').forEach(el => { el.hidden = +el.dataset.tabShow !== i; });
    $$('.chip[data-go-tab]').forEach(el => {
      const on = +el.dataset.goTab === i;
      el.classList.toggle('on', on);
      el.setAttribute('aria-current', on ? 'page' : 'false');
    });
    $$('[data-sectitle]').forEach(el => { el.textContent = TITLES[i]; });
    $$('[data-hasview]').forEach(el => { el.hidden = i >= 4; });
    $$('[data-tab-select]').forEach(el => { el.value = String(i); });
    if (history.replaceState) history.replaceState(null, '', '#f' + (i + 1));
  }

  const groups = t => [...new Set($$(`[data-table-row="${t}"]`).map(r => r.parentNode))];
  const rowsOf = (p, t) => Array.from(p.children).filter(r => r.dataset.tableRow === t);
  const val = (r, k) => {
    const v = r.getAttribute('data-s-' + k) || '';
    const x = parseFloat(v);
    return !isNaN(x) && String(x) === v ? x : v.toLowerCase();
  };

  function stripe(t) {
    groups(t).forEach(p => {
      let n = 0;
      rowsOf(p, t).forEach(r => { if (!r.hidden) r.style.background = ZEBRA[n++ % 2]; });
    });
  }

  function showEmpty(t) {
    const g = groups(t)[0];
    const n = g ? rowsOf(g, t).filter(r => !r.hidden).length : 0;
    $$(`[data-empty="${t}"]`).forEach(el => { el.hidden = n > 0; });
  }

  function sortRows(t) {
    const [key, dir] = state.sort[t];
    groups(t).forEach(p => {
      rowsOf(p, t)
        .sort((a, b) => { const x = val(a, key), y = val(b, key); return (x < y ? -1 : x > y ? 1 : 0) * dir; })
        .forEach(r => p.appendChild(r));
    });
    $$(`[data-sort-key][data-table="${t}"]`).forEach(b => {
      const on = b.dataset.sortKey === key, a = b.querySelector('[data-arrow]');
      if (a) { a.textContent = on ? (dir < 0 ? ' ▼' : ' ▲') : ' ↕'; a.style.color = on ? ON : OFF; }
    });
    stripe(t);
  }

  function applyNet() {
    $$('[data-table-row="net"]').forEach(r => { r.hidden = state.net === 'llm' && r.dataset.lab !== 'llm'; });
    $$('[data-net-filter]').forEach(b => b.classList.toggle('on', b.dataset.netFilter === state.net));
    stripe('net');
  }

  function applyOps() {
    $$('[data-table-row="ops"]').forEach(r => { r.hidden = !!state.q && !(r.dataset.search || '').includes(state.q); });
    showEmpty('ops');
    stripe('ops');
  }

  function applyEv() {
    $$('[data-table-row="ev"]').forEach(r => { r.hidden = state.ev !== 'all' && r.dataset.type !== state.ev; });
    $$('[data-ev-filter]').forEach(b => b.classList.toggle('on', b.dataset.evFilter === state.ev));
    showEmpty('ev');
    stripe('ev');
  }

  function toggleRow(row) {
    const open = !row.classList.contains('is-open');
    row.classList.toggle('is-open', open);
    own(row, '[data-detail]').forEach(el => { el.hidden = !open; });
    own(row, '[data-when-closed]').forEach(el => { el.hidden = open; });
    own(row, '[data-sign]').forEach(el => { el.textContent = open ? '[-]' : '[+]'; });
    own(row, '[data-toggle]').forEach(b => b.setAttribute('aria-expanded', String(open)));
  }

  function togglePanel(btn) {
    const id = btn.dataset.togglePanel;
    const panel = document.querySelector(`[data-panel="${id}"]`);
    if (!panel) return;
    const open = btn.getAttribute('aria-expanded') !== 'true';
    if (id === 'pred') panel.classList.toggle('open', open); else panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    $$('[data-sign]', btn).forEach(s => { s.textContent = open ? '[-]' : '[+]'; });
  }

  function copyAddr(btn) {
    const addr = btn.dataset.copy;
    if (navigator.clipboard) navigator.clipboard.writeText(addr).catch(() => {});
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = btn.dataset.label.includes('[copy]') ? btn.dataset.label.replace('[copy]', '[copied]') : '[copied]';
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.textContent = btn.dataset.label; }, 1500);
  }

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-toggle],[data-go-tab],[data-sort-key],[data-net-filter],[data-ev-filter],[data-copy],[data-toggle-panel]');
    if (!b) return;
    if (b.hasAttribute('data-toggle')) { const row = b.closest('[data-row]'); if (row) toggleRow(row); }
    else if (b.dataset.goTab) setTab(+b.dataset.goTab);
    else if (b.dataset.sortKey) {
      const t = b.dataset.table, s = state.sort[t], k = b.dataset.sortKey;
      state.sort[t] = [k, s[0] === k ? -s[1] : -1];
      sortRows(t);
      if (t === 'net') applyNet();
      if (t === 'ops') applyOps();
    }
    else if (b.dataset.netFilter) { state.net = b.dataset.netFilter; applyNet(); }
    else if (b.dataset.evFilter) { state.ev = b.dataset.evFilter; applyEv(); }
    else if (b.dataset.copy) copyAddr(b);
    else if (b.dataset.togglePanel) togglePanel(b);
  });

  document.addEventListener('change', e => {
    if (e.target.matches('[data-tab-select]')) setTab(+e.target.value);
    if (e.target.matches('[data-view-select]')) {
      document.dispatchEvent(new CustomEvent('probe:viewchange', { detail: { view: e.target.value } }));
    }
  });

  document.addEventListener('input', e => {
    if (e.target.matches('[data-search-input]')) { state.q = e.target.value.trim().toLowerCase(); applyOps(); }
  });

  window.addEventListener('keydown', e => {
    const m = /^F([1-6])$/.exec(e.key);
    if (m) { e.preventDefault(); setTab(+m[1] - 1); }
  });

  // dates are shown in UTC; the local time goes in the tooltip
  function localTimes(root = document) {
    $$('[data-utc]', root).forEach(el => {
      const d = new Date(el.dataset.utc);
      if (!isNaN(d)) el.title = 'Local time: ' + d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    });
  }

  // for the data layer: the rows it renders are sorted, filtered and striped like the static ones
  window.ProbeUI = {
    localTimes,
    refresh(t) {
      $$('[data-toggle]').forEach(b => { if (!b.hasAttribute('aria-expanded')) b.setAttribute('aria-expanded', 'false'); });
      if (t === 'ev') { applyEv(); return; }   // the event log keeps the order it arrives in
      sortRows(t);
      if (t === 'net') applyNet();
      if (t === 'ops') applyOps();
    },
  };

  function init() {
    localTimes();
    $$('[data-toggle],[data-toggle-panel]').forEach(b => b.setAttribute('aria-expanded', 'false'));
    ['ref', 'net', 'ops'].forEach(sortRows);
    applyNet();
    applyOps();
    applyEv();
    const h = /^#f([1-6])$/i.exec(location.hash);
    setTab(h ? +h[1] - 1 : 0);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
