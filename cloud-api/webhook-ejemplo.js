/**
 * Webhook mínimo WhatsApp Cloud API (Node + Express).
 * Vigente a jun 2026, Graph API v23.0.
 *
 * Hace 2 cosas:
 *   1. GET  /webhook  → verificación de Meta (responde el challenge).
 *   2. POST /webhook  → recibe mensajes entrantes y responde (dentro de ventana 24h = gratis).
 *
 * Despliegue: Render (Web Service, start = `node webhook-ejemplo.js`).
 * NO comparte nada con el bot Baileys de la carpeta padre — es un proyecto aparte.
 *
 * Para Cloudflare Workers: misma lógica, pero usa `export default { fetch }` en vez de Express.
 */

const express = require("express");
const { createGasolina } = require("./gasolina-logic");
const store = require("./store-supabase");

const {
  PHONE_NUMBER_ID,
  ACCESS_TOKEN,
  WEBHOOK_VERIFY_TOKEN,
  GRAPH_VERSION = "v23.0",
  LINK_CARPETA_SEGUROS = "",
  PORT = 3000,
} = process.env;

const API = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

// Motor de gasolina (portado de ../bot.js) con persistencia Supabase
const gasolina = createGasolina(store, { linkCarpetaSeguros: LINK_CARPETA_SEGUROS });

const app = express();
app.use(express.json());

// 1) Verificación del webhook (Meta hace un GET una sola vez al guardarlo)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Enviar texto libre (solo válido dentro de la ventana de 24h → gratis, categoría service)
async function sendText(to, text) {
  const r = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
  if (!r.ok) console.error("[send] error:", r.status, await r.text());
}

// 2) Mensajes entrantes
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // responde rápido SIEMPRE; Meta reintenta si tardas

  try {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value;
    const msg = entry?.messages?.[0];
    if (!msg) return; // puede ser un update de estado (delivered/read), ignorar

    const from = msg.from; // número del remitente (con código país)
    const body = msg.text?.body?.trim() || "";
    console.log(`Mensaje de ${from}: ${body}`);

    // Motor de gasolina: devuelve 0..N respuestas; las mandamos en orden.
    const respuestas = await gasolina.handle(from, body);
    for (const r of respuestas) await sendText(from, r);
  } catch (e) {
    console.error("[webhook] error:", e.message);
  }
});

app.listen(PORT, () => console.log(`Webhook Cloud API en puerto ${PORT}`));
