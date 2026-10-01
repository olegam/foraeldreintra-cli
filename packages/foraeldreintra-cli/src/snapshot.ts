import {
  hash,
  type Item,
  type Result,
} from "../../foraeldreintra-api-client/src/content";
export interface Snapshot {
  version: 1;
  scope: string;
  observedAt: string;
  records: Record<string, { hash: string; item: Item }>;
}
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((k) => !["localPath", "error"].includes(k))
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
export const contentHash = (item: Item) =>
  hash(JSON.stringify(canonical(item)));
export function compare(result: Result, scope: string, previous?: Snapshot) {
  if (!result.complete || result.status === "unsupported")
    throw new Error("Incomplete results cannot update a baseline.");
  if (previous && previous.scope !== scope)
    throw new Error("Snapshot scope mismatch.");
  const records = { ...previous?.records },
    added: Item[] = [],
    changed: Item[] = [],
    discovered: Item[] = [];
  for (const item of result.items) {
    const digest = contentHash(item),
      old = records[item.id];
    if (previous) {
      if (old && old.hash !== digest) changed.push(item);
      else if (!old) {
        // Unknown-age and historical discoveries are not announced as new.
        if (
          item.createdAt &&
          isNewer(item.createdAt, item.timezone, previous.observedAt)
        )
          added.push(item);
        else discovered.push(item);
      }
    }
    records[item.id] = { hash: digest, item };
  }
  const snapshot: Snapshot = {
    version: 1,
    scope,
    observedAt: result.observedAt,
    records,
  };
  return {
    snapshot,
    changes: {
      baseline: !previous,
      added,
      changed,
      discovered,
      unchanged:
        result.items.length - added.length - changed.length - discovered.length,
      missing: previous
        ? Object.keys(previous.records).filter(
            (k) => !result.items.some((i) => i.id === k),
          )
        : [],
      note: "Missing means absent from this scan, not deleted or cancelled. Discovered items have old or unknown creation times.",
    },
  };
}

// Local source timestamps explicitly carry the school timezone. Date-only values
// cannot establish a same-day creation time and remain historical discoveries.
function isNewer(source: string, timezone: string, cutoff: string): boolean {
  if (!source.includes("T")) return source > cutoff.slice(0, 10);
  if (/[zZ]|[+-]\d\d:\d\d$/.test(source))
    return Date.parse(source) > Date.parse(cutoff);
  const wall = Date.parse(source + "Z");
  if (!Number.isFinite(wall)) return false;
  let utc = wall;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let n = 0; n < 3; n++) {
    const p = Object.fromEntries(
      formatter.formatToParts(new Date(utc)).map((x) => [x.type, x.value]),
    );
    const shown = Date.parse(
      `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`,
    );
    utc = wall - (shown - utc);
  }
  return utc > Date.parse(cutoff);
}
