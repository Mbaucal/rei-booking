/**
 * Rei Booking report snapshots for Google Apps Script (V8 runtime).
 * Configure Script Properties; never paste credentials into this file or cells:
 * REI_API_BASE, REI_API_TOKEN, REI_SPREADSHEET_ID, REI_START_DATE.
 * Run reiSyncReports manually before reiInstallDailySync.
 * This script only creates separate snapshot tabs. It never updates old tabs.
 */
const REI_SYNC = Object.freeze({
  timezone: "Europe/Belgrade",
  allowedBases: ["https://rei-booking.mbaucal.workers.dev/api"],
  handler: "reiScheduledSync",
  proof: "REI_MANUAL_SYNC_SIGNATURE",
  metadata: "REI_REPORT_SNAPSHOT_V1",
  maxWindows: 11,
  maxResponseChars: 4000000,
  maxAllResponseChars: 12000000,
  maxCells: 500000,
});

function reiSyncReports() {
  return reiRunSync_(true);
}
function reiScheduledSync() {
  return reiRunSync_(false);
}
function reiInstallDailySync() {
  return reiWithLock_(function () {
    const config = reiConfig_();
    reiRequireManual_(config);
    const existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
      return trigger.getHandlerFunction() === REI_SYNC.handler;
    });
    if (!existing.length) {
      ScriptApp.newTrigger(REI_SYNC.handler)
        .timeBased()
        .atHour(9)
        .nearMinute(0)
        .everyDays(1)
        .inTimezone(REI_SYNC.timezone)
        .create();
    } else {
      existing.slice(1).forEach(function (trigger) {
        ScriptApp.deleteTrigger(trigger);
      });
    }
    return "Daily sync enabled around 09:00 Europe/Belgrade.";
  });
}
function reiRemoveDailySync() {
  return reiWithLock_(function () {
    ScriptApp.getProjectTriggers().forEach(function (trigger) {
      if (trigger.getHandlerFunction() === REI_SYNC.handler)
        ScriptApp.deleteTrigger(trigger);
    });
    return "Rei daily sync stopped. Other triggers were not changed.";
  });
}
function reiWithLock_(action) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000))
    throw new Error(
      "Another Rei sync is running. Try again after it finishes.",
    );
  try {
    return action();
  } finally {
    lock.releaseLock();
  }
}
function reiConfig_() {
  const p = PropertiesService.getScriptProperties().getProperties();
  const base = String(p.REI_API_BASE || "").trim();
  if (REI_SYNC.allowedBases.indexOf(base) < 0)
    throw new Error(
      "Set REI_API_BASE to the approved Rei Booking API address.",
    );
  const token = String(p.REI_API_TOKEN || "").trim();
  if (!/^[A-Za-z0-9_.-]{32,256}$/.test(token))
    throw new Error("Set REI_API_TOKEN in private Script Properties.");
  const spreadsheetId = String(p.REI_SPREADSHEET_ID || "").trim();
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(spreadsheetId))
    throw new Error(
      "Set REI_SPREADSHEET_ID to the destination spreadsheet ID.",
    );
  const from = String(p.REI_START_DATE || "").trim();
  if (!reiIsDate_(from))
    throw new Error("Set REI_START_DATE to a valid YYYY-MM-DD date.");
  return { base: base, token: token, spreadsheetId: spreadsheetId, from: from };
}
function reiConfigSignature_(config) {
  return reiHash_(
    JSON.stringify([
      config.base,
      config.token,
      config.spreadsheetId,
      config.from,
    ]),
  );
}
function reiRequireManual_(config) {
  if (
    PropertiesService.getScriptProperties().getProperty(REI_SYNC.proof) !==
    reiConfigSignature_(config)
  )
    throw new Error(
      "Run reiSyncReports manually with the current settings before enabling automatic sync.",
    );
}
function reiIsDate_(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + "T12:00:00Z")) &&
    new Date(value + "T12:00:00Z").toISOString().slice(0, 10) === value
  );
}
function reiShiftDate_(date, days) {
  return new Date(Date.parse(date + "T12:00:00Z") + days * 86400000)
    .toISOString()
    .slice(0, 10);
}
function reiWindows_(from) {
  const today = Utilities.formatDate(
    new Date(),
    REI_SYNC.timezone,
    "yyyy-MM-dd",
  );
  const to = reiShiftDate_(today, -1),
    result = [];
  if (from > to)
    throw new Error("REI_START_DATE must be before today in Europe/Belgrade.");
  for (let start = from; start <= to;) {
    const yearEnd = start.slice(0, 4) + "-12-31";
    const end = yearEnd < to ? yearEnd : to;
    result.push({ from: start, to: end });
    if (result.length > REI_SYNC.maxWindows)
      throw new Error(
        "Use a start date covering at most eleven calendar years.",
      );
    start = reiShiftDate_(end, 1);
  }
  return result;
}
function reiFetchReport_(config, period) {
  const query =
    "from=" +
    period.from +
    "&to=" +
    period.to +
    "&group_by=therapist&source=all&status=all&requested=all&average_day_basis=active&include_bonuses=true";
  let response;
  try {
    response = UrlFetchApp.fetch(
      config.base + "/v1/reports/performance?" + query,
      {
        method: "get",
        headers: {
          Authorization: "Bearer " + config.token,
          Accept: "application/json",
        },
        followRedirects: false,
        validateHttpsCertificates: true,
        muteHttpExceptions: true,
      },
    );
  } catch (_) {
    throw new Error(
      "Could not reach the Rei report API. No report data was written.",
    );
  }
  const status = response.getResponseCode();
  if (status !== 200)
    throw new Error(
      "Rei report API returned HTTP " +
        status +
        ". Check access and report dates; no report data was written.",
    );
  const body = response.getContentText();
  if (body.length > REI_SYNC.maxResponseChars)
    throw new Error("The report response is too large. Use a shorter period.");
  let data;
  try {
    data = JSON.parse(body);
  } catch (_) {
    throw new Error("The report API did not return valid JSON.");
  }
  return { report: reiValidateReport_(data, period), length: body.length };
}
function reiAssert_(condition) {
  if (!condition)
    throw new Error(
      "The report response is incomplete or incompatible. No report data was written.",
    );
}
function reiObject_(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function reiNumber_(value, integer, signed, nullable) {
  reiAssert_(
    (nullable && value === null) ||
      (typeof value === "number" &&
        Number.isFinite(value) &&
        Math.abs(value) <= Number.MAX_SAFE_INTEGER &&
        (signed || value >= 0) &&
        (!integer || Number.isSafeInteger(value))),
  );
  return value;
}
function reiMetrics_(record, period) {
  reiAssert_(
    reiObject_(record) &&
      record.from === period.from &&
      record.to === period.to,
  );
  const result = { from: record.from, to: record.to };
  [
    "appointments",
    "completed_massages",
    "cancelled",
    "no_show",
    "pending",
    "requested_bookings",
    "massage_minutes",
    "native_minutes",
    "regular_minutes",
    "requested_minutes",
    "day_count",
    "included_treatments",
    "historical_rows",
    "historical_treatments",
    "historical_visits",
    "historical_minutes",
    "excluded_native_overlap",
  ].forEach(function (key) {
    result[key] = reiNumber_(record[key], true, false, false);
  });
  [
    "revenue_cents",
    "bonus_cents",
    "regular_bonus_cents",
    "requested_bonus_cents",
  ].forEach(function (key) {
    result[key] = reiNumber_(record[key], true, false, true);
  });
  ["average_revenue_cents", "average_minutes_per_day"].forEach(function (key) {
    result[key] = reiNumber_(record[key], false, false, true);
  });
  reiAssert_(reiObject_(record.missing));
  result.missing = {};
  [
    "requested",
    "completion",
    "status",
    "source_money",
    "full_price",
    "bonus",
  ].forEach(function (key) {
    result.missing[key] = reiNumber_(record.missing[key], true, false, false);
  });
  reiAssert_(
    Array.isArray(record.source_net_sales) &&
      record.source_net_sales.length <= 100,
  );
  const currencies = {};
  result.source_net_sales = record.source_net_sales.map(function (amount) {
    reiAssert_(
      reiObject_(amount) &&
        /^[A-Z]{3}$/.test(amount.currency) &&
        Number.isInteger(amount.minor_unit_digits) &&
        amount.minor_unit_digits >= 0 &&
        amount.minor_unit_digits <= 4,
    );
    const key = amount.currency + ":" + amount.minor_unit_digits;
    reiAssert_(!currencies[key]);
    currencies[key] = true;
    return {
      currency: amount.currency,
      minor_unit_digits: amount.minor_unit_digits,
      amount_minor: reiNumber_(amount.amount_minor, true, true, true),
      rows: reiNumber_(amount.rows, true, false, false),
    };
  });
  return result;
}
function reiValidateReport_(data, period) {
  reiAssert_(
    reiObject_(data) &&
      data.schema_version === "1" &&
      data.demo === false &&
      data.complete === true &&
      data.next_cursor === null &&
      data.currency === "RSD" &&
      data.timezone === REI_SYNC.timezone &&
      data.from === period.from &&
      data.to === period.to &&
      typeof data.generated_at === "string" &&
      /^\d{4}-\d{2}-\d{2}T/.test(data.generated_at) &&
      Number.isFinite(Date.parse(data.generated_at)),
  );
  const f = data.filters;
  reiAssert_(
    reiObject_(f) &&
      f.group_by === "therapist" &&
      f.source === "all" &&
      !f.therapist &&
      !f.treatment &&
      f.status === "all" &&
      f.requested === "all" &&
      f.average_day_basis === "active" &&
      f.include_bonuses === true,
  );
  reiAssert_(Array.isArray(data.rows) && data.rows.length <= 5000);
  const ids = Object.create(null),
    rows = data.rows.map(function (row) {
      reiAssert_(
        reiObject_(row) &&
          typeof row.key === "string" &&
          row.key.length <= 1000 &&
          typeof row.label === "string" &&
          row.label.length <= 1000 &&
          reiObject_(row.dimensions) &&
          Object.keys(row.dimensions).length === 1 &&
          typeof row.dimensions.therapist === "string" &&
          row.dimensions.therapist.length > 0 &&
          row.dimensions.therapist.length <= 200,
      );
      reiAssert_(!ids[row.dimensions.therapist]);
      ids[row.dimensions.therapist] = true;
      return Object.assign(
        {
          key: row.key,
          dimensions: { therapist: row.dimensions.therapist },
          label: row.label,
        },
        reiMetrics_(row, period),
      );
    });
  const days = (Date.parse(period.to) - Date.parse(period.from)) / 86400000 + 1;
  const previousPeriod = {
    from: reiShiftDate_(period.from, -days),
    to: reiShiftDate_(period.from, -1),
  };
  const totals = reiMetrics_(data.totals, period),
    previous = reiMetrics_(data.previous, previousPeriod);
  reiAssert_(reiObject_(data.comparison));
  const comparison = {};
  [
    "revenue_cents",
    "completed_massages",
    "massage_minutes",
    "bonus_cents",
    "included_treatments",
    "historical_visits",
    "historical_minutes",
  ].forEach(function (key) {
    const item = data.comparison[key];
    reiAssert_(reiObject_(item));
    comparison[key] = {
      value: reiNumber_(item.value, false, false, false),
      previous: reiNumber_(item.previous, false, false, false),
      difference: reiNumber_(item.difference, false, true, false),
      percent: reiNumber_(item.percent, false, true, true),
    };
    reiAssert_(
      comparison[key].value === totals[key] &&
        comparison[key].previous === previous[key] &&
        comparison[key].difference === totals[key] - previous[key],
    );
  });
  const c = data.coverage;
  reiAssert_(
    reiObject_(c) &&
      c.from === period.from &&
      c.to === period.to &&
      c.comparison_from === previousPeriod.from &&
      c.comparison_to === previousPeriod.to &&
      c.source === "all" &&
      c.snapshot_consistent === true &&
      c.historical_import_completeness === "not_verified" &&
      c.native_row_limit === 20000 &&
      c.historical_row_limit === 50000,
  );
  const coverage = {
    from: c.from,
    to: c.to,
    comparison_from: c.comparison_from,
    comparison_to: c.comparison_to,
    source: "all",
    snapshot_consistent: true,
    historical_import_completeness: "not_verified",
    native_row_limit: 20000,
    historical_row_limit: 50000,
  };
  [
    "native_rows_loaded",
    "history_rows_loaded",
    "history_archive_rows",
    "archive_revision",
    "catalogue_revision",
    "native_audit_id",
  ].forEach(function (key) {
    coverage[key] = reiNumber_(c[key], true, false, false);
  });
  ["history_archive_from", "history_archive_to"].forEach(function (key) {
    reiAssert_(c[key] === null || reiIsDate_(c[key]));
    coverage[key] = c[key];
  });
  reiAssert_(
    coverage.native_rows_loaded <= coverage.native_row_limit &&
      coverage.history_rows_loaded <= coverage.historical_row_limit &&
      ((coverage.history_archive_from === null &&
        coverage.history_archive_to === null) ||
        (coverage.history_archive_from !== null &&
          coverage.history_archive_to !== null &&
          coverage.history_archive_from <= coverage.history_archive_to)),
  );
  // Only these whitelisted aggregate fields enter Sheets; raw source/identity data never does.
  return {
    schema_version: "1",
    from: period.from,
    to: period.to,
    generated_at: data.generated_at,
    filters: {
      group_by: "therapist",
      source: "all",
      average_day_basis: "active",
      include_bonuses: true,
    },
    rows: rows,
    totals: totals,
    previous: previous,
    comparison: comparison,
    coverage: coverage,
  };
}
function reiSafeCell_(value) {
  if (value == null) return "";
  return typeof value === "string" && /^[\s]*[=+@-]/.test(value)
    ? "'" + value
    : value;
}
function reiAmount_(value, divisor) {
  return value == null ? "" : value / divisor;
}
function reiMetricRow_(label, m) {
  return [
    label,
    m.from,
    m.to,
    m.appointments,
    m.completed_massages,
    m.cancelled,
    m.no_show,
    m.pending,
    m.included_treatments,
    m.historical_treatments,
    m.historical_visits,
    m.massage_minutes / 60,
    m.regular_minutes / 60,
    m.requested_minutes / 60,
    m.historical_minutes / 60,
    reiAmount_(m.revenue_cents, 100),
    reiAmount_(m.average_revenue_cents, 100),
    reiAmount_(m.average_minutes_per_day, 60),
    m.day_count,
    reiAmount_(m.bonus_cents, 100),
    m.missing.source_money,
    m.missing.requested,
    m.missing.completion,
    m.missing.status,
    m.missing.full_price,
    m.missing.bonus,
    m.excluded_native_overlap,
  ];
}
function reiMatrix_(report) {
  const header = [
    "Therapist / scope",
    "From",
    "To",
    "Appointments",
    "Completed Rei massages",
    "Cancelled",
    "No-show",
    "Pending Rei bookings",
    "Included treatments",
    "Imported treatments",
    "Imported visits (not additive)",
    "Massage hours (all included)",
    "Rei regular hours",
    "Rei requested hours",
    "Imported hours",
    "Rei revenue RSD",
    "Average Rei revenue RSD",
    "Average hours per active day",
    "Active days",
    "Rei bonus RSD",
    "Imported amounts unavailable",
    "Requested unknown",
    "Completion unknown",
    "Status unknown",
    "Full price unavailable",
    "Bonus unavailable",
    "Overlapping history excluded",
  ];
  const rows = [
    ["Rei Booking report snapshot"],
    ["Period", report.from + " to " + report.to, "Europe/Belgrade"],
    ["Generated by Rei", report.generated_at],
    [
      "Data source",
      "All data. Native revenue and bonuses are separate from imported source net sales.",
    ],
    [
      "History coverage",
      "Only records present in Rei are included. This is not proof that all Fresha history was imported.",
    ],
    [
      "Usage",
      "Snapshots are alternative views. Do not add snapshots, TOTAL rows, or imported visit counts across therapists.",
    ],
    [
      "Unknown amounts",
      "Blank cells remain unknown; unavailable counters explain missing source evidence.",
    ],
    [],
    header,
  ];
  report.rows.forEach(function (row) {
    rows.push(reiMetricRow_(row.label, row));
  });
  rows.push(
    reiMetricRow_(
      "TOTAL (use instead of summing therapist rows)",
      report.totals,
    ),
  );
  rows.push(
    reiMetricRow_("PREVIOUS PERIOD (comparison only)", report.previous),
  );
  rows.push(
    [],
    [
      "Imported source net sales; never add to Rei revenue without reconciliation",
    ],
    ["Scope", "Currency", "Source net sales", "Source rows", "From", "To"],
  );
  report.rows
    .concat([
      Object.assign({ label: "TOTAL" }, report.totals),
      Object.assign({ label: "PREVIOUS PERIOD" }, report.previous),
    ])
    .forEach(function (row) {
      row.source_net_sales.forEach(function (amount) {
        rows.push([
          row.label,
          amount.currency,
          reiAmount_(
            amount.amount_minor,
            Math.pow(10, amount.minor_unit_digits),
          ),
          amount.rows,
          row.from,
          row.to,
        ]);
      });
    });
  rows.push(
    [],
    ["Comparison", "Current", "Previous", "Difference", "Change %"],
  );
  Object.keys(report.comparison).forEach(function (key) {
    const c = report.comparison[key],
      divisor = /_cents$/.test(key) ? 100 : /_minutes$/.test(key) ? 60 : 1;
    const label = key
      .replace(/_cents$/, " RSD")
      .replace(/_minutes$/, " hours")
      .replace(/_/g, " ");
    rows.push([
      label,
      c.value / divisor,
      c.previous / divisor,
      c.difference / divisor,
      c.percent == null ? "" : c.percent,
    ]);
  });
  rows.push(
    [],
    [
      "Source coverage / provenance (all dates refer to records present in Rei)",
    ],
  );
  Object.keys(report.coverage).forEach(function (key) {
    rows.push([key, report.coverage[key]]);
  });
  return rows.map(function (row) {
    return Array.from({ length: header.length }, function (_, i) {
      return reiSafeCell_(row[i]);
    });
  });
}
function reiHash_(value) {
  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    value,
    Utilities.Charset.UTF_8,
  )
    .map(function (b) {
      return (b & 255).toString(16).padStart(2, "0");
    })
    .join("");
}
function reiSnapshotHash_(config, report) {
  const stable = Object.assign({}, report);
  delete stable.generated_at;
  // Source revision counters are provenance, not a change to the report values.
  delete stable.coverage;
  return reiHash_(JSON.stringify([config.base, stable]));
}
function reiRunSync_(manual) {
  return reiWithLock_(function () {
    const config = reiConfig_(),
      properties = PropertiesService.getScriptProperties();
    if (!manual) reiRequireManual_(config);
    const periods = reiWindows_(config.from),
      plans = [];
    let responseChars = 0,
      cells = 0;
    // Validate every period before opening or modifying the spreadsheet.
    periods.forEach(function (period) {
      const loaded = reiFetchReport_(config, period),
        matrix = reiMatrix_(loaded.report);
      responseChars += loaded.length;
      cells += matrix.length * matrix[0].length;
      if (
        responseChars > REI_SYNC.maxAllResponseChars ||
        cells > REI_SYNC.maxCells
      )
        throw new Error(
          "The combined report is too large. Choose a later REI_START_DATE; no report data was written.",
        );
      plans.push({
        report: loaded.report,
        matrix: matrix,
        hash: reiSnapshotHash_(config, loaded.report),
      });
    });
    let workbook;
    try {
      workbook = SpreadsheetApp.openById(config.spreadsheetId);
    } catch (_) {
      throw new Error(
        "Could not open the destination spreadsheet. Check its ID and your Google access.",
      );
    }
    const existing = {};
    workbook.getSheets().forEach(function (sheet) {
      sheet.getDeveloperMetadata().forEach(function (metadata) {
        if (metadata.getKey() === REI_SYNC.metadata)
          existing[metadata.getValue()] = sheet.getName();
      });
    });
    const created = [],
      names = [],
      stamp = Utilities.formatDate(
        new Date(),
        REI_SYNC.timezone,
        "yyyyMMdd-HHmmss",
      );
    try {
      plans.forEach(function (plan, index) {
        if (existing[plan.hash]) {
          names.push(existing[plan.hash]);
          return;
        }
        const baseName =
          "Rei " + plan.report.from + "_" + plan.report.to + " " + stamp;
        let name = baseName,
          suffix = 1;
        while (workbook.getSheetByName(name))
          name = baseName + " (" + ++suffix + ")";
        const sheet = workbook.insertSheet(name);
        created.push({ sheet: sheet, hash: plan.hash });
        if (sheet.getMaxColumns() < plan.matrix[0].length)
          sheet.insertColumnsAfter(
            sheet.getMaxColumns(),
            plan.matrix[0].length - sheet.getMaxColumns(),
          );
        if (sheet.getMaxRows() < plan.matrix.length)
          sheet.insertRowsAfter(
            sheet.getMaxRows(),
            plan.matrix.length - sheet.getMaxRows(),
          );
        sheet
          .getRange(1, 1, plan.matrix.length, plan.matrix[0].length)
          .setValues(plan.matrix);
        sheet
          .getRange(9, 1, 1, plan.matrix[0].length)
          .setFontWeight("bold")
          .setBackground("#e8eee7");
        sheet
          .getRange(
            10,
            4,
            plan.report.rows.length + 2,
            plan.matrix[0].length - 3,
          )
          .setNumberFormat("0.##");
        sheet.setFrozenRows(9);
        sheet.setFrozenColumns(1);
        sheet.setColumnWidth(1, 280);
        sheet.setColumnWidths(2, plan.matrix[0].length - 1, 150);
        names.push(name);
      });
      SpreadsheetApp.flush();
      created.forEach(function (item) {
        item.sheet.addDeveloperMetadata(REI_SYNC.metadata, item.hash);
      });
      SpreadsheetApp.flush();
      if (manual)
        properties.setProperty(REI_SYNC.proof, reiConfigSignature_(config));
    } catch (_) {
      // Only sheets created by this invocation may be removed; existing sheets are never touched.
      let cleanupFailed = false;
      created.reverse().forEach(function (item) {
        try {
          workbook.deleteSheet(item.sheet);
        } catch (_) {
          cleanupFailed = true;
        }
      });
      throw new Error(
        cleanupFailed
          ? "Sync did not finish. Existing tabs were preserved; check new incomplete Rei tabs before retrying."
          : "Sync did not finish. New tabs from this attempt were removed; existing tabs were preserved. Retry the sync.",
      );
    }
    return {
      periods: plans.length,
      created: created.length,
      unchanged: plans.length - created.length,
      sheets: names,
    };
  });
}
