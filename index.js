import express from "express";
import cors from "cors";
import webpush from "web-push";

const app = express();
app.use(cors());
app.use(express.json());

// === VAPID depuis Render (Settings → Environment) ===
const {
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT = "mailto:admin@example.com",
} = process.env;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Stockage en mémoire pour tester (suffit pour l’instant)
const subscriptions = []; // [{endpoint, keys:{p256dh,auth}}]

app.get("/health", (_, res) => res.json({ ok: true, subs: subscriptions.length }));

// 1) Reçoit l’abonnement push depuis le front
app.post("/subscribe", (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return res.status(400).json({ error: "Subscription invalide" });
  }
  if (!subscriptions.find(s => s.endpoint === sub.endpoint)) {
    subscriptions.push(sub);
  }
  res.json({ ok: true, subs: subscriptions.length });
});

// 2) Envoie une notification de test au 1er abonnement (pour valider que tout marche)
app.post("/test-push", async (req, res) => {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return res.status(500).json({ error: "VAPID manquant dans Render" });
  }
  if (!subscriptions.length) {
    return res.status(400).json({ error: "Aucun abonnement enregistré encore" });
  }
  try {
    await webpush.sendNotification(
      subscriptions[0],
      JSON.stringify({ title: "Test RDV Taxi", body: "Ça marche !" })
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Envoi échoué" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Backend up on :" + PORT));
