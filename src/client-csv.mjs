import { fail } from "./security.mjs";

export const CSV_MAX_BYTES = 1048576;
export const CSV_MAX_ROWS = 1000;
const unsafeCell = (v) => /^[\s]*[=+\-@]|^[\t\r\n']/u.test(v);
export function csvCell(value) {
  let v = String(value ?? "");
  if (unsafeCell(v)) v = "'" + v;
  return '"' + v.replaceAll('"', '""') + '"';
}
export function decodeReiCell(v) {
  return v.startsWith("'") && unsafeCell(v.slice(1)) ? v.slice(1) : v;
}
export function parseCSV(input, delimiter = "auto") {
  if (typeof input !== "string" || !input.trim())
    fail(400, "Choose a non-empty CSV file.");
  if (new TextEncoder().encode(input).length > CSV_MAX_BYTES)
    fail(413, "CSV files must be 1 MiB or smaller.");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(input))
    fail(400, "Save the file as UTF-8 CSV without control characters.");
  const csv = input.replace(/^\uFEFF/, "");
  if (!["auto", ",", ";", "\t"].includes(delimiter))
    fail(400, "Choose comma, semicolon or tab as the separator.");
  if (delimiter === "auto") {
    const counts = new Map([
      [",", 0],
      [";", 0],
      ["\t", 0],
    ]);
    let quoted = false;
    for (let i = 0; i < csv.length; i++) {
      const c = csv[i];
      if (c === '"') {
        if (quoted && csv[i + 1] === '"') i++;
        else quoted = !quoted;
      } else if (!quoted) {
        if (c === "\n" || c === "\r") break;
        if (counts.has(c)) counts.set(c, counts.get(c) + 1);
      }
    }
    const sorted = [...counts].sort((a, b) => b[1] - a[1]);
    if (sorted[0][1] && sorted[0][1] === sorted[1][1])
      fail(400, "The separator is ambiguous. Select it explicitly.");
    delimiter = sorted[0][0];
  }
  const rows = [];
  let row = [],
    field = "",
    mode = "start";
  const endField = () => {
    row.push(field);
    field = "";
    mode = "start";
    if (row.length > 40) fail(400, "CSV files can have at most 40 columns.");
  };
  const endRow = () => {
    endField();
    if (row.some((v) => v.trim())) rows.push(row);
    row = [];
    if (rows.length > CSV_MAX_ROWS + 1)
      fail(
        400,
        "Import at most 1,000 clients per file. Split larger files first.",
      );
  };
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (mode === "quoted") {
      if (c === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i++;
        } else mode = "closed";
      } else field += c;
    } else if (c === delimiter) endField();
    else if (c === "\r" || c === "\n") {
      if (c === "\r" && csv[i + 1] === "\n") i++;
      endRow();
    } else if (c === '"' && mode === "start") mode = "quoted";
    else {
      if (mode === "closed" || c === '"')
        fail(400, "Malformed CSV quoting. Export the file again as CSV.");
      field += c;
      mode = "plain";
    }
    if (field.length > 8000)
      fail(400, "A CSV cell is too long (maximum 8,000 characters).");
  }
  if (mode === "quoted") fail(400, "A quoted CSV cell is not closed.");
  if (row.length || field || mode === "closed") endRow();
  const headers = rows.shift();
  if (!headers?.length || !rows.length)
    fail(400, "Include a header and at least one client row.");
  if (headers.some((v) => !v.trim() || v.length > 150))
    fail(400, "Each column needs a header of 1–150 characters.");
  if (rows.some((r) => r.length !== headers.length))
    fail(400, "Every row must have the same number of columns as the header.");
  return { headers, rows, delimiter };
}
export function isReiExport(headers) {
  return (
    JSON.stringify(headers) ===
      JSON.stringify(["Rei client ID", "Full name", "Phone", "Email"]) ||
    JSON.stringify(headers) ===
      JSON.stringify(["Rei client ID", "Full name", "Phone", "Email", "Notes"])
  );
}
