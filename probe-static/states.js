// States of every data block: loading, no data, stale, error. The data layer drives them through
// window.ProbeState. For development only, and only on localhost, ?state=loading|empty|stale|error|
// unavailable in the URL applies one state to every block (there is no control for it on the page).
(() => {
  'use strict';
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const CADENCE = { NET: 'minute', CHAIN: 'minute', CAMP: 'day' };
  // a block is stale when its newest source is older than this
  const STALE_MS = { NET: 10 * 60e3, CHAIN: 10 * 60e3, CAMP: 30 * 3600e3 };
  const EMPTY = [
    [/^A\. Reference contracts/, 'No campaign transactions for this contract in this view.'],
    [/^B\. Network contracts/, 'No contract transactions observed in this view.'],
    [/^C\. Stuck contracts/, 'No stuck contracts detected in this view.'],
    [/^Votes per operator/, 'No votes recorded for this operator in this view.'],
    [/^Event log/, 'No events in this view.'],
  ];
  const EMPTY_BY_SOURCE = {
    CAMP: 'No campaign ran in this view yet. The daily campaign runs at a rotating hour.',
    NET: 'No network transactions observed in this view.',
    CHAIN: 'No data recorded for this epoch.',
  };

  const blocks = new Map();   // key -> { el, title, sources }
  function register() {
    $$('[data-tab-show] fieldset').forEach(el => {
      const tab = +el.closest('[data-tab-show]').dataset.tabShow;
      if (tab > 3) return;                       // Model validation and How it works are fixed content
      const legend = el.querySelector('legend');
      if (!legend) return;
      const text = legend.textContent.replace(/\s+/g, ' ').trim();
      const sources = (text.match(/\[(NET|CAMP|CHAIN)\]/g) || []).map(x => x.slice(1, -1));
      const title = text.replace(/\s*\[(NET|CAMP|CHAIN)\]/g, '').trim();
      const key = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      el.dataset.block = key;
      blocks.set(key, { el, title, sources: sources.length ? sources : ['NET', 'CAMP', 'CHAIN'] });
    });
  }

  const utc = d => d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  function ago(ms) {
    const m = Math.round(ms / 60e3);
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60);
    return h < 48 ? `${h} h ${m % 60} min` : Math.floor(h / 24) + ' days';
  }

  function message(b, state, info) {
    const at = info.lastUpdate ? new Date(info.lastUpdate) : null;
    if (state === 'loading') return 'Loading...';
    if (state === 'error') return 'Could not load this data. Retrying...';
    if (state === 'unavailable') return 'This data is temporarily unavailable.' + (at ? ` Last good data: ${utc(at)}.` : '');
    if (state === 'stale') {
      const src = info.source || b.sources[0];
      return `Last update ${at ? utc(at) : 'unknown'}${at ? ` (${ago(Date.now() - at)} ago)` : ''}. Expected every ${CADENCE[src]}.`;
    }
    if (state === 'empty') {
      if (info.text) return info.text;
      if (info.oldEpoch) return 'No data recorded for this epoch.';
      const own = EMPTY.find(([re]) => re.test(b.title));
      return own ? own[1] : EMPTY_BY_SOURCE[b.sources[0]];
    }
    return '';
  }

  // state: 'ok' | 'loading' | 'empty' | 'stale' | 'error' | 'unavailable'
  // info: { lastUpdate, source, text, oldEpoch }
  function set(key, state, info = {}) {
    const b = blocks.get(key);
    if (!b) return false;
    const { el } = b;
    el.classList.remove('st-loading', 'st-empty', 'st-stale', 'st-error', 'st-unavailable', 'st-hide');
    let msg = el.querySelector(':scope > .st-msg');
    let tag = el.querySelector(':scope > legend > .st-tag');
    if (state === 'ok') {
      if (msg) msg.remove();
      if (tag) tag.remove();
      el.removeAttribute('aria-busy');
      return true;
    }
    if (!msg) {
      msg = document.createElement('div');
      msg.className = 'st-msg';
      msg.setAttribute('role', 'status');
      el.querySelector('legend').after(msg);
    }
    msg.textContent = message(b, state, info);
    el.classList.add('st-' + state);
    if (state !== 'stale') el.classList.add('st-hide');   // stale keeps the data on screen
    el.toggleAttribute('aria-busy', state === 'loading');
    if (state === 'stale') {
      if (!tag) {
        tag = document.createElement('span');
        tag.className = 'st-tag';
        tag.textContent = '[STALE]';
        el.querySelector('legend').append(' ', tag);
      }
    } else if (tag) tag.remove();
    return true;
  }

  const setAll = (state, info) => blocks.forEach((_, key) => set(key, state, info));

  register();
  window.ProbeState = { set, setAll, keys: () => Array.from(blocks.keys()), sources: key => blocks.get(key)?.sources, STALE_MS };

  // development only, and only on localhost
  const params = new URLSearchParams(location.search);
  const dev = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ? params.get('state') : null;
  if (dev && ['loading', 'empty', 'stale', 'error', 'unavailable'].includes(dev)) {
    blocks.forEach((b, key) => {
      const src = b.sources[0];
      set(key, dev, { source: src, lastUpdate: Date.now() - (src === 'CAMP' ? 34 * 3600e3 : 25 * 60e3) });
    });
  }

})();
