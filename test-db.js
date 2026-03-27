require('dotenv').config();
const { mysqlPool } = require('./src/config/db');

async function checkTables() {
  let conn;
  try {
    conn = await mysqlPool.getConnection();
    const [rows] = await conn.query('SHOW TABLES;');
    console.log('Tables:', rows);
    
    // Also try checking the first row of TBL_NACIONALIDADES if it exists
    try {
      const [nats] = await conn.query('SELECT * FROM TBL_NACIONALIDADES LIMIT 1;');
      console.log('Nationalities example:', nats);
    } catch (e) {
      console.error('Error querying TBL_NACIONALIDADES:', e.message);
    }
    
    try {
      const [users] = await conn.query('SELECT * FROM TBL_MS_USUARIO LIMIT 1;');
      console.log('Users example:', users);
    } catch (e) {
      console.error('Error querying TBL_MS_USUARIO:', e.message);
    }

  } catch (err) {
    console.error('Error connecting to DB:', err);
  } finally {
    if (conn) conn.release();
    process.exit(0);
  }
}

checkTables();
