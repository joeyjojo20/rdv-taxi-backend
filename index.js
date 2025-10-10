import express from "express";
import cors from "cors";
import webpush from "web-push";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/* =========================
   CONFIG DE BASE
========================= */
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const {
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT = "mailto:admin@example.com",
  PORT = 3000,
  DB_FILE = path.join(process.cwd(), "data", "events.json"),
} = process.env;

/* =========================
   VAPID / PUSH
========================= */
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Abonnements en mémoire (OK pour test). Pour persister, sauvegarde-les aussi en fichier.
const subscriptions = []; // [{endpoint, keys, ua, createdAt}]

/* =========================
   PERSISTANCE DES ÉVÈNEMENTS
   - Fichier JSON: { eventsById: { [id]: {id,title,start,allDay,reminderMinutes,updatedAt,deleted?} } }
========================= */
const dir = path.dirname(DB_FILE);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

async function loadDB() {
  try {
    const raw = await fsp.readFile(DB_FILE, "utf8");
    const json = JSON.parse(raw);
    if (!json || typeof json !== "object" || !json.eventsById) {
      return { eventsById: {} };
    }
    return json;
  } catch {
    return { eventsById: {} };
  }
}
async function saveDB(db) {
  const tmp = DB_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
  await fsp.rename(tmp, DB_FILE);
}

// Petite file pour sérialiser les écritures (évite les corruptions)
let queue = Promise.resolve();
function enqueue(fn) {
  queue = queue.then(fn).catch((e) => {
    console.error("DB error:", e);
  });
  return queue;
}

/* =========================
   ROUTES SANTÉ / DEBUG
========================= */
app.get("/health", async (_, res) => {
  const db = await loadDB();
  const total = Object.values(db.eventsById).length;
  const notDeleted = Object.values(db.eventsById).filter((e) => !e.deleted).length;
  res.json({
    ok: true,
    subs: subscriptions.length,
    events_total: total,
    events_active: notDeleted,
  });
});

/* =========================
   PUSH: /subscribe + /test-push
========================= */
app.post("/subscribe", (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return res.status(400).json({ error: "Subscription invalide" });
  }
  const ua = req.headers["user-agent"] || "unknown";
  const exists = subscriptions.find((s) => s.endpoint === sub.endpoint);
  if (!exists) subscriptions.push({ ...sub, ua, createdAt: Date.now() });
  return res.json({ ok: true, subs: subscriptions.length });
});

async function sendTestToAll(res) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return res.status(500).json({ error: "VAPID manquant" });
  }
  if (!subscriptions.length) {
    return res.status(400).json({ error: "Aucun abonnement enregistré" });
  }

  const payload = JSON.stringify({ title: "Test RDV Taxi", body: "Ça marche !" });
  let sent = 0,
    failed = 0;
  const stillValid = [];
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
      stillValid.push(sub);
    } catch (err) {
      failed++;
      // On ne garde pas les abonnements expirés/supprimés (404/410)
      if (!(err.statusCode === 404 || err.statusCode === 410)) {
        stillValid.push(sub);
      }
      console.error("push error", err.statusCode, err.body || err.message);
    }
  }
  subscriptions.length = 0;
  subscriptions.push(...stillValid);
  return res.json({ ok: true, sent, failed, subs: subscriptions.length });
}
app.post("/test-push", (req, res) => void sendTestToAll(res));
app.get("/test-push", (req, res) => void sendTestToAll(res));

/* =========================
   EVENTS API (sync multi-appareils)
========================= */

/**
 * GET /events?since=<ms>
 * since: timestamp ms (0 pour tout)
 * Réponse: { events: [ ... ] }
 */
app.get("/events", async (req, res) => {
  const since = Number(req.query.since || 0);
  const db = await loadDB();
  const all = Object.values(db.eventsById);
  const filtered =
    since > 0 ? all.filter((e) => Number(e.updatedAt || 0) > since) : all;
  // Tri chronologique pour stabilité
  filtered.sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0));
  res.json({ events: filtered });
});

/**
 * POST /events/upsert
 * Body: { deviceId, events: [ {id,title,start,allDay,reminderMinutes,updatedAt,deleted?} ] }
 */
app.post("/events/upsert", async (req, res) => {
  const body = req.body || {};
  const list = Array.isArray(body.events) ? body.events : [];
  if (!list.length) return res.json({ ok: true, upserted: 0 });

  await enqueue(async () => {
    const db = await loadDB();
    let upserted = 0;

    for (const inc of list) {
      if (!inc || !inc.id) continue;
      const curr = db.eventsById[inc.id];
      const incU = Number(inc.updatedAt || 0);
      const curU = Number(curr?.updatedAt || 0);
      // Upsert seulement si + récent
      if (!curr || incU >= curU) {
        db.eventsById[inc.id] = {
          id: String(inc.id),
          title: String(inc.title || ""),
          start: String(inc.start || ""),
          allDay: !!inc.allDay,
          reminderMinutes:
            inc.reminderMinutes === null || inc.reminderMinutes === undefined
              ? null
              : Number(inc.reminderMinutes),
          updatedAt: incU || Date.now(),
          deleted: !!inc.deleted,
        };
        upserted++;
      }
    }
    await saveDB(db);
    res.json({ ok: true, upserted });
  });
});

/**
 * POST /events/delete
 * Body: { deviceId, ids: [id...], updatedAt }
 * → marque en deleted (tombstone) + updatedAt
 */
app.post("/events/delete", async (req, res) => {
  const { ids, updatedAt } = req.body || {};
  const list = Array.isArray(ids) ? ids : [];
  if (!list.length) return res.json({ ok: true, deleted: 0 });

  const markU = Number(updatedAt || Date.now());

  await enqueue(async () => {
    const db = await loadDB();
    let count = 0;

    for (const id of list) {
      if (!id) continue;
      const curr = db.eventsById[id];
      if (curr) {
        // On marque supprimé seulement si notre horodatage est plus récent
        if (markU >= Number(curr.updatedAt || 0)) {
          db.eventsById[id] = { ...curr, deleted: true, updatedAt: markU };
          count++;
        }
      } else {
        // Crée une tombstone pour propager la suppression
        db.eventsById[id] = {
          id: String(id),
          title: "",
          start: "",
          allDay: false,
          reminderMinutes: null,
          updatedAt: markU,
          deleted: true,
        };
        count++;
      }
    }

    // Option: nettoyage des tombstones très anciennes (non indispensable ici)
    await saveDB(db);
    res.json({ ok: true, deleted: count });
  });
});

/**
 * (Stub) POST /sync-events
 * Le front peut envoyer { events: [ {id,title,startISO,reminderMinutes} ] }
 * Ici on répond juste OK pour ne rien casser; tu pourras brancher un scheduler plus tard.
 */
app.post("/sync-events", (req, res) => {
  // console.log("sync-events payload", req.body);
  res.json({ ok: true });
});

/* =========================
   DÉMARRAGE
========================= */
app.listen(PORT, () => {
  console.log(`Backend up on :${PORT}`);
});
