/**
 * Verifica al arrancar la API que existan las columnas que el código necesita
 * y las crea si faltan (equivalente a database/migrations/2026-11-06_cancelacion_visitas.sql).
 * Es idempotente: si ya existen, no hace nada.
 */
const { mysqlPool } = require('./db');

const REQUIRED_COLUMNS = [
  ['TBL_REGVISITAS', 'FECHA_CANCELACION', "DATETIME NULL DEFAULT NULL COMMENT 'Fecha/hora (Honduras) en que el residente canceló la visita'"],
  ['TBL_REGVISITAS', 'MOTIVO_CANCELACION', "VARCHAR(255) NULL DEFAULT NULL COMMENT 'Motivo indicado por el residente'"],
  ['TBL_VISITANTES_RECURRENTES', 'FECHA_CANCELACION', "DATETIME NULL DEFAULT NULL COMMENT 'Fecha/hora (Honduras) en que el residente canceló la visita'"],
  ['TBL_VISITANTES_RECURRENTES', 'MOTIVO_CANCELACION', "VARCHAR(255) NULL DEFAULT NULL COMMENT 'Motivo indicado por el residente'"],
];

const ensureSchema = async () => {
  try {
    const [rows] = await mysqlPool.query(
      `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME IN ('FECHA_CANCELACION', 'MOTIVO_CANCELACION')`
    );
    const existing = new Set(rows.map(r => `${r.TABLE_NAME}.${r.COLUMN_NAME}`));

    for (const [table, column, definition] of REQUIRED_COLUMNS) {
      if (existing.has(`${table}.${column}`)) continue;
      await mysqlPool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
      console.log(`🛠️  Columna creada: ${table}.${column}`);
    }
  } catch (error) {
    console.error('❌ No se pudo verificar/crear el esquema requerido (cancelación de visitas):', error.message);
    console.error('   Ejecute manualmente database/migrations/2026-11-06_cancelacion_visitas.sql');
  }
};

module.exports = { ensureSchema };
