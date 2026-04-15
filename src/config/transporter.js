const nodemailer = require('nodemailer');
require('dotenv').config();

const emailPort = parseInt(process.env.EMAIL_PORT) || 587;

// Puerto 465 = SSL directo (secure: true)
// Puerto 587 = STARTTLS (secure: false, conn sube a TLS con STARTTLS)
// Render bloquea menos el 587. Si el usuario pone 465 lo respetamos.
const isSecure = emailPort === 465;

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: emailPort,
  secure: isSecure, // true para 465, false para otros
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  family: 4, // 🔥 FORZAR IPv4 para evitar ENETUNREACH en Render
  tls: {
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2'
  },
  connectionTimeout: 30000, 
  greetingTimeout: 30000,   
  socketTimeout: 60000,     
  logger: true,                
  debug: true,                 
});

// Verificar conexión al arrancar (solo loguea, no bloquea)
transporter.verify((error) => {
  if (error) {
    console.error('❌ Error al conectar con el servidor de correo:', error.message);
    console.error('   HOST:', process.env.EMAIL_HOST, '| PORT:', emailPort, '| SECURE:', isSecure);
    console.error('   USER:', process.env.EMAIL_USER ? '✓ definido' : '✗ NO definido');
    console.error('   PASS:', process.env.EMAIL_PASS ? '✓ definido' : '✗ NO definido');
  } else {
    console.log('✅ Servidor de correo listo |', process.env.EMAIL_HOST, 'puerto', emailPort);
  }
});

/**
 * Wrapper que envía un correo con un timeout máximo.
 * Si el proveedor SMTP no responde a tiempo, rechaza la promesa
 * en lugar de colgar el servidor indefinidamente.
 * @param {object} mailOptions - Opciones de nodemailer
 * @param {number} timeoutMs   - Timeout máximo en ms (default 12000)
 */
const sendMailWithTimeout = (mailOptions, timeoutMs = 30000) => {
  return new Promise((resolve, reject) => {
    console.log(`📨 Intentando enviar correo a: ${mailOptions.to}...`);
    const timer = setTimeout(() => {
      reject(new Error(`Timeout de correo: el servidor SMTP no respondió en ${timeoutMs / 1000}s`));
    }, timeoutMs);

    transporter.sendMail(mailOptions)
      .then((info) => {
        clearTimeout(timer);
        console.log(`✅ Correo enviado con éxito a: ${mailOptions.to}`);
        resolve(info);
      })
      .catch((err) => {
        clearTimeout(timer);
        console.error(`❌ Error al enviar correo a ${mailOptions.to}:`, err.message);
        reject(err);
      });
  });
};

module.exports = { transporter, sendMailWithTimeout };
