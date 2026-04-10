require("dotenv").config();
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON,
  proto,
  makeCacheableSignalKeyStore
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const P = require("pino");

// ==================== CONFIGURACIÓN ====================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// 🔒 GRUPO PERMITIDO (Solo procesar mensajes de este grupo)
const GRUPO_PERMITIDO = "5214111103705-1532543388@g.us";

// 📁 Link de carpeta de seguros en la nube
const LINK_CARPETA_SEGUROS =
  "https://drive.google.com/drive/folders/11GbfKwxzQUxYjA4wCQ4joRE15dpep9Xa?usp=sharing";

// 📲 TELEGRAM (alertas cuando el bot se cae o necesita acción)
// Pasos para configurar:
//   1. Habla con @BotFather en Telegram → /newbot → copia el token
//   2. Manda cualquier mensaje a tu nuevo bot
//   3. Abre: https://api.telegram.org/bot<TOKEN>/getUpdates → copia tu chat_id
//   4. Agrega en Render como variables de entorno: TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ==================== EXPRESS (UptimeRobot) ====================
const app = express();
app.get("/", (req, res) => res.send("Bot Activo 24/7 (Render + UptimeRobot)"));
app.listen(process.env.PORT || 3000, () =>
  console.log("Servidor Express escuchando (Listo para UptimeRobot)")
);

// ==================== ALERTAS TELEGRAM ====================
async function sendTelegramAlert (message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return; // No configurado, omitir
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: `🤖 *GasolinaBot*\n\n${message}`,
        parse_mode: "Markdown"
      })
    });
  } catch (e) {
    console.warn("[Telegram] No se pudo enviar alerta:", e.message);
  }
}

// ==================== AUTH STATE CON SUPABASE ====================
async function useSupabaseAuthState () {
  const write = async (key, data) => {
    const val = JSON.stringify(data, BufferJSON.replacer);
    await supabase.from("baileys_auth").upsert([{ key, value: val }]);
  };

  const read = async (key) => {
    const { data } = await supabase
      .from("baileys_auth")
      .select("value")
      .eq("key", key)
      .single();
    if (!data?.value) return null;
    return JSON.parse(data.value, BufferJSON.reviver);
  };

  const del = async (key) => {
    await supabase.from("baileys_auth").delete().eq("key", key);
  };

  const creds = (await read("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: makeCacheableSignalKeyStore(
        {
          get: async (type, ids) => {
            const result = {};
            await Promise.all(
              ids.map(async (id) => {
                let val = await read(`${type}-${id}`);
                if (val) {
                  if (type === "app-state-sync-key") {
                    val = proto.Message.AppStateSyncKeyData.fromObject(val);
                  }
                  result[id] = val;
                }
              })
            );
            return result;
          },
          set: async (data) => {
            const tasks = [];
            for (const [type, entries] of Object.entries(data)) {
              for (const [id, value] of Object.entries(entries)) {
                tasks.push(
                  value ? write(`${type}-${id}`, value) : del(`${type}-${id}`)
                );
              }
            }
            await Promise.all(tasks);
          }
        },
        P({ level: "warn" })
      )
    },
    saveCreds: () => write("creds", creds)
  };
}

// ==================== FUNCIONES DE DATOS (SUPABASE) ====================
async function appendCSV (row) {
  const fecha = new Date().toLocaleString("es-MX", {
    timeZone: "America/Mexico_City"
  });
  await supabase.from("historial").insert([
    {
      fecha,
      auto: row.autoName,
      km_actual: row.kmActual,
      km_recorridos: row.kmRecorridos,
      litros: row.litros,
      costo: row.costo,
      lleno: row.lleno,
      rendimiento: row.rendimiento,
      costo_por_km: row.costoPorKm
    }
  ]);
}

async function loadCars () {
  const { data, error } = await supabase
    .from("cars")
    .select("state_json")
    .eq("id", 1)
    .single();

  if (!data || error) {
    const defaults = {
      car1: { name: "Tiida", lastKm: null, baseKm: null, accLiters: 0, accCost: 0, lastOilKm: null, lastTireKm: null, poliza: null },
      car2: { name: "Hyundai", lastKm: null, baseKm: null, accLiters: 0, accCost: 0, lastOilKm: null, lastTireKm: null, poliza: null },
      car3: { name: "Chevy", lastKm: null, baseKm: null, accLiters: 0, accCost: 0, lastOilKm: null, lastTireKm: null, poliza: null }
    };
    await supabase.from("cars").upsert([{ id: 1, state_json: defaults }]);
    return defaults;
  }

  const cars = data.state_json;
  for (const key of ["car1", "car2", "car3"]) {
    if (cars[key] === undefined) cars[key] = {};
    if (cars[key].accLiters === undefined) cars[key].accLiters = 0;
    if (cars[key].accCost === undefined) cars[key].accCost = 0;
    if (cars[key].baseKm === undefined) cars[key].baseKm = null;
    if (cars[key].lastOilKm === undefined) cars[key].lastOilKm = null;
    if (cars[key].lastTireKm === undefined) cars[key].lastTireKm = null;
    if (cars[key].poliza === undefined) cars[key].poliza = null;
  }
  return cars;
}

async function saveCars (cars) {
  await supabase.from("cars").upsert([{ id: 1, state_json: cars }]);
}

// ==================== SESIONES EN MEMORIA ====================
const sessions = {};
function getSession (chatId) {
  if (!sessions[chatId]) sessions[chatId] = { step: "idle" };
  return sessions[chatId];
}
function resetSession (chatId) {
  sessions[chatId] = { step: "idle" };
}

// ==================== UTILIDADES ====================
function parseNumber (text) {
  const n = parseFloat(text.replace(",", ".").trim());
  return isNaN(n) ? null : n;
}

function parseRegistroExpress (textoOriginal) {
  const lower = textoOriginal.toLowerCase();

  let carKey = null;
  if (lower.includes("tiida") || lower.includes("tida") || lower.includes("auto 1")) carKey = "car1";
  else if (lower.includes("hyund") || lower.includes("hunday") || lower.includes("auto 2")) carKey = "car2";
  else if (lower.includes("chevy") || lower.includes("chevi") || lower.includes("auto 3")) carKey = "car3";
  if (!carKey) return null;

  const cleanLower = lower.replace(/(\d)\s+(\d)/g, "$1$2");

  const kmMatch = cleanLower.match(/km\s*[:\-]?\s*(\d+[,]?\d*)/i);
  let km = null;
  if (kmMatch) km = parseInt(kmMatch[1].replace(/,/g, ""));
  if (!km) return null;

  const ltsMatch = cleanLower.match(/(?:lts|litros|lt|l)\s*[:\-]?\s*(\d+[\.,]?\d*)/i);
  let lts = null;
  if (ltsMatch) lts = parseFloat(ltsMatch[1].replace(",", "."));

  let cost = null;
  const costMatch = cleanLower.match(/(?:\$|costo|pesos)\s*[:\-]?\s*(\d+[\.,]?\d*)/);
  if (costMatch) {
    cost = parseFloat(costMatch[1].replace(",", "."));
  } else {
    const numbers = cleanLower.match(/\b\d+[\.,]?\d*\b/g);
    if (numbers && lts && km) {
      for (const str of numbers) {
        const num = parseFloat(str.replace(",", "."));
        if (num > 50 && num < 6000 && Math.abs(num - lts) > 0.01 && Math.abs(num - km) > 0.01) {
          cost = num;
          break;
        }
      }
    }
  }

  return { carKey, km, litros: lts, cost };
}

function carMenu (cars) {
  return (
    `*Bot de Gasolina*\n\n` +
    `¿Cuál auto vas a cargar?\n\n` +
    `1️⃣  ${cars.car1.name}\n` +
    `2️⃣  ${cars.car2.name}\n` +
    `3️⃣  ${cars.car3.name}\n\n` +
    `Responde con *1*, *2* o *3*`
  );
}

function buildAlertas (car, km) {
  let alertas = "";
  if (car.lastOilKm !== null) {
    const oilDiff = km - car.lastOilKm;
    if (oilDiff >= 10000) alertas += `\n*¡ALERTA MANTENIMIENTO!* Aceite Expirado.`;
    else if (oilDiff >= 9000) alertas += `\nAviso: Aceite por expirar.`;
  }
  if (car.lastTireKm !== null) {
    const tireDiff = km - car.lastTireKm;
    if (tireDiff >= 50000) alertas += `\n🛞 *¡ALERTA LLANTAS!* Límite superado, reemplazo sugerido.`;
    else if (tireDiff >= 45000) alertas += `\n🛞 Aviso: Vida útil de llantas por terminar.`;
  }
  if (car.poliza) {
    const match = car.poliza.match(/(?:Fin|Vence):\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
    if (match) {
      const eDate = new Date(parseInt(match[3]), parseInt(match[2]) - 1, parseInt(match[1]));
      const diff = (eDate - new Date()) / (1000 * 60 * 60 * 24);
      if (diff < 0) alertas += `\n*¡SEGURO VENCIDO!*`;
      else if (diff <= 60) alertas += `\n*Seguro Vence* en ${Math.ceil(diff)} días.`;
    }
  }
  return alertas;
}

// ==================== EXTRACTOR DE TEXTO (BAILEYS) ====================
function getMessageText (msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    ""
  );
}

// ==================== BOT PRINCIPAL ====================
let sock;

async function reply (chatId, text, quotedMsg) {
  try {
    await sock.sendMessage(chatId, { text }, quotedMsg ? { quoted: quotedMsg } : undefined);
  } catch (err) {
    if (err.message?.includes("No sessions") || err.name === "SessionError") {
      console.warn(`[reply] No sessions en ${chatId} — forzando metadata y reintentando en 5s...`);
      // Forzar a Baileys a descargar la lista de participantes del grupo
      if (chatId.endsWith("@g.us")) {
        try {
          const meta = await sock.groupMetadata(chatId);
          console.log(`[debug] groupMetadata fetch exitoso. Participantes: ${meta.participants?.length}`);
        } catch (e) {
          console.warn("Fallo groupMetadata:", e.message);
        }
      }
      await new Promise(r => setTimeout(r, 5000));
      await sock.sendMessage(chatId, { text }, quotedMsg ? { quoted: quotedMsg } : undefined);
    } else {
      throw err;
    }
  }
}

async function handleMessage (msg) {
  const chatId = msg.key.remoteJid;
  if (!chatId || chatId === "status@broadcast" || chatId.includes("@newsletter")) return;

  const body = getMessageText(msg).trim();
  if (!body) return;

  // Ignorar las respuestas automáticas del propio bot
  if (msg.key.fromMe) {
    const isBotReply =
      /⛽|❌|✅|📝|✓|━━━━━━━━|🛢️|🚨|⚠️/i.test(body) ||
      body.includes("Bot de Gasolina") ||
      body.includes("¿A qué auto le vas a") ||
      body.includes("Responde con 1, 2 o 3") ||
      body.includes("Seleccionaste") ||
      body.includes("Escribe los datos de la póliza") ||
      body.includes("¿Cuántos *litros* cargaste?") ||
      body.includes("¿Cuánto *pagaste* en total?") ||
      body.includes("¿Llenaste el tanque *completo*?") ||
      body.includes("Póliza guardada para") ||
      body.includes("Pólizas Guardadas") ||
      body.includes("Últimos 5 Registros") ||
      body.includes("Aún no hay cargas registradas") ||
      body.includes("Sistema reiniciado");
    if (isBotReply) return;
  }

  // Botón de pánico
  if (body.toLowerCase() === "/encender" && chatId === GRUPO_PERMITIDO) {
    if (global.isPaused) {
      global.isPaused = false;
      await reply(chatId, "Sistema encendido.", msg);
    }
    return;
  }
  if (global.isPaused) return;
  if (body.toLowerCase() === "/apagar" && chatId === GRUPO_PERMITIDO) {
    global.isPaused = true;
    await reply(chatId, "*SISTEMA APAGADO*\n\nEscribe `/encender` cuando quieras reactivarlo.", msg);
    return;
  }

  // 🔒 Bloquear a los que NO sean del grupo permitido
  if (GRUPO_PERMITIDO && GRUPO_PERMITIDO !== "" && chatId !== GRUPO_PERMITIDO) return;

  if (body && body.length < 200) console.log(`Mensaje en ${chatId}: ${body}`);

  const session = getSession(chatId);
  const cars = await loadCars();

  // ---- PROCESADOR EXPRESS INTELIGENTE ----
  if (session.step === "idle" && !body.startsWith("/")) {
    const expressData = parseRegistroExpress(body);
    if (expressData) {
      const car = cars[expressData.carKey];
      if (expressData.km <= 0 || (car.lastKm !== null && expressData.km <= car.lastKm)) {
        await reply(chatId, `Quise registrar automáticamente pero el km (*${expressData.km}*) es inválido o menor al cargado ayer (*${car.lastKm}*).\nUsa \`/start\` manualmente.`, msg);
        return;
      }
      const alertas = buildAlertas(car, expressData.km);
      sessions[chatId].carKey = expressData.carKey;
      sessions[chatId].currentKm = expressData.km;

      if (!expressData.litros) {
        sessions[chatId].step = "input_liters";
        await reply(chatId, `*Registro Express Detectado*\n Auto: ${car.name}\nKM: ${expressData.km.toLocaleString("es-MX")}${alertas}\n\n¿Cuántos *litros* cargaste?`, msg);
        return;
      }
      sessions[chatId].liters = expressData.litros;
      if (!expressData.cost) {
        sessions[chatId].step = "input_cost";
        await reply(chatId, `*Registro Express: ${car.name}*\nKM: ${expressData.km.toLocaleString("es-MX")} | Lts: ${expressData.litros}${alertas}\n\n¿Cuánto *pagaste* en total? (ej. 900)`, msg);
        return;
      }
      sessions[chatId].cost = expressData.cost;
      sessions[chatId].step = "confirm_full";
      await reply(chatId, `*Registro Multi-Dato Exitoso* ⚡\n\nAuto: ${car.name}\nKM: ${expressData.km.toLocaleString("es-MX")}\nLitros: ${expressData.litros} L\nCosto: $${expressData.cost}\n${alertas}\n\n¿Llenaste el tanque *completo*?\nResponde *si* o *no*`, msg);
      return;
    }
  }

  // ---- COMANDOS ----
  if (body.toLowerCase().startsWith("/start")) {
    resetSession(chatId);
    const args = body.split(" ");
    if (args.length > 1 && ["1", "2", "3"].includes(args[1])) {
      const carKey = "car" + args[1];
      sessions[chatId].carKey = carKey;
      sessions[chatId].step = "input_km";
      const car = cars[carKey];
      const pendingInfo = car.accLiters > 0 ? `\n_(Acumulado sin rendimiento: *${car.accLiters.toFixed(2)} L*)_` : "";
      const lastInfo = car.lastKm !== null ? `\n_(Último odómetro: *${car.lastKm.toLocaleString("es-MX")} km*)_` : `\n_(Sin registro previo)_`;
      await reply(chatId, `${car.name} seleccionado ✓${lastInfo}${pendingInfo}\n\n¿Cuál es el *kilometraje actual*?\n(ej. 45320)`, msg);
      return;
    }
    sessions[chatId].step = "select_car";
    await reply(chatId, carMenu(cars), msg);
    return;
  }

  if (body.toLowerCase().startsWith("/aceite")) {
    resetSession(chatId);
    const args = body.split(" ");
    if (args.length > 1 && ["1", "2", "3"].includes(args[1])) {
      const carKey = "car" + args[1];
      sessions[chatId].carKey = carKey;
      sessions[chatId].step = "input_oil_km";
      await reply(chatId, `Seleccionaste ${cars[carKey].name}\n\nEscribe el *kilometraje* actual en el que se acaba de hacer el cambio de aceite:\n(ej. 52000)`, msg);
      return;
    }
    sessions[chatId].step = "select_car_oil";
    await reply(chatId, `*Cambio de Aceite*\n\n¿A cuál auto le cambiaste el aceite?\n\n1️⃣  ${cars.car1.name}\n2️⃣  ${cars.car2.name}\n3️⃣  ${cars.car3.name}\n\nResponde con *1*, *2* o *3*`, msg);
    return;
  }

  if (body.toLowerCase().startsWith("/llantas")) {
    resetSession(chatId);
    const args = body.split(" ");
    if (args.length > 1 && ["1", "2", "3"].includes(args[1])) {
      const carKey = "car" + args[1];
      sessions[chatId].carKey = carKey;
      sessions[chatId].step = "input_tire_km";
      await reply(chatId, `Seleccionaste ${cars[carKey].name}\n\nEscribe el *kilometraje* de la instalación de tus llantas nuevas:\n(ej. 45000)`, msg);
      return;
    }
    sessions[chatId].step = "select_car_tire";
    await reply(chatId, `*Cambio de Llantas*\n\n¿A cuál auto se le pusieron llantas nuevas?\n\n1️⃣  ${cars.car1.name}\n2️⃣  ${cars.car2.name}\n3️⃣  ${cars.car3.name}\n\nResponde con *1*, *2* o *3*`, msg);
    return;
  }

  if (body.toLowerCase().startsWith("/poliza")) {
    resetSession(chatId);
    const args = body.split(" ");
    if (args.length > 1 && ["1", "2", "3"].includes(args[1])) {
      const carKey = "car" + args[1];
      sessions[chatId].carKey = carKey;
      sessions[chatId].step = "input_poliza";
      await reply(chatId, `Seleccionaste ${cars[carKey].name}\n\nEscribe los datos de la póliza:\n(Ejemplo: GNP Poliza 12345 - Vence 15 Octubre)`, msg);
      return;
    }
    sessions[chatId].step = "select_car_poliza";
    await reply(chatId, `*Registrar Póliza de Seguro*\n\n¿A qué auto le vas a registrar el seguro?\n\n1️⃣  ${cars.car1.name}\n2️⃣  ${cars.car2.name}\n3️⃣  ${cars.car3.name}\n\nResponde con 1, 2 o 3`, msg);
    return;
  }

  if (body.toLowerCase() === "/seguros") {
    resetSession(chatId);
    let text = `*Pólizas Guardadas*\n`;
    for (const key of ["car1", "car2", "car3"]) {
      const p = cars[key].poliza;
      let extraInfo = "";
      if (p) {
        const match = p.match(/(?:Fin|Vence):\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
        if (match) {
          const expDate = new Date(parseInt(match[3]), parseInt(match[2]) - 1, parseInt(match[1]));
          const daysDiff = (expDate - new Date()) / (1000 * 60 * 60 * 24);
          if (daysDiff < 0) extraInfo = `\n*¡VENCIDO!*`;
          else if (daysDiff <= 60) extraInfo = `\n*Vence en ${Math.ceil(daysDiff)} días*`;
        }
      }
      text += `\n${cars[key].name}:\n${p ? p : "_Sin seguro registrado_"}${extraInfo}\n`;
    }
    if (LINK_CARPETA_SEGUROS && LINK_CARPETA_SEGUROS !== "") {
      text += `\n*Carpeta de Pólizas (PDF):*\n${LINK_CARPETA_SEGUROS}\n`;
    }
    await reply(chatId, text.trim(), msg);
    return;
  }

  if (body.toLowerCase() === "/registro") {
    const { data: logs, error } = await supabase
      .from("historial")
      .select("*")
      .order("id", { ascending: false })
      .limit(5);

    if (error || !logs || logs.length === 0) {
      await reply(chatId, "❌ Aún no hay registros en el historial.", msg);
      return;
    }

    let text = `📋 *Últimos 5 Registros*\n━━━━━━━━━━━━━━\n`;
    for (const row of logs) {
      const fechaLimpia = row.fecha ? row.fecha.split(",")[0] : "";
      const rendText = row.rendimiento
        ? `${parseFloat(row.rendimiento).toFixed(2)} km/L`
        : `_Carga Parcial_`;
      text += `*${fechaLimpia}* — ${row.auto}\n`;
      text += `${parseFloat(row.litros).toFixed(1)} L   💰 $${parseFloat(row.costo).toFixed(2)}\n`;
      text += `Km: ${parseInt(row.km_actual).toLocaleString("es-MX")}   📊 ${rendText}\n`;
      text += `━━━━━━━━━━━━━━\n`;
    }
    await reply(chatId, text.trim(), msg);
    return;
  }

  // ---- MÁQUINA DE ESTADOS ----
  switch (session.step) {
    case "select_car": {
      const carMap = { 1: "car1", 2: "car2", 3: "car3" };
      const carKey = carMap[body];
      if (!carKey) { await reply(chatId, "❌ Responde con *1*, *2* o *3*.", msg); return; }
      session.carKey = carKey;
      session.step = "input_km";
      const car = cars[carKey];
      const pendingInfo = car.accLiters > 0 ? `\n_(Acumulado sin rendimiento: *${car.accLiters.toFixed(2)} L*)_` : "";
      const lastInfo = car.lastKm !== null
        ? `\n_(Último odómetro: *${car.lastKm.toLocaleString("es-MX")} km*)_`
        : `\n_(Sin registro previo — este será el punto de partida)_`;
      await reply(chatId, `${car.name} seleccionado ✓${lastInfo}${pendingInfo}\n\n¿Cuál es el *kilometraje actual*?\n(ej. 45320)`, msg);
      break;
    }

    case "input_km": {
      const km = parseNumber(body);
      if (km === null || km <= 0) { await reply(chatId, "❌ Número inválido. (ej. 45320)", msg); return; }
      const car = cars[session.carKey];

      if (car.lastKm === null) {
        car.lastKm = km;
        await saveCars(cars);
        resetSession(chatId);
        await reply(chatId, `*Kilometraje inicial: ${km.toLocaleString("es-MX")} km*\n\nLa próxima carga, llena el tanque completo para establecer la base`, msg);
        return;
      }
      if (km <= car.lastKm) {
        await reply(chatId, `❌ El km (*${km.toLocaleString("es-MX")}*) debe ser mayor al anterior (*${car.lastKm.toLocaleString("es-MX")}*).`, msg);
        return;
      }
      session.currentKm = km;
      session.step = "input_liters";
      const alertasGenerales = buildAlertas(car, km);
      await reply(chatId, `¿Cuántos *litros* cargaste?\n(ej. 40.5)${alertasGenerales}`, msg);
      break;
    }

    case "input_liters": {
      const liters = parseNumber(body);
      if (liters === null || liters <= 0) { await reply(chatId, "❌ Número inválido. (ej. 40.5)", msg); return; }
      session.liters = liters;
      session.step = "input_cost";
      await reply(chatId, `¿Cuánto *pagaste* en total?\n(ej. 950)`, msg);
      break;
    }

    case "input_cost": {
      const cost = parseNumber(body);
      if (cost === null || cost <= 0) { await reply(chatId, "❌ Monto inválido. (ej. 950)", msg); return; }
      session.cost = cost;
      session.step = "confirm_full";
      await reply(chatId, `¿Llenaste el tanque *completo*?\n\nResponde *si* o *no*`, msg);
      break;
    }

    case "confirm_full": {
      const resp = body.toLowerCase().trim();
      const lleno = resp === "si" || resp === "sí";
      if (resp !== "si" && resp !== "sí" && resp !== "no") {
        await reply(chatId, "❌ Responde *si* o *no*.", msg);
        return;
      }
      const { carKey, currentKm, liters, cost } = session;
      const car = cars[carKey];
      const precioL = cost / liters;
      car.lastKm = currentKm;

      if (!lleno) {
        car.accLiters += liters;
        car.accCost += cost;
        await saveCars(cars);
        await appendCSV({ autoName: car.name, kmActual: currentKm, kmRecorridos: null, litros: liters, costo: cost, lleno: false, rendimiento: null, costoPorKm: null });
        resetSession(chatId);
        await reply(chatId,
          `*Carga parcial registrada*\n\n` +
          `Litros esta carga:  ${liters.toFixed(2)} L\n` +
          `Costo esta carga:   $${cost.toFixed(2)}\n` +
          `Precio/litro:       $${precioL.toFixed(2)}/L\n\n` +
          `*Acumulado desde último lleno:*\n` +
          `   ${car.accLiters.toFixed(2)} L — $${car.accCost.toFixed(2)}\n\n` +
          `⏳ El rendimiento se calculará al llenar el tanque completo.`, msg);
        return;
      }

      const totalLiters = car.accLiters + liters;
      const totalCost = car.accCost + cost;

      if (car.baseKm === null) {
        car.baseKm = currentKm;
        car.accLiters = 0;
        car.accCost = 0;
        await saveCars(cars);
        await appendCSV({ autoName: car.name, kmActual: currentKm, kmRecorridos: null, litros: liters, costo: cost, lleno: true, rendimiento: null, costoPorKm: null });
        resetSession(chatId);
        await reply(chatId, `*Primera base establecida: ${currentKm.toLocaleString("es-MX")} km*\n\n Precio/litro: $${precioL.toFixed(2)}/L\n\nYa podemos calcular rendimiento en la próxima carga completa`, msg);
        return;
      }

      const kmRecorridos = currentKm - car.baseKm;
      const rendimiento = kmRecorridos / totalLiters;
      const costoPorKm = totalCost / kmRecorridos;
      const totalPrecioL = totalCost / totalLiters;
      const bar = rendimiento >= 14 ? "🟢" : rendimiento >= 11 ? "🟡" : "🔴";

      await appendCSV({ autoName: car.name, kmActual: currentKm, kmRecorridos, litros: totalLiters, costo: totalCost, lleno: true, rendimiento, costoPorKm });

      car.baseKm = currentKm;
      car.accLiters = 0;
      car.accCost = 0;
      await saveCars(cars);
      resetSession(chatId);

      const oilUsado = car.lastOilKm !== null ? currentKm - car.lastOilKm : "N/A";
      const tireUsado = car.lastTireKm !== null ? currentKm - car.lastTireKm : "N/A";
      const infoVerif = { car1: "Placa 4 | Verif: Mar-Abr / Sep-Oct", car2: "Placa 6 | Verif: Feb-Mar / Jul-Ago", car3: "Placa 8 | Verif: Feb-Mar / Ago-Sep" }[carKey] || "";

      await reply(chatId,
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `*Rendimiento*\n` +
        `${car.name}\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Km recorridos:    *${kmRecorridos.toLocaleString("es-MX", { maximumFractionDigits: 1 })} km*\n` +
        `Litros:   *${totalLiters.toFixed(2)} L*\n` +
        `Costo total:      *$${totalCost.toFixed(2)}*\n\n` +
        `${bar} *Rendimiento:  ${rendimiento.toFixed(2)} km/L*\n\n` +
        `Precio prom/litro: $${totalPrecioL.toFixed(2)}/L\n` +
        `Costo por km:      $${costoPorKm.toFixed(2)}/km\n\n` +
        `Nueva base:        ${currentKm.toLocaleString("es-MX")} km\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `*Estado del Vehículo*\n` +
        `Uso Aceite:  ${oilUsado !== "N/A" ? oilUsado.toLocaleString("es-MX") + " km" : "N/A"}\n` +
        `Uso Llantas: ${tireUsado !== "N/A" ? tireUsado.toLocaleString("es-MX") + " km" : "N/A"}\n` +
        `${infoVerif}\n` +
        `━━━━━━━━━━━━━━━━━━━━━`, msg);
      break;
    }

    case "select_car_oil": {
      const carMap = { 1: "car1", 2: "car2", 3: "car3" };
      const carKey = carMap[body];
      if (!carKey) { await reply(chatId, "❌ Responde con *1*, *2* o *3*.", msg); return; }
      session.carKey = carKey;
      session.step = "input_oil_km";
      await reply(chatId, `Seleccionaste ${cars[carKey].name}\n\nEscribe el *kilometraje* actual en el que se acaba de hacer el cambio de aceite:\n(ej. 52000)`, msg);
      break;
    }

    case "input_oil_km": {
      const km = parseNumber(body);
      if (km === null || km <= 0) { await reply(chatId, "❌ Número inválido. (ej. 52000)", msg); return; }
      const car = cars[session.carKey];
      car.lastOilKm = km;
      await saveCars(cars);
      resetSession(chatId);
      const nextOil = km + 10000;
      await reply(chatId, `*¡Aceite renovado a los ${km.toLocaleString("es-MX")} km!*\n\nEl sistema te avisará automáticamente cuando pases de los ${nextOil.toLocaleString("es-MX")} km.`, msg);
      break;
    }

    case "select_car_tire": {
      const carMap = { 1: "car1", 2: "car2", 3: "car3" };
      const carKey = carMap[body];
      if (!carKey) { await reply(chatId, "❌ Responde con *1*, *2* o *3*.", msg); return; }
      session.carKey = carKey;
      session.step = "input_tire_km";
      await reply(chatId, `Seleccionaste ${cars[carKey].name}\n\nEscribe el *kilometraje* del vehículo en el que instalaste las llantas nuevas:\n(ej. 52000)`, msg);
      break;
    }

    case "input_tire_km": {
      const km = parseNumber(body);
      if (km === null || km <= 0) { await reply(chatId, "❌ Número inválido. (ej. 52000)", msg); return; }
      const car = cars[session.carKey];
      car.lastTireKm = km;
      await saveCars(cars);
      resetSession(chatId);
      const nextTires = km + 50000;
      await reply(chatId, `*¡Llantas registradas a los ${km.toLocaleString("es-MX")} km!*\n\nDispararé una alerta cuando logren alcanzar su límite físico de ${nextTires.toLocaleString("es-MX")} km.`, msg);
      break;
    }

    case "select_car_poliza": {
      const carMap = { 1: "car1", 2: "car2", 3: "car3" };
      const carKey = carMap[body];
      if (!carKey) { await reply(chatId, "❌ Responde con 1, 2 o 3.", msg); return; }
      session.carKey = carKey;
      session.step = "input_poliza";
      await reply(chatId, `Seleccionaste ${cars[carKey].name}\n\nEscribe los datos de la póliza:\n(Ejemplo: GNP Poliza 12345 - Vence 15 Octubre)`, msg);
      break;
    }

    case "input_poliza": {
      const car = cars[session.carKey];
      car.poliza = body.trim();
      await saveCars(cars);
      resetSession(chatId);
      await reply(chatId, `Póliza guardada para ${car.name}:\n"${car.poliza}"\n\nPuedes consultarla enviando /seguros`, msg);
      break;
    }

    default:
      break;
  }
}

// ==================== ARRANQUE DEL BOT ====================
async function startBot () {
  try {
    console.log("Cargando auth state desde Supabase...");
    const { state, saveCreds } = await useSupabaseAuthState();
    console.log("Auth state cargado. Obteniendo versión de WhatsApp...");

    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Versión de WA: ${version} (isLatest: ${isLatest})`);

    // Caché de reintentos en memoria (soluciona Invalid PreKey y No sessions)
    // Permite que Baileys le pida al remitente renegociar la sesión si falla al inicio.
    const msgRetryCounterMap = new Map();
    const msgRetryCounterCache = {
      get: (key) => msgRetryCounterMap.get(key),
      set: (key, value) => msgRetryCounterMap.set(key, value)
    };

    sock = makeWASocket({
      auth: state,
      version,
      logger: P({ level: "warn" }),
      printQRInTerminal: false,
      browser: ["Ubuntu", "Chrome", "20.0.04"],
      connectTimeoutMs: 60000,
      // Reintentar peticiones fallidas con un delay para evitar ban temporal
      retryRequestDelayMs: 2000,
      // Requerido para curar sesiones de grupos (No sessions / Invalid PreKey)
      msgRetryCounterCache,
      getMessage: async (key) => {
        // Fallback básico para que Baileys sepa que debe pedir un reintento
        return { conversation: "Buscando mensaje..." };
      }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("\n📱 Escanea este QR con WhatsApp:\n");
        qrcode.generate(qr, { small: true });
        const qrLink = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
        console.log("\n🔗 ¿No se ve bien? COPIA ESTE LINK para verlo en HD:\n");
        console.log(qrLink);
        console.log("");
        // 🚨 La sesión expiró — se necesita escanear el QR manualmente
        await sendTelegramAlert(
          `🚨 *Sesión expirada — acción requerida*\n\n` +
          `El bot necesita que escanees el QR para reconectarse.\n\n` +
          `📷 [Ver QR en alta resolución](${qrLink})\n\n` +
          `Abre ese link desde el celular y escanéalo con WhatsApp.`
        );
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errorMsg = lastDisconnect?.error?.message || "Desconocido";
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`Conexión cerrada. Código: ${statusCode} | Error: ${errorMsg} | Reconectar: ${shouldReconnect}`);

        // Limpiar keepalive si existe
        if (global.keepAliveInterval) {
          clearInterval(global.keepAliveInterval);
          global.keepAliveInterval = null;
        }

        if (shouldReconnect) {
          // Código 440 = connectionReplaced: otra instancia se conectó con las mismas credenciales.
          // Si reconectamos inmediatamente, las dos instancias se "patean" mutuamente en loop.
          // Esperamos 30s para darle tiempo a Render de terminar la instancia antigua.
          if (statusCode === 440) {
            console.log("⚠️ [Conflict 440] Otra instancia activa detectada. Esperando 30s antes de reconectar...");
            setTimeout(() => startBot(), 30000);
            return;
          }

          // Si Render nos mandó SIGTERM (está apagando esta instancia), NO reconectar
          if (global.shuttingDown) {
            console.log("🛑 Apagado en progreso — no se reconecta.");
            return;
          }

          retryCount++;
          // Backoff exponencial sin límite máximo de reintentos:
          // 3s, 6s, 9s... hasta 60s de tope — nunca se rinde
          const delay = Math.min(retryCount * 3000, 60000);
          console.log(`Reconectando (intento #${retryCount}) en ${delay / 1000}s...`);
          // Alertar si lleva varios intentos fallidos seguidos
          if (retryCount === 5) {
            await sendTelegramAlert(
              `⚠️ *Bot con problemas de conexión*\n\n` +
              `Lleva *${retryCount} intentos* fallidos reconectándose a WhatsApp.\n` +
              `Código de error: \`${statusCode}\` — ${errorMsg}\n\n` +
              `Seguirá intentando automáticamente. Si no se recupera en unos minutos, revisa los logs en Render.`
            );
          }
          setTimeout(() => startBot(), delay);
        } else {
          console.log("Sesión cerrada permanentemente (logged out). Borra la tabla baileys_auth en Supabase y reinicia.");
          await sendTelegramAlert(
            `❌ *Sesión cerrada permanentemente*\n\n` +
            `WhatsApp cerró la sesión del bot (logged out).\n\n` +
            `*Pasos para recuperar:*\n` +
            `1. Ve a Supabase → tabla \`baileys_auth\` → borra todas las filas\n` +
            `2. Reinicia el servicio en Render\n` +
            `3. Escanea el QR que aparecerá en los logs`
          );
        }
      }

      if (connection === "open") {
        const wasDown = retryCount > 0;
        retryCount = 0;
        console.log("✅ Bot conectado y listo!\n");
        // Notificar reconexión solo si venía de un fallo (no al arranque inicial)
        if (wasDown) {
          await sendTelegramAlert(`✅ *Bot reconectado exitosamente*\nWhatsApp volvió a conectarse después de varios intentos.`);
        }

        // Período de calentamiento: esperar 10s para que las sesiones E2E se establezcan
        // antes de procesar mensajes. Si alguien escribe durante ese período, se encola.
        global.botReady = false;
        global.messageQueue = [];
        setTimeout(() => {
          global.botReady = true;
          console.log("[Warmup] Sesiones listas. Procesando mensajes encolados:", global.messageQueue.length);
          for (const m of global.messageQueue) {
            handleMessage(m).catch(err => console.error("Error en mensaje encolado:", err.message));
          }
          global.messageQueue = [];
        }, 10000);

        // KeepAlive: actualizar presencia cada 10 min para que WhatsApp
        // no cierre el WebSocket por inactividad (UptimeRobot solo hace HTTP)
        if (global.keepAliveInterval) clearInterval(global.keepAliveInterval);
        global.keepAliveInterval = setInterval(async () => {
          try {
            await sock.sendPresenceUpdate("available");
            console.log("[KeepAlive] Presencia enviada a WhatsApp.");
          } catch (e) {
            console.warn("[KeepAlive] Error al enviar presencia:", e.message);
          }
        }, 10 * 60 * 1000); // cada 10 minutos

        if (GRUPO_PERMITIDO && GRUPO_PERMITIDO !== "") {
          // Esperar 15s para que las sesiones E2E se sincronicen antes de enviar
          // Usamos la función reply() porque tiene manejo automático de "No sessions"
          setTimeout(async () => {
            try {
              await reply(GRUPO_PERMITIDO, "Sistema reiniciado");
              console.log("Mensaje de reinicio enviado al grupo.");
            } catch (e) {
              console.error("No se pudo notificar al grupo:", e.message);
            }
          }, 15000);
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        // Si el bot aún está en calentamiento, encolar el mensaje
        if (!global.botReady) {
          console.log("[Warmup] Mensaje encolado hasta que las sesiones E2E estén listas.");
          global.messageQueue = global.messageQueue || [];
          global.messageQueue.push(m);
          continue;
        }
        try {
          await handleMessage(m);
        } catch (err) {
          // Los errores de sesión Signal son normales tras reconexión post-hibernación;
          // no es necesario actuar, Baileys los renegocia automáticamente.
          if (err.name === "SessionError" || err.message?.includes("No sessions") || err.message?.includes("Bad MAC")) {
            console.warn("[SessionError ignorado - renegociando E2E automaticamente]", err.message);
          } else {
            console.error("Error procesando mensaje:", err.message);
          }
        }
      }
    });

  } catch (err) {
    console.error("❌ Error fatal al iniciar el bot:", err.message);
    retryCount++;
    const delay = Math.min(retryCount * 3000, 60000);
    console.log(`Reintento #${retryCount} en ${delay / 1000}s...`);
    setTimeout(() => startBot(), delay);
  }
}

let retryCount = 0;
console.log("Iniciando bot con Baileys (Sin Chrome, ultra-ligero)...");
// Delay de 15s antes de conectar a WhatsApp para evitar el conflicto 440 en deploys.
// Render tarda ~2-5s en enviar SIGTERM al pod viejo tras declarar este pod "healthy".
// Con 15s de margen el pod viejo ya está muerto cuando este intenta conectar.
console.log("Esperando 15s para que la instancia anterior se cierre (anti-conflicto deploy)...");
setTimeout(() => startBot(), 15000);

// ==================== APAGADO LIMPIO (SIGTERM) ====================
// Render manda SIGTERM a la instancia vieja durante un deploy antes de matarla.
// Si no lo manejamos, la instancia vieja reconecta y pelea con la nueva (loop 440).
async function shutdown (signal) {
  console.log(`\n[${signal}] Apagando instancia limpiamente...`);
  global.shuttingDown = true;
  if (global.keepAliveInterval) {
    clearInterval(global.keepAliveInterval);
    global.keepAliveInterval = null;
  }
  try {
    if (sock) sock.end(); // Cierra el WebSocket de WA sin reconectar
  } catch (_) { }
  setTimeout(() => process.exit(0), 1500); // Salir tras 1.5s por si algo tarda
}

process.on("SIGTERM", () => shutdown("SIGTERM")); // Deploy de Render
process.on("SIGINT", () => shutdown("SIGINT"));  // Ctrl+C local
