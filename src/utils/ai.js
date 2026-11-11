/**
 * Base del módulo de Inteligencia Artificial (opcional por residencial).
 *
 * - La clave del proveedor vive SOLO en el servidor (variable ANTHROPIC_API_KEY).
 * - La administración enciende o apaga la IA, y cada función por separado, desde el
 *   panel (parámetros IA_* en TBL_MS_PARAMETROS). Sin configurar, todo queda apagado
 *   y la app funciona igual que antes.
 * - Cada consulta se registra en TBL_IA_USO para aplicar el tope mensual de la
 *   residencial y el tope diario por usuario.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { mysqlPool } = require('../config/db');
const { logParametro, ACCION } = require('./audit');

// Modelo económico por defecto; el asistente puede usar otro si se configura en el servidor.
const MODELO = process.env.IA_MODELO || 'claude-haiku-5-5';
const MODELO_ASISTENTE = process.env.IA_MODELO_ASISTENTE || MODELO;

// USD por millón de tokens (entrada, salida): solo para el costo estimado del panel.
const PRECIOS = {
  'claude-haiku-5-5': [0.10, 0.50],
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20],
};

const FUNCIONES = {
  reglamento: { parametro: 'IA_REGLAMENTO', nombre: 'Preguntas sobre el reglamento' },
  asistente: { parametro: 'IA_ASISTENTE', nombre: 'Asistente del residente' },
  fotos: { parametro: 'IA_FOTOS', nombre: 'Lectura de identidad y placa por foto' },
  analitica: { parametro: 'IA_ANALITICA', nombre: 'Consultas y resumen para administración' },
  solicitudes: { parametro: 'IA_SOLICITUDES', nombre: 'Análisis de solicitudes de residentes' },
};
const P_HABILITADA = 'IA_HABILITADA';
const P_LIMITE_MENSUAL = 'IA_LIMITE_MENSUAL';
const P_LIMITE_DIARIO = 'IA_LIMITE_DIARIO_USUARIO';
const DEFAULT_LIMITE_MENSUAL = 3000;
const DEFAULT_LIMITE_DIARIO = 30;

let client = null;
/** Cliente del proveedor, o null si el servidor no tiene la clave configurada. */
const getClient = () => {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
};

const toInt = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Configuración guardada por la administración (lo que no exista se considera apagado). */
const getConfig = async () => {
  const names = [P_HABILITADA, P_LIMITE_MENSUAL, P_LIMITE_DIARIO, ...Object.values(FUNCIONES).map(f => f.parametro)];
  const [rows] = await mysqlPool.query('SELECT PARAMETRO, VALOR FROM TBL_MS_PARAMETROS WHERE PARAMETRO IN (?)', [names]);
  const map = Object.fromEntries(rows.map(r => [r.PARAMETRO, r.VALOR]));
  const funciones = {};
  for (const [key, f] of Object.entries(FUNCIONES)) funciones[key] = map[f.parametro] === '1';
  return {
    disponible: Boolean(getClient()),
    habilitada: map[P_HABILITADA] === '1',
    funciones,
    limiteMensual: toInt(map[P_LIMITE_MENSUAL], DEFAULT_LIMITE_MENSUAL),
    limiteDiarioUsuario: toInt(map[P_LIMITE_DIARIO], DEFAULT_LIMITE_DIARIO),
  };
};

/** Lo que realmente puede usar un usuario: clave configurada + IA encendida + función encendida. */
const funcionesActivas = (cfg) => {
  const on = cfg.disponible && cfg.habilitada;
  return Object.fromEntries(Object.keys(FUNCIONES).map(k => [k, on && cfg.funciones[k]]));
};

/** Guarda la configuración (crea o actualiza cada parámetro y deja constancia en auditoría). */
const saveConfig = async (req, { habilitada, funciones, limiteMensual, limiteDiarioUsuario }) => {
  const userId = req.user.id;
  const upsert = async (parametro, valor) => {
    const [rows] = await mysqlPool.query('SELECT * FROM TBL_MS_PARAMETROS WHERE PARAMETRO = ?', [parametro]);
    if (rows.length > 0) {
      if (String(rows[0].VALOR) === String(valor)) return;
      await mysqlPool.query('UPDATE TBL_MS_PARAMETROS SET VALOR = ?, FECHA_MODIFICACION = NOW() WHERE PARAMETRO = ?', [valor, parametro]);
      await logParametro(mysqlPool, req, { parametro, accion: ACCION.MODIFICACION, antes: rows[0] });
    } else {
      await mysqlPool.query('INSERT INTO TBL_MS_PARAMETROS (ID_USUARIO, PARAMETRO, VALOR, FECHA_CREACION) VALUES (?, ?, ?, NOW())', [userId, parametro, valor]);
      await logParametro(mysqlPool, req, { parametro, accion: ACCION.CREACION, detalle: `Parámetro creado desde Inteligencia Artificial con valor ${valor}` });
    }
  };

  if (typeof habilitada === 'boolean') await upsert(P_HABILITADA, habilitada ? '1' : '0');
  for (const [key, f] of Object.entries(FUNCIONES)) {
    if (funciones && typeof funciones[key] === 'boolean') await upsert(f.parametro, funciones[key] ? '1' : '0');
  }
  if (limiteMensual !== undefined) await upsert(P_LIMITE_MENSUAL, String(toInt(limiteMensual, DEFAULT_LIMITE_MENSUAL)));
  if (limiteDiarioUsuario !== undefined) await upsert(P_LIMITE_DIARIO, String(toInt(limiteDiarioUsuario, DEFAULT_LIMITE_DIARIO)));
};

/** Consumo del mes en curso (hora de Honduras), por función, con costo estimado. */
const getUsoMes = async () => {
  const [rows] = await mysqlPool.query(
    `SELECT FUNCION, MODELO, COUNT(*) AS CONSULTAS,
            COALESCE(SUM(TOKENS_ENTRADA), 0) AS TOKENS_ENTRADA, COALESCE(SUM(TOKENS_SALIDA), 0) AS TOKENS_SALIDA
       FROM TBL_IA_USO
      WHERE FECHA >= DATE_FORMAT(NOW(), '%Y-%m-01')
      GROUP BY FUNCION, MODELO`
  );
  const porFuncion = Object.fromEntries(Object.keys(FUNCIONES).map(k => [k, { consultas: 0, costoUsd: 0 }]));
  let consultas = 0;
  let costoUsd = 0;
  for (const r of rows) {
    const precio = PRECIOS[r.MODELO];
    const costo = precio ? (Number(r.TOKENS_ENTRADA) * precio[0] + Number(r.TOKENS_SALIDA) * precio[1]) / 1e6 : 0;
    const f = porFuncion[r.FUNCION] || (porFuncion[r.FUNCION] = { consultas: 0, costoUsd: 0 });
    f.consultas += Number(r.CONSULTAS);
    f.costoUsd += costo;
    consultas += Number(r.CONSULTAS);
    costoUsd += costo;
  }
  return { consultas, costoUsd, porFuncion };
};

/** Registra una consulta para los topes y el reporte de consumo. */
const registrarUso = async (userId, funcion, modelo, usage) => {
  try {
    const entrada = (usage?.input_tokens || 0) + (usage?.cache_creation_input_tokens || 0) + (usage?.cache_read_input_tokens || 0);
    await mysqlPool.query(
      'INSERT INTO TBL_IA_USO (ID_USUARIO, FUNCION, MODELO, TOKENS_ENTRADA, TOKENS_SALIDA, FECHA) VALUES (?, ?, ?, ?, ?, NOW())',
      [userId, funcion, modelo, entrada, usage?.output_tokens || 0]
    );
  } catch (err) {
    console.error('[IA] No se pudo registrar el uso:', err.message);
  }
};

/**
 * Middleware: deja pasar solo si la función de IA está encendida y dentro de los topes.
 * Con la IA apagada responde 403 (la app simplemente oculta estas opciones).
 */
const requireIA = (funcion) => async (req, res, next) => {
  try {
    const cfg = await getConfig();
    if (!cfg.disponible) {
      return res.status(503).json({ success: false, code: 'IA_NO_CONFIGURADA', message: 'La inteligencia artificial no está configurada en el servidor.' });
    }
    if (!funcionesActivas(cfg)[funcion]) {
      return res.status(403).json({ success: false, code: 'IA_DESACTIVADA', message: 'Esta función de inteligencia artificial no está activada en su residencial.' });
    }
    if (cfg.limiteMensual > 0) {
      const [[mes]] = await mysqlPool.query("SELECT COUNT(*) AS total FROM TBL_IA_USO WHERE FECHA >= DATE_FORMAT(NOW(), '%Y-%m-01')");
      if (Number(mes.total) >= cfg.limiteMensual) {
        return res.status(429).json({ success: false, code: 'IA_LIMITE_MENSUAL', message: 'La residencial alcanzó el límite mensual de consultas de inteligencia artificial.' });
      }
    }
    if (cfg.limiteDiarioUsuario > 0) {
      const [[hoy]] = await mysqlPool.query('SELECT COUNT(*) AS total FROM TBL_IA_USO WHERE ID_USUARIO = ? AND FECHA >= CURDATE()', [req.user.id]);
      if (Number(hoy.total) >= cfg.limiteDiarioUsuario) {
        return res.status(429).json({ success: false, code: 'IA_LIMITE_DIARIO', message: 'Alcanzó su límite diario de consultas de inteligencia artificial. Intente mañana.' });
      }
    }
    next();
  } catch (err) {
    console.error('[IA] Error al verificar la configuración:', err);
    res.status(500).json({ success: false, message: 'No se pudo verificar la configuración de inteligencia artificial.' });
  }
};

/** Texto visible de una respuesta (los bloques de razonamiento se ignoran). */
const textOf = (message) => message.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();

/** Convierte un error del proveedor en una respuesta clara para la app. */
const handleAIError = (res, err, contexto) => {
  console.error(`[IA] ${contexto}:`, err?.status || '', err?.message || err);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return res.status(503).json({ success: false, code: 'IA_NO_CONFIGURADA', message: 'La clave de inteligencia artificial del servidor no es válida.' });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return res.status(429).json({ success: false, message: 'El servicio de inteligencia artificial está ocupado. Intente de nuevo en un momento.' });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return res.status(502).json({ success: false, message: 'No se pudo conectar con el servicio de inteligencia artificial.' });
  }
  if (err instanceof Anthropic.APIError) {
    return res.status(502).json({ success: false, message: 'El servicio de inteligencia artificial no pudo responder. Intente de nuevo.' });
  }
  return res.status(500).json({ success: false, message: 'Error interno al procesar la consulta.' });
};

module.exports = {
  MODELO,
  MODELO_ASISTENTE,
  FUNCIONES,
  getClient,
  getConfig,
  funcionesActivas,
  saveConfig,
  getUsoMes,
  registrarUso,
  requireIA,
  textOf,
  handleAIError,
};
