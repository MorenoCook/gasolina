/**
 * Store Supabase — mismas tablas que el bot original (`cars` y `historial`).
 * Reutilizable por el webhook de Cloud API. Sin lógica de WhatsApp.
 */

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const DEFAULTS = {
  car1: { name: "Tiida",   lastKm: null, baseKm: null, accLiters: 0, accCost: 0, lastOilKm: null, lastOilType: null, lastTireKm: null, poliza: null },
  car2: { name: "Hyundai", lastKm: null, baseKm: null, accLiters: 0, accCost: 0, lastOilKm: null, lastOilType: null, lastTireKm: null, poliza: null },
  car3: { name: "Chevy",   lastKm: null, baseKm: null, accLiters: 0, accCost: 0, lastOilKm: null, lastOilType: null, lastTireKm: null, poliza: null },
};

async function loadCars() {
  const { data, error } = await supabase
    .from("cars")
    .select("state_json")
    .eq("id", 1)
    .single();
  if (!data || error) {
    await supabase.from("cars").upsert([{ id: 1, state_json: DEFAULTS }]);
    return DEFAULTS;
  }
  return data.state_json;
}

async function saveCars(cars) {
  await supabase.from("cars").upsert([{ id: 1, state_json: cars }]);
}

async function appendHistorial(row) {
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
    costo_por_km: row.costoPorKm,
  }]);
}

async function recentHistorial(limit = 5) {
  const { data, error } = await supabase
    .from("historial")
    .select("*")
    .order("id", { ascending: false })
    .limit(limit);
  if (error) return [];
  return data || [];
}

module.exports = { loadCars, saveCars, appendHistorial, recentHistorial, supabase };
