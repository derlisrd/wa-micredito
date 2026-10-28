# wa-micredito

API HTTP chica para enviar mensajes de WhatsApp usando [`whatsapp-web.js`](https://github.com/wwebjs/whatsapp-web.js) (WhatsApp Web automatizado con Puppeteer).

## Endpoints

| Método | Ruta                 | Auth (`x-api-key`) | Descripción                                      |
| ------ | -------------------- | ------------------ | ------------------------------------------------ |
| GET    | `/health`            | No                 | Health-check simple (`200` conectado / `503` no) |
| GET    | `/status`            | Sí                 | Estado detallado del cliente y la reconexión     |
| POST   | `/restart`           | Sí                 | Fuerza el reinicio del cliente de WhatsApp       |
| POST   | `/send`              | Sí                 | `{ "number": "595981123456", "text": "..." }`    |
| POST   | `/send/grupo-noti`   | Sí                 | `{ "name": "noti", "text": "..." }`              |

Si WhatsApp no está conectado, `/send` y `/send/grupo-noti` esperan hasta
`SEND_WAIT_MS` a que termine una reconexión y, si no vuelve, responden `503`
para que el cliente que llama reintente (no pierden el mensaje en silencio).

Todas las rutas salvo `/health` requieren el header `x-api-key`. Si se supera el
límite de requests, la API responde `429` con `Retry-After` y los headers
`RateLimit-Limit`, `RateLimit-Remaining` y `RateLimit-Reset` (ver
[Rate limiting](#rate-limiting)).

## Qué pasa si el servicio falla

El cliente de WhatsApp se cae por muchos motivos: se cierra Chromium, la sesión
queda "detached", el teléfono se queda sin batería, WhatsApp Web cambia de
versión, etc. Antes, cualquiera de esos casos dejaba el proceso "vivo" pero
inservible hasta reiniciarlo a mano. Ahora hay tres capas:

### 1. Reconexión automática del cliente

`services/whatsapp.js` maneja el ciclo de vida del cliente y reacciona a:

- `disconnected` (logout, conflicto de sesión, teléfono desvinculado).
- `auth_failure`.
- Error o timeout en `client.initialize()`.
- Cierre inesperado del navegador de Chromium.
- `SingletonLock` de Chrome huérfano (el proceso anterior murió con `SIGKILL` o
  el VPS se reinició). Si el lock apunta a un PID muerto lo limpia solo; si el
  PID sigue vivo, avisa que hay otra instancia usando la misma sesión.
- Errores de envío típicos de sesión rota (`detached Frame`, `Target closed`,
  `Protocol error`, etc.).

En cada caso destruye el cliente (y mata el proceso de Chromium si `destroy()`
se cuelga, para no dejar zombies) y vuelve a conectar con **backoff exponencial
+ jitter** (`RECONNECT_MIN_DELAY_MS` → `RECONNECT_MAX_DELAY_MS`).

### 2. Watchdog de salud

Cada `WATCHDOG_INTERVAL_MS` (30 s por defecto) verifica:

- Que el navegador siga conectado.
- Que `client.getState()` devuelva `CONNECTED` (con timeout de 15 s para detectar
  cuelgues).
- Que la generación de QR no se haya quedado estancada (10 min sin un QR nuevo).
- Que una conexión no quede estancada más de `INIT_TIMEOUT_MS`.

Si falla 3 veces seguidas (o el estado no es `CONNECTED`), reinicia el cliente.

### 3. Reinicio del proceso (supervisor)

Si se agotan los `MAX_RECONNECT_ATTEMPTS` intentos, o hay un
`uncaughtException`, el proceso avisa y sale con código 1.
Para que vuelva solo necesita un supervisor: se incluye `ecosystem.config.cjs`
para **pm2** (`autorestart`, backoff y límite de memoria).

Las promesas rechazadas sin manejar (habituales dentro de `whatsapp-web.js`
cuando se destruye el navegador) se registran y se avisan, pero **no** tumban el
proceso: de la reconexión se encargan las capas 1 y 2.

```bash
npm install -g pm2
npm run pm2:start
npm run pm2:status
npm run pm2:logs
```

Sin pm2 el proceso queda detenido; el aviso por webhook/Telegram igual sale.

## Avisos (alertas)

Todo aviso se escribe en consola y, opcionalmente, en `LOG_FILE`. Además se
puede configurar uno o varios canales en `.env`:

| Variable              | Canal                                                        |
| --------------------- | ------------------------------------------------------------ |
| `ADMIN_NOTIFY_NUMBER` | WhatsApp al número indicado (se encola si está desconectado) |
| `ALERT_WEBHOOK_URL`   | `POST` JSON a cualquier URL (Slack, n8n, Discord, etc.)      |
| `ALERT_WEBHOOK_TOKEN` | `Authorization: Bearer ...` para el webhook                  |
| `TELEGRAM_BOT_TOKEN`  | Bot de Telegram                                              |
| `TELEGRAM_CHAT_ID`    | Chat que recibe los avisos de Telegram                       |

Payload del webhook:

```json
{
  "service": "wa-micredito",
  "host": "mi-maquina",
  "level": "error",
  "key": "connection",
  "text": "[mi-maquina] [wa-micredito] WhatsApp se desconectó (...)",
  "timestamp": "2026-10-28T12:00:00.000Z"
}
```

Los avisos repetidos con la misma `key` se silencian durante
`ALERT_THROTTLE_MS` (60 s) para no inundar. Al reconectar se envía un aviso de
recuperación y se descargan los avisos que quedaron en cola por WhatsApp.

**Importante:** si WhatsApp está caído, el aviso por WhatsApp no puede salir en
ese momento. Por eso se encola y se manda al reconectar; si querés enterarte
mientras está caído, configurá webhook o Telegram.

## Configuración

1. Copiar `.env.example` a `.env` y completar los valores.
2. `pnpm install` (o `npm install`)
3. Si al arrancar dice *"Could not find Chrome"*:
   `npx puppeteer browsers install chrome`
4. `pnpm start` (o `npm start`); en producción `pnpm pm2:start`.
5. Escanear el QR que aparece en la terminal.

Variables principales:

| Variable                  | Default   | Descripción                                     |
| ------------------------- | --------- | ----------------------------------------------- |
| `PORT`                    | `3000`    | Puerto HTTP                                     |
| `HOST`                    | `0.0.0.0` | Interfaz de escucha (en VPS: `127.0.0.1`)       |
| `TRUST_PROXY`             | `false`   | `loopback` detrás de Nginx/Caddy                |
| `API_KEY`                 | —         | Obligatoria; sin ella todas las rutas dan 401   |
| `SESSION_PATH`            | `./session` | Carpeta de la sesión de WhatsApp              |
| `REQUEST_TIMEOUT_MS`      | `60000`   | Timeout por request HTTP                        |
| `RATE_LIMIT_ENABLED`      | `true`    | Activa/desactiva el rate limiting               |
| `RATE_LIMIT_MAX`          | `120`     | Requests por ventana (general)                  |
| `RATE_LIMIT_SEND_MAX`     | `30`      | Envíos por ventana                              |
| `RATE_LIMIT_RESTART_MAX`  | `5`       | Reinicios por minuto                            |
| `WATCHDOG_INTERVAL_MS`    | `30000`   | Frecuencia del watchdog                         |
| `MAX_RECONNECT_ATTEMPTS`  | `20`      | Intentos antes de reiniciar el proceso (`0` = ∞) |
| `RECONNECT_MIN_DELAY_MS`  | `5000`    | Primer delay de reconexión                      |
| `RECONNECT_MAX_DELAY_MS`  | `60000`   | Delay máximo                                    |
| `SEND_WAIT_MS`            | `10000`   | Espera máxima por reconexión al enviar          |
| `GROUP_CACHE_TTL_MS`      | `600000`  | Caché del id de grupo por nombre                |
| `LOG_FILE`                | —         | Archivo de log (vacío = solo consola)           |

## Rate limiting

La API limita por **IP** con ventanas en memoria (no necesita Redis porque corre
en un solo proceso). Hay tres límites:

| Límite    | Aplica a                          | Variable                  | Default |
| --------- | --------------------------------- | ------------------------- | ------- |
| General   | Todas las rutas (menos `/health`) | `RATE_LIMIT_MAX`          | 120/min |
| Envíos    | `/send` y `/send/grupo-noti`      | `RATE_LIMIT_SEND_MAX`     | 30/min  |
| Reinicios | `/restart`                        | `RATE_LIMIT_RESTART_MAX`  | 5/min   |

Al superar el límite responde `429`:

```json
{
  "success": false,
  "message": "Límite de envíos alcanzado. Esperá antes de mandar más mensajes (protege tu número de WhatsApp).",
  "retryAfterSeconds": 60
}
```

Headers en todas las respuestas: `RateLimit-Limit`, `RateLimit-Remaining` y
`RateLimit-Reset`. En los `429` también `Retry-After`.

- `RATE_LIMIT_ENABLED=false` desactiva todo (no recomendado en producción).
- El límite de envíos es el más importante: mandar cientos de mensajes por
  minuto aumenta el riesgo de que WhatsApp bloquee el número.
- Detrás de un proxy configurá `TRUST_PROXY=loopback` para que se use la IP real
  del cliente y no `127.0.0.1` (si no, todos comparten el mismo contador).
- Al reiniciar el proceso se reinician los contadores (es en memoria).
- Nginx tiene una segunda capa con `limit_req` en el ejemplo de despliegue.

## Despliegue en un VPS

Arquitectura recomendada:

```
apps / clientes
      │ HTTPS
      ▼
  Nginx o Caddy  ──►  127.0.0.1:3005  (Node + whatsapp-web.js + Chromium)
```

El puerto de Node **no se expone a internet**: solo el proxy. Chrome corre
headless y consume RAM, por eso conviene un VPS de **2 vCPU / 2 GB** como mínimo
(con 1 GB agregá swap).

### 1. Preparar el servidor

```bash
# Ubuntu 22.04/24.04, como usuario con sudo
sudo adduser --disabled-password --gecos "" wa
sudo usermod -aG sudo wa
su - wa

# Node 22 LTS + pnpm
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx
sudo npm install -g pm2 pnpm

git clone <tu-repo> wa-micredito && cd wa-micredito
pnpm install
sudo npx puppeteer browsers install chrome --install-deps
```

> `--install-deps` instala las librerías de sistema que Chrome necesita en
> Linux. Se ejecuta una sola vez.

### 2. Configurar `.env`

```env
PORT=3005
HOST=127.0.0.1
TRUST_PROXY=loopback
API_KEY=<clave larga y aleatoria>
RATE_LIMIT_MAX=120
RATE_LIMIT_SEND_MAX=30
ADMIN_NOTIFY_NUMBER=595981123456
ALERT_WEBHOOK_URL=https://...        # opcional pero recomendado
LOG_FILE=./logs/wa-micredito.log
```

### 3. pm2 (reinicio automático y arranque con el VPS)

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup            # ejecutá el comando que imprime
pm2 logs wa-micredito  # acá aparece el QR para escanear
```

### 4. Nginx + TLS

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/wa-micredito
sudo sed -i 's/wa.tudominio.com/TU_DOMINIO/g' /etc/nginx/sites-available/wa-micredito
sudo ln -s /etc/nginx/sites-available/wa-micredito /etc/nginx/sites-enabled/
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d TU_DOMINIO
sudo nginx -t && sudo systemctl reload nginx
```

Alternativa más simple con TLS automático: `deploy/Caddyfile.example`.

### 5. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
# NO abras 3005: Node solo escucha en 127.0.0.1
```

### 6. Verificar y usar

```bash
curl https://TU_DOMINIO/health
curl -H "x-api-key: $API_KEY" https://TU_DOMINIO/status
curl -X POST https://TU_DOMINIO/send \
  -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"number":"595981123456","text":"hola"}'
```

Desde tus apps, guardá la URL y la API key en variables de entorno y tratá el
`429`/`503` como reintentable (respetando `Retry-After`):

```js
const BASE = process.env.WA_API_URL; // https://TU_DOMINIO
const KEY = process.env.WA_API_KEY;

export async function enviarWhatsApp(number, text, intentos = 3) {
  for (let intento = 1; intento <= intentos; intento += 1) {
    const res = await fetch(`${BASE}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ number, text }),
    });

    if (res.ok) return res.json();

    const data = await res.json().catch(() => ({}));
    if (res.status === 429 || res.status === 503) {
      const espera = Number(
        res.headers.get("retry-after") ?? data.retryAfterSeconds ?? intento * 2,
      );
      await new Promise((resolve) => setTimeout(resolve, espera * 1000));
      continue;
    }

    throw new Error(`WhatsApp API ${res.status}: ${data.message}`);
  }

  throw new Error("No se pudo enviar el mensaje tras varios intentos");
}
```

## Pruebas

```bash
pnpm test
# o
npm test
```

Los tests cubren el ciclo de vida del cliente con un cliente falso (conexión,
desconexión, watchdog, timeouts, intentos agotados, errores de envío y locks
huérfanos de Chrome), rate limiting y los avisos (webhook, throttle y cola de
WhatsApp). No necesitan Chrome ni una cuenta real.

## Notas

- Solo puede haber **un proceso** usando la misma sesión: pm2 está configurado
  con `instances: 1`. Dos instancias pelean por la sesión y se desconectan.
- `services/groq.js` y `services/cerebras.js` no se usan desde la API, quedaron
  como utilidades.
- `API_KEY` ahora falla cerrado: si la variable no está definida, toda petición
  autenticada devuelve 401.
