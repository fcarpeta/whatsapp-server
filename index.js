const express = require('express');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode'); // usamos qrcode para generar imagen
const { Client, LocalAuth, MessageMedia, Buttons } = require('whatsapp-web.js');
const csv = require('csv-parser');

const app = express();
const port = process.env.PORT || 10000;
const authPath = path.join(__dirname, '.wwebjs_auth');
const estadoUsuarios = {};
let numerosPermitidos = new Set();
let qrCodeData = null; // guardar último QR

// ?? Cargar CSV con números permitidos
function cargarNumerosDesdeCSV() {
  numerosPermitidos = new Set();
  fs.createReadStream('EnvioWS.csv')
    .pipe(csv())
    .on('data', (row) => {
      const celular = row.celular || row.numero || row.telefono;
      if (celular) {
        const numeroLimpio = celular.replace(/\D/g, '');
        if (numeroLimpio.length >= 10) {
          numerosPermitidos.add(numeroLimpio);
        }
      }
    })
    .on('end', () => {
      console.log(`?? Números cargados: ${numerosPermitidos.size}`);
    });
}
cargarNumerosDesdeCSV();

fs.watchFile('EnvioWS.csv', () => {
  console.log('?? CSV actualizado. Recargando...');
  cargarNumerosDesdeCSV();
});

// ?? Verificar carpeta de sesión
function checkSessionFolder() {
  try {
    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath);
    else fs.accessSync(authPath, fs.constants.W_OK);
  } catch (err) {
    console.log('?? Carpeta de sesión con error. Borrando...');
    try {
      fs.rmSync(authPath, { recursive: true, force: true });
      console.log('??? Sesión eliminada. Nuevo QR aparecerá.');
    } catch (e) {
      console.error('? No se pudo eliminar sesión:', e.message);
      process.exit(1);
    }
  }
}
checkSessionFolder();

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

// ?? Manejo de QR
client.on('qr', (qr) => {
  qrCodeData = qr;
  const baseUrl = process.env.RENDER_EXTERNAL_URL || `https://whatsapp-boot-cu8h.onrender.com`;
  console.log(`?? Escanea el QR en: ${baseUrl}/qr`);
});


client.on('ready', () => {
  qrCodeData = null;
  console.log('? Cliente de WhatsApp listo.');
});

client.on('auth_failure', (msg) => console.error('? Fallo de autenticación:', msg));
client.on('disconnected', (reason) => console.log('?? Cliente desconectado:', reason));

client.initialize();
app.use(express.json({ limit: '20mb' }));

// ?? Página principal
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Servidor WhatsApp</title>
	   <meta charset="UTF-8"></head>
      <body style="font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;">
        <h2>? Servidor WhatsApp funcionando</h2>
        <p><a href="/qr">?? Haz clic aquí para escanear el código QR</a></p>
      </body>
    </html>
  `);
});


// ?? Página para mostrar QR
app.get('/qr', async (req, res) => {
  if (!qrCodeData) {
    return res.send('? Cliente conectado o QR no generado.');
  }
  try {
    const qrImage = await qrcode.toDataURL(qrCodeData);
    res.send(`
      <html>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;">
          <h2>?? Escanea este código QR con WhatsApp</h2>
          <img src="${qrImage}" />
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('? Error generando QR.');
  }
});

// ?? Endpoint para enviar mensajes
app.post('/enviar', async (req, res) => {
  const { numero, mensaje, imagen } = req.body;

  try {
    const numeroLimpio = numero.replace(/\D/g, '');
    const numberId = await client.getNumberId(numeroLimpio);

    if (!numberId) {
      return res.status(400).send({ status: '?', error: 'Número no registrado en WhatsApp' });
    }

    const chatId = numberId._serialized;

    if (imagen && imagen.startsWith("data:")) {
      const matches = imagen.match(/^data:(.+);base64,(.+)$/);
      if (!matches || matches.length !== 3) {
        return res.status(400).send({ status: '?', error: 'Base64 mal formado' });
      }

      const media = new MessageMedia(matches[1], matches[2]);
      await client.sendMessage(chatId, media, { caption: mensaje });
    } else {
      await client.sendMessage(chatId, mensaje);
    }

    res.send({ status: '? Enviado', numero });

  } catch (err) {
    console.error("? Error al enviar:", err);
    res.status(500).send({ status: '? Error', error: err.toString() });
  }
});

// ?? Responder mensajes recibidos
client.on('message', async (msg) => {
  const numero = msg.from.replace('@c.us', '');
  const chatId = msg.from;
  const texto = msg.body.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

  console.log(`?? Mensaje de ${numero}: ${texto}`);

  if (!numerosPermitidos.has(numero)) {
    console.log(`?? Número ${numero} no está en el archivo. No se responde.`);
    return;
  }

  const positivos = ['si', 'sí', 'interesado', 'quiero informacion', 'quiero mas informacion', 'más informacion', 'mas informacion', 'informacion', 'de que se trata', 'como es', 'si estoy interesada', 'si estoy interesado', 'si me interesa'];
  const negativos = ['no', 'no estoy interesado', 'no me interesa', 'ya no me interesa', 'no gracias'];

  if (!estadoUsuarios[numero]) {
    if (positivos.includes(texto)) {
      estadoUsuarios[numero] = 'positivo';
      await msg.reply('Gracias por tu interés. Te enviaré más información.');

      // PDF
      const pdfPath = path.join(__dirname, 'material', 'PORTAFOLIO_SERVICIOS_PAC_2025.pdf');
      if (fs.existsSync(pdfPath)) {
        const mediaPdf = MessageMedia.fromFilePath(pdfPath);
        await client.sendMessage(chatId, mediaPdf, {
          caption: 'Plan Alfa: consulta médica domiciliaria + 12 especialidades + IPS a elección.'
        });
      }

      // Imagen
      const imgPath = path.join(__dirname, 'material', 'precios.jpeg');
      if (fs.existsSync(imgPath)) {
        const mediaImg = MessageMedia.fromFilePath(imgPath);
        await client.sendMessage(chatId, mediaImg, {
          caption: '?? ¿En qué momento le puedo llamar?'
        });
      }

      // Botones
      const botones = new Buttons(
        '¿Qué deseas hacer ahora?',
        [{ body: 'Ver más' }, { body: 'Contactar' }, { body: 'No gracias' }],
        'Información adicional',
        'Selecciona una opción'
      );
      await client.sendMessage(chatId, botones);

    } else if (negativos.includes(texto)) {
      estadoUsuarios[numero] = 'negativo';
      await msg.reply('Entendido. Si cambias de opinión, estoy para ayudarte.');
    } else {
      console.log('?? Mensaje no clasificado, ignorado.');
    }
  } else {
    console.log(`?? Usuario ${numero} ya registrado como ${estadoUsuarios[numero]}`);
  }
});

app.listen(port, () => {
  console.log(`?? Servidor corriendo en http://localhost:${port}`);
});
