import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  parseHistoryCSV,
  freshaHistoryPreset,
  validateHistoryMapping,
  historySourceValues,
  historyFileDigest,
  historyChunk,
  historyTime,
} from "../public/history-preview-helpers.js";

test("history CSV preserves text identity, Unicode, quoted delimiters and multiline source values", () => {
  const parsed = parseHistoryCSV(
    '\uFEFFClient;Appt. ref.;Note\r\n"Fictional, Guest";0007;"First line\nA ""quoted"" source value"\r\n',
  );
  assert.equal(parsed.delimiter, ";");
  assert.deepEqual(parsed.headers, ["Client", "Appt. ref.", "Note"]);
  assert.deepEqual(parsed.rows, [
    ["Fictional, Guest", "0007", 'First line\nA "quoted" source value'],
  ]);
  assert.deepEqual(
    parseHistoryCSV("Client\tReference\nFictional Ž Guest\t00001\n", "\t").rows,
    [["Fictional Ž Guest", "00001"]],
  );
});

test("the documented history limits support 50,000 rows and 128 columns without splitting", () => {
  const text =
    "Client,Reference\n" +
    Array.from(
      { length: 50000 },
      (_, i) => `Fictional Guest,${String(i).padStart(6, "0")}`,
    ).join("\n");
  assert.equal(parseHistoryCSV(text).rows.length, 50000);
  assert.throws(
    () => parseHistoryCSV(text + "\nFictional Guest,50000"),
    /50,000/,
  );
  const wide = Array.from({ length: 128 }, (_, i) => `Column${i}`);
  assert.equal(
    parseHistoryCSV(wide.join(",") + "\n" + wide.join(",")).headers.length,
    128,
  );
  assert.throws(
    () =>
      parseHistoryCSV(
        [...wide, "Extra"].join(",") + "\n" + [...wide, "Extra"].join(","),
      ),
    /128/,
  );
});

test("CSV rejects malformed quoting, inconsistent width, controls and oversized UTF-8 cells", () => {
  assert.throws(
    () => parseHistoryCSV('Client,Reference\n"Unclosed,1'),
    /not closed/,
  );
  assert.throws(
    () => parseHistoryCSV('Client,Reference\n"Closed"oops,1'),
    /malformed quoting/,
  );
  assert.throws(
    () => parseHistoryCSV("Client,Reference\nFictional,1,extra"),
    /same number/,
  );
  assert.throws(
    () => parseHistoryCSV("Client,Reference\nFictional\0,1"),
    /control characters/,
  );
  assert.throws(
    () => parseHistoryCSV("Client,Reference\n" + "ž".repeat(8193) + ",1"),
    /16 KiB/,
  );
  assert.equal(
    parseHistoryCSV("Client,Reference\n" + "ž".repeat(8192) + ",1").rows.length,
    1,
  );
  assert.throws(
    () => parseHistoryCSV("Client,Reference;Other\nFictional,1;other"),
    /ambiguous/,
  );
});

test("Fresha suggestions use exact unique headers and do not invent identity or completion evidence", () => {
  const preset = freshaHistoryPreset([
    "Appt. ref.",
    "Client",
    "Team member",
    "Scheduled date",
    "Duration (mins)",
    "Status",
    "Net sales",
  ]);
  assert.deepEqual(preset.mapping, {
    appointmentRef: 0,
    clientName: 1,
    therapistName: 2,
    scheduledDate: 3,
    duration: 4,
    status: 5,
    netSales: 6,
  });
  assert.equal(preset.format.dateTimeFormat, "fresha-en");
  assert.equal(preset.format.completionMap, undefined);
  assert.equal(preset.format.sourceTimeZone, undefined);
  assert.equal(preset.format.money, undefined);
  assert.equal(
    freshaHistoryPreset(["Client", "Client"]).mapping.clientName,
    undefined,
  );
  assert.equal(
    freshaHistoryPreset(["Client ID"]).mapping.clientSourceId,
    undefined,
  );
});

test("mapping requires distinct source columns and an explicit schedule/duration selection", () => {
  assert.deepEqual(
    validateHistoryMapping({ scheduledDate: 2, duration: 3, clientName: 0 }, 4),
    { scheduledDate: 2, duration: 3, clientName: 0 },
  );
  assert.throws(
    () => validateHistoryMapping({ scheduledDate: 2, duration: 2 }, 4),
    /only once/,
  );
  assert.throws(
    () => validateHistoryMapping({ scheduledDate: 2 }, 4),
    /scheduled date and duration/,
  );
  assert.throws(
    () => validateHistoryMapping({ scheduledDate: 2, duration: 5 }, 4),
    /valid source column/,
  );
  assert.throws(
    () =>
      validateHistoryMapping(
        { scheduledDate: 2, duration: 3, guessClient: 0 },
        4,
      ),
    /valid source column/,
  );
});

test("status values are textual evidence, bounded and never inferred from past dates", () => {
  assert.deepEqual(
    historySourceValues(
      { rows: [["Started"], ["Confirmed"], [" Started "], [""]] },
      0,
    ),
    ["Confirmed", "Started"],
  );
  assert.deepEqual(historySourceValues({ rows: [["Started"]] }, null), []);
  assert.throws(
    () =>
      historySourceValues(
        { rows: Array.from({ length: 101 }, (_, i) => [String(i)]) },
        0,
      ),
    /more than 100/,
  );
});

test("file identity uses original bytes including BOM and line endings", async () => {
  const original = new TextEncoder().encode(
    "\uFEFFClient,Reference\r\nFictional Guest,0001\r\n",
  );
  const expected = createHash("sha256").update(original).digest("hex");
  assert.equal(await historyFileDigest(original), expected);
  assert.notEqual(
    await historyFileDigest(original),
    await historyFileDigest(
      new TextEncoder().encode("Client,Reference\nFictional Guest,0001\n"),
    ),
  );
});

test("upload groups are capped at 100 rows, bounded by bytes, deterministic and preserve mapped text", () => {
  const rows = Array.from({ length: 250 }, (_, i) =>
    Object.freeze([`Fictional ${i}`, "unused private column", `000${i}`]),
  );
  const parsed = Object.freeze({
    headers: Object.freeze(["Client", "Ignore", "ID"]),
    rows: Object.freeze(rows),
  });
  const mapping = { clientName: 0, clientSourceId: 2 };
  assert.equal(historyChunk(parsed, mapping, 0).length, 100);
  assert.deepEqual(
    historyChunk(parsed, mapping, 0),
    historyChunk(parsed, mapping, 0),
  );
  assert.deepEqual(historyChunk(parsed, mapping, 100)[0], [
    "Fictional 100",
    "",
    "000100",
  ]);
  assert.equal(historyChunk(parsed, mapping, 200).length, 50);
  const bounded = historyChunk(parsed, mapping, 0, 100, 100);
  assert.ok(
    new TextEncoder().encode(JSON.stringify(bounded)).byteLength <= 100,
  );
  assert.ok(bounded.length > 0 && bounded.length < 100);
  assert.equal(parsed.rows[0][1], "unused private column");
});

test("invalid source durations do not fabricate a clock beyond the end of the day", () => {
  assert.equal(historyTime(600, 60), "10:00–11:00");
  assert.equal(historyTime(1425, 15), "23:45–24:00");
  assert.equal(historyTime(600, 1500), "10:00 · exceeds this day");
  assert.equal(historyTime(600, null), "10:00 · end unknown");
  assert.equal(historyTime(null, 60), "Time unknown");
  assert.equal(historyTime(1440, 60), "Time unknown");
});
