/**
 * Bot de gasolina sobre TELEGRAM.
 * Reusa el MISMO motor (gasolina-logic.js) y el MISMO store Supabase que el WhatsApp.
 * No toca nada de WhatsApp — es otro "front" para la misma lógica y los mismos datos.
 *
 * Arranque: node bot-telegram.js   (usa polling, no necesita URL pública)
 * Ideal en Render como "Background Worker".
 */

const TelegramBot = require("node-telegram-bot-api");
const { createGasolina } = require("./gasolina-logic");
const store = require("./store-supabase");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("Falta TELEGRAM_BOT_TOKEN (lo da @BotFather).");
  process.exit(1);
}

// Allowlist: solo tus 3 cuentas. IDs separados por coma en TELEGRAM_ALLOWED_IDS.
// Si lo dejas vacío, cualquiera que encuentre el bot puede usarlo.
const ALLOWED = (process.env.TELEGRAM_ALLOWED_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const gasolina = createGasolina(store, {
  linkCarpetaSeguros: process.env.LINK_CARPETA_SEGUROS || "",
});

const bot = new TelegramBot(TOKEN, { polling: true });

bot.on("message", async (msg) => {
  const chatId = String(msg.chat.id);
  let text = msg.text || "";
  if (!text) return;

  // En grupos, Telegram manda los comandos como "/seguros@TuBot". Quitamos el @Bot
  // para que el motor los reconozca igual que en privado.
  text = text.replace(/^(\/[A-Za-z0-9_]+)@\w+/, "$1");

  // Control de acceso (tus 3 cuentas)
  if (ALLOWED.length && !ALLOWED.includes(chatId)) {
    console.warn(`Mensaje de chat no autorizado: ${chatId}`);
    await bot.sendMessage(chatId, `No autorizado. Tu ID es ${chatId} (pásalo al admin).`);
    return;
  }

  try {
    // userId = chatId → cada cuenta tiene su propia sesión; los autos/historial son
    // compartidos via Supabase (igual que el WhatsApp).
    const respuestas = await gasolina.handle(chatId, text);
    for (const r of respuestas) {
      // El motor usa formato WhatsApp (*negrita* _itálica_), compatible con Markdown de
      // Telegram. Si algún texto desbalancea el Markdown, reenvía en plano para no fallar.
      try {
        await bot.sendMessage(chatId, r, { parse_mode: "Markdown" });
      } catch {
        await bot.sendMessage(chatId, r);
      }
    }
  } catch (e) {
    console.error("Error procesando mensaje:", e.message);
    await bot.sendMessage(chatId, "❌ Error procesando tu mensaje.");
  }
});

bot.on("polling_error", (e) => console.error("[polling_error]", e.message));

console.log("Bot de gasolina (Telegram) corriendo en modo polling...");

// Dummy HTTP server for Render "Web Service" port binding requirement
const http = require("http");
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bot de Telegram activo");
}).listen(PORT, () => {
  console.log(`Servidor dummy escuchando en puerto ${PORT}`);
});
