const fs = require('fs');

let code = fs.readFileSync('bot.js', 'utf8');

// 1. Reemplazar imports
const imports_old = `const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");`;

const imports_new = `const { Client, RemoteAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");
const { PostgresStore } = require("wwebjs-postgres");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || "TU_SUPABASE_URL";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "TU_SUPABASE_KEY";
const DATABASE_URL = process.env.DATABASE_URL || "postgres://pass@host:5432/postgres"; // Usar el connection pooling de Supabase

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const app = express();
app.get("/", (req, res) => res.send("Bot Activo 24/7 (Render + UptimeRobot)"));
app.listen(process.env.PORT || 3000, () => console.log("Servidor Express escuchando (Listo para UptimeRobot)"));
`;

code = code.replace(imports_old, imports_new);

// 2. Reemplazar el manejo de archivos local
const file_helpers_old = `const CARS_FILE = path.join(__dirname, "cars.json");
const CSV_FILE = path.join(__dirname, "historial.csv");

const CSV_HEADERS =
  "fecha,auto,km_actual,km_recorridos,litros,costo,precio_litro,lleno,rendimiento,costo_por_km\\n";

function initCSV() {
  if (!fs.existsSync(CSV_FILE)) fs.writeFileSync(CSV_FILE, CSV_HEADERS);
}

function appendCSV(row) {
  const fecha = new Date().toLocaleString("es-MX", {
    timeZone: "America/Mexico_City"
  });
  const rendimiento =
    row.rendimiento !== null ? row.rendimiento.toFixed(2) : "";
  const costoPorKm = row.costoPorKm !== null ? row.costoPorKm.toFixed(2) : "";
  const precioPorLitro = (row.costo / row.litros).toFixed(2);
  const kmRecorridos = row.kmRecorridos !== null ? row.kmRecorridos : "";
  const line =
    \`"\${fecha}","\${row.autoName}",\${row.kmActual},\${kmRecorridos},\` +
    \`\${row.litros},\${row.costo},\${precioPorLitro},\` +
    \`\${row.lleno ? "si" : "no"},\${rendimiento},\${costoPorKm}\\n\`;
  fs.appendFileSync(CSV_FILE, line);
}

function loadCars() {
  if (!fs.existsSync(CARS_FILE)) {
    const defaults = {
      car1: {
        name: "Tiida",
        lastKm: null,
        baseKm: null,
        accLiters: 0,
        accCost: 0
      },
      car2: {
        name: "Hyundai",
        lastKm: null,
        baseKm: null,
        accLiters: 0,
        accCost: 0
      },
      car3: {
        name: "Chevy",
        lastKm: null,
        baseKm: null,
        accLiters: 0,
        accCost: 0
      }
    };
    fs.writeFileSync(CARS_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  const cars = JSON.parse(fs.readFileSync(CARS_FILE, "utf8"));
  for (const key of ["car1", "car2", "car3"]) {
    if (cars[key].accLiters === undefined) cars[key].accLiters = 0;
    if (cars[key].accCost === undefined) cars[key].accCost = 0;
    if (cars[key].baseKm === undefined) cars[key].baseKm = null;
    if (cars[key].lastOilKm === undefined) cars[key].lastOilKm = null;
    if (cars[key].lastTireKm === undefined) cars[key].lastTireKm = null;
    if (cars[key].poliza === undefined) cars[key].poliza = null;
  }
  return cars;
}

function saveCars(cars) {
  fs.writeFileSync(CARS_FILE, JSON.stringify(cars, null, 2));
}`;

const file_helpers_new = `async function initCSV() {
  console.log("Supabase listo para tablas 'historial' y 'cars'");
}

async function appendCSV(row) {
  const fecha = new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" });
  await supabase.from("historial").insert([{
    fecha,
    auto: row.autoName,
    km_actual: row.kmActual,
    km_recorridos: row.kmRecorridos,
    litros: row.litros,
    costo: row.costo,
    lleno: row.lleno,
    rendimiento: row.rendimiento,
    costo_por_km: row.costoPorKm
  }]);
}

async function loadCars() {
  const { data, error } = await supabase.from("cars").select("state_json").eq("id", 1).single();
  
  if (!data || error) {
    const defaults = {
      car1: { name: "Tiida \uD83D\uDE97", lastKm: null, baseKm: null, accLiters: 0, accCost: 0, lastOilKm: null, lastTireKm: null, poliza: null },
      car2: { name: "Hyundai \uD83D\uDE99", lastKm: null, baseKm: null, accLiters: 0, accCost: 0, lastOilKm: null, lastTireKm: null, poliza: null },
      car3: { name: "Chevy \uD83D\uDEFB", lastKm: null, baseKm: null, accLiters: 0, accCost: 0, lastOilKm: null, lastTireKm: null, poliza: null }
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
}`;

code = code.replace(file_helpers_old, file_helpers_new);

// 3. Client configuration
const client_old = `const client = new Client({
  authStrategy: new LocalAuth(),`;

const client_new = `const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
const store = new PostgresStore({ client: pool });

const client = new Client({
  authStrategy: new RemoteAuth({ store: store, backupSyncIntervalMs: 300000 }),`;

code = code.replace(client_old, client_new);

// 4. Update async calls globally
code = code.replace(/const cars = loadCars\(\);/g, `const cars = await loadCars();`);
code = code.replace(/saveCars\(cars\);/g, `await saveCars(cars);`);
code = code.replace(/appendCSV\(\{/g, `await appendCSV({`);

// 5. Replace "/registro" command logic to fetch from Supabase
const reg_old = `if (body.toLowerCase() === "/registro") {
    if (!fs.existsSync(CSV_FILE)) {
      await msg.reply("❌ Aún no hay registros en el historial.");
      return;
    }

    const content = fs.readFileSync(CSV_FILE, "utf-8").trim();
    const lines = content.split("\\n");

    if (lines.length <= 1) {
      await msg.reply("❌ Aun no hay cargas registradas.");
      return;
    }

    // Agarrar los últimos 5, y mostrar el más reciente primero
    const logs = lines.slice(1).slice(-5).reverse();

    let text = \`📋 *Últimos 5 Registros*\\n━━━━━━━━━━━━━━\\n\`;
    for (const line of logs) {
      const match = line.match(/^"([^"]+)","([^"]+)",(.*)/);
      if (!match) continue;

      const fecha = match[1].replace(
        /,\\s\\d{1,2}:\\d{2}:\\d{2}\\s?(a\\.m\\.|p\\.m\\.|AM|PM)?/i,
        ""
      ); // Remover la hora para dejar la fecha limpia
      const auto = match[2];
      const parts = match[3].split(",");

      const kmActual = parseInt(parts[0]).toLocaleString("es-MX");
      const litros = parseFloat(parts[2]).toFixed(1);
      const costo = parseFloat(parts[3]).toFixed(2);
      const rend = parts[6];

      const rendText = rend
        ? \`\${parseFloat(rend).toFixed(2)} km/L\`
        : \`_Carga Parcial_\`;

      text += \`*\${fecha}* — \${auto}\\n\`;
      text += \`\${litros} L   💰 $\${costo}\\n\`;
      text += \`Km: \${kmActual}   📊 \${rendText}\\n\`;
      text += \`━━━━━━━━━━━━━━\\n\`;
    }

    await msg.reply(text.trim());
    return;
  }`;

const reg_new = `if (body.toLowerCase() === "/registro") {
    const { data: logs, error } = await supabase
      .from("historial")
      .select("*")
      .order("id", { ascending: false })
      .limit(5);

    if (error || !logs || logs.length === 0) {
      await msg.reply("❌ Aún no hay registros en el historial de Supabase.");
      return;
    }

    let text = \`📋 *Últimos 5 Registros*\\n━━━━━━━━━━━━━━\\n\`;
    for (const row of logs) {
      // row.fecha viene como string tipo "dd/mm/yyyy hh:mm:ss" o el timestamp
      const fechaLimpia = row.fecha ? row.fecha.split(',')[0] : "";
      
      const rendText = row.rendimiento 
        ? \`\${parseFloat(row.rendimiento).toFixed(2)} km/L\` 
        : \`_Carga Parcial_\`;

      text += \`*\${fechaLimpia}* — \${row.auto}\\n\`;
      text += \`\${parseFloat(row.litros).toFixed(1)} L   💰 $\${parseFloat(row.costo).toFixed(2)}\\n\`;
      text += \`Km: \${parseInt(row.km_actual).toLocaleString("es-MX")}   📊 \${rendText}\\n\`;
      text += \`━━━━━━━━━━━━━━\\n\`;
    }

    await msg.reply(text.trim());
    return;
  }`;

code = code.replace(reg_old, reg_new);

// 6. Delete Oracle Anti-Idle
const indexToCut = code.indexOf("// --- SISTEMA ANTI-APAGADOS PARA ORACLE CLOUD");
if (indexToCut !== -1) {
    code = code.substring(0, indexToCut);
}

fs.writeFileSync('bot.js', code);
fs.writeFileSync('bot.patch.txt', "Hecho!");
