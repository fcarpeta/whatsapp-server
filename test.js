const sql = require("mssql");

const dbConfig = {
    user: "Universidad",       // tu usuario SQL
    password: "Universidad", // tu contraseña
    server: "localhost",         // o la IP del servidor
    database: "Universidad",
    options: {
        encrypt: false,
        trustServerCertificate: true
    }
};
async function testConnection() {
  try {
    console.log("🔄 Conectando a SQL Server...");
    let pool = await sql.connect(dbConfig);
    console.log("✅ Conexión exitosa!");

    // Probar una consulta básica
    let result = await pool.request().query("SELECT TOP 5 name FROM sys.tables");
    console.log("📋 Tablas encontradas:");
    console.log(result.recordset);

    await sql.close();
  } catch (err) {
    console.error("❌ Error en la conexión:", err);
  }
}

testConnection();
