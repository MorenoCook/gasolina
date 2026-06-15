#!/usr/bin/env bash
# Enviar una plantilla aprobada con WhatsApp Cloud API (jun 2026, v23.0).
# Uso:  source ../.env  &&  ./enviar-plantilla.sh
set -euo pipefail

: "${PHONE_NUMBER_ID:?falta PHONE_NUMBER_ID}"
: "${ACCESS_TOKEN:?falta ACCESS_TOKEN}"
: "${OWNER_NUMBER:?falta OWNER_NUMBER}"
GRAPH_VERSION="${GRAPH_VERSION:-v23.0}"

curl -sS -X POST "https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"messaging_product\": \"whatsapp\",
    \"to\": \"${OWNER_NUMBER}\",
    \"type\": \"template\",
    \"template\": {
      \"name\": \"recordatorio_mantenimiento\",
      \"language\": { \"code\": \"es_MX\" },
      \"components\": [
        { \"type\": \"body\", \"parameters\": [
          { \"type\": \"text\", \"text\": \"Jetta\" },
          { \"type\": \"text\", \"text\": \"cambio de aceite\" },
          { \"type\": \"text\", \"text\": \"95,000\" }
        ]}
      ]
    }
  }"
echo
