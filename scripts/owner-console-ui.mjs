import { prepareOwnerConsole } from "./owner-console.mjs";

const form = document.querySelector("form");
const fields = document.querySelector("fieldset");
const status = document.querySelector("#status");
const output = document.querySelector("#output");
const sql = document.querySelector("#sql");
const password = document.querySelector("#password");
const repeat = document.querySelector("#repeat");
const show = document.querySelector("#show");

show.addEventListener("change", () => {
  password.type = repeat.type = show.checked ? "text" : "password";
});
form.addEventListener("input", () => {
  output.hidden = true;
  sql.value = "";
  status.textContent = "";
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  output.hidden = true;
  sql.value = "";
  fields.disabled = true;
  status.textContent = "Preparing your command…";
  try {
    const result = await prepareOwnerConsole({
      email: form.elements.email.value,
      name: form.elements.name.value,
      password: password.value,
      repeat: repeat.value,
    });
    sql.value = result.sql;
    document.querySelector("#owner-email").textContent = result.email;
    password.value = repeat.value = "";
    show.checked = false;
    password.type = repeat.type = "password";
    output.hidden = false;
    status.textContent =
      "Command prepared. Complete the Cloudflare step below to save your password.";
    output.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    status.textContent = error.message;
  } finally {
    fields.disabled = false;
  }
});
document.querySelector("#copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(sql.value);
    status.textContent =
      "Copied. Paste into the Cloudflare D1 console, then click Execute.";
  } catch {
    sql.focus();
    sql.select();
    status.textContent =
      "Command selected. Press Command+C on Mac or Ctrl+C on Windows to copy.";
  }
});
document.querySelector("#clear").addEventListener("click", () => {
  form.reset();
  password.type = repeat.type = "password";
  sql.value = "";
  output.hidden = true;
  status.textContent = "Cleared.";
});
