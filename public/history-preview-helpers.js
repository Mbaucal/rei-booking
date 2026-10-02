export const HISTORY_PREVIEW_LIMITS = Object.freeze({
  rows: 50000,
  columns: 128,
  cellBytes: 16384,
  bytes: 25 * 1048576,
});
export const HISTORY_COLUMNS = Object.freeze({
  appointmentRef: "Appointment reference",
  serviceLineRef: "Service-line reference",
  clientSourceId: "Source client ID",
  clientName: "Client name",
  phone: "Phone",
  email: "Email",
  instagram: "Instagram",
  therapistName: "Therapist",
  serviceName: "Treatment",
  scheduledDate: "Scheduled date",
  slot: "Appointment time",
  duration: "Duration",
  createdAt: "Created date",
  cancelledAt: "Cancelled date",
  status: "Status",
  netSales: "Net sales",
  requested: "Requested therapist",
  roomName: "Room",
});
const freshaHeaders = {
  appointmentRef: "Appt. ref.",
  clientName: "Client",
  therapistName: "Team member",
  serviceName: "Service",
  scheduledDate: "Scheduled date",
  slot: "Appt. slot",
  duration: "Duration (mins)",
  createdAt: "Created date",
  cancelledAt: "Cancelled date",
  status: "Status",
  netSales: "Net sales",
};
const encoder = new TextEncoder();
const fail = (message) => {
  throw new Error(message);
};

// Parse the file locally before uploading. Values and textual IDs stay unchanged.
export function parseHistoryCSV(input, delimiter = "auto") {
  if (typeof input !== "string" || !input.trim())
    fail("Choose a non-empty CSV file.");
  if (encoder.encode(input).byteLength > HISTORY_PREVIEW_LIMITS.bytes)
    fail("Choose a CSV file of 25 MiB or smaller.");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(input))
    fail("Save the file as UTF-8 CSV without control characters.");
  const csv = input.replace(/^\uFEFF/, "");
  if (!["auto", ",", ";", "\t"].includes(delimiter))
    fail("Choose comma, semicolon or tab as the separator.");
  if (delimiter === "auto") {
    const counts = new Map([
      [",", 0],
      [";", 0],
      ["\t", 0],
    ]);
    let quoted = false;
    for (let i = 0; i < csv.length; i++) {
      if (csv[i] === '"') {
        if (quoted && csv[i + 1] === '"') i++;
        else quoted = !quoted;
      } else if (!quoted) {
        if (["\n", "\r"].includes(csv[i])) break;
        if (counts.has(csv[i])) counts.set(csv[i], counts.get(csv[i]) + 1);
      }
    }
    const choices = [...counts].sort((a, b) => b[1] - a[1]);
    if (choices[0][1] && choices[0][1] === choices[1][1])
      fail("The separator is ambiguous. Select it explicitly.");
    delimiter = choices[0][0];
  }
  const records = [];
  let record = [],
    field = "",
    mode = "start";
  const finishField = () => {
    if (encoder.encode(field).byteLength > HISTORY_PREVIEW_LIMITS.cellBytes)
      fail("A CSV cell exceeds 16 KiB.");
    record.push(field);
    field = "";
    mode = "start";
    if (record.length > HISTORY_PREVIEW_LIMITS.columns)
      fail("Use a CSV with at most 128 columns.");
  };
  const finishRecord = () => {
    finishField();
    if (record.some((cell) => cell.trim())) records.push(record);
    record = [];
    if (records.length > HISTORY_PREVIEW_LIMITS.rows + 1)
      fail("Preview up to 50,000 appointment rows in one file.");
  };
  for (let i = 0; i < csv.length; i++) {
    const character = csv[i];
    if (mode === "quoted") {
      if (character === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i++;
        } else mode = "closed";
      } else field += character;
    } else if (character === delimiter) finishField();
    else if (character === "\r" || character === "\n") {
      if (character === "\r" && csv[i + 1] === "\n") i++;
      finishRecord();
    } else if (character === '"' && mode === "start") mode = "quoted";
    else {
      if (mode === "closed" || character === '"')
        fail("The CSV contains malformed quoting. Export it again as CSV.");
      field += character;
      mode = "plain";
    }
    if (field.length > HISTORY_PREVIEW_LIMITS.cellBytes)
      fail("A CSV cell exceeds 16 KiB.");
  }
  if (mode === "quoted") fail("A quoted CSV cell is not closed.");
  if (record.length || field || mode === "closed") finishRecord();
  const headers = records.shift();
  if (!headers?.length || !records.length)
    fail("Include a header and at least one appointment row.");
  if (headers.some((header) => !header.trim()))
    fail("Every column needs a header.");
  if (records.some((values) => values.length !== headers.length))
    fail("Every row must have the same number of columns as its header.");
  return { headers, rows: records, delimiter };
}

export function freshaHistoryPreset(headers) {
  const mapping = {};
  for (const [key, name] of Object.entries(freshaHeaders)) {
    const indices = headers.flatMap((header, index) =>
      header.trim() === name ? [index] : [],
    );
    if (indices.length === 1) mapping[key] = indices[0];
  }
  return {
    mapping,
    format: {
      dateTimeFormat: "fresha-en",
      slotFormat: "HH:mm:ss-HH:mm:ss",
      durationFormat: "hours-minutes",
    },
  };
}

export function validateHistoryMapping(mapping, width) {
  const entries = Object.entries(mapping);
  if (
    entries.some(
      ([key, index]) =>
        !Object.hasOwn(HISTORY_COLUMNS, key) ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= width,
    )
  )
    fail("Choose a valid source column for each field.");
  if (new Set(Object.values(mapping)).size !== entries.length)
    fail("Use each source column only once.");
  if (mapping.scheduledDate == null || mapping.duration == null)
    fail("Match the scheduled date and duration columns before previewing.");
  return { ...mapping };
}

export function historySourceValues(parsed, index) {
  if (!Number.isInteger(index)) return [];
  const values = [
    ...new Set(parsed.rows.map((row) => row[index].trim()).filter(Boolean)),
  ];
  if (values.length > 100)
    fail(
      "This status or request column has more than 100 values. Check its column mapping.",
    );
  return values.sort((a, b) => a.localeCompare(b, "en"));
}

export async function historyFileDigest(bytes) {
  const value = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function historyChunk(
  parsed,
  mapping,
  offset,
  maxRows = 100,
  maxBytes = 700000,
) {
  const used = new Set(Object.values(mapping));
  const rows = [];
  let bytes = 2;
  for (
    let index = offset;
    index < Math.min(offset + maxRows, parsed.rows.length);
    index++
  ) {
    const row = parsed.rows[index].map((value, column) =>
      used.has(column) ? value : "",
    );
    const size = encoder.encode(JSON.stringify(row)).byteLength + 1;
    if (size > maxBytes)
      fail(
        "A mapped row is too large to prepare. Reduce the unusually long source values.",
      );
    if (rows.length && bytes + size > maxBytes) break;
    rows.push(row);
    bytes += size;
  }
  return rows;
}

export const historyDispositionLabel = (value) =>
  ({
    ready: "Ready for review",
    unresolved: "Needs review",
    conflict: "Conflict",
    duplicate: "Duplicate",
    invalid: "Invalid",
  })[value] || "Needs review";
export function historyTime(start, duration) {
  if (!Number.isInteger(start) || start < 0 || start >= 1440)
    return "Time unknown";
  const clock = (minute) =>
    `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  if (!Number.isInteger(duration) || duration <= 0)
    return `${clock(start)} · end unknown`;
  if (start + duration > 1440) return `${clock(start)} · exceeds this day`;
  return `${clock(start)}–${clock(start + duration)}`;
}
