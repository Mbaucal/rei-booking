// Identical contact identities are resolved by staff, never merged implicitly.
export function mountClientMatches({
  form,
  container,
  api,
  esc,
  phone,
  instagram,
  email,
  exclude = "",
  current,
  onUse,
  onOpen,
}) {
  let sequence = 0,
    timer;
  const valid = () => form.isConnected && current();
  const show = (matches) => {
    if (!valid()) return;
    container.hidden = !matches.length;
    container.innerHTML = matches.length
      ? `<strong>Client already exists</strong>${matches.map((c) => `<div class="client-match"><p><strong>${esc(c.name)}</strong><br>${esc(c.phone || "")}${c.instagram ? ` · @${esc(c.instagram)}` : ""}<br><small>Matching: ${esc((c.matchedOn || []).join(", ") || "contact details")}</small></p>${onUse ? `<button type="button" class="btn primary" data-use-client="${esc(c.id)}">Use this client</button>` : ""}${onOpen ? `<button type="button" class="btn" data-open-client="${esc(c.id)}">Open profile</button>` : ""}</div>`).join("")}`
      : "";
    container
      .querySelectorAll("[data-use-client]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            onUse(matches.find((c) => c.id === b.dataset.useClient))),
      );
    container
      .querySelectorAll("[data-open-client]")
      .forEach((b) => (b.onclick = () => onOpen(b.dataset.openClient)));
  };
  const check = async () => {
    const own = ++sequence,
      params = new URLSearchParams({ exclude }),
      p = form.querySelector(`[name="${phone}"]`)?.value || "",
      i = form.querySelector(`[name="${instagram}"]`)?.value || "",
      e = form.querySelector(`[name="${email}"]`)?.value || "";
    if (p.replace(/\D/g, "").length >= 7) params.set("phone", p);
    if (i.trim()) params.set("instagram", i);
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) params.set("email", e);
    if (params.size === 1) {
      show([]);
      return;
    }
    try {
      const data = await api("/clients/matches?" + params);
      if (own === sequence && valid()) show(data.matches);
    } catch (error) {
      if (own === sequence && valid()) {
        show([]);
        if (error.status !== 400) {
          container.hidden = false;
          container.textContent =
            "Contact check is temporarily unavailable. Saving will check for duplicates again.";
        }
      }
    }
  };
  for (const name of [phone, instagram, email]) {
    const el = form.querySelector(`[name="${name}"]`);
    if (el)
      el.addEventListener("input", () => {
        sequence++;
        show([]);
        clearTimeout(timer);
        timer = setTimeout(check, 350);
      });
  }
  return { show, check };
}
