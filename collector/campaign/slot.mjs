// Decides whether this dispatch is today's campaign slot.
//
// An external cron (cron-job.org) dispatches the workflow every 3 hours. The UTC day is split into
// 8 buckets of 3 hours; the campaign runs only in bucket (day of year mod 8), so over 8 days it
// visits 8 different hours. Any 3-hour cadence works, whatever minute or timezone the cron uses.
//
//   node collector/campaign/slot.mjs            prints the decision; with GITHUB_OUTPUT set,
//                                               also writes run=true|false for the next steps
//   FORCE=true node collector/campaign/slot.mjs always run (manual dispatch)

import { appendFileSync } from "node:fs";

export function slotFor(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((date.getTime() - start) / 86_400_000) + 1;
  return { bucket: Math.floor(date.getUTCHours() / 3), turn: dayOfYear % 8, dayOfYear };
}

const now = new Date();
const { bucket, turn, dayOfYear } = slotFor(now);
const force = process.env.FORCE === "true";
const run = force || bucket === turn;
console.log(`${now.toISOString()} UTC: day ${dayOfYear}, bucket ${bucket} (${bucket * 3}:00-${bucket * 3 + 2}:59 UTC), `
  + `today's turn ${turn} (${turn * 3}:00-${turn * 3 + 2}:59 UTC) -> ${run ? "run" : "skip"}${force ? " (forced)" : ""}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
