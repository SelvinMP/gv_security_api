/**
 * Aviso por correo a los ADMINISTRADORES (ID_ROL = 4, activos) cada vez que se
 * crea una reservación de área común, desde la app del residente o desde el panel.
 *
 * Se envía un solo correo con los administradores en copia oculta (BCC) para no
 * exponer sus direcciones entre sí. Nunca lanza errores: un fallo de correo no
 * debe impedir la reservación.
 */
const { mysqlPool } = require('../config/db');
const { sendMailWithTimeout } = require('../config/transporter');
const { buildEmailHtml } = require('./notify');

const ROL_ADMINISTRADOR = 4;

const fmtFecha = (v) => {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(`${String(v).slice(0, 10)}T12:00:00-06:00`);
  return d.toLocaleDateString('es-HN', { timeZone: 'America/Tegucigalpa', weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
};
const fmtHora = (v) => {
  if (!v) return '';
  const [h, m] = String(v).split(':').map(Number);
  return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'p. m.' : 'a. m.'}`;
};

/**
 * @param {number} idReserva
 * @param {{ origen?: 'app' | 'panel', db?: import('mysql2/promise').Pool }} [opts]
 */
const notifyAdminsNewReservation = async (idReserva, { origen = 'app', db = mysqlPool } = {}) => {
  try {
    const [[r]] = await db.query(
      `SELECT r.ID_RESERVA, r.FECHA_RESERVA, r.HORA_INICIO, r.HORA_FINAL, r.TIPO_EVENTO, r.NUM_INVITADO, r.NOTAS,
              i.NOMBRE_INSTALACION, e.DESCRIPCION AS ESTADO,
              u.NOMBRE_USUARIO, u.EMAIL, c.DESCRIPCION AS NUM_CASA
         FROM TBL_RESERVAS r
         LEFT JOIN TBL_INSTALACIONES i ON i.ID_INSTALACION = r.ID_INSTALACION
         LEFT JOIN TBL_ESTADO_RESERVA e ON e.ID_ESTADO_RESERVA = r.ID_ESTADO_RESERVA
         LEFT JOIN TBL_MS_USUARIO u ON u.ID_USUARIO = r.ID_USUARIO
         LEFT JOIN TBL_PERSONAS p ON p.ID_USUARIO = r.ID_USUARIO
         LEFT JOIN TBL_CONDOMINIOS c ON c.ID_CONDOMINIO = p.ID_CONDOMINIO
        WHERE r.ID_RESERVA = ?
        LIMIT 1`,
      [idReserva]
    );
    if (!r) return { sent: 0 };

    const [admins] = await db.query(
      `SELECT EMAIL FROM TBL_MS_USUARIO
        WHERE ID_ROL = ? AND ID_ESTADO_USUARIO = 1 AND EMAIL IS NOT NULL AND EMAIL <> ''`,
      [ROL_ADMINISTRADOR]
    );
    const emails = [...new Set(admins.map(a => String(a.EMAIL).trim().toLowerCase()).filter(Boolean))];
    if (emails.length === 0) {
      console.warn('[reservas] No hay administradores activos con correo para notificar la reservación', idReserva);
      return { sent: 0 };
    }

    const area = r.NOMBRE_INSTALACION || 'Área común';
    const title = `Nueva reservación: ${area}`;
    const intro = origen === 'panel'
      ? 'Se registró una nueva reservación desde el panel administrativo.'
      : 'Un residente solicitó una nueva reservación desde la app. Revísela en el panel administrativo (Gestión › Reservaciones) para aprobarla o cancelarla.';

    await sendMailWithTimeout({
      from: `"GV-Security" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_USER,
      bcc: emails,
      subject: `Nueva reservación: ${area} · ${fmtFecha(r.FECHA_RESERVA)}`,
      html: buildEmailHtml(title, intro, [
        { label: 'Área común', value: area },
        { label: 'Fecha', value: fmtFecha(r.FECHA_RESERVA) },
        { label: 'Horario', value: `${fmtHora(r.HORA_INICIO)} – ${fmtHora(r.HORA_FINAL)}` },
        { label: 'Residente', value: r.NOMBRE_USUARIO },
        { label: 'Casa', value: r.NUM_CASA },
        { label: 'Correo', value: r.EMAIL },
        { label: 'Evento', value: r.TIPO_EVENTO },
        { label: 'Invitados', value: r.NUM_INVITADO },
        { label: 'Notas', value: r.NOTAS },
        { label: 'Estado', value: r.ESTADO || 'Pendiente' },
      ], 'Este aviso se envía automáticamente a los administradores de la residencial.'),
    });
    return { sent: emails.length };
  } catch (err) {
    console.error('[reservas] No se pudo enviar el correo a los administradores:', err.message);
    return { sent: 0, error: err.message };
  }
};

module.exports = { notifyAdminsNewReservation };
