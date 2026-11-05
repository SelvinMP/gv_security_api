const nodemailer = require('nodemailer');
const dns = require('dns');

// Forzar IPv4 a nivel de proceso
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

require('dotenv').config();

/*
 * ============================================================================
 *  ENVÍO DE CORREOS - GV-SECURITY
 * ============================================================================
 *  Render (plan gratuito) BLOQUEA los puertos SMTP salientes (25, 465, 587)
 *  desde el 26/09/2025. Por eso Gmail SMTP funciona en local pero NO en Render.
 *
 *  Solución: si existe BREVO_API_KEY se envía por la API HTTP de Brevo
 *  (puerto 443, no bloqueado). Si no existe, se usa Gmail SMTP (útil en local).
 * ============================================================================
 */

const BREVO_API_KEY = (process.env.BREVO_API_KEY || '').trim();
const USE_BREVO = BREVO_API_KEY.length > 0;

const EMAIL_PORT = parseInt(process.env.EMAIL_PORT || '465', 10);

// --- Transporte SMTP (solo se usa si NO hay BREVO_API_KEY) ---
const smtpTransporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: EMAIL_PORT,
  secure: EMAIL_PORT === 465, // 465 = SSL directo, 587 = STARTTLS
  auth: {
    user: process.env.EMAIL_USER,
    pass: (process.env.EMAIL_PASS || '').replace(/\s+/g, ''), // quita espacios de la contraseña de aplicación
  },
  family: 4,
  tls: { minVersion: 'TLSv1.2' },
  connectionTimeout: 20000,
  greetingTimeout: 20000,
  socketTimeout: 30000,
});

// Convierte '"Nombre" <correo@x.com>' en { name, email }
const parseFrom = (from) => {
  const fallbackEmail = process.env.MAIL_FROM_EMAIL || process.env.EMAIL_USER;
  if (!from) return { name: 'GV-Security', email: fallbackEmail };
  const match = String(from).match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (match) {
    return { name: match[1].trim() || 'GV-Security', email: process.env.MAIL_FROM_EMAIL || match[2].trim() };
  }
  return { name: 'GV-Security', email: process.env.MAIL_FROM_EMAIL || String(from).trim() };
};

const toList = (to) =>
  String(to)
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
    .map((email) => ({ email }));

// --- Envío por API HTTP de Brevo ---
const sendViaBrevo = async (mailOptions) => {
  const body = {
    sender: parseFrom(mailOptions.from),
    to: toList(mailOptions.to),
    subject: mailOptions.subject,
  };
  if (mailOptions.html) body.htmlContent = mailOptions.html;
  if (mailOptions.text) body.textContent = mailOptions.text;
  if (!body.htmlContent && !body.textContent) body.textContent = ' ';

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Brevo ${res.status}: ${data.message || JSON.stringify(data)}`);
  }
  return data; // { messageId }
};

// --- Función única de envío (la usan todos los controladores) ---
const sendMail = (mailOptions) =>
  USE_BREVO ? sendViaBrevo(mailOptions) : smtpTransporter.sendMail(mailOptions);

/**
 * Envía un correo con un timeout máximo para no colgar la petición.
 */
const sendMailWithTimeout = (mailOptions, timeoutMs = 30000) => {
  return new Promise((resolve, reject) => {
    console.log(`📨 [${USE_BREVO ? 'Brevo API' : 'SMTP'}] Enviando correo a: ${mailOptions.to}...`);
    const timer = setTimeout(() => {
      reject(new Error(`Timeout de correo: no hubo respuesta en ${timeoutMs / 1000}s`));
    }, timeoutMs);

    sendMail(mailOptions)
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

// Verificación al arrancar (solo loguea)
if (USE_BREVO) {
  console.log('✉️  Correo: usando API HTTP de Brevo. Remitente:', process.env.MAIL_FROM_EMAIL || process.env.EMAIL_USER);
} else {
  smtpTransporter.verify((error) => {
    if (error) {
      console.error('❌ Error al conectar con el servidor SMTP:', error.message);
      console.error('   Si estás en Render (plan gratuito), el SMTP está bloqueado: configura BREVO_API_KEY.');
    } else {
      console.log('✅ Servidor SMTP listo para enviar mensajes.');
    }
  });
}

// `transporter.sendMail` se mantiene por compatibilidad con código existente
const transporter = { sendMail };

module.exports = { transporter, sendMail, sendMailWithTimeout };
