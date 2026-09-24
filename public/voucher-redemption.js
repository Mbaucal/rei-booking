const time = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const errorHTML = '<p class="error" role="alert" data-error hidden></p>';
const statusLabel = (v) =>
  ({
    issued: "Available",
    partially_redeemed: "Partly used",
    redeemed: "Fully used",
    expired: "Expired",
  })[v.status];

export function redemptionHistoryHTML({ esc: e, money, stamp }, records) {
  return `<h3>Voucher use history</h3><div class="history">${records.length ? records.map((r) => `<article><strong>${e(r.code)} · ${money(r.appliedCents)}</strong><p>${e(r.date)} · ${time(r.start)} · ${e(r.serviceName)} · ${r.duration} min</p><p class="hint">Recorded ${e(stamp(r.createdAt))} by ${e(r.createdBy)}</p>${r.reversedAt ? `<p>Reversed ${e(stamp(r.reversedAt))} by ${e(r.reversedBy)}</p><p>${e(r.reason)}</p>` : `<button class="btn" type="button" data-reverse-use="${e(r.id)}">Correct this use</button>`}</article>`).join("") : '<p class="hint">No voucher use recorded.</p>'}</div>`;
}

export function wireRedemptionHistory(ctx, container, records, refresh) {
  container.querySelectorAll("[data-reverse-use]").forEach((button) => {
    button.onclick = () => {
      const r = records.find((row) => row.id === button.dataset.reverseUse);
      ctx.showDrawer(
        "Correct voucher use",
        r.code,
        `<form class="sales-form" id="reverse-use-form"><p>Restore this voucher use of ${ctx.money(r.appliedCents)} for ${ctx.esc(r.date)} at ${time(r.start)}.</p><p class="hint">This corrects the voucher record. It does not refund a payment or cancel the appointment.</p><label>Reason<textarea name="reason" required minlength="3" maxlength="500" rows="3"></textarea></label><label class="sales-check"><input name="confirmed" type="checkbox" required>I confirm this use was recorded incorrectly.</label>${errorHTML}</form>`,
      );
      const form = document.getElementById("reverse-use-form");
      document.getElementById("drawer-footer").innerHTML =
        '<button class="btn primary" type="submit" form="reverse-use-form">Restore voucher value</button>';
      const submit = document.querySelector('[form="reverse-use-form"]');
      let payload,
        busy = false;
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (busy) return;
        payload ||= {
          requestId: crypto.randomUUID(),
          reason: form.elements.reason.value,
          confirmed: form.elements.confirmed.checked,
        };
        busy = true;
        submit.disabled = true;
        form.elements.reason.readOnly = true;
        form.elements.confirmed.disabled = true;
        try {
          await ctx.api(`/sales/redemptions/${r.id}/reverse`, {
            method: "POST",
            body: payload,
          });
          if (!form.isConnected || !ctx.isCurrent()) return;
          submit.textContent = "Correction saved";
          ctx.toast(
            "Voucher use reversed. The reason is saved in its history.",
          );
          await refresh();
        } catch (error) {
          if (!form.isConnected || !ctx.isCurrent()) return;
          const box = form.querySelector("[data-error]");
          box.hidden = false;
          box.textContent = error.message;
          if (error.status >= 400 && error.status < 500) {
            payload = null;
            form.elements.reason.readOnly = false;
            form.elements.confirmed.disabled = false;
          }
          submit.textContent = payload
            ? "Retry same correction"
            : "Restore voucher value";
          submit.disabled = false;
        } finally {
          busy = false;
        }
      };
    };
  });
}

export async function openVoucherRedemption(ctx, options = {}) {
  const { api, esc: e, money, today, showDrawer, isCurrent, toast } = ctx;
  showDrawer(
    "Use a gift voucher",
    "Sales",
    `<section id="voucher-use" class="sales-form"><form data-lookup class="sales-form"><label>Voucher code<input name="code" required maxlength="100" autocomplete="off" placeholder="Enter the full code"></label><button class="btn" type="submit">Find voucher</button></form><div data-gift></div><div data-appointment></div><div data-review></div>${errorHTML}<div data-history></div></section>`,
  );
  const root = document.getElementById("voucher-use"),
    $ = (selector) => root.querySelector(selector);
  const alive = () => root.isConnected && isCurrent();
  let voucher = null,
    appointment = null,
    history = [],
    payload = null,
    busy = false,
    sequence = 0;
  const showError = (error) => {
    if (!alive()) return;
    $("[data-error]").hidden = false;
    $("[data-error]").textContent = error.message;
  };
  const clearError = () => {
    $("[data-error]").hidden = true;
  };
  const refresh = () =>
    openVoucherRedemption(ctx, {
      voucherId: voucher?.id,
      appointmentId: appointment?.id,
      onSaved: options.onSaved,
    });
  function review() {
    $("[data-gift]").innerHTML = voucher
      ? `<section class="sale-panel"><strong>${e(voucher.serviceName)}</strong><p>${e(voucher.code)} · ${e(statusLabel(voucher))}</p><p>${voucher.kind === "treatment" ? `${voucher.duration} min · One matching treatment` : `Remaining: ${money(voucher.remainingCents)}`}</p><p class="hint">${voucher.expiresOn ? `Valid through ${e(voucher.expiresOn)}` : "No expiry"}</p></section>`
      : "";
    const target = $("[data-review]");
    if (!appointment) {
      target.innerHTML = "";
      return;
    }
    const a = appointment;
    let reason = "";
    if (a.status !== "done" || a.date > today())
      reason =
        "Save the appointment as Completed, dated today or earlier, before using a voucher.";
    else if (a.uncoveredCents <= 0)
      reason =
        "This appointment has no remaining value to cover with a voucher.";
    else if (!voucher) reason = "Find a voucher by its code to continue.";
    else if (!["issued", "partially_redeemed"].includes(voucher.status))
      reason = "This voucher is fully used or expired.";
    else if (
      voucher.kind === "treatment" &&
      (voucher.serviceId !== a.serviceId ||
        voucher.duration !== a.duration ||
        a.coveredCents !== 0)
    )
      reason =
        "A massage voucher covers one complete matching treatment and duration. This appointment must have no other voucher use.";
    const limit = voucher
      ? Math.min(voucher.remainingCents, a.uncoveredCents)
      : 0;
    target.innerHTML = `<section class="sale-panel"><h3>${e(a.clientName)}</h3><p>${e(a.date)} · ${time(a.start)} · ${e(a.therapistName)}</p><p>${e(a.serviceName)} · ${a.duration} min</p><p>Treatment value: ${money(a.netCents)}<br>Covered by vouchers: ${money(a.coveredCents)}<br>Not covered by vouchers: ${money(a.uncoveredCents)}</p><p class="hint">Other payment methods are not included in this voucher balance.</p></section>${reason ? `<p class="hint">${e(reason)}</p>` : `<form data-confirm class="sales-form">${voucher.kind === "amount" ? `<label>Apply voucher amount (RSD)<input name="amount" type="number" min="0.01" max="${(limit / 100).toFixed(2)}" step="0.01" value="${(limit / 100).toFixed(2)}" required></label>` : `<p>This voucher covers the whole treatment: ${money(a.netCents)}.</p>`}<label class="sales-check"><input name="confirmed" type="checkbox" required>I confirm this voucher is being used for this appointment.</label><button class="btn primary" type="submit">Confirm voucher use</button></form>`}`;
    const form = $("[data-confirm]");
    if (form) form.onsubmit = save;
  }
  function renderHistory() {
    $("[data-history]").innerHTML = redemptionHistoryHTML(ctx, history);
    wireRedemptionHistory(ctx, $("[data-history]"), history, async () => {
      if (options.onSaved)
        await options.onSaved(voucher?.id || history[0]?.voucherId);
      else await refresh();
    });
  }
  async function selectAppointment(id) {
    const n = ++sequence;
    appointment = null;
    history = [];
    review();
    renderHistory();
    if (!id) return;
    try {
      const result = await api("/sales/appointments/" + encodeURIComponent(id));
      if (!alive() || n !== sequence) return;
      appointment = result.appointment;
      history = result.redemptions;
      review();
      renderHistory();
    } catch (error) {
      showError(error);
    }
  }
  async function chooseDate(date) {
    const n = ++sequence;
    appointment = null;
    history = [];
    review();
    renderHistory();
    $("[data-appointment]").innerHTML =
      `<label>Appointment date<input data-date type="date" value="${e(date)}" max="${today()}"></label><p class="hint">Loading completed appointments…</p>`;
    $("[data-date]").onchange = (event) => chooseDate(event.target.value);
    try {
      const result = await api(
        "/sales/redemption-appointments?" + new URLSearchParams({ date }),
      );
      if (!alive() || n !== sequence) return;
      $("[data-appointment] p").outerHTML =
        `<label>Completed appointment<select data-select><option value="">Select an appointment</option>${result.appointments.map((a) => `<option value="${e(a.id)}">${time(a.start)} · ${e(a.clientName)} · ${e(a.serviceName)} · ${e(a.therapistName)}</option>`).join("")}</select></label>${result.appointments.length ? "" : '<p class="hint">No completed appointments on this date.</p>'}`;
      $("[data-select]").onchange = (event) =>
        selectAppointment(event.target.value);
    } catch (error) {
      showError(error);
    }
  }
  async function save(event) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget,
      submit = form.querySelector("button");
    if (!payload) {
      const amount = form.elements.amount?.value;
      if (amount !== undefined && !/^\d+(\.\d{1,2})?$/.test(amount)) {
        showError(
          new Error("Enter an amount with at most two decimal places."),
        );
        return;
      }
      payload = {
        requestId: crypto.randomUUID(),
        voucherId: voucher.id,
        appointmentId: appointment.id,
        appointmentVersion: appointment.version,
        appliedCents:
          amount === undefined
            ? appointment.netCents
            : Math.round(Number(amount) * 100),
        confirmed: form.elements.confirmed.checked,
      };
    }
    busy = true;
    clearError();
    root.querySelectorAll("input,select,button").forEach((el) => {
      el.disabled = true;
    });
    try {
      await api("/sales/redemptions", { method: "POST", body: payload });
      if (!alive()) return;
      submit.textContent = "Voucher use saved";
      toast("Voucher use saved and linked to the appointment.");
      if (options.onSaved) await options.onSaved(voucher.id);
      else await refresh();
    } catch (error) {
      if (!alive()) return;
      showError(error);
      if (error.status >= 400 && error.status < 500) {
        const button = document.createElement("button");
        button.className = "btn";
        button.type = "button";
        button.textContent = "Refresh details";
        button.onclick = () => refresh().catch(showError);
        $("[data-error]").after(button);
      } else {
        $("[data-error]").textContent =
          "Confirmation was interrupted. Retry the same voucher use to check its result without spending twice.";
        submit.textContent = "Retry same voucher use";
        submit.disabled = false;
      }
    } finally {
      busy = false;
    }
  }
  let lookupSequence = 0;
  $("[data-lookup]").onsubmit = async (event) => {
    event.preventDefault();
    if (busy || payload) return;
    const n = ++lookupSequence,
      code = event.currentTarget.elements.code.value;
    clearError();
    voucher = null;
    review();
    try {
      const result = await api(
        "/sales/voucher-lookup?" + new URLSearchParams({ code }),
      );
      if (!alive() || n !== lookupSequence) return;
      voucher = result.voucher;
      review();
    } catch (error) {
      showError(error);
    }
  };
  try {
    if (options.voucherId) {
      const result = await api(
        "/sales/vouchers/" + encodeURIComponent(options.voucherId),
      );
      if (!alive()) return;
      voucher = result.voucher;
      $("[data-lookup]").elements.code.value = voucher.code;
      review();
    }
    if (options.appointmentId) await selectAppointment(options.appointmentId);
    else await chooseDate(today());
  } catch (error) {
    showError(error);
  }
}
