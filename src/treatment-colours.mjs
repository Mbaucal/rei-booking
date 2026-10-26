// The catalogue stores the chosen colour. Rendering never guesses or overrides
// a manually saved colour, even when it matches the former import default.
export const TREATMENT_COLOURS = Object.freeze(
  [
    { key: "combination", label: "Combination · turquoise", color: "#3aa6bf" },
    { key: "thai", label: "Thai · amber", color: "#e7a346" },
    { key: "aroma", label: "Aroma oil · rose", color: "#d982ab" },
    { key: "foot", label: "Foot · sage", color: "#76b896" },
    { key: "facial", label: "Head & facial · lavender", color: "#9c8cd4" },
    { key: "back", label: "Back, neck & shoulders · coral", color: "#de967c" },
    { key: "other", label: "Other treatments · blue", color: "#729cc7" },
  ].map(Object.freeze),
);

export function suggestedTreatmentColour(name) {
  const label = String(name ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/([a-z])(?=\d)/g, "$1 ")
    .trim();
  const family = /\bcombination\b/.test(label)
    ? "combination"
    : /\b(?:nuad|thai)\b/.test(label)
      ? "thai"
      : /\b(?:aroma|oil|relaxing)\b/.test(label)
        ? "aroma"
        : /\b(?:foot|feet|reflexology)\b/.test(label)
          ? "foot"
          : /\b(?:hbns|bnsh|bns|back|neck|shoulders?)\b/.test(label)
            ? "back"
            : /\b(?:head|facial|hf)\b|\bh\s+(?:and\s+)?f\b/.test(label)
              ? "facial"
              : "other";
  return TREATMENT_COLOURS.find((entry) => entry.key === family).color;
}

const initialized = new WeakMap();

// A bounded upgrade of untouched entries created by historical salon setup.
// Existing catalogue links alone do not prove that setup created the service:
// the service, link and setup receipt must share the creation timestamp too.
// No tables are installed and no existing custom colour is changed.
export async function ensureImportedTreatmentColours(db, actorId) {
  let pending = initialized.get(db);
  if (!pending) {
    pending = applyImportedTreatmentColours(db, actorId).catch((error) => {
      initialized.delete(db);
      throw error;
    });
    initialized.set(db, pending);
  }
  await pending;
}

async function applyImportedTreatmentColours(db, actorId) {
  const schema = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('history_catalogue_links','history_salon_receipts')",
    )
    .first();
  if (schema.n !== 2) return;
  const untouched = `version=1 AND lower(color)='#2e87a0' AND created_at=updated_at
    AND EXISTS(SELECT 1 FROM history_catalogue_links l WHERE l.kind='service' AND l.entity_id=services.id AND l.created_at=services.created_at)
    AND EXISTS(SELECT 1 FROM history_salon_receipts r WHERE r.created_at=services.created_at AND json_extract(r.result_json,'$.createdServices')>0)`;
  const { results } = await db
    .prepare(`SELECT id,name,color,created_at FROM services WHERE ${untouched}`)
    .all();
  // Each batch rechecks both the untouched state and exact selected name, so a
  // simultaneous manual edit wins. Audit and update commit or roll back together.
  const now = new Date().toISOString();
  for (let offset = 0; offset < results.length; offset += 40) {
    const statements = [];
    for (const entry of results.slice(offset, offset + 40)) {
      const color = suggestedTreatmentColour(entry.name);
      const guard = `id=? AND name=? AND created_at=? AND ${untouched}`;
      const args = [entry.id, entry.name, entry.created_at];
      statements.push(
        db
          .prepare(
            `INSERT INTO audit_log(actor_id,action,entity,entity_id,before_json,after_json,created_at)
             SELECT ?,'apply_treatment_palette','service',id,json_object('color',color,'version',version),json_object('color',?,'version',version+1),?
             FROM services WHERE ${guard}`,
          )
          .bind(actorId, color, now, ...args),
        db
          .prepare(
            `UPDATE services SET color=?,version=version+1,updated_at=? WHERE ${guard}`,
          )
          .bind(color, now, ...args),
      );
    }
    await db.batch(statements);
  }
}
