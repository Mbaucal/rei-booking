export async function uploadClientCSV({
  api,
  parsed,
  mapping,
  source,
  current,
  progress,
  state,
}) {
  const hash = async (value) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
  const ensure = () => {
    if (!current()) throw new Error("Import cancelled.");
  };
  const fileHash =
    parsed.fileHash ||
    (await hash(
      JSON.stringify({ headers: parsed.headers, rows: parsed.rows }),
    ));
  parsed.fileHash = fileHash;
  const signature = JSON.stringify({ fileHash, mapping, source });
  ensure();
  if (state.signature !== signature) {
    state.signature = signature;
    state.job = null;
    state.offset = 0;
  }
  if (!state.job) {
    const created = await api("/clients/import/bulk/start", {
      method: "POST",
      body: {
        headers: parsed.headers,
        mapping,
        source,
        total: parsed.rows.length,
        fileHash,
      },
    });
    ensure();
    state.job = created;
  }
  const used = new Set(Object.values(mapping));
  while (state.offset < parsed.rows.length) {
    ensure();
    const rows = [];
    let bytes = 0;
    for (
      let i = state.offset;
      i < Math.min(state.offset + 250, parsed.rows.length);
      i++
    ) {
      const row = parsed.rows[i].map((v, j) => (used.has(j) ? v : ""));
      const size = new TextEncoder().encode(JSON.stringify(row)).length;
      if (rows.length && bytes + size > 800000) break;
      rows.push(row);
      bytes += size;
    }
    progress(state.offset, parsed.rows.length);
    await api("/clients/import/bulk/" + state.job.id + "/upload", {
      method: "POST",
      body: { offset: state.offset, rows },
    });
    ensure();
    state.offset += rows.length;
  }
  progress(state.offset, parsed.rows.length);
  ensure();
  return api("/clients/import/bulk/" + state.job.id + "/finalize", {
    method: "POST",
    body: {},
  });
}
