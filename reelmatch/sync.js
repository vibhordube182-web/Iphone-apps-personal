// Two-phone sync over a Firebase-style Realtime Database REST API (works with Firebase, or with ./server.js).
// Layout:  rooms/<code>/members/<uid> = { name }
//          rooms/<code>/swipes/<uid>/<movieId> = compact record (see taste.js makeRecord)
//          rooms/<code>/watched/<movieId> = true
// Writes are queued in an outbox, so swiping works offline and catches up when the connection returns.

export class Room {
  constructor(db, code, uid) {
    this.db = (db || "").replace(/\/+$/, "");
    this.code = code; this.uid = uid; this.etag = null;
    this.outbox = [];
    try { this.outbox = JSON.parse(localStorage.getItem("rm_outbox_" + code) || "[]"); } catch (_) {}
  }
  get enabled() { return !!(this.db && this.code); }
  url(path) { return `${this.db}/rooms/${this.code}/${path}.json`; }

  async req(method, path, body) {
    const r = await fetch(this.url(path), { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { "Content-Type": "application/json" } });
    if (!r.ok) throw new Error("Sync error " + r.status);
    return r.status === 204 ? null : r.json();
  }

  static async ping(db) {
    try { const r = await fetch(db.replace(/\/+$/, "") + "/ping.json"); return r.ok; } catch (_) { return false; }
  }

  // Full snapshot, using ETags so an unchanged room costs almost nothing.
  async snapshot() {
    const headers = { "X-Firebase-ETag": "true" };
    if (this.etag) headers["If-None-Match"] = this.etag;
    const r = await fetch(this.url(""), { headers });
    if (r.status === 304) return null;
    if (!r.ok) throw new Error("Sync error " + r.status);
    this.etag = r.headers.get("ETag") || null;
    return (await r.json()) || {};
  }

  save() { try { localStorage.setItem("rm_outbox_" + this.code, JSON.stringify(this.outbox)); } catch (_) {} }
  queue(op) {
    if (!this.enabled) return;
    this.outbox = this.outbox.filter((o) => o.path !== op.path); // last write wins per key
    this.outbox.push(op); this.save(); this.flush();
  }
  async flush() {
    if (this.flushing || !this.enabled) return;
    this.flushing = true;
    try {
      while (this.outbox.length) {
        const op = this.outbox[0];
        await this.req(op.method, op.path, op.body);
        this.outbox.shift(); this.save();
      }
    } catch (_) { /* offline: keep the queue, retry on the next poll */ }
    this.flushing = false;
  }

  swipe(id, rec) { this.queue({ method: "PUT", path: `swipes/${this.uid}/${id}`, body: rec }); }
  unswipe(id) { this.queue({ method: "DELETE", path: `swipes/${this.uid}/${id}` }); }
  watched(id, on) { this.queue(on ? { method: "PUT", path: `watched/${id}`, body: true } : { method: "DELETE", path: `watched/${id}` }); }
  setName(name) { this.queue({ method: "PUT", path: `members/${this.uid}`, body: { name, t: Date.now() } }); }
  setKey(k) { this.queue({ method: "PUT", path: "cfg", body: { k } }); }
  forget(uid) { this.queue({ method: "DELETE", path: `members/${uid}` }); this.queue({ method: "DELETE", path: `swipes/${uid}` }); }

  // A joiner only knows the room code: the TMDB key is read from the private room.
  static async fetchKey(db, code) {
    try { const r = await fetch(`${db.replace(/\/+$/, "")}/rooms/${code}/cfg.json`); const o = r.ok ? await r.json() : null; return o && o.k ? o.k : null; } catch (_) { return null; }
  }
}
