const { Sequelize } = require('sequelize');
const mysql = require('mysql2/promise');
require('dotenv').config();

// Creamos la instancia de conexión para Sequelize
const db = new Sequelize(
  process.env.DB_NAME, 
  process.env.DB_USER, 
  process.env.DB_PASSWORD, 
  {
    host: process.env.DB_HOST,
    dialect: 'mysql',
    port: process.env.DB_PORT,
    logging: false,
    // --- ESTO SOLUCIONA EL ERROR EN SEQUELIZE ---
    dialectOptions: {
      authPlugins: {
        mysql_native_password: 'mysql_native_password'
      },
      connectTimeout: 60000 // Aumentamos el tiempo de espera por si Render tarda
    }
  }
);

// Pool de MySQL para transacciones (usado en registro)
const mysqlPool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // --- ESTO SOLUCIONA EL ERROR EN EL POOL ---
  allowPublicKeyRetrieval: true,
  ssl: false 
});

// Función para probar la conexión
const connectDB = async () => {
  try {
    await db.authenticate();
    console.log('✅ Conexión a la base de datos establecida correctamente con Sequelize.');
    
    // Probar el pool
    const connection = await mysqlPool.getConnection();
    console.log('✅ Pool de MySQL listo para transacciones.');
    connection.release();
  } catch (error) {
    console.error('❌ No se pudo conectar a la base de datos:', error);
    // Imprimimos más detalles para saber exactamente qué falló
    if (error.original) {
        console.error('Detalle técnico:', error.original.message);
    }
  }
};

module.exports = { db, connectDB, mysqlPool };