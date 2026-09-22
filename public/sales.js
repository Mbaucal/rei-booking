// Per-visit state stays inside this view and is discarded on navigation/sign-out.
export async function renderSales(ctx) {
  const {
    root,
    api,
    esc: e,
    money,
    stamp,
    today,
    isCurrent,
    showDrawer,
    closeDrawer,
    toast,
  } = ctx;
  const $ = (id) => document.getElementById(id);
  let settings = await api("/sales/settings"),
    catalogue = [],
    cart = [],
    page = 0,
    filters = { q: "", from: "", to: "" },
    buyerMode = "walkin",
    buyer = null,
    newBuyer = { name: "", phone: "", email: "" },
    paymentMethod = "cash",
    paymentReference = "",
    requestId = crypto.randomUUID(),
    checkoutPayload = null,
    busy = false,
    view = 0,
    drawerVersion = 0;
  if (!isCurrent()) return;
  const err = (error) => {
    if (isCurrent()) {
      const box =
        ($("drawer").open &&
          $("drawer-content").querySelector(".sales-error")) ||
        root.querySelector(".sales-error");
      if (box) {
        box.textContent = error.message;
        box.hidden = false;
      } else toast(error.message);
    }
  };
  const field = (name, label, value = "", type = "text", extra = "") =>
    `<label>${label}<input name="${name}" type="${type}" value="${e(value)}" ${extra}></label>`;
  const button = (id, label, primary = false) =>
    `<button class="btn${primary ? " primary" : ""}" id="${id}" type="button">${label}</button>`;
  const errorHTML = '<p class="error sales-error" role="alert" hidden></p>';
  const choice = (value, wanted) => (value === wanted ? " selected" : "");
  const labelStatus = (value) =>
    ({
      prepared: "Ready to send",
      sending: "Sending · confirmation pending",
      retry: "Retry available",
      accepted: "Accepted by email service",
      delayed: "Delivery delayed",
      delivered: "Delivered",
      bounced: "Bounced",
      complained: "Complaint received",
      suppressed: "Recipient blocked",
      uncertain: "Check in Resend",
      failed: "Failed",
      issued: "Issued",
      expired: "Expired",
    })[value] || value;
  function previewFrame(html) {
    const frame = $("voucher-preview");
    if (frame) frame.srcdoc = html;
  }
  function drawer(title, kicker, html) {
    drawerVersion++;
    showDrawer(title, kicker, html);
    return drawerVersion;
  }
  function stillDrawer(n) {
    return isCurrent() && n === drawerVersion && $("drawer").open;
  }
  function designFields(d) {
    return `<div class="form-grid">${field("title", "Voucher title", d.title, "text", 'required maxlength="100"')}
<label>Colour theme<select name="theme"><option value="ivory"${choice(d.theme, "ivory")}>Ivory & gold</option><option value="forest"${choice(d.theme, "forest")}>Forest & gold</option></select></label>
<label>Layout<select name="layout"><option value="classic"${choice(d.layout, "classic")}>Centred</option><option value="letter"${choice(d.layout, "letter")}>Personal letter</option></select></label>
<label>Price on treatment voucher<select name="showPrice"><option value="no"${choice(d.showPrice, false)}>Hide price</option><option value="yes"${choice(d.showPrice, true)}>Show price</option></select></label></div>
<label>Booking instructions / terms<textarea name="terms" maxlength="1000" rows="3">${e(d.terms)}</textarea></label>`;
  }
  function readDesign(data) {
    return {
      title: data.get("title"),
      theme: data.get("theme"),
      layout: data.get("layout"),
      showPrice: data.get("showPrice") === "yes",
      terms: data.get("terms"),
    };
  }
  async function editDesign() {
    const n = drawer(
      "Voucher design",
      "Default for future vouchers",
      `<form id="design-form" class="sales-form">${designFields(settings.design)}<p class="hint">Issued vouchers keep their original design and wording.</p>${errorHTML}</form>`,
    );
    $("drawer-footer").innerHTML =
      '<button class="btn primary" form="design-form" type="submit">Save default design</button>';
    $("design-form").onsubmit = async (event) => {
      event.preventDefault();
      const save = $("drawer-footer").querySelector("button");
      save.disabled = true;
      try {
        await api("/sales/settings", {
          method: "PUT",
          body: {
            version: settings.version,
            design: readDesign(new FormData(event.currentTarget)),
          },
        });
        settings = await api("/sales/settings");
        if (stillDrawer(n)) {
          closeDrawer();
          toast("Default voucher design saved.");
        }
      } catch (error) {
        err(error);
      } finally {
        if (save.isConnected) save.disabled = false;
      }
    };
  }
  async function list() {
    const n = ++view;
    closeDrawer();
    root.innerHTML = `<div class="sales-heading"><div><p class="eyebrow">Sales</p><h2>Gift vouchers</h2><p class="hint">Find an issued gift, view its sale or send it to the recipient.</p></div><div class="sales-actions">${button("voucher-design", "Voucher design")}${button("new-sale", "New sale", true)}</div></div>
<form id="voucher-filters" class="sales-filters">${field("q", "Search code, buyer or recipient", filters.q, "search", 'maxlength="100"')}${field("from", "Sold from", filters.from, "date")}${field("to", "Sold through", filters.to, "date")}<button class="btn primary" type="submit">Search</button>${button("voucher-export", "Export CSV")}</form>
${errorHTML}<p class="hint" id="voucher-count" role="status">Loading vouchers…</p><div class="table-wrap" id="voucher-register"></div><div class="sales-actions" id="voucher-pages"></div>`;
    $("new-sale").onclick = () => startSale().catch(err);
    $("voucher-design").onclick = () => editDesign().catch(err);
    $("voucher-filters").onsubmit = (event) => {
      event.preventDefault();
      filters = Object.fromEntries(new FormData(event.currentTarget));
      page = 0;
      list().catch(err);
    };
    $("voucher-export").onclick = () =>
      ctx.download(new URLSearchParams({ ...filters })).catch(err);
    const result = await api(
      "/sales/vouchers?" + new URLSearchParams({ ...filters, page }),
    );
    if (!isCurrent() || n !== view) return;
    $("voucher-count").textContent =
      `${result.count} vouchers · ${money(result.totalCents)} sold in this selection`;
    $("voucher-register").innerHTML = result.vouchers.length
      ? `<table class="data-table"><thead><tr><th>Voucher</th><th>Gift</th><th>Buyer / recipient</th><th>Sold</th><th>Value</th><th>Status</th></tr></thead><tbody>${result.vouchers.map((v) => `<tr><td><button type="button" class="btn link" data-voucher="${e(v.id)}">${e(v.code)}</button><small>${e(v.reference)}</small></td><td>${e(v.serviceName)}<small>${v.duration ? `${v.duration} min` : "Custom amount"}</small></td><td>${e(v.buyerName || "Walk-in buyer")}<small>For ${e(v.recipientName || "Gift recipient")}</small></td><td>${e(stamp(v.issuedAt))}</td><td>${money(v.priceCents)}</td><td><span class="status">${labelStatus(v.status)}</span></td></tr>`).join("")}</tbody></table>`
      : '<div class="empty"><h3>No gift vouchers yet</h3><p>Create your first sale using New sale.</p></div>';
    root
      .querySelectorAll("[data-voucher]")
      .forEach(
        (b) => (b.onclick = () => openVoucher(b.dataset.voucher).catch(err)),
      );
    $("voucher-pages").innerHTML =
      `${button("previous-vouchers", "Previous")}<span>Page ${page + 1} of ${Math.max(1, Math.ceil(result.count / 50))}</span>${button("next-vouchers", "Next")}`;
    $("previous-vouchers").disabled = page === 0;
    $("next-vouchers").disabled = (page + 1) * 50 >= result.count;
    $("previous-vouchers").onclick = () => {
      page--;
      list().catch(err);
    };
    $("next-vouchers").onclick = () => {
      page++;
      list().catch(err);
    };
  }
  async function startSale() {
    const n = ++view;
    const data = await api("/catalogue");
    if (!isCurrent() || n !== view) return;
    catalogue = data.services.filter((s) => s.active && s.priceCents > 0);
    cart = [];
    buyerMode = "walkin";
    buyer = null;
    newBuyer = { name: "", phone: "", email: "" };
    requestId = crypto.randomUUID();
    checkoutPayload = null;
    paymentMethod = "cash";
    paymentReference = "";
    renderCart();
  }
  function renderCart() {
    root.innerHTML = `<div class="sales-heading"><div><p class="eyebrow">Sales / New sale</p><h2>A thoughtful gift</h2></div>${button("back-to-sales", "Back to vouchers")}</div>${errorHTML}
<div class="sale-layout"><section class="sale-panel"><h3>Choose a gift</h3><p class="hint">Treatment prices come from your current menu.</p>${field("catalogueSearch", "Find a massage", "", "search", 'id="catalogue-search"')}
<div class="voucher-catalogue" id="voucher-catalogue">${catalogue.map((s) => `<button class="voucher-option" type="button" data-service="${e(s.id)}"><span class="eyebrow">Massage voucher</span><strong>${e(s.name)}</strong><span>${s.duration} min · ${money(s.priceCents)}</span></button>`).join("")}<button type="button" class="voucher-option custom" id="custom-voucher"><span class="eyebrow">Any amount</span><strong>Custom gift value</strong><span>Choose an amount in RSD</span></button></div>${catalogue.length ? "" : '<p class="hint">Add priced treatments in Treatments to sell massage vouchers.</p>'}</section>
<section class="sale-panel cart-panel"><h3>Your cart <span class="badge">${cart.length}</span></h3>
<div class="cart-items">${cart.length ? cart.map((v, i) => `<article><div><strong>${e(v.serviceName)}</strong><small>${v.duration ? `${v.duration} min · ` : ""}${money(v.priceCents)}</small><small>For ${e(v.recipientName || "Gift recipient")}</small></div><div>${button("edit-cart-" + i, "Edit")}${button("remove-cart-" + i, "Remove")}</div></article>`).join("") : '<p class="hint">Select a massage or a custom amount to begin.</p>'}</div>
<label>Buyer<select id="buyer-mode"><option value="walkin"${choice(buyerMode, "walkin")}>Walk-in / no client linked</option><option value="existing"${choice(buyerMode, "existing")}>Existing client</option><option value="new"${choice(buyerMode, "new")}>Add new client</option></select></label>
<div id="buyer-fields">${buyerMode === "existing" ? `${field("buyerSearch", "Search client name, phone or email", "", "search", 'id="buyer-search"')}<div id="buyer-results"></div><p class="hint" id="buyer-selected">${buyer ? `Selected: ${e(buyer.name)}` : "Choose a client from the results."}</p>` : buyerMode === "new" ? `<div class="sales-form">${field("buyerName", "Buyer name", newBuyer.name, "text", 'id="buyer-name" maxlength="100"')}${field("buyerPhone", "Phone", newBuyer.phone, "tel", 'id="buyer-phone" maxlength="30"')}${field("buyerEmail", "Buyer email (optional)", newBuyer.email, "email", 'id="buyer-email" maxlength="254"')}</div>` : ""}</div>
<p class="hint">The buyer is recorded on the sale. Choose a delivery email separately after issuing the voucher.</p>
<label>Payment received by<select id="sale-payment"><option value="cash"${choice(paymentMethod, "cash")}>Cash</option><option value="card"${choice(paymentMethod, "card")}>Card</option><option value="bank_transfer"${choice(paymentMethod, "bank_transfer")}>Bank transfer</option><option value="other"${choice(paymentMethod, "other")}>Other</option></select></label>
${field("reference", "Payment reference (optional)", paymentReference, "text", 'id="sale-reference" maxlength="120"')}
<div class="sale-total"><span>Total</span><strong>${money(cart.reduce((sum, v) => sum + v.priceCents, 0))}</strong></div>
<label class="sales-check"><input type="checkbox" id="payment-confirmed">Payment has been received</label>
<p class="hint">This records an existing payment. No card is charged by this application.</p>
${button("complete-sale", "Complete sale & issue vouchers", true)}</section></div>`;
    $("back-to-sales").onclick = () => {
      if (cart.length && !window.confirm("Leave this unsaved cart?")) return;
      list().catch(err);
    };
    root.querySelectorAll("[data-service]").forEach(
      (b) =>
        (b.onclick = () => {
          const s = catalogue.find((v) => v.id === b.dataset.service);
          editItem({
            kind: "treatment",
            serviceId: s.id,
            serviceVersion: s.version,
            serviceName: s.name,
            duration: s.duration,
            priceCents: s.priceCents,
            design: { ...settings.design },
            recipientName: "",
            senderName: "",
            message: "",
            expiresOn: undefined,
          });
        }),
    );
    $("custom-voucher").onclick = () =>
      editItem({
        kind: "amount",
        serviceName: "Custom amount",
        priceCents: 0,
        design: { ...settings.design },
        recipientName: "",
        senderName: "",
        message: "",
        expiresOn: undefined,
      });
    $("catalogue-search").oninput = (event) =>
      root
        .querySelectorAll("[data-service]")
        .forEach(
          (b) =>
            (b.hidden = !b.textContent
              .toLowerCase()
              .includes(event.target.value.toLowerCase())),
        );
    cart.forEach((v, i) => {
      $("edit-cart-" + i).onclick = () => editItem(v, i);
      $("remove-cart-" + i).onclick = () => {
        cart.splice(i, 1);
        renderCart();
      };
    });
    $("buyer-mode").onchange = (event) => {
      buyerMode = event.target.value;
      buyer = null;
      renderCart();
    };
    if (buyerMode === "new")
      for (const key of ["name", "phone", "email"])
        $("buyer-" + key).oninput = (event) =>
          (newBuyer[key] = event.target.value);
    if (buyerMode === "existing") {
      let seq = 0;
      $("buyer-search").oninput = async (event) => {
        const own = ++seq,
          element = event.target,
          q = element.value;
        if (!q.trim()) {
          $("buyer-results").textContent = "";
          return;
        }
        try {
          const results = await api("/clients?q=" + encodeURIComponent(q));
          if (!isCurrent() || own !== seq || !element.isConnected) return;
          $("buyer-results").innerHTML =
            results.clients
              .map(
                (c) =>
                  `<button class="btn" type="button" data-buyer="${e(c.id)}">${e(c.name)}${c.phone ? ` · ${e(c.phone)}` : ""}</button>`,
              )
              .join("") || '<p class="hint">No matching clients.</p>';
          root.querySelectorAll("[data-buyer]").forEach(
            (b) =>
              (b.onclick = () => {
                buyer = results.clients.find((c) => c.id === b.dataset.buyer);
                $("buyer-selected").textContent = "Selected: " + buyer.name;
                $("buyer-results").textContent = "";
              }),
          );
        } catch (error) {
          err(error);
        }
      };
    }
    $("sale-payment").onchange = (event) =>
      (paymentMethod = event.target.value);
    $("sale-reference").oninput = (event) =>
      (paymentReference = event.target.value);
    $("complete-sale").disabled = !cart.length;
    $("complete-sale").onclick = () => complete().catch(err);
  }
  function editItem(original, index = null) {
    if (cart.length >= 20 && index === null) {
      toast("A sale can contain up to 20 vouchers.");
      return;
    }
    const v = structuredClone(original),
      expiry = v.expiresOn === null ? "none" : v.expiresOn ? "date" : "";
    const n = drawer(
      index === null ? "Personalise your gift" : "Edit gift voucher",
      v.serviceName,
      `<form id="voucher-form" class="sales-form">
${v.kind === "amount" ? field("amount", "Gift value (RSD)", v.priceCents ? v.priceCents / 100 : "", "number", 'required min="0.01" max="1000000" step="0.01"') : `<p class="hint">${v.duration} min · ${money(v.priceCents)}</p>`}
<div class="form-grid">${field("recipientName", "For (optional)", v.recipientName, "text", 'maxlength="100"')}${field("senderName", "Gift from (optional)", v.senderName, "text", 'maxlength="100"')}</div>
<label>Personal message<textarea name="message" maxlength="1000" rows="3">${e(v.message)}</textarea></label>
<div class="form-grid"><label>Validity<select name="validity" id="voucher-validity" required><option value="">Choose validity</option><option value="none"${choice(expiry, "none")}>No expiry date</option><option value="date"${choice(expiry, "date")}>Choose an expiry date</option></select></label>${field("expiresOn", "Valid through", v.expiresOn || "", "date", `id="voucher-expiry" min="${today()}" ${expiry === "date" ? "required" : "disabled"}`)}</div>
<h3>Design</h3>${designFields(v.design)}${errorHTML}</form>`,
    );
    $("voucher-validity").onchange = (event) => {
      const f = $("voucher-expiry");
      f.disabled = event.target.value !== "date";
      f.required = !f.disabled;
    };
    $("drawer-footer").innerHTML =
      '<button class="btn primary" type="submit" form="voucher-form">Preview gift</button>';
    $("voucher-form").onsubmit = async (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget),
        save = $("drawer-footer").querySelector("button");
      save.disabled = true;
      Object.assign(v, {
        recipientName: data.get("recipientName"),
        senderName: data.get("senderName"),
        message: data.get("message"),
        expiresOn:
          data.get("validity") === "none" ? null : data.get("expiresOn"),
        design: readDesign(data),
      });
      if (v.kind === "amount")
        v.priceCents = Math.round(Number(data.get("amount")) * 100);
      try {
        const preview = await api("/sales/preview", {
          method: "POST",
          body: v,
        });
        if (!stillDrawer(n)) return;
        drawer(
          "Review gift voucher",
          "Preview before adding to cart",
          '<iframe class="voucher-preview" id="voucher-preview" title="Gift voucher preview" sandbox></iframe>',
        );
        previewFrame(preview.html);
        $("drawer-footer").innerHTML =
          button("back-to-design", "Edit design") +
          button(
            "save-cart-item",
            index === null ? "Add to cart" : "Update cart",
            true,
          );
        $("back-to-design").onclick = () => editItem(v, index);
        $("save-cart-item").onclick = () => {
          if (index === null) cart.push(v);
          else cart[index] = v;
          closeDrawer();
          renderCart();
        };
      } catch (error) {
        err(error);
      } finally {
        if (save.isConnected) save.disabled = false;
      }
    };
  }
  async function complete() {
    if (busy) return;
    if (!checkoutPayload) {
      if (!$("payment-confirmed").checked)
        throw new Error("Confirm that payment has been received.");
      if (buyerMode === "existing" && !buyer)
        throw new Error("Select the buyer from the search results.");
      checkoutPayload = {
        requestId,
        items: structuredClone(cart),
        buyerId: buyerMode === "existing" ? buyer.id : null,
        newBuyer: buyerMode === "new" ? { ...newBuyer } : null,
        paymentMethod,
        paymentReference,
        paymentConfirmed: true,
      };
    }
    busy = true;
    root
      .querySelectorAll("button,input,select,textarea")
      .forEach((el) => (el.disabled = true));
    try {
      const result = await api("/sales/checkout", {
        method: "POST",
        body: checkoutPayload,
      });
      if (!isCurrent()) return;
      checkoutPayload = null;
      cart = [];
      await showSale(result.sale);
    } catch (error) {
      if (!isCurrent()) return;
      if (error.status && error.status < 500) {
        checkoutPayload = null;
        renderCart();
      } else {
        $("complete-sale").disabled = false;
        $("complete-sale").textContent = "Retry same checkout";
        error.message =
          "Confirmation was interrupted. Retry this checkout to retrieve its result without issuing duplicates.";
      }
      err(error);
    } finally {
      busy = false;
    }
  }
  async function showSale(sale) {
    ++view;
    closeDrawer();
    root.innerHTML = `<div class="sales-heading"><div><p class="eyebrow">Sale completed</p><h2>${e(sale.reference)}</h2><p class="hint">${e(stamp(sale.createdAt))} · ${e(sale.buyerName || "Walk-in buyer")}</p></div>${button("back-to-sales", "Gift vouchers")}</div>
<section class="sale-panel"><div class="sale-total"><span>${e(sale.paymentMethod.replaceAll("_", " "))}${sale.paymentReference ? ` · ${e(sale.paymentReference)}` : ""}</span><strong>${money(sale.totalCents)}</strong></div>
<p class="hint">${sale.vouchers.length} vouchers issued. Choose each voucher to print it or prepare its email.</p><div class="voucher-catalogue">${sale.vouchers.map((v) => `<button class="voucher-option" data-voucher="${e(v.id)}"><span class="eyebrow">${e(v.code)}</span><strong>${e(v.serviceName)}</strong><span>${v.duration ? `${v.duration} min · ` : ""}${money(v.priceCents)}</span><span>For ${e(v.recipientName || "Gift recipient")}</span></button>`).join("")}</div></section>${errorHTML}`;
    $("back-to-sales").onclick = () => list().catch(err);
    root
      .querySelectorAll("[data-voucher]")
      .forEach(
        (b) => (b.onclick = () => openVoucher(b.dataset.voucher).catch(err)),
      );
  }
  async function openVoucher(id) {
    const n = drawer(
      "Gift voucher",
      "Loading…",
      '<p class="hint">Loading voucher…</p>',
    );
    const data = await api("/sales/vouchers/" + id);
    if (!stillDrawer(n)) return;
    const v = data.voucher;
    drawer(
      v.serviceName,
      v.code,
      `<p class="hint">${labelStatus(v.status)} · ${e(stamp(v.issuedAt))}</p><iframe class="voucher-preview" id="voucher-preview" title="Issued voucher preview" sandbox></iframe>
<div class="sales-actions"><a class="btn" target="_blank" rel="noopener" href="/api/sales/vouchers/${e(id)}/print">Print / Save as PDF</a>${button("open-voucher-sale", "View sale")}</div>
<h3>Email this gift</h3><p class="hint">From: info@reithailandmassage.com</p>
${settings.emailReady ? "" : '<p class="hint">Email sending awaits sender verification and setup. You can prepare a preview now.</p>'}
<form id="voucher-email-form" class="sales-form">${field("recipientEmail", "Recipient email", "", "email", 'required maxlength="254" autocomplete="off"')}${data.sale.buyerEmail ? button("use-buyer-email", "Use buyer’s email: " + e(data.sale.buyerEmail)) : ""}
${field("subject", "Subject", "A gift for you from Rei Thailand Massage", "text", 'required maxlength="160"')}
<button class="btn primary" type="submit" ${v.status !== "issued" ? "disabled" : ""}>Review email</button></form>
<h3>Delivery history</h3><div id="delivery-history">${data.deliveries.length ? data.deliveries.map((d) => `<article class="delivery-row"><strong>${e(d.recipient)}</strong><span>${e(labelStatus(d.status))}</span><small>${e(stamp(d.updatedAt))}</small>${button("delivery-" + d.id, "Open email")}</article>`).join("") : '<p class="hint">No emails prepared or sent.</p>'}</div>${errorHTML}`,
    );
    previewFrame(data.preview.html);
    $("open-voucher-sale").onclick = () => showSale(data.sale).catch(err);
    if ($("use-buyer-email"))
      $("use-buyer-email").onclick = () =>
        ($("voucher-email-form").elements.recipientEmail.value =
          data.sale.buyerEmail);
    for (const d of data.deliveries)
      $("delivery-" + d.id).onclick = () =>
        reviewEmail(id, d.recipient, d.subject, d.id).catch(err);
    $("voucher-email-form").onsubmit = async (event) => {
      event.preventDefault();
      const form = event.currentTarget,
        submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        await reviewEmail(
          id,
          form.elements.recipientEmail.value,
          form.elements.subject.value,
        );
      } catch (error) {
        err(error);
      } finally {
        if (submit.isConnected) submit.disabled = false;
      }
    };
  }
  async function reviewEmail(
    voucherId,
    recipientEmail,
    subject,
    deliveryId = null,
  ) {
    const n = drawerVersion;
    const result = deliveryId
      ? await api("/sales/deliveries/" + deliveryId)
      : await api(`/sales/vouchers/${voucherId}/email-preview`, {
          method: "POST",
          body: { recipientEmail, subject },
        });
    if (!stillDrawer(n)) return;
    const d = result.delivery;
    drawer(
      "Review email",
      "Gift voucher delivery",
      `<div class="email-envelope"><p><strong>From:</strong> ${e(result.from)}</p><p><strong>To:</strong> ${e(d.recipient)}</p><p><strong>Subject:</strong> ${e(d.subject)}</p></div>
<iframe class="voucher-preview" id="voucher-preview" title="Email content preview" sandbox></iframe><p class="hint" id="delivery-status" role="status">${e(labelStatus(d.status))}</p>
${settings.emailReady ? "" : '<p class="hint">Sending will be available once email setup is complete.</p>'}${errorHTML}`,
    );
    previewFrame(result.preview.html);
    $("drawer-footer").innerHTML =
      button("back-to-voucher", "Back") +
      button(
        "send-voucher-email",
        d.status === "prepared" ? "Send email" : "Retry delivery",
        true,
      );
    $("back-to-voucher").onclick = () => openVoucher(voucherId).catch(err);
    const send = $("send-voucher-email");
    send.disabled = !settings.emailReady || !d.canSend;
    if (!d.canSend) send.textContent = "Delivery recorded";
    send.onclick = async () => {
      send.disabled = true;
      try {
        const result = await api("/sales/deliveries/" + d.id + "/send", {
          method: "POST",
          body: {},
        });
        if (!send.isConnected) return;
        $("delivery-status").textContent =
          labelStatus(result.delivery.status) +
          (result.delivery.status === "retry"
            ? ". Reopen this email after a minute to retry safely."
            : "");
        send.textContent = "Delivery recorded";
      } catch (error) {
        if (send.isConnected) {
          err(error);
          send.disabled = false;
          send.textContent = "Retry delivery";
        }
      }
    };
  }
  await list();
}
