require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
// ==================== CHROMIUM PATH DETECTOR ====================
// whatsapp-web.js usa su propio puppeteer-core interno que NO auto-descarga
// Chrome. Solución: pedirle al paquete `puppeteer` (que sí descarga Chrome
// en el postinstall) la ruta exacta de su binario y pasársela al Client.
function findChromiumExecutable () {
  // 1. Variable de entorno manual (máxima prioridad, útil para overrides)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    console.log(`[Chrome] Usando PUPPETEER_EXECUTABLE_PATH: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  // 2. Ruta reportada por el paquete `puppeteer` del proyecto (instalado via postinstall)
  try {
    const puppeteer = require("puppeteer");
    const path = puppeteer.executablePath();
    console.log(`[Chrome] Usando Chrome de puppeteer: ${path}`);
    return path;
  } catch (e) {
    console.warn("[Chrome] No se pudo obtener la ruta de puppeteer:", e.message);
  }
  console.warn("[Chrome] Sin ruta de Chrome. Puede fallar el inicio.");
  return undefined;
}

const CHROMIUM_EXECUTABLE = findChromiumExecutable();

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

// ==================== (AUTH STATE REMOVIDO PARA USAR LOCALAUTH) ====================

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

// ==================== BOT PRINCIPAL ====================
let client;

async function reply (chatId, text, msg) {
  try {
    if (msg) {
      await msg.reply(text);
    } else {
      await client.sendMessage(chatId, text);
    }
  } catch (err) {
    console.error("Error enviando mensaje:", err.message);
  }
}

async function handleMessage (msg) {
  const chatId = msg.from;
  if (!chatId || chatId === "status@broadcast" || chatId.includes("@newsletter")) return;

  if (GRUPO_PERMITIDO && GRUPO_PERMITIDO !== "" && chatId !== GRUPO_PERMITIDO && !msg.fromMe) {
    return;
  }

  const body = msg.body?.trim();
  if (!body) return;

  // Ignorar las respuestas automáticas del propio bot
  if (msg.fromMe) {
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
      if (!carKey) { await msg.reply("❌ Responde con 1, 2 o 3."); return; }
      session.carKey = carKey;
      session.step = "input_poliza";
      await msg.reply(`Seleccionaste ${cars[carKey].name}\n\nEscribe los datos de la póliza:\n(Ejemplo: GNP Poliza 12345 - Vence 15 Octubre)`);
      break;
    }

    case "input_poliza": {
      const car = cars[session.carKey];
      car.poliza = body.trim();
      await saveCars(cars);
      resetSession(chatId);
      await msg.reply(`Póliza guardada para ${car.name}:\n"${car.poliza}"\n\nPuedes consultarla enviando /seguros`);
      break;
    }

    default:
      break;
  }
}

// ==================== ARRANQUE DEL BOT (WHATSAPP-WEB.JS ULTRA LIGERO) ====================
let retryCount = 0;

async function startBot () {
  try {
    console.log("Iniciando bot con whatsapp-web.js (RAM Restringida)...");

    client = new Client({
      authStrategy: new LocalAuth(),
      authTimeoutMs: 120000, // Darle 2 minutos de tolerancia al CPU lento
      qrMaxRetries: 5, // Reintentar el QR si falla la carga
      puppeteer: {
        headless: true,
        executablePath: CHROMIUM_EXECUTABLE, // Binario del sistema (Render/Linux)
        timeout: 120000, // Darle 2 minutos a Chrome para abrir
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--single-process",
          "--disable-gpu",
          "--js-flags=--max-old-space-size=256",
          "--disable-web-security",
          "--disable-features=IsolateOrigins,site-per-process",
          "--disable-site-isolation-trials",
          "--disable-notifications",
          "--disable-background-networking",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-extensions",
          "--disable-features=TranslateUI,BlinkGenPropertyTrees",
          "--disable-ipc-flooding-protection",
          "--mute-audio"
        ]
      }
    });

    client.on("qr", async (qr) => {
      console.log("\n📱 Escanea este QR con WhatsApp:\n");
      qrcode.generate(qr, { small: true });
      const qrLink = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
      console.log("\n🔗 ¿No se ve bien? COPIA ESTE LINK para verlo en HD:\n");
      console.log(qrLink);
      console.log("");
      
      const now = Date.now();
      if (!global.lastQrAlert || now - global.lastQrAlert > 5 * 60 * 1000) {
        global.lastQrAlert = now;
        await sendTelegramAlert(
          `🚨 *Sesión expirada / QR Requerido*\n\n` +
          `El bot necesita escanear el código QR.\n\n` +
          `📷 [Ver QR en alta resolución](${qrLink})\n\n` +
          `Abre ese link desde el celular y escanéalo con WhatsApp.`
        );
      }
    });

    client.on("ready", async () => {
      console.log("✅ Bot conectado y listo!\n");
      if (retryCount > 0) {
        await sendTelegramAlert(`✅ *Bot reconectado exitosamente*\nChrome inició sesión tras previos fallos.`);
      }
      retryCount = 0;

      try {
        const page = await client.pupPage;
        if (page) {
          await page.setRequestInterception(true);
          page.on("request", (req) => {
            const rt = req.resourceType();
            if (["image", "stylesheet", "font", "media"].includes(rt)) {
              req.abort();
            } else {
              req.continue();
            }
          });
          console.log("[Optimize] Bloqueo de multimedia/CSS activado en Chromium.");
        }
      } catch (e) {
        console.log("No se pudo inyectar el bloqueador de red:", e.message);
      }

      if (GRUPO_PERMITIDO && GRUPO_PERMITIDO !== "") {
        setTimeout(async () => {
          try {
            await client.sendMessage(GRUPO_PERMITIDO, "Sistema reiniciado");
            console.log("Mensaje de reinicio enviado al grupo.");
          } catch (e) {
            console.error("No se pudo notificar al grupo:", e.message);
          }
        }, 5000);
      }
    });

    client.on("disconnected", async (reason) => {
      console.log("Sesión cerrada (logged out):", reason);
      await sendTelegramAlert(
        `❌ *Sesión desconectada*\n\n` +
        `Motivo: ${reason}\n\n` +
        `Deberás forzar un Manual Deploy en Render y buscar el nuevo QR en los logs.`
      );
    });

    client.on("message", async (msg) => {
      try {
        await handleMessage(msg);
      } catch (err) {
        console.error("Error procesando mensaje:", err.message);
      }
    });

    client.initialize();

  } catch (err) {
    console.error("❌ Error fatal al iniciar el bot:", err.message);
    retryCount++;
    const delay = Math.min(retryCount * 5000, 60000);
    console.log(`Reintento #${retryCount} en ${delay / 1000}s...`);
    setTimeout(() => startBot(), delay);
  }
}

console.log("Esperando 15s para que la instancia anterior se cierre (anti-conflicto deploy)...");
setTimeout(() => startBot(), 15000);

// ==================== APAGADO LIMPIO (SIGTERM) ====================
async function shutdown (signal) {
  console.log(`\n[${signal}] Apagando instancia limpiamente...`);
  global.shuttingDown = true;
  try {
    if (client) await client.destroy();
  } catch (_) { }
  setTimeout(() => process.exit(0), 1500);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
