# 🤖 Bot de gasolina en Telegram (transporte alterno)

Reusa **el mismo motor** (`gasolina-logic.js`) y **el mismo Supabase** que el de WhatsApp.
Los autos y el historial son **los mismos datos**. WhatsApp queda intacto.

> Por qué Telegram: gratis, oficial, notificaciones push perfectas, sin QR/440/ban,
> multi-usuario trivial. Tus 3 cuentas hablan con el mismo bot.

---

## Pasos (5 min)

### 1. Crear el bot
1. En Telegram escribe a **@BotFather** → `/newbot`.
2. Dale nombre y usuario → te da un **token** (`123456:ABC...`).

### 2. Sacar los chat IDs de tus 3 cuentas
- Desde cada cuenta, escribe a **@userinfobot** → te dice tu **ID numérico**.
- (O arranca el bot sin allowlist, manda un mensaje, y lee el ID en el log.)

### 3. Configurar variables
Copia `.env.example` y llena:
```
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_ALLOWED_IDS=11111111,22222222,33333333   # tus 3 IDs
SUPABASE_URL=...
SUPABASE_KEY=...
LINK_CARPETA_SEGUROS=        # opcional
```

### 4. Correr
```bash
cd cloud-api
npm install
npm run start:telegram
```
Usa **polling** → no necesita URL pública. En Render: crea un **Background Worker**
con start command `node bot-telegram.js`.

### 5. Usar
Desde cualquiera de tus 3 cuentas, al bot:
- `/start` → menú de autos, o `/start 1 45320` directo.
- Express: `tiida km 45320 lts 40 900`.
- `/aceite`, `/llantas`, `/poliza`, `/seguros`, `/registro`.

Mismos comandos y mensajes que el WhatsApp.

---

## Dejarlo en un GRUPO

1. **Desactiva privacy mode** (clave): @BotFather → `/setprivacy` → tu bot → **Disable**.
   Sin esto el bot solo ve comandos, NO los mensajes express (`tiida km 45320 lts 40 900`).
2. **Mete el bot al grupo** (Añadir miembros → @TuBot). Si ya estaba antes de desactivar
   privacy → sácalo y vuélvelo a meter. Alternativa: hazlo **admin** (también ve todo).
3. **Saca el ID del grupo**: mete `@RawDataBot` al grupo y lee el id (negativo, ej `-1001234567`),
   o míralo en el log del bot.
4. **Allowlist**: pon ese id de grupo en `TELEGRAM_ALLOWED_IDS` (solo el grupo).
5. Deploy igual: Render Background Worker → `node bot-telegram.js`.

> En grupo la **sesión es compartida** (un solo flujo para los 3), igual que el WhatsApp original
> con `GRUPO_PERMITIDO`. Los comandos `/seguros@TuBot` ya se normalizan en el código.

## Notas
- **Sesión** es por cuenta (cada quien su flujo). **Autos/historial** se comparten (Supabase).- Para volver a WhatsApp en el futuro: ahí sigue (`webhook-ejemplo.js` / `../bot.js`), sin tocar.
- Puedes correr **los dos a la vez** (Telegram worker + WhatsApp) sobre el mismo Supabase.
- Si quitas `TELEGRAM_ALLOWED_IDS`, cualquiera que halle el bot lo usa. Déjalo con tus 3 IDs.
