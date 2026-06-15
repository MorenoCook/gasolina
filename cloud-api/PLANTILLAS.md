# 📋 Plantillas (Message Templates) — WhatsApp Cloud API

> Vigente a **14 de junio de 2026** · Graph API **v23.0** · pricing **por-mensaje**.

---

## ¿Cuándo necesitas plantilla?

- **Dentro** de la ventana de 24 h (el usuario te escribió hace <24 h) → mandas **texto libre**,
  categoría *service*, **gratis**. No necesitas plantilla.
- **Fuera** de esa ventana (tú inicias la conversación) → **obligatorio** usar una **plantilla
  pre-aprobada**. Ej.: recordatorio de aceite/llantas/seguro disparado por el bot.

---

## Las 4 categorías

| Categoría | Para qué | Costo (relativo) |
|---|---|---|
| **service** | Responder dentro de la ventana 24 h (texto libre) | **Gratis** |
| **utility** | Aviso disparado por acción/estado del usuario: recordatorios, confirmaciones, alertas | Barato (~80-90% menos que marketing) |
| **authentication** | OTP / códigos de verificación | Barato |
| **marketing** | Promos, ofertas | Más caro |

> El **país del destinatario** define la tarifa (no el tuyo). México = tarifa MX.
> ⚠️ Meta a veces **reclasifica** plantillas *utility* → *marketing* si el texto suena promocional.
> Mantén el texto seco y transaccional para que quede *utility*.

**Para el bot de gasolina** todos los recordatorios proactivos = **utility**.

---

## Cómo crear una plantilla

### Opción A — Panel (más fácil)
1. **business.facebook.com → WhatsApp Manager → Plantillas de mensajes → Crear plantilla**.
2. Elige **Categoría = Utility**, **Idioma = Español (MX) `es_MX`**, nombre en minúsculas con guion
   bajo (ej. `recordatorio_mantenimiento`).
3. Escribe el cuerpo con variables `{{1}}`, `{{2}}`… y da **un ejemplo** de cada variable
   (Meta lo exige para aprobar).
4. **Enviar** → aprobación normalmente en minutos a 24 h.

### Opción B — API
```bash
curl -X POST 'https://graph.facebook.com/v23.0/WABA_ID/message_templates' \
  -H 'Authorization: Bearer ACCESS_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "recordatorio_mantenimiento",
    "language": "es_MX",
    "category": "UTILITY",
    "components": [
      {
        "type": "BODY",
        "text": "Hola, recordatorio de mantenimiento de tu {{1}}: {{2}} a los {{3}} km. Responde aquí para registrar la próxima carga.",
        "example": { "body_text": [["Jetta", "cambio de aceite", "95,000"]] }
      }
    ]
  }'
```

---

## Plantillas sugeridas para el bot

### 1. `recordatorio_mantenimiento` (UTILITY, es_MX)
```
Hola, recordatorio de mantenimiento de tu {{1}}: {{2}} a los {{3}} km.
Responde aquí para registrar la próxima carga.
```
Variables: `{{1}}`=auto, `{{2}}`=tipo (aceite/llantas), `{{3}}`=km límite.

### 2. `seguro_por_vencer` (UTILITY, es_MX)
```
Aviso: el seguro de tu {{1}} vence en {{2}} días ({{3}}).
Renueva a tiempo para no quedar sin cobertura.
```

### 3. `resumen_semanal` (UTILITY, es_MX)
```
Resumen semanal {{1}}: recorriste {{2}} km, gastaste ${{3}} en gasolina,
rendimiento promedio {{4}} km/L.
```

---

## Enviar una plantilla (ya aprobada)
```bash
curl -X POST 'https://graph.facebook.com/v23.0/PHONE_NUMBER_ID/messages' \
  -H 'Authorization: Bearer ACCESS_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "messaging_product": "whatsapp",
    "to": "5214111103705",
    "type": "template",
    "template": {
      "name": "recordatorio_mantenimiento",
      "language": { "code": "es_MX" },
      "components": [
        { "type": "body", "parameters": [
          { "type": "text", "text": "Jetta" },
          { "type": "text", "text": "cambio de aceite" },
          { "type": "text", "text": "95,000" }
        ]}
      ]
    }
  }'
```

---

## Reglas y gotchas (jun 2026)
- **Idioma exacto:** el `language.code` al enviar debe ser idéntico al de la plantilla (`es_MX`).
- **Variables:** el número y orden de `parameters` debe coincidir con los `{{n}}` o falla.
- **Aprobación:** plantillas con texto vago, URLs raras o tono promo en *utility* → rechazo o
  reclasificación a *marketing* (más caro).
- **Bots IA general:** prohibidos desde ene 2026; bots task-specific (como este de gasolina) OK.
- **Límite inicial:** 250 conversaciones únicas/día, escala con buen historial.

## Fuentes
- [Meta — Template categorization](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization)
- [WhatsApp API Message Templates Guide 2026 (YCloud)](https://www.ycloud.com/blog/whatsapp-api-message-template-guide)
- [Pricing update ene 1 2026 (AiSensy)](https://m.aisensy.com/blog/whatsapp-per-message-pricing-update-effective-january-1-2026/)
