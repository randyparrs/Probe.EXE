// When the campaign runs. Since 2026-10-06 the schedule follows the epochs: one campaign per epoch,
// in a 3-hour window that starts (epoch number mod 8) x 3 hours after the epoch starts, so over 8
// epochs it visits 8 different hours. An epoch that lasts more than a day gets a further window
// every 24 hours, so the cadence stays daily; one of those counts only when the epoch has lasted
// more than 25 hours by then (epochs last about 24 h 2 min, so the next one is about to start).
//
// A window that passes with fewer campaigns than windows is made up at the next dispatch, and that
// campaign is late. An epoch that ends with no campaign is a failed campaign. Before 2026-10-06 the
// campaign ran in one 3-hour bucket of the UTC day: bucket number (day of year mod 8).
//
// probe-static/data.js repeats windowsOf for the notice of the next campaign.

export const SCHEDULE_SINCE = Date.UTC(2026, 9, 6) / 1000;   // epochs that start from then on follow this rule
export const WINDOW_SECONDS = 3 * 3600;
export const DAY_SECONDS = 24 * 3600;
export const LONG_EPOCH_SECONDS = 25 * 3600;
export const offsetOf = (epoch) => (epoch % 8) * WINDOW_SECONDS;

// The windows of an epoch that started at `start`, those that open up to `until`: [{ start, end }].
export function windowsOf(epoch, start, until) {
  const out = [];
  for (let k = 0; ; k++) {
    const s = start + k * DAY_SECONDS + offsetOf(epoch);
    if (s > until) return out;
    if (k === 0 || s - start > LONG_EPOCH_SECONDS) out.push({ start: s, end: s + WINDOW_SECONDS });
  }
}

// Whether a dispatch at `now` runs a campaign in an epoch that started at `start`. campaigns: start
// times of the campaigns already seen in the epoch, or null when they could not be read; then it
// runs only inside an open window, so a missed window is not made up and at most one more runs.
// Returns { run, late, window, reason }; window: the one the campaign is for, or the next one.
export function decide({ epoch, start, now, campaigns }) {
  const open = windowsOf(epoch, start, now);
  if (!open.length) {
    return { run: false, late: false, window: windowsOf(epoch, start, start + offsetOf(epoch))[0], reason: "before the window of the epoch" };
  }
  const last = open.at(-1);
  if (campaigns == null) {
    const inside = now < last.end;
    return { run: inside, late: false, window: last, reason: inside ? "campaigns of the epoch unknown, inside a window" : "campaigns of the epoch unknown, outside a window" };
  }
  if (campaigns.length >= open.length) return { run: false, late: false, window: last, reason: "the epoch has its campaign" };
  const due = open[campaigns.length];
  return { run: true, late: now >= due.end, window: due, reason: now >= due.end ? "window passed with no campaign: late" : "inside the window" };
}

// Whether each campaign of an epoch is late: the n-th campaign answers the n-th window and is late
// when it started after that window ended. starts: start times of the campaigns, oldest first.
// Epochs that started before SCHEDULE_SINCE have no late campaigns.
export function lateOf(epoch, start, starts) {
  if (start == null || start < SCHEDULE_SINCE) return starts.map(() => false);
  return starts.map((t, i) => {
    const w = windowsOf(epoch, start, t)[i];
    return w != null && t >= w.end;
  });
}

// The 3-hour bucket of the UTC day that held the campaign before SCHEDULE_SINCE, in seconds.
export function dailySlot(now) {
  const d = new Date(now * 1000);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  const dayOfYear = Math.floor((day - Date.UTC(d.getUTCFullYear(), 0, 1) / 1000) / 86400) + 1;
  return { start: day + (dayOfYear % 8) * WINDOW_SECONDS, end: day + (dayOfYear % 8 + 1) * WINDOW_SECONDS };
}
