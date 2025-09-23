const express = require('express');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia, Buttons } = require('whatsapp-web.js');
const csv = require('csv-parser');
const qrcode = require('qrcode');

const app = express();
const port = process.env.PORT || 3000;
const authPath = path.join(__dirname, '.wwebjs_auth');
const estadoUsuarios = {};
let numerosPermitidos = new Set();
let ultimoQR = null; // 👈 Guardamos el QR aquí

// Cargar CSV
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
      console.log(`📋 Numeros cargados: ${numerosPermitidos.size}`);
    });
}
cargarNumerosDesdeCSV();

// Vigilar CSV
fs.watchFile('EnvioWS.csv', () => {
  console.log('📂 CSV actualizado. Recargando...');
  cargarNumerosDesdeCSV();
});

// Verificar carpeta de sesión
function checkSessionFolder() {
  try {
    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath);
    else fs.accessSync(authPath, fs.constants.W_OK);
  } catch (err) {
    console.log('⚠️ Carpeta de sesión con error. Borrando...');
    try {
      fs.rmSync(authPath, { recursive: true, force: true });
      console.log('🗑️ Sesión eliminada. Nuevo QR aparecerá.');
    } catch (e) {
      console.error('❌ No se pudo eliminar sesión:', e.message);
      process.exit(1);
    }
  }
}
checkSessionFolder();

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

// Eventos del cliente
client.on('qr', async qr => {
  ultimoQR = await qrcode.toDataURL(qr); // 👈 Guardamos QR en base64
  console.log('👉 QR actualizado. Abre /qr para escanearlo.');
});

client.on('ready', () => console.log('✅ Cliente de WhatsApp listo.'));
client.on('auth_failure', msg => console.error('❌ Fallo de autenticación:', msg));
client.on('disconnected', reason => console.log('⚡ Cliente desconectado:', reason));

client.initialize();
app.use(express.json({ limit: '20mb' }));

// Rutas
app.get('/', (req, res) => res.send('🚀 Servidor WhatsApp funcionando.'));

app.get('/qr', (req, res) => {
  if (!ultimoQR) {
    return res.send('⏳ QR no disponible todavía, espera un momento...');
  }
  res.send(`
    <html>
      <body style="text-align:center; font-family: Arial">
        <h2>Escanea este QR con tu WhatsApp</h2>
        <img src="${ultimoQR}" />
        <p>(La página se actualizará sola cada 5 segundos)</p>
        <script>setTimeout(()=>location.reload(),5000)</script>
      </body>
    </html>
  `);
});

app.post('/enviar', async (req, res) => {
  const { numero, mensaje, imagen } = req.body;
  const chatId = `${numero}@c.us`;

  try {
    const isRegistered = await client.isRegisteredUser(chatId);
    if (!isRegistered) return res.status(400).send({ status: '❌', error: 'No tiene WhatsApp' });

    if (imagen && imagen.startsWith("data:")) {
      const matches = imagen.match(/^data:(.+);base64,(.+)$/);
      if (!matches || matches.length !== 3) return res.status(400).send({ status: '❌', error: 'Base64 mal formado' });

      const media = new MessageMedia(matches[1], matches[2]);
      await client.sendMessage(chatId, media, { caption: mensaje });
    } else {
      await client.sendMessage(chatId, mensaje);
    }

    res.send({ status: '✅ Enviado', numero });
  } catch (err) {
    console.error("❌ Error al enviar:", err);
    res.status(500).send({ status: '❌ Error', error: err.toString() });
  }
});

// Escuchar mensajes entrantes
client.on('message', async msg => {
  const numero = msg.from.replace('@c.us', '');
  const chatId = msg.from;
  const texto = msg.body.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

  console.log(`💬 Mensaje de ${numero}: ${texto}`);

  if (!numerosPermitidos.has(numero)) {
    console.log(`🚫 Numero ${numero} no está en el archivo, no se responde.`);
    return;
  }

  const positivos = ['si','sí','interesado','quiero informacion','quiero mas informacion','más informacion','mas informacion','informacion','de que se trata','como es','si estoy interesada','si estoy interesado'];
  const negativos = ['no','no estoy interesado','no me interesa','ya no me interesa','no gracias','no sra gracias','no señora gracias','ya no estoy interesada','no, no me interesa adquirirlo en este momento','no, no estoy interesado en ningún producto','no ya no estoy interesado muchas gracias','en el momento no me interesa'];

  if (!estadoUsuarios[numero]) {
    if (positivos.includes(texto)) {
      estadoUsuarios[numero] = 'positivo';
      await msg.reply('✅ Gracias por tu interés. Te enviaré más información sobre los planes.');

      // Enviar PDF
      const pdfPath = path.join(__dirname, 'material', 'Comparativo_PAC_medico_2023.pdf');
      if (fs.existsSync(pdfPath)) {
        const mediaPdf = MessageMedia.fromFilePath(pdfPath);
        await client.sendMessage(chatId, mediaPdf, {
          caption: 'Tu salud merece comodidad, calidad y cercanía. Con el Plan Alfa tienes consulta médica domiciliaria, acceso a 12 especialidades y puedes elegir la IPS que más se ajuste a ti.'
        });
      }

      // Enviar Imagen
      const imgPath = path.join(__dirname, 'material', 'precios.jpeg');
      if (fs.existsSync(imgPath)) {
        const mediaImg = MessageMedia.fromFilePath(imgPath);
        await client.sendMessage(chatId, mediaImg, { caption: 'Tarifas. ¿En qué momento le puedo llamar?' });
      }

      // Enviar Botones
      const botones = new Buttons(
        '¿Qué deseas hacer ahora?',
        [{ body: 'Ver más' }, { body: 'Contactar' }, { body: 'No gracias' }],
        'Información adicional',
        'Selecciona una opción'
      );
      await client.sendMessage(chatId, botones);

    } else if (negativos.includes(texto)) {
      estadoUsuarios[numero] = 'negativo';
      await msg.reply('👌 Entendido. Si cambias de opinión, estoy para ayudarte.');
    } else {
      console.log('⚠️ Mensaje no clasificado, ignorado.');
    }
  } else {
    console.log(`ℹ️ Usuario ${numero} ya registrado como ${estadoUsuarios[numero]}`);
  }
});

app.listen(port, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${port}`);
});
