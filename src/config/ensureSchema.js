/**
 * Verifica al arrancar la API que exista el esquema que el código necesita y lo
 * crea si falta. Es idempotente: si ya existe, no hace nada.
 *
 * Equivale a:
 *   - database/migrations/2026-11-06_cancelacion_visitas.sql
 *   - database/migrations/2026-11-07_auditoria.sql
 *   - database/migrations/2026-11-08_politicas.sql
 *   - database/migrations/2026-11-10_inteligencia_artificial.sql
 */
const { mysqlPool } = require('./db');

const AUDIT_ACCION = "VARCHAR(40) NULL DEFAULT NULL COMMENT 'Acción auditada: CREACIÓN, MODIFICACIÓN, ELIMINACIÓN, etc.'";
const AUDIT_DETALLE = "VARCHAR(500) NULL DEFAULT NULL COMMENT 'Descripción legible del cambio'";
const AUDIT_TABLES = ['TBL_LOG_USUARIO', 'TBL_LOG_PERSONA', 'TBL_LOG_PARAMETROS', 'TBL_LOG_ROLES', 'TBL_LOG_PERMISOS', 'TBL_LOG_HISTORIAL_CONTRASEÑA'];

const REQUIRED_COLUMNS = [
  ['TBL_REGVISITAS', 'FECHA_CANCELACION', "DATETIME NULL DEFAULT NULL COMMENT 'Fecha/hora (Honduras) en que el residente canceló la visita'"],
  ['TBL_REGVISITAS', 'MOTIVO_CANCELACION', "VARCHAR(255) NULL DEFAULT NULL COMMENT 'Motivo indicado por el residente'"],
  ['TBL_VISITANTES_RECURRENTES', 'FECHA_CANCELACION', "DATETIME NULL DEFAULT NULL COMMENT 'Fecha/hora (Honduras) en que el residente canceló la visita'"],
  ['TBL_VISITANTES_RECURRENTES', 'MOTIVO_CANCELACION', "VARCHAR(255) NULL DEFAULT NULL COMMENT 'Motivo indicado por el residente'"],
  ...AUDIT_TABLES.flatMap(t => [[t, 'ACCION', AUDIT_ACCION], [t, 'DETALLE', AUDIT_DETALLE]]),
];

// Responsable / origen para cambios hechos directamente en la base de datos.
// Si una conexión define @gv_usuario, @gv_ip o @gv_navegador se usan esos valores.
const WHO = "LEFT(COALESCE(@gv_usuario, CURRENT_USER()), 50)";
const IP = "LEFT(COALESCE(@gv_ip, 'Base de datos'), 45)";
const NAV = "LEFT(COALESCE(@gv_navegador, 'Consola / cliente MySQL'), 255)";
const flags = (r) =>
  `CONCAT('Objeto ', IFNULL(${r}.ID_OBJETO, '-'), ' · Insertar=', ${r}.PERMISO_INSERCION, ' Eliminar=', ${r}.PERMISO_ELIMINACION, ' Actualizar=', ${r}.PERMISO_ACTUALIZACION, ' Consultar=', ${r}.PERMISO_CONSULTAR)`;
const permisoInsert = (r, accion, detalle) => `
  INSERT INTO TBL_LOG_PERMISOS
    (ID_PERMISO, ID_ROL, ID_OBJETO, PERMISO_INSERCION, PERMISO_ELIMINACION, PERMISO_ACTUALIZACION, PERMISO_CONSULTAR,
     FECHA_CREACION, CREADO_POR, FECHA_MODIFICACION, MODIFICADO_POR,
     FECHA_ELIMINACION, USUARIO_ELIMINACION, ORIGEN_IP, NAVEGADOR, ACCION, DETALLE)
  VALUES (${r}.ID_PERMISO, ${r}.ID_ROL, ${r}.ID_OBJETO, ${r}.PERMISO_INSERCION, ${r}.PERMISO_ELIMINACION, ${r}.PERMISO_ACTUALIZACION, ${r}.PERMISO_CONSULTAR,
     ${r}.FECHA_CREACION, ${r}.CREADO_POR, ${r}.FECHA_MODIFICACION, ${r}.MODIFICADO_POR,
     NOW(), ${WHO}, ${IP}, ${NAV}, '${accion}', LEFT(${detalle}, 500))`;
const rolInsert = (r, accion, detalle) => `
  INSERT INTO TBL_LOG_ROLES (ID_ROL, ROL, DESCRIPCION, FECHA_ELIMINACION, USUARIO_ELIMINACION, ORIGEN_IP, NAVEGADOR, ACCION, DETALLE)
  VALUES (${r}.ID_ROL, ${r}.ROL, LEFT(${r}.DESCRIPCION, 50), NOW(), ${WHO}, ${IP}, ${NAV}, '${accion}', LEFT(${detalle}, 500))`;

// Roles y permisos no tienen pantalla de edición en la app: solo cambian desde la
// base de datos, por eso se auditan con triggers.
const TRIGGERS = [
  ['TRG_AUD_ROLES_INS', 'AFTER INSERT ON TBL_MS_ROLES', rolInsert('NEW', 'CREACIÓN', "CONCAT('Rol creado: ', NEW.ROL)")],
  ['TRG_AUD_ROLES_UPD', 'AFTER UPDATE ON TBL_MS_ROLES', rolInsert('NEW', 'MODIFICACIÓN', "CONCAT('Antes: ', OLD.ROL, ' — ', IFNULL(OLD.DESCRIPCION, ''))")],
  ['TRG_AUD_ROLES_DEL', 'BEFORE DELETE ON TBL_MS_ROLES', rolInsert('OLD', 'ELIMINACIÓN', "CONCAT('Rol eliminado: ', OLD.ROL)")],
  ['TRG_AUD_PERMISOS_INS', 'AFTER INSERT ON TBL_PERMISOS', permisoInsert('NEW', 'CREACIÓN', flags('NEW'))],
  ['TRG_AUD_PERMISOS_UPD', 'AFTER UPDATE ON TBL_PERMISOS', permisoInsert('NEW', 'MODIFICACIÓN', `CONCAT('Antes: ', ${flags('OLD')}, ' → Ahora: ', ${flags('NEW')})`)],
  ['TRG_AUD_PERMISOS_DEL', 'BEFORE DELETE ON TBL_PERMISOS', permisoInsert('OLD', 'ELIMINACIÓN', flags('OLD'))],
];

// ─── Políticas / reglamento de la residencial (opción B: política + roles destinatarios) ───
const POLICY_TABLES = [
  `CREATE TABLE IF NOT EXISTS TBL_CATEGORIA_POLITICA (
     ID_CATEGORIA INT NOT NULL AUTO_INCREMENT,
     DESCRIPCION VARCHAR(80) NOT NULL,
     ORDEN INT NOT NULL DEFAULT 0,
     PRIMARY KEY (ID_CATEGORIA),
     UNIQUE KEY UQ_CATEGORIA_POLITICA (DESCRIPCION)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS TBL_POLITICAS (
     ID_POLITICA INT NOT NULL AUTO_INCREMENT,
     TITULO VARCHAR(150) NOT NULL,
     RESUMEN VARCHAR(300) NULL,
     CONTENIDO MEDIUMTEXT NOT NULL,
     ID_CATEGORIA INT NULL,
     ARCHIVO_PDF VARCHAR(255) NULL COMMENT 'Ruta relativa del PDF adjunto (uploads/politicas/...)',
     ESTADO ENUM('BORRADOR','PUBLICADA','ARCHIVADA') NOT NULL DEFAULT 'BORRADOR',
     VIGENTE_DESDE DATE NULL,
     VIGENTE_HASTA DATE NULL,
     FECHA_PUBLICACION DATETIME NULL,
     CREADO_POR INT NULL,
     FECHA_CREACION DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     MODIFICADO_POR INT NULL,
     FECHA_MODIFICACION DATETIME NULL,
     PRIMARY KEY (ID_POLITICA),
     KEY IDX_POLITICA_ESTADO (ESTADO),
     KEY IDX_POLITICA_CATEGORIA (ID_CATEGORIA),
     CONSTRAINT FK_POLITICA_CATEGORIA FOREIGN KEY (ID_CATEGORIA) REFERENCES TBL_CATEGORIA_POLITICA (ID_CATEGORIA) ON DELETE SET NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS TBL_POLITICA_ROL (
     ID_POLITICA INT NOT NULL,
     ID_ROL INT NOT NULL,
     PRIMARY KEY (ID_POLITICA, ID_ROL),
     KEY IDX_POLITICA_ROL_ROL (ID_ROL),
     CONSTRAINT FK_POLROL_POLITICA FOREIGN KEY (ID_POLITICA) REFERENCES TBL_POLITICAS (ID_POLITICA) ON DELETE CASCADE,
     CONSTRAINT FK_POLROL_ROL FOREIGN KEY (ID_ROL) REFERENCES TBL_MS_ROLES (ID_ROL)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

const DEFAULT_POLICY_CATEGORIES = [
  'CONVIVENCIA Y RUIDO', 'MASCOTAS', 'ÁREAS COMUNES', 'SEGURIDAD Y ACCESO', 'VISITAS Y PROVEEDORES',
  'MUDANZAS Y CONSTRUCCIÓN', 'ESTACIONAMIENTO', 'CUOTAS Y PAGOS', 'PROTOCOLOS DE CASETA',
];

const ensurePolicyTables = async () => {
  for (const ddl of POLICY_TABLES) await mysqlPool.query(ddl);
  const [[{ total }]] = await mysqlPool.query('SELECT COUNT(*) AS total FROM TBL_CATEGORIA_POLITICA');
  if (Number(total) === 0) {
    await mysqlPool.query(
      'INSERT INTO TBL_CATEGORIA_POLITICA (DESCRIPCION, ORDEN) VALUES ?',
      [DEFAULT_POLICY_CATEGORIES.map((d, i) => [d, i + 1])]
    );
    console.log('🛠️  Categorías de políticas iniciales creadas');
  }
};

// ─── Inteligencia Artificial: registro de consultas (topes mensual/diario y reporte de consumo) ───
const AI_TABLES = [
  `CREATE TABLE IF NOT EXISTS TBL_IA_USO (
     ID_USO INT NOT NULL AUTO_INCREMENT,
     ID_USUARIO INT NULL,
     FUNCION VARCHAR(30) NOT NULL COMMENT 'reglamento, asistente, fotos',
     MODELO VARCHAR(60) NOT NULL,
     TOKENS_ENTRADA INT NOT NULL DEFAULT 0,
     TOKENS_SALIDA INT NOT NULL DEFAULT 0,
     FECHA DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (ID_USO),
     KEY IDX_IA_USO_FECHA (FECHA),
     KEY IDX_IA_USO_USUARIO_FECHA (ID_USUARIO, FECHA)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

const ensureAITables = async () => {
  for (const ddl of AI_TABLES) await mysqlPool.query(ddl);
};

const ensureColumns = async () => {
  const names = [...new Set(REQUIRED_COLUMNS.map(c => c[1]))];
  const [rows] = await mysqlPool.query(
    `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME IN (?)`,
    [names]
  );
  const existing = new Set(rows.map(r => `${r.TABLE_NAME}.${r.COLUMN_NAME}`));
  for (const [table, column, definition] of REQUIRED_COLUMNS) {
    if (existing.has(`${table}.${column}`)) continue;
    await mysqlPool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    console.log(`🛠️  Columna creada: ${table}.${column}`);
  }
};

const ensureTriggers = async () => {
  const [rows] = await mysqlPool.query(
    'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME IN (?)',
    [TRIGGERS.map(t => t[0])]
  );
  const existing = new Set(rows.map(r => r.TRIGGER_NAME));
  for (const [name, timing, body] of TRIGGERS) {
    if (existing.has(name)) continue;
    await mysqlPool.query(`CREATE TRIGGER \`${name}\` ${timing} FOR EACH ROW ${body.trim()}`);
    console.log(`🛠️  Trigger de auditoría creado: ${name}`);
  }
};

const ensureSchema = async () => {
  try {
    await ensureColumns();
  } catch (error) {
    console.error('❌ No se pudieron verificar/crear las columnas requeridas:', error.message);
    console.error('   Ejecute manualmente los scripts de database/migrations/');
  }
  try {
    await ensurePolicyTables();
  } catch (error) {
    console.error('❌ No se pudieron crear las tablas de políticas / reglamento:', error.message);
    console.error('   Ejecute manualmente database/migrations/2026-11-08_politicas.sql');
  }
  try {
    await ensureAITables();
  } catch (error) {
    console.error('❌ No se pudo crear la tabla de consumo de inteligencia artificial:', error.message);
    console.error('   Ejecute manualmente database/migrations/2026-11-10_inteligencia_artificial.sql');
  }
  try {
    await ensureTriggers();
  } catch (error) {
    console.error('❌ No se pudieron crear los triggers de auditoría (roles / permisos):', error.message);
    console.error('   Ejecute manualmente database/migrations/2026-11-07_auditoria.sql');
  }
};

module.exports = { ensureSchema, TRIGGERS, REQUIRED_COLUMNS, POLICY_TABLES, DEFAULT_POLICY_CATEGORIES };
