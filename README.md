# ⛽ Bot de Gasolina para WhatsApp

Bot que calcula automáticamente el rendimiento de tus 3 autos cada vez que cargas gasolina.

---

## 📋 Requisitos

- **Node.js 18+** → https://nodejs.org
- **Google Chrome** instalado (lo usa internamente)
- El bot corre en tu computadora (debe estar prendida con internet)

---

## 🚀 Instalación

```bash
# 1. Entra a la carpeta
cd gasolina-bot

# 2. Instala dependencias
npm install

# 3. Arranca el bot
npm start
```

La primera vez aparece un **código QR** en la terminal.  
Ábrelo con WhatsApp → Dispositivos vinculados → Vincular dispositivo.

---

## 🚗 Configura los nombres de tus autos

Edita el archivo `cars.json` y pon los nombres reales:

```json
{
  "car1": { "name": "Jetta 🚗",  "lastKm": null },
  "car2": { "name": "Aveo 🚙",   "lastKm": null },
  "car3": { "name": "Ranger 🛻", "lastKm": null }
}
```

> ⚠️ Si ya tienes kilómetros guardados, no borres `lastKm` — el bot lo actualiza solo.

---

## 💬 Cómo usarlo en el grupo de WhatsApp

1. Agrega el número del bot al grupo
2. Escribe `/start`
3. El bot te guía paso a paso:
   - Elige el auto (1, 2 o 3)
   - Escribe el kilometraje del odómetro
   - Escribe los litros cargados
   - Escribe lo que pagaste
4. El bot responde con el reporte completo

### Ejemplo de reporte:
```
━━━━━━━━━━━━━━━━━━━━━
⛽ Reporte de Gasolina
Jetta 🚗
━━━━━━━━━━━━━━━━━━━━━

🛣️  Km recorridos:    480 km
🪣  Litros cargados:  40.00 L
💰  Total pagado:     $920.00

🟢 Rendimiento:  12.00 km/L

📊 Precio por litro: $23.00/L
📊 Costo por km:     $1.92/km

📍 Nuevo odómetro:   45,800 km
━━━━━━━━━━━━━━━━━━━━━
```

---

## 🎨 Indicador de rendimiento

| Color | Rendimiento |
|-------|-------------|
| 🟢 Verde | 14+ km/L (excelente) |
| 🟡 Amarillo | 11–13 km/L (normal) |
| 🔴 Rojo | menos de 11 km/L (revisar) |

> Ajusta estos valores en `index.js` línea ~107 según tu tipo de auto.

---

## 🔄 Primer uso de cada auto

La primera vez que registres un auto, el bot solo guarda el kilometraje inicial. El rendimiento se calcula a partir de la **segunda carga** en adelante.

---

## ❓ Problemas comunes

**El bot no responde en el grupo**  
→ Asegúrate de que el número del bot esté en el grupo.

**La sesión se cierra**  
→ Vuelve a correr `npm start`. La sesión se guarda en `.wwebjs_auth/`.

**Quiero reiniciar el kilometraje de un auto**  
→ Edita `cars.json` y pon `"lastKm": null` en ese auto.
