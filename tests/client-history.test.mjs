import test from "node:test";
import assert from "node:assert/strict";
import { renderClientHistoryPage } from "../public/client-history.js";

const esc = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const record = (changes = {}) => ({
  id: "archive-a",
  date: "2026-01-04",
  start: 600,
  duration: 60,
  serviceName: "Former treatment",
  therapistName: "Former therapist",
  roomName: null,
  sourceStatus: "Started",
  completionState: "unknown",
  requestState: "unknown",
  importedAt: "2026-10-03T10:00:00.000Z",
  ...changes,
});
const data = (changes = {}) => ({
  clientId: "fictional-client",
  page: 0,
  pageSize: 25,
  total: 3,
  totalPages: 1,
  statusCounts: [
    { status: "Started", count: 1 },
    { status: "Cancelled", count: 1 },
    { status: "No Show", count: 1 },
  ],
  rows: [
    record(),
    record({
      id: "archive-b",
      sourceStatus: "Cancelled",
      completionState: "not_completed",
    }),
    record({
      id: "archive-c",
      sourceStatus: "No Show",
      completionState: "not_completed",
    }),
  ],
  ...changes,
});
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test("imported profile history preserves original statuses and separate global status counts", () => {
  const html = renderClientHistoryPage(data(), esc);
  assert.match(html, /Imported appointment history/);
  assert.match(html, /Bookings in Rei are shown separately/);
  assert.match(html, /<strong>1<\/strong> Cancelled/);
  assert.match(html, /<strong>1<\/strong> No Show/);
  assert.match(html, /client-history-source-status">Started/);
  assert.match(html, /<dt>Completion<\/dt><dd>Unknown<\/dd>/);
  assert.match(html, /client-history-source-status">Cancelled/);
  assert.match(html, /client-history-source-status">No Show/);
  assert.doesNotMatch(html, /<dt>Completion<\/dt><dd>Completed<\/dd>/);
});

test("operational view hides owner source evidence even if supplied by an over-broad fixture", () => {
  const input = data({
    rows: [
      record({
        sourceNetSalesMinor: 990000,
        currency: "RSD",
        provenance: { source: "sensitive-source" },
        record: {
          raw: {
            clientName: "PRIVATE_SOURCE_CLIENT",
            netSales: "PRIVATE_AMOUNT",
            phone: "PRIVATE_PHONE",
          },
        },
      }),
    ],
  });
  const reception = renderClientHistoryPage(input, esc);
  assert.doesNotMatch(
    reception,
    /PRIVATE_|990000|sensitive-source|Original source values/,
  );
  const owner = renderClientHistoryPage(input, esc, { canViewSource: true });
  assert.match(owner, /Original source values/);
  assert.match(owner, /PRIVATE_SOURCE_CLIENT/);
  assert.match(owner, /PRIVATE_AMOUNT/);
  assert.match(owner, /Client name/);
  assert.doesNotMatch(owner, /990000|sensitive-source/);
});

test("archive rendering escapes source values, statuses and identifiers without mutating snapshots", () => {
  const input = freeze(
    data({
      statusCounts: [{ status: '<svg onload="bad()">', count: 1 }],
      rows: [
        record({
          id: 'id" onclick="bad()',
          serviceName: "<script>bad()</script>",
          sourceStatus: '<img src=x onerror="bad()">',
          record: { raw: { serviceName: "<b>source</b>" } },
        }),
      ],
    }),
  );
  const before = JSON.stringify(input);
  const html = renderClientHistoryPage(input, esc, { canViewSource: true });
  assert.doesNotMatch(html, /<script>|<svg|<img|<b>source<\/b>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /id&quot; onclick=&quot;bad\(\)/);
  assert.equal(JSON.stringify(input), before);
});

test("pagination uses supplied whole-history totals, not the current page's rows", () => {
  const html = renderClientHistoryPage(
    data({
      page: 1,
      total: 53,
      totalPages: 3,
      rows: [record()],
      statusCounts: [
        { status: "Cancelled", count: 20 },
        { status: "No Show", count: 10 },
      ],
    }),
    esc,
  );
  assert.match(html, /<strong>53<\/strong> imported appointments/);
  assert.match(html, /<strong>20<\/strong> Cancelled/);
  assert.match(html, /Page 2 of 3/);
  assert.doesNotMatch(html, /id="client-history-prev" disabled/);
  assert.doesNotMatch(html, /id="client-history-next" disabled/);
  const last = renderClientHistoryPage(
    data({ page: 2, total: 53, totalPages: 3 }),
    esc,
  );
  assert.match(last, /id="client-history-next" disabled/);
});

test("empty history and missing metadata remain explicit without inventing completed visits or amounts", () => {
  const empty = renderClientHistoryPage(
    data({ rows: [], total: 0, totalPages: 0, statusCounts: [] }),
    esc,
  );
  assert.match(empty, /No imported appointment history yet/);
  assert.match(empty, /<strong>0<\/strong> Cancelled/);
  assert.match(empty, /<strong>0<\/strong> No Show/);
  const unknown = renderClientHistoryPage(
    data({
      rows: [
        record({
          sourceStatus: null,
          serviceName: null,
          date: null,
          start: null,
          duration: null,
          importedAt: null,
        }),
      ],
    }),
    esc,
  );
  assert.match(unknown, /Unknown status/);
  assert.match(unknown, /Treatment unknown/);
  assert.match(unknown, /Time unknown/);
  assert.match(unknown, /<dt>Added to history<\/dt><dd>Unknown<\/dd>/);
  assert.doesNotMatch(unknown, /NaN|undefined|Invalid Date/);
});
