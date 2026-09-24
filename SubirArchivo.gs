/**
 * ============================================================
 * SubirArchivo.gs
 * Endpoint generico de subida a Drive para robots locales (TOM,
 * StockSearch/Power BI). NO toca nada de Inventario.gs -- el flujo de
 * Pyxis (recibirInventarioRobot) sigue exactamente igual.
 * ============================================================
 */

// Carpetas de Drive permitidas para el endpoint generico de subida.
// Whitelist explicita -- el robot nunca puede escribir fuera de estas dos.
var CARPETA_ARCHIVO_POR_DESTINO = {
  'pyxis': INVENTARIO_FOLDER_ID,                     // misma carpeta que los inventarios (Inventario.gs)
  'stocksearch': '10A5-v9FmN2MasXjbG3hvWdQeIYfPZGIg' // carpeta nueva de Power BI
};

function getOCrearTokenRobotArchivo() {
  var props = PropertiesService.getScriptProperties();
  var tok = props.getProperty('ROBOT_ARCHIVO_TOKEN');
  if (!tok) {
    tok = Utilities.getUuid();
    props.setProperty('ROBOT_ARCHIVO_TOKEN', tok);
  }
  return tok;
}

/**
 * Recibe un archivo (base64) de un robot y lo guarda en la carpeta
 * correspondiente a "destino", SOBRESCRIBIENDO cualquier archivo previo con
 * el mismo nombre en esa carpeta.
 *
 * comprimido (opcional, HISTORICO): true si archivoBase64 es el .gz del
 * archivo. YA NO SE USA para archivos grandes -- Utilities.ungzip() sobre un
 * CSV de 99 MB revento la memoria del propio Apps Script (visto en real
 * 2026-09-15: "Error de falta de memoria"). Se deja el parametro por si algun
 * caso pequeno lo necesita, pero TOM2 ahora usa trozos (ver parte/totalPartes).
 *
 * parte/totalPartes (opcional): subida en varios trozos SIN comprimir (cada
 * trozo va por debajo del limite de payload de google.script.run, ~27 MB
 * probado). El robot manda los trozos en orden por llamadas SEPARADAS; aqui
 * se van anexando al mismo archivo en Drive (leer bytes existentes + pegar
 * el trozo nuevo + reescribir). En el trozo 1 se crea el archivo desde cero
 * (reemplazando cualquier archivo previo con ese nombre); en el ultimo trozo
 * se registra en el log de actividad igual que una subida normal. Los
 * llamadores que no manden estos parametros (TOM #1, inventarios,
 * StockSearch) siguen exactamente igual que antes.
 */
function recibirArchivoRobot(token, destino, nombreArchivo, archivoBase64, mime, comprimido, parte, totalPartes) {
  if (token !== getOCrearTokenRobotArchivo()) return { ok: false, error: 'Token invalido' };

  var folderId = CARPETA_ARCHIVO_POR_DESTINO[destino];
  if (!folderId) return { ok: false, error: 'Destino desconocido: ' + destino };

  var nombre = String(nombreArchivo || '').replace(/[\/\\]/g, '_');
  if (!nombre) return { ok: false, error: 'Nombre de archivo vacio' };

  var bytes;
  try {
    bytes = Utilities.base64Decode(archivoBase64);
  } catch (e) {
    return { ok: false, error: 'archivoBase64 invalido: ' + e.message };
  }

  if (comprimido) {
    try {
      bytes = Utilities.ungzip(Utilities.newBlob(bytes, 'application/gzip', nombre + '.gz')).getBytes();
    } catch (e) {
      return { ok: false, error: 'ungzip fallo: ' + e.message };
    }
  }

  var carpeta = DriveApp.getFolderById(folderId);

  if (parte && parte > 1) {
    // Trozo 2+: anexar al archivo ya creado por el trozo anterior.
    // OJO memoria: bytes (de base64Decode/getBytes) ya es un array plano de
    // GAS -- concat() sobre dos arrays planos es barato. Antes se pasaba por
    // Uint8Array + Array.from() para volver a array plano, y ESE paso
    // (Array.from sobre un typed array grande) es lo que realmente reventaba
    // la memoria, no el tamano en si (confirmado 2026-09-17: el trozo 1
    // solo -20 MB- subio bien, el trozo 2 -concat- peto).
    // Y el archivo viejo NO se borra hasta que el nuevo este creado y
    // confirmado -- si algo falla a mitad, antes se perdia el trozo 1 ya
    // subido (visto en real: "trozo 2 sin trozo 1 previo" tras un fallo).
    var existentes = carpeta.getFilesByName(nombre);
    if (!existentes.hasNext()) return { ok: false, error: 'No se encontro el archivo a continuar (trozo ' + parte + ' sin trozo 1 previo)' };
    var archivoExistente = existentes.next();
    var bytesPrevios = archivoExistente.getBlob().getBytes();
    var bytesCombinados = bytesPrevios.concat(bytes);
    var blobParte = Utilities.newBlob(bytesCombinados, mime || 'application/octet-stream', nombre);
    var archivoParte = carpeta.createFile(blobParte);
    archivoExistente.setTrashed(true);
    if (parte === totalPartes) {
      logActividad('ROBOT_ARCHIVO', nombre + ' subido a "' + destino + '" (' + totalPartes + ' trozos)', 'robot');
    }
    return { ok: true, archivo: archivoParte.getName(), id: archivoParte.getId(), reemplazados: 0 };
  }

  var reemplazados = 0;
  var it = carpeta.getFilesByName(nombre);
  while (it.hasNext()) {
    it.next().setTrashed(true);
    reemplazados++;
  }

  var blob = Utilities.newBlob(bytes, mime || 'application/octet-stream', nombre);
  var nuevo = carpeta.createFile(blob);
  if (!parte || parte === totalPartes) {
    logActividad('ROBOT_ARCHIVO', nombre + ' subido a "' + destino + '" (' + reemplazados + ' reemplazado(s))', 'robot');
  }
  return { ok: true, archivo: nuevo.getName(), id: nuevo.getId(), reemplazados: reemplazados };
}

/**
 * Prueba manual desde el editor de Apps Script (mismo patron que
 * probarInventario() en Inventario.gs). Ejecutar UNA VEZ tras desplegar:
 * imprime el token a pegar en los .ps1 y sube un archivo de prueba a la
 * carpeta de Pyxis para confirmar que el guardado en Drive funciona.
 * El archivo de prueba (_prueba_recibirArchivoRobot.txt) se puede borrar a
 * mano de esa carpeta despues de comprobarlo.
 */
function probarSubirArchivoRobot() {
  var token = getOCrearTokenRobotArchivo();
  Logger.log('Token (pegar en TOM_bucle.ps1 y stocksearch_bucle.ps1 como $TOKEN_ARCHIVO): ' + token);

  var contenido = 'prueba recibirArchivoRobot ' + new Date().toISOString();
  var base64 = Utilities.base64Encode(contenido);
  var resultado = recibirArchivoRobot(token, 'pyxis', '_prueba_recibirArchivoRobot.txt', base64, 'text/plain');
  Logger.log('Resultado subida de prueba: ' + JSON.stringify(resultado));
}
