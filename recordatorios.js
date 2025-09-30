const express = require('express');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia, List } = require('whatsapp-web.js');
const csv = require('csv-parser');
const sql = require("mssql");
const cron = require("node-cron");

const app = express();
const port = 3000;
const authPath = path.join(__dirname, '.wwebjs_auth');
const estadoUsuarios = {};
let numerosPermitidos = new Set();

// 📌 Cargar CSV
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
      console.log(`📋 Números cargados: ${numerosPermitidos.size}`);
    });
}
cargarNumerosDesdeCSV();
fs.watchFile('EnvioWS.csv', () => {
  console.log('🔄 CSV actualizado. Recargando...');
  cargarNumerosDesdeCSV();
});

// 📌 Verificar carpeta de sesión
function checkSessionFolder() {
  try {
    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath);
    else fs.accessSync(authPath, fs.constants.W_OK);
  } catch (err) {
    console.log('⚠️ Carpeta de sesión con error. Borrando...');
    try {
      fs.rmSync(authPath, { recursive: true, force: true });
      console.log('✅ Sesión eliminada. Nuevo QR aparecerá.');
    } catch (e) {
      console.error('❌ No se pudo eliminar sesión:', e.message);
      process.exit(1);
    }
  }
}
checkSessionFolder();

// 📌 Inicializar cliente WhatsApp
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

client.on('qr', qr => {
  console.log('📲 Escanea este QR con WhatsApp:');
  qrcode.generate(qr, { small: true });
});
client.on('ready', () => console.log('✅ Cliente de WhatsApp listo.'));
client.on('auth_failure', msg => console.error('❌ Fallo de autenticación:', msg));
client.on('disconnected', reason => console.log('⚠️ Cliente desconectado:', reason));

client.initialize();
app.use(express.json({ limit: '20mb' }));
app.get('/', (req, res) => res.send('🌐 Servidor WhatsApp funcionando.'));

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

// 📌 Configuración SQL
const dbConfig = {
   user: "Universidad",       
   password: "Universidad",   
   server: "localhost",       
   database: "Universidad",
   options: {
     encrypt: false,
     trustServerCertificate: true
   },
};

client.on("message", async msg => {
  try {
    const numero = msg.from; // Ejemplo: "573001112233@c.us"
    const respuesta = msg.body.trim().toUpperCase();

    if (respuesta === "SI" || respuesta === "NO") {
      const telefono = numero.replace("@c.us", "").replace(/^57/, ""); // limpiar el número
      const pool = await sql.connect(dbConfig);

      await pool.request()
        .input("telefono", sql.VarChar, telefono)
        .input("respuesta", sql.VarChar, respuesta)
        .query(`
          UPDATE eventoscalendar
          SET Confirmado = @respuesta
          WHERE Telefono = @telefono
            AND CAST(FechaAsignacion AS DATE) = CAST(GETDATE() AS DATE)
        `);

      if (respuesta === "SI") {
        await client.sendMessage(numero, "✅ ¡Gracias por confirmar tu asistencia!");
      } else {
        await client.sendMessage(numero, "❌ Hemos registrado que no asistirás. Por favor contacta para reprogramar.");
      }

      console.log(`📌 Confirmación registrada: ${numero} → ${respuesta}`);
    }

  } catch (err) {
    console.error("❌ Error guardando respuesta:", err.message);
  }
});



// 📌 Número fijo de recordatorio
const numeroRecordatorio = "573214498302@c.us";



// 📌 Tarea programada cada minuto (versión simplificada sin botones)
cron.schedule("* * * * *", async () => {
  console.log("⏰ Ejecutando tarea de recordatorios...");

  try {
    let pool = await sql.connect(dbConfig);

    const result = await pool.request().query(`
       SELECT 
        ev.id,
        tip.IdTipificacion,
        tip.Tipificacion,
        cli.Nombres + ' ' + cli.Apellidos AS Nombre,
        ev.documento,
        cli.Telefono,
        CONVERT(varchar(10), ev.fechaasignacion, 23) AS FechaAsignacionStr,
        CONVERT(varchar(5), TRY_CONVERT(time, ev.hora), 108) AS HoraStr,
        DATEDIFF(
          MINUTE, 
          GETDATE(), 
          DATEADD(SECOND, DATEDIFF(SECOND, 0, TRY_CONVERT(time, ev.hora)), CONVERT(datetime, ev.fechaasignacion, 120))
        ) AS MinutosFaltantes
      FROM eventoscalendar ev
      LEFT JOIN Tipificaciones tip ON tip.IdTipificacion = ev.evento
      LEFT JOIN TClientes cli ON cli.Documento = ev.documento
      WHERE tip.IdTipificacion IN (1,3,4,6,12,13)
        AND (ev.recordatorioEnviado = 0 OR ev.recordatorioEnviado IS NULL)
        AND DATEDIFF(
          MINUTE, 
          GETDATE(), 
          DATEADD(SECOND, DATEDIFF(SECOND, 0, TRY_CONVERT(time, ev.hora)), CONVERT(datetime, ev.fechaasignacion, 120))
        ) BETWEEN 57 AND 63
    `);

    // mensaje para cliente recordatorio
// ---------------------------
// Función para formatear fecha
// ---------------------------
function formatearFechaHora(fechaStr, horaStr) {
  let fechaTexto = "Fecha no registrada";
  let horaTexto = "Hora no registrada";

  if (!fechaStr || !horaStr) return { fechaTexto, horaTexto };

  try {
    // Si viene como YYYYMMDD -> convertir a YYYY-MM-DD
    if (/^\d{8}$/.test(fechaStr)) {
      fechaStr = `${fechaStr.substring(0,4)}-${fechaStr.substring(4,6)}-${fechaStr.substring(6,8)}`;
    }
    // Asegurar que hora tenga formato HH:mm
    const horaClean = horaStr.substring(0,5);

    // Construir ISO con zona -05:00 (Bogotá)
    const iso = `${fechaStr}T${horaClean}:00-05:00`;
    const fechaJS = new Date(iso);

    if (!isNaN(fechaJS.getTime())) {
      fechaTexto = fechaJS.toLocaleDateString("es-CO", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "America/Bogota"
      });
      horaTexto = fechaJS.toLocaleTimeString("es-CO", {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: "America/Bogota"
      });
    } else {
      console.warn("⚠️ formatearFechaHora: fecha inválida ->", iso);
    }
  } catch (e) {
    console.error("⚠️ Error en formatearFechaHora:", e.message);
  }

  return { fechaTexto, horaTexto };
}

// ---------------------------------
// Generar mensaje de recordatorio
// ---------------------------------
function generarMensajeRecordatorio(row) {
  const { fechaTexto, horaTexto } = formatearFechaHora(row.FechaAsignacionStr, row.HoraStr);

  const telefono = row.Telefono ? row.Telefono : "No registrado";
  const linkConfirmacion = `https://symagentesdeseguros.com/universidad/Admin/confirmar_cita.php?id=${row.id}`;

  return (
    `📅 *Recordatorio de Cita*\n\n` +
    `👤 Cliente: *${row.Nombre || "Desconocido"}*\n` +
    `📱 Teléfono: ${telefono}\n` +
    `🗓️ Fecha: ${fechaTexto}\n` +
    `⏰ Hora: ${horaTexto}\n` +
    `📌 Estado: ${row.Tipificacion || "N/A"}\n\n` +
    `🔗 Por favor confirma tu asistencia aquí:\n${linkConfirmacion}`
  );
}

// -----------------------------
// Envío dentro del for (reemplaza tu bloque actual)
// -----------------------------
console.log(`📋 Recordatorios obtenidos: ${result.recordset.length}`);

for (let row of result.recordset) {
  try {
    if (!row.Telefono) continue;

    // debug rápido (descomenta si quieres ver cómo llegan los datos)
    // console.log("DEBUG row:", row);

    // Formatear fecha/hora una sola vez
    const { fechaTexto, horaTexto } = formatearFechaHora(row.FechaAsignacionStr, row.HoraStr);

    // Mensaje al cliente (usa fecha/hora formateadas)
    const mensajeCliente =
      generarMensajeRecordatorio(row) +
      "\n\nPor favor responde con:\n" +
      "✅ *SI* para confirmar\n" +
      "❌ *NO* para cancelar o reprogramar";

    const numeroLimpio = row.Telefono.replace(/\D/g, "");
    const chatIdCliente = `57${numeroLimpio}@c.us`;

    await client.sendMessage(chatIdCliente, mensajeCliente);
    console.log(`✅ Recordatorio enviado al cliente ${row.Nombre}`);

    // Mensaje para el asesor (también con fecha/hora formateadas)
    const mensajeAsesor =
      `📢 *Recordatorio asignado*\n\n` +
      `👤 Cliente: *${row.Nombre}*\n` +
      `📱 Teléfono: ${row.Telefono}\n` +
      `🗓️ Fecha: ${fechaTexto}\n` +
      `⏰ Hora: ${horaTexto}\n` +
      `📌 Estado: ${row.Tipificacion}\n\n` +
      `🔗 Contactar cliente: https://wa.me/57${row.Telefono}`;

    await client.sendMessage(numeroRecordatorio, mensajeAsesor);
    console.log(`✅ Copia enviada al asesor para ${row.Nombre}`);

    // Actualizar DB
    await pool.request()
      .input("id", sql.Int, row.id)
      .query("UPDATE eventoscalendar SET recordatorioEnviado = 1 WHERE id = @id");

  } catch (err) {
    console.error("❌ Error procesando recordatorio:", err.message);
  }
}

    await pool.close();
  } catch (err) {
    console.error("❌ Error en la consulta SQL:", err.message);
  }
});


app.listen(port, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${port}`);
});
