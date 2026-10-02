import { mountClientMatches } from "./client-matches.js";
import { mountBookingAvailability } from "./calendar-availability.js";
import { bookingSummaryHTML } from "./booking-presentation.js";
import { mountCalendarInteractions } from "./calendar-interactions.js";
import {
  calendarResourceItems,
  calendarBlockHTML,
  calendarBlockDetailsHTML,
} from "./calendar-blocks.js";
import {
  START,
  END,
  SCALE,
  setCalendarScale,
  BAND,
  calendarTop,
  calendarHeight,
} from "./calendar-geometry.js";
import { mountCalendarReschedule } from "./calendar-reschedule.js";
import {
  mountAppointmentPreview,
  appointmentDetailsHTML,
} from "./appointment-preview.js";
import { renderClientTransfer } from "./client-transfer.js";
import { renderHistoryPreview } from "./history-preview.js";
import { mountClientHistory } from "./client-history.js";
import { renderMonthly } from "./monthly.js";
import { avatar, mountPhotoEditor } from "./photos.js";
import { openVoucherRedemption } from "./voucher-redemption.js";
import { renderReports } from "./reports.js";
import { renderSales } from "./sales.js";
document.addEventListener(
  "error",
  (event) => {
    if (
      event.target instanceof HTMLImageElement &&
      event.target.closest(".avatar")
    )
      event.target.remove();
  },
  true,
);
const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const clock = (m) =>
  String(Math.floor(m / 60)).padStart(2, "0") +
  ":" +
  String(m % 60).padStart(2, "0");
const minutes = (value) => {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
};
const money = (cents) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "RSD" }).format(
    cents / 100,
  );
const dateParts = () =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Belgrade",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
const today = () => {
  const p = dateParts();
  return `${p.year}-${p.month}-${p.day}`;
};
const prettyDate = (value) =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value + "T12:00:00Z"));
const stamp = (value) =>
  new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Belgrade",
  }).format(new Date(value));
const statusName = (value) =>
  ({
    booked: "Booked",
    confirmed: "Confirmed",
    done: "Completed",
    cancelled: "Cancelled",
    no_show: "No-show",
  })[value] || value;
const mobileCalendarMedia = window.matchMedia(
  "(max-width:700px), (max-height:560px) and (pointer:coarse)",
);
const calendarLayout = () =>
  mobileCalendarMedia.matches ? "mobile" : "desktop";
const calendarModes = { mobile: "therapists", desktop: "all" };
let calendarLayoutKey = calendarLayout(),
  calendarRenderedWidth = 0,
  calendarLayoutPending = false,
  calendarResizeFrame = 0;
let state = {
    user: null,
    csrf: "",
    page: "calendar",
    date: today(),
    mode: calendarModes[calendarLayoutKey],
    catalogue: { therapists: [], rooms: [], services: [] },
    appointments: [],
    blocks: [],
    clients: [],
    version: 0,
  },
  toastTimer,
  refreshTimer,
  calendarInteractions = null,
  calendarReschedule = null,
  appointmentPreview = null,
  calendarViewEpoch = 0,
  calendarLoadEpoch = 0,
  sessionEpoch = 0;
let historyPreviewCleanup = null,
  clientHistoryCleanup = null;
const owner = () => state.user?.role === "owner",
  operator = () => ["owner", "reception"].includes(state.user?.role);
const therapist = (id) => state.catalogue.therapists.find((t) => t.id === id),
  room = (id) => state.catalogue.rooms.find((r) => r.id === id),
  service = (id) => state.catalogue.services.find((s) => s.id === id);
const opts = (items, value, empty = "") =>
  (empty ? `<option value="">${empty}</option>` : "") +
  items
    .map(
      (i) =>
        `<option value="${esc(i.id)}" ${i.id === value ? "selected" : ""}>${esc(i.name)}</option>`,
    )
    .join("");
const input = (name, label, value = "", type = "text", extra = "") =>
  `<label><span>${label}</span><input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 4500);
}
async function api(path, { method = "GET", body } = {}) {
  const epoch = sessionEpoch;
  const response = await fetch("/api" + path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(method === "GET" ? {} : { "X-CSRF-Token": state.csrf }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (epoch !== sessionEpoch) throw new Error("The session changed.");
  if (response.status === 401 && path !== "/login") {
    signOutView();
    throw new Error("Your session ended. Please sign in.");
  }
  if (!response.ok) {
    const error = new Error(data.error || "Something went wrong.");
    error.status = response.status;
    error.matches = data.matches;
    throw error;
  }
  return data;
}
function disposeCalendarUI() {
  calendarViewEpoch++;
  const interactions = calendarInteractions,
    reschedule = calendarReschedule,
    preview = appointmentPreview;
  calendarInteractions = null;
  calendarReschedule = null;
  appointmentPreview = null;
  interactions?.dispose();
  reschedule?.dispose();
  preview?.dispose();
}
function signOutView() {
  historyPreviewCleanup?.();
  historyPreviewCleanup = null;
  disposeCalendarUI();
  sessionEpoch++;
  state = {
    ...state,
    user: null,
    csrf: "",
    appointments: [],
    blocks: [],
    clients: [],
    catalogue: { therapists: [], rooms: [], services: [] },
    version: state.version + 1,
  };
  clearInterval(refreshTimer);
  closeDrawer();
  $("page-content").textContent = "";
  $("drawer-content").textContent = "";
  $("drawer-footer").textContent = "";
  $("signed-name").textContent = "";
  $("signed-role").textContent = "";
  $("app").hidden = true;
  $("mobile-navigation").hidden = true;
  delete $("app").dataset.page;
  $("login-screen").hidden = false;
}
let drawerEpoch = 0,
  drawerReturnFocus = null;
function closeDrawer() {
  clientHistoryCleanup?.();
  clientHistoryCleanup = null;
  drawerEpoch++;
  const wasOpen = $("drawer").open;
  if (wasOpen) $("drawer").close();
  $("drawer-content").textContent = "";
  $("drawer-footer").textContent = "";
  if (wasOpen) {
    const target = [
      drawerReturnFocus,
      $("required-password-open"),
      $("calendar-view-options"),
      $("mobile-more"),
      $("change-password"),
    ].find(
      (element) =>
        element?.isConnected &&
        element.getClientRects().length &&
        !element.disabled,
    );
    target?.focus({ preventScroll: true });
  }
  drawerReturnFocus = null;
  scheduleCalendarLayoutSync();
}
function showDrawer(title, kicker, html) {
  clientHistoryCleanup?.();
  clientHistoryCleanup = null;
  calendarReschedule?.cancel();
  appointmentPreview?.dismiss();
  calendarInteractions?.dismiss();
  drawerEpoch++;
  $("drawer-title").textContent = title;
  $("drawer-kicker").textContent = kicker;
  $("drawer-content").innerHTML = html;
  $("drawer-footer").innerHTML = "";
  if (!$("drawer").open) {
    drawerReturnFocus = document.activeElement;
    $("drawer").showModal();
  }
  $("drawer-content").scrollTop = 0;
}
function errorBox(message) {
  return `<p class="error" id="form-error" role="alert" ${message ? "" : "hidden"}>${esc(message || "")}</p>`;
}
function formError(error) {
  if (error.matches)
    $("drawer-content")
      .querySelector("form")
      ?.clientMatches?.show(error.matches);
  if ($("form-error")) {
    $("form-error").textContent = error.message;
    $("form-error").hidden = false;
  } else toast(error.message);
}
function bindForm(id, save, label = "Save changes") {
  $("drawer-footer").innerHTML =
    `<button class="btn" id="form-cancel">Cancel</button><button class="btn primary" form="${id}" id="form-save" type="submit">${label}</button>`;
  $("form-cancel").onclick = closeDrawer;
  $(id).onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget,
      button = $("form-save"),
      epoch = drawerEpoch;
    if (button.disabled) return;
    const data = new FormData(form);
    const controls = [...form.querySelectorAll("input,select,textarea,button")];
    const disabled = controls.map((el) => el.disabled);
    controls.forEach((el) => (el.disabled = true));
    button.disabled = true;
    try {
      await save(
        data,
        () => form.isConnected && $("drawer").open && drawerEpoch === epoch,
      );
    } catch (error) {
      if (form.isConnected && drawerEpoch === epoch) formError(error);
    } finally {
      if (form.isConnected) {
        controls.forEach((el, i) => (el.disabled = disabled[i]));
      }
      if (button.isConnected) button.disabled = false;
    }
  };
}
async function enterApp(session) {
  sessionEpoch++;
  state.user = session.user;
  state.csrf = session.csrf;
  $("mobile-navigation").hidden = !!session.mustChangePassword;
  $("mobile-navigation")
    .querySelectorAll("[data-mobile-operator]")
    .forEach((button) => {
      button.hidden = !operator();
    });
  $("login-screen").hidden = true;
  $("app").hidden = false;
  $("signed-name").textContent = session.user.name;
  $("signed-role").textContent = {
    owner: "Owner",
    reception: "Reception",
    therapist: "Therapist",
  }[session.user.role];
  document
    .querySelectorAll("nav [data-page]")
    .forEach(
      (b) =>
        (b.hidden =
          b.dataset.page === "calendar"
            ? false
            : b.dataset.page === "clients"
              ? !operator()
              : !owner()),
    );
  if (session.mustChangePassword) {
    $("app").dataset.page = "password";
    $("page-title").textContent = "Your account";
    $("page-title").closest(".page-top").classList.remove("calendar-page-top");
    $("page-content").innerHTML =
      '<div class="empty"><h2>Choose your own password</h2><p>Replace your temporary password to continue.</p><button type="button" class="btn primary" id="required-password-open">Change password</button> <button type="button" class="btn" id="required-password-sign-out">Sign out</button></div>';
    $("required-password-open").onclick = () => passwordDialog(true);
    $("required-password-sign-out").onclick = signOut;
    passwordDialog(true);
    return;
  }
  await loadCatalogue();
  await setPage(
    owner() && /^#report=[a-f0-9]{64}$/.test(location.hash)
      ? "monthly"
      : owner() && !mobileCalendarMedia.matches
        ? "dashboard"
        : "calendar",
  );
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (
      state.user &&
      state.page === "calendar" &&
      !document.hidden &&
      !calendarReschedule?.isActive()
    )
      loadCalendar().catch(showAppError);
  }, 30000);
}
function showAppError(error) {
  $("app-error").textContent = error.message;
  $("app-error").hidden = false;
}
async function loadCatalogue() {
  state.catalogue = await api("/catalogue");
}
async function setPage(page, monthlyFilters = null) {
  if (!state.user) return;
  if (page !== "calendar" && (!operator() || (page !== "clients" && !owner())))
    return;
  historyPreviewCleanup?.();
  historyPreviewCleanup = null;
  disposeCalendarUI();
  state.page = page;
  updateMobileNavigation();
  $("app").dataset.page = page;
  $("page-title")
    .closest(".page-top")
    .classList.toggle("calendar-page-top", page === "calendar");
  $("page-title").parentElement.classList.toggle(
    "calendar-page-heading",
    page === "calendar",
  );
  if (page !== "monthly" && location.hash.startsWith("#report="))
    history.replaceState(null, "", location.pathname);
  closeDrawer();
  state.version++;
  $("app-error").hidden = true;
  $("page-title").textContent = {
    calendar: "Calendar",
    dashboard: "Dashboard",
    reports: "Reports",
    monthly: "Reports",
    sales: "Sales",
    clients: "Clients",
    "client-transfer": "Clients",
    "history-preview": "Appointment history",
    team: "Team",
    services: "Treatments",
    users: "Accounts",
  }[page];
  document
    .querySelectorAll("nav [data-page]")
    .forEach((b) =>
      b.classList.toggle(
        "active",
        b.dataset.page ===
          (page === "monthly"
            ? "reports"
            : ["client-transfer", "history-preview"].includes(page)
              ? "clients"
              : page),
      ),
    );
  try {
    if (page === "calendar") {
      renderCalendarShell();
      await loadCalendar();
    } else if (page === "monthly") {
      const version = state.version;
      await renderMonthly(
        {
          root: $("page-content"),
          api,
          esc,
          money,
          stamp,
          clock,
          statusName,
          catalogue: state.catalogue,
          isCurrent: () => state.version === version && owner(),
          download: downloadReport,
          openReports: () => setPage("reports"),
        },
        monthlyFilters,
        /^#report=[a-f0-9]{64}$/.test(location.hash)
          ? location.hash.slice(8)
          : null,
      );
    } else if (page === "reports" || page === "dashboard") {
      const version = state.version;
      await renderReports(
        {
          root: $("page-content"),
          api,
          esc,
          money,
          stamp,
          clock,
          statusName,
          catalogue: state.catalogue,
          isCurrent: () => state.version === version && owner(),
          download: downloadReport,
          openReports: () => setPage("reports"),
          openMonthly: (filters) => setPage("monthly", filters),
        },
        page === "dashboard",
      );
    } else if (page === "sales") {
      const version = state.version;
      await renderSales({
        root: $("page-content"),
        api,
        esc,
        money,
        stamp,
        today,
        isCurrent: () => state.version === version && owner(),
        showDrawer,
        closeDrawer,
        toast,
        openProfile: clientProfile,
        download: (query) => downloadReport(query, "/api/sales/vouchers.csv?"),
      });
    } else if (page === "history-preview") {
      const version = state.version;
      historyPreviewCleanup = renderHistoryPreview({
        root: $("page-content"),
        api,
        esc,
        isCurrent: () => state.version === version && owner(),
        back: () => setPage("clients"),
        openProfile: clientProfile,
      });
    } else if (page === "client-transfer") {
      const version = state.version;
      renderClientTransfer({
        root: $("page-content"),
        api,
        esc,
        isCurrent: () => state.version === version && owner(),
        back: () => setPage("clients"),
        openProfile: clientProfile,
      });
    } else if (page === "clients") await renderClients();
    else if (page === "team") await renderTeam();
    else if (page === "services") await renderServices();
    else await renderUsers();
  } catch (error) {
    showAppError(error);
  }
}
async function downloadReport(
  query,
  endpoint = "/api/reports/appointments.csv?",
) {
  const epoch = sessionEpoch;
  const response = await fetch(endpoint + query, {
    credentials: "same-origin",
  });
  if (epoch !== sessionEpoch || !owner())
    throw new Error("The session changed.");
  if (response.status === 401) {
    signOutView();
    throw new Error("Please sign in again.");
  }
  if (!response.ok)
    throw new Error((await response.json()).error || "Export failed.");
  const blob = await response.blob();
  if (epoch !== sessionEpoch || !owner())
    throw new Error("The session changed.");
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download =
    response.headers
      .get("content-disposition")
      ?.match(/filename="([^"]+)"/)?.[1] || "rei-report.csv";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function resources(mode = state.mode) {
  return [
    ...(mode === "rooms"
      ? []
      : state.catalogue.therapists.map((t) => ({
          ...t,
          kind: "therapist",
          capacity: 1,
        }))),
    ...(mode === "therapists"
      ? []
      : state.catalogue.rooms.map((r) => ({ ...r, kind: "room" }))),
  ];
}
function updateMobileNavigation() {
  const activePage =
    state.page === "monthly"
      ? "reports"
      : ["client-transfer", "history-preview"].includes(state.page)
        ? "clients"
        : state.page;
  $("mobile-navigation")
    .querySelectorAll("[data-mobile-page]")
    .forEach((button) => {
      const active = button.dataset.mobilePage === activePage;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
  $("mobile-more").classList.toggle(
    "active",
    !["calendar", "clients"].includes(activePage),
  );
}
function mobileMenu() {
  if (!state.user) return;
  const pages = [
    ["calendar", "Calendar"],
    ["dashboard", "Dashboard"],
    ["clients", "Clients"],
    ["team", "Team"],
    ["services", "Treatments"],
    ["sales", "Sales"],
    ["reports", "Reports"],
    ["users", "Accounts"],
  ].filter(
    ([page]) =>
      owner() || page === "calendar" || (operator() && page === "clients"),
  );
  showDrawer(
    "Menu",
    "Rei Booking",
    `<div class="mobile-menu-list">${pages.map(([page, label]) => `<button type="button" class="btn mobile-menu-route" data-mobile-page="${page}">${label}</button>`).join("")}</div><section class="mobile-account"><h3>${esc(state.user.name)}</h3><p>${esc($("signed-role").textContent)}</p><button type="button" class="btn" id="mobile-change-password">Change password</button><button type="button" class="btn" id="mobile-sign-out">Sign out</button></section>${errorBox()}`,
  );
  $("mobile-change-password").onclick = () => passwordDialog();
  $("mobile-sign-out").onclick = async (event) => {
    const button = event.currentTarget;
    if (button.disabled) return;
    button.disabled = true;
    await signOut();
    if (button.isConnected) button.disabled = false;
  };
}
function mobileAddMenu() {
  if (!operator()) return;
  showDrawer(
    "Add to calendar",
    prettyDate(state.date),
    '<div class="mobile-add-menu"><button type="button" class="btn primary" id="mobile-add-appointment">Add appointment</button><button type="button" class="btn" id="mobile-add-block">Add blocked time or note</button></div>',
  );
  const epoch = drawerEpoch,
    session = sessionEpoch;
  const open = async (kind) => {
    if (!operator() || epoch !== drawerEpoch || session !== sessionEpoch)
      return;
    closeDrawer();
    const ready =
        state.page !== "calendar" ? setPage("calendar") : Promise.resolve(),
      version = state.version,
      openingEpoch = drawerEpoch;
    await ready;
    if (
      session !== sessionEpoch ||
      version !== state.version ||
      openingEpoch !== drawerEpoch ||
      !operator() ||
      state.page !== "calendar"
    )
      return;
    if (kind === "appointment") await appointmentDialog();
    else calendarBlockDialog();
  };
  $("mobile-add-appointment").onclick = () =>
    open("appointment").catch(showAppError);
  $("mobile-add-block").onclick = () => open("block").catch(showAppError);
}
function calendarLegendHTML() {
  return (
    state.catalogue.services
      .filter((s) => s.active)
      .map(
        (s) =>
          `<span><i style="background:${esc(s.color)}"></i>${esc(s.name)} · ${s.duration} min</span>`,
      )
      .join("") +
    "<span>♥ Requested therapist</span><span>▧ Blocked time</span><span>✎ Note only</span>"
  );
}
function selectCalendarMode(mode) {
  if (
    !["all", "therapists", "rooms"].includes(mode) ||
    state.page !== "calendar"
  )
    return;
  calendarModes[calendarLayout()] = mode;
  state.mode = mode;
  calendarLayoutKey = calendarLayout();
  renderCalendarShell();
  renderCalendar();
}
function calendarOptions() {
  if (!state.user || state.page !== "calendar") return;
  showDrawer(
    "Calendar view",
    "View and options",
    `<div class="calendar-mobile-options"><div class="mobile-menu-list">${[
      ["all", "All resources"],
      ["therapists", "Therapists"],
      ["rooms", "Rooms"],
    ]
      .map(
        ([mode, label]) =>
          `<button type="button" class="btn ${state.mode === mode ? "primary" : ""}" data-mobile-mode="${mode}" aria-pressed="${state.mode === mode}">${label}</button>`,
      )
      .join(
        "",
      )}</div><button type="button" class="btn" id="mobile-calendar-refresh">Refresh calendar</button><h3>Treatments and calendar key</h3><div class="legend calendar-options-legend">${calendarLegendHTML()}</div></div>`,
  );
  $("drawer-content")
    .querySelectorAll("[data-mobile-mode]")
    .forEach((button) => {
      button.onclick = () => {
        closeDrawer();
        selectCalendarMode(button.dataset.mobileMode);
        $("calendar-view-options")?.focus({ preventScroll: true });
      };
    });
  $("mobile-calendar-refresh").onclick = () => {
    closeDrawer();
    $("calendar-view-options")?.focus({ preventScroll: true });
    loadCalendar().catch(showAppError);
  };
}
function scheduleCalendarLayoutSync() {
  if (calendarResizeFrame) return;
  calendarResizeFrame = requestAnimationFrame(() => {
    calendarResizeFrame = 0;
    if (!state.user || state.page !== "calendar" || !$("calendar-scroll"))
      return;
    if ($("drawer").open || calendarReschedule?.isActive()) {
      calendarLayoutPending = true;
      return;
    }
    const changed =
      calendarLayoutKey !== calendarLayout() ||
      SCALE !== (mobileCalendarMedia.matches ? 1 : 2) ||
      Math.abs($("calendar-scroll").clientWidth - calendarRenderedWidth) >= 1;
    calendarLayoutPending = false;
    if (changed) renderCalendar();
  });
}
async function openTreatmentSetup() {
  if (!owner()) return;
  const session = sessionEpoch,
    version = state.version + 1;
  await setPage("services");
  if (
    session !== sessionEpoch ||
    state.version !== version ||
    state.page !== "services" ||
    !owner() ||
    !$("service-add")
  )
    return;
  serviceDialog();
}
function calendarTreatmentSetupHTML() {
  if (!operator() || state.catalogue.services.some((s) => s.active)) return "";
  return `<div class="calendar-setup-hint" id="calendar-treatment-setup" role="status"><p>${owner() ? "Add a treatment to start booking." : "Ask the owner to add treatments."}</p>${owner() ? '<button type="button" class="btn" id="calendar-treatment-add">Add treatment</button>' : ""}</div>`;
}
function renderCalendarShell() {
  const previousScroll = $("calendar-scroll")?.dataset.initialized
    ? {
        minute:
          $("calendar-scroll").scrollTop /
          (Number($("calendar-scroll").dataset.scale) || SCALE),
        left: $("calendar-scroll").scrollLeft,
      }
    : null;
  disposeCalendarUI();
  const layout = calendarLayout();
  if (layout !== calendarLayoutKey) {
    calendarModes[calendarLayoutKey] = state.mode;
    state.mode = calendarModes[layout];
    calendarLayoutKey = layout;
  }
  $("page-content").innerHTML =
    `<div class="toolbar calendar-toolbar"><div class="toolgroup calendar-primary-tools"><div class="calendar-date-controls"><button class="btn" id="calendar-today">Today</button><button class="btn" id="calendar-prev" aria-label="Previous day">‹</button><input id="calendar-date" type="date" value="${state.date}" aria-label="Calendar date"><button class="btn" id="calendar-next" aria-label="Next day">›</button><button type="button" class="btn mobile-calendar-control" id="calendar-view-options" aria-label="Calendar view and options" aria-haspopup="dialog">View</button></div><div class="calendar-resource-controls"><div class="segments" aria-label="Calendar resources">${[
      ["all", "All resources"],
      ["therapists", "Therapists"],
      ["rooms", "Rooms"],
    ]
      .map(
        ([value, label]) =>
          `<button data-mode="${value}" class="${state.mode === value ? "active" : ""}">${label}</button>`,
      )
      .join(
        "",
      )}</div><button class="btn" id="calendar-refresh">Refresh</button></div></div>${operator() ? '<div class="calendar-add-actions"><button class="btn" id="calendar-block-add">Add blocked time</button><button class="btn primary" id="appointment-add">+ Add appointment</button></div>' : ""}</div><div class="calendar-card"><div class="calendar-meta"><span id="calendar-summary"></span><span>${operator() ? "Book in 15-minute steps · move in 5-minute steps · hold on touch" : "Full salon schedule · requested · read-only"}</span></div><div class="calendar-scroll" id="calendar-scroll"><div class="calendar-grid" id="calendar-grid"><div class="calendar-headers" id="calendar-headers"></div><div class="calendar-body" id="calendar-body"></div></div></div></div><button class="btn calendar-today-floating" id="calendar-today-floating" aria-label="Return to today" ${state.date === today() ? "hidden" : ""}><svg width="21" height="21" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2v4m8-4v4M3 9h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M9 15h6m-3-3v6" fill="none" stroke="currentColor" stroke-width="1.7"/></svg><span>Today</span></button><div class="legend">${state.catalogue.services
      .filter((s) => s.active)
      .map(
        (s) =>
          `<span><i style="background:${esc(s.color)}"></i>${esc(s.name)} · ${s.duration} min</span>`,
      )
      .join(
        "",
      )}<span>♥ Requested therapist</span><span>▧ Blocked time</span><span>✎ Note only</span></div>`;
  if (previousScroll) {
    $("calendar-scroll").dataset.initialized = "true";
    // The full grid has not been rendered yet; restore once its height exists.
    $("calendar-scroll").dataset.restoreMinute = String(previousScroll.minute);
    $("calendar-scroll").dataset.restoreLeft = String(previousScroll.left);
  }
  const change = async (date) => {
    disposeCalendarUI();
    state.date = date;
    $("calendar-date").value = date;
    updateClock();
    try {
      await loadCalendar();
    } catch (error) {
      showAppError(error);
    }
  };
  $("calendar-date").onchange = () => {
    if ($("calendar-date").value) change($("calendar-date").value);
  };
  $("calendar-today").onclick = () => change(today());
  $("calendar-today-floating").onclick = () => change(today());
  for (const [id, delta] of [
    ["calendar-prev", -1],
    ["calendar-next", 1],
  ])
    $(id).onclick = () => {
      const d = new Date(state.date + "T12:00:00Z");
      d.setUTCDate(d.getUTCDate() + delta);
      change(d.toISOString().slice(0, 10));
    };
  $("calendar-refresh").onclick = () => loadCalendar().catch(showAppError);
  $("calendar-view-options").onclick = calendarOptions;
  if (operator()) {
    $("appointment-add").onclick = () => appointmentDialog();
    $("calendar-block-add").onclick = () => calendarBlockDialog();
  }
  document
    .querySelectorAll("[data-mode]")
    .forEach((b) => (b.onclick = () => selectCalendarMode(b.dataset.mode)));
  const setup = calendarTreatmentSetupHTML();
  if (setup) {
    $("page-content").insertAdjacentHTML("afterbegin", setup);
    if ($("calendar-treatment-add"))
      $("calendar-treatment-add").onclick = () =>
        openTreatmentSetup().catch(showAppError);
  }
}
async function loadCalendar() {
  if (calendarReschedule?.isActive()) return;
  const requestEpoch = ++calendarLoadEpoch,
    date = state.date,
    version = state.version,
    data = await api(`/appointments?from=${date}&to=${date}`);
  if (
    requestEpoch !== calendarLoadEpoch ||
    calendarReschedule?.isActive() ||
    date !== state.date ||
    state.page !== "calendar" ||
    version !== state.version ||
    !state.user
  )
    return;
  state.appointments = data.appointments;
  state.blocks = data.blocks || [];
  renderCalendar();
}
function renderCalendar() {
  if (!$("calendar-grid")) return;
  if (calendarReschedule?.isActive()) return;
  const mobile = mobileCalendarMedia.matches,
    desiredScale = mobile ? 1 : 2;
  if (
    $("drawer").open &&
    (calendarLayoutKey !== calendarLayout() ||
      SCALE !== desiredScale ||
      Math.abs($("calendar-scroll").clientWidth - calendarRenderedWidth) >= 1)
  ) {
    calendarLayoutPending = true;
    return;
  }
  if (calendarLayoutKey !== calendarLayout()) renderCalendarShell();
  disposeCalendarUI();
  const list = resources(),
    scroll = $("calendar-scroll"),
    oldScale = Number(scroll.dataset.scale) || SCALE,
    logicalTop =
      scroll.dataset.restoreMinute !== undefined
        ? Number(scroll.dataset.restoreMinute)
        : scroll.dataset.initialized
          ? scroll.scrollTop / oldScale
          : 540 - START,
    left =
      scroll.dataset.restoreLeft !== undefined
        ? Number(scroll.dataset.restoreLeft)
        : scroll.scrollLeft;
  setCalendarScale(desiredScale);
  scroll.dataset.scale = String(SCALE);
  calendarRenderedWidth = scroll.clientWidth;
  calendarLayoutPending = false;
  delete scroll.dataset.restoreMinute;
  delete scroll.dataset.restoreLeft;
  scroll.dataset.initialized = "true";
  $("calendar-summary").textContent =
    `${prettyDate(state.date)} · ${state.appointments.filter((a) => !["cancelled", "no_show"].includes(a.status)).length} appointments`;
  const timeAxis = mobile ? 44 : 60,
    mobileColumnWidth = Math.max(80, (scroll.clientWidth - timeAxis) / 3),
    widths = list.map(() => (mobile ? mobileColumnWidth : 180));
  $("calendar-grid").style.setProperty("--time-axis-width", `${timeAxis}px`);
  $("calendar-grid").style.setProperty(
    "--calendar-quarter-height",
    `${BAND * SCALE}px`,
  );
  $("calendar-body").style.height = `${calendarHeight(END - START)}px`;
  $("calendar-grid").style.setProperty(
    "--columns",
    widths.map((w) => `minmax(${w}px, 1fr)`).join(" "),
  );
  $("calendar-grid").style.setProperty(
    "--grid-width",
    timeAxis + widths.reduce((a, b) => a + b, 0) + "px",
  );
  $("calendar-headers").innerHTML =
    "<div>Time</div>" +
    list
      .map(
        (r) =>
          `<div data-kind="${r.kind}">${r.kind === "room" ? `<span class="avatar room-avatar">${esc("R" + r.id.slice(1))}</span>` : avatar("therapists", r, esc)}<div>${esc(r.name)}<small>${r.kind === "room" ? r.capacity + " tables" : "Therapist"}</small></div></div>`,
      )
      .join("");
  let ticks = "";
  for (let m = START; m <= END; m += 30)
    ticks += `<span class="${m % 60 ? "time-half-hour" : "time-hour"}" style="top:${calendarTop(m)}px">${clock(m)}</span>`;
  $("calendar-body").innerHTML =
    '<div class="time-axis">' +
    ticks +
    "</div>" +
    list
      .map(
        (r) =>
          `<div class="calendar-column" data-resource="${esc(r.id)}" data-kind="${r.kind}" aria-label="${esc(r.name)}">${availability(r)}${calendarResourceItems(
            r,
            state.appointments,
            state.blocks,
          )
            .map((item) =>
              item.kind === "block"
                ? calendarBlockHTML(item, state.user.role)
                : eventHTML(item.record, r, item),
            )
            .join("")}</div>`,
      )
      .join("") +
    '<div class="now-line" id="now-line" hidden><span id="now-time"></span></div>';
  scroll.scrollTop = logicalTop * SCALE;
  scroll.scrollLeft = left;
  updateClock();
  const date = state.date,
    version = state.version,
    session = sessionEpoch,
    view = calendarViewEpoch;
  const current = () =>
    !!state.user &&
    state.page === "calendar" &&
    state.date === date &&
    state.version === version &&
    sessionEpoch === session &&
    calendarViewEpoch === view;
  const eligible = (a) => ["booked", "confirmed"].includes(a.status);
  if (operator()) {
    calendarReschedule = mountCalendarReschedule({
      root: scroll,
      getContext: () => ({
        date,
        role: state.user.role,
        resources: resources("all"),
        appointments: state.appointments.filter(eligible),
        blockingAppointments: state.appointments,
        blocks: state.blocks,
      }),
      isCurrent: () => current() && operator(),
      onSave: (candidate, original, { kind }) =>
        api(
          (kind === "block" ? "/calendar-blocks/" : "/appointments/") +
            encodeURIComponent(candidate.id),
          {
            method: "PUT",
            body: candidate,
          },
        ),
      onRefresh: () => loadCalendar(),
      onError: (error) => {
        if (current()) toast(error.message || String(error));
      },
      onModeChange: (active) => {
        calendarInteractions?.dismiss({ blockClick: active });
        appointmentPreview?.dismiss();
        if ($("calendar-today-floating"))
          $("calendar-today-floating").hidden =
            active || state.date === today();
        if (!active && calendarLayoutPending) scheduleCalendarLayoutSync();
      },
      confirmTherapistChange: () =>
        confirm(
          "Move this requested appointment to another therapist? The original request will stay recorded.",
        ),
    });
    calendarInteractions = mountCalendarInteractions({
      root: scroll,
      resources: list,
      date,
      onAdd: (defaults) =>
        appointmentDialog(null, defaults).catch(showAppError),
      onAddBlock: (defaults) => calendarBlockDialog(null, defaults),
      isCurrent: () =>
        current() && operator() && !calendarReschedule?.isActive(),
    });
  }
  appointmentPreview = mountAppointmentPreview({
    root: scroll,
    appointments: state.appointments,
    role: state.user.role,
    catalogue: state.catalogue,
    isCurrent: current,
    isBusy: () =>
      !!calendarReschedule?.isActive() ||
      $("drawer").open ||
      (!!$("calendar-slot-menu") && !$("calendar-slot-menu").hidden),
  });
  scroll.querySelectorAll("[data-calendar-block]").forEach((el) => {
    el.onclick = (event) => {
      event.stopPropagation();
      if (!current() || calendarReschedule?.shouldSuppressClick(event)) return;
      const block = state.blocks.find((b) => b.id === el.dataset.calendarBlock);
      if (block) calendarBlockDetails(block);
    };
  });
  scroll.querySelectorAll("[data-appointment]").forEach((el) => {
    const a = state.appointments.find((a) => a.id === el.dataset.appointment);
    el.onclick = (event) => {
      event.stopPropagation();
      if (!current() || calendarReschedule?.shouldSuppressClick(event)) return;
      appointmentDetails(a);
    };
    el.onkeydown = (event) => {
      if (["Enter", " "].includes(event.key)) {
        event.preventDefault();
        if (!current() || calendarReschedule?.isActive()) return;
        appointmentDetails(a);
      }
    };
  });
}
function availability(r) {
  if (r.kind !== "therapist") return "";
  const day = r.weekly[new Date(state.date + "T12:00:00Z").getUTCDay()],
    off = !r.active || !day.enabled || r.timeOff.includes(state.date);
  return (
    off
      ? [[START, END]]
      : [
          [START, day.start],
          [day.end, END],
        ]
  )
    .filter(([a, b]) => b > a)
    .map(
      ([a, b]) =>
        `<div class="unavailable" style="top:${calendarTop(a)}px;height:${calendarHeight(b - a)}px"><span>${off ? "Day off" : "Outside working hours"}</span></div>`,
    )
    .join("");
}
function eventHTML(a, r, layout = null) {
  const left = layout?.left ?? 0;
  const width = layout?.width ?? 100;
  return `<div class="calendar-event ${width < 100 ? "is-overlapping" : ""} ${a.duration <= 30 ? "short" : ""} ${a.duration <= 15 ? "very-short" : ""}" role="button" tabindex="0" data-appointment="${esc(a.id)}" style="top:${calendarTop(a.start)}px;height:${calendarHeight(a.duration, 3)}px;left:calc(${left}% + 3px);width:calc(${width}% - 6px);--service:${esc(a.color)}" aria-label="${esc((operator() ? (a.clientName || "Walk-in") + " · " : "") + a.serviceName + " · " + clock(a.start) + " · " + a.duration + " minutes")}"><span class="event-time"><span class="event-start">${clock(a.start)}</span><span class="event-time-separator">–</span><span class="event-end">${clock(a.start + a.duration)}</span></span>${operator() ? '<span class="drag-grip" aria-hidden="true">⠿</span>' : ""}<strong>${esc(operator() ? a.clientName || "Walk-in" : a.serviceName)}</strong><span class="event-service">${operator() ? esc(a.serviceName) : a.duration + " minutes"}</span><span class="event-room">${esc(r.kind === "room" ? therapist(a.therapistId)?.name : room(a.roomId)?.name + " · table " + (a.bed + 1))}</span>${a.requestedTherapistId ? '<span class="request-heart" title="Requested therapist">♥</span>' : ""}</div>`;
}
function updateClock() {
  const p = dateParts();
  $("clock").textContent = `${p.hour}:${p.minute} · Belgrade`;
  if ($("calendar-today-floating"))
    $("calendar-today-floating").hidden =
      state.date === today() || !!calendarReschedule?.isActive();
  if (!$("now-line")) return;
  const m = Number(p.hour) * 60 + Number(p.minute);
  $("now-line").hidden = state.date !== today() || m < START || m >= END;
  $("now-line").style.top = calendarTop(m) + "px";
  $("now-time").textContent = clock(m);
}
async function appointmentDialog(existing = null, defaults = {}) {
  if (!operator()) return;
  const needsTreatment = !state.catalogue.services.some((s) => s.active);
  const needsTherapist = !state.catalogue.therapists.some((t) => t.active);
  if (needsTreatment || needsTherapist) {
    showDrawer(
      "Set up bookings",
      "Calendar",
      `<p>${owner() ? "Complete the following before adding an appointment:" : "Ask the owner to complete the following before adding an appointment:"}</p><ul>${needsTreatment ? "<li>Add or activate a treatment in Treatments, with its duration and price.</li>" : ""}${needsTherapist ? "<li>Add or activate a team member in Team.</li>" : ""}</ul>${owner() ? `<div class="toolgroup">${needsTreatment ? '<button type="button" class="btn primary" id="booking-treatment-add">Add treatment</button>' : ""}${needsTherapist ? '<button type="button" class="btn" id="booking-team-setup">Open Team</button>' : ""}</div>` : ""}`,
    );
    if ($("booking-treatment-add"))
      $("booking-treatment-add").onclick = () =>
        openTreatmentSetup().catch(showAppError);
    if ($("booking-team-setup"))
      $("booking-team-setup").onclick = () => setPage("team");
    return;
  }
  const openingDate = existing?.date || defaults.date || state.date;
  showDrawer(
    existing ? "Appointment details" : "New appointment",
    prettyDate(openingDate),
    '<p id="booking-opening" class="hint" role="status" aria-live="polite" aria-busy="true">Loading appointment…</p>',
  );
  $("drawer-footer").innerHTML =
    '<button class="btn" id="form-cancel">Cancel</button>';
  $("form-cancel").onclick = closeDrawer;
  const openingEpoch = drawerEpoch,
    openingVersion = state.version,
    openingSession = sessionEpoch,
    openingCurrent = () =>
      $("drawer").open &&
      drawerEpoch === openingEpoch &&
      state.version === openingVersion &&
      sessionEpoch === openingSession &&
      operator();
  let clients;
  try {
    clients = (await api("/clients")).clients;
    if (!openingCurrent()) return;
    if (!Array.isArray(clients))
      throw new Error("Client details could not be loaded. Please try again.");
    if (
      existing?.clientId &&
      !clients.some((c) => c.id === existing.clientId)
    ) {
      const result = await api("/clients/" + existing.clientId);
      if (!openingCurrent()) return;
      if (!result.client || result.client.id !== existing.clientId)
        throw new Error(
          "Client details could not be loaded. Please try again.",
        );
      clients.push(result.client);
    }
  } catch (error) {
    if (!openingCurrent()) return;
    $("drawer-content").innerHTML =
      `<p class="error" id="booking-opening-error" role="alert">${esc(error.message)}</p><button class="btn primary" id="booking-opening-retry" type="button">Try again</button>`;
    $("booking-opening-retry").onclick = () => {
      if (openingCurrent())
        void appointmentDialog(existing, { ...defaults, date: openingDate });
    };
    return;
  }
  if (!openingCurrent()) return;
  state.clients = clients;
  const first = state.catalogue.services.find((s) => s.active),
    a = existing || {
      date: openingDate,
      start: 600,
      duration: first.duration,
      serviceId: first.id,
      therapistId: state.catalogue.therapists.find((t) => t.active).id,
      roomId: "r1",
      bed: 0,
      status: "booked",
      clientId: null,
      requestedTherapistId: null,
      note: "",
      grossCents: first.priceCents,
      netCents: first.priceCents,
      ...defaults,
    };
  showDrawer(
    existing ? "Appointment details" : "New appointment",
    prettyDate(a.date),
    `<form id="appointment-form" class="booking-form">
      <aside id="booking-summary" class="booking-summary" role="status" aria-live="polite" aria-atomic="true"></aside>
      <section class="booking-form-section" aria-labelledby="booking-client-heading">
        <h3 id="booking-client-heading" class="booking-section-heading">Client</h3>
        <div class="booking-client-controls"><div id="booking-client-photo"></div>
          <label><span>Find a client</span><input id="booking-client-search" type="search" placeholder="Search name, phone, email or Instagram"></label>
          <label><span>Selected client</span><select name="clientId" id="booking-client">${opts(state.clients, a.clientId, "Walk-in · no client selected")}</select></label>
          ${!existing ? '<label class="check"><input type="checkbox" id="new-client-check">Create a new client</label><fieldset id="new-client-fields" hidden disabled><legend>New client</legend><div class="fields booking-section-fields">' + input("newName", "Full name", "", "text", 'maxlength="100"') + input("newPhone", "Phone · optional", "", "tel") + input("newEmail", "Email · optional", "", "email") + input("newInstagram", "Instagram · optional", "", "text", 'maxlength="250" placeholder="@username or profile URL"') + '<label class="wide"><span>Client note</span><textarea name="newNote" maxlength="2000"></textarea></label><div id="booking-client-matches" class="client-matches wide" hidden></div>' + "</div></fieldset>" : ""}
          ${existing?.clientId ? '<button class="btn link" type="button" id="booking-open-profile">Open client profile</button>' : ""}
        </div>
      </section>
      <section class="booking-form-section" aria-labelledby="booking-treatment-heading">
        <h3 id="booking-treatment-heading" class="booking-section-heading">Treatment &amp; time</h3>
        <div class="fields booking-section-fields">
          <label class="wide"><span>Massage</span><select name="serviceId" id="booking-service">${state.catalogue.services
            .filter((s) => s.active || s.id === a.serviceId)
            .map(
              (s) =>
                `<option value="${esc(s.id)}" ${s.id === a.serviceId ? "selected" : ""}>${esc(s.name)} · ${s.duration} min</option>`,
            )
            .join("")}</select></label>
          ${input("date", "Date", a.date, "date", "required")}
          ${input("start", "Start time", clock(a.start), "time", 'step="300" required')}
          ${input("duration", "Duration (minutes)", a.duration, "number", 'min="5" max="720" step="5" required')}
          <label><span>Status</span><select name="status">${["booked", "confirmed", "done", "cancelled", "no_show"].map((s) => `<option value="${s}" ${s === a.status ? "selected" : ""}>${statusName(s)}</option>`).join("")}</select></label>
        </div>
      </section>
      <section class="booking-form-section" aria-labelledby="booking-resources-heading">
        <h3 id="booking-resources-heading" class="booking-section-heading">Therapist &amp; room</h3>
        <div class="fields booking-section-fields">
          <label class="wide"><span>Therapist</span><select name="therapistId">${opts(
            state.catalogue.therapists.filter(
              (t) => t.active || t.id === a.therapistId,
            ),
            a.therapistId,
          )}</select></label>
          <label><span>Room</span><select name="roomId" id="booking-room">${opts(state.catalogue.rooms, a.roomId)}</select></label>
          <label><span>Table</span><select name="bed" id="booking-bed"></select></label>
        </div>
      </section>
      ${owner() ? '<section class="booking-form-section" aria-labelledby="booking-pricing-heading"><h3 id="booking-pricing-heading" class="booking-section-heading">Pricing</h3><div class="fields booking-section-fields">' + input("grossCents", "Full price (RSD)", (a.grossCents / 100).toFixed(2), "number", 'min="0" step="0.01" required') + input("netCents", "After discount (RSD)", (a.netCents / 100).toFixed(2), "number", 'min="0" step="0.01" required') + "</div></section>" : ""}
      <section class="booking-form-section" aria-labelledby="booking-notes-heading">
        <h3 id="booking-notes-heading" class="booking-section-heading">Requests &amp; notes</h3>
        <div class="fields booking-section-fields">
          <label class="wide"><span>Requested therapist · optional</span><select name="requestedTherapistId">${opts(state.catalogue.therapists, a.requestedTherapistId, "No specific request")}</select></label>
          <label class="wide"><span>Appointment note</span><textarea name="note" rows="3" maxlength="2000">${esc(a.note)}</textarea></label>
        </div>
      </section>
      ${existing ? `<p class="hint">Booked on ${esc(stamp(a.createdAt))}</p>` : ""}${errorBox()}
    </form>`,
  );
  const form = $("appointment-form"),
    formEpoch = drawerEpoch,
    formCurrent = () =>
      form.isConnected &&
      $("drawer").open &&
      drawerEpoch === formEpoch &&
      state.version === openingVersion &&
      sessionEpoch === openingSession &&
      operator(),
    beds = (selected = a.bed) => {
      const capacity = room($("booking-room").value)?.capacity || 0;
      selected = Math.min(capacity - 1, Math.max(0, Number(selected)));
      $("booking-bed").innerHTML = Array.from(
        { length: capacity },
        (_, i) =>
          `<option value="${i}" ${i === selected ? "selected" : ""}>Table ${i + 1}</option>`,
      ).join("");
    };
  const summaryFields = new Set([
    "date",
    "start",
    "duration",
    "serviceId",
    "therapistId",
    "roomId",
    "bed",
  ]);
  const refreshSummary = () => {
    if (!formCurrent()) return;
    const selection = Object.fromEntries(
      [...summaryFields].map((name) => [name, form.elements[name].value]),
    );
    $("booking-summary").innerHTML = bookingSummaryHTML(
      selection,
      state.catalogue,
    );
  };
  for (const eventName of ["input", "change"])
    form.addEventListener(eventName, (event) => {
      if (summaryFields.has(event.target.name)) refreshSummary();
    });
  let availability = null;
  const availabilityEpoch = drawerEpoch,
    availabilityVersion = state.version;
  if (!existing) {
    const feedback = document.createElement("p");
    feedback.id = "booking-availability";
    feedback.className = "booking-availability";
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    form.elements.bed.closest(".fields").after(feedback);
  }
  if (existing && owner()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn";
    button.textContent = "Voucher payment & history";
    form.after(button);
    let dirty = false;
    form.addEventListener("change", () => {
      dirty = true;
    });
    form.addEventListener("input", (event) => {
      if (event.target.name) dirty = true;
    });
    const version = state.version;
    button.onclick = () => {
      if (dirty) {
        toast("Save your appointment changes before opening voucher payment.");
        return;
      }
      openVoucherRedemption(
        {
          api,
          esc,
          money,
          stamp,
          today,
          showDrawer,
          closeDrawer,
          toast,
          isCurrent: () => state.version === version && owner(),
        },
        { appointmentId: existing.id },
      ).catch((error) => toast(error.message));
    };
  }
  if (!existing) {
    const epoch = drawerEpoch;
    form.clientMatches = mountClientMatches({
      form,
      container: $("booking-client-matches"),
      api,
      esc,
      phone: "newPhone",
      instagram: "newInstagram",
      email: "newEmail",
      current: () => epoch === drawerEpoch && operator() && $("drawer").open,
      onUse: (c) => {
        if (!state.clients.some((x) => x.id === c.id)) state.clients.push(c);
        $("booking-client").innerHTML = opts(
          state.clients,
          c.id,
          "Walk-in · no client selected",
        );
        $("new-client-check").checked = false;
        $("new-client-check").dispatchEvent(new Event("change"));
        toast("Selected existing client: " + c.name);
      },
    });
  }
  beds();
  refreshSummary();
  $("booking-room").onchange = () => {
    beds(existing ? a.bed : form.elements.bed.value);
    refreshSummary();
  };
  $("booking-service").onchange = () => {
    const s = service($("booking-service").value);
    if (!s) {
      refreshSummary();
      return;
    }
    form.elements.duration.value = s.duration;
    if (owner())
      form.elements.grossCents.value = form.elements.netCents.value = (
        s.priceCents / 100
      ).toFixed(2);
    refreshSummary();
  };
  const showClientPhoto = () => {
    const c = state.clients.find((c) => c.id === $("booking-client").value);
    $("booking-client-photo").innerHTML =
      c && !$("new-client-check")?.checked
        ? `<div class="profile-top">${avatar("clients", c, esc)}</div>`
        : "";
  };
  $("booking-client").addEventListener("change", showClientPhoto);
  showClientPhoto();
  let searchSequence = 0;
  $("booking-client-search").oninput = async () => {
    const sequence = ++searchSequence;
    try {
      const data = await api(
        "/clients?q=" + encodeURIComponent($("booking-client-search").value),
      );
      if (sequence !== searchSequence || !formCurrent()) return;
      const selected = $("booking-client").value,
        known = state.clients.find((c) => c.id === selected);
      state.clients = data.clients;
      if (known && !state.clients.some((c) => c.id === known.id))
        state.clients.unshift(known);
      $("booking-client").innerHTML = opts(
        state.clients,
        selected,
        "Walk-in · no client selected",
      );
      showClientPhoto();
    } catch (error) {
      if (sequence === searchSequence && formCurrent()) formError(error);
    }
  };
  if (!existing)
    $("new-client-check").onchange = () => {
      const enabled = $("new-client-check").checked;
      $("new-client-fields").hidden = !enabled;
      $("new-client-fields").disabled = !enabled;
      form.elements.newName.required = enabled;
      $("booking-client").disabled = enabled;
      showClientPhoto();
    };
  if (existing?.clientId)
    $("booking-open-profile").onclick = () =>
      clientProfile(existing.clientId, () => appointmentDialog(existing));
  bindForm(
    "appointment-form",
    async (fd, isCurrent) => {
      const body = {
        date: fd.get("date"),
        start: minutes(fd.get("start")),
        duration: Number(fd.get("duration")),
        serviceId: fd.get("serviceId"),
        therapistId: fd.get("therapistId"),
        roomId: fd.get("roomId"),
        bed: Number(fd.get("bed")),
        status: fd.get("status"),
        clientId: fd.get("clientId") || null,
        requestedTherapistId: fd.get("requestedTherapistId") || null,
        note: fd.get("note"),
        ...(existing ? { version: existing.version } : {}),
      };
      if (owner()) {
        body.grossCents = Math.round(Number(fd.get("grossCents")) * 100);
        body.netCents = Math.round(Number(fd.get("netCents")) * 100);
      }
      if (!existing && $("new-client-check").checked)
        body.newClient = {
          name: fd.get("newName"),
          phone: fd.get("newPhone"),
          email: fd.get("newEmail"),
          instagram: fd.get("newInstagram"),
          note: fd.get("newNote"),
        };
      availability?.suspend();
      try {
        await api("/appointments" + (existing ? "/" + existing.id : ""), {
          method: existing ? "PUT" : "POST",
          body,
        });
      } catch (error) {
        if (isCurrent() && formCurrent()) void availability?.resume();
        throw error;
      }
      if (!isCurrent() || !formCurrent()) return;
      closeDrawer();
      await loadCalendar();
      toast("Appointment saved.");
    },
    "Save appointment",
  );
  if (!existing)
    availability = mountBookingAvailability({
      form,
      feedback: $("booking-availability"),
      catalogue: state.catalogue,
      defaults,
      loadAppointments: (date) => api(`/appointments?from=${date}&to=${date}`),
      applyResources: (selected) => {
        form.elements.therapistId.value = selected.therapistId;
        form.elements.roomId.value = selected.roomId;
        beds(selected.bed);
        refreshSummary();
      },
      isCurrent: () =>
        form.isConnected &&
        $("drawer").open &&
        availabilityEpoch === drawerEpoch &&
        availabilityVersion === state.version &&
        operator(),
    });
}
function calendarBlockDetails(block) {
  showDrawer(
    block.blocksAvailability ? "Blocked time" : "Calendar note",
    prettyDate(block.date),
    calendarBlockDetailsHTML(block, {
      role: state.user.role,
      catalogue: state.catalogue,
    }),
  );
  if (!operator()) return;
  const epoch = drawerEpoch,
    session = sessionEpoch,
    version = state.version;
  const current = () =>
    $("drawer").open &&
    drawerEpoch === epoch &&
    sessionEpoch === session &&
    state.version === version &&
    state.page === "calendar" &&
    operator();
  $("calendar-block-edit").onclick = () => {
    if (current()) calendarBlockDialog(block);
  };
  $("calendar-block-reschedule").onclick = () => {
    if (!current() || $("calendar-block-reschedule").disabled) return;
    closeDrawer();
    calendarReschedule?.beginBlock(block.id);
  };
  $("calendar-block-remove").onclick = async () => {
    const remove = $("calendar-block-remove"),
      edit = $("calendar-block-edit"),
      move = $("calendar-block-reschedule");
    if (
      !current() ||
      remove.disabled ||
      !confirm("Remove this calendar entry?")
    )
      return;
    remove.disabled = edit.disabled = move.disabled = true;
    $("calendar-block-error").hidden = true;
    try {
      await api("/calendar-blocks/" + encodeURIComponent(block.id), {
        method: "DELETE",
        body: { version: block.version },
      });
      if (!current()) return;
      closeDrawer();
      try {
        await loadCalendar();
      } catch (error) {
        if (sessionEpoch === session && state.page === "calendar")
          showAppError(error);
      }
      if (sessionEpoch === session) toast("Calendar entry removed.");
    } catch (error) {
      if (!current()) return;
      $("calendar-block-error").textContent = error.message;
      $("calendar-block-error").hidden = false;
      remove.disabled = edit.disabled = move.disabled = false;
    }
  };
}
function calendarBlockDialog(existing = null, defaults = {}) {
  if (!operator()) return;
  const groups = {
    therapist: state.catalogue.therapists,
    room: state.catalogue.rooms,
  };
  const types = Object.keys(groups).filter((type) => groups[type].length);
  if (!types.length) {
    toast("Add a team member or a room before adding blocked time.");
    return;
  }
  const preferredType = defaults.therapistId
    ? "therapist"
    : defaults.roomId
      ? "room"
      : types[0];
  const initialType = existing?.resourceType || preferredType;
  const type = types.includes(initialType) ? initialType : types[0];
  const initialId =
    existing?.resourceId || defaults.therapistId || defaults.roomId;
  const resourceId = groups[type].some((r) => r.id === initialId)
    ? initialId
    : groups[type][0].id;
  const b = existing || {
    date: defaults.date || state.date,
    start: defaults.start ?? 600,
    duration: Math.min(60, END - (defaults.start ?? 600)),
    resourceType: type,
    resourceId,
    bed: type === "room" ? (defaults.bed ?? null) : null,
    title: "Blocked time",
    note: "",
    blocksAvailability: true,
  };
  showDrawer(
    existing ? "Edit blocked time" : "Add blocked time",
    prettyDate(b.date),
    `<form id="calendar-block-form"><div class="fields"><label class="wide"><span>Title</span><input name="title" value="${esc(b.title)}" maxlength="120" required></label>${input("date", "Date", b.date, "date", "required")}${input("start", "Start time", clock(b.start), "time", 'step="300" required')}${input("duration", "Duration (minutes)", b.duration, "number", 'min="5" max="1440" step="5" required')}<label><span>Resource type</span><select name="resourceType" id="block-resource-type">${types.map((t) => `<option value="${t}" ${t === type ? "selected" : ""}>${t === "room" ? "Room" : "Therapist"}</option>`).join("")}</select></label><label class="wide"><span>Resource</span><select name="resourceId" id="block-resource"></select></label><label id="block-table-field"><span>Table</span><select name="bed" id="block-table"></select></label><label class="wide"><span>Note · optional</span><textarea name="note" rows="4" maxlength="2000">${esc(b.note || "")}</textarea></label></div><label class="check"><input name="blocksAvailability" type="checkbox" ${b.blocksAvailability ? "checked" : ""}>Block availability</label><p class="hint" id="block-availability-help">Turn this off for a reminder or call note. Notes stay on the calendar without preventing appointments.</p><p class="hint">Calendar entries can run from 00:00 to 24:00 on one day, in 5-minute steps.</p>${errorBox()}</form>`,
  );
  const form = $("calendar-block-form"),
    epoch = drawerEpoch,
    version = state.version,
    session = sessionEpoch;
  const current = () =>
    form.isConnected &&
    $("drawer").open &&
    drawerEpoch === epoch &&
    state.version === version &&
    sessionEpoch === session &&
    state.page === "calendar" &&
    operator();
  form.elements.blocksAvailability.setAttribute(
    "aria-describedby",
    "block-availability-help",
  );
  const tables = (selected = null) => {
    const isRoom = form.elements.resourceType.value === "room";
    $("block-table-field").hidden = !isRoom;
    form.elements.bed.disabled = !isRoom;
    const room = groups.room.find(
      (r) => r.id === form.elements.resourceId.value,
    );
    form.elements.bed.innerHTML =
      '<option value="">All tables</option>' +
      Array.from(
        { length: isRoom ? room?.capacity || 0 : 0 },
        (_, bed) =>
          `<option value="${bed}" ${selected === bed ? "selected" : ""}>Table ${bed + 1}</option>`,
      ).join("");
  };
  const populate = (selectedId = null, selectedBed = null) => {
    const entries = groups[form.elements.resourceType.value];
    form.elements.resourceId.innerHTML = opts(
      entries,
      selectedId || entries[0].id,
    );
    tables(selectedBed);
  };
  populate(resourceId, b.bed);
  form.elements.resourceType.onchange = () => populate();
  form.elements.resourceId.onchange = () => tables();
  bindForm(
    "calendar-block-form",
    async (data, formCurrent) => {
      if (!current() || !formCurrent()) return;
      const start = minutes(data.get("start")),
        duration = Number(data.get("duration"));
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(duration) ||
        start % 5 ||
        duration % 5 ||
        start < 0 ||
        duration < 5 ||
        start + duration > END
      )
        throw new Error(
          "Choose a time and duration in 5-minute steps ending by 24:00 on the same day.",
        );
      const resourceType = data.get("resourceType");
      await api(
        "/calendar-blocks" +
          (existing ? "/" + encodeURIComponent(existing.id) : ""),
        {
          method: existing ? "PUT" : "POST",
          body: {
            date: data.get("date"),
            start,
            duration,
            resourceType,
            resourceId: data.get("resourceId"),
            bed:
              resourceType === "room" && data.get("bed") !== ""
                ? Number(data.get("bed"))
                : null,
            title: data.get("title").trim(),
            note: data.get("note").trim(),
            blocksAvailability: data.has("blocksAvailability"),
            ...(existing ? { version: existing.version } : {}),
          },
        },
      );
      if (!current() || !formCurrent()) return;
      closeDrawer();
      await loadCalendar();
      toast("Calendar entry saved.");
    },
    "Save calendar entry",
  );
}
function appointmentDetails(a) {
  showDrawer(
    "Appointment",
    prettyDate(a.date),
    appointmentDetailsHTML(a, {
      role: state.user.role,
      catalogue: state.catalogue,
      variant: "summary",
    }),
  );
  if ($("appointment-summary-edit"))
    $("appointment-summary-edit").onclick = () =>
      appointmentDialog(a).catch(showAppError);
  if ($("appointment-summary-client"))
    $("appointment-summary-client").onclick = () =>
      clientProfile(a.clientId, () => appointmentDetails(a));
  if ($("appointment-summary-reschedule"))
    $("appointment-summary-reschedule").onclick = () => {
      closeDrawer();
      calendarReschedule?.begin(a.id);
    };
}

async function renderClients() {
  $("page-content").innerHTML =
    '<div class="toolbar"><input type="search" id="client-search" placeholder="Search name, phone, email or Instagram" aria-label="Search clients"><button class="btn primary" id="client-add">+ New client</button></div><div id="client-results"></div>';
  const version = state.version;
  if (owner()) {
    $("client-add").insertAdjacentHTML(
      "beforebegin",
      '<button class="btn" id="client-import">Import clients</button><button class="btn" id="history-preview-open">Import history</button><button class="btn" id="client-export">Export CSV</button>',
    );
    $("client-import").onclick = () => setPage("client-transfer");
    $("history-preview-open").onclick = () => setPage("history-preview");
    $("client-export").onclick = () => {
      showDrawer(
        "Export clients",
        "Clients",
        '<p>Export all client profiles as a UTF-8 CSV. Photos and appointment history are not included.</p><label class="check"><input type="checkbox" id="client-export-notes"> Include client notes</label><p id="client-export-error" class="error" role="alert" hidden></p>',
      );
      $("drawer-footer").innerHTML =
        '<button class="btn primary" id="client-export-download">Download CSV</button>';
      const epoch = drawerEpoch;
      $("client-export-download").onclick = async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await downloadReport(
            "notes=" + $("client-export-notes").checked,
            "/api/clients/export.csv?",
          );
          if (epoch === drawerEpoch) closeDrawer();
        } catch (error) {
          if (epoch === drawerEpoch) {
            $("client-export-error").textContent = error.message;
            $("client-export-error").hidden = false;
            button.disabled = false;
          }
        }
      };
    };
  }
  $("client-add").onclick = () => clientDialog();
  let sequence = 0;
  const search = async () => {
    const current = ++sequence;
    try {
      const data = await api(
        "/clients?q=" + encodeURIComponent($("client-search").value),
      );
      if (
        current !== sequence ||
        state.page !== "clients" ||
        state.version !== version
      )
        return;
      state.clients = data.clients;
      $("client-results").innerHTML = data.clients.length
        ? `<div class="table-wrap"><table><thead><tr><th>Client</th><th>Phone</th><th>Email / Instagram</th><th></th></tr></thead><tbody>${data.clients.map((c) => `<tr><td><div class="name-cell">${avatar("clients", c, esc)}<strong>${esc(c.name)}</strong></div></td><td>${esc(c.phone)}</td><td>${esc(c.email)}${c.instagram ? `<br>@${esc(c.instagram)}` : ""}</td><td><button class="btn" data-profile="${esc(c.id)}">Profile</button></td></tr>`).join("")}</tbody></table></div><p class="hint">Up to 100 matching clients. Use search to narrow the list.</p>`
        : '<div class="empty"><h2>No clients found</h2><p>Add a client or leave a booking as Walk-in.</p></div>';
      document
        .querySelectorAll("[data-profile]")
        .forEach((b) => (b.onclick = () => clientProfile(b.dataset.profile)));
    } catch (error) {
      showAppError(error);
    }
  };
  $("client-search").oninput = search;
  await search();
}
function clientDialog(c = null) {
  showDrawer(
    c ? "Edit client" : "New client",
    "Clients",
    `<form id="client-form"><div id="client-photo-editor"></div><div class="fields">${input("name", "Full name", c?.name, "text", 'required maxlength="100"')}${input("phone", "Phone · optional", c?.phone, "tel")}${input("email", "Email · optional", c?.email, "email")}${input("instagram", "Instagram · optional", c?.instagram, "text", 'maxlength="250" placeholder="@username or profile URL"')}<label class="wide"><span>Client note</span><textarea name="note" maxlength="2000">${esc(c?.note || "")}</textarea></label></div><div id="client-matches" class="client-matches" hidden></div>${errorBox()}</form>`,
  );
  const epoch = sessionEpoch;
  const photo = mountPhotoEditor(
    $("client-photo-editor"),
    c,
    "clients",
    esc,
    () => sessionEpoch === epoch && operator() && $("drawer").open,
  );
  const clientForm = $("client-form");
  clientForm.clientMatches = mountClientMatches({
    form: clientForm,
    container: $("client-matches"),
    api,
    esc,
    phone: "phone",
    instagram: "instagram",
    email: "email",
    exclude: c?.id || "",
    current: () => sessionEpoch === epoch && operator() && $("drawer").open,
    onOpen: clientProfile,
  });
  bindForm(
    "client-form",
    async (fd, current) => {
      const data = await api("/clients" + (c ? "/" + c.id : ""), {
        method: c ? "PUT" : "POST",
        body: {
          ...Object.fromEntries(fd),
          photo: photo.payload(),
          ...(c ? { version: c.version } : {}),
        },
      });
      if (!current()) return;
      closeDrawer();
      await setPage("clients");
      await clientProfile(data.id);
      toast("Client saved.");
    },
    "Save client",
  );
}
async function clientProfile(id, back = null) {
  const epoch = ++drawerEpoch;
  try {
    const { client: c, appointments: items } = await api("/clients/" + id);
    if (epoch !== drawerEpoch || !operator()) return;
    showDrawer(
      c.name,
      "Client profile",
      `<div class="profile-top">${avatar("clients", c, esc)}<div><h3>${esc(c.name)}</h3><p class="hint">${esc(c.phone || "No phone")}<br>${esc(c.email || "No email")}${c.instagram ? `<br><a href="https://www.instagram.com/${encodeURIComponent(c.instagram)}/" target="_blank" rel="noopener noreferrer">@${esc(c.instagram)}</a>` : ""}</p></div></div><h3 class="form-section">Client note</h3><p class="client-note">${esc(c.note || "No client note yet.")}</p><strong>${items.filter((a) => a.status === "done").length} completed visits</strong><p class="hint">${items.filter((a) => a.status === "cancelled").length} cancelled · ${items.filter((a) => a.status === "no_show").length} no-shows</p><h3 class="form-section">Bookings in Rei</h3><div class="history">${items.map((a) => `<article><strong>${esc(prettyDate(a.date))} · ${clock(a.start)}</strong><p>${esc(a.serviceName)} · ${a.duration} min</p><p>${esc(therapist(a.therapistId)?.name)} · ${esc(room(a.roomId)?.name)}</p><p><span class="status ${a.status}">${statusName(a.status)}</span>${a.requestedTherapistId ? " · ♥ Requested" : ""}</p></article>`).join("") || '<p class="hint">No appointments yet.</p>'}</div>`,
    );
    const historyRoot = document.createElement("section");
    historyRoot.id = "client-imported-history";
    $("drawer-content").append(historyRoot);
    const profileEpoch = drawerEpoch,
      profileSession = sessionEpoch;
    clientHistoryCleanup = mountClientHistory({
      root: historyRoot,
      api,
      esc,
      clientId: c.id,
      canViewSource: owner(),
      isCurrent: () =>
        historyRoot.isConnected &&
        $("drawer").open &&
        drawerEpoch === profileEpoch &&
        sessionEpoch === profileSession &&
        operator(),
    });
    $("drawer-footer").innerHTML =
      `${back ? '<button class="btn" id="profile-back">Back to appointment</button>' : ""}<button class="btn" id="profile-photo">Upload / change photo</button><button class="btn primary" id="profile-edit">Edit client</button>`;
    if (back) $("profile-back").onclick = back;
    $("profile-edit").onclick = () => clientDialog(c);
    $("profile-photo").onclick = () => {
      const epoch = sessionEpoch;
      showDrawer(
        "Profile photo",
        c.name,
        `<form id="client-photo-form"><div id="profile-photo-editor"></div>${errorBox()}</form>`,
      );
      const photo = mountPhotoEditor(
        $("profile-photo-editor"),
        c,
        "clients",
        esc,
        () => epoch === sessionEpoch && operator() && $("drawer").open,
      );
      bindForm(
        "client-photo-form",
        async (_fd, current) => {
          const payload = photo.payload();
          if (payload)
            await api(`/photos/clients/${c.id}`, {
              method: "PUT",
              body: payload,
            });
          if (epoch !== sessionEpoch || !current()) return;
          closeDrawer();
          if (state.page === "clients") await renderClients();
          await clientProfile(c.id, back);
          toast("Profile photo saved.");
        },
        "Save photo",
      );
    };
  } catch (error) {
    toast(error.message);
  }
}

async function renderTeam() {
  await loadCatalogue();
  if (state.page !== "team") return;
  $("page-content").innerHTML =
    `<div class="toolbar"><p class="hint">Profiles, working hours and time off.</p><button class="btn primary" id="team-add">+ Team member</button></div><div class="cards">${
      state.catalogue.therapists
        .map(
          (t) =>
            `<article class="team-card"><header>${avatar("therapists", t, esc)}<div><h3>${esc(t.name)}</h3><small>${t.active ? "Active" : "Inactive"}</small></div></header><p>${esc(t.fullName || "Therapist")}<br>Days off: ${
              t.weekly
                .map((d, i) =>
                  !d.enabled
                    ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][i]
                    : "",
                )
                .filter(Boolean)
                .join(", ") || "None set"
            }<br>${t.timeOff.length} dated days off</p><button class="btn" data-team="${esc(t.id)}">Edit team member</button></article>`,
        )
        .join("") ||
      '<div class="empty"><h2>Your team starts here</h2><p>Add therapist profiles before booking.</p></div>'
    }</div>`;
  $("team-add").onclick = () => teamDialog();
  document
    .querySelectorAll("[data-team]")
    .forEach((b) => (b.onclick = () => teamDialog(therapist(b.dataset.team))));
}
function bonusFields(t) {
  const b = t?.bonus || {
    mode: "hourly",
    regularRate: 10000,
    requestedRate: 50000,
  };
  return `<h3 class="form-section">Bonus settings</h3><label><span>Calculation</span><select name="bonusMode" id="bonus-mode"><option value="hourly" ${b.mode === "hourly" ? "selected" : ""}>Fixed amount per hour</option><option value="percent" ${b.mode === "percent" ? "selected" : ""}>Percentage of full price</option></select></label><p class="hint" id="bonus-unit">${b.mode === "hourly" ? "RSD per hour of massage" : "Percentage of full treatment price"}</p><div class="fields">${input("bonusRegular", "Regular", (b.regularRate / 100).toFixed(2), "number", `min="0" max="${b.mode === "percent" ? 100 : 1000000}" step="0.01" required`)}${input("bonusRequested", "Requested", (b.requestedRate / 100).toFixed(2), "number", `min="0" max="${b.mode === "percent" ? 100 : 1000000}" step="0.01" required`)}</div><p class="hint">Rate changes apply to new appointments. Reassigning an unfinished appointment uses the new therapist’s rate. Completed appointments keep their saved rates. Requested replaces the regular rate when the requested therapist performs the massage. Earned bonuses appear in Reports.</p>`;
}
function teamDialog(t = null) {
  const week =
    t?.weekly ||
    Array.from({ length: 7 }, () => ({ enabled: true, start: 600, end: 1320 }));
  showDrawer(
    t ? "Edit team member" : "New team member",
    "Team",
    `<form id="team-form"><div id="team-photo-editor"></div><div class="fields">${input("name", "Display name", t?.name, "text", 'required maxlength="70"')}${input("fullName", "Full name", t?.fullName)}${input("phone", "Phone", t?.phone, "tel")}${input("email", "Email", t?.email, "email")}<label class="wide"><span>Owner note</span><textarea name="note" maxlength="2000">${esc(t?.note || "")}</textarea></label></div><label class="check"><input name="active" type="checkbox" ${t?.active !== false ? "checked" : ""}>Active therapist</label><h3 class="form-section">Weekly working hours</h3>${[1, 2, 3, 4, 5, 6, 0].map((d) => `<div class="weekly-row"><label><input type="checkbox" name="day-${d}" ${week[d].enabled ? "checked" : ""}>${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]}</label><input name="start-${d}" type="time" value="${clock(week[d].start)}" step="300" required aria-label="Start on day ${d}"><span>–</span><input name="end-${d}" type="time" value="${clock(week[d].end)}" step="300" required aria-label="End on day ${d}"></div>`).join("")}${bonusFields(t)}<h3 class="form-section">Time off</h3><label><span>Dates · one YYYY-MM-DD date per line</span><textarea name="timeOff" rows="3">${esc(t?.timeOff.join("\n") || "")}</textarea></label><p class="hint">Existing bookings must be moved before changing availability that would conflict with them. Account access is managed in Accounts.</p>${errorBox()}</form>`,
  );
  const epoch = sessionEpoch;
  const photo = mountPhotoEditor(
    $("team-photo-editor"),
    t,
    "therapists",
    esc,
    () => epoch === sessionEpoch && owner() && $("drawer").open,
  );
  $("bonus-mode").onchange = () => {
    const percent = $("bonus-mode").value === "percent";
    const form = $("team-form");
    const original = t?.bonus?.mode === $("bonus-mode").value ? t.bonus : null;
    form.elements.bonusRegular.value = original
      ? original.regularRate / 100
      : percent
        ? 0
        : 100;
    form.elements.bonusRequested.value = original
      ? original.requestedRate / 100
      : percent
        ? 0
        : 500;
    form.elements.bonusRegular.max = form.elements.bonusRequested.max = percent
      ? 100
      : 1000000;
    $("bonus-unit").textContent = percent
      ? "Percentage of full treatment price"
      : "RSD per hour of massage";
  };
  bindForm(
    "team-form",
    async (fd, current) => {
      const body = {
        photo: photo.payload(),
        name: fd.get("name"),
        fullName: fd.get("fullName"),
        phone: fd.get("phone"),
        email: fd.get("email"),
        note: fd.get("note"),
        active: fd.has("active"),
        bonus: {
          mode: fd.get("bonusMode"),
          regularRate: Math.round(Number(fd.get("bonusRegular")) * 100),
          requestedRate: Math.round(Number(fd.get("bonusRequested")) * 100),
        },
        weekly: Array.from({ length: 7 }, (_, d) => ({
          enabled: fd.has("day-" + d),
          start: minutes(fd.get("start-" + d)),
          end: minutes(fd.get("end-" + d)),
        })),
        timeOff: fd.get("timeOff").split(/\s+/).filter(Boolean),
        ...(t ? { version: t.version } : {}),
      };
      await api("/therapists" + (t ? "/" + t.id : ""), {
        method: t ? "PUT" : "POST",
        body,
      });
      if (!current()) return;
      closeDrawer();
      await renderTeam();
      toast("Team member saved.");
    },
    "Save team member",
  );
}
async function renderServices() {
  await loadCatalogue();
  if (state.page !== "services") return;
  $("page-content").innerHTML =
    `<div class="toolbar"><p class="hint">Each duration and price is a treatment variant.</p><button class="btn primary" id="service-add">+ Treatment</button></div><div class="table-wrap"><table><thead><tr><th>Treatment</th><th>Duration</th><th>Price</th><th>Status</th><th></th></tr></thead><tbody>${state.catalogue.services.map((s) => `<tr><td><span style="color:${esc(s.color)}">●</span> ${esc(s.name)}</td><td>${s.duration} min</td><td>${money(s.priceCents)}</td><td>${s.active ? "Active" : "Archived"}</td><td><button class="btn" data-service="${esc(s.id)}">Edit</button></td></tr>`).join("")}</tbody></table></div>`;
  $("service-add").onclick = () => serviceDialog();
  document
    .querySelectorAll("[data-service]")
    .forEach(
      (b) => (b.onclick = () => serviceDialog(service(b.dataset.service))),
    );
}
function serviceDialog(s = null) {
  showDrawer(
    s ? "Edit treatment" : "New treatment",
    "Treatment catalogue",
    `<form id="service-form"><div class="fields">${input("name", "Treatment name", s?.name, "text", 'required maxlength="120"')}${input("duration", "Duration (minutes)", s?.duration || 60, "number", 'min="5" max="720" step="5" required')}${input("price", "Price (RSD)", s ? (s.priceCents / 100).toFixed(2) : "", "number", 'min="0" step="0.01" required')}${input("color", "Calendar colour", s?.color || "#2e87a0", "color")}</div><label class="check"><input name="active" type="checkbox" ${s?.active !== false ? "checked" : ""}>Active treatment</label><p class="hint">Existing appointments keep their recorded treatment name and price.</p>${errorBox()}</form>`,
  );
  bindForm(
    "service-form",
    async (fd) => {
      await api("/services" + (s ? "/" + s.id : ""), {
        method: s ? "PUT" : "POST",
        body: {
          name: fd.get("name"),
          duration: Number(fd.get("duration")),
          priceCents: Math.round(Number(fd.get("price")) * 100),
          color: fd.get("color"),
          active: fd.has("active"),
          ...(s ? { version: s.version } : {}),
        },
      });
      closeDrawer();
      await renderServices();
      toast("Treatment saved.");
    },
    "Save treatment",
  );
}
async function renderUsers() {
  const { users } = await api("/users");
  if (state.page !== "users") return;
  $("page-content").innerHTML =
    `<div class="toolbar"><p class="hint">Grant access separately from team profiles.</p><button class="btn primary" id="user-add">+ Account</button></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Access</th><th></th></tr></thead><tbody>${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${u.active ? "Enabled" : "Disabled"}</td><td>${u.id !== state.user.id ? `<button class="btn" data-user="${esc(u.id)}">${u.active ? "Disable" : "Enable"}</button>` : "Your account"}</td></tr>`).join("")}</tbody></table></div>`;
  $("user-add").onclick = userDialog;
  document.querySelectorAll("[data-user]").forEach(
    (b) =>
      (b.onclick = async () => {
        const u = users.find((u) => u.id === b.dataset.user);
        try {
          await api("/users/" + u.id + "/active", {
            method: "PUT",
            body: { active: !u.active },
          });
          await renderUsers();
          toast("Account access updated.");
        } catch (error) {
          showAppError(error);
        }
      }),
  );
}
function userDialog() {
  showDrawer(
    "New account",
    "Access management",
    `<form id="user-form"><div class="fields">${input("name", "Name", "", "text", "required")}${input("email", "Email", "", "email", 'required autocomplete="off"')}<label><span>Role</span><select name="role" id="user-role"><option value="reception">Reception</option><option value="therapist">Therapist</option><option value="owner">Owner</option></select></label><label id="user-therapist-field" hidden><span>Therapist profile</span><select name="therapistId">${opts(
      state.catalogue.therapists.filter((t) => t.active),
      "",
      "Select therapist",
    )}</select></label><label class="wide"><span>Temporary password</span><input name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required></label></div><p class="hint">Share the temporary password privately. The user must choose their own password at first sign-in. Therapists see the whole anonymous calendar; reception has no financial values or reports.</p>${errorBox()}</form>`,
  );
  $("user-role").onchange = () => {
    $("user-therapist-field").hidden = $("user-role").value !== "therapist";
  };
  bindForm(
    "user-form",
    async (fd) => {
      await api("/users", { method: "POST", body: Object.fromEntries(fd) });
      closeDrawer();
      await renderUsers();
      toast("Account created.");
    },
    "Create account",
  );
}
function passwordDialog(required = false) {
  showDrawer(
    "Change password",
    required ? "First sign-in" : "Your account",
    `<form id="password-form"><div class="fields"><label class="wide"><span>Current password</span><input name="currentPassword" type="password" autocomplete="current-password" required maxlength="128"></label><label class="wide"><span>New password · at least 12 characters</span><input name="newPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="128"></label><label class="wide"><span>Repeat new password</span><input name="repeat" type="password" autocomplete="new-password" required minlength="12" maxlength="128"></label></div>${errorBox()}</form>`,
  );
  bindForm(
    "password-form",
    async (fd) => {
      if (fd.get("newPassword") !== fd.get("repeat"))
        throw new Error("The new passwords do not match.");
      await api("/password", { method: "POST", body: Object.fromEntries(fd) });
      signOutView();
      toast("Password updated. Sign in with your new password.");
    },
    "Update password",
  );
}
$("drawer-close").onclick = closeDrawer;
$("drawer").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDrawer();
});
$("login-form").onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget,
    button = form.querySelector("button");
  button.disabled = true;
  $("login-error").hidden = true;
  try {
    const session = await api("/login", {
      method: "POST",
      body: Object.fromEntries(new FormData(form)),
    });
    form.reset();
    await enterApp(session);
  } catch (error) {
    $("login-error").textContent = error.message;
    $("login-error").hidden = false;
  } finally {
    button.disabled = false;
  }
};
async function signOut() {
  try {
    await api("/logout", { method: "POST" });
    signOutView();
  } catch (error) {
    if ($("drawer").open && $("form-error")) formError(error);
    else showAppError(error);
  }
}
$("sign-out").onclick = signOut;
$("change-password").onclick = () => passwordDialog();
$("mobile-more").onclick = mobileMenu;
$("mobile-add").onclick = mobileAddMenu;
document.addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-mobile-page]");
  if (button && state.user) void setPage(button.dataset.mobilePage);
});
window.addEventListener("resize", scheduleCalendarLayoutSync);
for (const eventName of ["pointerup", "pointercancel"])
  document.addEventListener(eventName, () => {
    if (calendarLayoutPending) scheduleCalendarLayoutSync();
  });
mobileCalendarMedia.addEventListener("change", scheduleCalendarLayoutSync);
document
  .querySelectorAll("nav [data-page]")
  .forEach((b) => (b.onclick = () => setPage(b.dataset.page)));
window.addEventListener("focus", () => {
  if (
    state.user &&
    state.page === "calendar" &&
    !calendarReschedule?.isActive()
  )
    loadCalendar().catch(showAppError);
});
setInterval(updateClock, 15000);
try {
  await enterApp(await api("/session"));
} catch (error) {
  signOutView();
  if (error.status !== 401) {
    $("login-error").textContent = error.message;
    $("login-error").hidden = false;
  }
}

window.addEventListener("hashchange", () => {
  if (owner() && /^#report=[a-f0-9]{64}$/.test(location.hash))
    setPage("monthly");
});
