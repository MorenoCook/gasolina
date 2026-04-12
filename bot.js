require("dotenv").config();
const {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  Browsers
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

// Proxy opcional (para evadir bloqueo de IPs de Render por WhatsApp)
// Configura en Render: HTTPS_PROXY_URL=http://user:pass@proxy-host:port
let proxyAgent;
if (process.env.HTTPS_PROXY_URL) {
  try {
    const { HttpsProxyAgent } = require("https-proxy-agent");
    proxyAgent = new HttpsProxyAgent(process.env.HTTPS_PROXY_URL);
    console.log(
      `[Proxy] Usando proxy: ${process.env.HTTPS_PROXY_URL.replace(/:.*@/, ":***@")}`
    );
  } catch (e) {
    console.warn(
      "[Proxy] https-proxy-agent no instalado, ignorando proxy:",
      e.message
    );
  }
}

// Logger silencioso para Baileys (evitar spam de logs internos)
const logger = pino({ level: "silent" });

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
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ==================== EXPRESS (UptimeRobot) ====================
const app = express();
app.get("/", (req, res) => res.send("Bot Activo 24/7 (Render + UptimeRobot)"));
app.listen(process.env.PORT || 3000, () =>
  console.log("Servidor Express escuchando (Listo para UptimeRobot)")
);

// ==================== ALERTAS TELEGRAM ====================
async function sendTelegramAlert(message, replyMarkup) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const payload = {
      chat_id: TELEGRAM_CHAT_ID,
      text: `🤖 *GasolinaBot*\n${message}`,
      parse_mode: "Markdown"
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.warn("[Telegram] No se pudo enviar alerta:", e.message);
  }
}

// ==================== AUTH SUPABASE (Backup Asíncrono) ====================
// Para evitar los timeouts del celular (QR check your internet) tenemos que usar
// disco local (useMultiFileAuthState). Supabase servirá solo como respaldo
// en bloque que se descarga al arrancar y se sube periódicamente en segundo plano.

const AUTH_FOLDER = "./.auth_baileys";

async function restoreAuthFromSupabase() {
  try {
    const { data, error } = await supabase
      .from("baileys_auth")
      .select("value")
      .eq("key", "backup_folder")
      .single();
    if (error || !data) return;

    // Limpiar carpeta entera para evitar mezclar sesiones viejas con nuevas
    if (fs.existsSync(AUTH_FOLDER)) {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
    }
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });

    const folderData = data.value; // objeto con los archivos
    // Procesar restauración de llaves de forma paralela y veloz
    await Promise.all(
      Object.keys(folderData).map(async (filename) => {
        const filePath = path.join(AUTH_FOLDER, filename);
        await fs.promises.writeFile(
          filePath,
          JSON.stringify(folderData[filename])
        );
      })
    );
    console.log(
      "[Auth] ✅ Carpeta de sesión restaurada ultrarrápido desde Supabase."
    );
  } catch (e) {
    if (e.code !== "PGRST116") {
      console.warn(
        "[Auth] ⚠️ No se pudo restaurar respaldo de Supabase:",
        e.message
      );
    }
  }
}

async function backupAuthToSupabase() {
  try {
    if (!fs.existsSync(AUTH_FOLDER)) return;
    const files = await fs.promises.readdir(AUTH_FOLDER);
    const folderData = {};
    for (const file of files) {
      if (file.endsWith(".json")) {
        try {
          const filePath = path.join(AUTH_FOLDER, file);
          const content = await fs.promises.readFile(filePath, "utf-8");
          if (content) {
            folderData[file] = JSON.parse(content);
          }
        } catch (err) {
          // Ignorar silenciosamente archivos que se están modificando en este momento
        }
      }
    }
    // Subir de forma rápida
    supabase
      .from("baileys_auth")
      .upsert([{ key: "backup_folder", value: folderData }])
      .then(({ error }) => {
        if (error)
          console.warn("❌ [SupabaseAuth] Error en background:", error.message);
        else
          console.log(
            `[SupabaseAuth] ✅ Respaldo ok (${Object.keys(folderData).length} archivos).`
          );
      });
  } catch (e) {
    console.warn("❌ [SupabaseAuth] Exception subiendo respaldo:", e.message);
  }
}

// ==================== FUNCIONES DE DATOS (SUPABASE) ====================
async function appendCSV(row) {
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

async function loadCars() {
  const { data, error } = await supabase
    .from("cars")
    .select("state_json")
    .eq("id", 1)
    .single();

  if (!data || error) {
    const defaults = {
      car1: {
        name: "Tiida",
        lastKm: null,
        baseKm: null,
        accLiters: 0,
        accCost: 0,
        lastOilKm: null,
        lastTireKm: null,
        poliza: null
      },
      car2: {
        name: "Hyundai",
        lastKm: null,
        baseKm: null,
        accLiters: 0,
        accCost: 0,
        lastOilKm: null,
        lastTireKm: null,
        poliza: null
      },
      car3: {
        name: "Chevy",
        lastKm: null,
        baseKm: null,
        accLiters: 0,
        accCost: 0,
        lastOilKm: null,
        lastTireKm: null,
        poliza: null
      }
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

async function saveCars(cars) {
  await supabase.from("cars").upsert([{ id: 1, state_json: cars }]);
}

// ==================== SESIONES EN MEMORIA ====================
const sessions = {};
function getSession(chatId) {
  if (!sessions[chatId]) sessions[chatId] = { step: "idle" };
  return sessions[chatId];
}
function resetSession(chatId) {
  sessions[chatId] = { step: "idle" };
}

// ==================== UTILIDADES ====================
function parseNumber(text) {
  const n = parseFloat(text.replace(",", ".").trim());
  return isNaN(n) ? null : n;
}

function parseRegistroExpress(textoOriginal) {
  const lower = textoOriginal.toLowerCase();

  let carKey = null;
  if (
    lower.includes("tiida") ||
    lower.includes("tida") ||
    lower.includes("auto 1")
  )
    carKey = "car1";
  else if (
    lower.includes("hyund") ||
    lower.includes("hunday") ||
    lower.includes("auto 2")
  )
    carKey = "car2";
  else if (
    lower.includes("chevy") ||
    lower.includes("chevi") ||
    lower.includes("auto 3")
  )
    carKey = "car3";
  if (!carKey) return null;

  const cleanLower = lower.replace(/(\d)\s+(\d)/g, "$1$2");

  const kmMatch = cleanLower.match(/km\s*[:\-]?\s*(\d+[,]?\d*)/i);
  let km = null;
  if (kmMatch) km = parseInt(kmMatch[1].replace(/,/g, ""));
  if (!km) return null;

  const ltsMatch = cleanLower.match(
    /(?:lts|litros|lt|l)\s*[:\-]?\s*(\d+[\.,]?\d*)/i
  );
  let lts = null;
  if (ltsMatch) lts = parseFloat(ltsMatch[1].replace(",", "."));

  let cost = null;
  const costMatch = cleanLower.match(
    /(?:\$|costo|pesos)\s*[:\-]?\s*(\d+[\.,]?\d*)/
  );
  if (costMatch) {
    cost = parseFloat(costMatch[1].replace(",", "."));
  } else {
    // Busca todas las líneas
    const lines = textoOriginal.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      // Si la linea es solo un numero soltito (ej: "797")
      if (/^\d+[\.,]?\d*$/.test(trimmed)) {
        const num = parseFloat(trimmed.replace(",", "."));
        // si el num parece un costo y no es igual a los km ni a los litros
        if (
          num > 50 &&
          num <= 3000 &&
          Math.abs(num - (lts || 0)) > 0.01 &&
          Math.abs(num - km) > 0.01
        ) {
          cost = num;
          break;
        }
      }
    }

    // Si no funcionó buscando por líneas, buscar cualquier número en el string (fallback original)
    if (!cost) {
      const numbers = cleanLower.match(/\b\d+[\.,]?\d*\b/g);
      if (numbers && lts && km) {
        for (const str of numbers) {
          const num = parseFloat(str.replace(",", "."));
          if (
            num > 50 &&
            num <= 3000 &&
            Math.abs(num - lts) > 0.01 &&
            Math.abs(num - km) > 0.01
          ) {
            cost = num;
            break;
          }
        }
      }
    }
  }

  return { carKey, km, litros: lts, cost };
}

function carMenu(cars) {
  return (
    `*Bot de Gasolina*\n` +
    `¿Cuál auto vas a cargar?\n` +
    `1️⃣  ${cars.car1.name}\n` +
    `2️⃣  ${cars.car2.name}\n` +
    `3️⃣  ${cars.car3.name}\n` +
    `Responde con *1*, *2* o *3*`
  );
}

function buildAlertas(car, km) {
  let alertas = "";
  if (car.lastOilKm !== null) {
    const oilDiff = km - car.lastOilKm;
    if (oilDiff >= 10000)
      alertas += `\n*¡ALERTA MANTENIMIENTO!* Aceite Expirado.`;
    else if (oilDiff >= 9000) alertas += `\nAviso: Aceite por expirar.`;
  }
  if (car.lastTireKm !== null) {
    const tireDiff = km - car.lastTireKm;
    if (tireDiff >= 50000)
      alertas += `\n🛞 *¡ALERTA LLANTAS!* Límite superado, reemplazo sugerido.`;
    else if (tireDiff >= 45000)
      alertas += `\n🛞 Aviso: Vida útil de llantas por terminar.`;
  }
  if (car.poliza) {
    const match = car.poliza.match(
      /(?:Fin|Vence):\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i
    );
    if (match) {
      const eDate = new Date(
        parseInt(match[3]),
        parseInt(match[2]) - 1,
        parseInt(match[1])
      );
      const diff = (eDate - new Date()) / (1000 * 60 * 60 * 24);
      if (diff < 0) alertas += `\n*¡SEGURO VENCIDO!*`;
      else if (diff <= 60)
        alertas += `\n*Seguro Vence* en ${Math.ceil(diff)} días.`;
    }
  }
  return alertas;
}

// ==================== BOT PRINCIPAL (BAILEYS) ====================
let sock;
let retryCount = 0;

// ── Intervalos y timers a nivel de módulo (NO dentro de startBot)
// para que las reconexiones no los dupliquen.
let backupInterval = null;
let backupTimeout = null;
const debouncedBackup = () => {
  if (backupTimeout) clearTimeout(backupTimeout);
  backupTimeout = setTimeout(async () => {
    await backupAuthToSupabase();
  }, 5000);
};

// Flag para evitar solicitar múltiples pairing codes mientras WA procesa el login.
// WhatsApp es lento con IPs de datacenter y startBot() se llama de nuevo antes
// de que termine, lo que genera un segundo código innecesario.
let pairingCodeRequested = false;

// Extrae el texto del mensaje — compatible con versiones viejas de WhatsApp
function getMessageText(message) {
  return (
    message.message?.conversation ||
    message.message?.extendedTextMessage?.text ||
    message.message?.imageMessage?.caption ||
    message.message?.videoMessage?.caption ||
    message.message?.ephemeralMessage?.message?.conversation ||
    message.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
    message.message?.documentWithCaptionMessage?.message?.documentMessage
      ?.caption ||
    ""
  );
}

async function reply(chatId, text, rawMessage) {
  try {
    if (rawMessage) {
      await sock.sendMessage(chatId, { text }, { quoted: rawMessage });
    } else {
      await sock.sendMessage(chatId, { text });
    }
  } catch (err) {
    console.error("Error enviando mensaje:", err.message);
  }
}

async function handleMessage(rawMessage) {
  const chatId = rawMessage.key.remoteJid;
  if (
    !chatId ||
    chatId === "status@broadcast" ||
    chatId.includes("@newsletter")
  )
    return;

  const fromMe = rawMessage.key.fromMe;

  if (
    GRUPO_PERMITIDO &&
    GRUPO_PERMITIDO !== "" &&
    chatId !== GRUPO_PERMITIDO &&
    !fromMe
  ) {
    return;
  }

  let body = getMessageText(rawMessage).trim();
  if (!body) return;

  // Ignorar las respuestas automáticas del propio bot
  if (fromMe) {
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
      await reply(chatId, "Sistema encendido.", rawMessage);
    }
    return;
  }
  if (global.isPaused) return;
  if (body.toLowerCase() === "/apagar" && chatId === GRUPO_PERMITIDO) {
    global.isPaused = true;
    await reply(
      chatId,
      "*SISTEMA APAGADO*\nEscribe `/encender` cuando quieras reactivarlo.",
      rawMessage
    );
    return;
  }

  // 🔒 Bloquear a los que NO sean del grupo permitido
  if (GRUPO_PERMITIDO && GRUPO_PERMITIDO !== "" && chatId !== GRUPO_PERMITIDO)
    return;

  if (body && body.length < 200) console.log(`Mensaje en ${chatId}: ${body}`);

  const session = getSession(chatId);
  const cars = await loadCars();

  // ---- PROCESADOR EXPRESS INTELIGENTE ----
  if (session.step === "idle" && !body.startsWith("/")) {
    const expressData = parseRegistroExpress(body);
    if (expressData) {
      const car = cars[expressData.carKey];
      if (
        expressData.km <= 0 ||
        (car.lastKm !== null && expressData.km <= car.lastKm)
      ) {
        await reply(
          chatId,
          `Quise registrar automáticamente pero el km (*${expressData.km}*) es inválido o menor al cargado ayer (*${car.lastKm}*).\\nUsa \`/start\` manualmente.`,
          rawMessage
        );
        return;
      }
      const alertas = buildAlertas(car, expressData.km);
      sessions[chatId].carKey = expressData.carKey;
      sessions[chatId].currentKm = expressData.km;

      if (!expressData.litros) {
        sessions[chatId].step = "input_liters";
        await reply(
          chatId,
          `*Registro Express Detectado*\n Auto: ${car.name}\nKM: ${expressData.km.toLocaleString("es-MX")}${alertas}\n¿Cuántos *litros* cargaste?`,
          rawMessage
        );
        return;
      }
      sessions[chatId].liters = expressData.litros;
      if (!expressData.cost) {
        sessions[chatId].step = "input_cost";
        await reply(
          chatId,
          `*Registro Express: ${car.name}*\nKM: ${expressData.km.toLocaleString("es-MX")} | Lts: ${expressData.litros}${alertas}\n¿Cuánto *pagaste* en total? (ej. 900)`,
          rawMessage
        );
        return;
      }
      sessions[chatId].cost = expressData.cost;
      sessions[chatId].step = "confirm_full";
      await reply(
        chatId,
        `*Registro Multi-Dato Exitoso* ⚡\nAuto: ${car.name}\nKM: ${expressData.km.toLocaleString("es-MX")}\nLitros: ${expressData.litros} L\nCosto: $${expressData.cost}\n${alertas}\n¿Llenaste el tanque *completo*?\nResponde *si* o *no*`,
        rawMessage
      );
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
      if (args.length > 2) {
        body = args.slice(2).join(" ");
      } else {
        const car = cars[carKey];
        const pendingInfo =
          car.accLiters > 0
            ? `\n_(Acumulado sin rendimiento: *${car.accLiters.toFixed(2)} L*)_`
            : "";
        const lastInfo =
          car.lastKm !== null
            ? `\n_(Último odómetro: *${car.lastKm.toLocaleString("es-MX")} km*)_`
            : `\n_(Sin registro previo)_`;
        await reply(
          chatId,
          `${car.name} seleccionado ✓${lastInfo}${pendingInfo}\n¿Cuál es el *kilometraje actual*?\n(ej. 45320)`,
          rawMessage
        );
        return;
      }
    } else {
      sessions[chatId].step = "select_car";
      await reply(chatId, carMenu(cars), rawMessage);
      return;
    }
  }

  if (body.toLowerCase().startsWith("/aceite")) {
    resetSession(chatId);
    const args = body.split(" ");
    if (args.length > 1 && ["1", "2", "3"].includes(args[1])) {
      const carKey = "car" + args[1];
      sessions[chatId].carKey = carKey;
      sessions[chatId].step = "input_oil_km";
      if (args.length > 2) {
        body = args.slice(2).join(" ");
      } else {
        await reply(
          chatId,
          `Seleccionaste ${cars[carKey].name}\nEscribe el *kilometraje* actual en el que se acaba de hacer el cambio de aceite:\n(ej. 52000)`,
          rawMessage
        );
        return;
      }
    } else {
      sessions[chatId].step = "select_car_oil";
      await reply(
        chatId,
        `*Cambio de Aceite*\n¿A cuál auto le cambiaste el aceite?\n1️⃣  ${cars.car1.name}\n2️⃣  ${cars.car2.name}\n3️⃣  ${cars.car3.name}\nResponde con *1*, *2* o *3*`,
        rawMessage
      );
      return;
    }
  }

  if (body.toLowerCase().startsWith("/llantas")) {
    resetSession(chatId);
    const args = body.split(" ");
    if (args.length > 1 && ["1", "2", "3"].includes(args[1])) {
      const carKey = "car" + args[1];
      sessions[chatId].carKey = carKey;
      sessions[chatId].step = "input_tire_km";
      if (args.length > 2) {
        body = args.slice(2).join(" ");
      } else {
        await reply(
          chatId,
          `Seleccionaste ${cars[carKey].name}\nEscribe el *kilometraje* de la instalación de tus llantas nuevas:\n(ej. 45000)`,
          rawMessage
        );
        return;
      }
    } else {
      sessions[chatId].step = "select_car_tire";
      await reply(
        chatId,
        `*Cambio de Llantas*\n¿A cuál auto se le pusieron llantas nuevas?\n1️⃣  ${cars.car1.name}\n2️⃣  ${cars.car2.name}\n3️⃣  ${cars.car3.name}\nResponde con *1*, *2* o *3*`,
        rawMessage
      );
      return;
    }
  }

  if (body.toLowerCase().startsWith("/poliza")) {
    resetSession(chatId);
    const args = body.split(" ");
    if (args.length > 1 && ["1", "2", "3"].includes(args[1])) {
      const carKey = "car" + args[1];
      sessions[chatId].carKey = carKey;
      sessions[chatId].step = "input_poliza";
      if (args.length > 2) {
        body = args.slice(2).join(" ");
      } else {
        await reply(
          chatId,
          `Seleccionaste ${cars[carKey].name}\nEscribe los datos de la póliza:\n(Ejemplo: GNP Poliza 12345 - Vence 15 Octubre)`,
          rawMessage
        );
        return;
      }
    } else {
      sessions[chatId].step = "select_car_poliza";
      await reply(
        chatId,
        `*Registrar Póliza de Seguro*\n¿A qué auto le vas a registrar el seguro?\n1️⃣  ${cars.car1.name}\n2️⃣  ${cars.car2.name}\n3️⃣  ${cars.car3.name}\nResponde con 1, 2 o 3`,
        rawMessage
      );
      return;
    }
  }

  if (body.toLowerCase() === "/seguros") {
    resetSession(chatId);
    let text = `*Pólizas Guardadas*\n`;
    for (const key of ["car1", "car2", "car3"]) {
      const p = cars[key].poliza;
      let extraInfo = "";
      if (p) {
        const match = p.match(
          /(?:Fin|Vence):\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i
        );
        if (match) {
          const expDate = new Date(
            parseInt(match[3]),
            parseInt(match[2]) - 1,
            parseInt(match[1])
          );
          const daysDiff = (expDate - new Date()) / (1000 * 60 * 60 * 24);
          if (daysDiff < 0) extraInfo = `\n*¡VENCIDO!*`;
          else if (daysDiff <= 60)
            extraInfo = `\n*Vence en ${Math.ceil(daysDiff)} días*`;
        }
      }
      text += `\n${cars[key].name}:\n${p ? p : "_Sin seguro registrado_"}${extraInfo}\n`;
    }
    if (LINK_CARPETA_SEGUROS && LINK_CARPETA_SEGUROS !== "") {
      text += `\n*Carpeta de Pólizas (PDF):*\n${LINK_CARPETA_SEGUROS}\n`;
    }
    await reply(chatId, text.trim(), rawMessage);
    return;
  }

  if (body.toLowerCase() === "/registro") {
    const { data: logs, error } = await supabase
      .from("historial")
      .select("*")
      .order("id", { ascending: false })
      .limit(5);

    if (error || !logs || logs.length === 0) {
      await reply(
        chatId,
        "❌ Aún no hay registros en el historial.",
        rawMessage
      );
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
    await reply(chatId, text.trim(), rawMessage);
    return;
  }

  // ---- MÁQUINA DE ESTADOS ----
  switch (session.step) {
    case "select_car": {
      const carMap = { 1: "car1", 2: "car2", 3: "car3" };
      const carKey = carMap[body];
      if (!carKey) {
        await reply(chatId, "❌ Responde con *1*, *2* o *3*.", rawMessage);
        return;
      }
      session.carKey = carKey;
      session.step = "input_km";
      const car = cars[carKey];
      const pendingInfo =
        car.accLiters > 0
          ? `\n_(Acumulado sin rendimiento: *${car.accLiters.toFixed(2)} L*)_`
          : "";
      const lastInfo =
        car.lastKm !== null
          ? `\n_(Último odómetro: *${car.lastKm.toLocaleString("es-MX")} km*)_`
          : `\n_(Sin registro previo — este será el punto de partida)_`;
      await reply(
        chatId,
        `${car.name} seleccionado ✓${lastInfo}${pendingInfo}\n¿Cuál es el *kilometraje actual*?\n(ej. 45320)`,
        rawMessage
      );
      break;
    }

    case "input_km": {
      const km = parseNumber(body);
      if (km === null || km <= 0) {
        await reply(chatId, "❌ Número inválido. (ej. 45320)", rawMessage);
        return;
      }
      const car = cars[session.carKey];

      if (car.lastKm === null) {
        car.lastKm = km;
        await saveCars(cars);
        resetSession(chatId);
        await reply(
          chatId,
          `*Kilometraje inicial: ${km.toLocaleString("es-MX")} km*\nLa próxima carga, llena el tanque completo para establecer la base`,
          rawMessage
        );
        return;
      }
      if (km <= car.lastKm) {
        await reply(
          chatId,
          `❌ El km (*${km.toLocaleString("es-MX")}*) debe ser mayor al anterior (*${car.lastKm.toLocaleString("es-MX")}*).`,
          rawMessage
        );
        return;
      }
      session.currentKm = km;
      session.step = "input_liters";
      const alertasGenerales = buildAlertas(car, km);
      await reply(
        chatId,
        `¿Cuántos *litros* cargaste?\n(ej. 40.5)${alertasGenerales}`,
        rawMessage
      );
      break;
    }

    case "input_liters": {
      const liters = parseNumber(body);
      if (liters === null || liters <= 0) {
        await reply(chatId, "❌ Número inválido. (ej. 40.5)", rawMessage);
        return;
      }
      session.liters = liters;
      session.step = "input_cost";
      await reply(chatId, `¿Cuánto *pagaste* en total?\n(ej. 950)`, rawMessage);
      break;
    }

    case "input_cost": {
      const cost = parseNumber(body);
      if (cost === null || cost <= 0) {
        await reply(chatId, "❌ Monto inválido. (ej. 950)", rawMessage);
        return;
      }
      session.cost = cost;
      session.step = "confirm_full";
      await reply(
        chatId,
        `¿Llenaste el tanque *completo*?\nResponde *si* o *no*`,
        rawMessage
      );
      break;
    }

    case "confirm_full": {
      const resp = body.toLowerCase().trim();
      const lleno = resp === "si" || resp === "sí";
      if (resp !== "si" && resp !== "sí" && resp !== "no") {
        await reply(chatId, "❌ Responde *si* o *no*.", rawMessage);
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
        await appendCSV({
          autoName: car.name,
          kmActual: currentKm,
          kmRecorridos: null,
          litros: liters,
          costo: cost,
          lleno: false,
          rendimiento: null,
          costoPorKm: null
        });
        resetSession(chatId);
        await reply(
          chatId,
          `*Carga parcial registrada*\n` +
            `Litros esta carga:  ${liters.toFixed(2)} L\n` +
            `Costo esta carga:   $${cost.toFixed(2)}\n` +
            `Precio/litro:       $${precioL.toFixed(2)}/L\n` +
            `*Acumulado desde último lleno:*\n` +
            `   ${car.accLiters.toFixed(2)} L — $${car.accCost.toFixed(2)}\n` +
            `⏳ El rendimiento se calculará al llenar el tanque completo.`,
          rawMessage
        );
        return;
      }

      const totalLiters = car.accLiters + liters;
      const totalCost = car.accCost + cost;

      if (car.baseKm === null) {
        car.baseKm = currentKm;
        car.accLiters = 0;
        car.accCost = 0;
        await saveCars(cars);
        await appendCSV({
          autoName: car.name,
          kmActual: currentKm,
          kmRecorridos: null,
          litros: liters,
          costo: cost,
          lleno: true,
          rendimiento: null,
          costoPorKm: null
        });
        resetSession(chatId);
        await reply(
          chatId,
          `*Primera base establecida: ${currentKm.toLocaleString("es-MX")} km*\n Precio/litro: $${precioL.toFixed(2)}/L\nYa podemos calcular rendimiento en la próxima carga completa`,
          rawMessage
        );
        return;
      }

      const kmRecorridos = currentKm - car.baseKm;
      const rendimiento = kmRecorridos / totalLiters;
      const costoPorKm = totalCost / kmRecorridos;
      const totalPrecioL = totalCost / totalLiters;
      const bar = rendimiento >= 14 ? "🟢" : rendimiento >= 11 ? "🟡" : "🔴";

      await appendCSV({
        autoName: car.name,
        kmActual: currentKm,
        kmRecorridos,
        litros: totalLiters,
        costo: totalCost,
        lleno: true,
        rendimiento,
        costoPorKm
      });

      car.baseKm = currentKm;
      car.accLiters = 0;
      car.accCost = 0;
      await saveCars(cars);
      resetSession(chatId);

      const oilUsado =
        car.lastOilKm !== null ? currentKm - car.lastOilKm : "N/A";
      const tireUsado =
        car.lastTireKm !== null ? currentKm - car.lastTireKm : "N/A";
      const infoVerif =
        {
          car1: "Placa 4 | Verif: Mar-Abr / Sep-Oct",
          car2: "Placa 6 | Verif: Feb-Mar / Jul-Ago",
          car3: "Placa 8 | Verif: Feb-Mar / Ago-Sep"
        }[carKey] || "";

      await reply(
        chatId,
        `━━━━━━━━━━━━━━━━━━━━━\n` +
          `*Rendimiento*\n` +
          `${car.name}\n` +
          `━━━━━━━━━━━━━━━━━━━━━\n` +
          `Km recorridos:    *${kmRecorridos.toLocaleString("es-MX", { maximumFractionDigits: 1 })} km*\n` +
          `Litros:   *${totalLiters.toFixed(2)} L*\n` +
          `Costo total:      *$${totalCost.toFixed(2)}*\n` +
          `${bar} *Rendimiento:  ${rendimiento.toFixed(2)} km/L*\n` +
          `Precio prom/litro: $${totalPrecioL.toFixed(2)}/L\n` +
          `Costo por km:      $${costoPorKm.toFixed(2)}/km\n` +
          `Nueva base:        ${currentKm.toLocaleString("es-MX")} km\n` +
          `━━━━━━━━━━━━━━━━━━━━━\n` +
          `*Estado del Vehículo*\n` +
          `Uso Aceite:  ${oilUsado !== "N/A" ? oilUsado.toLocaleString("es-MX") + " km" : "N/A"}\n` +
          `Uso Llantas: ${tireUsado !== "N/A" ? tireUsado.toLocaleString("es-MX") + " km" : "N/A"}\n` +
          `${infoVerif}\n` +
          `━━━━━━━━━━━━━━━━━━━━━`,
        rawMessage
      );
      break;
    }

    case "select_car_oil": {
      const carMap = { 1: "car1", 2: "car2", 3: "car3" };
      const carKey = carMap[body];
      if (!carKey) {
        await reply(chatId, "❌ Responde con *1*, *2* o *3*.", rawMessage);
        return;
      }
      session.carKey = carKey;
      session.step = "input_oil_km";
      await reply(
        chatId,
        `Seleccionaste ${cars[carKey].name}\nEscribe el *kilometraje* actual en el que se acaba de hacer el cambio de aceite:\n(ej. 52000)`,
        rawMessage
      );
      break;
    }

    case "input_oil_km": {
      const km = parseNumber(body);
      if (km === null || km <= 0) {
        await reply(chatId, "❌ Número inválido. (ej. 52000)", rawMessage);
        return;
      }
      const car = cars[session.carKey];
      car.lastOilKm = km;
      await saveCars(cars);
      resetSession(chatId);
      const nextOil = km + 10000;
      await reply(
        chatId,
        `*¡Aceite renovado a los ${km.toLocaleString("es-MX")} km!*\nEl sistema te avisará automáticamente cuando pases de los ${nextOil.toLocaleString("es-MX")} km.`,
        rawMessage
      );
      break;
    }

    case "select_car_tire": {
      const carMap = { 1: "car1", 2: "car2", 3: "car3" };
      const carKey = carMap[body];
      if (!carKey) {
        await reply(chatId, "❌ Responde con *1*, *2* o *3*.", rawMessage);
        return;
      }
      session.carKey = carKey;
      session.step = "input_tire_km";
      await reply(
        chatId,
        `Seleccionaste ${cars[carKey].name}\nEscribe el *kilometraje* del vehículo en el que instalaste las llantas nuevas:\n(ej. 52000)`,
        rawMessage
      );
      break;
    }

    case "input_tire_km": {
      const km = parseNumber(body);
      if (km === null || km <= 0) {
        await reply(chatId, "❌ Número inválido. (ej. 52000)", rawMessage);
        return;
      }
      const car = cars[session.carKey];
      car.lastTireKm = km;
      await saveCars(cars);
      resetSession(chatId);
      const nextTires = km + 50000;
      await reply(
        chatId,
        `*¡Llantas registradas a los ${km.toLocaleString("es-MX")} km!*\nDispararé una alerta cuando logren alcanzar su límite físico de ${nextTires.toLocaleString("es-MX")} km.`,
        rawMessage
      );
      break;
    }

    case "select_car_poliza": {
      const carMap = { 1: "car1", 2: "car2", 3: "car3" };
      const carKey = carMap[body];
      if (!carKey) {
        await reply(chatId, "❌ Responde con 1, 2 o 3.", rawMessage);
        return;
      }
      session.carKey = carKey;
      session.step = "input_poliza";
      await reply(
        chatId,
        `Seleccionaste ${cars[carKey].name}\nEscribe los datos de la póliza:\n(Ejemplo: GNP Poliza 12345 - Vence 15 Octubre)`,
        rawMessage
      );
      break;
    }

    case "input_poliza": {
      const car = cars[session.carKey];
      car.poliza = body.trim();
      await saveCars(cars);
      resetSession(chatId);
      await reply(
        chatId,
        `Póliza guardada para ${car.name}:\n"${car.poliza}"\nPuedes consultarla enviando /seguros`,
        rawMessage
      );
      break;
    }

    default:
      break;
  }
}

// ==================== ARRANQUE DEL BOT (BAILEYS) ====================
async function startBot() {
  try {
    console.log("Iniciando bot con Baileys (sin Chrome, RAM ultra ligera)...");

    // Obtener versión de WhatsApp — con fallback si hay error de red
    let version;
    try {
      const result = await fetchLatestBaileysVersion();
      version = result.version;
      console.log(`[Baileys] Versión WA: ${version.join(".")}`);
    } catch (e) {
      version = [2, 3000, 1023262840]; // versión de respaldo conocida
      console.warn(
        "[Baileys] No se pudo obtener versión WA, usando fallback:",
        version.join(".")
      );
    }

    // Descargar respaldo desde Supabase antes de iniciar
    await restoreAuthFromSupabase();

    // Usar Auth ultrarrápido local en disco para que no haya timeouts
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    // Cerrar socket viejo en caso de reconexión para no duplicar listeners
    if (sock) {
      try {
        sock.end();
      } catch (e) {}
    }

    // Backup periódico: solo registrar UNA vez aunque startBot se llame varias veces
    if (!backupInterval) {
      backupInterval = setInterval(backupAuthToSupabase, 60 * 1000); // 1 minuto
    }

    // Cache de mensajes recientes para retrasmisión (evita timeouts con WA viejos)
    const msgCache = new Map();

    sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      // Presentarse con MacOS Desktop — suele acelerar el proceso de "Logging in" en Meta
      // Ubuntu/Chrome fingerprint — tiene menos rechazo en IPs de datacenter que macOS Desktop
      browser: Browsers.ubuntu("Chrome"),
      syncFullHistory: false,
      // ⚡ NO disparar queries iniciales (contactos, grupos, presencia).
      // Esto es lo que causa el "Logging in" de 3+ min en IPs de datacenter.
      fireInitQueries: false,
      // No marcar "en línea" al conectar — ahorra otro roundtrip lento
      markOnlineOnConnect: false,
      // Si alguien pide retrasmisión, buscar en cache en lugar de pedir a WA
      // Evita timeouts 408 causados por usuarios con versiones viejas
      getMessage: async (key) => {
        const cached = msgCache.get(`${key.remoteJid}-${key.id}`);
        return cached ?? { conversation: "" };
      },
      // Mantener conexión viva y no desconectar por inactividad
      keepAliveIntervalMs: 25_000,
      retryRequestDelayMs: 250,
      // Timeouts extendidos: WA ralentiza el handshake en IPs de datacenter (Render).
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      // Proxy residencial para evadir bloqueo de IPs de Render (opcional)
      ...(proxyAgent ? { agent: proxyAgent, fetchAgent: proxyAgent } : {})
    });

    // ==================== PAIRING CODE (alternativa al QR) ====================
    // Si WA_PHONE_NUMBER está definido, usar código de texto en vez de QR.
    // El usuario lo ingresa en: WhatsApp → Config → Dispositivos vinculados → Vincular con número.
    const usePairingCode =
      !!process.env.WA_PHONE_NUMBER && !state.creds.registered;
    if (usePairingCode && !pairingCodeRequested) {
      pairingCodeRequested = true; // bloquear para no generar otro en la siguiente reconexión
      // Esperar un tick para que el socket esté listo antes de pedir el código
      setTimeout(async () => {
        // 1s basta para que socket esté listo
        try {
          const phone = process.env.WA_PHONE_NUMBER.replace(/[^0-9]/g, "");
          const code = await sock.requestPairingCode(phone);
          // Formatear como XXXX-XXXX para que sea legible
          const formatted = code.match(/.{1,4}/g)?.join("-") ?? code;
          console.log(`[Auth] 🔑 Código de vinculación: ${formatted}`);
          // Guardar código — se enviará junto con QR HD link cuando llegue
          global.lastPairingCode = formatted;
        } catch (e) {
          pairingCodeRequested = false; // permitir reintento si falló por error
          console.error("[Auth] ❌ Error solicitando pairing code:", e.message);
          await sendTelegramAlert(
            `⚠️ No se pudo obtener Pairing Code: ${e.message}\nRevisa que WA_PHONE_NUMBER sea correcto (solo dígitos, con código de país).`
          );
        }
      }, 1000);
    }

    // Guardar credenciales cuando cambien (persistencia en disco y Supabase)
    sock.ev.on("creds.update", async () => {
      await saveCreds();
      debouncedBackup();
    });

    // Cachear mensajes enviados para retrasmisión
    sock.ev.on("messages.upsert", ({ messages }) => {
      for (const msg of messages) {
        if (!msg.key?.id) continue;
        msgCache.set(`${msg.key.remoteJid}-${msg.key.id}`, msg.message);
        // Limitar cache a 200 mensajes para no crecer infinitamente
        if (msgCache.size > 200) {
          const firstKey = msgCache.keys().next().value;
          msgCache.delete(firstKey);
        }
      }
    });

    // Manejar errores de descifrado (usuarios con WA muy viejo) sin caer
    sock.ev.process((events) => {
      if (events["messages.update"]) {
        for (const update of events["messages.update"]) {
          if (update.update?.messageStubType === 2) {
            console.warn(
              `[Decrypt] No se pudo descifrar mensaje de ${update.key?.remoteJid} — versión WA incompatible (ignorando).`
            );
          }
        }
      }
    });

    // Conexión, QR y reconexión
    sock.ev.on(
      "connection.update",
      async ({ connection, lastDisconnect, qr }) => {
        // Log every state change for diagnostics
        console.log(
          `[Conexión] estado=${connection ?? "(actualizando)"} código=${lastDisconnect?.error?.output?.statusCode ?? "-"}`
        );

        if (qr) {
          console.log("\n📱 Escanea este QR con WhatsApp:\n");
          qrcode.generate(qr, { small: true });
          const qrLink = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
          console.log("\n🔗 COPIA ESTE LINK para verlo en HD:\n");
          console.log(qrLink);
          console.log("");

          if (usePairingCode) {
            // Mandar AMBOS: código de pairing + QR HD link
            const now = Date.now();
            if (!global.lastQrAlert || now - global.lastQrAlert > 30_000) {
              global.lastQrAlert = now;
              const codeText = global.lastPairingCode
                ? `🔑 *Código:* \`${global.lastPairingCode}\`\n⚙️ _Dispositivos vinculados → Vincular con número_\n\n`
                : "";
              await sendTelegramAlert(
                `${codeText}` +
                `📷 *QR alternativo:*\n[Ver QR en alta resolución](${qrLink})\n\n` +
                `_Usa cualquiera de las dos opciones._`,
                {
                  inline_keyboard: [
                    [{ text: "📲 Abrir WhatsApp", url: "https://wa.me/" }]
                  ]
                }
              );
            }
            return;
          }

          // Modo solo QR (sin pairing code)

          // Throttle de 30s: cada QR dura ~20-60s, así el usuario recibe uno fresco
          // sin recibir spam si WA genera varios QRs seguidos al arrancar.
          const now = Date.now();
          if (!global.lastQrAlert || now - global.lastQrAlert > 30_000) {
            global.lastQrAlert = now;
            global.qrAlertCount = (global.qrAlertCount || 0) + 1;
            const aviso =
              global.qrAlertCount >= 3
                ? `\n⚠️ _Este es el QR #${global.qrAlertCount}. Si sigues sin poder conectar, haz redeploy._`
                : "";
            await sendTelegramAlert(
              `🚨 *QR Requerido* (escanea en los próximos 30s)\n📷 [Ver QR en alta resolución](${qrLink})\nWhatsApp → Dispositivos vinculados → Vincular dispositivo.${aviso}`
            );
          }
        }

        if (connection === "close") {
          const statusCode =
            lastDisconnect?.error instanceof Boom
              ? lastDisconnect.error.output.statusCode
              : 0;
          const loggedOut = statusCode === DisconnectReason.loggedOut;

          console.log(
            `Conexión cerrada. Código: ${statusCode}. Logged out: ${loggedOut}`
          );

          if (loggedOut) {
            console.log(
              "❌ Sesión cerrada (Logged Out). Necesitas borrar creds en Supabase y re-escanear QR."
            );
            await sendTelegramAlert(
              `❌ *Sesión desconectada (Logged Out)*\n` +
                `Borra todas las filas de la tabla \`baileys_auth\` en Supabase y haz redeploy para escanear QR de nuevo.`
            );
          } else {
            retryCount++;
            const delay = Math.min(retryCount * 5000, 60000);
            console.log(`Reintento #${retryCount} en ${delay / 1000}s...`);
            setTimeout(() => startBot(), delay);
          }
        }

        if (connection === "open") {
          console.log("✅ Bot conectado y listo!\n");
          if (retryCount > 0) {
            await sendTelegramAlert(
              `✅ *Bot reconectado exitosamente* tras ${retryCount} intento(s).`
            );
          }
          retryCount = 0;
          // Resetear flags de auth para que una futura desconexión pueda pedir código/QR de nuevo
          pairingCodeRequested = false;
          global.qrAlertCount = 0;
          global.lastQrAlert = null;

          if (GRUPO_PERMITIDO && GRUPO_PERMITIDO !== "") {
            setTimeout(async () => {
              try {
                await sock.sendMessage(GRUPO_PERMITIDO, {
                  text: "Sistema reiniciado"
                });
                console.log("Mensaje de reinicio enviado al grupo.");
              } catch (e) {
                console.error("No se pudo notificar al grupo:", e.message);
              }
            }, 5000);
          }
        }
      }
    );

    // Mensajes entrantes
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return; // Solo mensajes nuevos, no historial cargado
      for (const message of messages) {
        if (!message.message) continue;
        try {
          await handleMessage(message);
        } catch (err) {
          console.error("Error procesando mensaje:", err.message);
        }
      }
    });
  } catch (err) {
    console.error("❌ Error fatal al iniciar el bot:", err.message);
    retryCount++;
    const delay = Math.min(retryCount * 5000, 60000);
    console.log(`Reintento #${retryCount} en ${delay / 1000}s...`);
    setTimeout(() => startBot(), delay);
  }
}

// Arrancar inmediato — no hay razón para esperar 5s
startBot();

// ==================== APAGADO LIMPIO (SIGTERM) ====================
async function shutdown(signal) {
  console.log(`\n[${signal}] Apagando instancia y respaldando sesión...`);
  global.shuttingDown = true;
  try {
    await backupAuthToSupabase();
    if (sock) sock.end();
  } catch (_) {}
  setTimeout(() => process.exit(0), 1000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
