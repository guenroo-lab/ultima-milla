/**
 * ============================================================
 * Configuracion.gs
 * Constantes globales del sistema de expedición LM Málaga
 * ============================================================
 */

// === IDENTIFICADOR DEL SPREADSHEET ===
// Se rellena automáticamente la primera vez que se ejecuta inicializarSistema()
// Guardado en PropertiesService para no perderse entre ejecuciones.
function getSpreadsheetId() {
  return PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
}
function setSpreadsheetId(id) {
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', id);
}

// === CARPETA DE DRIVE PARA FOTOS DE INCIDENCIAS ===
// Se crea automáticamente la primera vez que se sube una foto. Guardada en
// PropertiesService, mismo patrón que SPREADSHEET_ID.
function getIncidenciasFolderId() {
  return PropertiesService.getScriptProperties().getProperty('INCIDENCIAS_FOLDER_ID');
}
function setIncidenciasFolderId(id) {
  PropertiesService.getScriptProperties().setProperty('INCIDENCIAS_FOLDER_ID', id);
}

// === WEBHOOK GOOGLE CHAT (incidencias) ===
// Pega aquí la URL del webhook del espacio de Chat.
// Cómo obtenerla: Espacio de Chat → Aplicaciones e integraciones → Webhooks → Añadir
function getWebhookChat() {
  return PropertiesService.getScriptProperties().getProperty('WEBHOOK_CHAT') || '';
}
function setWebhookChat(url) {
  PropertiesService.getScriptProperties().setProperty('WEBHOOK_CHAT', url);
}

// === PARÁMETROS OPERATIVOS ===
const CONFIG = {
  HORA_CAMBIO_MODO: 14,        // < 14h = mañana (carga), >= 14h = tarde (preparación)
  POSICIONES_SILUETA: 16,      // posiciones por silueta (valor por defecto)
  POSICIONES_POR_SILUETA: { E: 27, F: 27 }, // excepciones: E y F son más grandes que las demás (valores por defecto — ver posicionesDeSilueta())
  SILUETAS: ['A', 'B', 'C', 'D', 'E', 'F'], // G se retiró (2026-07-06): sin uso real; si hiciera falta más espacio se usan zonas libres/ficticias en vez de una silueta física más
  TIENDAS: ['Málaga', 'Marbella', 'Mijas'],

  // Código numérico de tienda (prefijo de idPedido y nombre de archivo de inventario)
  CODIGO_TIENDA: { 'Marbella': '014', 'Málaga': '036', 'Granada': '043', 'Mijas': '279' },

  // Operarios (en producción podrían venir de una hoja USUARIOS)
  OPERARIOS: ['Pedro Gil', 'Juan Martínez', 'Ana Ruiz', 'Miguel Torres'],

  // Transportistas → flujo
  TRANSPORTISTAS_FLUJO: {
    'Correcaminos': 'transporte',
    'Correcaminos Instalaciones': 'instalacion',
    'Correcaminos PRO': 'pro',
    'Remansur': 'remansur_transporte',
    'Remansur PRO': 'remansur_pro',
    'GruaRemansur': 'grua_remansur'
  },

  // Letras de flujo para el mapa de siluetas
  FLUJO_LETRA: {
    transporte: 'T',
    instalacion: 'I',
    pro: 'P',
    remansur_transporte: 'R',
    remansur_pro: 'R+',
    grua_remansur: 'G'
  },

  FLUJO_LABEL: {
    transporte: 'Transporte',
    instalacion: 'Instalación',
    pro: 'PRO',
    remansur_transporte: 'Remansur',
    remansur_pro: 'Remansur PRO',
    grua_remansur: 'GruaRemansur'
  },

  // Soportes y ocupación
  SOPORTES: [
    { id: 'palet_euro',      nombre: 'Palet Euro',      ocupa: 0.5 },
    { id: 'palet_americano', nombre: 'Palet Americano', ocupa: 0.5 },
    { id: 'palet_estaribel', nombre: 'Palet Estaríbel', ocupa: 0.5 },
    { id: 'jaula',           nombre: 'Jaula',           ocupa: 0.5 },
    { id: 'palet_doble',     nombre: 'Palet Doble',     ocupa: 1.0 },
    { id: 'palet_medio',     nombre: 'Palet Medio',     ocupa: 0.25 },
    { id: 'bulto',           nombre: 'Bulto',           ocupa: 0 }
  ],

  // Buzón de sugerencias / mejoras / fallos (botón de la app, mismo destino
  // que el botón equivalente de la app de Cargas/Descargas)
  CORREO_SUGERENCIAS: 'pedro.gil@ext.leroymerlin.es'
};

// === HELPERS DE CÓDIGO DE TIENDA (mapa único) ===
function codigoTienda(tienda) {
  return CONFIG.CODIGO_TIENDA[tienda] || '000';
}
function tiendaPorCodigo(codigo) {
  var m = CONFIG.CODIGO_TIENDA;
  for (var k in m) { if (m[k] === codigo) return k; }
  return null;
}

// === CAPACIDAD POR SILUETA (editable a mano desde el panel admin) ===
// El admin puede ampliar manualmente la capacidad de una silueta concreta
// (p.ej. para compactar mercancía y ganar espacio) sin tocar código. El
// ajuste se guarda en PropertiesService como un override que se FUSIONA por
// encima de los valores por defecto de CONFIG.POSICIONES_POR_SILUETA — así,
// mientras no se toque una silueta, sigue con su valor de código de siempre.
// Memoizado por EJECUCIÓN (mismo patrón que _SS_MEMO/_HOJA_MEMO en
// EstructuraSheets.gs): posicionesDeSilueta() se llama muchas veces dentro
// de una misma petición (p.ej. compactar siluetas recorre huecos posición a
// posición), así que releer PropertiesService en cada llamada sería un coste
// repetido innecesario dentro de la MISMA ejecución.
var _POS_POR_SILUETA_MEMO = null;
function posicionesPorSiluetaEfectivo() {
  if (_POS_POR_SILUETA_MEMO) return _POS_POR_SILUETA_MEMO;
  var mapa = {};
  var base = CONFIG.POSICIONES_POR_SILUETA || {};
  for (var k in base) mapa[k] = base[k];
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('POSICIONES_POR_SILUETA_OVERRIDE');
    if (raw) {
      var override = JSON.parse(raw);
      for (var k2 in override) mapa[k2] = override[k2];
    }
  } catch (e) { /* override corrupto: se ignora, quedan los valores de CONFIG */ }
  _POS_POR_SILUETA_MEMO = mapa;
  return mapa;
}

// Nº de posiciones de UNA silueta concreta (usa el override guardado o la
// excepción de CONFIG.POSICIONES_POR_SILUETA si la tiene, si no el valor
// por defecto).
function posicionesDeSilueta(silueta) {
  var mapa = posicionesPorSiluetaEfectivo();
  return mapa[silueta] || CONFIG.POSICIONES_SILUETA;
}

// === DISPONIBILIDAD EXTERNA (Drive de "Pedidos Disponibles", ajeno a este sistema) ===
// Al cerrar un pedido en silueta, se vuelca el nº de palets/bultos generados
// en la hoja de esa tienda, para que el equipo que gestiona ese Drive vea
// de un vistazo qué se ha preparado sin tener que entrar en esta app.
const DISPONIBILIDAD_SHEET_ID = '187Xa0TGkDqudhJJbekEYwQGqmKYwn6hcOG1-FujXCF4';
const DISPONIBILIDAD_PESTANA_POR_TIENDA = {
  'Málaga': 'DISP_MALAGA',
  'Marbella': 'DISP_MARBELLA',
  'Mijas': 'DISP_MIJAS',
  'Granada': 'DISP_GRANADA'
};
const DISPONIBILIDAD_COL_ID_PEDIDO = 9;  // columna I
const DISPONIBILIDAD_COL_PALETS = 25;    // columna Y
const DISPONIBILIDAD_COL_BULTOS = 26;    // columna Z

// Memoizado por ejecución, mismo patrón que _SS_MEMO en EstructuraSheets.gs.
var _SS_DISPONIBILIDAD_MEMO = null;
function getSSDisponibilidad() {
  if (_SS_DISPONIBILIDAD_MEMO) return _SS_DISPONIBILIDAD_MEMO;
  _SS_DISPONIBILIDAD_MEMO = SpreadsheetApp.openById(DISPONIBILIDAD_SHEET_ID);
  return _SS_DISPONIBILIDAD_MEMO;
}

// === SUPABASE (Fase 1 de la migración: escritura en sombra, ver
// docs/superpowers/specs/2026-07-28-migracion-sheets-supabase-design.md) ===
// URL y clave viven en Propiedades del script (Configuración del proyecto),
// NUNCA en el código fuente. Usar SIEMPRE la clave legacy service_role (JWT) —
// la clave nueva sb_secret_... la rechaza Supabase cuando se llama desde
// UrlFetchApp (la detecta como "de navegador" y responde HTTP 401).
var _SUPABASE_CFG_MEMO = null;
function getSupabaseConfig_() {
  if (_SUPABASE_CFG_MEMO) return _SUPABASE_CFG_MEMO;
  var p = PropertiesService.getScriptProperties();
  var url = p.getProperty('SUPABASE_URL');
  var key = p.getProperty('SUPABASE_SERVICE_KEY');
  if (!url || !key) return null;
  _SUPABASE_CFG_MEMO = { url: url, key: key };
  return _SUPABASE_CFG_MEMO;
}

// === NOMBRES DE HOJAS ===
const HOJAS = {
  PEDIDOS: 'PEDIDOS',
  LINEAS: 'LINEAS_PREPARACION',
  OCUPACION: 'OCUPACION_SILUETAS',
  CARGAS: 'CARGAS',
  HISTORIAL: 'HISTORIAL_ENTREGAS',
  LOG: 'LOG_ACTIVIDAD',
  VISAS: 'VISAS',
  RETIRADAS: 'RETIRADAS_STOCK',
  HIST_TRANSP: 'HISTORIAL_TRANSPORTISTA',
  INCIDENCIAS: 'INCIDENCIAS',
  INC_COMENTARIOS: 'INCIDENCIAS_COMENTARIOS'
};

// === COLUMNAS DE CADA HOJA (orden exacto) ===
const COLUMNAS = {
  PEDIDOS: ['id', 'ped', 'tienda', 'transportista', 'flujo', 'estado', 'pct',
            'operario', 'silueta', 'posIni', 'posFin', 'numeroCarga', 'soportes', 'nLin', 'nUbic', 'actualizado', 'intentoCarga', 'comentario', 'tipoEntrega', 'enRevision', 'sdImpreso', 'parcial'],
  LINEAS: ['id', 'idPedido', 'idx', 'dir', 'ref', 'ean', 'des', 'ctd',
           'tipoUbic', 'esPicking', 'estado', 'motivo', 'operario', 'ts', 'muelleHecho'],
  OCUPACION: ['silueta', 'pos', 'layer', 'pedido', 'tienda', 'flujo', 'reservado'],
  CARGAS: ['id', 'numCarga', 'fecha', 'estado', 'items', 'responsable', 'cargador', 'fechaCierre', 'esCamionGrua', 'agencia'],
  HISTORIAL: ['pedido', 'tienda', 'transportista', 'silueta', 'posIni', 'posFin', 'cargador', 'ts', 'confirmadoTs', 'responsable'],
  LOG: ['ts', 'tipo', 'detalle', 'usuario'],
  VISAS: ['id', 'ped', 'tienda', 'estado', 'numeroCarga', 'fechaAlta', 'fechaResuelta', 'motivoAlerta'],
  RETIRADAS: ['fecha', 'tienda', 'pedido', 'cliente', 'resultado', 'code', 'ts'],
  HIST_TRANSP: ['id', 'idPedido', 'ped', 'tienda', 'transportista', 'flujo', 'evento', 'fecha'],
  INCIDENCIAS: ['id', 'idPedido', 'ped', 'tienda', 'tipo', 'prioridad', 'estado', 'asignado', 'creadoPor', 'creadoTs', 'actualizado'],
  INC_COMENTARIOS: ['id', 'idIncidencia', 'autor', 'rol', 'texto', 'fotos', 'ts']
};
