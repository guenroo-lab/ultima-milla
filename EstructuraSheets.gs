/**
 * ============================================================
 * EstructuraSheets.gs
 * Creación e inicialización automática del Spreadsheet
 * ============================================================
 *
 * EJECUTAR UNA VEZ: inicializarSistema()
 * Crea el Spreadsheet (si no existe), todas las hojas con sus cabeceras,
 * y guarda el ID en las propiedades del script.
 */

function inicializarSistema() {
  var ss = null;

  // 1) Si el script vive DENTRO de una hoja (lo abriste con Extensiones → Apps Script),
  //    usamos ESA misma hoja. Así la app y los datos quedan en un único archivo.
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }

  // 2) Si no, reutilizamos la hoja que ya se haya guardado antes.
  if (!ss) {
    var ssId = getSpreadsheetId();
    if (ssId) {
      try { ss = SpreadsheetApp.openById(ssId); }
      catch (e) { ss = null; Logger.log('El ID guardado no es válido, creando uno nuevo...'); }
    }
  }

  // 3) Si no había ninguna, creamos una nueva.
  if (!ss) {
    ss = SpreadsheetApp.create('LM Málaga · Expedición Última Milla');
    Logger.log('Spreadsheet creado.');
  }

  setSpreadsheetId(ss.getId());
  _crearHojas(ss);

  Logger.log('✓ Sistema inicializado correctamente');
  Logger.log('Todos los datos están en esta hoja:');
  Logger.log(ss.getUrl());
  return ss.getUrl();
}

/**
 * Crea (si faltan) todas las hojas con sus cabeceras dentro del Spreadsheet dado.
 */
function _crearHojas(ss) {
  Object.keys(HOJAS).forEach(function(key) {
    var nombre = HOJAS[key];
    var sheet = ss.getSheetByName(nombre);
    if (!sheet) { sheet = ss.insertSheet(nombre); }
    var cols = COLUMNAS[key];
    if (cols && sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, cols.length).setValues([cols]);
      sheet.getRange(1, 1, 1, cols.length).setFontWeight('bold').setBackground('#e30613').setFontColor('#ffffff');
      sheet.setFrozenRows(1);
    }
  });

  // Eliminar la hoja por defecto "Hoja 1" / "Sheet1" si existe y está vacía
  var defecto = ss.getSheetByName('Hoja 1') || ss.getSheetByName('Sheet1') || ss.getSheetByName('Hoja1');
  if (defecto && ss.getSheets().length > 1) {
    try { ss.deleteSheet(defecto); } catch (e) {}
  }
}

/**
 * Repara las cabeceras: si una hoja tiene datos pero le falta la fila de títulos
 * (o está vacía), inserta la cabecera correcta arriba. Arregla el caso en que
 * leerHoja confunde la 1ª fila de datos con los nombres de columna.
 */
function repararCabeceras() {
  var ss = getSS();
  var res = [];
  Object.keys(HOJAS).forEach(function(key) {
    var nombre = HOJAS[key];
    var cols = COLUMNAS[key];
    if (!cols) return;
    var sheet = ss.getSheetByName(nombre);
    if (!sheet) { sheet = ss.insertSheet(nombre); }
    var lastRow = sheet.getLastRow();
    var primera = (lastRow >= 1) ? sheet.getRange(1, 1, 1, cols.length).getValues()[0] : [];
    var tieneCabecera = (String(primera[0] || '') === String(cols[0]) &&
                         String(primera[1] || '') === String(cols[1]));
    if (tieneCabecera) { res.push(nombre + ': ok'); return; }
    if (lastRow === 0) {
      sheet.getRange(1, 1, 1, cols.length).setValues([cols]);
    } else {
      sheet.insertRowBefore(1);
      sheet.getRange(1, 1, 1, cols.length).setValues([cols]);
    }
    sheet.getRange(1, 1, 1, cols.length).setFontWeight('bold').setBackground('#e30613').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    res.push(nombre + ': CABECERA REPARADA');
  });
  Logger.log(res.join('\n'));
  return res;
}

/**
 * Dice en qué hoja está guardando los datos el sistema ahora mismo.
 * Ejecútala desde el editor y mira el registro (Ver → Registros).
 */
function dondeEstanLosDatos() {
  var id = getSpreadsheetId();
  if (!id) { Logger.log('El sistema NO está inicializado todavía. Ejecuta inicializarSistema().'); return 'NO INICIALIZADO'; }
  var ss = SpreadsheetApp.openById(id);
  Logger.log('Nombre del archivo: ' + ss.getName());
  Logger.log('URL (esta es la hoja buena, las demás puedes borrarlas): ' + ss.getUrl());
  return ss.getUrl();
}

/**
 * Apunta el sistema a una hoja que YA tengas (pega su URL o su ID) y crea
 * dentro las hojas que falten. Úsala si quieres unificar todo en una hoja concreta.
 * Después puedes borrar la otra hoja sobrante.
 */
function vincularSheetExistente(urlOId) {
  var id = String(urlOId || '');
  var m = id.match(/[-\w]{25,}/);   // extrae el ID si pegas la URL completa
  if (m) id = m[0];
  var ss = SpreadsheetApp.openById(id);   // lanza error si la URL/ID no vale
  setSpreadsheetId(ss.getId());
  _crearHojas(ss);
  Logger.log('✓ Sistema vinculado a: ' + ss.getName());
  Logger.log(ss.getUrl());
  return ss.getUrl();
}

/**
 * Devuelve el objeto Spreadsheet activo (abre por ID guardado).
 * MEMOIZADO por ejecución: openById cuesta ~0,5 s y antes se repetía en cada
 * lectura de hoja. Las variables de módulo se reinician en cada ejecución de
 * Apps Script, así que la caché nunca queda obsoleta entre llamadas.
 */
var _SS_MEMO = null;
function getSS() {
  if (_SS_MEMO) return _SS_MEMO;
  const id = getSpreadsheetId();
  if (!id) throw new Error('Sistema no inicializado. Ejecuta inicializarSistema() primero.');
  _SS_MEMO = SpreadsheetApp.openById(id);
  return _SS_MEMO;
}

/**
 * Devuelve una hoja por su clave (HOJAS.PEDIDOS, etc). Memoizada por ejecución.
 */
var _HOJA_MEMO = {};
function getHoja(clave) {
  if (_HOJA_MEMO[clave]) return _HOJA_MEMO[clave];
  const ss = getSS();
  const nombre = HOJAS[clave];
  let sheet = ss.getSheetByName(nombre);
  if (!sheet) {
    // Autocreación defensiva: una hoja añadida a HOJAS/COLUMNAS después de que
    // el sistema ya está en producción (p.ej. VISAS) no existe todavía en el
    // Spreadsheet real hasta ejecutar inicializarSistema()/repararCabeceras()
    // en el editor — como no se puede ejecutar GAS desde local, se crea aquí
    // mismo la primera vez que algo la usa, con su cabecera, para que la
    // función nueva funcione sin pasos manuales previos.
    sheet = ss.insertSheet(nombre);
    const cols = COLUMNAS[clave];
    if (cols) {
      sheet.getRange(1, 1, 1, cols.length).setValues([cols]);
      sheet.getRange(1, 1, 1, cols.length).setFontWeight('bold').setBackground('#e30613').setFontColor('#ffffff');
      sheet.setFrozenRows(1);
    }
  }
  _HOJA_MEMO[clave] = sheet;
  return sheet;
}

/**
 * Lee todas las filas de una hoja como array de objetos (usando cabecera).
 * PEDIDOS/LINEAS/OCUPACION (Fase 3, Pieza 3 -- 2026-09-04): redirigidas a
 * Postgres (public) vía la capa de compatibilidad en Pieza3Publico.gs --
 * mismo shape de objeto (camelCase, con _fila) para que TODAS las llamadas
 * existentes sigan funcionando sin tocarlas. El resto de hojas (CARGAS,
 * VISAS, HISTORIAL, LOG, RETIRADAS) sigue en Sheets sin cambios.
 */
function leerHoja(clave) {
  if (_esTablaPublic_(clave)) return leerHojaPublic_(clave);
  return _leerHojaSheetsCruda_(clave);
}

/**
 * Lectura de Sheets SIN pasar por la redirección a Postgres -- BYPASS
 * deliberado, no un descuido. Uso exclusivo: herramientas de reconciliación
 * (MigracionFase2.gs) que necesitan comparar/recargar contra la copia
 * CONGELADA de Sheets (que ya no recibe escrituras desde el corte de Pieza 3,
 * 2026-09-04) precisamente PORQUE `leerHoja` para estas claves ya no lee
 * Sheets. Llamar a `leerHoja('LINEAS')` desde una herramienta de recarga
 * Sheets→Postgres después del corte sería un no-op (leería Postgres y lo
 * volvería a escribir sobre sí mismo) -- de ahí este bypass explícito.
 * NUNCA usar esto en código de la app normal -- solo en herramientas de
 * migración/recarga puntuales.
 */
function _leerHojaSheetsCruda_(clave) {
  const sheet = getHoja(clave);
  const datos = sheet.getDataRange().getValues();
  if (!datos.length) return [];
  const cols = COLUMNAS[clave];
  // Cabecera canónica: siempre que conozcamos las columnas (COLUMNAS) usamos ESE
  // esquema como mapa, NO los nombres físicos de la fila 1. Como las columnas solo
  // se AÑADEN al final, esto garantiza que una columna nueva (p.ej. 'cargador') se
  // lea bien aunque la hoja antigua tenga la cabecera corta y sin ese título.
  // Autodefensa adicional: si la 1ª fila no es la cabecera (se borró), tratamos
  // todas las filas como datos.
  let cabecera, inicio;
  if (cols && String(datos[0][0]) === String(cols[0]) && String(datos[0][1]) === String(cols[1])) {
    cabecera = cols; inicio = 1;
  } else if (cols) {
    cabecera = cols; inicio = 0;
  } else {
    cabecera = datos[0]; inicio = 1;
  }
  if (datos.length <= inicio) return [];
  const filas = [];
  for (let i = inicio; i < datos.length; i++) {
    const obj = {};
    cabecera.forEach(function(col, j) { obj[col] = datos[i][j]; });
    obj._fila = i + 1; // número de fila real (para updates)
    filas.push(obj);
  }
  return filas;
}

/**
 * Añade una fila a una hoja a partir de un objeto (respeta orden de COLUMNAS).
 */
function anadirFila(clave, obj) {
  if (_esTablaPublic_(clave)) return anadirFilaPublic_(clave, obj);
  const sheet = getHoja(clave);
  const cols = COLUMNAS[clave];
  const fila = cols.map(function(c) {
    const v = obj[c];
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  });
  sheet.appendRow(fila);
  return sheet.getLastRow();
}

/**
 * Actualiza una fila existente (por número de fila) con un objeto parcial.
 */
function actualizarFila(clave, numFila, cambios) {
  if (_esTablaPublic_(clave)) return actualizarFilaPublic_(clave, numFila, cambios);
  const sheet = getHoja(clave);
  const cols = COLUMNAS[clave];
  const rango = sheet.getRange(numFila, 1, 1, cols.length);
  const valores = rango.getValues()[0];
  cols.forEach(function(c, j) {
    if (cambios.hasOwnProperty(c)) {
      const v = cambios[c];
      valores[j] = (typeof v === 'object' && v !== null) ? JSON.stringify(v) : (v === null ? '' : v);
    }
  });
  rango.setValues([valores]);
}

// Serializa el valor de una celda igual que anadirFila/actualizarFila.
function _celda(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v);
  return v;
}

/**
 * Añade VARIAS filas de golpe (una sola escritura en vez de un appendRow por
 * fila). Usa un candado para que dos ejecuciones simultáneas no pisen las
 * mismas filas; si no consigue el candado, cae al appendRow clásico (atómico).
 */
function anadirFilas(clave, objs) {
  if (!objs || !objs.length) return;
  if (_esTablaPublic_(clave)) return anadirFilasPublic_(clave, objs);
  const sheet = getHoja(clave);
  const cols = COLUMNAS[clave];
  const filas = objs.map(function(obj) {
    return cols.map(function(c) { return _celda(obj[c]); });
  });
  var lock = null;
  try { lock = LockService.getScriptLock(); if (!lock.tryLock(10000)) lock = null; } catch (e) { lock = null; }
  try {
    if (lock) {
      // GARANTIZAR CAPACIDAD: setValues NO amplía el grid (appendRow sí lo hacía)
      // y los borrados de ocupación lo encogen. Sin esto, la hoja se agota y la
      // escritura revienta a mitad de una gestión.
      var ultima = sheet.getLastRow();
      var faltan = (ultima + filas.length) - sheet.getMaxRows();
      if (faltan > 0) sheet.insertRowsAfter(sheet.getMaxRows(), faltan);
      sheet.getRange(ultima + 1, 1, filas.length, cols.length).setValues(filas);
    } else {
      filas.forEach(function(f) { sheet.appendRow(f); });
    }
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (e2) {} }
  }
}

/**
 * Escribe una fila COMPLETA desde un objeto ya leído con leerHoja, SIN releer
 * la fila antes (la mitad de operaciones que actualizarFila). El objeto debe
 * traer TODAS las columnas (los objetos de leerHoja las traen).
 */
function escribirFila(clave, numFila, obj) {
  const sheet = getHoja(clave);
  const cols = COLUMNAS[clave];
  const fila = cols.map(function(c) { return _celda(obj[c]); });
  sheet.getRange(numFila, 1, 1, cols.length).setValues([fila]);
}

// Número de columna (1-based) → letra A1 ('A', 'B', ... 'AA').
function _colLetra(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * Escribe el MISMO valor en una columna para muchas filas en UNA sola operación
 * (RangeList). Ideal para marcar lotes: mismo estado en N pedidos, etc.
 */
function actualizarColumnaLote(clave, numFilas, nombreCol, valor) {
  if (!numFilas || !numFilas.length) return;
  if (_esTablaPublic_(clave)) return actualizarColumnaLotePublic_(clave, numFilas, nombreCol, valor);
  const sheet = getHoja(clave);
  const idx = COLUMNAS[clave].indexOf(nombreCol);
  if (idx < 0) return;
  const letra = _colLetra(idx + 1);
  const refs = numFilas.map(function(f) { return letra + f; });
  sheet.getRangeList(refs).setValue(_celda(valor));
}

/**
 * Borra UNA fila por su `_fila` (Fase 3, Pieza 3 -- nueva, no existía en
 * Sheets-only: los sitios que borraban una fila de OCUPACION lo hacían con
 * sheet.deleteRow(_fila) directo. Genérica igual que el resto -- solo tiene
 * efecto en Postgres para las tablas migradas; para el resto no se usa hoy.
 */
function borrarFila(clave, fila) {
  if (_esTablaPublic_(clave)) return borrarFilaPublic_(clave, fila);
  throw new Error('borrarFila: hoja "' + clave + '" no está migrada.');
}

/**
 * Busca filas de una hoja filtrando por UN campo, sin traer la hoja entera.
 * Para claves migradas a Postgres: consulta filtrada real (un solo viaje
 * HTTP) en vez de `leerHoja(clave).filter(...)`, que pagina la tabla ENTERA
 * para acabar filtrando en memoria una sola fila -- el motivo real de
 * lentitud encontrado 2026-09-04 en el punto más caliente de la app (abrir
 * un pedido). Para hojas NO migradas, cae a leerHoja(clave)+filter en
 * memoria, exactamente el comportamiento de siempre. `valores` puede ser un
 * solo valor o un array.
 */
function buscarFilasPorCampo(clave, campo, valores) {
  if (_esTablaPublic_(clave)) return leerFilasPublicFiltro_(clave, campo, valores);
  var lista = Array.isArray(valores) ? valores : [valores];
  var set = {};
  lista.forEach(function(v) { set[String(v)] = true; });
  return leerHoja(clave).filter(function(f) { return set[String(f[campo])]; });
}
function buscarFilaPorCampo(clave, campo, valor) {
  var r = buscarFilasPorCampo(clave, campo, valor);
  return r.length ? r[0] : null;
}

/**
 * Borra todas las filas de datos de una hoja (mantiene cabecera).
 */
function limpiarHoja(clave) {
  const sheet = getHoja(clave);
  const last = sheet.getLastRow();
  if (last > 1) sheet.deleteRows(2, last - 1);
}

/**
 * Registra una entrada en el log de actividad.
 */
function logActividad(tipo, detalle, usuario) {
  try {
    anadirFila('LOG', {
      ts: new Date().toISOString(),
      tipo: tipo,
      detalle: detalle,
      usuario: usuario || ''
    });
  } catch (e) {
    // No bloquear por fallos de log
    console.error('Error en log:', e);
  }
}

/**
 * Registra una entrada en el historial de transportistas de un pedido — de
 * SOLO AÑADIR, a diferencia de PEDIDOS.transportista (un único valor que se
 * sobrescribe cada vez que se corrige/reclasifica). Caso real que motivó
 * esto: un pedido se carga un día con un transportista, "vuelve" (no se
 * entrega, se devuelve a almacén...) y al día siguiente se carga con OTRO
 * transportista distinto — antes solo quedaba el último valor, así que la
 * ficha de "Buscar pedido" solo reflejaba el transportista más reciente y se
 * perdía el rastro de a quién se le había cargado antes. Se llama desde
 * cualquier punto que fije/cambie transportista o flujo de un pedido: alta
 * (crearPedidoConLineas), reclasificación por reimportación
 * (renovarDireccionesPedidoExistente), cambio manual (cambiarFlujoPedido/
 * cambiarFlujoPedidosMasivo), reconversión a Recogidas/Ya Cargados, y
 * reapertura (reabrirPedido, como marcador de que el pedido "volvió").
 */
function registrarHistorialTransportista(idPedido, ped, tienda, transportista, flujo, evento) {
  try {
    var filaHist = {
      id: idPedido + '::' + new Date().getTime(),
      idPedido: idPedido, ped: ped, tienda: tienda || '',
      transportista: transportista || '', flujo: flujo || '',
      evento: evento || '', fecha: new Date().toISOString()
    };
    // Fase 3, Pieza 3 (2026-09-04): HIST_TRANSP ya vive en Postgres (public)
    // -- anadirFila ya escribe ahí directamente, el sync de después ya no
    // hace falta (segunda escritura redundante con el mismo id).
    anadirFila('HIST_TRANSP', filaHist);
  } catch (e) {
    // No bloquear el flujo principal por un fallo al registrar el historial
    console.error('Error registrando historial de transportista:', e);
  }
}
