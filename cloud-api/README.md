# ⛽ Gasolina Bot — Migración a WhatsApp Cloud API (oficial Meta)

> Carpeta **independiente**. No toca el bot actual (`../bot.js`, Baileys).
> Aquí está la ruta para mover el bot a la **API oficial** con un **número dedicado**,
> y así dejar de robar tus notificaciones personales, sin QR, sin loop 440, sin Supabase-auth.
>
> **Vigente a: 14 de junio de 2026** · Graph API **v23.0** · pricing por-mensaje.

---

## ¿Por qué Cloud API en vez de Baileys?

| | Baileys (actual) | Cloud API (oficial) |
|---|---|---|
| Cuenta | TU número personal (vinculado) | Número **dedicado** de negocio |
| Roba tus notificaciones | Sí | No |
| Conexión | WebSocket 24/7 (proceso vivo) | Webhook (Meta te empuja) |
| Hosting | Render persistente | Render **o** Cloudflare Workers (serverless) |
| QR / 440 / sesión | Sí, frágil | No existe |
| Riesgo de ban | Alto (no oficial) | Bajo (oficial) |
| Costo | Gratis | Gratis dentro de ventana 24h; plantillas proactivas se cobran |

> ⚠️ El número que uses para Cloud API **no puede** estar registrado en la app normal de
> WhatsApp ni en WhatsApp Business. Usa una **SIM/eSIM nueva** o el número de prueba que da Meta.

---

## Pasos resumidos — conectar TODO

### 0. Requisitos
- Cuenta Meta + **Meta Business Manager** (business.facebook.com).
- Un **número dedicado** con SMS/llamada para verificar (o usa el número de prueba gratis de Meta).
- Un endpoint público HTTPS para el webhook (Render o Cloudflare Worker — ver `webhook-ejemplo.js`).

### 1. Crear la App
1. https://developers.facebook.com → **Mis Apps → Crear app → tipo "Empresa/Business"**.
2. Dentro de la app → **Agregar producto → WhatsApp → Configurar**.
3. Meta crea automáticamente una **WhatsApp Business Account (WABA)** de prueba y un
   **número de prueba** gratis (manda hasta 5 destinatarios de prueba, sin costo).

### 2. Anotar los IDs y el token
En el panel **WhatsApp → API Setup** copia:
- **Phone Number ID** → `PHONE_NUMBER_ID`
- **WhatsApp Business Account ID** → `WABA_ID`
- **Temporary access token** (dura 24 h) → `ACCESS_TOKEN` (para pruebas; luego el permanente, paso 6)

### 3. Prueba de humo (template pre-aprobado `hello_world`)
```bash
curl -X POST 'https://graph.facebook.com/v23.0/PHONE_NUMBER_ID/messages' \
  -H 'Authorization: Bearer ACCESS_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "messaging_product": "whatsapp",
    "to": "5214111103705",
    "type": "template",
    "template": { "name": "hello_world", "language": { "code": "en_US" } }
  }'
```
Si la respuesta trae `messages[0].id` → conectado. (`to` = número con código país, sin `+`.)

### 4. Configurar el Webhook (recibir mensajes)
1. Despliega `webhook-ejemplo.js` (Render) **o** la versión Worker (Cloudflare). Define un
   `WEBHOOK_VERIFY_TOKEN` inventado por ti (cualquier string secreto).
2. En la app → **WhatsApp → Configuration → Webhook → Edit**:
   - **Callback URL:** `https://tu-dominio/webhook`
   - **Verify token:** el mismo `WEBHOOK_VERIFY_TOKEN`.
3. Click **Verify and Save** (Meta hace un GET de verificación → tu endpoint responde el `challenge`).
4. **Subscribe** al campo **`messages`** (es el que trae mensajes entrantes + estados).

### 5. Registrar TU número dedicado (si no usas el de prueba)
1. **WhatsApp → API Setup → Add phone number** → verifica por SMS/llamada.
2. Define un **PIN de 6 dígitos** (two-step) — lo pide al registrar.
3. Tu nuevo Phone Number ID reemplaza al de prueba en `.env`.

### 6. Token PERMANENTE (el temporal muere en 24 h)
1. **Business Settings → Users → System users → Add** (rol Admin).
2. **Assign assets** → tu WABA → permiso **Full control / manage**.
3. **Generate new token** → selecciona la app → permisos:
   `whatsapp_business_messaging` + `whatsapp_business_management`.
4. Copia ese token (no expira) → `ACCESS_TOKEN`.

### 7. Pasar variables al hosting
Copia `.env.example` → configura en Render (o `wrangler secret put` en Cloudflare). Listo.

---

## Flujo de costos (resumen)
- Usuario te escribe → abre **ventana de 24 h** → respondes **texto libre GRATIS** (categoría *service*).
- Para escribir TÚ primero fuera de esa ventana (ej. recordatorio de aceite/seguro) → necesitas
  **plantilla aprobada** (categoría *utility*, barata). Ver `PLANTILLAS.md`.
- Límite inicial: **250 conversaciones únicas/día**, escala automático con buen uso.

Para el bot de gasolina: casi todo cae en *service* (respondes cuando registras carga, gratis).
Solo los **recordatorios proactivos** usan plantilla *utility*.

---

## Archivos de esta carpeta
- `README.md` — esto.
- `PLANTILLAS.md` — categorías, cómo crear plantillas y aprobarlas (jun 2026).
- `.env.example` — variables.
- `webhook-ejemplo.js` — webhook mínimo Node/Express (recibir + responder).
- `enviar-plantilla.sh` — curl para mandar una plantilla.

## Fuentes (jun 2026)
- [Meta — WhatsApp Cloud API Get Started](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started)
- [Meta — Template categorization](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization)
- [WhatsApp API Message Templates Guide 2026 (YCloud)](https://www.ycloud.com/blog/whatsapp-api-message-template-guide)
- [WhatsApp Per-Message Pricing Update — ene 1 2026 (AiSensy)](https://m.aisensy.com/blog/whatsapp-per-message-pricing-update-effective-january-1-2026/)
