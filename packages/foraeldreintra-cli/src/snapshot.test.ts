import { test, expect } from "bun:test";
import { compare, contentHash } from "./snapshot";
import type { Item, Result } from "@foraeldreintra/api-client";
const item: Item = {
  id: "a",
  kind: "news",
  childId: "1",
  sourceUrl: "https://school.m.skoleintra.dk/a",
  title: "A",
  createdAt: "2026-01-01",
  modifiedAt: null,
  timezone: "Europe/Copenhagen",
  content: { text: "Old", html: "Old" },
  attachments: [],
  data: {},
};
const result: Result = {
  schemaVersion: 1,
  school: "https://school.m.skoleintra.dk",
  child: { id: "1", name: "A", path: "/parent/1/A" },
  area: "news",
  sourceUrl: "https://school.m.skoleintra.dk",
  observedAt: "2026-10-01T12:00:00Z",
  status: "ok",
  complete: true,
  items: [item],
  warnings: [],
  next: null,
};
test("first scan baselines old unread items; repeated scan is quiet", () => {
  const first = compare(result, "scope");
  expect(first.changes.baseline).toBe(true);
  expect(first.changes.added).toEqual([]);
  const next = compare(result, "scope", first.snapshot);
  expect(next.changes.changed).toEqual([]);
  expect(next.changes.added).toEqual([]);
});
test("edits and historical discoveries are distinct from new records", () => {
  const first = compare(result, "scope");
  const second = compare(
    {
      ...result,
      items: [
        { ...item, content: { text: "Edited", html: "Edited" } },
        { ...item, id: "old" },
        { ...item, id: "new", createdAt: "2026-10-02" },
      ],
    },
    "scope",
    first.snapshot,
  );
  expect(second.changes.changed.map((i) => i.id)).toEqual(["a"]);
  expect(second.changes.discovered.map((i) => i.id)).toEqual(["old"]);
  expect(second.changes.added.map((i) => i.id)).toEqual(["new"]);
});
test("incomplete reads cannot replace good baselines and missing records are retained", () => {
  const first = compare(result, "scope");
  expect(() =>
    compare({ ...result, complete: false }, "scope", first.snapshot),
  ).toThrow();
  const next = compare({ ...result, items: [] }, "scope", first.snapshot);
  expect(next.snapshot.records.a).toBeDefined();
  expect(next.changes.missing).toEqual(["a"]);
});
test("attachment bytes affect comparison; local paths do not", () => {
  const a = {
    ...item,
    attachments: [
      {
        id: "x",
        name: "a.pdf",
        url: "https://school.m.skoleintra.dk/a.pdf",
        mediaType: "application/pdf",
        size: 10,
        sha256: "a",
        localPath: "/tmp/a",
      },
    ],
  };
  expect(contentHash(a)).toBe(
    contentHash({
      ...a,
      attachments: [{ ...a.attachments[0]!, localPath: "/tmp/b" }],
    }),
  );
  expect(contentHash(a)).not.toBe(
    contentHash({ ...a, attachments: [{ ...a.attachments[0]!, sha256: "b" }] }),
  );
});
test("same-day new content respects the source timezone", () => {
  const first = compare(result, "scope");
  const next = compare(
    {
      ...result,
      items: [{ ...item, id: "same-day", createdAt: "2026-10-01T15:00:00" }],
    },
    "scope",
    first.snapshot,
  );
  expect(next.changes.added.map((x) => x.id)).toEqual(["same-day"]);
  const old = compare(
    {
      ...result,
      items: [{ ...item, id: "earlier", createdAt: "2026-10-01T13:00:00" }],
    },
    "scope",
    first.snapshot,
  );
  expect(old.changes.discovered.map((x) => x.id)).toEqual(["earlier"]);
});
