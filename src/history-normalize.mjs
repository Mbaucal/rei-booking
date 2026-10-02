// Pure source normalization only. This module performs no linking or writes.
// Caller chooses date/slot/duration presets and supplies a verified timezone,
// currency precision, and exact status/request mappings where known. Missing
// facts stay nullable/unknown. info diagnostics describe optional metric gaps;
// review requires a decision, and error marks malformed/unsupported source data.
// Summary states count normalization results, never archive/import eligibility.
// interpretation and *Basis fields record supplied decisions, not approval.
export const HISTORY_LIMITS = Object.freeze({
  rows: 50000,
  columns: 128,
  cellBytes: 16384,
  bytes: 25 * 1048576,
});
export const HISTORY_FIELDS = Object.freeze([
  "appointmentRef",
  "serviceLineRef",
  "clientSourceId",
  "clientName",
  "phone",
  "email",
  "instagram",
  "therapistName",
  "serviceName",
  "scheduledDate",
  "slot",
  "duration",
  "createdAt",
  "cancelledAt",
  "status",
  "netSales",
  "requested",
  "roomName",
]);
const own = (object, key) => Object.hasOwn(object, key);
const clean = (value) => value?.trim() || null;
const configError = (message) => {
  throw new TypeError(message);
};
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const pad = (number) => String(number).padStart(2, "0");
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const DATE_FORMATS = [
  "fresha-en",
  "iso-local",
  "iso-date",
  "dmy-date",
  "mdy-date",
];
const SLOT_FORMATS = ["HH:mm:ss-HH:mm:ss", "HH:mm-HH:mm", "HH:mm"];
const completionDefaults = Object.freeze({
  Cancelled: "not_completed",
  "No Show": "not_completed",
});

function checkKeys(value, allowed, label) {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    configError(`Invalid ${label} options.`);
}
function enumMap(value, allowed, label) {
  if (
    !object(value) ||
    Object.keys(value).length > 100 ||
    Object.entries(value).some(
      ([key, state]) =>
        !key.trim() || key.length > 120 || !allowed.includes(state),
    )
  )
    configError(`Invalid ${label} mapping.`);
  return value;
}
function options(format, mapping) {
  checkKeys(
    format,
    [
      "dateTimeFormat",
      "slotFormat",
      "durationFormat",
      "money",
      "sourceTimeZone",
      "completionMap",
      "requestMap",
    ],
    "history format",
  );
  if (
    format.dateTimeFormat !== undefined &&
    !DATE_FORMATS.includes(format.dateTimeFormat)
  )
    configError("Unsupported date format.");
  if (
    ["scheduledDate", "createdAt", "cancelledAt"].some(
      (key) => mapping[key] != null,
    ) &&
    !format.dateTimeFormat
  )
    configError("Choose an explicit date format.");
  if (
    format.slotFormat !== undefined &&
    !SLOT_FORMATS.includes(format.slotFormat)
  )
    configError("Unsupported slot format.");
  if (mapping.slot != null && !format.slotFormat)
    configError("Choose an explicit slot format.");
  if (
    format.durationFormat !== undefined &&
    !["minutes", "hours-minutes"].includes(format.durationFormat)
  )
    configError("Unsupported duration format.");
  if (mapping.duration != null && !format.durationFormat)
    configError("Choose an explicit duration format.");
  const money = {
    currency: null,
    minorUnitDigits: null,
    decimalSeparator: ".",
    groupSeparator: null,
    ...(format.money || {}),
  };
  if (format.money !== undefined)
    checkKeys(
      format.money,
      ["currency", "minorUnitDigits", "decimalSeparator", "groupSeparator"],
      "money",
    );
  if (
    money.currency !== null &&
    (typeof money.currency !== "string" || !/^[A-Z]{3}$/.test(money.currency))
  )
    configError("Currency must be an explicit three-letter code or null.");
  if (
    money.minorUnitDigits !== null &&
    (!Number.isInteger(money.minorUnitDigits) ||
      money.minorUnitDigits < 0 ||
      money.minorUnitDigits > 4)
  )
    configError("Invalid currency precision.");
  if (
    ![".", ","].includes(money.decimalSeparator) ||
    ![null, ",", ".", " "].includes(money.groupSeparator) ||
    money.decimalSeparator === money.groupSeparator
  )
    configError("Invalid money separators.");
  const zone = format.sourceTimeZone ?? null;
  let formatter = null;
  if (zone !== null) {
    if (
      typeof zone !== "string" ||
      zone.length > 100 ||
      !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(zone)
    )
      configError("Invalid source timezone.");
    try {
      formatter = new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      });
    } catch {
      configError("Invalid source timezone.");
    }
  }
  return {
    ...format,
    money,
    zone,
    formatter,
    completionMap: enumMap(
      format.completionMap || {},
      ["completed", "not_completed", "unknown"],
      "completion",
    ),
    requestMap: enumMap(
      format.requestMap || {},
      ["yes", "no", "unknown"],
      "request",
    ),
  };
}

function validateInput({ headers, rows, mapping, source, fileDigest, format }) {
  if (
    !Array.isArray(headers) ||
    !headers.length ||
    headers.length > HISTORY_LIMITS.columns ||
    !Array.isArray(rows) ||
    rows.length > HISTORY_LIMITS.rows
  )
    configError(
      "History input exceeds row or column limits, or has an invalid shape.",
    );
  if (
    typeof source !== "string" ||
    !source.trim() ||
    source.length > 100 ||
    /[\u0000-\u001f\u007f]/.test(source)
  )
    configError("Invalid source namespace.");
  if (typeof fileDigest !== "string" || !/^[a-fA-F0-9]{64}$/.test(fileDigest))
    configError("Expected a SHA-256 file digest.");
  checkKeys(mapping, HISTORY_FIELDS, "column mapping");
  const indexes = Object.values(mapping).filter((index) => index != null);
  if (
    indexes.some(
      (index) =>
        !Number.isInteger(index) || index < 0 || index >= headers.length,
    ) ||
    new Set(indexes).size !== indexes.length
  )
    configError("Column mappings must be distinct valid zero-based indexes.");
  const encoder = new TextEncoder();
  let bytes = 0;
  const cells = (values) => {
    if (values.some((value) => typeof value !== "string"))
      configError("History cells must be strings.");
    for (const value of values) {
      if (value.length > HISTORY_LIMITS.cellBytes)
        configError("History cell exceeds the size limit.");
      const size = encoder.encode(value).byteLength;
      if (size > HISTORY_LIMITS.cellBytes)
        configError("History cell exceeds the size limit.");
      bytes += size + 1;
      if (bytes > HISTORY_LIMITS.bytes)
        configError("History input exceeds the total size limit.");
    }
  };
  cells(headers);
  for (const values of rows) {
    if (!Array.isArray(values) || values.length !== headers.length)
      configError("History rows must match the header width.");
    cells(values);
  }
  return options(format, mapping);
}
function validDate(year, month, day) {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31)
    return null;
  const date = `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
  const parsed = new Date(date + "T00:00:00.000Z");
  return Number.isFinite(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === date
    ? date
    : null;
}
function parseDateTime(value, format) {
  let match,
    year,
    month,
    day,
    hour = null,
    minute = null;
  if (format === "fresha-en") {
    match =
      /^(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}), (\d{1,2}):(\d{2})(am|pm)$/.exec(
        value,
      );
    if (!match || Number(match[4]) < 1 || Number(match[4]) > 12) return null;
    [, day, month, year] = match;
    month = MONTHS.indexOf(month) + 1;
    hour = (Number(match[4]) % 12) + (match[6] === "pm" ? 12 : 0);
    minute = Number(match[5]);
  } else if (format === "iso-local") {
    match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(value);
    if (!match) return null;
    [, year, month, day, hour, minute] = match;
  } else if (format === "iso-date") {
    match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    [, year, month, day] = match;
  } else {
    match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
    if (!match) return null;
    [, day, month, year] = match;
    if (format === "mdy-date") [day, month] = [month, day];
  }
  const localDate = validDate(Number(year), Number(month), Number(day));
  if (
    !localDate ||
    (hour !== null && (Number(hour) > 23 || Number(minute) > 59))
  )
    return null;
  return {
    localDate,
    timeMinute: hour === null ? null : Number(hour) * 60 + Number(minute),
  };
}
function parseSlot(value, format) {
  const seconds = format === "HH:mm:ss-HH:mm:ss";
  const range = format !== "HH:mm";
  const time = seconds ? "(\\d{2}):(\\d{2}):00" : "(\\d{2}):(\\d{2})";
  const match = new RegExp(`^${time}${range ? "-" + time : ""}$`).exec(value);
  if (!match) return null;
  const start = Number(match[1]) * 60 + Number(match[2]);
  if (Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  if (!range) return { start, end: null };
  const end = Number(match[3]) * 60 + Number(match[4]);
  if (Number(match[3]) > 24 || Number(match[4]) > 59 || end > 1440) return null;
  return { start, end };
}
function parseDuration(value, format) {
  let duration;
  if (format === "minutes") {
    if (!/^\d+$/.test(value)) return null;
    duration = Number(value);
  } else {
    const match = /^(?:(\d+)h(?: )?)?(?:(\d+)min)?$/.exec(value);
    if (
      !match ||
      (!match[1] && !match[2]) ||
      (match[1] && Number(match[2]) >= 60)
    )
      return null;
    duration = Number(match[1] || 0) * 60 + Number(match[2] || 0);
  }
  return Number.isSafeInteger(duration) &&
    duration > 0 &&
    Number.isSafeInteger(duration + 1440)
    ? duration
    : null;
}
function parseMoney(value, money) {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const parts = unsigned.split(money.decimalSeparator);
  if (
    parts.length > 2 ||
    !parts[0] ||
    (parts.length === 2 && !/^\d+$/.test(parts[1]))
  )
    return { error: "invalid_money" };
  let whole = parts[0];
  if (money.groupSeparator && whole.includes(money.groupSeparator)) {
    const groups = whole.split(money.groupSeparator);
    if (
      !/^\d{1,3}$/.test(groups[0]) ||
      groups.slice(1).some((group) => !/^\d{3}$/.test(group))
    )
      return { error: "invalid_money" };
    whole = groups.join("");
  }
  if (!/^\d+$/.test(whole)) return { error: "invalid_money" };
  if (!money.currency || money.minorUnitDigits === null)
    return { unknown: true };
  const fraction = parts[1] || "";
  if (fraction.length > money.minorUnitDigits)
    return { error: "money_precision" };
  // Never parse decimal amounts through a floating-point intermediate.
  const digits = (whole + fraction.padEnd(money.minorUnitDigits, "0")).replace(
    /^0+(?=\d)/,
    "",
  );
  if (digits.length > 16) return { error: "money_out_of_range" };
  const minor = BigInt(digits) * (negative ? -1n : 1n);
  if (
    minor > BigInt(Number.MAX_SAFE_INTEGER) ||
    minor < BigInt(Number.MIN_SAFE_INTEGER)
  )
    return { error: "money_out_of_range" };
  return { minor: Number(minor) };
}

function timeResolver(config) {
  const offsetsByDate = new Map(),
    resultCache = new Map();
  const localMillis = (instant) => {
    const parts = Object.fromEntries(
      config.formatter
        .formatToParts(instant)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    return Date.parse(
      `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.000Z`,
    );
  };
  return (date, minute) => {
    if (!config.zone) return { instant: null, reason: "timezone_unconfirmed" };
    const key = `${date}/${minute}`;
    if (resultCache.has(key)) return resultCache.get(key);
    const midnight = Date.parse(date + "T00:00:00.000Z"),
      wallTime = midnight + minute * 60000;
    if (!offsetsByDate.has(date)) {
      const offsets = new Set();
      for (let hours = -36; hours <= 36; hours += 6) {
        const sample = midnight + hours * 3600000;
        offsets.add(localMillis(sample) - sample);
      }
      offsetsByDate.set(date, offsets);
    }
    const candidates = [...offsetsByDate.get(date)]
      .map((offset) => wallTime - offset)
      .filter((instant) => localMillis(instant) === wallTime);
    const result =
      candidates.length === 1
        ? { instant: new Date(candidates[0]).toISOString(), reason: null }
        : {
            instant: null,
            reason: candidates.length ? "time_ambiguous" : "time_nonexistent",
          };
    resultCache.set(key, result);
    return result;
  };
}

export function normalizeHistoryRows({
  headers,
  rows,
  mapping,
  source,
  fileDigest,
  format = {},
}) {
  const config = validateInput({
    headers,
    rows,
    mapping,
    source,
    fileDigest,
    format,
  });
  const resolve = timeResolver(config);
  const normalized = rows.map((cells, index) => {
    const raw = Object.fromEntries(
      HISTORY_FIELDS.map((key) => [
        key,
        mapping[key] == null ? null : cells[mapping[key]],
      ]),
    );
    const issues = [];
    const issue = (code, field, severity, message) =>
      issues.push({ code, field, severity, message });
    const instant = (date, minute, field) => {
      const result = resolve(date, minute);
      if (result.reason)
        issue(
          result.reason,
          field,
          "review",
          {
            timezone_unconfirmed:
              "Confirm the source timezone before using this timestamp.",
            time_ambiguous:
              "This local time occurs twice; an explicit source offset or reviewed decision is required.",
            time_nonexistent:
              "This local time does not exist in the source timezone; review the original timestamp.",
          }[result.reason],
        );
      return result.instant;
    };
    const timestamp = (field) => {
      if (!clean(raw[field])) return null;
      const parsed = parseDateTime(clean(raw[field]), config.dateTimeFormat);
      const value = {
        raw: raw[field],
        localDate: parsed?.localDate ?? null,
        timeMinute: parsed?.timeMinute ?? null,
        instant: null,
        timeZone: config.zone,
      };
      if (!parsed)
        issue(
          "invalid_datetime",
          field,
          "error",
          "The timestamp does not match the selected date format or calendar.",
        );
      else if (parsed.timeMinute === null)
        issue(
          "timestamp_time_missing",
          field,
          "review",
          "Only the date is known; the timestamp has no time of day.",
        );
      else value.instant = instant(parsed.localDate, parsed.timeMinute, field);
      return value;
    };
    const scheduledText = clean(raw.scheduledDate);
    const scheduled = scheduledText
      ? parseDateTime(scheduledText, config.dateTimeFormat)
      : null;
    if (!scheduledText)
      issue(
        "scheduled_date_missing",
        "scheduledDate",
        "error",
        "A scheduled date is required.",
      );
    else if (!scheduled)
      issue(
        "invalid_datetime",
        "scheduledDate",
        "error",
        "The scheduled date does not match the selected date format or calendar.",
      );
    const slotText = clean(raw.slot),
      slot = slotText ? parseSlot(slotText, config.slotFormat) : null;
    if (slotText && !slot)
      issue(
        "invalid_slot",
        "slot",
        "error",
        "The appointment slot does not match the selected time format.",
      );
    let startMinute = scheduled?.timeMinute ?? slot?.start ?? null;
    if (
      scheduled?.timeMinute != null &&
      slot &&
      scheduled.timeMinute !== slot.start
    ) {
      issue(
        "scheduled_slot_mismatch",
        "slot",
        "error",
        "Scheduled time and appointment slot disagree.",
      );
      startMinute = null;
    }
    if (
      startMinute === null &&
      !issues.some((entry) => entry.code === "scheduled_slot_mismatch")
    )
      issue(
        "start_time_missing",
        "slot",
        "error",
        "A valid appointment start time is required.",
      );
    const durationText = clean(raw.duration),
      durationMinutes = durationText
        ? parseDuration(durationText, config.durationFormat)
        : null;
    if (durationMinutes === null)
      issue(
        durationText ? "invalid_duration" : "duration_missing",
        "duration",
        "error",
        "A positive whole-minute duration in the selected format is required.",
      );
    if (
      durationMinutes !== null &&
      (durationMinutes > 1440 ||
        (startMinute !== null && startMinute + durationMinutes > 1440))
    )
      issue(
        "cross_day_unsupported",
        "duration",
        "error",
        "This preview supports appointments ending by 24:00 on the scheduled day; preserve and review this cross-day source record separately.",
      );
    if (slot?.end != null && slot.end <= slot.start)
      issue(
        "slot_cross_day_unsupported",
        "slot",
        "error",
        "A same-day slot must end after its start; an overnight slot needs a separate reviewed mapping.",
      );
    if (
      slot?.end != null &&
      durationMinutes !== null &&
      slot.start + durationMinutes !== slot.end
    )
      issue(
        "slot_duration_mismatch",
        "duration",
        "error",
        "Slot end time and duration disagree.",
      );
    const scheduledAt =
      scheduled && startMinute !== null
        ? instant(scheduled.localDate, startMinute, "scheduledDate")
        : null;
    const sourceCreatedAt = timestamp("createdAt"),
      sourceCancelledAt = timestamp("cancelledAt");
    const sourceStatus = clean(raw.status);
    const completionState =
      sourceStatus && own(config.completionMap, sourceStatus)
        ? config.completionMap[sourceStatus]
        : sourceStatus && own(completionDefaults, sourceStatus)
          ? completionDefaults[sourceStatus]
          : "unknown";
    if (completionState === "unknown")
      issue(
        "completion_unknown",
        "status",
        "info",
        "Completion is not established by the source status.",
      );
    const requested = clean(raw.requested),
      requestState =
        requested && own(config.requestMap, requested)
          ? config.requestMap[requested]
          : "unknown";
    if (requestState === "unknown")
      issue(
        "request_unknown",
        "requested",
        "info",
        "The source does not establish whether a therapist was requested.",
      );
    if (sourceCancelledAt && sourceStatus !== "Cancelled")
      issue(
        "cancellation_status_mismatch",
        "cancelledAt",
        "review",
        "A cancellation timestamp accompanies a different or unknown status.",
      );
    if (
      completionState === "completed" &&
      (sourceCancelledAt || ["Cancelled", "No Show"].includes(sourceStatus))
    )
      issue(
        "completion_conflict",
        "status",
        "review",
        "The completion mapping contradicts cancellation or no-show evidence.",
      );
    const localOrder = (value) =>
      value?.localDate && value.timeMinute !== null
        ? `${value.localDate}/${String(value.timeMinute).padStart(4, "0")}`
        : null;
    const createdOrder = localOrder(sourceCreatedAt),
      cancelledOrder = localOrder(sourceCancelledAt);
    if (
      createdOrder &&
      scheduled &&
      startMinute !== null &&
      createdOrder >
        localOrder({ localDate: scheduled.localDate, timeMinute: startMinute })
    )
      issue(
        "created_after_scheduled",
        "createdAt",
        "review",
        "The source creation timestamp is after the scheduled appointment.",
      );
    if (createdOrder && cancelledOrder && cancelledOrder < createdOrder)
      issue(
        "cancelled_before_created",
        "cancelledAt",
        "review",
        "Cancellation is earlier than source creation.",
      );
    let sourceNetSalesMinor = null;
    const moneyText = clean(raw.netSales);
    if (moneyText === null)
      issue(
        "net_sales_missing",
        "netSales",
        "info",
        "Source net sales are unavailable.",
      );
    else {
      const parsed = parseMoney(moneyText, config.money);
      if (parsed.error)
        issue(
          parsed.error,
          "netSales",
          "error",
          "Net sales must match the selected separators and currency precision without rounding or overflow.",
        );
      else if (parsed.unknown)
        issue(
          "currency_unconfirmed",
          "netSales",
          "info",
          "Confirm the source currency and minor-unit precision before using this amount.",
        );
      else sourceNetSalesMinor = parsed.minor;
    }
    return {
      row: index + 2,
      source: source.trim(),
      fileDigest: fileDigest.toLowerCase(),
      raw,
      interpretation: {
        version: 1,
        dateTimeFormat: config.dateTimeFormat ?? null,
        slotFormat: config.slotFormat ?? null,
        durationFormat: config.durationFormat ?? null,
        money: { ...config.money },
        sourceTimeZone: config.zone,
      },
      completionBasis: {
        method:
          sourceStatus && own(config.completionMap, sourceStatus)
            ? "explicit_mapping"
            : sourceStatus && own(completionDefaults, sourceStatus)
              ? "source_status"
              : "unresolved",
        sourceValue: sourceStatus,
        mappedValue: completionState,
      },
      requestBasis: {
        method:
          requested && own(config.requestMap, requested)
            ? "explicit_mapping"
            : "unresolved",
        sourceValue: requested,
        mappedValue: requestState,
      },
      sourceAppointmentRef: clean(raw.appointmentRef),
      sourceServiceLineRef: clean(raw.serviceLineRef),
      sourceClientId: clean(raw.clientSourceId),
      sourceClientLabel: clean(raw.clientName),
      phone: clean(raw.phone),
      email: clean(raw.email),
      instagram: clean(raw.instagram),
      sourceTherapistLabel: clean(raw.therapistName),
      sourceServiceLabel: clean(raw.serviceName),
      sourceRoomLabel:
        config.dateTimeFormat === "fresha-en" &&
        headers[mapping.roomName] === "Resource" &&
        clean(raw.roomName) === "No resource"
          ? null
          : clean(raw.roomName),
      scheduledLocalDate: scheduled?.localDate ?? null,
      startMinute,
      durationMinutes,
      scheduledAt,
      sourceTimeZone: config.zone,
      sourceCreatedAt,
      sourceCancelledAt,
      sourceStatus,
      completionState,
      requestState,
      sourceNetSalesMinor,
      currency: config.money.currency,
      fullPriceMinor: null,
      paidAmountMinor: null,
      bonusRule: null,
      bonusAmountMinor: null,
      issues,
    };
  });
  const summary = {
    total: normalized.length,
    valid: 0,
    invalid: 0,
    needsReview: 0,
    completed: 0,
    notCompleted: 0,
    unknownCompletion: 0,
    unknownRequest: 0,
    unknownTimeZone: 0,
    unknownNetSales: 0,
  };
  for (const row of normalized) {
    if (row.issues.some((issue) => issue.severity === "error"))
      summary.invalid++;
    else if (row.issues.some((issue) => issue.severity === "review"))
      summary.needsReview++;
    else summary.valid++;
    summary[
      row.completionState === "completed"
        ? "completed"
        : row.completionState === "not_completed"
          ? "notCompleted"
          : "unknownCompletion"
    ]++;
    if (row.requestState === "unknown") summary.unknownRequest++;
    if (row.sourceTimeZone === null) summary.unknownTimeZone++;
    if (row.sourceNetSalesMinor === null) summary.unknownNetSales++;
  }
  return { rows: normalized, summary };
}
