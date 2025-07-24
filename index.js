import express from 'express';
import whatsapp from 'whatsapp-web.js';
const { Client, LocalAuth } = whatsapp;
import qrcode from 'qrcode-terminal';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const apiKeyMiddleware = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  const VALID_API_KEY = process.env.API_KEY;
  if (apiKey !== VALID_API_KEY) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
};

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './session' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', (qr) => {
  console.log('🔐 Escaneá este QR con WhatsApp:');
  qrcode.generate(qr, { small: true });
});


client.on('ready', () => {
  console.log('Cliente conectado a WhatsApp');
});

client.on('auth_failure', () => {
  console.error('Fallo de autenticación');
});

client.on('disconnected', (reason) => {
  console.log('Desconectado:', reason);
});




client.on('message', async (message) => {
  // Ignorar mensajes enviados por el propio bot para evitar bucles infinitos
  if (message.fromMe) {
    return;
  }

  // Ignorar mensajes si provienen de un grupo
  if (message.isGroup) {
    console.log(`Mensaje recibido en grupo de ${message.from}: ${message.body} (Ignorado)`);
    return;
  }

  console.log(`Mensaje recibido en privado de ${message.from}: ${message.body}`);

  // Mensaje de respuesta predefinido
  const responseMessage = 'Por favor comuniquese con ATC 0985713544';

  try {
    // Envía el mensaje de respuesta al remitente del mensaje original
    await client.sendMessage(message.from, responseMessage);
    console.log(`Respuesta enviada a ${message.from}: ${responseMessage}`);
  } catch (err) {
    console.error(`Error al enviar la respuesta a ${message.from}:`, err);
  }
});


client.initialize();

// Ruta para enviar mensajes
app.post('/send',apiKeyMiddleware, async (req, res) => {
  const { number, text } = req.body;

  if (!number || !text) {
    return res.status(400).json({ success: false, message: 'Faltan datos' });
  }

  try {
    const fullNumber = number.includes('@c.us') ? number : number.replace(/\D/g, '') + '@c.us';
    await client.sendMessage(fullNumber, text);
    res.json({ success: true, message: 'Mensaje enviado' });
  } catch (err) {
    console.error('Error al enviar mensaje:', err);
    res.status(500).json({ success: false, message: 'Error al enviar mensaje' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor API WhatsApp corriendo en http://localhost:${PORT}`);
});
