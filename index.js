const express = require('express');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia, Buttons } = require('whatsapp-web.js');
const csv = require('csv-parser');

const app = express();
const port = 3000;
const authPath = path.join(__dirname, '.wwebjs_auth');
const estadoUsuarios = {};
let numerosPermitidos = new Set(); // Set global que se sobrescribe al cargar CSV

// ?? Cargar CSV desde cero cada vez que se ejecuta
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
      console.log(`Numeros cargados: ${numerosPermitidos.size}`);
    });
}
cargarNumerosDesdeCSV();

// ?? Vigilar cambios en el archivo CSV y recargar automáticamente
fs.watchFile('EnvioWS.csv', (curr, prev) => {
  console.log('CSV actualizado. Recargando...');
  cargarNumerosDesdeCSV();
});

// ?? Verificar carpeta de sesión
function checkSessionFolder() {
  try {
    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath);
    else fs.accessSync(authPath, fs.constants.W_OK);
  } catch (err) {
    console.log(' Carpeta de sesion con error. Borrando...');
    try {
      fs.rmSync(authPath, { recursive: true, force: true });
      console.log(' Sesion eliminada. Nuevo QR aparecerá.');
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

// ?? Eventos básicos del cliente
client.on('qr', qr => {
  console.log(' Escanea este QR con WhatsApp:');
  qrcode.generate(qr, { small: true });
});
client.on('ready', () => console.log(' Cliente de WhatsApp listo.'));
client.on('auth_failure', msg => console.error(' Fallo de autenticación:', msg));
client.on('disconnected', reason => console.log(' Cliente desconectado:', reason));

client.initialize();
app.use(express.json({ limit: '20mb' }));

app.get('/', (req, res) => res.send(' Servidor WhatsApp funcionando.'));

app.post('/enviar', async (req, res) => {
  const { numero, mensaje, imagen } = req.body;
  const chatId = `${numero}@c.us`;

  try {
    const isRegistered = await client.isRegisteredUser(chatId);
    if (!isRegistered) return res.status(400).send({ status: '?', error: 'No tiene WhatsApp' });

    if (imagen && imagen.startsWith("data:")) {
      const matches = imagen.match(/^data:(.+);base64,(.+)$/);
      if (!matches || matches.length !== 3) return res.status(400).send({ status: '?', error: 'Base64 mal formado' });

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

// ?? Escuchar mensajes
client.on('message', async msg => {
  const numero = msg.from.replace('@c.us', '');
  const chatId = msg.from;
  const texto = msg.body.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

  console.log(` Mensaje de ${numero}: ${texto}`);

  if (!numerosPermitidos.has(numero)) {
    console.log(` Numero ${numero} no esta en el archivo no se responde.`);
    return;
  }

  const positivos = ['si', 'sí', 'interesado', 'quiero informacion', 'quiero mas informacion', 'más informacion', 'mas informacion', 'informacion','de que se trata','como es','Si estoy interesada','Si estoy interesado','si estoy interesada'];
  const negativos = ['no', 'no estoy interesado', 'no me interesa', 'ya no me interesa', 'no gracias', 'No sra gracias', 'no señora gracias', 'Ya no estoy interesada', 'No, no me interesa adquirirlo en este momento','No, no estoy interesado en ningún producto','No ya no estoy interesado muchas gracias','en el momento no me interesa','No, ya no estoy interesado en adquirirlo en este momento.','No, ya no estoy interesado en adquirirlo en este momento'];

  if (!estadoUsuarios[numero]) {
    if (positivos.includes(texto)) {
      estadoUsuarios[numero] = 'positivo';
      await msg.reply('Gracias por tu interes. Te enviare mas informacion sobre los planes.');

      // Enviar PDF
      const pdfPath = path.join(__dirname, 'material', 'Comparativo_PAC_medico_2023.pdf');
      if (fs.existsSync(pdfPath)) {
        const mediaPdf = MessageMedia.fromFilePath(pdfPath);
        await client.sendMessage(chatId, mediaPdf, {
          caption: 'Tu salud merece comodidad, calidad y cercania. Con el Plan Alfa tienes consulta medica domiciliaria, acceso a 12 especialidades y puedes elegir la IPS que mas se ajuste a ti.'
        });
      }

      // Enviar Imagen
      const imgPath = path.join(__dirname, 'material', 'precios.jpeg');
      if (fs.existsSync(imgPath)) {
        const mediaImg = MessageMedia.fromFilePath(imgPath);
        await client.sendMessage(chatId, mediaImg, {
          caption: 'Tarifas. ¿En que momento le puedo llamar?'
        });
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
      await msg.reply('Entendido. Si cambias de opinion, estoy para ayudarte.');
    } else {
      console.log('?? Mensaje no clasificado, ignorado.');
    }
  } else {
    console.log(`? Usuario ${numero} ya registrado como ${estadoUsuarios[numero]}`);
  }
});

app.listen(port, () => {
  console.log(`?? Servidor corriendo en http://localhost:${port}`);
});
