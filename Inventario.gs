/**
 * ============================================================
 * Inventario.gs · Lector de inventario + clasificador de pedidos
 * LM Málaga — preparación de última milla
 * ============================================================
 *
 * FLUJO
 *  1. Los inventarios viven en una carpeta de Google Drive, UN archivo por tienda.
 *     El nombre del archivo empieza por el código de tienda: 014 / 036 / 043 / 279.
 *  2. Cada archivo es una hoja "Listado" (export Pyxis): cabeceras en la fila 3,
 *     datos desde la fila 4. Cada fila = una línea/ubicación de un pedido; el nº de
 *     pedido se repite en varias filas.
 *  3. Administración pega números de pedido (sin prefijo de tienda) en 4 zonas:
 *     Transporte / Instalaciones / PRO / Remansur. clasificarPedidos() localiza cada
 *     pedido en el inventario, deduce su TIENDA (por el nombre del archivo) y sus
 *     líneas, y los devuelve agrupados por transporte y ordenados por tienda.
 *
 * NOTA: la lógica de parseo y clasificación (construirIndiceInventario / clasificar*)
 * está validada contra un export real (036 = Málaga: 4014 líneas → 1313 pedidos).
 *
 * REQUISITOS AL DESPLEGAR:
 *  - INVENTARIO_FOLDER_ID ya apunta a la carpeta de Drive.
 *  - Los inventarios pueden ser Hojas de Google O Excel (.xlsx/.xls): los Excel se
 *    convierten a una Hoja temporal al vuelo y se borran tras leerlos.
 *  - Para esa conversión hay que habilitar el SERVICIO AVANZADO "Drive":
 *    Editor de Apps Script → Servicios (+) → "Drive API" → Añadir.
 *  - Solo se leen los archivos cuyo nombre contiene el código de tienda
 *    (014/036/043/279). Los demás (p.ej. temp_*) se ignoran con aviso.
 */

// ===== CONFIG =====
const INVENTARIO_FOLDER_ID = '1_1muNRzTzLrgSLyZdWtpf7GJeRqbplIG'; // carpeta de Drive con los inventarios

// Mapa código↔tienda centralizado en Configuracion.gs (tiendaPorCodigo / codigoTienda)
const TRANSPORTES       = ['Transporte', 'Instalaciones', 'PRO', 'Remansur'];

const INV_SHEET_NOMBRE = 'Listado'; // hoja a leer; si no existe, se usa la primera
const INV_FILA_DATOS   = 4;         // cabeceras en la fila 3 → los datos empiezan en la 4
// Columnas (1-based) del "Listado Inventario Pedido Cliente" de Pyxis
const INV_COL = { dir: 1, ped: 2, seccion: 3, subseccion: 4, ref: 5, ean: 6, des: 7, ctd: 8 };

// ===== LÓGICA PURA (validada) =====

/**
 * Reconstruye los pedidos a partir de las filas mapeadas de un inventario.
 * @param {Array<Array>} filas  Cada fila = [dir, ped, ref, ean, des, ctd]
 * @param {string} tienda       Tienda a la que pertenece este inventario
 * @return {Object} índice  ped → { ped, tienda, lineas:[], nUbic, nLin }
 */
function construirIndiceInventario(filas, tienda) {
  const idx = {};
  for (let i = 0; i < filas.length; i++) {
    const f = filas[i];
    const ped = String(f[1] || '').trim();
    if (!ped) continue;
    if (!idx[ped]) idx[ped] = { ped: ped, tienda: tienda, lineas: [] };
    idx[ped].lineas.push({
      dir: String(f[0] || '').trim(),
      ref: String(f[2] || '').trim(),
      ean: String(f[3] || '').trim(),
      des: String(f[4] || '').trim(),
      ctd: Number(f[5]) || 0
    });
  }
  for (const k in idx) {
    const p = idx[k];
    p.nLin = p.lineas.length;
    p.nUbic = new Set(p.lineas.map(function (l) { return l.dir; })).size;
  }
  return idx;
}

/**
 * Resuelve a qué tienda corresponde un pedido del índice combinado.
 * @param {Object} entry  índice[ped] = { ped, porTienda:{ tienda: {tienda,lineas,nUbic,nLin} } }
 * @param {(string|null)} tiendaColisiones  tienda elegida (global) para resolver duplicados
 * @return {Object} { tienda, data } | { colision:true, tiendas:[...] }
 */
function resolverOcurrencia(entry, tiendaColisiones) {
  const tiendas = Object.keys(entry.porTienda);
  if (tiendas.length === 1) return { tienda: tiendas[0], data: entry.porTienda[tiendas[0]] };
  if (tiendaColisiones && entry.porTienda[tiendaColisiones]) {
    return { tienda: tiendaColisiones, data: entry.porTienda[tiendaColisiones] };
  }
  return { colision: true, tiendas: tiendas };
}

// ===== LECTURA DESDE DRIVE =====

/** Deduce la tienda a partir del nombre del archivo (busca el código 014/036/043/279). */
function tiendaDeNombreArchivo(nombre) {
  const m = String(nombre).match(/(\d{3})/);
  return m ? (tiendaPorCodigo(m[1]) || null) : null;
}

/** Convierte la matriz completa de la hoja (getValues) a filas [dir,ped,ref,ean,des,ctd]. */
function mapearFilasHoja(valores) {
  const filas = [];
  for (let i = INV_FILA_DATOS - 1; i < valores.length; i++) {
    const row = valores[i];
    const ped = String(row[INV_COL.ped - 1] || '').trim();
    if (!ped) continue;
    filas.push([
      String(row[INV_COL.dir - 1] || '').trim(),
      ped,
      String(row[INV_COL.ref - 1] || '').trim(),
      String(row[INV_COL.ean - 1] || '').trim(),
      String(row[INV_COL.des - 1] || '').trim().replace(/[\r\n\t]+/g, ' '),
      row[INV_COL.ctd - 1]
    ]);
  }
  return filas;
}

/**
 * Abre un archivo como Spreadsheet. Si es Excel (.xlsx/.xls) lo convierte a una
 * Hoja de Google TEMPORAL (requiere el servicio avanzado "Drive").
 * @return {{ss: Spreadsheet, tempId: (string|null)}}  tempId != null → hay que borrarlo
 */
function abrirComoSpreadsheet(file) {
  if (file.getMimeType() === MimeType.GOOGLE_SHEETS) {
    return { ss: SpreadsheetApp.open(file), tempId: null };
  }
  // Excel → Hoja de Google temporal. Subimos los BYTES del archivo (no copia por ID),
  // así funciona aunque el original esté en una Unidad compartida / "Compartido conmigo".
  // Compatible con el servicio avanzado Drive v2 (insert) y v3 (create).
  const nombre = '__tmp_inv_' + file.getName();
  const blob = file.getBlob();
  let creado;
  if (Drive.Files && Drive.Files.insert) {            // Drive API v2
    creado = Drive.Files.insert({ title: nombre, mimeType: MimeType.GOOGLE_SHEETS }, blob, { convert: true });
  } else {                                            // Drive API v3
    creado = Drive.Files.create({ name: nombre, mimeType: MimeType.GOOGLE_SHEETS }, blob);
  }
  return { ss: SpreadsheetApp.openById(creado.id), tempId: creado.id };
}

// ===== CACHÉ DE INVENTARIO (para no reconvertir los Excel en cada clasificación) =====
var INV_CACHE_KEY = 'INV_IDX_v1';
var INV_CACHE_TTL = 1800; // 30 minutos

function _cacheGetInv() {
  try {
    var cache = CacheService.getScriptCache();
    var meta = cache.get(INV_CACHE_KEY + '_n');
    if (!meta) return null;
    var n = Number(meta), keys = [];
    for (var i = 0; i < n; i++) keys.push(INV_CACHE_KEY + '_' + i);
    var parts = cache.getAll(keys), str = '';
    for (var j = 0; j < n; j++) {
      var p = parts[INV_CACHE_KEY + '_' + j];
      if (p == null) return null; // algún trozo caducó → recargar
      str += p;
    }
    return JSON.parse(str);
  } catch (e) { return null; }
}

function _cachePutInv(obj) {
  try {
    var cache = CacheService.getScriptCache();
    var str = JSON.stringify(obj);
    var size = 90000, n = Math.ceil(str.length / size), map = {};
    for (var i = 0; i < n; i++) map[INV_CACHE_KEY + '_' + i] = str.substr(i * size, size);
    map[INV_CACHE_KEY + '_n'] = String(n);
    cache.putAll(map, INV_CACHE_TTL);
  } catch (e) { /* si no cabe en caché, no pasa nada: se leerá en vivo */ }
}

/** Fuerza recarga del inventario desde Drive (ejecutar tras subir Excel nuevos). */
function recargarInventario() {
  try { CacheService.getScriptCache().remove(INV_CACHE_KEY + '_n'); } catch (e) {}
  var r = cargarInventario(null, true);
  Logger.log('Inventario recargado. Tiendas: ' + r.tiendas.join(', '));
  return { ok: true, tiendas: r.tiendas, pedidos: Object.keys(r.indice).length };
}

/**
 * Carga TODOS los inventarios de la carpeta y devuelve un índice combinado.
 * Usa caché (30 min) salvo que se fuerce con forzar=true.
 * @param {string} [folderId]  ID de carpeta; por defecto INVENTARIO_FOLDER_ID
 * @param {boolean} [forzar]   true = ignora la caché y relee de Drive
 * @return {Object} { indice, avisos:[], tiendas:[] }
 */
function cargarInventario(folderId, forzar) {
  if (!forzar) {
    var cached = _cacheGetInv();
    if (cached) return cached;
  }
  var resultado = _cargarInventarioLive(folderId);
  _cachePutInv(resultado);
  return resultado;
}

function _cargarInventarioLive(folderId) {
  const carpeta = DriveApp.getFolderById(folderId || INVENTARIO_FOLDER_ID);
  const indice = {};
  const avisos = [];
  const tiendas = [];
  const it = carpeta.getFiles();
  while (it.hasNext()) {
    const file = it.next();
    const nombre = file.getName();
    const tienda = tiendaDeNombreArchivo(nombre);
    if (!tienda) { avisos.push('Sin código de tienda en el nombre, ignorado: ' + nombre); continue; }
    let abierto;
    try {
      abierto = abrirComoSpreadsheet(file);
    } catch (e) {
      avisos.push('No se pudo abrir/convertir, ignorado: ' + nombre + ' (' + e.message + ')');
      continue;
    }
    const hoja = abierto.ss.getSheetByName(INV_SHEET_NOMBRE) || abierto.ss.getSheets()[0];
    const filas = mapearFilasHoja(hoja.getDataRange().getValues());
    if (abierto.tempId) { try { DriveApp.getFileById(abierto.tempId).setTrashed(true); } catch (e2) {} }
    const idxT = construirIndiceInventario(filas, tienda);
    let nuevos = 0;
    for (const k in idxT) {
      if (!indice[k]) indice[k] = { ped: k, porTienda: {} };
      indice[k].porTienda[tienda] = idxT[k];
      nuevos++;
    }
    tiendas.push(tienda);
  }
  // Las colisiones globales del inventario son irrelevantes: solo importa cuando
  // un pedido que el usuario PEGA está en dos tiendas (eso lo resuelve resolverOcurrencia
  // y el selector del clasificador). No avisamos de repeticiones del inventario entero.
  return { indice: indice, avisos: avisos, tiendas: tiendas };
}

// ===== API PARA EL FRONTEND (google.script.run.*) =====

/**
 * Clasifica los pedidos pegados. Llamada desde el frontend.
 * @param {Object} numerosPorTransporte  { Transporte:[...], Instalaciones:[...], PRO:[...], Remansur:[...] }
 * @param {Object} [opciones]  { tiendaColisiones:(string|null), parciales:[{ped,transporte,dirs:[...]}] }
 * @return {Object} { resultado, colisiones, avisos, tiendas }
 */
function clasificarPedidos(numerosPorTransporte, opciones) {
  opciones = opciones || {};
  const tiendaColisiones = opciones.tiendaColisiones || null;
  const parciales = opciones.parciales || [];
  const inv = cargarInventario();
  const indice = inv.indice;

  // pedidos marcados como parciales (clave transporte|ped) → se excluyen del bloque
  const esParcial = {};
  parciales.forEach(function (p) { esParcial[p.transporte + '|' + String(p.ped).trim()] = true; });

  const resultado = {};
  const colisiones = [];
  TRANSPORTES.forEach(function (t) { resultado[t] = { encontrados: [], noEncontrados: [] }; });

  // 1) pedidos pegados en bloque
  TRANSPORTES.forEach(function (t) {
    const nums = (numerosPorTransporte[t] || []).map(function (n) { return String(n).trim(); }).filter(Boolean);
    nums.forEach(function (n) {
      if (esParcial[t + '|' + n]) return; // lo procesa el parcial
      const entry = indice[n];
      if (!entry) { resultado[t].noEncontrados.push(n); return; }
      const r = resolverOcurrencia(entry, tiendaColisiones);
      if (r.colision) { colisiones.push({ ped: n, transporte: t, tiendas: r.tiendas }); return; }
      resultado[t].encontrados.push({ ped: n, tienda: r.tienda, nUbic: r.data.nUbic, nLin: r.data.nLin, parcial: false });
    });
  });

  // 2) pedidos parciales (solo las direcciones elegidas)
  parciales.forEach(function (p) {
    const t = p.transporte; const n = String(p.ped).trim();
    if (!resultado[t]) return;
    const entry = indice[n];
    if (!entry) { resultado[t].noEncontrados.push(n); return; }
    // Si al elegir direcciones (obtenerPedido) el admin ya eligió una tienda
    // concreta para ESTE pedido (colisión resuelta ahí mismo), se respeta esa
    // elección puntual en vez de depender del selector global de colisiones
    // -- necesario porque dos pedidos parciales del mismo lote pueden vivir
    // en colisiones de tiendas DISTINTAS, y un único tiendaColisiones global
    // no puede acertar en los dos a la vez.
    var r = (p.tienda && entry.porTienda[p.tienda])
      ? { tienda: p.tienda, data: entry.porTienda[p.tienda] }
      : resolverOcurrencia(entry, tiendaColisiones);
    if (r.colision) { colisiones.push({ ped: n, transporte: t, tiendas: r.tiendas, parcial: true }); return; }
    const dirsSel = (p.dirs || []).map(function (d) { return String(d).trim(); });
    const lineasSel = r.data.lineas.filter(function (l) { return dirsSel.indexOf(l.dir) !== -1; });
    const nUbic = new Set(lineasSel.map(function (l) { return l.dir; })).size;
    resultado[t].encontrados.push({ ped: n, tienda: r.tienda, nUbic: nUbic, nLin: lineasSel.length, parcial: true, totalUbic: r.data.nUbic });
  });

  TRANSPORTES.forEach(function (t) {
    resultado[t].encontrados.sort(function (a, b) { return a.tienda.localeCompare(b.tienda) || a.nUbic - b.nUbic; });
  });

  return { resultado: resultado, colisiones: colisiones, avisos: inv.avisos, tiendas: inv.tiendas };
}

/**
 * Devuelve las direcciones de un pedido para elegir un parcial (casillas).
 * Si el pedido vive en VARIAS tiendas a la vez (mismo número, inventarios
 * distintos) y no se indica tiendaElegida, YA NO se asume la primera tienda
 * en silencio -- bug real reportado por el usuario: al marcar un pedido como
 * parcial, las direcciones que se le enseñaban a elegir podían ser las de la
 * tienda EQUIVOCADA sin que hubiera ninguna forma de elegir, a diferencia del
 * flujo de pedidos completos (clasificarPedidos ya deja elegir tienda vía
 * colisiones). Ahora, sin tiendaElegida y con colisión real, se devuelve SIN
 * direcciones (dirs:[]) para que el cliente muestre el mismo selector de
 * tienda que ya usa para colisiones normales, y solo cuando se vuelve a
 * llamar con la tienda elegida se devuelven las direcciones de esa tienda.
 * @return {(Object|null)} { ped, tiendas:[...], tienda, dirs:[{dir,des}], nLin }
 */
function obtenerPedido(num, tiendaElegida) {
  const inv = cargarInventario();
  const entry = inv.indice[String(num).trim()];
  if (!entry) return null;
  const tiendas = Object.keys(entry.porTienda);
  const tiendaValida = tiendaElegida && entry.porTienda[tiendaElegida] ? tiendaElegida : null;
  if (tiendas.length > 1 && !tiendaValida) {
    return { ped: entry.ped, tiendas: tiendas, tienda: null, dirs: [], nLin: 0 };
  }
  const tiendaUsar = tiendaValida || tiendas[0];
  const data = entry.porTienda[tiendaUsar];
  const vistas = {}; const dirs = [];
  data.lineas.forEach(function (l) {
    if (!vistas[l.dir]) { vistas[l.dir] = true; dirs.push({ dir: l.dir, des: l.des }); }
  });
  return { ped: entry.ped, tiendas: tiendas, tienda: tiendaUsar, dirs: dirs, nLin: data.nLin };
}

/** Prueba rápida: ejecútala desde el editor tras poner INVENTARIO_FOLDER_ID. */
function probarInventario() {
  const inv = cargarInventario();
  Logger.log('Tiendas cargadas: ' + inv.tiendas.join(' | '));
  Logger.log('Total pedidos en índice: ' + Object.keys(inv.indice).length);
  if (inv.avisos.length) Logger.log('Avisos: ' + inv.avisos.join(' / '));
}

// ============================================================
// ROBOT DE INVENTARIOS (sube el Excel exportado de Pyxis a Drive)
// ============================================================
// Mismo espíritu que el robot de Muelles: un script PowerShell autocontenido
// que se descarga desde la app, automatiza Pyxis (y aquí también Excel) y
// llama a ESTA misma app por HTTP (doPost en WebApp.gs) para subir el
// archivo -- así Drive lo guarda con los permisos legítimos de Apps Script,
// sin tener que gestionar ninguna credencial de Google desde el PC. Sin
// esto, el proceso era manual: alguien sacaba el listado en Pyxis y lo
// subía a mano a Drive (fuente probable del bug real "inventario
// desactualizado" corregido antes en esta misma sesión).

var ROBOT_INVENTARIO_TOKEN_PROP = 'ROBOT_INVENTARIO_TOKEN';

/**
 * Token compartido para autenticar las llamadas del robot a doPost -- este
 * endpoint es alcanzable por CUALQUIERA que tenga la URL del despliegue (no
 * pasa por el login de Google como el resto de la app), así que sin esto
 * cualquiera podría sobrescribir los inventarios de producción. Se genera
 * una vez y se guarda en las propiedades del script; se incrusta en el
 * script descargado en el momento de generarlo (mismo patrón que los
 * pendientes del robot de Muelles).
 */
function getOCrearTokenRobotInventario() {
  var props = PropertiesService.getScriptProperties();
  var tok = props.getProperty(ROBOT_INVENTARIO_TOKEN_PROP);
  if (!tok) {
    tok = Utilities.getUuid();
    props.setProperty(ROBOT_INVENTARIO_TOKEN_PROP, tok);
  }
  return tok;
}

/**
 * Recibe un archivo de inventario (base64) del robot y lo guarda en
 * INVENTARIO_FOLDER_ID con el nombre "<código tienda>.<extensión>",
 * SOBRESCRIBIENDO cualquier archivo previo con ese código (en cualquiera de
 * las dos extensiones -- .xls o .xlsx -- por si el robot cambia de formato
 * en el futuro, para no dejar dos copias desincronizadas del mismo
 * inventario). cargarInventario() ya lee ambos formatos indistintamente
 * (ver comentario al principio de este archivo).
 */
function recibirInventarioRobot(token, tienda, archivoBase64, extension) {
  if (token !== getOCrearTokenRobotInventario()) return { ok: false, error: 'Token inválido' };

  var codigo = String(tienda || '').trim();
  if (!/^\d{3}$/.test(codigo)) return { ok: false, error: 'Código de tienda inválido: ' + codigo };
  var ext = (String(extension || 'xls').replace(/[^a-z]/gi, '').toLowerCase() === 'xlsx') ? 'xlsx' : 'xls';
  var mime = ext === 'xlsx' ? MimeType.MICROSOFT_EXCEL : 'application/vnd.ms-excel';

  var bytes;
  try { bytes = Utilities.base64Decode(archivoBase64); }
  catch (e) { return { ok: false, error: 'archivoBase64 inválido: ' + e.message }; }

  var carpeta = DriveApp.getFolderById(INVENTARIO_FOLDER_ID);
  var reemplazados = 0;
  ['xls', 'xlsx'].forEach(function (e) {
    var it = carpeta.getFilesByName(codigo + '.' + e);
    while (it.hasNext()) { it.next().setTrashed(true); reemplazados++; }
  });

  var blob = Utilities.newBlob(bytes, mime, codigo + '.' + ext);
  var nuevo = carpeta.createFile(blob);
  logActividad('ROBOT_INVENTARIO', 'Inventario ' + codigo + '.' + ext + ' subido por el robot (' + reemplazados + ' reemplazado(s))', 'robot');
  return { ok: true, archivo: nuevo.getName(), id: nuevo.getId(), reemplazados: reemplazados };
}
