import express from "express";
import whatsapp from "whatsapp-web.js";
const { Client, LocalAuth } = whatsapp;
import qrcode from "qrcode-terminal";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const apiKeyMiddleware = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  const VALID_API_KEY = process.env.API_KEY;
  if (apiKey !== VALID_API_KEY) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
};

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "./session" }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

client.on("qr", (qr) => {
  console.log("🔐 Escaneá este QR con WhatsApp:");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("Cliente conectado a WhatsApp");
});

client.on("auth_failure", () => {
  console.error("Fallo de autenticación");
});

client.on("disconnected", (reason) => {
  console.log("Desconectado:", reason);
});

client.initialize();

// Ruta para enviar mensajes
app.post("/send", apiKeyMiddleware, async (req, res) => {
  const { number, text } = req.body;

  if (!number || !text) {
    return res.status(400).json({ success: false, message: "Faltan datos" });
  }

  try {
    const fullNumber = number.includes("@c.us") ? number : number.replace(/\D/g, "") + "@c.us";
    await client.sendMessage(fullNumber, text);
    res.json({ success: true, message: "Mensaje enviado" });
  } catch (err) {
    console.error("Error al enviar mensaje:", err);
    res.status(500).json({ success: false, message: "Error al enviar mensaje" });
  }
});


app.post("/send/grupo-noti", apiKeyMiddleware, async (req, res) => {
  // 1. Extraemos el texto del body (usamos POST para enviar datos)
  const { text, name } = req.body;

  if (!text || !name) {
    return res.status(400).json({ success: false, message: "Falta el campo 'text' en el body" });
  }

  try {
    // 2. Obtenemos todos los chats
    const chats = await client.getChats();

    // 3. Buscamos el grupo que se llame exactamente "noti"
    const grupo = chats.find((chat) => chat.isGroup && chat.name === name);

    // 4. Validamos si lo encontramos
    if (!grupo) {
      return res.status(404).json({
        success: false,
        message: "No se encontró ningún grupo con el nombre 'noti'",
      });
    }

    // 5. Enviamos el mensaje usando el ID serializado del grupo encontrado
    await client.sendMessage(grupo.id._serialized, text);

    res.json({
      success: true,
      message: `Mensaje enviado al grupo: ${grupo.name}`,
      groupId: grupo.id._serialized,
    });
  } catch (err) {
    console.error("Error al procesar el envío al grupo:", err);
    res.status(500).json({ success: false, message: "Error interno al enviar el mensaje" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor API WhatsApp corriendo en http://localhost:${PORT}`);
});
