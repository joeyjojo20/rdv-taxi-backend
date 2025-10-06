import express from "express";
import cors from "cors";

const app = express();
app.use(cors());

app.get("/health", (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Backend up on :" + PORT));
