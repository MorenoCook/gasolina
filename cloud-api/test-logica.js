/**
 * Prueba local del motor de gasolina SIN Supabase ni WhatsApp.
 * Store en memoria. Corre:  node test-logica.js
 */
const { createGasolina } = require("./gasolina-logic");

let carsDB = null;
const hist = [];
const store = {
  async loadCars() { return carsDB; },
  async saveCars(c) { carsDB = c; },
  async appendHistorial(r) { hist.push({ ...r, fecha: "14/06/2026" }); },
  async recentHistorial(n) {
    return hist.slice(-n).reverse().map((r) => ({
      fecha: r.fecha, auto: r.autoName, litros: r.litros, costo: r.costo,
      km_actual: r.kmActual, rendimiento: r.rendimiento,
    }));
  },
};

const gas = createGasolina(store);
const U = "521000000000";

(async () => {
  const say = async (t) => {
    const out = await gas.handle(U, t);
    console.log(`\n>>> ${t}`);
    for (const r of out) console.log(r);
  };

  // Flujo paso a paso: base + carga con rendimiento
  await say("/start");
  await say("1");              // Tiida
  await say("100000");        // primer km → establece lastKm, resetea
  await say("/start 1");      // inline car
  await say("100500");        // km > lastKm
  await say("40");            // litros
  await say("900");           // costo
  await say("si");            // lleno → primera base
  await say("/start 1 101000"); // km nuevo inline (cae a input_km)
  await say("38");
  await say("800");
  await say("si");            // ahora SÍ calcula rendimiento (500km / 38L ≈ 13.16)

  // Express multi-dato
  await say("tiida km 101600 lts 30 850");

  // Mantenimiento + consultas
  await say("/aceite 1 101000 5w-30");
  await say("/registro");

  console.log("\n--- carsDB final ---");
  console.log(JSON.stringify(carsDB.car1, null, 2));
})();
