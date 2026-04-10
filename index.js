const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");

const CARS_FILE = path.join(__dirname, "cars.json");
const CSV_FILE  = path.join(__dirname, "historial.csv");

const CSV_HEADERS = "fecha,auto,km_actual,km_recorridos,litros,costo,precio_litro,lleno,rendimiento,costo_por_km\n";

function initCSV() {
  if (!fs.existsSync(CSV_FILE)) fs.writeFileSync(CSV_FILE, CSV_HEADERS);
}

function appendCSV(row) {
  const fecha          = new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" });
  const rendimiento    = row.rendimiento !== null ? row.rendimiento.toFixed(2) : "";
  const costoPorKm     = row.costoPorKm  !== null ? row.costoPorKm.toFixed(2)  : "";
  const precioPorLitro = (row.costo / row.litros).toFixed(2);
  const kmRecorridos   = row.kmRecorridos !== null ? row.kmRecorridos : "";
  const line =
    `"${fecha}","${row.autoName}",${row.kmActual},${kmRecorridos},` +
    `${row.litros},${row.costo},${precioPorLitro},` +
    `${row.lleno ? "si" : "no"},${rendimiento},${costoPorKm}\n`;
  fs.appendFileSync(CSV_FILE, line);
}

function loadCars() {
  if (!fs.existsSync(CARS_FILE)) {
    const defaults = {
      car1: { name: "Tiida 🚗", lastKm: null, baseKm: null, accLiters: 0, accCost: 0 },
      car2: { name: "Hyundai 🚙", lastKm: null, baseKm: null, accLiters: 0, accCost: 0 },
      car3: { name: "Chevy 🛻", lastKm: null, baseKm: null, accLiters: 0, accCost: 0 },
    };
    fs.writeFileSync(CARS_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  const cars = JSON.parse(fs.readFileSync(CARS_FILE, "utf8"));
  for (const key of ["car1", "car2", "car3"]) {
    if (cars[key].accLiters === undefined) cars[key].accLiters = 0;
    if (cars[key].accCost   === undefined) cars[key].accCost   = 0;
    if (cars[key].baseKm    === undefined) cars[key].baseKm    = null;
  }
  return cars;
}

function saveCars(cars) {
  fs.writeFileSync(CARS_FILE, JSON.stringify(cars, null, 2));
}

const sessions = {};
function getSession(chatId) {
  if (!sessions[chatId]) sessions[chatId] = { step: "idle" };
  return sessions[chatId];
}
function resetSession(chatId) { sessions[chatId] = { step: "idle" }; }

function parseNumber(text) {
  const n = parseFloat(text.replace(",", ".").trim());
  return isNaN(n) ? null : n;
}

function carMenu(cars) {
  return (
    `⛽ *Bot de Gasolina*\n\n` +
    `¿Cuál auto vas a cargar?\n\n` +
    `1️⃣  ${cars.car1.name}\n` +
    `2️⃣  ${cars.car2.name}\n` +
    `3️⃣  ${cars.car3.name}\n\n` +
    `Responde con *1*, *2* o *3*`
  );
}

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { args: ["--no-sandbox", "--disable-setuid-sandbox"] },
});

client.on("qr", (qr) => {
  console.log("\n📱 Escanea este QR con WhatsApp:\n");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  initCSV();
  console.log("✅ Bot conectado y listo!\n");
});

client.on("message", async (msg) => {
  const chatId  = msg.from;
  const body    = msg.body.trim();
  const session = getSession(chatId);
  const cars    = loadCars();

  if (body.toLowerCase() === "/start") {
    resetSession(chatId);
    sessions[chatId].step = "select_car";
    await msg.reply(carMenu(cars));
    return;
  }

  switch (session.step) {

    case "select_car": {
      const carMap = { "1": "car1", "2": "car2", "3": "car3" };
      const carKey = carMap[body];
      if (!carKey) { await msg.reply("❌ Responde con *1*, *2* o *3*."); return; }

      session.carKey = carKey;
      session.step   = "input_km";
      const car = cars[carKey];
      const pendingInfo = car.accLiters > 0
        ? `\n_(Acumulado sin rendimiento: *${car.accLiters.toFixed(2)} L*)_`
        : "";
      const lastInfo = car.lastKm !== null
        ? `\n_(Último odómetro: *${car.lastKm.toLocaleString("es-MX")} km*)_`
        : `\n_(Sin registro previo — este será el punto de partida)_`;

      await msg.reply(`${car.name} seleccionado ✓${lastInfo}${pendingInfo}\n\n¿Cuál es el *kilometraje actual*?\n(ej. 45320)`);
      break;
    }

    case "input_km": {
      const km = parseNumber(body);
      if (km === null || km <= 0) { await msg.reply("❌ Número inválido. (ej. 45320)"); return; }

      const car = cars[session.carKey];

      if (car.lastKm === null) {
        car.lastKm = km;
        saveCars(cars);
        resetSession(chatId);
        await msg.reply(`✅ *Kilometraje inicial: ${km.toLocaleString("es-MX")} km*\n\nLa próxima carga, llena el tanque completo para establecer la base 🚀`);
        return;
      }

      if (km <= car.lastKm) {
        await msg.reply(`❌ El km (*${km.toLocaleString("es-MX")}*) debe ser mayor al anterior (*${car.lastKm.toLocaleString("es-MX")}*).\n\nIngresa el valor correcto:`);
        return;
      }

      session.currentKm = km;
      session.step      = "input_liters";
      await msg.reply(`¿Cuántos *litros* cargaste?\n(ej. 40.5)`);
      break;
    }

    case "input_liters": {
      const liters = parseNumber(body);
      if (liters === null || liters <= 0) { await msg.reply("❌ Número inválido. (ej. 40.5)"); return; }
      session.liters = liters;
      session.step   = "input_cost";
      await msg.reply(`¿Cuánto *pagaste* en total?\n(ej. 950)`);
      break;
    }

    case "input_cost": {
      const cost = parseNumber(body);
      if (cost === null || cost <= 0) { await msg.reply("❌ Monto inválido. (ej. 950)"); return; }
      session.cost = cost;
      session.step = "confirm_full";
      await msg.reply(`¿Llenaste el tanque *completo*?\n\nResponde *si* o *no*`);
      break;
    }

    case "confirm_full": {
      const resp  = body.toLowerCase().trim();
      const lleno = resp === "si" || resp === "sí";
      if (resp !== "si" && resp !== "sí" && resp !== "no") {
        await msg.reply("❌ Responde *si* o *no*.");
        return;
      }

      const { carKey, currentKm, liters, cost } = session;
      const car         = cars[carKey];
      const precioL     = cost / liters;
      car.lastKm        = currentKm;

      if (!lleno) {
        car.accLiters += liters;
        car.accCost   += cost;
        saveCars(cars);
        appendCSV({ autoName: car.name, kmActual: currentKm, kmRecorridos: null, litros: liters, costo: cost, lleno: false, rendimiento: null, costoPorKm: null });
        resetSession(chatId);
        await msg.reply(
          `📝 *Carga parcial registrada*\n\n` +
          `🪣  Litros esta carga:  ${liters.toFixed(2)} L\n` +
          `💰  Costo esta carga:   $${cost.toFixed(2)}\n` +
          `⛽  Precio/litro:       $${precioL.toFixed(2)}/L\n\n` +
          `📦 *Acumulado desde último lleno:*\n` +
          `   ${car.accLiters.toFixed(2)} L — $${car.accCost.toFixed(2)}\n\n` +
          `⏳ El rendimiento se calculará al llenar el tanque completo.`
        );
        return;
      }

      const totalLiters = car.accLiters + liters;
      const totalCost   = car.accCost   + cost;

      if (car.baseKm === null) {
        car.baseKm    = currentKm;
        car.accLiters = 0;
        car.accCost   = 0;
        saveCars(cars);
        appendCSV({ autoName: car.name, kmActual: currentKm, kmRecorridos: null, litros: liters, costo: cost, lleno: true, rendimiento: null, costoPorKm: null });
        resetSession(chatId);
        await msg.reply(`✅ *Primera base establecida: ${currentKm.toLocaleString("es-MX")} km*\n\n⛽ Precio/litro: $${precioL.toFixed(2)}/L\n\nYa podemos calcular rendimiento en la próxima carga completa 🚀`);
        return;
      }

      const kmRecorridos = currentKm - car.baseKm;
      const rendimiento  = kmRecorridos / totalLiters;
      const costoPorKm   = totalCost / kmRecorridos;
      const totalPrecioL = totalCost / totalLiters;
      const bar          = rendimiento >= 14 ? "🟢" : rendimiento >= 11 ? "🟡" : "🔴";

      appendCSV({ autoName: car.name, kmActual: currentKm, kmRecorridos, litros: totalLiters, costo: totalCost, lleno: true, rendimiento, costoPorKm });

      car.baseKm    = currentKm;
      car.accLiters = 0;
      car.accCost   = 0;
      saveCars(cars);
      resetSession(chatId);

      await msg.reply(
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `⛽ *Reporte de Rendimiento*\n` +
        `${car.name}\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🛣️  Km recorridos:    *${kmRecorridos.toLocaleString("es-MX", { maximumFractionDigits: 1 })} km*\n` +
        `🪣  Litros totales:   *${totalLiters.toFixed(2)} L*\n` +
        `💰  Gasto total:      *$${totalCost.toFixed(2)}*\n\n` +
        `${bar} *Rendimiento:  ${rendimiento.toFixed(2)} km/L*\n\n` +
        `📊 Precio prom/litro: $${totalPrecioL.toFixed(2)}/L\n` +
        `📊 Costo por km:      $${costoPorKm.toFixed(2)}/km\n\n` +
        `📍 Nueva base:        ${currentKm.toLocaleString("es-MX")} km\n` +
        `━━━━━━━━━━━━━━━━━━━━━`
      );
      break;
    }

    default:
      break;
  }
});

initCSV();
client.initialize();
