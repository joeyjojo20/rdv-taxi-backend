import express from "express";
import cors from "cors";
import webpush from "web-push";

const app = express();
app.use(cors());
app.use(express.json());

// --- VAPID depuis Render ---
const {
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT = "mailto:admin@example.com",
} = process.env;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// --- stockage en mémoire (test) ---
const subscriptions = []; // [{endpoint, keys, ua, createdAt}]

// Santé / debug
app.get("/health", (_, res) => res.json({ ok: true, subs: subscriptions.length }));

// Abonnement push (côté front)
app.post("/subscribe", (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return res.status(400).json({ error: "Subscription invalide" });
  }
  const ua = req.headers["user-agent"] || "unknown";
  const exists = subscriptions.find(s => s.endpoint === sub.endpoint);
  if (!exists) subscriptions.push({ ...sub, ua, createdAt: Date.now() });
  return res.json({ ok: true, subs: subscriptions.length });
});

// Fonction commune: envoyer une notif de test à TOUS les abonnés
async function sendTestToAll(res) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return res.status(500).json({ error: "VAPID manquant dans Render" });
  }
  if (!subscriptions.length) {
    return res.status(400).json({ error: "Aucun abonnement enregistré encore" });
  }

  const payload = JSON.stringify({ title: "Test RDV Taxi", body: "Ça marche !" });
  let sent = 0, failed = 0;
  const stillValid = [];

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
      stillValid.push(sub);
    } catch (err) {
      failed++;
      // on supprime seulement si l'abonnement est expiré/supprimé
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

// Routes de test (POST et GET)
app.post("/test-push", (req, res) => { sendTestToAll(res); });
app.get("/test-push", (req, res) => { sendTestToAll(res); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Backend up on :" + PORT));
