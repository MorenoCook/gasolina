require("dotenv").config();
const { Client, RemoteAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");
const { PostgresStore } = require("wwebjs-postgres");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || "TU_SUPABASE_URL";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "TU_SUPABASE_KEY";
const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://pass@host:5432/postgres"; // Usar el connection pooling de Supabase

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const app = express();
app.get("/", (req, res) => res.send("Bot Activo 24/7 (Render + UptimeRobot)"));
app.listen(process.env.PORT || 3000, () =>
  console.log("Servidor Express escuchando (Listo para UptimeRobot)")
);

// Opcional: Librerías para correo
let nodemailer = null;
let QRCodeLib = null;
let transporter = null;

try {
  nodemailer = require("nodemailer");
  QRCodeLib = require("qrcode");
} catch (e) {
  console.log(
    "Aviso: Librerías de correo (nodemailer/qrcode) no instaladas en este entorno. Se desactivarán las alertas por email."
  );
}

// 🔒 [CONFIGURACIÓN DE SEGURIDAD]
// Si quieres que el bot SOLO procese mensajes de un **grupo específico**, pega su ID aquí.
// El ID de un grupo siempre acaba en "@g.us" (ejemplo: "1203630239123456@g.us").
// Para descubrir cuál es tu ID, manda un Hola al grupo y revisa qué número sale en la terminal.
const GRUPO_PERMITIDO = "5214111103705-1532543388@g.us";

// 📁 Link permanente hacia tu carpeta de nube con los PDF de los seguros:
const LINK_CARPETA_SEGUROS =
  "https://drive.google.com/drive/folders/11GbfKwxzQUxYjA4wCQ4joRE15dpep9Xa?usp=sharing";

// 📧 CONFIGURACIÓN DE CORREO PARA RECIBIR EL QR AUTOMÁTICO (Opcional)
// Usa Gmail. En tu cuenta de Google -> Seguridad -> Genera una "Contraseña de aplicación" de 16 letras.
const EMAIL_USER = "boiban200@gmail.com"; // Tu correo: ejemplo@gmail.com
const EMAIL_PASS = "htjl xfkb ubid ybsx"; // Tu contraseña de aplicación: "abcd efgh ijkl mnop"

async function initCSV() {
  console.log("Supabase listo para tablas 'historial' y 'cars'");
}

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
        name: "Tiida 🚗",
        lastKm: null,
        baseKm: null,
        accLiters: 0,
        accCost: 0,
        lastOilKm: null,
        lastTireKm: null,
        poliza: null
      },
      car2: {
        name: "Hyundai 🚙",
        lastKm: null,
        baseKm: null,
        accLiters: 0,
        accCost: 0,
        lastOilKm: null,
        lastTireKm: null,
        poliza: null
      },
      car3: {
        name: "Chevy 🛻",
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

const sessions = {};
function getSession(chatId) {
  if (!sessions[chatId]) sessions[chatId] = { step: "idle" };
  return sessions[chatId];
}
function resetSession(chatId) {
  sessions[chatId] = { step: "idle" };
}

// Inicializa el mensajero de Email
if (nodemailer) {
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
  });
}

function parseNumber(text) {
  const n = parseFloat(text.replace(",", ".").trim());
  return isNaN(n) ? null : n;
}

// ---- NUEVO: Analizador Inteligente de Texto Libre (Registro Express) ----
function parseRegistroExpress(textoOriginal) {
  const lower = textoOriginal.toLowerCase();

  // Buscar Auto
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

  // Normalizar los kilómetros unidos si pasaron "258 849" -> "258849"
  const cleanLower = lower.replace(/(\d)\s+(\d)/g, "$1$2");

  // Extraer KM con Regex
  const kmMatch = cleanLower.match(/km\s*[:\-]?\s*(\d+[,]?\d*)/i);
  let km = null;
  if (kmMatch) km = parseInt(kmMatch[1].replace(/,/g, ""));

  if (!km) return null; // Si no hay KM, no es un registro completo

  // Extraer Litros
  const ltsMatch = cleanLower.match(
    /(?:lts|litros|lt|l)\s*[:\-]?\s*(\d+[\.,]?\d*)/i
  );
  let lts = null;
  if (ltsMatch) lts = parseFloat(ltsMatch[1].replace(",", "."));

  // Extraer Costo usando signo de pesos o buscando número residual si no indicó costo
  let cost = null;
  const costMatch = cleanLower.match(
    /(?:\$|costo|pesos)\s*[:\-]?\s*(\d+[\.,]?\d*)/
  );
  if (costMatch) {
    cost = parseFloat(costMatch[1].replace(",", "."));
  } else {
    // Heurística de número restante suelto equivalente a pesos mexicanos (+-$100 a $5000)
    const numbers = cleanLower.match(/\b\d+[\.,]?\d*\b/g);
    if (numbers && lts && km) {
      for (const str of numbers) {
        const num = parseFloat(str.replace(",", "."));
        if (
          num > 50 &&
          num < 6000 &&
          Math.abs(num - lts) > 0.01 &&
          Math.abs(num - km) > 0.01
        ) {
          cost = num;
          break; // El primero posible
        }
      }
    }
  }

  return { carKey, km, litros: lts, cost };
}

function carMenu(cars) {
  return (
    `*Bot de Gasolina*\n\n` +
    `¿Cuál auto vas a cargar?\n\n` +
    `1️⃣  ${cars.car1.name}\n` +
    `2️⃣  ${cars.car2.name}\n` +
    `3️⃣  ${cars.car3.name}\n\n` +
    `Responde con *1*, *2* o *3*`
  );
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
const store = new PostgresStore({ pool: pool });

const client = new Client({
  authStrategy: new RemoteAuth({ store: store, backupSyncIntervalMs: 300000 }),
  webVersionCache: {
    type: "remote",
    remotePath:
      "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html"
  },
  puppeteer: {
    timeout: 120000,
    protocolTimeout: 120000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-software-rasterizer",
      "--disable-background-networking"
    ]
  }
});

client.on("qr", async (qr) => {
  console.log("\n📱 Escanea este QR con WhatsApp:\n");
  qrcode.generate(qr, { small: true });
  const qrLink = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
  console.log(
    "\n🔗 ¿Se ve mal? HAZ CLIC O COPIA ESTE LINK PARA VERLO EN HD:\n\n",
    qrLink,
    "\n"
  );

  if (EMAIL_USER && EMAIL_PASS && EMAIL_USER !== "") {
    try {
      // Convertir el QR directamente a una imagen base64 embebida de alta calidad (Seguro y offline)
      const qrDataUrl = await QRCodeLib.toDataURL(qr, { margin: 2, scale: 6 });

      transporter
        .sendMail({
          from: EMAIL_USER,
          to: EMAIL_USER,
          subject: "⚠ Bot de WhatsApp: Requiere escanear QR",
          html: `<h3>¡El bot se ha desconectado o reiniciado y necesita autorización!</h3>
               <p>Por favor, escanea este código desde "Dispositivos Vinculados" en WhatsApp para revivirlo.</p>
               <br>
               <img src="${qrDataUrl}" alt="QR Code de WhatsApp" />`
        })
        .catch((err) =>
          console.error("Error al enviar el correo:", err.message)
        );
    } catch (e) {
      console.error("No se pudo regenerar el QR en imagen para correo.", e);
    }
  }
});

// Detectar específicamente cuando la cuenta se desconecta bruscamente
client.on("disconnected", (reason) => {
  console.log("🔴 La sesión se ha cerrado. Razón:", reason);
  if (EMAIL_USER && EMAIL_PASS && EMAIL_USER !== "") {
    transporter
      .sendMail({
        from: EMAIL_USER,
        to: EMAIL_USER,
        subject: "🔴 ¡ALERTA! El Bot fue desconectado",
        text: `WhatsApp ha revocado la sesión del bot.\nMotivo interno: ${reason}\n\nEn menos de 2 minutos deberías recibir un nuevo correo con el código QR para escanear y revivirlo.`
      })
      .catch((err) => console.error("Error enviando alerta:", err));
  }
});

client.on("ready", async () => {
  initCSV();
  console.log("✅ Bot conectado y listo!\n");

  if (GRUPO_PERMITIDO && GRUPO_PERMITIDO !== "") {
    // Retrasar el envío 5 segundos para darle tiempo a puppeteer de descargar los chats
    setTimeout(async () => {
      try {
        await client.sendMessage(GRUPO_PERMITIDO, "Sistema reiniciado");
        console.log("Mensaje de reinicio emitido al grupo correctamente.");
      } catch (error) {
        console.error("No se pudo notificar el reinicio al grupo:", error);
      }
    }, 5000);
  }
});

client.on("message_create", async (msg) => {
  // Ignorar estados y canales (newsletters)
  if (msg.from === "status@broadcast") return;
  if (msg.from.includes("@newsletter") || msg.to.includes("@newsletter"))
    return;

  // Evitar que el bot se responda a sí mismo al leer su propio texto
  if (msg.fromMe) {
    const isBotReply =
      /⛽|❌|✅|📝|✓|━━━━━━━━|🛢️|🚨|⚠️/i.test(msg.body) ||
      msg.body.includes("Bot de Gasolina") ||
      msg.body.includes("¿A qué auto le vas a") ||
      msg.body.includes("Responde con 1, 2 o 3") ||
      msg.body.includes("Seleccionaste") ||
      msg.body.includes("Escribe los datos de la póliza") ||
      msg.body.includes("¿Cuántos *litros* cargaste?") ||
      msg.body.includes("¿Cuánto *pagaste* en total?") ||
      msg.body.includes("¿Llenaste el tanque *completo*?") ||
      msg.body.includes("Póliza guardada para") ||
      msg.body.includes("Pólizas Guardadas") ||
      msg.body.includes("Últimos 5 Registros") ||
      msg.body.includes("Aún no hay cargas registradas") ||
      msg.body.includes("Sistema reiniciado");

    if (isBotReply) return;
  }

  const chatId = msg.fromMe ? msg.to : msg.from;
  const body = msg.body ? msg.body.trim() : "";

  // 🔒 Botón rojo de pánico remoto (Anti-Bucles)
  if (body.toLowerCase() === "/encender" && chatId === GRUPO_PERMITIDO) {
    if (global.isPaused) {
      global.isPaused = false;
      await msg.reply("Sistema encendido.");
    }
    return;
  }

  // Si alguien tiró el switch de pánico, el bot ignorará absolutamente todo
  if (global.isPaused) return;

  if (body.toLowerCase() === "/apagar" && chatId === GRUPO_PERMITIDO) {
    global.isPaused = true;
    await msg.reply(
      "*SISTEMA APAGADO*\n\nEscribe `/encender` cuando quieras reactivarlo."
    );
    return;
  }

  // 🔒 Bloquear a todos los que NO sean de tu grupo permitido
  if (GRUPO_PERMITIDO && GRUPO_PERMITIDO !== "" && chatId !== GRUPO_PERMITIDO) {
    return;
  }

  // Solo imprimir en consola si es un mensaje de ti o de un grupo (ignorar si es muy largo)
  if (body && body.length < 200) {
    console.log(`Mensaje recibido en ${chatId}: ${body}`);
  }

  const session = getSession(chatId);
  const cars = await loadCars();

  // ---- PROCESADOR EXPRESS INTELIGENTE ----
  // Se evalúa SIEMPRE cuando el bot está inactivo, para absorber bloques de datos en texto crudo
  if (session.step === "idle" && !body.startsWith("/")) {
    const expressData = parseRegistroExpress(body);
    if (expressData) {
      const car = cars[expressData.carKey];

      // Prevenir errores de lectura o odómetros mal tecleados
      if (
        expressData.km <= 0 ||
        (car.lastKm !== null && expressData.km <= car.lastKm)
      ) {
        await msg.reply(
          `Quise registrar esto automáticamente pero el km (*${expressData.km}*) es inválido o menor al cargado ayer (*${car.lastKm}*).\nUsa \`/start\` manualmente.`
        );
        return;
      }

      // Armamos alertas invisibles por si toca el aceite o seguro
      let alertas = "";
      if (car.lastOilKm !== null) {
        const oilDiff = expressData.km - car.lastOilKm;
        if (oilDiff >= 10000)
          alertas += `\n*¡ALERTA MANTENIMIENTO!* Aceite Expirado.`;
        else if (oilDiff >= 9000) alertas += `\nAviso: Aceite por expirar.`;
      }
      if (car.lastTireKm !== null) {
        const tireDiff = expressData.km - car.lastTireKm;
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

      sessions[chatId].carKey = expressData.carKey;
      sessions[chatId].currentKm = expressData.km;

      // Si faltan los listros, saltamos al paso 2 directamente
      if (!expressData.litros) {
        sessions[chatId].step = "input_liters";
        await msg.reply(
          `*Registro Express Detectado*\n Auto: ${car.name}\nKM: ${expressData.km.toLocaleString("es-MX")}${alertas}\n\n¿Cuántos *litros* cargaste?`
        );
        return;
      }

      sessions[chatId].liters = expressData.litros;

      // Si faltó el costo (dinero), calculamos hasta el paso 3
      if (!expressData.cost) {
        sessions[chatId].step = "input_cost";
        await msg.reply(
          `*Registro Express: ${car.name}*\nKM: ${expressData.km.toLocaleString("es-MX")} | Lts: ${expressData.litros}${alertas}\n\n¿Cuánto *pagaste* en total? (ej. 900)`
        );
        return;
      }

      sessions[chatId].cost = expressData.cost;
      sessions[chatId].step = "confirm_full";
      await msg.reply(
        `*Registro Multi-Dato Exitoso* ⚡\n\nAuto: ${car.name}\nKM: ${expressData.km.toLocaleString("es-MX")}\nLitros: ${expressData.litros} L\nCosto: $${expressData.cost}\n${alertas}\n\n¿Llenaste el tanque *completo*?\nResponde *si* o *no*`
      );
      return;
    }
  }

  if (body.toLowerCase().startsWith("/start")) {
    resetSession(chatId);
    const args = body.split(" ");

    // Atajo acelerado: /start 1
    if (args.length > 1 && ["1", "2", "3"].includes(args[1])) {
      const carKey = "car" + args[1];
      sessions[chatId].carKey = carKey;
      sessions[chatId].step = "input_km";
      const car = cars[carKey];
      const pendingInfo =
        car.accLiters > 0
          ? `\n_(Acumulado sin rendimiento: *${car.accLiters.toFixed(2)} L*)_`
          : "";
      const lastInfo =
        car.lastKm !== null
          ? `\n_(Último odómetro: *${car.lastKm.toLocaleString("es-MX")} km*)_`
          : `\n_(Sin registro previo)_`;
      await msg.reply(
        `${car.name} seleccionado ✓${lastInfo}${pendingInfo}\n\n¿Cuál es el *kilometraje actual*?\n(ej. 45320)`
      );
      return;
    }

    // Ruta clásica
    sessions[chatId].step = "select_car";
    await msg.reply(carMenu(cars));
    return;
  }

  if (body.toLowerCase().startsWith("/aceite")) {
    resetSession(chatId);
    const args = body.split(" ");

    // Atajo acelerado: /aceite 1
    if (args.length > 1 && ["1", "2", "3"].includes(args[1])) {
      const carKey = "car" + args[1];
      sessions[chatId].carKey = carKey;
      sessions[chatId].step = "input_oil_km";
      await msg.reply(
        `Seleccionaste ${cars[carKey].name}\n\nEscribe el *kilometraje* actual en el que se acaba de hacer el cambio de aceite:\n(ej. 52000)`
      );
      return;
    }

    // Ruta clásica
    sessions[chatId].step = "select_car_oil";
    await msg.reply(
      `*Cambio de Aceite*\n\n¿A cuál auto le cambiaste el aceite?\n\n1️⃣  ${cars.car1.name}\n2️⃣  ${cars.car2.name}\n3️⃣  ${cars.car3.name}\n\nResponde con *1*, *2* o *3*`
    );
    return;
  }

  if (body.toLowerCase().startsWith("/llantas")) {
    resetSession(chatId);
    const args = body.split(" ");

    // Atajo acelerado: /llantas 1
    if (args.length > 1 && ["1", "2", "3"].includes(args[1])) {
      const carKey = "car" + args[1];
      sessions[chatId].carKey = carKey;
      sessions[chatId].step = "input_tire_km";
      await msg.reply(
        `Seleccionaste ${cars[carKey].name}\n\nEscribe el *kilometraje* de la instalación de tus llantas nuevas:\n(ej. 45000)`
      );
      return;
    }

    // Ruta clásica
    sessions[chatId].step = "select_car_tire";
    await msg.reply(
      `*Cambio de Llantas*\n\n¿A cuál auto se le pusieron llantas nuevas?\n\n1️⃣  ${cars.car1.name}\n2️⃣  ${cars.car2.name}\n3️⃣  ${cars.car3.name}\n\nResponde con *1*, *2* o *3*`
    );
    return;
  }

  if (body.toLowerCase().startsWith("/poliza")) {
    resetSession(chatId);
    const args = body.split(" ");

    // Atajo acelerado: /poliza 1
    if (args.length > 1 && ["1", "2", "3"].includes(args[1])) {
      const carKey = "car" + args[1];
      sessions[chatId].carKey = carKey;
      sessions[chatId].step = "input_poliza";
      await msg.reply(
        `Seleccionaste ${cars[carKey].name}\n\nEscribe los datos de la póliza:\n(Ejemplo: GNP Poliza 12345 - Vence 15 Octubre)`
      );
      return;
    }

    // Ruta clásica
    sessions[chatId].step = "select_car_poliza";
    await msg.reply(
      `*Registrar Póliza de Seguro*\n\n¿A qué auto le vas a registrar el seguro?\n\n1️⃣  ${cars.car1.name}\n2️⃣  ${cars.car2.name}\n3️⃣  ${cars.car3.name}\n\nResponde con 1, 2 o 3`
    );
    return;
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

    await msg.reply(text.trim());
    return;
  }

  if (body.toLowerCase() === "/registro") {
    const { data: logs, error } = await supabase
      .from("historial")
      .select("*")
      .order("id", { ascending: false })
      .limit(5);

    if (error || !logs || logs.length === 0) {
      await msg.reply("❌ Aún no hay registros en el historial de Supabase.");
      return;
    }

    let text = `📋 *Últimos 5 Registros*\n━━━━━━━━━━━━━━\n`;
    for (const row of logs) {
      // row.fecha viene como string tipo "dd/mm/yyyy hh:mm:ss" o el timestamp
      const fechaLimpia = row.fecha ? row.fecha.split(",")[0] : "";

      const rendText = row.rendimiento
        ? `${parseFloat(row.rendimiento).toFixed(2)} km/L`
        : `_Carga Parcial_`;

      text += `*${fechaLimpia}* — ${row.auto}\n`;
      text += `${parseFloat(row.litros).toFixed(1)} L   💰 ${parseFloat(row.costo).toFixed(2)}\n`;
      text += `Km: ${parseInt(row.km_actual).toLocaleString("es-MX")}   📊 ${rendText}\n`;
      text += `━━━━━━━━━━━━━━\n`;
    }

    await msg.reply(text.trim());
    return;
  }

  switch (session.step) {
    case "select_car": {
      const carMap = { 1: "car1", 2: "car2", 3: "car3" };
      const carKey = carMap[body];
      if (!carKey) {
        await msg.reply("❌ Responde con *1*, *2* o *3*.");
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

      await msg.reply(
        `${car.name} seleccionado ✓${lastInfo}${pendingInfo}\n\n¿Cuál es el *kilometraje actual*?\n(ej. 45320)`
      );
      break;
    }

    case "input_km": {
      const km = parseNumber(body);
      if (km === null || km <= 0) {
        await msg.reply("❌ Número inválido. (ej. 45320)");
        return;
      }

      const car = cars[session.carKey];

      if (car.lastKm === null) {
        car.lastKm = km;
        await saveCars(cars);
        resetSession(chatId);
        await msg.reply(
          `*Kilometraje inicial: ${km.toLocaleString("es-MX")} km*\n\nLa próxima carga, llena el tanque completo para establecer la base`
        );
        return;
      }

      if (km <= car.lastKm) {
        await msg.reply(
          `❌ El km (*${km.toLocaleString("es-MX")}*) debe ser mayor al anterior (*${car.lastKm.toLocaleString("es-MX")}*).\n\nIngresa el valor correcto:`
        );
        return;
      }

      session.currentKm = km;
      session.step = "input_liters";

      let alertasGenerales = "";

      // Alerta de aceite
      if (car.lastOilKm !== null) {
        const oilDiff = km - car.lastOilKm;
        if (oilDiff >= 10000) {
          alertasGenerales += `\n\n*¡ALERTA DE ACEITE!*\nLlevas ${oilDiff.toLocaleString("es-MX")} km de uso desde el último cambio.`;
        } else if (oilDiff >= 9000) {
          alertasGenerales += `\n\n*Aviso de Aceite:* Cambio próximo (${oilDiff.toLocaleString("es-MX")}/10,000 km).`;
        }
      }

      // Alerta de llantas
      if (car.lastTireKm !== null) {
        const tireDiff = km - car.lastTireKm;
        if (tireDiff >= 50000) {
          alertasGenerales += `\n\n*¡ALERTA DE LLANTAS!*\nLímite superado, llevas ${tireDiff.toLocaleString("es-MX")} km en tus llantas desde el cambio.`;
        } else if (tireDiff >= 45000) {
          alertasGenerales += `\n\n*Aviso de Llantas:* Vida útil cercana a expirar (${tireDiff.toLocaleString("es-MX")}/50,000 km).`;
        }
      }

      // Alerta de seguro (Extrae la fecha en formato Fin: DD/MM/YYYY)
      if (car.poliza) {
        const match = car.poliza.match(
          /(?:Fin|Vence):\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i
        );
        if (match) {
          const expDate = new Date(
            parseInt(match[3]),
            parseInt(match[2]) - 1,
            parseInt(match[1])
          );
          const daysDiff = (expDate - new Date()) / (1000 * 60 * 60 * 24);
          if (daysDiff < 0) {
            alertasGenerales += `\n\n*¡SEGURO VENCIDO!* (Expiró el ${match[1]}/${match[2]}/${match[3]})`;
          } else if (daysDiff <= 60) {
            alertasGenerales += `\n\n*SEGURO POR VENCER:* Vence el ${match[1]}/${match[2]}/${match[3]} (faltan ${Math.ceil(daysDiff)} días).`;
          }
        }
      }

      await msg.reply(
        `¿Cuántos *litros* cargaste?\n(ej. 40.5)${alertasGenerales}`
      );
      break;
    }

    case "input_liters": {
      const liters = parseNumber(body);
      if (liters === null || liters <= 0) {
        await msg.reply("❌ Número inválido. (ej. 40.5)");
        return;
      }
      session.liters = liters;
      session.step = "input_cost";
      await msg.reply(`¿Cuánto *pagaste* en total?\n(ej. 950)`);
      break;
    }

    case "input_cost": {
      const cost = parseNumber(body);
      if (cost === null || cost <= 0) {
        await msg.reply("❌ Monto inválido. (ej. 950)");
        return;
      }
      session.cost = cost;
      session.step = "confirm_full";
      await msg.reply(
        `¿Llenaste el tanque *completo*?\n\nResponde *si* o *no*`
      );
      break;
    }

    case "confirm_full": {
      const resp = body.toLowerCase().trim();
      const lleno = resp === "si" || resp === "sí";
      if (resp !== "si" && resp !== "sí" && resp !== "no") {
        await msg.reply("❌ Responde *si* o *no*.");
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
        await msg.reply(
          `*Carga parcial registrada*\n\n` +
            `Litros esta carga:  ${liters.toFixed(2)} L\n` +
            `Costo esta carga:   $${cost.toFixed(2)}\n` +
            `Precio/litro:       $${precioL.toFixed(2)}/L\n\n` +
            `*Acumulado desde último lleno:*\n` +
            `   ${car.accLiters.toFixed(2)} L — $${car.accCost.toFixed(2)}\n\n` +
            `⏳ El rendimiento se calculará al llenar el tanque completo.`
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
        await msg.reply(
          `*Primera base establecida: ${currentKm.toLocaleString("es-MX")} km*\n\n Precio/litro: $${precioL.toFixed(2)}/L\n\nYa podemos calcular rendimiento en la próxima carga completa`
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

      await msg.reply(
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
          `━━━━━━━━━━━━━━━━━━━━━`
      );
      break;
    }

    case "select_car_oil": {
      const carMap = { 1: "car1", 2: "car2", 3: "car3" };
      const carKey = carMap[body];
      if (!carKey) {
        await msg.reply("❌ Responde con *1*, *2* o *3*.");
        return;
      }
      session.carKey = carKey;
      session.step = "input_oil_km";
      await msg.reply(
        `Seleccionaste ${cars[carKey].name}\n\nEscribe el *kilometraje* actual en el que se acaba de hacer el cambio de aceite:\n(ej. 52000)`
      );
      break;
    }

    case "input_oil_km": {
      const km = parseNumber(body);
      if (km === null || km <= 0) {
        await msg.reply("❌ Número inválido. (ej. 52000)");
        return;
      }
      const car = cars[session.carKey];
      car.lastOilKm = km;
      await saveCars(cars);
      resetSession(chatId);
      const nextOil = km + 10000;
      await msg.reply(
        `*¡Aceite renovado a los ${km.toLocaleString("es-MX")} km!*\n\nEl sistema te avisará automáticamente cuando pases de los ${nextOil.toLocaleString("es-MX")} km.`
      );
      break;
    }

    case "select_car_tire": {
      const carMap = { 1: "car1", 2: "car2", 3: "car3" };
      const carKey = carMap[body];
      if (!carKey) {
        await msg.reply("❌ Responde con *1*, *2* o *3*.");
        return;
      }
      session.carKey = carKey;
      session.step = "input_tire_km";
      await msg.reply(
        `Seleccionaste ${cars[carKey].name}\n\nEscribe el *kilometraje* del vehículo en el que instalaste las llantas nuevas:\n(ej. 52000)`
      );
      break;
    }

    case "input_tire_km": {
      const km = parseNumber(body);
      if (km === null || km <= 0) {
        await msg.reply("❌ Número inválido. (ej. 52000)");
        return;
      }
      const car = cars[session.carKey];
      car.lastTireKm = km;
      await saveCars(cars);
      resetSession(chatId);
      const nextTires = km + 50000;
      await msg.reply(
        `*¡Llantas registradas a los ${km.toLocaleString("es-MX")} km!*\n\ndispararé una alerta cuando logren alcanzar su límite físico de ${nextTires.toLocaleString("es-MX")} km.`
      );
      break;
    }

    case "select_car_poliza": {
      const carMap = { 1: "car1", 2: "car2", 3: "car3" };
      const carKey = carMap[body];
      if (!carKey) {
        await msg.reply("❌ Responde con 1, 2 o 3.");
        return;
      }
      session.carKey = carKey;
      session.step = "input_poliza";
      await msg.reply(
        `Seleccionaste ${cars[carKey].name}\n\nEscribe los datos de la póliza:\n(Ejemplo: GNP Poliza 12345 - Vence 15 Octubre)`
      );
      break;
    }

    case "input_poliza": {
      const car = cars[session.carKey];
      car.poliza = body.trim();
      await saveCars(cars);
      resetSession(chatId);
      await msg.reply(
        `Póliza guardada para ${car.name}:\n"${car.poliza}"\n\nPuedes consultarla enviando /seguros`
      );
      break;
    }

    default:
      break;
  }
});

initCSV();
client.initialize();
