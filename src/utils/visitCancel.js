/**
 * Cancelación de visitas por parte del residente.
 * Mensaje formal que ve el guardia al escanear un QR de una visita cancelada.
 */
const moment = require('moment-timezone');

const TZ = 'America/Tegucigalpa';

const isCancelled = (row) => !!(row && row.FECHA_CANCELACION);

/** Respuesta estándar (HTTP 410) para el portón cuando la visita fue cancelada. */
const buildCancelledResult = (row) => {
  const fecha = moment(row.FECHA_CANCELACION).tz(TZ);
  const visitante = row.NOMBRE_VISITANTE || 'el visitante';
  const casa = row.CASA_DESTINO ? ` para la casa ${row.CASA_DESTINO}` : '';
  const residente = row.RESIDENTE ? ` ${row.RESIDENTE}` : '';
  const motivo = row.MOTIVO_CANCELACION ? String(row.MOTIVO_CANCELACION).trim().replace(/[.\s]+$/, '') : '';

  const message =
    `ACCESO DENEGADO — VISITA CANCELADA. La visita registrada a nombre de ${visitante}${casa} ` +
    `fue cancelada por el residente${residente} el ${fecha.format('DD/MM/YYYY')} a las ${fecha.format('hh:mm a')}. ` +
    'Este código QR ya no es válido y no se autoriza el ingreso. Si el visitante requiere ingresar, ' +
    'comuníquese con el residente para que genere una nueva autorización.' +
    (motivo ? ` Motivo indicado: ${motivo}.` : '');

  return {
    status: 410,
    message,
    cancelled: true,
    cancelacion: {
      visitante,
      casa: row.CASA_DESTINO || null,
      residente: row.RESIDENTE || null,
      fecha: fecha.format('DD/MM/YYYY'),
      hora: fecha.format('hh:mm a'),
      motivo: motivo || null
    }
  };
};

module.exports = { isCancelled, buildCancelledResult, TZ };
