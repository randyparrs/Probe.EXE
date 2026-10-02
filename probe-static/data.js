// Data layer: loads real data from the API of the page's own origin (api/*) and feeds the
// interface. The HTML carries no numbers: a block shows real data or its state (loading, no data,
// stale, error), never sample data.
(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (local && (params.has('mock') || params.has('state'))) return;   // development views, only on localhost: no real data

  const TAPE_MS = 60e3, META_MS = 60e3, VIEW_MS = 300e3;   // the API caches the aggregates for 5 minutes
  const STALE_S = { NET: 10 * 60, CHAIN: 10 * 60, CAMP: 30 * 3600 };
  const EXPLORER = 'https://explorer-bradbury.genlayer.com/address/';
  const EXPLORER_TX = 'https://explorer-bradbury.genlayer.com/tx/', EXPLORER_EPOCH = 'https://explorer-bradbury.genlayer.com/epoch/';
  // the daily data files: one pair per epoch in the "data" branch of the repository, listed in index.json
  const DATA_RAW = 'https://raw.githubusercontent.com/randyparrs/Probe.EXE/data/', DATA_TREE = 'https://github.com/randyparrs/Probe.EXE/tree/data';
  const dataFiles = new Map();   // epoch -> { csv, jsonl }, from index.json
  const HEALTH_TIP = 'Healthy: 90% or more. Degraded: 70 to 90%. Failing: below 70%. Fixed thresholds chosen by Probe.EXE, not a GenLayer standard.';
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const get = async path => {
    const res = await fetch(path);
    if (!res.ok) throw new Error(path + ': ' + res.status);
    return res.json();
  };

  // ---- formats
  const two = n => String(n).padStart(2, '0');
  const date = d => `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
  const clock = d => `${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
  const full = ts => { const d = new Date(ts * 1000); return `${date(d)} ${clock(d)}`; };
  const iso = ts => new Date(ts * 1000).toISOString();
  // time alone when it is today (UTC), with the date otherwise
  const recent = (ts, now) => { const d = new Date(ts * 1000); return date(d) === date(new Date(now * 1000)) ? clock(d) : `${date(d).slice(5)} ${clock(d)}`; };
  const int = n => n.toLocaleString('en-US');
  const pct = r => (r * 100).toFixed(1) + '%';
  const share = (k, n) => (n ? pct(k / n) : 'n/a');
  const interval = (k, n) => { const [lo, hi] = window.ProbeStats.clopperPearson(k, n); return `${(lo * 100).toFixed(1)}-${(hi * 100).toFixed(1)}`; };
  const short = a => a.slice(0, 6) + '...' + a.slice(-4);
  const capital = s => s.charAt(0).toUpperCase() + s.slice(1);

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
    for (const c of children.flat()) if (c != null) node.append(c);
    return node;
  }
  // percent bar: solid blocks, the empty part in a dim color (shaded characters come from a fallback
  // font and are taller than the line)
  const bar = (r, cells = 20) => { const on = Math.round(r * cells); return ['█'.repeat(on), el('span', { class: 'bar-off' }, '█'.repeat(cells - on))]; };
  const ciSpan = (k, n, prefix) => el('span', { class: 'c5', title: '95% Clopper-Pearson interval' }, `${prefix} ${interval(k, n)}`);
  const address = a => el('a', { href: EXPLORER + a, target: '_blank', rel: 'noopener', title: a }, short(a));
  const txLink = h => el('a', { href: EXPLORER_TX + h, target: '_blank', rel: 'noopener', title: h }, short(h));
  // Every total links to what it is made of: the data file of its epoch, or the list of files when
  // the view is not one epoch or its file is not published yet.
  const viewEpoch = () => { const m = /^epoch:(\d+)$/.exec(view); return m ? +m[1] : null; };
  const dataUrl = epoch => { const f = epoch == null ? null : dataFiles.get(epoch); return f && /^[\w.-]+$/.test(f.csv || '') ? DATA_RAW + f.csv : DATA_TREE; };
  const dataLink = (text, epoch = viewEpoch()) => el('a', { href: dataUrl(epoch), target: '_blank', rel: 'noopener', title: 'The transactions behind this number, in the data files.' }, text);

  // every element with data-f="key": text, and the time for the local-time tooltip
  function fill(key, text, ts) {
    $$(`[data-f="${key}"]`).forEach(node => {
      node.textContent = text;
      if (ts) node.dataset.utc = iso(ts); else delete node.dataset.utc;
      node.removeAttribute('title');
    });
  }

  // ---- blocks: the fieldsets that states.js registers by the text of their legend
  const state = (key, s, info) => window.ProbeState && window.ProbeState.set(key, s, info);
  const sourceOf = key => (window.ProbeState && window.ProbeState.sources(key) || ['NET'])[0];
  const loaded = new Set();
  const content = new Map();   // block -> 'ok' | 'empty', what its last load found
  let meta = null, view = '', optionList = '';

  // replaces what a block shows (everything but its legend and its state message)
  function body(key, ...nodes) {
    const box = document.querySelector(`fieldset[data-block="${key}"]`);
    if (!box) return;
    Array.from(box.children).forEach(c => { if (c.tagName !== 'LEGEND' && !c.classList.contains('st-msg')) c.remove(); });
    box.append(...nodes.flat().filter(Boolean));
  }

  // Loads once and feeds several blocks. render(data) returns { block: true when it has no data }.
  async function group(keys, load, render) {
    for (const key of keys) if (!loaded.has(key)) state(key, 'loading');
    try {
      const empty = render(await load());
      const oldEpoch = !!(meta && meta.epoch && view !== '24h' && view !== `epoch:${meta.epoch.number}`);
      for (const key of keys) {
        loaded.add(key);
        content.set(key, empty[key] ? 'empty' : 'ok');
        state(key, empty[key] ? 'empty' : 'ok', { oldEpoch, text: emptyText.get(key) });
      }
      markStale();
    } catch {
      for (const key of keys) if (!loaded.has(key)) state(key, 'error');
    }
  }

  // data older than expected is marked, with the data kept on screen
  function markStale() {
    if (!meta) return;
    const last = { NET: meta.updated.network, CHAIN: meta.updated.chain, CAMP: meta.updated.campaign };
    for (const [key, what] of content) {
      const src = sourceOf(key);
      if (what !== 'ok' || !last[src]) continue;
      state(key, meta.now - last[src] > STALE_S[src] ? 'stale' : 'ok', { source: src, lastUpdate: last[src] * 1000 });
    }
  }

  // ---- tape: the latest network transactions
  const TAPE_STATUS = { first: 'first', retry: 'retry', none: 'none' };   // anything else: in progress
  const shown = new Map();   // hash -> status on screen
  let tapeLoaded = false;

  async function loadTape() {
    try {
      const { txs } = await get('api/tape');
      const list = txs.map(t => ({ hash: t.hash, contract: t.contract, status: TAPE_STATUS[t.status] || 'pending' }));
      if (!tapeLoaded) {
        if (list.length) window.ProbeTape.set(list); else window.ProbeTape.message('No network transactions observed yet.');
        tapeLoaded = list.length > 0;
      } else {
        for (const tx of list) {
          if (!shown.has(tx.hash)) window.ProbeTape.push(tx);                       // new: enters on the right
          else if (shown.get(tx.hash) !== tx.status) window.ProbeTape.update(tx.hash, tx.status);
        }
      }
      shown.clear();
      for (const tx of list) shown.set(tx.hash, tx.status);
    } catch {
      if (!tapeLoaded) window.ProbeTape.message('Could not load this data. Retrying...');
    }
  }

  // ---- top bar, view selector, RPC card and freshness
  async function loadMeta() {
    try {
      meta = await get('api/meta');
    } catch {
      if (!loaded.has('rpc')) state('rpc', 'error');
      return;
    }
    const { now, updated, epoch } = meta;
    const times = { 'upd-net': updated.network, 'upd-chain': updated.chain, 'upd-camp': updated.campaign };
    for (const [key, ts] of Object.entries(times)) fill(key, ts ? recent(ts, now) : 'no data yet', ts);
    const known = Object.values(times).filter(Boolean);
    fill('upd-oldest', known.length ? recent(Math.min(...known), now) : 'no data yet', known.length ? Math.min(...known) : null);
    fill('epoch-n', epoch ? String(epoch.number) : 'unknown');
    $$('a[data-f="epoch-n"]').forEach(node => { if (epoch) { node.href = EXPLORER_EPOCH + epoch.number; node.title = 'This epoch on the explorer'; } else node.removeAttribute('href'); });
    $$('[data-f="epoch-since-wrap"]').forEach(node => { node.hidden = !(epoch && epoch.since); });
    if (epoch && epoch.since) fill('epoch-since', full(epoch.since), epoch.since);
    fill('epoch-next', !epoch || !epoch.since ? 'unknown' : epoch.next_estimate > now ? 'estimated ' + full(epoch.next_estimate) : 'any time now');
    $$('[data-field="method.eventsSince"]').forEach(node => { node.textContent = meta.events_since; });

    // View: every epoch with data, newest first, and the last 24 hours
    $$('[data-view-select]').forEach(select => {
      const options = meta.epochs.map(e => [`epoch:${e.epoch}`, `Epoch ${e.epoch}${epoch && e.epoch === epoch.number ? ' (current)' : ''}`]);
      options.push(['24h', 'Last 24 h']);
      if (!view || !options.some(([value]) => value === view)) view = options[0][0];
      if (optionList !== JSON.stringify(options)) {
        select.replaceChildren(...options.map(([value, text]) => el('option', { value }, text)));
        optionList = JSON.stringify(options);
      }
      select.value = view;
    });
    if (window.ProbeUI) window.ProbeUI.localTimes(document.querySelector('.c3'));

    body('rpc', meta.rpc.state === 'normal' ? el('div', { class: 'c64' }, 'RPC: normal')
      : el('div', { class: 'rpc-degraded' }, `RPC: degraded (non-JSON responses in the last hour: ${int(meta.rpc.non_json_last_hour)})`));
    loaded.add('rpc'); content.set('rpc', 'ok'); state('rpc', 'ok');
    markStale();
  }

  // ---- Overview
  const HEALTH = rate => (rate >= 0.9 ? ['[HEALTHY]', 'c37', 'c38', 'c39'] : rate >= 0.7 ? ['[DEGRADED]', 'c33', 'c34', 'c36'] : ['[FAILING]', 'pct-failing', 'hl-failing', 'bar-failing']);

  // first-attempt acceptance of a group of campaign transactions; returns true when there is none
  function acceptanceCard(key, t, note) {
    if (!t.decided) return true;
    const [label, big, tag, barClass] = HEALTH(t.first_rate);
    body(key,
      el('div', { class: 'c32' }, el('span', { class: big }, pct(t.first_rate)), el('span', { class: tag, title: HEALTH_TIP }, label)),
      el('div', { class: 'c35' }, '(', dataLink(`${int(t.first)} / ${int(t.decided)}`), ', ', ciSpan(t.first, t.decided, '95% CI'), ')', t.in_progress ? ` · ${int(t.in_progress)} in progress` : ''),
      el('div', { class: barClass }, bar(t.first_rate), ` ${pct(t.first_rate)}`),
      note ? el('div', { class: 'c40' }, note) : null);
    return false;
  }

  const VOTES = [['agree', 'Agree', 'c50'], ['disagree', 'Content disagreement', 'c51'], ['dv', 'Execution divergence (DV)', 'v-dv'], ['timeout', 'Timeout', 'c52']];
  // cells of a stacked bar: proportional, with at least one cell for a category that has votes
  function stacked(votes, cells) {
    const raw = VOTES.map(([k]) => (votes[k] ? Math.max(1, Math.round(votes[k] / votes.total * cells)) : 0));
    let extra = raw.reduce((a, b) => a + b, 0) - cells;
    while (extra !== 0) {   // the largest category absorbs the rounding
      const i = raw.indexOf(Math.max(...raw));
      raw[i] -= Math.sign(extra); extra -= Math.sign(extra);
    }
    return VOTES.map(([, , cls], i) => (raw[i] ? el('span', { class: cls }, '█'.repeat(raw[i])) : null));
  }

  function renderOverview(o) {
    const llm = o.campaign.llm, empty = {};
    // network [NET]
    for (const [name, t] of Object.entries(o.network)) {
      const row = document.querySelector(`[data-net-row="${name}"]`);
      if (!row) continue;
      const barEl = row.querySelector('[data-bar]'), count = row.querySelector('[data-count]');
      if (!t.decided) {
        barEl.replaceChildren();
        count.replaceChildren(t.tx ? `${int(t.tx)} in progress, none decided yet` : 'no transactions in this view');
        continue;
      }
      barEl.replaceChildren(...bar(t.first_rate), ` ${pct(t.first_rate)}`);
      count.replaceChildren('(', dataLink(`${int(t.first)} / ${int(t.decided)}`), ', ', ciSpan(t.first, t.decided, '95% CI'), ')', t.in_progress ? ` · ${int(t.in_progress)} in progress` : '');
    }
    empty['network-wide-first-attempt-acceptance'] = o.network.all.tx === 0;

    // campaign [CAMP]
    empty['first-attempt-acceptance-contracts-with-llm-calls'] = acceptanceCard('first-attempt-acceptance-contracts-with-llm-calls', llm);
    empty['first-attempt-acceptance-control-without-llm'] = acceptanceCard('first-attempt-acceptance-control-without-llm', o.campaign.control,
      'If the control also fails, the problem is not the LLM.');

    empty['what-goes-wrong-votes'] = !llm.votes.total;
    if (llm.votes.total) {
      body('what-goes-wrong-votes',
        el('div', { class: 'c49' }, stacked(llm.votes, 30)),
        el('div', { class: 'c53' }, VOTES.map(([k, text, cls]) => el('div', { class: 'c54' }, el('span', { class: cls }, '█'), el('span', {}, text),
          el('span', { class: 'c55' }, int(llm.votes[k])), el('span', { class: 'c56' }, pct(llm.votes[k] / llm.votes.total))))),
        el('div', { class: 'c57' }, dataLink(int(llm.votes.total)), ' votes on contracts with LLM calls'));
    }

    empty['what-goes-wrong-attempts'] = !llm.retries.transactions;
    if (llm.retries.transactions) {
      const r = llm.retries;
      body('what-goes-wrong-attempts',
        el('div', { class: 'c58' }, [['Leader timeouts', r.leader_timeouts], ['No majority', r.no_majority], ['Appeals', r.appeals], ['Recomputations', r.recomputations]]
          .map(([text, n]) => el('div', { class: 'c59' }, el('span', {}, text), el('span', {}, int(n))))),
        el('div', { class: 'c57' }, 'Across ', dataLink(int(r.transactions)), ' transactions on contracts with LLM calls'));
    }

    const t = llm.time_to_acceptance;
    empty['time-to-acceptance'] = !t.accepted;
    if (t.accepted) {
      const ranges = [['< 30 s', t.under_30s], ['30-60 s', t.s30_to_60], ['1-5 min', t.m1_to_5], ['> 5 min', t.over_5m]];
      body('time-to-acceptance',
        el('div', { class: 'c60' }, `median ${int(t.median)} s, p90 ${int(t.p90)} s`),
        el('div', { class: 'tta' }, ranges.map(([text, n], i) => el('div', { class: 'tta-row' }, el('span', {}, text),
          el('span', { class: i === 3 ? 'tta-bar tta-slow' : 'tta-bar' }, '▮'.repeat(n ? Math.max(1, Math.round(n / t.accepted * 20)) : 0)),
          el('span', {}, Math.round(n / t.accepted * 100) + '%')))),
        el('div', { class: 'c57' }, `max ${int(t.max)} s · `, dataLink(int(t.accepted)), ' accepted transactions'));
    }

    empty['operators-timing-out'] = !o.campaign.voters;
    if (o.campaign.voters) {
      body('operators-timing-out',
        el('div', {}, 'Operators with a timeout on every LLM vote in this view: ', el('b', { class: 'c52' }, int(o.campaign.operators_all_timeout.length))),
        el('button', { class: 'c63', type: 'button', 'data-go-tab': '2' }, 'See Operators'));
    }

    const last = o.last_campaign;
    const wallet = () => (meta && meta.campaign_wallet ? el('div', { class: 'c57' }, 'Sent by the campaign wallet ', address(meta.campaign_wallet)) : null);
    empty['last-campaign'] = !last;
    if (last && last.status === 'failed') {
      // the bucket of the day passed with no transaction of the campaign wallet
      body('last-campaign', el('div', {}, `Last campaign: expected ${full(last.expected_from).replace(' UTC', '')} to ${clock(new Date(last.expected_until * 1000))}, no transactions `,
        el('span', { class: 'cs-failed' }, '(failed)')), wallet());
    } else if (last) {
      body('last-campaign', el('div', {}, 'Last campaign: ', el('span', { class: 'c5', 'data-utc': iso(last.started) }, full(last.started)),
        ', ', dataLink(`${int(last.transactions)} transactions`, last.epoch), ' ', el('span', { class: last.status === 'running' ? 'cs-running' : 'c64' }, `(${last.status})`)), wallet());
      if (window.ProbeUI) window.ProbeUI.localTimes(document.querySelector('fieldset[data-block="last-campaign"]'));
    }

    // validators [CHAIN]
    const v = o.validators;
    empty.validators = !v;
    if (v) {
      body('validators', el('div', { class: 'c61' }, el('span', {}, `${int(v.active)} active`), el('span', {}, '·'), el('span', {}, `${int(v.eligible)} eligible`),
        el('span', {}, '·'), el('span', { class: 'c62' }, `${int(v.quarantined)} quarantined`), el('span', {}, '·'), el('span', { class: 'c62' }, `${int(v.banned)} banned`)),
        el('button', { class: 'c63', type: 'button', 'data-go-tab': '2' }, 'See Operators'));
    }
    return empty;
  }

  // ---- Contracts
  const LABEL = { llm: ['llm', 'Contract with LLM calls', 'c109'], none: ['none', 'No LLM calls found', 'c112'], na: ['na', 'Code not available', 'c112'] };
  const PENDING_LABEL = ['na', 'Code not read yet', 'c112'];
  const HEIGHTS = '▁▂▃▄▅▆▇█';

  // A. reference contracts [CAMP]
  function renderReference(rows) {
    const desk = document.querySelector('[data-rows="ref-desk"]'), mob = document.querySelector('[data-rows="ref-mob"]');
    if (!desk || !mob) return true;
    $$('[data-table-row="ref"]').forEach(node => node.remove());
    for (const c of rows) {
      const n = c.decided, accepted = c.first + c.retry, t = c.time_to_acceptance, r = c.retries, v = c.votes;
      const causes = [['Leader timeout', r.leader_timeouts], ['No majority', r.no_majority], ['Appeal', r.appeals], ['Recomputation', r.recomputations]];
      const data = { 'data-row': '', 'data-table-row': 'ref', 'data-s-id': c.name, 'data-s-fa': n ? c.first / n : -1, 'data-s-ar': n ? accepted / n : -1,
        'data-s-nc': n ? c.none / n : -1, 'data-s-rc': causes.reduce((s, [, k]) => s + k, 0), 'data-s-vo': v.total ? v.timeout / v.total : -1,
        'data-s-tt': t.median == null ? -1 : t.median };
      const voteTip = VOTES.map(([k, text]) => `${text}: ${int(v[k])}`).join(', ');
      const series = c.by_epoch.filter(e => e.decided);
      const seriesTip = series.length ? 'First attempt by epoch. ' + series.map(e => `${e.epoch}: ${pct(e.first_rate)}`).join(', ') : 'No campaign data yet.';
      const mini = () => (series.length ? el('span', { class: 'c62' }, series.map(e => HEIGHTS[Math.min(7, Math.floor(e.first_rate * 8))]).join('')) : 'n/a');
      const copies = [...c.copies.map((a, i) => [`Copy ${i + 1}`, a, null]), ...(c.retired || []).map(x => ['Retired copy', x.address, x.reason])];
      const cell = (main, sub, more) => el('div', { class: 'c78' }, el('div', {}, main), sub ? el('div', { class: 'c77' }, sub) : null, more);

      desk.append(el('div', { ...data, class: 'c73' },
        el('div', { class: 'c74' },
          el('div', { class: 'c75' }, el('button', { class: 'c76', type: 'button', 'data-toggle': '' }, el('span', { 'data-sign': '' }, '[+]'), ' ' + c.name), el('div', { class: 'c77' }, capital(c.kind))),
          el('div', { class: 'c78' }, el('div', { class: 'c79' }, share(c.first, n)), el('div', { class: 'c77' }, `${int(c.first)} / ${int(n)}`),
            n ? el('div', { class: 'c80', title: '95% Clopper-Pearson interval' }, `CI ${interval(c.first, n)}`) : null),
          cell(share(accepted, n), `${int(accepted)} / ${int(n)}`),
          cell(share(c.none, n), `${int(c.none)} / ${int(n)}`),
          el('div', { class: 'c81' }, causes.map(([text, k]) => el('div', { class: 'c82' }, el('span', {}, text), el('span', {}, int(k))))),
          el('div', { class: 'c78', title: voteTip }, el('div', { class: 'c83' }, v.total ? stacked(v, 10) : 'n/a'), el('div', { class: 'c77' }, `${int(v.total)} votes`)),
          cell(t.median == null ? 'n/a' : `${int(t.median)} s`, t.p90 == null ? null : `p90 ${int(t.p90)} s`),
          el('div', { class: 'c84', title: seriesTip }, mini())),
        el('div', { class: 'contents', 'data-detail': '', hidden: '' }, el('div', { class: 'c85' },
          el('div', {}, el('div', { class: 'c86' }, 'Series by epoch'), series.length ? series.map(e => el('div', { class: 'c87' }, el('span', {}, `Epoch ${e.epoch}`),
            el('span', {}, bar(e.first_rate, 10), ` ${pct(e.first_rate)}`), el('span', { class: 'c7' }, `(${int(e.first)} / ${int(e.decided)})`))) : el('div', { class: 'c7' }, 'No campaign data yet.')),
          el('div', { class: 'c88' }, el('div', { class: 'c86' }, 'Fixed inputs'), el('div', { class: 'c89' }, c.input || ''), el('div', { class: 'c35' }, 'Transactions in this view: ', dataLink(int(c.tx)))),
          el('div', {}, el('div', { class: 'c86' }, 'Copies'), copies.map(([name, a, reason]) => el('div', { class: 'c90' },
            el('div', { class: 'c91' }, el('span', {}, name), address(a), reason ? el('span', { class: 'c51' }, 'Retired') : el('span', { class: 'c50' }, 'Active')),
            reason ? el('div', { class: 'c93' }, capital(reason) + '.') : null)))))));

      mob.append(el('div', { ...data, class: 'c94' },
        el('div', { class: 'c95' }, el('span', { class: 'c79' }, c.name), el('span', { class: 'c79' }, share(c.first, n))),
        el('div', { class: 'c96' }, el('span', {}, capital(c.kind)), el('span', {}, `n = ${int(c.tx)}`)),
        el('button', { class: 'c97', type: 'button', 'data-toggle': '' }, el('span', { 'data-sign': '' }, '[+]'), ' Details'),
        el('div', { class: 'contents', 'data-detail': '', hidden: '' }, el('div', { class: 'c98' },
          el('div', {}, n ? `First attempt: ${share(c.first, n)} (${int(c.first)} / ${int(n)}, 95% CI ${interval(c.first, n)})` : 'First attempt: n/a'),
          el('div', {}, `After retry: ${share(accepted, n)} (${int(accepted)} / ${int(n)})`),
          el('div', {}, `No consensus: ${share(c.none, n)} (${int(c.none)} / ${int(n)})`),
          el('div', {}, 'Retry causes: ' + causes.map(([text, k]) => `${text.toLowerCase()} ${int(k)}`).join(', ')),
          el('div', { class: 'c46' }, 'Votes: ', v.total ? stacked(v, 10) : '', ` ${int(v.total)}`),
          el('div', {}, t.median == null ? 'Time to acceptance: n/a' : `Time to acceptance: ${int(t.median)} s, p90 ${int(t.p90)} s`),
          el('div', { class: 'c46' }, 'By epoch: ', mini()),
          series.map(e => el('div', { class: 'c99' }, `Epoch ${e.epoch} `, bar(e.first_rate, 10), ` ${pct(e.first_rate)}`)),
          el('div', { class: 'c89' }, c.input || ''),
          copies.map(([name, a, reason]) => el('div', {}, el('span', {}, name + ' '), address(a),
            reason ? el('span', { class: 'c51' }, ' Retired') : el('span', { class: 'c50' }, ' Active'), reason ? el('div', { class: 'c100' }, capital(reason) + '.') : null))))));
    }
    if (window.ProbeUI) window.ProbeUI.refresh('ref');
    return rows.every(c => c.tx === 0);
  }

  // Markdown of the badge of a contract: its first-attempt acceptance in the current epoch
  const BADGE_TIP = 'Copy the Markdown of a badge with the first-attempt acceptance of this contract in the current epoch.';
  const badgeSnippet = a => `[![Probe.EXE first attempt](${location.origin}/api/badge/${a}.svg)](${location.origin}/#f2)`;

  // B. every contract of the network [NET] [CHAIN]
  function renderNetwork(rows, now) {
    const desk = document.querySelector('[data-rows="net-desk"]'), mob = document.querySelector('[data-rows="net-mob"]');
    if (!desk || !mob) return true;
    $$('[data-table-row="net"]').forEach(node => node.remove());
    for (const c of rows) {
      const [lab, text, cls] = LABEL[c.llm] || PENDING_LABEL;
      const firstPct = share(c.first, c.decided), nonePct = share(c.none, c.decided);
      const seen = c.last_seen ? recent(c.last_seen, now) : 'n/a';
      const data = { 'data-row': '', 'data-table-row': 'net', 'data-lab': lab, 'data-s-c': c.contract, 'data-s-l': text, 'data-s-tx': c.tx,
        'data-s-fa': c.decided ? c.first / c.decided : -1, 'data-s-nc': c.decided ? c.none / c.decided : -1, 'data-s-cx': c.cancelled, 'data-s-ls': c.last_seen || 0 };

      desk.append(el('div', { ...data, class: 'c107' },
        el('div', { class: 'c108' }, el('div', { class: 'c142' }, address(c.contract),
          el('button', { class: 'c143', type: 'button', title: BADGE_TIP, 'data-copy': badgeSnippet(c.contract) }, '[badge]'))),
        el('div', { class: cls }, text),
        el('div', { class: 'c110' }, int(c.tx)),
        el('div', { class: 'c110' }, el('span', { class: 'c79' }, firstPct), ' ', el('span', { class: 'c77' }, int(c.first)),
          c.decided ? el('div', { class: 'c80', title: '95% Clopper-Pearson interval' }, `CI ${interval(c.first, c.decided)}`) : null),
        el('div', { class: 'c110' }, nonePct + ' ', el('span', { class: 'c77' }, int(c.none))),
        el('div', { class: 'c110' }, int(c.cancelled)),
        el('div', { class: 'c110', 'data-utc': c.last_seen ? iso(c.last_seen) : null }, seen)));

      mob.append(el('div', { ...data, class: 'c94' },
        el('div', { class: 'c59' }, address(c.contract), el('span', { class: 'c79' }, firstPct)),
        el('div', { class: 'c96' }, el('span', {}, text), el('span', {}, `n = ${int(c.tx)}`)),
        el('button', { class: 'c97', type: 'button', 'data-toggle': '' }, el('span', { 'data-sign': '' }, '[+]'), ' Details'),
        el('div', { class: 'contents', 'data-detail': '', hidden: '' }, el('div', { class: 'c113' },
          el('div', {}, c.decided ? `First attempt: ${firstPct} (${int(c.first)} / ${int(c.decided)}, 95% CI ${interval(c.first, c.decided)})` : 'First attempt: n/a'),
          el('div', {}, `No consensus: ${nonePct} (${int(c.none)})`),
          el('div', {}, `Cancelled / idle: ${int(c.cancelled)}`),
          el('div', {}, `Last seen: ${seen}`),
          el('div', {}, el('button', { class: 'c156', type: 'button', title: BADGE_TIP, 'data-copy': badgeSnippet(c.contract) }, '[copy] badge'))))));
    }
    if (window.ProbeUI) { window.ProbeUI.refresh('net'); window.ProbeUI.localTimes(desk); }
    return rows.length === 0;
  }

  // C. stalled contracts [NET]
  const contractName = c => [c.reference ? c.reference + ' ' : null, address(c.contract), c.last_tx ? [' · last tx ', txLink(c.last_tx)] : null].flat();
  function renderStalled(rows) {
    const desk = document.querySelector('[data-rows="stalled-desk"]'), mob = document.querySelector('[data-rows="stalled-mob"]');
    if (!desk || !mob) return true;
    $$('[data-table-row="stalled"]').forEach(node => node.remove());
    rows.forEach((c, i) => {
      const back = c.status === 'recovered';
      const status = () => (back ? el('span', { 'data-utc': iso(c.recovered) }, `Recovered on ${full(c.recovered)}`)
        : el('span', { 'data-utc': iso(c.since) }, `Stalled since ${full(c.since)}`));
      desk.append(el('div', { class: i % 2 ? 'c117 alt' : 'c117', 'data-table-row': 'stalled' },
        el('div', { class: 'c116' }, contractName(c)),
        el('div', { class: 'c116', 'data-utc': iso(c.since) }, full(c.since)),
        el('div', { class: 'c116' }, int(c.transactions)),
        el('div', { class: back ? 'c116 recovered' : 'c119' }, status())));
      mob.append(el('div', { class: 'c120', 'data-table-row': 'stalled' },
        el('div', {}, contractName(c)),
        el('div', { class: back ? 'recovered' : 'c121' }, status()),
        el('div', { class: 'c122' }, `${int(c.transactions)} transactions without a vote`)));
    });
    if (window.ProbeUI) { window.ProbeUI.localTimes(desk); window.ProbeUI.localTimes(mob); }
    return rows.length === 0;
  }

  // ---- Events
  const EV_TAG = { epoch: '[EPOCH]', eligible: '[VALIDATOR]', quarantined: '[VALIDATOR]', banned: '[VALIDATOR]', stalled: '[CONTRACT]',
    recovered: '[CONTRACT]', campaign: '[CAMPAIGN]', method: '[METHOD]', rpc: '[RPC]' };
  const EV_SOURCE = { epoch: 'CHAIN', eligible: 'CHAIN', quarantined: 'CHAIN', banned: 'CHAIN', stalled: 'NET', recovered: 'NET', campaign: 'CAMP', method: 'CAMP' };
  const SOURCE_TIP = { CHAIN: 'Read directly from the staking contract.', NET: 'All transactions on Bradbury, read from consensus events.',
    CAMP: 'Our daily campaign: fixed reference contracts and a control without LLM.' };
  const lasted = s => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return [d ? d + ' d' : null, h ? h + ' h' : null, m + ' min'].filter(Boolean).join(' '); };
  const operatorName = d => (d.moniker ? `${d.moniker} (${short(d.validator)})` : `${short(d.validator)} (no declared name)`);
  const contractText = d => (d.reference ? `${d.reference} ${short(d.contract)}` : short(d.contract));

  function eventText(e) {
    const d = e.data;
    switch (e.type) {
      case 'epoch': return `Epoch ${d.epoch} started.` + (d.previous_seconds ? ` Epoch ${d.epoch - 1} lasted ${lasted(d.previous_seconds)}.` : '');
      case 'eligible': return `Eligible set: +${int(d.joined.length)} joined, -${int(d.left.length)} left (${int(d.eligible)} eligible).`;
      case 'quarantined': return `${operatorName(d)} quarantined.`;
      case 'banned': return `${operatorName(d)} ${d.until ? `banned until epoch ${d.until}.` : 'banned permanently.'}`;
      case 'stalled': return `${contractText(d)}: stalled since ${full(d.since)}.`;
      case 'recovered': return `${contractText(d)}: recovered after ${int(d.transactions)} transactions without a vote.`;
      case 'campaign': return `Campaign ${d.id}: ${int(d.transactions)} transactions, ${d.status}.`;
      case 'method': return `Campaigns counted from consensus events (METRICS v6) since ${d.since}.`;
      case 'rpc': return d.open ? `RPC returning non-JSON responses since ${full(d.from)}.` : `RPC returned non-JSON responses from ${full(d.from)} to ${full(d.to)}.`;
      default: return e.type;
    }
  }

  // the sentence of an event with everything that can be opened as a link
  function eventNodes(e) {
    const d = e.data;
    const operator = () => [d.moniker ? d.moniker + ' ' : null, address(d.validator), d.moniker ? null : ' (no declared name)'];
    const contract = () => [d.reference ? d.reference + ' ' : null, address(d.contract)];
    const listed = list => (list.length ? [' (', list.map((a, i) => [i ? ', ' : null, address(a)]), ')'] : null);
    const epochLink = n => el('a', { href: EXPLORER_EPOCH + n, target: '_blank', rel: 'noopener', title: 'This epoch on the explorer' }, `Epoch ${n}`);
    const parts = (() => {
      switch (e.type) {
        case 'epoch': return [epochLink(d.epoch), ' started.', d.previous_seconds ? ` Epoch ${d.epoch - 1} lasted ${lasted(d.previous_seconds)}.` : null];
        case 'eligible': return [`Eligible set: +${int(d.joined.length)} joined`, listed(d.joined), `, -${int(d.left.length)} left`, listed(d.left), ` (${int(d.eligible)} eligible).`];
        case 'quarantined': return [operator(), ' quarantined.'];
        case 'banned': return [operator(), d.until ? ` banned until epoch ${d.until}.` : ' banned permanently.'];
        case 'stalled': return [contract(), `: stalled since ${full(d.since)}.`];
        case 'recovered': return [contract(), `: recovered after ${int(d.transactions)} transactions without a vote`, d.tx ? [', with the vote on ', txLink(d.tx)] : null, '.'];
        case 'campaign': return [`Campaign ${d.id}: `, dataLink(`${int(d.transactions)} transactions`, d.epoch), `, ${d.status}.`,
          meta && meta.campaign_wallet ? [' Wallet ', address(meta.campaign_wallet), '.'] : null];
        default: return [eventText(e)];
      }
    })();
    return parts.flat(Infinity).filter(p => p != null);
  }

  function eventRow(e) {
    const text = eventText(e), tag = EV_TAG[e.type] || '', src = EV_SOURCE[e.type];
    const epoch = e.type === 'epoch' ? e.data.epoch : null;
    return el('div', { class: 'c169', 'data-row': '', 'data-table-row': 'ev', 'data-type': e.group, 'data-epoch': epoch },
      el('div', { class: 'contents', 'data-only': 'desk' }, el('div', { class: 'c170' },
        el('span', { class: 'c171', 'data-utc': iso(e.ts) }, full(e.ts)),
        el('span', { class: 'c7' }, tag),
        epoch == null ? el('span', {}, eventNodes(e))
          : el('span', {}, el('button', { class: 'c177', type: 'button', 'data-toggle': '' }, el('span', { 'data-sign': '' }, '[+]'), ' ' + text), ' ',
            el('a', { class: 'c172', href: EXPLORER_EPOCH + epoch, target: '_blank', rel: 'noopener', title: 'This epoch on the explorer' }, '[explorer]')),
        el('span', { class: 'c172', title: SOURCE_TIP[src] }, src ? `[${src}]` : ''))),
      el('div', { class: 'contents', 'data-only': 'mob' }, el('button', { class: 'c173', type: 'button', 'data-toggle': '' },
        el('span', { class: 'c174' }, `${full(e.ts)} ${tag}`), el('span', { class: 'c175', 'data-when-closed': '' }, text))),
      el('div', { class: 'contents', 'data-detail': '', hidden: '' }, el('div', { class: 'c178' },
        el('div', { 'data-only': 'mob' }, eventNodes(e)),
        epoch == null ? null : el('div', { class: 'contents', 'data-epoch-summary': '' }, el('div', {}, 'Loading...')))));
  }

  // summary of an epoch change, loaded when its row is opened: first-attempt acceptance in the
  // epoch against the one before
  async function loadEpochSummary(row) {
    const box = row.querySelector('[data-epoch-summary]'), epoch = +row.dataset.epoch;
    if (!box || box.dataset.done) return;
    box.dataset.done = '1';
    const [now, before] = await Promise.all([epoch, epoch - 1].map(n => get(`api/overview?view=epoch:${n}`).catch(() => null)));
    if (!now) { delete box.dataset.done; box.replaceChildren(el('div', {}, 'Could not load this data.')); return; }
    const rate = t => (t && t.decided ? `${pct(t.first_rate)} (${int(t.first)} / ${int(t.decided)})` : 'no data');
    const line = (label, pick) => el('div', {}, `${label}: epoch ${epoch} ${rate(pick(now))} · epoch ${epoch - 1} ${rate(before && pick(before))}`);
    box.replaceChildren(el('div', { class: 'c86' }, 'First-attempt acceptance'),
      line('Contracts with LLM calls [CAMP]', o => o.campaign.llm), line('Control without LLM [CAMP]', o => o.campaign.control),
      line('Whole network [NET]', o => o.network.all));
  }
  document.addEventListener('click', e => {
    const toggle = e.target.closest('[data-toggle]'), row = toggle && toggle.closest('[data-epoch]');
    if (row) loadEpochSummary(row);
    const more = e.target.closest('[data-ev-more]');
    if (more) loadOlderEvents(more);
  });

  let eventsShown = '';
  function appendEvents(data) {
    const box = document.querySelector('[data-rows="events"]');
    $$('[data-ev-more]', box).forEach(node => node.remove());
    box.append(...data.events.map(eventRow));
    if (data.next) box.append(el('button', { class: 'c177', type: 'button', 'data-ev-more': data.next }, '[+] Older events'));
    if (window.ProbeUI) { window.ProbeUI.refresh('ev'); window.ProbeUI.localTimes(box); }
  }
  function renderEvents(data) {
    const box = document.querySelector('[data-rows="events"]'), text = JSON.stringify(data);
    if (box && text !== eventsShown) {   // unchanged: keep the rows, and the ones that are open
      eventsShown = text;
      box.replaceChildren();
      appendEvents(data);
    }
    return { 'event-log-newest-first': data.events.length === 0 };
  }
  async function loadOlderEvents(button) {
    button.disabled = true;
    try {
      appendEvents(await get(`api/events?view=${encodeURIComponent(view)}&before=${encodeURIComponent(button.dataset.evMore)}`));
    } catch {
      button.disabled = false;
    }
  }

  // ---- Operators [CAMP] [NET] [CHAIN]
  const ABOVE_TIP = "The lower bound of this operator's 95% CI is above the rate of all other operators in this view.";
  const WEIGHT_TIP = '(0.6 x own stake + 0.4 x delegated stake)^0.5, GenLayer docs.';
  const MIN_VOTES = 10;   // fewer votes with LLM than this: too few to compare
  const STATUS_CLASS = { Active: 'c50', Quarantined: 'c51', Banned: 'c52' };
  const gen = n => Math.round(n).toLocaleString('en-US');

  function renderOperators(list) {
    const desk = document.querySelector('[data-rows="ops-desk"]'), mob = document.querySelector('[data-rows="ops-mob"]');
    if (!desk || !mob) return true;
    $$('[data-table-row="ops"]').forEach(node => node.remove());
    const all = list.reduce((s, o) => ({ votes: s.votes + o.campaign_llm.votes, timeout: s.timeout + o.campaign_llm.timeout }), { votes: 0, timeout: 0 });
    // First leader of each campaign transaction against the eligible set in effect at its block
    // (validators active, not banned and not quarantined, by selection weight). Nobody is filtered out: a validator
    // that was eligible and never led is in the table with what was expected of it.
    const drawn = list.filter(o => o.leader && (o.leader.expected > 0 || o.leader.first > 0));
    const led = o => o.campaign_llm.led + o.campaign_control.led;
    const leaders = drawn.reduce((s, o) => s + o.leader.first, 0);

    for (const o of list) {
      const llm = o.campaign_llm, ctl = o.campaign_control, net = o.network;
      const name = o.moniker || '(no declared name)';
      const rate = llm.votes ? llm.timeout / llm.votes : null;
      const rest = all.votes - llm.votes ? (all.timeout - llm.timeout) / (all.votes - llm.votes) : null;
      // 2: above the rest, 1: not above, 0: too few votes to compare
      const above = llm.votes < MIN_VOTES || rest == null ? 0 : window.ProbeStats.clopperPearson(llm.timeout, llm.votes)[0] > rest ? 2 : 1;
      const campLed = led(o), campLt = llm.leader_timeouts + ctl.leader_timeouts;
      const data = { 'data-row': '', 'data-table-row': 'ops', 'data-search': `${name.toLowerCase()} ${o.address}`, 'data-s-nm': name.toLowerCase(), 'data-s-st': o.status,
        'data-s-lv': llm.votes, 'data-s-to': rate == null ? -1 : rate, 'data-s-sp': rate == null ? -1 : rate, 'data-s-cv': ctl.votes, 'data-s-ct': ctl.timeout,
        'data-s-cd': ctl.dv, 'data-s-nv': net.votes, 'data-s-ld': campLed, 'data-s-nl': net.led, 'data-s-ab': above };
      const splitTip = `Agree ${int(llm.agree)}, Content disagreement ${int(llm.disagree)}, DV ${int(llm.dv)}, Timeout ${int(llm.timeout)}`;
      const split = () => (llm.agree + llm.disagree + llm.dv + llm.timeout ? stacked({ ...llm, total: llm.agree + llm.disagree + llm.dv + llm.timeout }, 10) : 'n/a');
      const status = () => el('span', { class: STATUS_CLASS[o.status] || 'c7' }, o.status + (o.status === 'Banned' && o.banned_until ? ` until epoch ${o.banned_until}` : ''));
      const stake = o.stake ? `Stake: own ${gen(o.stake.own)} GEN · delegated ${gen(o.stake.delegated)} GEN` : 'Stake: not read yet';
      const weight = o.weight == null ? 'not read yet' : o.weight.toFixed(1);
      const selected = o.leader ? `First leader of ${int(o.leader.first)} campaign transactions, expected ${o.leader.expected.toFixed(1)} from its weight`
        : `Leader rounds in campaign transactions: ${int(campLed)}`;
      const chain = () => el('span', { class: 'c80', title: 'Read directly from the staking contract.' }, '[CHAIN]');
      const explorer = () => el('a', { href: EXPLORER + o.address, target: '_blank', rel: 'noopener' }, 'More on the explorer');
      const epochRate = e => (e.llm_votes ? pct(e.llm_timeout / e.llm_votes) : 'no votes');

      desk.append(el('div', { ...data, class: 'c73' },
        el('div', { class: 'c137' },
          el('div', { class: 'c138' }, el('button', { class: 'c139', type: 'button', 'data-toggle': '' }, el('span', { 'data-sign': '' }, '[+]')),
            el('div', { class: 'c140' }, el('div', { class: o.moniker ? 'c141' : 'c152' }, name),
              el('div', { class: 'c142' }, address(o.address), el('button', { class: 'c143', type: 'button', title: 'Copy full address', 'data-copy': o.address }, '[copy]')))),
          el('div', { class: 'c108' }, status()),
          el('div', { class: 'c110' }, int(llm.votes)),
          el('div', { class: 'c110' }, el('div', { class: 'c79' }, rate == null ? 'n/a' : pct(rate)), el('div', { class: 'c77' }, `${int(llm.timeout)} / ${int(llm.votes)}`)),
          el('div', { class: 'c145', title: splitTip }, split()),
          el('div', { class: 'c110' }, int(ctl.votes)),
          el('div', { class: 'c110' }, int(ctl.timeout)),
          el('div', { class: 'c110' }, int(ctl.dv)),
          el('div', { class: 'c110' }, int(net.votes)),
          el('div', { class: 'c110' }, `${int(campLed)} / ${int(campLt)}`),
          el('div', { class: 'c110' }, `${int(net.led)} / ${int(net.leader_timeouts)}`),
          el('div', { class: 'c108' }, above === 2 ? el('span', { class: 'c146', title: ABOVE_TIP }, '[ABOVE REST]') : above === 0 ? el('span', { class: 'c151', title: ABOVE_TIP }, 'Too few votes to compare') : null)),
        el('div', { class: 'contents', 'data-detail': '', hidden: '' }, el('div', { class: 'c147' },
          el('div', { class: 'c43' },
            el('div', {}, stake + ' ', chain()),
            el('div', {}, el('span', { class: 'c5', title: WEIGHT_TIP }, 'Selection weight'), `: ${weight} `, chain()),
            el('div', {}, selected),
            el('div', { class: 'c148' }, o.address),
            explorer()),
          el('div', {}, el('div', { class: 'c86' }, 'By epoch'),
            el('div', { class: 'c149' }, el('span', {}, 'Epoch'), el('span', {}, 'Votes with LLM'), el('span', { class: 'c55' }, 'Timeout LLM'), el('span', { class: 'c55' }, 'DV'), el('span', { class: 'c55' }, 'Leader TO')),
            o.by_epoch.map(e => el('div', { class: 'c150' }, el('span', {}, String(e.epoch)), el('span', {}, int(e.llm_votes)), el('span', { class: 'c55' }, epochRate(e)),
              el('span', { class: 'c55' }, int(e.llm_dv)), el('span', { class: 'c55' }, int(e.leader_timeouts)))))))));

      mob.append(el('div', { ...data, class: 'c94' },
        el('div', { class: 'c95' }, el('span', { class: o.moniker ? 'c141' : 'c152' }, name), el('span', { class: 'c79' }, rate == null ? 'n/a' : pct(rate))),
        el('div', { class: 'c96' }, el('span', {}, address(o.address)), el('span', {}, `timeout with LLM, n = ${int(llm.votes)}`)),
        el('button', { class: 'c97', type: 'button', 'data-toggle': '' }, el('span', { 'data-sign': '' }, '[+]'), ' Details'),
        el('div', { class: 'contents', 'data-detail': '', hidden: '' }, el('div', { class: 'c153' },
          el('div', {}, 'Status: ', status()),
          el('div', { class: 'c46' }, 'Split with LLM: ', split()),
          el('div', {}, `Control: ${int(ctl.votes)} votes, ${int(ctl.timeout)} timeouts, ${int(ctl.dv)} DV`),
          el('div', {}, `Network: ${int(net.votes)} votes`),
          el('div', {}, `Led / Leader timeouts: campaign ${int(campLed)} / ${int(campLt)}, network ${int(net.led)} / ${int(net.leader_timeouts)}`),
          el('div', {}, 'Above rest: ', above === 2 ? el('span', { class: 'c52' }, '[ABOVE REST]') : el('span', { class: 'c7' }, above === 0 ? 'Too few votes' : 'No')),
          el('div', {}, stake),
          el('div', {}, `Selection weight: ${weight}`),
          el('div', {}, selected),
          o.by_epoch.map(e => el('div', { class: 'c154' }, `Epoch ${e.epoch}: timeout ${epochRate(e)}, DV ${int(e.llm_dv)}, leader TO ${int(e.leader_timeouts)}`)),
          el('div', { class: 'c155' }, el('button', { class: 'c156', type: 'button', 'data-copy': o.address }, '[copy] address'), (() => { const a = explorer(); a.className = 'c157'; return a; })())))));
    }
    if (window.ProbeUI) window.ProbeUI.refresh('ops');

    // committee selection check: are leaders drawn in proportion to stake weight?
    const box = document.querySelector('[data-rows="committee"]'), pEl = document.querySelector('[data-committee-p]');
    const rows = drawn.slice().sort((a, b) => b.leader.expected - a.leader.expected);
    const enough = rows.filter(o => o.leader.expected > 0).length > 1 && leaders > 0;
    if (box && pEl && enough) {
      const fit = window.ProbeStats.chiSquare(rows.map(o => o.leader.first), rows.map(o => o.leader.expected));
      const outside = rows.filter(o => o.leader.expected === 0).length;
      pEl.className = 'c64';
      pEl.textContent = `chi-square p = ${fit.p < 0.01 ? fit.p.toExponential(1) : fit.p.toFixed(2)}`;
      pEl.title = `${int(leaders)} campaign transactions, by first leader, against the eligible set in effect at each one (validators active, not banned and not quarantined): ${rows.length - outside} validators, ${fit.df} degrees of freedom.`
        + (outside ? ` ${outside} led without being in the eligible set and are left out of the test.` : '');
      box.replaceChildren(...rows.map((o, i) => el('div', { class: i % 2 ? 'c165' : 'c162' },
        el('span', { class: o.moniker ? 'c163' : 'c166', title: o.address }, (o.moniker || '(no declared name)') + ' ', el('span', { class: 'c164' }, address(o.address))),
        el('span', { class: 'c55' }, pct(o.leader.expected / leaders)), el('span', { class: 'c55' }, int(o.leader.first)), el('span', { class: 'c55' }, o.leader.expected.toFixed(1)))));
    }
    return { 'votes-per-operator': !list.some(o => o.network.votes || o.network.led), 'committee-selection-check': !enough };
  }

  // ---- the blocks that depend on the view
  const OPERATORS = ['votes-per-operator', 'committee-selection-check'];
  const OVERVIEW = ['network-wide-first-attempt-acceptance', 'first-attempt-acceptance-contracts-with-llm-calls',
    'first-attempt-acceptance-control-without-llm', 'what-goes-wrong-votes', 'what-goes-wrong-attempts', 'time-to-acceptance',
    'operators-timing-out', 'last-campaign', 'validators'];
  const CONTRACTS = ['a-reference-contracts', 'b-network-contracts', 'c-stalled-contracts'];
  const EVENTS = ['event-log-newest-first'];

  // ---- The campaign runs once a day, so a new epoch has no campaign for hours. While the current
  // epoch has none, its campaign blocks stay empty and each section says when the next campaign is
  // expected, with a button to the epoch of the last one. While a campaign is running the sections
  // say so and the blocks show what there is so far. An earlier epoch picked by hand is shown as it is.
  const CAMP_BLOCKS = ['first-attempt-acceptance-contracts-with-llm-calls', 'first-attempt-acceptance-control-without-llm', 'what-goes-wrong-votes',
    'what-goes-wrong-attempts', 'time-to-acceptance', 'operators-timing-out', 'a-reference-contracts', 'committee-selection-check'];
  const WAITING = 'Waiting for the next campaign.';
  const emptyText = new Map();   // block -> the text of its "no data" state, when it is not the usual one
  const campaignTx = o => o.campaign.llm.tx + o.campaign.control.tx;
  const isCurrent = selected => !!(meta && meta.epoch) && selected === `epoch:${meta.epoch.number}`;
  const markWaiting = waiting => { for (const key of CAMP_BLOCKS) { if (waiting) emptyText.set(key, WAITING); else emptyText.delete(key); } };

  // The 3-hour bucket of a UTC day the campaign runs in: bucket number (day of the year mod 8), the
  // rule of collector/campaign/slot.mjs. Seconds.
  function campaignSlot(now) {
    const d = new Date(now * 1000);
    const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
    const dayOfYear = Math.floor((day - Date.UTC(d.getUTCFullYear(), 0, 1) / 1000) / 86400) + 1;
    return { day, start: day + (dayOfYear % 8) * 10800, end: day + (dayOfYear % 8 + 1) * 10800 };
  }
  // the bucket of the next campaign: today's while it has not ended and has no campaign, tomorrow's otherwise
  function nextSlot(now, lastStarted) {
    const today = campaignSlot(now);
    return now < today.end && !(lastStarted >= today.start) ? today : campaignSlot(today.day + 86400);
  }
  // the newest epoch before the current one that has campaign transactions, or null
  function lastCampaignEpoch() {
    const ts = meta.updated.campaign;
    const earlier = meta.epochs.filter(e => e.epoch < meta.epoch.number && e.since != null && ts != null && e.since <= ts).map(e => e.epoch);
    return earlier.length ? Math.max(...earlier) : null;
  }

  // The notice of the sections, from the overview of the selected view. Returns whether the current
  // epoch is still waiting for its campaign.
  function campaignNote(o, selected) {
    const current = isCurrent(selected), last = o.last_campaign;
    const waiting = current && !campaignTx(o);
    let parts = null;
    if (current && last && last.status === 'running') {
      parts = [el('span', {}, `Campaign running since ${clock(new Date(last.started * 1000))}. Results appear as transactions finish.`)];
    } else if (waiting) {
      const slot = nextSlot(meta.now, last ? last.started : null);
      const hm = ts => (ts === slot.day + 86400 ? '24:00' : clock(new Date(ts * 1000)).replace(' UTC', ''));
      const m = lastCampaignEpoch();
      const day = new Date(slot.start * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
      parts = [el('span', {}, `Next campaign: ${day}, ${hm(slot.start)} to ${hm(slot.end)} UTC. Campaign data for this epoch appears once it runs.`),
        m == null ? null : el('button', { class: 'c63', type: 'button', 'data-camp-view': `epoch:${m}` }, `See the last campaign (epoch ${m})`)];
    }
    $$('[data-camp-note]').forEach(node => {
      node.hidden = !parts;
      node.replaceChildren(...(parts || []).filter(Boolean).map(p => p.cloneNode(true)));
    });
    return waiting;
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-camp-view]');
    if (b) document.dispatchEvent(new CustomEvent('probe:viewchange', { detail: { view: b.dataset.campView } }));
  });

  function loadView() {
    const selected = view, q = view ? '?view=' + encodeURIComponent(view) : '';
    const now = Math.floor(Date.now() / 1000);
    const overview = get('api/overview' + q);
    const waiting = overview.then(o => isCurrent(selected) && !campaignTx(o)).catch(() => false);
    group(OVERVIEW, () => overview, o => { markWaiting(campaignNote(o, selected)); return renderOverview(o); });
    group(CONTRACTS, () => Promise.all([get('api/contracts' + q), waiting]), ([c, w]) => {
      markWaiting(w);
      return { 'a-reference-contracts': renderReference(c.reference), 'b-network-contracts': renderNetwork(c.network, now), 'c-stalled-contracts': renderStalled(c.stalled || []) };
    });
    group(OPERATORS, () => Promise.all([get('api/operators' + q), waiting]), ([o, w]) => { markWaiting(w); return renderOperators(o.operators); });
    group(EVENTS, () => get('api/events' + q), renderEvents);
  }

  // ---- How it works: data downloads. The list is the index that the daily export writes in the
  // "data" branch of the repository: { files: [{ epoch, csv, jsonl }] }, one entry per epoch that exists.
  async function loadDownloads() {
    const box = document.querySelector('[data-downloads]');
    if (!box) return;
    try {
      const { files } = await get(DATA_RAW + 'index.json');
      for (const f of files) dataFiles.set(f.epoch, f);
      const names = files.sort((a, b) => b.epoch - a.epoch).flatMap(f => [f.csv, f.jsonl]).filter(name => /^[\w.-]+$/.test(name || ''));
      if (!names.length) throw new Error('empty');
      box.replaceChildren(...names.map(name => el('a', { href: DATA_RAW + name, target: '_blank', rel: 'noopener' }, name)));
    } catch {
      box.replaceChildren('No data files published yet.');
    }
  }

  document.addEventListener('probe:viewchange', e => {
    view = e.detail.view;
    $$('[data-view-select]').forEach(select => { select.value = view; });
    for (const key of [...OVERVIEW, ...CONTRACTS, ...OPERATORS, ...EVENTS]) loaded.delete(key);
    loadView();
  });

  const every = (ms, fn) => setInterval(() => { if (!document.hidden) fn(); }, ms);
  loadTape(); every(TAPE_MS, loadTape);
  Promise.all([loadMeta(), loadDownloads()]).then(loadView);
  every(META_MS, loadMeta);
  every(VIEW_MS, loadView);
})();
