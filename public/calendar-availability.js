const released = (status) => ["cancelled", "no_show"].includes(status);
const resourceFields = ["therapistId", "roomId", "bed"];

function validDate(value) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

// Suggestions are advisory. The API still validates availability atomically.
export function suggestBookingResources({
  catalogue,
  appointments,
  blocks = [],
  selection,
  fixed = {},
}) {
  const { date, start, duration } = selection;
  const unchanged = (message) => ({ available: false, selection, message });
  if (
    !validDate(date) ||
    !Number.isInteger(start) ||
    !Number.isInteger(duration)
  )
    return unchanged(
      "Choose a date, start time and duration to check availability.",
    );
  if (
    start % 5 ||
    duration % 5 ||
    start < 600 ||
    duration < 5 ||
    duration > 720 ||
    start + duration > 1320
  )
    return unchanged(
      "Use 5-minute steps between 10:00 and 22:00, including the full treatment.",
    );
  const selectedRoom = catalogue.rooms.find((r) => r.id === selection.roomId);
  if (fixed.roomId && !selectedRoom)
    return unchanged("Choose an available room.");
  if (
    fixed.bed &&
    (!selectedRoom ||
      !Number.isInteger(selection.bed) ||
      selection.bed < 0 ||
      selection.bed >= selectedRoom.capacity)
  )
    return unchanged("Choose a valid table for this room.");
  if (released(selection.status))
    return {
      available: true,
      selection,
      message: "This status does not reserve a therapist or table.",
    };
  const day = new Date(date + "T12:00:00Z").getUTCDay();
  const overlaps = appointments.filter(
    (a) =>
      a.date === date &&
      !released(a.status) &&
      a.id !== selection.id &&
      a.start < start + duration &&
      a.start + a.duration > start,
  );
  const blocking = blocks.filter(
    (b) =>
      b.blocksAvailability &&
      b.date === date &&
      b.start < start + duration &&
      b.start + b.duration > start,
  );
  const availableTherapists = catalogue.therapists.filter((t) => {
    const hours = t.weekly[day];
    return (
      t.active &&
      hours?.enabled &&
      !t.timeOff.includes(date) &&
      hours.start <= start &&
      hours.end >= start + duration &&
      !overlaps.some((a) => a.therapistId === t.id) &&
      !blocking.some(
        (b) => b.resourceType === "therapist" && b.resourceId === t.id,
      )
    );
  });
  const therapists = availableTherapists.filter(
    (t) => !fixed.therapistId || t.id === selection.therapistId,
  );
  if (!therapists.length)
    return unchanged(
      fixed.therapistId
        ? "This therapist is unavailable for the full treatment. Choose another time or therapist."
        : "No therapist is available for the full treatment. Choose another time or duration.",
    );
  const tables = catalogue.rooms
    .flatMap((r) =>
      Array.from({ length: r.capacity }, (_, bed) => ({ roomId: r.id, bed })),
    )
    .filter(
      (table) =>
        (!fixed.roomId || table.roomId === selection.roomId) &&
        (!fixed.bed || table.bed === selection.bed) &&
        !overlaps.some(
          (a) => a.roomId === table.roomId && a.bed === table.bed,
        ) &&
        !blocking.some(
          (b) =>
            b.resourceType === "room" &&
            b.resourceId === table.roomId &&
            (b.bed === null || b.bed === table.bed),
        ),
    );
  if (!tables.length)
    return unchanged(
      fixed.roomId
        ? "This room and table are unavailable for the full treatment. Choose another time, room or table."
        : "No room and table are available for the full treatment. Choose another time or duration.",
    );
  const therapist =
    therapists.find((t) => t.id === selection.therapistId) || therapists[0];
  const table =
    tables.find(
      (t) => t.roomId === selection.roomId && t.bed === selection.bed,
    ) || tables[0];
  const room = catalogue.rooms.find((r) => r.id === table.roomId);
  return {
    available: true,
    selection: { ...selection, therapistId: therapist.id, ...table },
    message: `${therapist.name} · ${room.name} · Table ${table.bed + 1} is available for the full treatment.`,
  };
}

// Keep this controller independent of page-global state so each drawer owns its
// request sequence. Late responses cannot change another date, drawer or role.
export function mountBookingAvailability({
  form,
  feedback,
  catalogue,
  defaults = {},
  loadAppointments,
  applyResources,
  isCurrent,
}) {
  let sequence = 0,
    suspended = false;
  const fixed = Object.fromEntries(
    resourceFields.map((key) => [key, Object.hasOwn(defaults, key)]),
  );
  const show = (message, state) => {
    feedback.textContent = message;
    feedback.dataset.state = state;
  };
  const current = (request) =>
    !suspended && request === sequence && isCurrent();
  const read = () => {
    const value = (name) => form.elements[name].value;
    const time = /^(\d{2}):(\d{2})$/.exec(value("start"));
    return {
      date: value("date"),
      start: time ? Number(time[1]) * 60 + Number(time[2]) : NaN,
      duration: value("duration") === "" ? NaN : Number(value("duration")),
      status: value("status"),
      therapistId: value("therapistId"),
      roomId: value("roomId"),
      bed: Number(value("bed")),
    };
  };
  async function refresh({ preserve = false } = {}) {
    const request = ++sequence;
    if (suspended || !isCurrent()) return;
    const selection = read();
    if (!validDate(selection.date)) {
      show("Choose a date to check availability.", "warning");
      return;
    }
    show("Checking availability…", "loading");
    try {
      const data = await loadAppointments(selection.date);
      if (!current(request)) return;
      const result = suggestBookingResources({
        catalogue,
        appointments: Array.isArray(data) ? data : data.appointments,
        blocks: Array.isArray(data) ? [] : data.blocks || [],
        selection,
        fixed: preserve
          ? { therapistId: true, roomId: true, bed: true }
          : fixed,
      });
      if (result.available) applyResources(result.selection);
      show(result.message, result.available ? "available" : "warning");
    } catch {
      if (current(request))
        show(
          "Availability could not be checked. Try again, or choose your resources and save to check them.",
          "warning",
        );
    }
  }
  const changes = new Set([
    "date",
    "start",
    "duration",
    "serviceId",
    "status",
    ...resourceFields,
  ]);
  form.addEventListener("change", (event) => {
    const name = event.target.name;
    if (!changes.has(name)) return;
    if (resourceFields.includes(name)) fixed[name] = true;
    // A room choice leaves its table open to suggestions. A table choice (or
    // clicked room half in defaults) fixes that particular room/table pair.
    if (name === "roomId") fixed.bed = false;
    if (name === "bed") fixed.roomId = true;
    void refresh();
  });
  form.addEventListener("input", (event) => {
    if (["date", "start", "duration"].includes(event.target.name))
      void refresh();
  });
  void refresh();
  return {
    refresh,
    suspend() {
      suspended = true;
      ++sequence;
    },
    resume() {
      suspended = false;
      return refresh({ preserve: true });
    },
  };
}
