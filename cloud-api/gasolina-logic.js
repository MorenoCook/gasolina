/**
 * Motor de gasolina — portado desde ../bot.js (Baileys) a algo framework-agnóstico.
 * No depende de WhatsApp: recibe (userId, texto) y devuelve un array de respuestas (strings).
 * El webhook (Cloud API) las envía. Mantiene la MISMA lógica, mensajes y matemática.
 *
 * Estado conversacional en memoria por usuario (igual que el bot original).
 * Persistencia (cars + historial) via `store` inyectado → ver store-supabase.js.
 */

const DEFAULT_CAR = {
  name: "Auto",
  lastKm: null,
  baseKm: null,
  accLiters: 0,
  accCost: 0,
  lastOilKm: null,
  lastOilType: null,
  lastTireKm: null,
  poliza: null,
};

function normalizeCars(cars) {
  const out = {};
  for (const key of ["car1", "car2", "car3"]) {
    out[key] = { ...DEFAULT_CAR, ...(cars?.[key] || {}) };
  }
  return out;
}

function parseNumber(text) {
  const n = parseFloat(String(text).replace(",", ".").trim());
  return isNaN(n) ? null : n;
}

function parseRegistroExpress(textoOriginal) {
  const lower = textoOriginal.toLowerCase();

  let carKey = null;
  if (lower.includes("tiida") || lower.includes("tida") || lower.includes("auto 1"))
    carKey = "car1";
  else if (lower.includes("hyund") || lower.includes("hunday") || lower.includes("auto 2"))
    carKey = "car2";
  else if (lower.includes("chevy") || lower.includes("chevi") || lower.includes("auto 3"))
    carKey = "car3";
  if (!carKey) return null;

  const cleanLower = lower.replace(/(\d)[ \t]+(\d)/g, "$1$2");

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
    const lines = textoOriginal.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^\d+[\.,]?\d*$/.test(trimmed)) {
        const num = parseFloat(trimmed.replace(",", "."));
        if (num > 50 && num <= 3000 && Math.abs(num - (lts || 0)) > 0.01 && Math.abs(num - km) > 0.01) {
          cost = num;
          break;
        }
      }
    }
    if (!cost) {
      const numbers = cleanLower.match(/\b\d+[\.,]?\d*\b/g);
      if (numbers && lts && km) {
        for (const str of numbers) {
          const num = parseFloat(str.replace(",", "."));
          if (num > 50 && num <= 3000 && Math.abs(num - lts) > 0.01 && Math.abs(num - km) > 0.01) {
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

/**
 * @param store { loadCars, saveCars, appendHistorial, recentHistorial }
 * @param opts  { linkCarpetaSeguros?: string }
 */
function createGasolina(store, opts = {}) {
  const LINK_CARPETA_SEGUROS = opts.linkCarpetaSeguros || "";
  const sessions = {};
  const getSession = (id) => (sessions[id] ||= { step: "idle" });
  // Muta el MISMO objeto (no lo reemplaza) para que las referencias capturadas
  // antes del reset sigan apuntando a la sesión viva. Reemplazarlo dejaba `session`
  // obsoleto y rompía el fall-through de comandos inline tipo `/start 1 45320`.
  const resetSession = (id) => {
    const s = getSession(id);
    for (const k of Object.keys(s)) delete s[k];
    s.step = "idle";
    return s;
  };

  async function handle(userId, rawText) {
    const out = [];
    const reply = (t) => out.push(t);

    let body = String(rawText || "").trim();
    if (!body) return out;

    const session = getSession(userId);
    const cars = normalizeCars(await store.loadCars());

    // ---- PROCESADOR EXPRESS INTELIGENTE ----
    if (session.step === "idle" && !body.startsWith("/")) {
      const expressData = parseRegistroExpress(body);
      if (expressData) {
        const car = cars[expressData.carKey];
        if (expressData.km <= 0 || (car.lastKm !== null && expressData.km <= car.lastKm)) {
          reply(`Quise registrar automáticamente pero el km (*${expressData.km}*) es inválido o menor al cargado ayer (*${car.lastKm}*).\nUsa \`/start\` manualmente.`);
          return out;
        }
        const alertas = buildAlertas(car, expressData.km);
        session.carKey = expressData.carKey;
        session.currentKm = expressData.km;

        if (!expressData.litros) {
          session.step = "input_liters";
          reply(`*Registro Express Detectado*\n Auto: ${car.name}\nKM: ${expressData.km.toLocaleString("es-MX")}${alertas}\n¿Cuántos *litros* cargaste?`);
          return out;
        }
        session.liters = expressData.litros;
        if (!expressData.cost) {
          session.step = "input_cost";
          reply(`*Registro Express: ${car.name}*\nKM: ${expressData.km.toLocaleString("es-MX")} | Lts: ${expressData.litros}${alertas}\n¿Cuánto *pagaste* en total? (ej. 900)`);
          return out;
        }
        session.cost = expressData.cost;
        session.step = "confirm_full";
        reply(`*Registro Multi-Dato Exitoso* ⚡\nAuto: ${car.name}\nKM: ${expressData.km.toLocaleString("es-MX")}\nLitros: ${expressData.litros} L\nCosto: $${expressData.cost}\n${alertas}\n¿Llenaste el tanque *completo*?\nResponde *si* o *no*`);
        return out;
      }
    }

    // ---- COMANDOS ----
    const low = body.toLowerCase();

    if (low.startsWith("/start")) {
      resetSession(userId);
      const s = getSession(userId);
      const args = body.split(" ");
      if (args.length > 1 && ["1", "2", "3"].includes(args[1])) {
        s.carKey = "car" + args[1];
        s.step = "input_km";
        if (args.length > 2) {
          body = args.slice(2).join(" ");
        } else {
          const car = cars[s.carKey];
          const pendingInfo = car.accLiters > 0 ? `\n_(Acumulado sin rendimiento: *${car.accLiters.toFixed(2)} L*)_` : "";
          const lastInfo = car.lastKm !== null ? `\n_(Último odómetro: *${car.lastKm.toLocaleString("es-MX")} km*)_` : `\n_(Sin registro previo)_`;
          reply(`${car.name} seleccionado ✓${lastInfo}${pendingInfo}\n¿Cuál es el *kilometraje actual*?\n(ej. 45320)`);
          return out;
        }
      } else {
        s.step = "select_car";
        reply(carMenu(cars));
        return out;
      }
    } else if (low.startsWith("/aceite")) {
      resetSession(userId);
      const s = getSession(userId);
      const args = body.split(" ");
      if (args.length > 1 && ["1", "2", "3"].includes(args[1])) {
        s.carKey = "car" + args[1];
        s.step = "input_oil_km";
        if (args.length > 2) body = args.slice(2).join(" ");
        else {
          reply(`Seleccionaste ${cars[s.carKey].name}\nEscribe el *kilometraje* actual en el que se acaba de hacer el cambio de aceite y el *tipo de aceite*:\n(ej. 52000 15w-40)`);
          return out;
        }
      } else {
        s.step = "select_car_oil";
        reply(`*Cambio de Aceite*\n¿A cuál auto le cambiaste el aceite?\n1️⃣  ${cars.car1.name}\n2️⃣  ${cars.car2.name}\n3️⃣  ${cars.car3.name}\nResponde con *1*, *2* o *3*`);
        return out;
      }
    } else if (low.startsWith("/llantas")) {
      resetSession(userId);
      const s = getSession(userId);
      const args = body.split(" ");
      if (args.length > 1 && ["1", "2", "3"].includes(args[1])) {
        s.carKey = "car" + args[1];
        s.step = "input_tire_km";
        if (args.length > 2) body = args.slice(2).join(" ");
        else {
          reply(`Seleccionaste ${cars[s.carKey].name}\nEscribe el *kilometraje* de la instalación de tus llantas nuevas:\n(ej. 45000)`);
          return out;
        }
      } else {
        s.step = "select_car_tire";
        reply(`*Cambio de Llantas*\n¿A cuál auto se le pusieron llantas nuevas?\n1️⃣  ${cars.car1.name}\n2️⃣  ${cars.car2.name}\n3️⃣  ${cars.car3.name}\nResponde con *1*, *2* o *3*`);
        return out;
      }
    } else if (low.startsWith("/poliza")) {
      resetSession(userId);
      const s = getSession(userId);
      const args = body.split(" ");
      if (args.length > 1 && ["1", "2", "3"].includes(args[1])) {
        s.carKey = "car" + args[1];
        s.step = "input_poliza";
        if (args.length > 2) body = args.slice(2).join(" ");
        else {
          reply(`Seleccionaste ${cars[s.carKey].name}\nEscribe los datos de la póliza:\n(Ejemplo: GNP Poliza 12345 - Vence 15 Octubre)`);
          return out;
        }
      } else {
        s.step = "select_car_poliza";
        reply(`*Registrar Póliza de Seguro*\n¿A qué auto le vas a registrar el seguro?\n1️⃣  ${cars.car1.name}\n2️⃣  ${cars.car2.name}\n3️⃣  ${cars.car3.name}\nResponde con 1, 2 o 3`);
        return out;
      }
    } else if (low === "/seguros") {
      resetSession(userId);
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
      if (LINK_CARPETA_SEGUROS) text += `\n*Carpeta de Pólizas (PDF):*\n${LINK_CARPETA_SEGUROS}\n`;
      reply(text.trim());
      return out;
    } else if (low === "/registro") {
      const logs = await store.recentHistorial(5);
      if (!logs || logs.length === 0) {
        reply("❌ Aún no hay registros en el historial.");
        return out;
      }
      let text = `📋 *Últimos 5 Registros*\n━━━━━━━━━━━━━━\n`;
      for (const row of logs) {
        const fechaLimpia = row.fecha ? row.fecha.split(",")[0] : "";
        const rendText = row.rendimiento ? `${parseFloat(row.rendimiento).toFixed(2)} km/L` : `_Carga Parcial_`;
        text += `*${fechaLimpia}* — ${row.auto}\n`;
        text += `${parseFloat(row.litros).toFixed(1)} L   💰 $${parseFloat(row.costo).toFixed(2)}\n`;
        text += `Km: ${parseInt(row.km_actual).toLocaleString("es-MX")}   📊 ${rendText}\n`;
        text += `━━━━━━━━━━━━━━\n`;
      }
      reply(text.trim());
      return out;
    }

    // ---- MÁQUINA DE ESTADOS ----
    switch (session.step) {
      case "select_car": {
        const carKey = { 1: "car1", 2: "car2", 3: "car3" }[body];
        if (!carKey) { reply("❌ Responde con *1*, *2* o *3*."); return out; }
        session.carKey = carKey;
        session.step = "input_km";
        const car = cars[carKey];
        const pendingInfo = car.accLiters > 0 ? `\n_(Acumulado sin rendimiento: *${car.accLiters.toFixed(2)} L*)_` : "";
        const lastInfo = car.lastKm !== null ? `\n_(Último odómetro: *${car.lastKm.toLocaleString("es-MX")} km*)_` : `\n_(Sin registro previo — este será el punto de partida)_`;
        reply(`${car.name} seleccionado ✓${lastInfo}${pendingInfo}\n¿Cuál es el *kilometraje actual*?\n(ej. 45320)`);
        break;
      }

      case "input_km": {
        const km = parseNumber(body);
        if (km === null || km <= 0) { reply("❌ Número inválido. (ej. 45320)"); return out; }
        const car = cars[session.carKey];
        if (car.lastKm === null) {
          car.lastKm = km;
          await store.saveCars(cars);
          resetSession(userId);
          reply(`*Kilometraje inicial: ${km.toLocaleString("es-MX")} km*\nLa próxima carga, llena el tanque completo para establecer la base`);
          return out;
        }
        if (km <= car.lastKm) {
          reply(`❌ El km (*${km.toLocaleString("es-MX")}*) debe ser mayor al anterior (*${car.lastKm.toLocaleString("es-MX")}*).`);
          return out;
        }
        session.currentKm = km;
        session.step = "input_liters";
        reply(`¿Cuántos *litros* cargaste?\n(ej. 40.5)${buildAlertas(car, km)}`);
        break;
      }

      case "input_liters": {
        const liters = parseNumber(body);
        if (liters === null || liters <= 0) { reply("❌ Número inválido. (ej. 40.5)"); return out; }
        session.liters = liters;
        session.step = "input_cost";
        reply(`¿Cuánto *pagaste* en total?\n(ej. 950)`);
        break;
      }

      case "input_cost": {
        const cost = parseNumber(body);
        if (cost === null || cost <= 0) { reply("❌ Monto inválido. (ej. 950)"); return out; }
        session.cost = cost;
        session.step = "confirm_full";
        reply(`¿Llenaste el tanque *completo*?\nResponde *si* o *no*`);
        break;
      }

      case "confirm_full": {
        const resp = body.toLowerCase().trim();
        const lleno = resp === "si" || resp === "sí";
        if (resp !== "si" && resp !== "sí" && resp !== "no") { reply("❌ Responde *si* o *no*."); return out; }
        const { carKey, currentKm, liters, cost } = session;
        const car = cars[carKey];
        const precioL = cost / liters;
        car.lastKm = currentKm;

        if (!lleno) {
          car.accLiters += liters;
          car.accCost += cost;
          await store.saveCars(cars);
          await store.appendHistorial({ autoName: car.name, kmActual: currentKm, kmRecorridos: null, litros: liters, costo: cost, lleno: false, rendimiento: null, costoPorKm: null });
          resetSession(userId);
          reply(
            `*Carga parcial registrada*\n` +
            `Litros esta carga:  ${liters.toFixed(2)} L\n` +
            `Costo esta carga:   $${cost.toFixed(2)}\n` +
            `Precio/litro:       $${precioL.toFixed(2)}/L\n` +
            `*Acumulado desde último lleno:*\n` +
            `   ${car.accLiters.toFixed(2)} L — $${car.accCost.toFixed(2)}\n` +
            `⏳ El rendimiento se calculará al llenar el tanque completo.`
          );
          return out;
        }

        const totalLiters = car.accLiters + liters;
        const totalCost = car.accCost + cost;

        if (car.baseKm === null) {
          car.baseKm = currentKm;
          car.accLiters = 0;
          car.accCost = 0;
          await store.saveCars(cars);
          await store.appendHistorial({ autoName: car.name, kmActual: currentKm, kmRecorridos: null, litros: liters, costo: cost, lleno: true, rendimiento: null, costoPorKm: null });
          resetSession(userId);
          reply(`*Primera base establecida: ${currentKm.toLocaleString("es-MX")} km*\n Precio/litro: $${precioL.toFixed(2)}/L\nYa podemos calcular rendimiento en la próxima carga completa`);
          return out;
        }

        const kmRecorridos = currentKm - car.baseKm;
        const rendimiento = kmRecorridos / totalLiters;
        const costoPorKm = totalCost / kmRecorridos;
        const totalPrecioL = totalCost / totalLiters;
        const bar = rendimiento >= 14 ? "🟢" : rendimiento >= 11 ? "🟡" : "🔴";

        await store.appendHistorial({ autoName: car.name, kmActual: currentKm, kmRecorridos, litros: totalLiters, costo: totalCost, lleno: true, rendimiento, costoPorKm });

        car.baseKm = currentKm;
        car.accLiters = 0;
        car.accCost = 0;
        await store.saveCars(cars);
        resetSession(userId);

        const oilUsado = car.lastOilKm !== null ? currentKm - car.lastOilKm : "N/A";
        const tireUsado = car.lastTireKm !== null ? currentKm - car.lastTireKm : "N/A";
        const infoVerif = {
          car1: "Placa 4 | Verif: Mar-Abr / Sep-Oct",
          car2: "Placa 6 | Verif: Feb-Mar / Jul-Ago",
          car3: "Placa 8 | Verif: Feb-Mar / Ago-Sep",
        }[carKey] || "";

        let infoAceiteExtra = "";
        if (car.name.toLowerCase().includes("tiida")) infoAceiteExtra = "14 mm - 4.4 L";
        else if (car.name.toLowerCase().includes("hyundai")) infoAceiteExtra = "17 mm - 3.5 L";
        else if (car.name.toLowerCase().includes("chevy")) infoAceiteExtra = "15 mm - ~3.5–4.0 L";
        const oilTypeDisplay = car.lastOilType || "No especificado";
        const oilSummary = oilUsado !== "N/A" ? `${oilTypeDisplay} - ${oilUsado.toLocaleString("es-MX")} km - ${infoAceiteExtra}` : "N/A";

        reply(
          `*Rendimiento*\n` +
          `${car.name}\n` +
          `━━━━━━━━━━━━━━━━━━━━━\n` +
          `Km recorridos:    *${kmRecorridos.toLocaleString("es-MX", { maximumFractionDigits: 1 })} km*\n` +
          `Lts:   *${totalLiters.toFixed(2)} L*\n` +
          `Costo total:      *$${totalCost.toFixed(2)}*\n` +
          `${bar} *Rendimiento:  ${rendimiento.toFixed(2)} km/L*\n` +
          `Precio prom/litro: $${totalPrecioL.toFixed(2)}/L\n` +
          `Costo por km:      $${costoPorKm.toFixed(2)}/km\n` +
          `Nueva base:        ${currentKm.toLocaleString("es-MX")} km\n` +
          `━━━━━━━━━━━━━━━━━━━━━\n` +
          `*Estado del Vehículo*\n` +
          `Uso Aceite:  ${oilSummary}\n` +
          `Uso Llantas: ${tireUsado !== "N/A" ? tireUsado.toLocaleString("es-MX") + " km" : "N/A"}\n` +
          `${infoVerif}\n` +
          `━━━━━━━━━━━━━━━━━━━━━`
        );
        break;
      }

      case "select_car_oil": {
        const carKey = { 1: "car1", 2: "car2", 3: "car3" }[body];
        if (!carKey) { reply("❌ Responde con *1*, *2* o *3*."); return out; }
        session.carKey = carKey;
        session.step = "input_oil_km";
        reply(`Seleccionaste ${cars[carKey].name}\nEscribe el *kilometraje* actual en el que se acaba de hacer el cambio de aceite y el *tipo de aceite*:\n(ej. 52000 15w-40)`);
        break;
      }

      case "input_oil_km": {
        const parts = body.trim().split(/\s+/);
        const km = parseNumber(parts[0]);
        if (km === null || km <= 0) { reply("❌ Número y tipo inválido. (ej. 52000 15w-40)"); return out; }
        const oilType = parts.length > 1 ? parts.slice(1).join(" ") : "No especificado";
        const car = cars[session.carKey];
        car.lastOilKm = km;
        car.lastOilType = oilType;
        await store.saveCars(cars);
        resetSession(userId);
        reply(`*¡Aceite (${oilType}) renovado a los ${km.toLocaleString("es-MX")} km!*\nEl sistema te avisará automáticamente cuando pases de los ${(km + 10000).toLocaleString("es-MX")} km.`);
        break;
      }

      case "select_car_tire": {
        const carKey = { 1: "car1", 2: "car2", 3: "car3" }[body];
        if (!carKey) { reply("❌ Responde con *1*, *2* o *3*."); return out; }
        session.carKey = carKey;
        session.step = "input_tire_km";
        reply(`Seleccionaste ${cars[carKey].name}\nEscribe el *kilometraje* del vehículo en el que instalaste las llantas nuevas:\n(ej. 52000)`);
        break;
      }

      case "input_tire_km": {
        const km = parseNumber(body);
        if (km === null || km <= 0) { reply("❌ Número inválido. (ej. 52000)"); return out; }
        const car = cars[session.carKey];
        car.lastTireKm = km;
        await store.saveCars(cars);
        resetSession(userId);
        reply(`*¡Llantas registradas a los ${km.toLocaleString("es-MX")} km!*\nDispararé una alerta cuando logren alcanzar su límite físico de ${(km + 50000).toLocaleString("es-MX")} km.`);
        break;
      }

      case "select_car_poliza": {
        const carKey = { 1: "car1", 2: "car2", 3: "car3" }[body];
        if (!carKey) { reply("❌ Responde con 1, 2 o 3."); return out; }
        session.carKey = carKey;
        session.step = "input_poliza";
        reply(`Seleccionaste ${cars[carKey].name}\nEscribe los datos de la póliza:\n(Ejemplo: GNP Poliza 12345 - Vence 15 Octubre)`);
        break;
      }

      case "input_poliza": {
        const car = cars[session.carKey];
        car.poliza = body.trim();
        await store.saveCars(cars);
        resetSession(userId);
        reply(`Póliza guardada para ${car.name}:\n"${car.poliza}"\nPuedes consultarla enviando /seguros`);
        break;
      }

      default:
        break;
    }

    return out;
  }

  return { handle };
}

module.exports = { createGasolina, parseRegistroExpress, buildAlertas, normalizeCars };
