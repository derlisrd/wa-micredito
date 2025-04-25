const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const app = express();
const PORT = 3000;

app.use(express.json());

// Inicializa el cliente de WhatsApp
const client = new Client({
  authStrategy: new LocalAuth()
});

// Muestra el QR para iniciar sesión
client.on('qr', qr => {
  console.log('📲 Escanea el siguiente QR con tu WhatsApp:');
  qrcode.generate(qr, { small: true });
});

// Indica que el bot está listo
client.on('ready', () => {
  console.log('✅ Bot conectado a WhatsApp');
});

// Endpoint para enviar mensaje
app.post('/send-message', async (req, res) => {
  const { number, text } = req.body;

  if (!number || !text) {
    return res.status(400).json({ success: false, message: 'Falta número o mensaje.' });
  }

  const formattedNumber = number.includes('@c.us') ? number : number.replace('+', '') + '@c.us';

  try {
    await client.sendMessage(formattedNumber, text);
    return res.status(200).json({ success: true, message: 'Mensaje enviado.' });
  } catch (error) {
    console.error('❌ Error al enviar el mensaje:', error);
    return res.status(500).json({ success: false, message: 'Error al enviar el mensaje.' });
  }
});

// Inicia el servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});

// Inicia WhatsApp
client.initialize();
