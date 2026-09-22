export const DEFAULT_DESIGN = Object.freeze({
  theme: "ivory",
  layout: "classic",
  title: "A moment just for you",
  terms: "Please quote your voucher code when booking.",
  showPrice: false,
});
export const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const money = (cents) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "RSD" }).format(
    cents / 100,
  );
export function voucherContent(
  voucher,
  origin,
  { preview = false, print = false } = {},
) {
  const d = voucher.design,
    e = escapeHTML;
  const dark = d.theme === "forest",
    bg = dark ? "#1f3d33" : "#fffaf0",
    ink = dark ? "#fffaf0" : "#1f3d33",
    muted = dark ? "#e5d2af" : "#705b34";
  const entitlement =
    voucher.kind === "amount" ? money(voucher.priceCents) : voucher.serviceName;
  const price =
    voucher.kind === "treatment" && d.showPrice
      ? money(voucher.priceCents)
      : "";
  const validity = voucher.expiresOn
    ? `Valid through ${voucher.expiresOn}`
    : "No expiry date";
  const lines = [
    "Rei Thailand Massage",
    "Gift voucher",
    d.title,
    voucher.recipientName ? `For ${voucher.recipientName}` : "",
    entitlement,
    voucher.duration ? `${voucher.duration} minutes` : "",
    price,
    voucher.message,
    voucher.senderName ? `From ${voucher.senderName}` : "",
    `Voucher code: ${voucher.code}`,
    validity,
    d.terms,
    preview ? "PREVIEW — no voucher has been issued." : "",
  ].filter(Boolean);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rei gift voucher</title>
<style>body{margin:0;padding:24px;background:#faf6ef;font:16px/1.65 Arial,sans-serif}p,h1,h2{margin:0} .voucher{max-width:620px;margin:0 auto;overflow-wrap:anywhere} .print-tools{max-width:620px;margin:0 auto 20px;text-align:center}button{font:inherit;padding:12px 20px;cursor:pointer}@media(max-width:480px){body{padding:8px}.voucher td{padding:24px!important}}@media print{body{padding:0;background:white}.print-tools{display:none}}</style></head><body>
${print ? '<div class="print-tools"><button id="print-voucher">Print / Save as PDF</button></div>' : ""}
<table role="presentation" class="voucher" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;margin:auto;background:${bg};color:${ink};border:1px solid #b79b60;border-radius:12px"><tr><td style="padding:44px;text-align:${d.layout === "letter" ? "left" : "center"}">
<img src="${e(origin)}/logo.png" width="180" alt="Rei Thailand Massage" style="max-width:100%;height:auto;background:#fff;padding:8px;border-radius:4px">
<p style="font-size:12px;letter-spacing:3px;color:${muted};margin:28px 0 12px">GIFT VOUCHER</p>
<h1 style="font:32px/1.3 Georgia,serif;color:${ink}">${e(d.title)}</h1>
${voucher.recipientName ? `<p style="margin-top:24px">For ${e(voucher.recipientName)}</p>` : ""}
<h2 style="font:25px/1.35 Georgia,serif;margin:24px 0 8px;color:${ink}">${e(entitlement)}</h2>
${voucher.duration ? `<p>${voucher.duration} minutes${price ? ` · ${e(price)}` : ""}</p>` : ""}
${voucher.message ? `<p style="margin:24px 0;white-space:pre-line">${e(voucher.message)}</p>` : ""}
${voucher.senderName ? `<p>With love, ${e(voucher.senderName)}</p>` : ""}
<p style="margin:32px 0 4px;font-size:12px;color:${muted}">VOUCHER CODE</p><p style="font:bold 17px/1.5 monospace;letter-spacing:1px">${e(voucher.code)}</p>
<p style="margin-top:16px;font-size:13px">${e(validity)}</p><p style="margin-top:16px;font-size:13px;white-space:pre-line">${e(d.terms)}</p>
${preview ? '<p style="margin-top:24px;font-weight:bold">PREVIEW · Not issued</p>' : ""}
</td></tr></table>${print ? '<script src="/voucher-print.js" defer></script>' : ""}</body></html>`;
  return { html, text: lines.join("\n\n") };
}
