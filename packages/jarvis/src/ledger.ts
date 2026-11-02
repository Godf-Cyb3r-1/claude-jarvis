import { Database } from "bun:sqlite"

export type Card = {
  session_id: string
  title: string
  goal: string
  keywords: string[]
  state: "running" | "queued" | "waiting" | "done" | "failed" | "interrupted"
  outcome: string
  files: string[]
  updated_at: number
}

type Row = Omit<Card, "keywords" | "files"> & { keywords: string; files: string }

const STOP = new Set(
  "the a an and or to of in on for with is are was were be it this that i you we my me your can could should would please just then than from into about have has had do does did not no yes ok okay hey jarvis".split(" "),
)

/** Cheap keyword extraction used when the summariser model is unavailable, and to build search queries. */
export function keywordsOf(text: string, max = 12): string[] {
  const counts = new Map<string, number>()
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}_./-]{3,}/gu) ?? []) {
    if (STOP.has(w)) continue
    counts.set(w, (counts.get(w) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w)
}

/** SQLite + FTS5. A trigram index backs partial words and scripts without word breaks (Tamil, for example). */
export class Ledger {
  readonly db: Database
  constructor(path = ":memory:") {
    this.db = new Database(path, { create: true })
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS cards (
        session_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', goal TEXT NOT NULL DEFAULT '',
        keywords TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT 'running',
        outcome TEXT NOT NULL DEFAULT '', files TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(session_id UNINDEXED, title, goal, keywords, outcome);
      CREATE VIRTUAL TABLE IF NOT EXISTS cards_tri USING fts5(session_id UNINDEXED, body, tokenize='trigram');
      CREATE TABLE IF NOT EXISTS profile (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
    `)
  }

  upsert(card: Partial<Card> & { session_id: string }) {
    const prev = this.get(card.session_id)
    const next: Card = {
      session_id: card.session_id,
      title: card.title ?? prev?.title ?? "",
      goal: card.goal ?? prev?.goal ?? "",
      keywords: card.keywords ?? prev?.keywords ?? [],
      state: card.state ?? prev?.state ?? "running",
      outcome: card.outcome ?? prev?.outcome ?? "",
      files: card.files ?? prev?.files ?? [],
      updated_at: Date.now(),
    }
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO cards(session_id,title,goal,keywords,state,outcome,files,updated_at) VALUES(?,?,?,?,?,?,?,?)
           ON CONFLICT(session_id) DO UPDATE SET title=excluded.title,goal=excluded.goal,keywords=excluded.keywords,
           state=excluded.state,outcome=excluded.outcome,files=excluded.files,updated_at=excluded.updated_at`,
        )
        .run(next.session_id, next.title, next.goal, JSON.stringify(next.keywords), next.state, next.outcome, JSON.stringify(next.files), next.updated_at)
      this.db.query(`DELETE FROM cards_fts WHERE session_id=?`).run(next.session_id)
      this.db.query(`DELETE FROM cards_tri WHERE session_id=?`).run(next.session_id)
      this.db.query(`INSERT INTO cards_fts(session_id,title,goal,keywords,outcome) VALUES(?,?,?,?,?)`).run(next.session_id, next.title, next.goal, next.keywords.join(" "), next.outcome)
      this.db.query(`INSERT INTO cards_tri(session_id,body) VALUES(?,?)`).run(next.session_id, [next.title, next.goal, next.keywords.join(" "), next.outcome].join(" "))
    })()
    return next
  }

  private parse(r: Row): Card {
    return { ...r, keywords: JSON.parse(r.keywords), files: JSON.parse(r.files) }
  }

  get(id: string): Card | undefined {
    const r = this.db.query(`SELECT * FROM cards WHERE session_id=?`).get(id) as Row | null
    return r ? this.parse(r) : undefined
  }

  recent(limit = 20): Card[] {
    return (this.db.query(`SELECT * FROM cards ORDER BY updated_at DESC LIMIT ?`).all(limit) as Row[]).map((r) => this.parse(r))
  }

  /** Top cards for a free-text mention. FTS5 first, trigram as the fallback for partial words and other scripts. */
  find(query: string, limit = 3): Card[] {
    const words = keywordsOf(query, 8)
    const ids: string[] = []
    if (words.length) {
      const match = words.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ")
      try {
        for (const r of this.db.query(`SELECT session_id FROM cards_fts WHERE cards_fts MATCH ? ORDER BY bm25(cards_fts) LIMIT ?`).all(match, limit) as { session_id: string }[]) ids.push(r.session_id)
      } catch {}
    }
    if (ids.length < limit) {
      for (const w of [query.trim(), ...words].filter((w) => w.length >= 3)) {
        try {
          for (const r of this.db.query(`SELECT session_id FROM cards_tri WHERE cards_tri MATCH ? LIMIT ?`).all(`"${w.replace(/"/g, "")}"`, limit) as { session_id: string }[]) if (!ids.includes(r.session_id)) ids.push(r.session_id)
        } catch {}
        if (ids.length >= limit) break
      }
    }
    return ids.slice(0, limit).map((id) => this.get(id)!).filter(Boolean)
  }

  // ---- user profile and notes ----
  setProfile(k: string, v: string) {
    this.db.query(`INSERT INTO profile(k,v,updated_at) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated_at=excluded.updated_at`).run(k, v, Date.now())
  }
  profile(): Record<string, string> {
    return Object.fromEntries((this.db.query(`SELECT k,v FROM profile`).all() as { k: string; v: string }[]).map((r) => [r.k, r.v]))
  }
  addNote(note: string) {
    const dup = this.db.query(`SELECT 1 FROM notes WHERE note=?`).get(note)
    if (!dup) this.db.query(`INSERT INTO notes(note,at) VALUES(?,?)`).run(note, Date.now())
    return !dup
  }
  notes(limit = 40): string[] {
    return (this.db.query(`SELECT note FROM notes ORDER BY id DESC LIMIT ?`).all(limit) as { note: string }[]).map((r) => r.note)
  }
  wipeUser() {
    this.db.exec(`DELETE FROM profile; DELETE FROM notes;`)
  }

  audit(kind: string, detail: string) {
    this.db.query(`INSERT INTO audit(at,kind,detail) VALUES(?,?,?)`).run(Date.now(), kind, detail)
  }
  auditLog(limit = 50) {
    return this.db.query(`SELECT at,kind,detail FROM audit ORDER BY id DESC LIMIT ?`).all(limit) as { at: number; kind: string; detail: string }[]
  }
}
