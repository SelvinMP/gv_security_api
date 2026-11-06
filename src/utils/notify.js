/**
 * Notificaciones al residente: notificación en la app (TBL_NOTIFICACIONES_APP),
 * push (Firebase Cloud Messaging) y correo electrónico.
 * Nunca lanza errores: un fallo al notificar no debe revertir la operación.
 */
const { sendPush } = require('../config/firebase');
const { sendMailWithTimeout } = require('../config/transporter');

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Plantilla de correo con la línea gráfica institucional (navy #0E2041 / dorado #C49B55).
 * @param {string} title  Título del correo
 * @param {string} intro  Párrafo introductorio (texto plano)
 * @param {Array<{label:string,value:any}>} rows  Filas de detalle
 * @param {string} [footer] Texto final (texto plano)
 */
const buildEmailHtml = (title, intro, rows = [], footer = '') => {
  const rowsHtml = rows
    .filter(r => r && r.value !== undefined && r.value !== null && r.value !== '')
    .map(r => `
      <tr>
        <td style="padding:8px 12px;font-size:12px;font-weight:bold;color:#C49B55;text-transform:uppercase;letter-spacing:1px;white-space:nowrap;vertical-align:top;">${escapeHtml(r.label)}</td>
        <td style="padding:8px 12px;font-size:14px;color:#0E2041;font-weight:bold;">${escapeHtml(r.value)}</td>
      </tr>`)
    .join('');

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;background:#FAFAF8;padding:24px;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #e5e7eb;">
      <div style="background:#0E2041;padding:20px 24px;">
        <p style="margin:0;color:#C49B55;font-size:11px;font-weight:bold;letter-spacing:4px;">GV-SECURITY</p>
        <h2 style="margin:6px 0 0;color:#ffffff;font-size:20px;">${escapeHtml(title)}</h2>
      </div>
      <div style="padding:24px;">
        <p style="margin:0 0 16px;color:#4A5D7A;font-size:14px;line-height:1.5;">${escapeHtml(intro)}</p>
        ${rowsHtml ? `<table style="width:100%;border-collapse:collapse;background:#FAFAF8;border-radius:12px;">${rowsHtml}</table>` : ''}
        ${footer ? `<p style="margin:16px 0 0;color:#8898AA;font-size:12px;line-height:1.5;">${escapeHtml(footer)}</p>` : ''}
      </div>
    </div>
  </div>`;
};

/**
 * Notifica a un usuario por app + push + correo.
 * @param {import('mysql2/promise').PoolConnection} connection
 * @param {number} userId
 * @param {{title:string, message:string, emailSubject?:string, emailHtml?:string, sendEmail?:boolean}} opts
 */
const notifyUser = async (connection, userId, { title, message, emailSubject, emailHtml, sendEmail = true }) => {
  try {
    const [userRows] = await connection.query(
      'SELECT EMAIL, FCM_TOKEN FROM TBL_MS_USUARIO WHERE ID_USUARIO = ?',
      [userId]
    );
    if (userRows.length === 0) return;
    const user = userRows[0];

    await connection.query(
      'INSERT INTO TBL_NOTIFICACIONES_APP (ID_USUARIO, TITULO, MENSAJE, FECHA_HORA, LEIDA) VALUES (?, ?, ?, NOW(), 0)',
      [userId, String(title).slice(0, 150), message]
    );

    if (user.FCM_TOKEN) {
      sendPush(user.FCM_TOKEN, { title, body: message, link: '/notifications' });
    }

    if (sendEmail && user.EMAIL) {
      sendMailWithTimeout({
        from: `"GV-Security" <${process.env.EMAIL_USER}>`,
        to: user.EMAIL,
        subject: emailSubject || title,
        html: emailHtml || buildEmailHtml(title, message)
      }).catch(err => console.log('Error enviando correo:', err.message));
    }
  } catch (err) {
    console.error('Error al notificar al usuario:', err.message);
  }
};

module.exports = { notifyUser, buildEmailHtml, escapeHtml };
