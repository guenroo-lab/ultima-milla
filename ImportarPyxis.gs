/**
 * ============================================================
 * ImportarPyxis.gs
 * Importación de pedidos desde el "Listado Inventario Pedido Cliente" de Pyxis
 * ============================================================
 *
 * El Excel de Pyxis tiene estas columnas:
 *   Dirección | Nº Ped | Sección | Subsección | Ref. | Código EAN |
 *   Designación | Ctd Recep. | Código C1 | Total línea | Nº Prov. | Fecha Entre.
 *
 * Cada fila es una línea (ubicación) de un pedido. Varias filas con el mismo
 * Nº Ped forman un pedido completo.
 */

/**
 * Importa pedidos desde un array de filas (ya parseadas del Excel).
 * filas: array de arrays, primera fila = cabecera.
 * tienda y transportista se pasan porque NO vienen en el Excel.
 *
 * Para importar desde un archivo subido a Drive, usar importarDesdeArchivo().
 */
function importarPedidosPyxis(filas, tienda, transportista) {
  if (!filas || filas.length < 2) return { ok: false, error: 'Sin datos' };

  const cabecera = filas[0].map(function(c) { return String(c).trim().toLowerCase(); });
  const idx = {
    dir: encontrarColumna(cabecera, ['dirección', 'direccion', 'ubicación', 'ubicacion']),
    ped: encontrarColumna(cabecera, ['nº ped', 'n ped', 'pedido', 'num ped']),
    seccion: encontrarColumna(cabecera, ['sección', 'seccion']),
    ref: encontrarColumna(cabecera, ['ref.', 'ref', 'referencia']),
    ean: encontrarColumna(cabecera, ['código ean', 'codigo ean', 'ean']),
    des: encontrarColumna(cabecera, ['designación', 'designacion', 'descripción']),
    ctd: encontrarColumna(cabecera, ['ctd recep.', 'ctd recep', 'ctd', 'cantidad'])
  };

  if (idx.ped === -1 || idx.dir === -1) {
    return { ok: false, error: 'No se encuentran columnas Nº Ped o Dirección' };
  }

  // Agrupar filas por nº pedido
  const grupos = {};
  for (let i = 1; i < filas.length; i++) {
    const fila = filas[i];
    const numPed = String(fila[idx.ped]).trim();
    if (!numPed) continue;
    if (!grupos[numPed]) grupos[numPed] = [];
    grupos[numPed].push({
      dir: String(fila[idx.dir]).trim(),
      ref: idx.ref >= 0 ? String(fila[idx.ref]).trim() : '',
      ean: idx.ean >= 0 ? String(fila[idx.ean]).trim() : '',
      des: idx.des >= 0 ? String(fila[idx.des]).trim() : '',
      ctd: idx.ctd >= 0 ? fila[idx.ctd] : ''
    });
  }

  let nPedidos = 0;
  let nLineas = 0;

  Object.keys(grupos).forEach(function(numPed) {
    var idPedido = codigoTienda(tienda) + '::' + numPed;
    var res = crearPedidoConLineas(idPedido, numPed, tienda, transportista, grupos[numPed]);
    nPedidos++;
    nLineas += res.nLin;
  });

  logActividad('IMPORTAR_PYXIS', nPedidos + ' pedidos, ' + nLineas + ' líneas (' + tienda + '/' + transportista + ')', '');
  return { ok: true, pedidos: nPedidos, lineas: nLineas };
}

/**
 * Importa desde un archivo Excel/CSV subido a Drive (por su ID).
 */
function importarDesdeArchivo(fileId, tienda, transportista) {
  try {
    const blob = DriveApp.getFileById(fileId).getBlob();
    const nombre = DriveApp.getFileById(fileId).getName();

    let filas;
    if (nombre.toLowerCase().indexOf('.csv') >= 0) {
      filas = Utilities.parseCsv(blob.getDataAsString());
    } else {
      // Excel: convertir a Sheets temporalmente
      const recurso = { title: 'temp_import_' + new Date().getTime(), mimeType: MimeType.GOOGLE_SHEETS };
      const archivo = Drive.Files.insert(recurso, blob);
      const ssTemp = SpreadsheetApp.openById(archivo.id);
      filas = ssTemp.getSheets()[0].getDataRange().getValues();
      Drive.Files.remove(archivo.id); // borrar temporal
    }

    return importarPedidosPyxis(filas, tienda, transportista);
  } catch (e) {
    return { ok: false, error: e.toString() };
  }
}

// ============================================================
// CLASIFICACIÓN DE UBICACIONES PYXIS
// ============================================================

// Códigos de TRÁNSITO tienda -> plataforma (llegan un día concreto de la
// semana; código corto O nombre largo, ambos conviven en los datos reales).
var UBIC_TRANSITO_TIENDA_PLATAFORMA = {
  L: 1, L1: 1, L2: 1, L3: 1, LUNE: 1,
  M: 1, M1: 1, M2: 1, M3: 1, MART: 1,
  X: 1, X1: 1, X2: 1, X3: 1, MIER: 1, 'MIÉR': 1,
  J: 1, J1: 1, J2: 1, J3: 1, JUEV: 1,
  V: 1, V1: 1, V2: 1, V3: 1, VIER: 1,
  S: 1, SABA: 1,
  TAISA: 1, TOR: 1, VALEN: 1
};
// Códigos de TRÁNSITO plataforma -> tienda (devolución por alguna incidencia).
var UBIC_TRANSITO_PLATAFORMA_TIENDA = { DEV: 1, TIEND: 1 };

/**
 * Clasifica el tipo de ubicación según su código (tipo de ESTANTERÍA, para
 * picking/ocupación — distinto de origenUbicacion, que clasifica de dónde
 * hay que SACARLA físicamente). OJO: los códigos cortos de tránsito
 * (X/X1/X2/X3, día miércoles) se comprueban ANTES que "empieza por X ->
 * cantilever", porque NO son cantilever — solo lo son los códigos X más
 * largos (p.ej. X152A).
 */
function clasificarUbicacion(dir) {
  // normalize('NFC'): por si el código llega con una tilde en forma
  // descompuesta (p.ej. 'MIÉR' en vez de 'MIÉR' precompuesto) — sin
  // esto, esa variante no haría match exacto contra los diccionarios y
  // caería en silencio fuera de 'transitoria'.
  const d = String(dir).trim().toUpperCase().normalize('NFC');
  if (UBIC_TRANSITO_TIENDA_PLATAFORMA.hasOwnProperty(d) || UBIC_TRANSITO_PLATAFORMA_TIENDA.hasOwnProperty(d)) return 'transitoria';
  if (/^(LUNE|MART|MIER|MIÉR|JUEV|VIER|SABA|DOMI)/.test(d)) return 'transitoria';
  if (d.charAt(0) === 'X') return 'cantilever';
  if (/^3[012]000/.test(d)) return 'zona_especial';
  if (d.indexOf('467') === 0) return 'expedicion';
  // Tipos de picking
  if (/BULTO|TAPETA|ESPEJO|0\.5M|PICKING/.test(d)) return 'picking';
  // Por defecto, palet
  return 'palet';
}

/**
 * Determina si una ubicación es de picking (no cuenta para ocupación).
 */
function esPicking(dir) {
  const tipo = clasificarUbicacion(dir);
  return tipo === 'picking' || tipo === 'cantilever';
}

/**
 * Clasifica el ORIGEN FÍSICO de una ubicación — de dónde tiene que sacarla
 * físicamente el operario. Distinto de clasificarUbicacion (tipo de
 * estantería): esto es sobre TIENDA vs PLATAFORMA vs TRÁNSITO entre ambas,
 * para avisar al operario ANTES de entrar a un pedido y para priorizar el
 * orden de preparación (ver Index.html: pantallaListaPedidos/siguienteLinea).
 * Devuelve 'transito_tienda' | 'transito_devolucion' | 'plataforma' | 'tienda'.
 */
function origenUbicacion(dir) {
  const d = String(dir || '').trim().toUpperCase().normalize('NFC');
  if (UBIC_TRANSITO_TIENDA_PLATAFORMA.hasOwnProperty(d)) return 'transito_tienda';
  if (UBIC_TRANSITO_PLATAFORMA_TIENDA.hasOwnProperty(d)) return 'transito_devolucion';
  if (/^\d+$/.test(d)) return 'plataforma'; // todo numérica
  if (/^X\d/.test(d)) return 'plataforma'; // cantilever tipo X152A (X/X1/X2/X3 cortos ya se cogieron arriba)
  return 'tienda';
}

/**
 * Ordena líneas: cantilever (X) y numéricas primero, picking SIEMPRE al final.
 */
/**
 * Colapsa a una sola línea cualquier grupo de líneas que comparta
 * referencia+dirección+cantidad EXACTAS -- ver el comentario en
 * crearPedidoConLineas/renovarDireccionesPedidoExistente (ImportarClasificacion.gs)
 * para el porqué (bug real 2026-08-03: artículos duplicados al preparar).
 * Deliberadamente NO fusiona líneas con la MISMA referencia+dirección pero
 * cantidad DISTINTA (no hay evidencia de que eso represente un duplicado en
 * vez de dos lotes reales) -- esas se dejan tal cual, sin tocar.
 */
function deduplicarLineasPyxis_(lineas) {
  var vistos = {};
  var resultado = [];
  var colapsadas = 0;
  lineas.forEach(function(l) {
    var clave = String(l.ref) + '|' + String(l.dir) + '|' + String(l.ctd);
    if (vistos[clave]) { colapsadas++; return; }
    vistos[clave] = true;
    resultado.push(l);
  });
  return { lineas: resultado, colapsadas: colapsadas };
}

function ordenarLineasPyxis(lineas) {
  const principales = [];
  const picking = [];
  lineas.forEach(function(l) {
    if (esPicking(l.dir)) picking.push(l);
    else principales.push(l);
  });
  // Ordenar principales por dirección
  principales.sort(function(a, b) { return a.dir < b.dir ? -1 : 1; });
  picking.sort(function(a, b) { return a.dir < b.dir ? -1 : 1; });
  return principales.concat(picking);
}

// ============================================================
// UTILIDADES
// ============================================================

function encontrarColumna(cabecera, posibles) {
  for (let i = 0; i < cabecera.length; i++) {
    for (let j = 0; j < posibles.length; j++) {
      if (cabecera[i].indexOf(posibles[j]) >= 0) return i;
    }
  }
  return -1;
}

// codigoTienda(tienda) está centralizada en Configuracion.gs

// ============================================================
// HELPER COMPARTIDO DE CREACIÓN DE PEDIDO + LÍNEAS
// ============================================================

/**
 * Crea un pedido + sus líneas a partir de líneas crudas { dir, ref, ean, des, ctd }.
 * Reutilizado por importarPedidosPyxis() e importarClasificacion().
 * esParcial (opcional, solo lo usa importarClasificacion): true si el
 * pedido se dio de alta a propósito con SOLO algunas direcciones elegidas a
 * mano (ver clfToggleParcial en Index.html) -- queda marcado en PEDIDOS.parcial
 * para que renovarDireccionesPedidoExistente/resincronizarPedidosActivos
 * nunca le vuelvan a añadir las direcciones que se dejaron fuera a propósito.
 * comentario (opcional, solo lo usa importarClasificacion): instrucción
 * escrita a mano en el clasificador ANTES de importar (ver clfSetComentario
 * en Index.html) -- mismo campo PEDIDOS.comentario que actualizarComentarioPedido,
 * se imprime en la hoja de carga como instrucción para el cargador.
 * Devuelve { nLin, nUbic }.
 */
/**
 * Dedupe+ordena lineasRaw (mismo criterio que crearPedidoConLineas) e inserta las filas
 * LINEAS resultantes para idPedido. Compartido entre crearPedidoConLineas (alta nueva) y
 * el bloque "forzados" de importarClasificacion (reemplazo de líneas de un pedido ya
 * existente que se fuerza a reimportar) -- MISMA lógica de construcción en los dos sitios,
 * para que nunca diverja cómo se calculan/ordenan/clasifican las líneas.
 * Devuelve { nLin, nUbic }.
 */
function _construirEInsertarLineas(idPedido, numPed, lineasRaw) {
  var lineasOrdenadas = ordenarLineasPyxis(lineasRaw);

  // DEDUPLICAR (2026-08-03, bug real: "salen 4 cerraduras en vez de 2" --
  // la línea se duplicaba, un operario tenía que marcar el doble de lo que
  // hacía falta). Dos causas confirmadas con datos reales, distintas entre
  // sí: (a) una condición de carrera ya corregida con candados (v193/v195,
  // dos ejecuciones creaban la MISMA línea nueva cada una por su cuenta) y
  // (b) el propio Excel de Pyxis a veces trae la MISMA referencia+dirección
  // repetida de origen, sin que medie ninguna carrera. Esta salvaguarda
  // protege contra las DOS causas a la vez, colapsando a una sola línea
  // cualquier grupo que comparta referencia+dirección+cantidad exactas --
  // NO se suman cantidades (si el duplicado fuera un reparto real en dos
  // lotes con cantidades DISTINTAS, eso no se toca, se deja tal cual: no hay
  // evidencia de que eso ocurra, y sumar a ciegas sería peor que no tocarlo).
  var dedupCrear = deduplicarLineasPyxis_(lineasOrdenadas);
  if (dedupCrear.colapsadas > 0) {
    logActividad('LINEAS_DUPLICADAS_COLAPSADAS', 'Pedido ' + numPed + ' (' + idPedido + '): ' + dedupCrear.colapsadas +
      ' línea(s) duplicada(s) en origen (Pyxis o reintento) colapsada(s) a 1 antes de crear', 'sistema');
  }
  lineasOrdenadas = dedupCrear.lineas;

  var ubic = {};
  lineasOrdenadas.forEach(function(l) { ubic[l.dir] = true; });
  var nUbic = Object.keys(ubic).length;

  lineasOrdenadas.forEach(function(l, j) {
    anadirFila('LINEAS', {
      id: idPedido + '::L' + j, idPedido: idPedido, idx: j,
      dir: l.dir, ref: l.ref, ean: l.ean, des: l.des, ctd: l.ctd,
      tipoUbic: clasificarUbicacion(l.dir), esPicking: esPicking(l.dir),
      estado: 'PENDIENTE', motivo: '', operario: '', ts: ''
    });
  });

  return { nLin: lineasOrdenadas.length, nUbic: nUbic };
}

/**
 * Borra TODAS las filas LINEAS de un idPedido. Usado por el bloque "forzados" de
 * importarClasificacion antes de insertar las líneas frescas de Pyxis -- a diferencia de
 * marcarLinea/marcarDireccion (que solo cambian estado), aquí las líneas viejas ya no
 * sirven de nada: se sustituyen enteras.
 */
function _borrarLineasDePedido(idPedido) {
  // Fase 3, Pieza 3 (2026-09-04): LINEAS ya vive en Postgres -- borrarFila
  // redirige sola. El orden de borrado ya no importa (era un artefacto de
  // deleteRows de Sheets, cada fila de Postgres se borra por su propio id).
  leerHoja('LINEAS')
    .filter(function(l) { return l.idPedido === idPedido; })
    .forEach(function(l) { borrarFila('LINEAS', l._fila); });
}

function crearPedidoConLineas(idPedido, numPed, tienda, transportista, lineasRaw, esParcial, comentario, sinSyncInmediato) {
  var flujo = CONFIG.TRANSPORTISTAS_FLUJO[transportista] || 'transporte';
  var r = _construirEInsertarLineas(idPedido, numPed, lineasRaw);

  var pedidoNuevo = {
    id: idPedido, ped: numPed, tienda: tienda, transportista: transportista,
    flujo: flujo, estado: 'PENDIENTE', pct: 0, operario: '',
    silueta: '', posIni: '', posFin: '', numeroCarga: '',
    soportes: [], nLin: r.nLin, nUbic: r.nUbic,
    actualizado: new Date().toISOString(), parcial: !!esParcial,
    comentario: comentario ? String(comentario).trim() : ''
  };
  // Fase 3, Pieza 3 (2026-09-04): PEDIDOS ya vive en Postgres -- anadirFila
  // escribe ahí directo, ya no hace falta sincronizarPedidoSupabase_ después
  // (era el puente Fase 1, redundante ahora). sinSyncInmediato queda sin uso
  // (se mantiene el parámetro por compatibilidad con las llamadas existentes).
  anadirFila('PEDIDOS', pedidoNuevo);
  registrarHistorialTransportista(idPedido, numPed, tienda, transportista, flujo, 'ALTA');

  return { nLin: r.nLin, nUbic: r.nUbic, pedido: pedidoNuevo };
}
