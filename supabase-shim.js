/* Tim & Myles Booking — Supabase connection.
   Gives the app the same small data interface it used on claude.ai
   (collections of documents, live updates, the signed-in person, file storage,
   downloads), backed by the Supabase project. */
(() => {
  const SUPABASE_URL = "https://eaguhgotxjdpkvxkuwol.supabase.co";
  const SUPABASE_KEY = "sb_publishable_4RfoKVn-4ITFLfP1SgGvSw_S9Wxj9Tn"; // public key; data is protected by team-only rules
  const BUCKET = "files";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  window.__sb = sb;

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/-/g, "");
  const err = (code, message) => Object.assign(new Error(message || code), { code });
  const fail = e => { console.error(e); throw err(/row-level|permission|JWT/i.test(e?.message||"") ? "invalid_argument" : "unavailable", e?.message); };
  const isObj = v => v && typeof v === "object" && !Array.isArray(v);
  const merge = (a, b) => { const out = { ...(a||{}) }; for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v; return out; };
  const splitPath = p => { const s = p.split("/"); return { col: s.slice(0, -1).join("/"), id: s[s.length - 1] }; };

  /* ---- local change bus so this device updates instantly after its own writes ---- */
  const listeners = new Set();   // {col, apply(type, id, data)}
  const emit = (col, type, id, data) => listeners.forEach(l => l.col === col && l.apply(type, id, data));

  const docSnap = (id, data) => ({ id, exists: data !== undefined, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } });

  function makeQuery(col, filters = [], order = null, lim = 1000) {
    const q = {
      path: col,
      where: (f, op, v) => makeQuery(col, [...filters, [f, op, v]], order, lim),
      orderBy: (f, dir = "asc") => makeQuery(col, filters, [f, dir], lim),
      limit: n => makeQuery(col, filters, order, n),
      doc: id => docRef(col, id || uuid()),
      add: async data => { const r = docRef(col, uuid()); await r.set(data); return r; },
      async get() {
        let rq = sb.from("docs").select("id,data").eq("collection", col);
        for (const [f, op, v] of filters) {
          const path = "data->>" + f;
          if (op === "==" || op === "eq") rq = rq.eq(path, v);
          else if (op === ">" || op === "gt") rq = rq.gt(path, v);
          else if (op === "<" || op === "lt") rq = rq.lt(path, v);
          else if (op === "in") rq = rq.in(path, v);
        }
        if (order) rq = rq.order("data->>" + order[0], { ascending: order[1] !== "desc" });
        rq = rq.range(0, Math.max(0, lim - 1));
        const { data, error } = await rq;
        if (error) fail(error);
        const docs = data.map(r => docSnap(r.id, r.data));
        return { docs, size: docs.length, empty: !docs.length, docChanges: () => docs.map((d, i) => ({ type: "added", doc: d, oldIndex: -1, newIndex: i })), metadata: { fromCache: false, hasPendingWrites: false } };
      },
      onSnapshot(next, onError) {
        const rows = new Map(); let alive = true; let timer = null;
        const matches = data => filters.every(([f, op, v]) => op === "==" ? String(data?.[f]) === String(v) : op === ">" ? String(data?.[f] ?? "") > String(v) : true);
        const deliver = () => { if (!alive) return; clearTimeout(timer); timer = setTimeout(() => {
          const docs = [...rows.entries()].map(([id, d]) => docSnap(id, d));
          next({ docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } });
        }, 30); };
        const apply = (type, id, data) => {
          if (type === "delete" || (data && !matches(data))) rows.delete(id); else rows.set(id, data);
          deliver();
        };
        const listener = { col, apply }; listeners.add(listener);
        q.get().then(s => { s.docs.forEach(d => rows.set(d.id, d.data())); deliver(); }).catch(e => onError && onError(e));
        const ch = sb.channel("docs-" + col.replace(/[^a-z0-9]/gi, "_") + "-" + uuid().slice(0, 8))
          .on("postgres_changes", { event: "*", schema: "public", table: "docs", filter: `collection=eq.${col}` }, p => {
            if (p.eventType === "DELETE") apply("delete", p.old.id);
            else apply("upsert", p.new.id, p.new.data);
          })
          .subscribe();
        return () => { alive = false; listeners.delete(listener); sb.removeChannel(ch); };
      },
    };
    return q;
  }

  function docRef(col, id) {
    return {
      id, path: col + "/" + id,
      async get() {
        const { data, error } = await sb.from("docs").select("data").eq("collection", col).eq("id", id).maybeSingle();
        if (error) fail(error);
        return docSnap(id, data ? data.data : undefined);
      },
      async set(data) {
        const { error } = await sb.from("docs").upsert({ collection: col, id, data }, { onConflict: "collection,id" });
        if (error) fail(error);
        emit(col, "upsert", id, data);
      },
      async update(patch) {
        const cur = await this.get();
        if (!cur.exists) throw err("invalid_argument", "Document does not exist");
        const data = merge(cur.data(), patch);
        const { error } = await sb.from("docs").update({ data }).eq("collection", col).eq("id", id);
        if (error) fail(error);
        emit(col, "upsert", id, data);
      },
      async delete() {
        const { error } = await sb.from("docs").delete().eq("collection", col).eq("id", id);
        if (error) fail(error);
        emit(col, "delete", id);
      },
      collection: sub => makeQuery(col + "/" + id + "/" + sub),
      onSnapshot(next, onError) {
        const q = makeQuery(col).where("__id", "==", id);
        return makeQuery(col).onSnapshot(s => { const d = s.docs.find(x => x.id === id); next(d || docSnap(id, undefined)); }, onError);
      },
    };
  }

  const db = {
    collection: path => makeQuery(path),
    doc: path => { const { col, id } = splitPath(path); return docRef(col, id); },
  };

  /* ---- who is signed in ---- */
  let session = null, profileName = "";
  const user = {
    isOwner: async () => true, canEdit: async () => true, can: async () => true,
    id: async () => session?.user?.id || null,
    name: async () => profileName,
    email: async () => session?.user?.email || null,
    me: async () => ({ id: session?.user?.id || null, name: profileName, email: session?.user?.email || null, avatarUrl: "", color: "#1f5f53", isOwner: true, canEdit: true }),
    async profiles(ids) {
      ids = [...new Set([].concat(ids))];
      const out = Object.fromEntries(ids.map(id => [id, { id, name: "", avatarUrl: "", color: "#888", email: null, isMe: id === session?.user?.id, guest: false }]));
      const { data } = await sb.from("docs").select("id,data").eq("collection", "people").in("id", ids);
      (data || []).forEach(r => { out[r.id].name = r.data?.name || ""; });
      return out;
    },
    search: async () => [],
  };

  /* ---- contract photos and PDFs ---- */
  const extOf = t => t.includes("pdf") ? "pdf" : t.includes("png") ? "png" : t.includes("webp") ? "webp" : t.includes("gif") ? "gif" : "jpg";
  const assets = {
    async upload(blob, opts = {}) {
      const type = opts.type || blob.type || "application/octet-stream";
      if (blob.size > 20 * 1024 * 1024) throw err("too_large");
      if (!/^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(type)) throw err("unsupported_type");
      const path = `${uuid()}.${extOf(type)}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: type, upsert: false });
      if (error) { console.error(error); throw err("upstream_error", error.message); }
      const { data } = await sb.storage.from(BUCKET).createSignedUrl(path, 3600);
      return { id: path, url: data?.signedUrl || "", sizeBytes: blob.size, contentType: type };
    },
    async delete(id) { const { error } = await sb.storage.from(BUCKET).remove([id]); if (error) throw err("upstream_error", error.message); return { deleted: true }; },
    async signed(ids) {
      if (!ids.length) return {};
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(ids, 3600);
      if (error) { console.error(error); return {}; }
      return Object.fromEntries((data || []).filter(x => x.signedUrl).map(x => [x.path, x.signedUrl]));
    },
    list: async () => ({ assets: [], usage: {} }),
  };

  /* ---- saving files to the device ---- */
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    },
  };

  /* ---- sign-in gate ---- */
  let ready, readyResolve; ready = new Promise(r => readyResolve = r);
  const caps = { db, user, assets, downloads };
  window.claude = { use: async name => { await ready; return caps[name] || null; } };

  function gate(html){
    const g = document.getElementById("auth-gate");
    g.innerHTML = html; g.hidden = false;
  }
  async function checkTeam() {
    const email = session.user.email;
    const { data, error } = await sb.from("app_users").select("email,display_name").ilike("email", email).maybeSingle();
    if (error || !data) return null;
    return data;
  }
  async function start(s) {
    session = s;
    if (!session) {
      gate(`<div class="gate-card"><h1>Tim &amp; Myles Booking</h1><p>Sign in with your email. We'll send you a link; tap it and you're in. No password needed.</p>
        <form id="gate-form"><label for="gate-email">Email</label><input id="gate-email" type="email" required autocomplete="email" placeholder="you@example.com">
        <button class="btn primary" type="submit" id="gate-btn">Email me a sign-in link</button></form><p class="gate-msg" id="gate-msg" role="status"></p></div>`);
      document.getElementById("gate-form").addEventListener("submit", async e => {
        e.preventDefault();
        const email = document.getElementById("gate-email").value.trim(), btn = document.getElementById("gate-btn"), msg = document.getElementById("gate-msg");
        btn.disabled = true; msg.textContent = "Sending…";
        const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
        btn.disabled = false;
        msg.textContent = error ? (/rate/i.test(error.message) ? "Too many sign-in emails in a short time. Wait a few minutes and try again." : "Couldn't send the link: " + error.message)
                                : `Check ${email} for an email from Supabase and tap the sign-in link. It works on this device's browser.`;
      });
      return;
    }
    const member = await checkTeam();
    if (!member) {
      gate(`<div class="gate-card"><h1>Not on the team list</h1><p>${session.user.email.replace(/[<>&]/g,"")} isn't set up for this booking app. Ask Tim to add you.</p><button class="btn" id="gate-out" type="button">Sign out</button></div>`);
      document.getElementById("gate-out").onclick = () => sb.auth.signOut().then(() => location.reload());
      return;
    }
    profileName = member.display_name || session.user.email.split("@")[0];
    sb.from("docs").upsert({ collection: "people", id: session.user.id, data: { name: profileName, email: session.user.email } }, { onConflict: "collection,id" }).then(() => {});
    document.getElementById("auth-gate").hidden = true;
    readyResolve();
  }
  window.__signOut = () => sb.auth.signOut().then(() => location.replace(location.origin + location.pathname));
  const domReady = new Promise(r => document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", r, { once: true }) : r());
  Promise.all([sb.auth.getSession(), domReady]).then(([{ data }]) => start(data.session));
  sb.auth.onAuthStateChange((evt, s) => { if (evt === "SIGNED_IN" && !session) domReady.then(() => start(s)); if (evt === "SIGNED_OUT") location.reload(); });
})();
