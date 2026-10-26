const roleNames = {
  therapist: "Therapist",
  reception: "Reception",
  owner: "Owner",
};
const roleDescriptions = {
  none: "This account cannot sign in. The team profile and bookings are kept.",
  therapist:
    "View the whole salon calendar, rooms, treatments and requests. No client names, notes or financial information.",
  reception:
    "Manage bookings, blocked time and clients. No prices, bonuses, financial reports or account management.",
  owner:
    "Full access, including reports, financial information and account management.",
};

/** Owner-only account controls; the team profile is saved separately. */
export function mountAccountAccess({
  root,
  api,
  esc,
  profile = null,
  accountId = null,
  profiles = [],
  ownerId,
  isCurrent,
  onPreview,
  onSaved = () => {},
}) {
  let disposed = false,
    sequence = 0,
    busy = false,
    currentAccount = null,
    accounts = [],
    selectedId = accountId,
    initialForm = "";
  const current = (version) =>
    !disposed && root.isConnected && isCurrent() && version === sequence;
  const $ = (id) => root.querySelector(`#${id}`);
  const safe = (v) => esc(String(v ?? ""));
  const values = () => {
    const form = $("access-form");
    if (!form) return null;
    return Object.fromEntries(
      ["name", "login", "permission", "therapistId", "password"].map((key) => [
        key,
        form.elements[key]?.value ?? "",
      ]),
    );
  };
  const hasUnsavedChanges = () =>
    !!$("access-form") && JSON.stringify(values()) !== initialForm;
  function error(message) {
    $("access-error").textContent = message;
    $("access-error").hidden = false;
  }
  function updateRole() {
    const permission = $("access-role").value;
    $("access-role-description").textContent = roleDescriptions[permission];
    $("access-credentials").hidden = permission === "none" && !currentAccount;
    $("access-save").disabled =
      busy || (!currentAccount && permission === "none");
    $("access-password").required = !currentAccount && permission !== "none";
    if ($("access-profile"))
      $("access-profile").required = permission === "therapist";
    $("access-discard").hidden = !hasUnsavedChanges();
  }
  function render(message = "") {
    currentAccount =
      accounts.find((a) => a.id === selectedId) || accounts[0] || null;
    selectedId = currentAccount?.id || null;
    const self = currentAccount?.id === ownerId;
    const permission = currentAccount
      ? currentAccount.active
        ? currentAccount.role
        : "none"
      : profile
        ? "none"
        : "reception";
    const linkedId = profile?.id || currentAccount?.therapistId || "";
    const linkedProfile = profile || profiles.find((p) => p.id === linkedId);
    root.innerHTML = `<section class="account-access" aria-label="Access and permissions">
      <h3 class="form-section">Access &amp; permissions</h3>
      <p class="hint">${profile ? "Save account access here. Profile details, hours and bonuses are saved separately." : "Use an email address or a username. An email account is not required."}</p>
      ${accounts.length > 1 ? `<label><span>Linked account</span><select id="access-account">${accounts.map((a) => `<option value="${safe(a.id)}" ${a.id === selectedId ? "selected" : ""}>${safe(a.name)} · ${safe(a.login)} · ${safe(roleNames[a.role])}${a.active ? "" : " · No access"}</option>`).join("")}</select></label>` : ""}
      <form id="access-form">
        <label><span>Permission</span><select name="permission" id="access-role">${[
          ["none", "No access"],
          ["therapist", "Therapist"],
          ["reception", "Reception"],
          ["owner", "Owner"],
        ]
          .map(
            ([value, label]) =>
              `<option value="${value}" ${value === permission ? "selected" : ""} ${self && value !== "owner" ? "disabled" : ""}>${label}</option>`,
          )
          .join("")}</select></label>
        <p id="access-role-description" class="hint"></p>
        <div id="access-credentials" class="account-access-fields">
          <label><span>Account name</span><input name="name" id="access-name" maxlength="100" value="${safe(currentAccount?.name || profile?.name || "")}" required></label>
          <label><span>Email or username</span><input name="login" id="access-login" maxlength="254" value="${safe(currentAccount?.login || "")}" autocomplete="off" autocapitalize="none" spellcheck="false" ${self ? "readonly" : ""} required></label>
          <p class="hint">Usernames use 3–64 letters, numbers, dots, underscores or hyphens, starting with a letter.</p>
          ${profile ? "" : `<label><span>Team profile${permission === "therapist" ? "" : " (optional)"}</span><select name="therapistId" id="access-profile"><option value="">No linked profile</option>${profiles.map((p) => `<option value="${safe(p.id)}" ${p.id === linkedId ? "selected" : ""}>${safe(p.name)}${p.active ? "" : " (inactive)"}</option>`).join("")}</select></label>`}
          <label><span>${currentAccount ? "New temporary password (optional)" : "Temporary password"}</span><input name="password" id="access-password" type="password" minlength="12" maxlength="128" autocomplete="new-password" ${self ? "disabled" : ""}></label>
          <p class="hint">${self ? "Use Change password for your own account." : currentAccount ? "Leave blank to keep the existing password. A new temporary password must be replaced at first sign-in." : "Use at least 12 characters. Share privately; the user chooses their own password at first sign-in."}</p>
          ${currentAccount?.mustChangePassword ? '<p class="hint">A password change is required at the next sign-in.</p>' : ""}
        </div>
        ${profile?.active === false ? '<p class="hint">This team profile is inactive. Activate it before enabling Therapist access.</p>' : ""}
        <p id="access-error" class="error" role="alert" hidden></p>
        <p id="access-result" class="hint" role="status" ${message ? "" : "hidden"}>${safe(message)}</p>
        <div class="account-access-actions"><button class="btn primary" id="access-save" type="submit">Save access</button><button class="btn" id="access-discard" type="button" hidden>Discard access changes</button><button class="btn" id="access-reload" type="button" hidden>Reload access</button></div>
      </form>
      ${currentAccount?.active && ["therapist", "reception"].includes(currentAccount.role) && (currentAccount.role !== "therapist" || linkedProfile?.active !== false) ? '<button class="btn" id="access-preview" type="button">View as member</button><p class="hint">Check their view without their password. Preview does not save changes.</p>' : ""}
    </section>`;
    initialForm = JSON.stringify(values());
    updateRole();
    $("access-form").addEventListener("input", updateRole);
    $("access-form").addEventListener("change", updateRole);
    $("access-form").onsubmit = save;
    $("access-discard").onclick = () => render();
    $("access-reload").onclick = () => load();
    if ($("access-account"))
      $("access-account").onchange = (event) => {
        const next = event.target.value;
        if (hasUnsavedChanges()) {
          event.target.value = selectedId;
          error(
            "Save or discard access changes before selecting another account.",
          );
          return;
        }
        selectedId = next;
        render();
      };
    if ($("access-preview"))
      $("access-preview").onclick = async () => {
        if (busy || !current(sequence)) return;
        if (hasUnsavedChanges())
          return error("Save or discard access changes before previewing.");
        const button = $("access-preview");
        button.disabled = true;
        try {
          await onPreview(currentAccount.id);
        } catch (failure) {
          if (current(sequence)) error(failure.message);
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      };
  }
  async function load(message = "") {
    const version = ++sequence;
    root.innerHTML =
      '<p class="hint" role="status">Loading account access…</p>';
    try {
      const result = profile
        ? await api(`/therapists/${encodeURIComponent(profile.id)}/access`)
        : selectedId
          ? await api("/users")
          : { users: [] };
      if (!current(version)) return;
      accounts = profile
        ? result.accounts
        : (result.users || []).filter((a) => a.id === selectedId);
      if (!profile && selectedId && !accounts.length)
        throw new Error("This account is no longer available.");
      render(message);
    } catch (failure) {
      if (!current(version)) return;
      root.innerHTML = `<section class="account-access"><h3 class="form-section">Access &amp; permissions</h3><p class="error" role="alert">${safe(failure.message)}</p><button id="access-reload" class="btn" type="button">Reload access</button></section>`;
      $("access-reload").onclick = () => load();
    }
  }
  async function save(event) {
    event.preventDefault();
    if (busy || !current(sequence)) return;
    const form = event.currentTarget,
      version = sequence,
      draft = values();
    if (!currentAccount && draft.permission === "none") return;
    if (draft.permission === "therapist" && profile?.active === false)
      return error(
        "Activate this team profile before enabling Therapist access.",
      );
    const body = {
      name: draft.name,
      login: draft.login,
      role:
        draft.permission === "none" ? currentAccount.role : draft.permission,
      therapistId: profile?.id || draft.therapistId || null,
      ...(currentAccount
        ? {
            active: draft.permission !== "none",
            version: currentAccount.version,
          }
        : {}),
      ...(draft.password ? { password: draft.password } : {}),
    };
    const controls = [...form.querySelectorAll("input,select,button")],
      disabled = controls.map((c) => c.disabled);
    busy = true;
    controls.forEach((c) => {
      c.disabled = true;
    });
    if ($("access-account")) $("access-account").disabled = true;
    if ($("access-preview")) $("access-preview").disabled = true;
    $("access-error").hidden = true;
    $("access-result").hidden = true;
    try {
      const result = await api(
        currentAccount
          ? `/users/${encodeURIComponent(currentAccount.id)}`
          : "/users",
        { method: currentAccount ? "PUT" : "POST", body },
      );
      if (!current(version)) return;
      selectedId = result.account?.id || result.id || currentAccount?.id;
      busy = false;
      await load("Access saved.");
      if (current(sequence)) await onSaved();
    } catch (failure) {
      if (!current(version)) return;
      error(failure.message);
      if (failure.status === 409) $("access-reload").hidden = false;
    } finally {
      busy = false;
      if (form.isConnected && current(version)) {
        controls.forEach((c, i) => {
          c.disabled = disabled[i];
        });
        if ($("access-account")) $("access-account").disabled = false;
        if ($("access-preview")) $("access-preview").disabled = false;
        updateRole();
      }
    }
  }
  void load();
  return {
    hasUnsavedChanges,
    isBusy: () => busy,
    dispose() {
      disposed = true;
      sequence++;
    },
  };
}
