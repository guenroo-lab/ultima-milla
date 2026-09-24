/**
 * ============================================================
 * Pruebas.gs · Tests ejecutables desde el editor de Apps Script
 * ============================================================
 * Ejecuta cada función test_* desde el editor y mira el log (Ver → Registros).
 * Cada assert escribe PASS/FAIL. Un FAIL lanza excepción y detiene el test.
 */

/**
 * Diagnóstico de solo lectura (2026-09-03): pedido 286192 reportado "pillado
 * en la app". buscarPedidosMasivo es de solo lectura -- no toca datos --
 * solo para ver estado/tienda/silueta/flujo reales antes de decidir cómo
 * quitarlo (root cause primero, ver systematic-debugging).
 */
/**
 * Acción REAL (2026-09-03): el diagnóstico de solo lectura confirmó que
 * "286192" existe en DOS tiendas -- Mijas (ENTREGADO, ya resuelto, silueta
 * vacía) y MARBELLA (COMPLETADO_LISTO, silueta A13 ocupada desde el
 * 2026-08-18, ~2 semanas sin cerrar) -- ese segundo es el "pillado en la
 * app" que reportó el usuario. Usa liberarPedidoDeSilueta (Backend.gs) con
 * tienda='Marbella' para no tocar el de Mijas -- misma función que el botón
 * admin. disposicion='otros' -> SALIDA_MANUAL (terminal genérico), libera la
 * posición A13 y lo saca de cualquier cola activa.
 */
function ejecutarQuitarPedido286192Marbella() {
  var r = liberarPedidoDeSilueta('286192', 'otros', 'Pedido pillado en Marbella desde 2026-08-18 -- liberado a petición del usuario 2026-09-03', 'Marbella');
  Logger.log(JSON.stringify(r, null, 2));
  return r;
}

function ejecutarDiagnosticoPedido286192() {
  var r = buscarPedidosMasivo(['286192']);
  Logger.log('buscarPedidosMasivo: ' + JSON.stringify(r, null, 2));

  var pedidos = leerHoja('PEDIDOS');
  var p = pedidos.find(function(x) { return String(x.ped) === '286192'; });
  Logger.log('Fila PEDIDOS completa: ' + JSON.stringify(p, null, 2));

  if (p) {
    var visa = leerHoja('VISAS').find(function(v) { return v.id === p.id; });
    Logger.log('VISA asociada: ' + JSON.stringify(visa, null, 2));

    var ocup = leerHoja('OCUPACION').filter(function(o) { return String(o.pedido) === '286192'; });
    Logger.log('Filas OCUPACION con este nº: ' + JSON.stringify(ocup, null, 2));

    if (p.numeroCarga) {
      var carga = leerHoja('CARGAS').find(function(c) { return String(c.numCarga) === String(p.numeroCarga); });
      Logger.log('Carga asociada (numeroCarga=' + p.numeroCarga + '): ' + JSON.stringify(carga, null, 2));
    } else {
      Logger.log('Sin numeroCarga.');
    }
  }
  return r;
}

/**
 * Prueba REAL end-to-end (Task 6 del plan de Camión Grúa): crea una carga real marcada
 * Camión Grúa con un pedido real en silueta (indicado por el usuario), confirma que sale
 * bien, y la ELIMINA a continuación con eliminarCargaCompleta -- libera el pedido de vuelta
 * a silueta, no deja restos en "Cargas activas". La fila que caiga en la hoja externa
 * CARGAS TAISA NO se borra aquí -- hay que borrarla a mano, igual que las de prueba
 * anteriores (ver ejecutarPruebaCargasTaisa).
 */
var NUM_PED_PRUEBA_GRUA_REAL = '980217';

function ejecutarPruebaCargaRealCamionGrua() {
  var r = crearCarga([NUM_PED_PRUEBA_GRUA_REAL], 'PRUEBA CAMION GRUA - BORRAR', true, 'Remansur');
  Logger.log('crearCarga: ' + JSON.stringify(r));
  if (!r.ok) { Logger.log('⚠ No se pudo crear -- revisa el error de arriba, no hay nada que limpiar.'); return; }

  var borrado = eliminarCargaCompleta(r.carga.id);
  Logger.log('eliminarCargaCompleta: ' + JSON.stringify(borrado));
  Logger.log('Pedido ' + NUM_PED_PRUEBA_GRUA_REAL + ' liberado de nuevo a silueta. Revisa la hoja CARGAS TAISA externa y borra a mano la fila de esta prueba (agencia REMANSUR, pedido ' + NUM_PED_PRUEBA_GRUA_REAL + ').');
}

/**
 * Prueba el índice de pedidos_totales.csv y el exportador a CARGAS TAISA de forma AISLADA
 * (sin pasar por crearCarga real). Escribe una fila de prueba real en la hoja externa --
 * el usuario debe borrarla a mano después de confirmar que salió bien (ver plan de
 * implementación, Task 3, Paso 3). PED_REAL_CONOCIDO_GRUA: un pedido real que el usuario
 * sepa que está en pedidos_totales.csv, para comprobar que sale con datos -- si se deja en
 * blanco, ese bloque se salta.
 */
var PED_REAL_CONOCIDO_GRUA = '291161'; // real, confirmado existente esta misma sesión (diagnóstico Forzar)

function ejecutarPruebaCargasTaisa() {
  if (PED_REAL_CONOCIDO_GRUA) {
    var indice = _indicePedidosTotales();
    var datos = indice[PED_REAL_CONOCIDO_GRUA];
    Logger.log('Datos de ' + PED_REAL_CONOCIDO_GRUA + ': ' + JSON.stringify(datos));
    if (!datos) Logger.log('⚠ No se encontró -- revisa que el número sea correcto y esté en el CSV');
  } else {
    Logger.log('PED_REAL_CONOCIDO_GRUA vacío -- se salta la comprobación con pedido real.');
  }

  var itemsPrueba = [
    { ped: 'TESTGRUA_CONDATOS', tienda: 'Málaga' },
    { ped: 'TESTGRUA_SINDATOS_99999999', tienda: 'Mijas' }
  ];
  var n = _exportarCargaTaisa_('Remansur', new Date().toISOString(), itemsPrueba);
  Logger.log('Filas escritas en CARGAS TAISA: ' + n + ' -- revisa la hoja externa y BÓRRALAS a mano tras confirmar que el formato es correcto (agencia/fecha/tienda/pedido en las columnas A-D, y en la fila SINDATOS las columnas E-H vacías).');
}

/**
 * Solo-lectura: relee las últimas filas de CARGAS TAISA sin escribir nada -- para verificar
 * lo que dejó ejecutarPruebaCargasTaisa cuando no se puede abrir la hoja externa a mano
 * (p.ej. sesión de navegador con la cuenta de Google equivocada).
 */
function ejecutarVerificarUltimasFilasCargasTaisa() {
  var hoja = SpreadsheetApp.openById(CARGAS_TAISA_SHEET_ID).getSheetByName(CARGAS_TAISA_TAB);
  var ultimaFila = hoja.getLastRow();
  var n = 3;
  var filas = hoja.getRange(ultimaFila - n + 1, 1, n, 9).getValues();
  Logger.log('Últimas ' + n + ' filas (' + (ultimaFila - n + 1) + '-' + ultimaFila + '): ' + JSON.stringify(filas));
}

/**
 * DIAGNÓSTICO DE SOLO LECTURA (2026-09-01): antes de diseñar la caché del índice de
 * pedidos_totales.csv para Camión Grúa -- cuántas filas y pedidos ÚNICOS tiene de verdad,
 * y qué tamaño tendría el índice compacto en JSON (para saber si cabe en una sola clave de
 * CacheService, límite real 100KB, o hace falta trocearlo).
 */
function ejecutarDiagnosticoTamanoPedidosTotales() {
  var carpeta = DriveApp.getFolderById(INVENTARIO_FOLDER_ID);
  var it = carpeta.getFilesByName('pedidos_totales.csv');
  if (!it.hasNext()) { Logger.log('No se encontró pedidos_totales.csv en la carpeta.'); return; }
  var file = it.next();
  Logger.log('Tamaño del archivo: ' + (file.getSize() / 1024 / 1024).toFixed(1) + ' MB');
  var texto = file.getBlob().getDataAsString('UTF-8').replace(/^﻿/, '');
  var lineas = texto.split('\n');
  Logger.log('Total líneas (incluida cabecera): ' + lineas.length);

  var cab = lineas[0].split(';').map(function(c) { return c.replace(/"/g, '').trim(); });
  Logger.log('Cabecera cruda (primeras 10): ' + JSON.stringify(cab.slice(0, 10)));
  var idxPed = cab.indexOf('Nº Pedido cliente');
  var idxPro = cab.indexOf('Cliente PRO');
  var idxPeso = cab.indexOf('Peso');
  var idxCp = cab.indexOf('Código postal envío');
  var idxCiudad = cab.indexOf('Ciudad envío');
  Logger.log('Índices de columna: ped=' + idxPed + ' pro=' + idxPro + ' peso=' + idxPeso + ' cp=' + idxCp + ' ciudad=' + idxCiudad);

  var indice = {};
  for (var i = 1; i < lineas.length; i++) {
    if (!lineas[i]) continue;
    var f = lineas[i].split(';');
    var ped = (f[idxPed] || '').replace(/"/g, '').trim();
    if (!ped || indice[ped]) continue;
    indice[ped] = {
      peso: (f[idxPeso] || '').replace(/"/g, ''),
      cp: (f[idxCp] || '').replace(/"/g, ''),
      ciudad: (f[idxCiudad] || '').replace(/"/g, ''),
      esPro: (f[idxPro] || '').replace(/"/g, '').toLowerCase() === 'si'
    };
  }
  var pedidosUnicos = Object.keys(indice).length;
  var json = JSON.stringify(indice);
  Logger.log('Pedidos únicos: ' + pedidosUnicos);
  Logger.log('Tamaño del índice JSON: ' + (json.length / 1024).toFixed(1) + ' KB');
  Logger.log('Ejemplo de una entrada real: ' + JSON.stringify(indice[Object.keys(indice)[0]]));
}

/**
 * DIAGNÓSTICO (2026-09-01): el usuario reporta que el pedido 291161 (Entregado) sale
 * correctamente en "omitidos" al importar, pero el chip "Forzar" no aparece en el
 * Clasificador. Llama a importarClasificacion tal cual lo hace el cliente real, y
 * vuelca el objeto COMPLETO devuelto (incluido omitidosForzables) para ver de verdad
 * qué está llegando -- sin depender del navegador ni de ninguna caché.
 */
function ejecutarDiagnosticoOmitidosForzables() {
  var res = importarClasificacion({ Transporte: ['291161'] }, {});
  Logger.log(JSON.stringify(res, null, 2));
  return res;
}

/**
 * Prueba actualizarChofer contra una carga real (2026-09-01). Si ID_CARGA_PRUEBA_CHOFER sigue con
 * el valor por defecto, elige automáticamente la carga CERRADA más reciente (ya entregada, nadie
 * trabajando en ella ahora mismo -- la opción más segura) en vez de una GENERADA en curso. Guarda el
 * valor original y lo restaura al final, incluso si algo falla (try/finally) -- no debe dejar la
 * carga real modificada.
 */
var ID_CARGA_PRUEBA_CHOFER = 'PON_AQUI_UN_ID_DE_CARGA_REAL';

function ejecutarPruebaActualizarChofer() {
  var cargas = leerHoja('CARGAS');
  var idUsar = ID_CARGA_PRUEBA_CHOFER;
  if (idUsar === 'PON_AQUI_UN_ID_DE_CARGA_REAL') {
    var cerradas = cargas.filter(function(c) { return c.estado === 'CERRADA'; });
    cerradas.sort(function(a, b) { return new Date(b.fecha) - new Date(a.fecha); });
    if (!cerradas.length) { Logger.log('❌ No hay ninguna carga CERRADA para probar.'); return; }
    idUsar = cerradas[0].id;
    Logger.log('Auto-elegida (CERRADA más reciente): ' + idUsar + ' (carga nº ' + cerradas[0].numCarga + ')');
  }
  var original = cargas.find(function(c) { return c.id === idUsar; });
  if (!original) { Logger.log('❌ No se encontró la carga ' + idUsar); return; }
  var choferOriginal = original.responsable;
  var cargadorOriginal = original.cargador;
  Logger.log('Antes: responsable=' + JSON.stringify(choferOriginal) + ' cargador=' + JSON.stringify(cargadorOriginal));

  try {
    var r = actualizarChofer(idUsar, 'CHOFER_PRUEBA_TEMPORAL');
    Logger.log('Resultado: ' + JSON.stringify(r));
    var tras = leerHoja('CARGAS').find(function(c) { return c.id === idUsar; });
    Logger.log('Después: responsable=' + JSON.stringify(tras.responsable) + ' cargador=' + JSON.stringify(tras.cargador));
    var ok = r.ok && tras.responsable === 'CHOFER_PRUEBA_TEMPORAL' && tras.cargador === cargadorOriginal;
    Logger.log(ok ? '✓ OK (chófer cambiado, cargador intacto)' : '❌ FALLO');
  } finally {
    actualizarChofer(idUsar, choferOriginal || '');
    var restaurado = leerHoja('CARGAS').find(function(c) { return c.id === idUsar; });
    Logger.log('Restaurado a: ' + JSON.stringify(restaurado.responsable));
  }
}

/**
 * DIAGNÓSTICO DE SOLO LECTURA (2026-09-01): comprobando si el Excel real de Pyxis trae
 * localidad/código postal/peso en columnas que hoy INV_COL no lee (dir,ped,seccion,
 * subseccion,ref,ean,des,ctd = 8 columnas mapeadas, pero mapearFilasHoja() solo usa 6).
 * Abre el PRIMER archivo de inventario que encuentre y vuelca la fila de cabeceras (fila 3)
 * + una fila de datos de muestra, sin tocar nada.
 */
function ejecutarDiagnosticoColumnasPyxis() {
  var carpeta = DriveApp.getFolderById(INVENTARIO_FOLDER_ID);
  var it = carpeta.getFiles();
  if (!it.hasNext()) { Logger.log('Carpeta de inventarios vacía.'); return; }
  var file = it.next();
  Logger.log('Archivo: ' + file.getName());
  var abierto = abrirComoSpreadsheet(file);
  var hoja = abierto.ss.getSheetByName(INV_SHEET_NOMBRE) || abierto.ss.getSheets()[0];
  var valores = hoja.getDataRange().getValues();
  if (abierto.tempId) { try { DriveApp.getFileById(abierto.tempId).setTrashed(true); } catch (e) {} }
  Logger.log('Total columnas reales: ' + (valores[2] || []).length);
  Logger.log('Fila 3 (cabeceras): ' + JSON.stringify(valores[2]));
  Logger.log('Fila 4 (muestra de datos): ' + JSON.stringify(valores[3]));
  return { cabeceras: valores[2], muestra: valores[3] };
}

function ejecutarLimpiezaFilasPrueba() {
  var resultado = { borrados: [], sinTocar: [] };
  ['TEST_SYNC_borrar', 'TEST_SYNC_borrar_numcarga'].forEach(function(id) {
    var fila = leerHoja('PEDIDOS').find(function(p) { return p.id === id; });
    if (!fila) { resultado.sinTocar.push(id + ': ya no existe'); return; }
    var lineas = leerHoja('LINEAS').filter(function(l) { return l.idPedido === id; });
    if (lineas.length) {
      var sheetL = getHoja('LINEAS');
      lineas.map(function(l) { return l._fila; }).sort(function(a, b) { return b - a; })
        .forEach(function(f) { sheetL.deleteRows(f, 1); });
    }
    getHoja('PEDIDOS').deleteRows(fila._fila, 1);
    resultado.borrados.push(id + ' (ped ' + fila.ped + ', ' + lineas.length + ' lineas)');
  });
  Logger.log(JSON.stringify(resultado, null, 2));
  return resultado;
}

function ejecutarCorregirSiluetaFantasma() {
  var resultado = { reparados: [], sinTocar: [] };
  var targets = ['014::286192', '279::290529'];
  targets.forEach(function(id) {
    var fila = leerHoja('PEDIDOS').find(function(p) { return p.id === id; });
    if (!fila) { resultado.sinTocar.push(id + ': ya no existe'); return; }
    var ocupado = leerHoja('OCUPACION').some(function(o) {
      return o.silueta === fila.silueta && Number(o.pos) >= Number(fila.posIni) && Number(o.pos) <= Number(fila.posFin);
    });
    if (ocupado) { resultado.sinTocar.push(id + ': ahora si tiene ocupacion real, no se toca'); return; }
    var siluetaVieja = fila.silueta + fila.posIni;
    var cambios = { silueta: '', posIni: '', posFin: '', actualizado: new Date().toISOString() };
    actualizarFila('PEDIDOS', fila._fila, cambios);
    sincronizarPedidoSupabase_(fila, cambios);
    resultado.reparados.push(id + ' (era ' + siluetaVieja + ')');
  });
  Logger.log(JSON.stringify(resultado, null, 2));
  return resultado;
}

/**
 * APLICA de verdad el plan de compactado real (2026-09-01, confirmado por el usuario
 * "SI APLICALO" tras ver el diagnóstico de solo lectura de más abajo). Recalcula el plan
 * fresco justo antes de aplicarlo (mismo patrón que el botón real del admin: previsualizar
 * -> confirmar -> aplicar con el MISMO array) y loguea aplicados/omitidos para ver si A1
 * se rechaza en el momento de escribir, y por qué motivo exacto si es así. Primera función
 * del archivo a propósito -- va a escribir de verdad, no puede depender del desplegable.
 */
function ejecutarAplicarCompactarA1() {
  var plan = previsualizarCompactarSiluetas();
  Logger.log('Plan a aplicar (' + plan.movimientos.length + ' movimientos): ' + JSON.stringify(plan.movimientos));
  var res = aplicarCompactarSiluetas(plan.movimientos);
  Logger.log('Resultado: ok=' + res.ok + ' aplicados=' + res.aplicados);
  Logger.log('Movimientos aplicados: ' + JSON.stringify(res.movimientos));
  Logger.log('Omitidos: ' + JSON.stringify(res.omitidos));
  var a1Aplicado = res.movimientos.some(function(m) { return m.siluetaNueva === 'A' && m.posIniNueva === 1; });
  var a1Omitido = res.omitidos.filter(function(s) { return String(s).indexOf('A1') !== -1; });
  Logger.log('¿A1 quedó realmente aplicado? ' + a1Aplicado + ' · omitidos relacionados con A1: ' + JSON.stringify(a1Omitido));
  return res;
}

/**
 * DIAGNÓSTICO DE SOLO LECTURA (2026-09-01): investigando el reporte del usuario
 * "al compactar, la posición A1 siempre se queda vacía". previsualizarCompactarSiluetas()
 * no escribe nada -- solo LEE y calcula el plan. Se ejecuta tal cual, sin tocar datos, para
 * ver el plan REAL contra los datos reales, en vez de fiarse de un rastreo a mano.
 */
function ejecutarDiagnosticoCompactarA1() {
  var plan = previsualizarCompactarSiluetas();
  Logger.log('Total revisados: ' + plan.totalRevisados);
  Logger.log('Movimientos propuestos: ' + plan.movimientos.length);
  plan.movimientos.forEach(function(m) {
    Logger.log(m.ped + ': ' + m.siluetaVieja + m.posIniVieja + '-' + m.posFinVieja + ' -> ' + m.siluetaNueva + m.posIniNueva + '-' + m.posFinNueva);
  });
  var haciaA1 = plan.movimientos.filter(function(m) { return m.siluetaNueva === 'A' && m.posIniNueva === 1; });
  Logger.log('¿Algún movimiento propone A1 como destino? ' + (haciaA1.length ? JSON.stringify(haciaA1) : 'NINGUNO'));
  return plan;
}

/**
 * Prueba el bloque "forzados" de importarClasificacion (2026-08-31). NO toca ningún pedido
 * real -- todos los datos de prueba llevan el prefijo TESTFORZ_ y se limpian al final,
 * incluso si algo falla a mitad (try/finally).
 */
function ejecutarPruebaForzarReimportacion() {
  return probarForzarReimportacion();
}

function probarForzarReimportacion() {
  var idsCreados = [];
  try {
    Logger.log('--- Caso 1: guarda -- pedido YA NO está en estado terminal ---');
    var idNoTerminal = '036::TESTFORZ_NOTERM';
    anadirFila('PEDIDOS', {
      id: idNoTerminal, ped: 'TESTFORZ_NOTERM', tienda: 'Málaga', transportista: 'Correcaminos',
      flujo: 'transporte', estado: 'PENDIENTE', pct: 0, operario: '', silueta: '', posIni: '', posFin: '',
      numeroCarga: '', soportes: '[]', nLin: 0, nUbic: 0, actualizado: new Date().toISOString(), parcial: false, comentario: ''
    });
    idsCreados.push(idNoTerminal);
    var r1 = importarClasificacion({}, { forzados: [{ ped: 'TESTFORZ_NOTERM', tienda: 'Málaga', dirsSel: [] }] });
    Logger.log('forzadosError esperado 1, motivo "ya no está en un estado que se pueda forzar": ' + JSON.stringify(r1.forzadosError));
    if (r1.forzadosError.length !== 1 || r1.forzadosOk.length !== 0) Logger.log('❌ FALLO caso 1');
    else Logger.log('✓ OK caso 1');

    Logger.log('--- Caso 2: guarda -- pedido terminal pero YA NO está en Pyxis ---');
    var idNoPyxis = '036::TESTFORZ_NOPYXIS';
    anadirFila('PEDIDOS', {
      id: idNoPyxis, ped: 'TESTFORZ_NOPYXIS', tienda: 'Málaga', transportista: 'Correcaminos',
      flujo: 'transporte', estado: 'ENTREGADO', pct: 100, operario: '', silueta: '', posIni: '', posFin: '',
      numeroCarga: '', soportes: '[]', nLin: 1, nUbic: 1, actualizado: new Date().toISOString(), parcial: false, comentario: ''
    });
    idsCreados.push(idNoPyxis);
    var r2 = importarClasificacion({}, { forzados: [{ ped: 'TESTFORZ_NOPYXIS', tienda: 'Málaga', dirsSel: [] }] });
    Logger.log('forzadosError esperado 1, motivo "ya no está en el inventario de Pyxis": ' + JSON.stringify(r2.forzadosError));
    if (r2.forzadosError.length !== 1 || r2.forzadosOk.length !== 0) Logger.log('❌ FALLO caso 2');
    else Logger.log('✓ OK caso 2');

    Logger.log('--- Caso 3: mecánica de reset+sustitución de líneas (sin pasar por Pyxis real) ---');
    var idMecanica = '036::TESTFORZ_MECANICA';
    anadirFila('PEDIDOS', {
      id: idMecanica, ped: 'TESTFORZ_MECANICA', tienda: 'Málaga', transportista: 'Correcaminos',
      flujo: 'transporte', estado: 'ENTREGADO', pct: 100, operario: 'Alguien', silueta: 'A', posIni: '3', posFin: '3',
      numeroCarga: '', soportes: '[]', nLin: 1, nUbic: 1, actualizado: new Date().toISOString(), parcial: false, comentario: ''
    });
    idsCreados.push(idMecanica);
    anadirFila('LINEAS', {
      id: idMecanica + '::L0', idPedido: idMecanica, idx: 0, dir: 'VIEJA-1', ref: 'REFVIEJA', ean: '', des: 'línea vieja',
      ctd: 1, tipoUbic: 'palet', esPicking: false, estado: 'PREPARADO', motivo: '', operario: 'Alguien', ts: new Date().toISOString()
    });
    var lineasAntes = leerHoja('LINEAS').filter(function(l) { return l.idPedido === idMecanica; });
    Logger.log('Líneas antes de forzar (esperado 1): ' + lineasAntes.length);

    _borrarLineasDePedido(idMecanica);
    var rMec = _construirEInsertarLineas(idMecanica, 'TESTFORZ_MECANICA', [
      { dir: 'FRESCA-1', ref: 'REF1', ean: 'EAN1', des: 'línea fresca 1', ctd: 2 },
      { dir: 'FRESCA-2', ref: 'REF2', ean: 'EAN2', des: 'línea fresca 2', ctd: 1 }
    ]);
    var lineasDespues = leerHoja('LINEAS').filter(function(l) { return l.idPedido === idMecanica; });
    Logger.log('nLin/nUbic devueltos: ' + JSON.stringify(rMec) + ' · líneas reales tras sustituir: ' + lineasDespues.length +
      ' · dirs: ' + lineasDespues.map(function(l) { return l.dir; }).join(','));
    var mecanicaOk = rMec.nLin === 2 && rMec.nUbic === 2 && lineasDespues.length === 2 &&
      lineasDespues.every(function(l) { return l.dir.indexOf('FRESCA-') === 0; });
    Logger.log(mecanicaOk ? '✓ OK caso 3 (líneas viejas fuera, frescas dentro, conteos correctos)' : '❌ FALLO caso 3');

  } finally {
    idsCreados.forEach(function(id) {
      _borrarLineasDePedido(id);
      var fila = leerHoja('PEDIDOS').find(function(p) { return p.id === id; });
      if (fila) getHoja('PEDIDOS').deleteRow(fila._fila);
    });
    Logger.log('--- Limpieza completa: ' + idsCreados.length + ' pedidos de prueba y sus líneas eliminados ---');
  }
}

/**
 * DIAGNÓSTICO (solo lectura, 2026-08-13): lee la capacidad EFECTIVA real de
 * cada silueta (valor por defecto de CONFIG.POSICIONES_POR_SILUETA fusionado
 * con el override de PropertiesService, si lo hay) -- necesario para sembrar
 * config_siluetas en Supabase (Fase 3, Lote 1) sin adivinar el valor.
 */
function ejecutarDiagnosticoCapacidadesSiluetas() {
  var out = CONFIG.SILUETAS.map(function(s) {
    return { silueta: s, posiciones: posicionesDeSilueta(s) };
  });
  Logger.log(JSON.stringify(out));
  return out;
}

/**
 * DIAGNÓSTICO (solo lectura, 2026-08-12): mide el volumen real de las 9 hojas
 * oficiales antes de diseñar el volcado masivo de históricos a Supabase
 * (Fase 2 de la migración) -- el tamaño de lote y si hace falta trocear el
 * volcado en varias ejecuciones dependen de esto, no se puede adivinar.
 * Colocada como PRIMERA función del archivo a propósito (ver nota más abajo
 * sobre el desplegable de funciones del editor).
 */
function contarFilasHojasParaMigracion() {
  var claves = ['PEDIDOS', 'LINEAS', 'OCUPACION', 'CARGAS', 'HISTORIAL', 'LOG', 'VISAS', 'RETIRADAS', 'HIST_TRANSP'];
  Logger.log('=== Recuento de filas por hoja (para calibrar el volcado de Fase 2) ===');
  claves.forEach(function(clave) {
    var n = leerHoja(clave).length;
    Logger.log(clave + ' (' + HOJAS[clave] + '): ' + n + ' filas');
  });
  return 'OK';
}

/**
 * LIMPIEZA de un caso concreto (2026-08-11): diagnosticarPedidoBloqueado(976313)
 * confirmó que ese pedido tiene 2 filas HUÉRFANAS en OCUPACION_SILUETAS
 * (silueta A, pos 14, back+front) que ya no tienen ningún pedido real detrás
 * -- el pedido 976313 se cerró dos veces el 2026-08-07 (16:16 -> A14, 18:14
 * -> zona libre "PANT21-2"), y `cerrarPedido` no libera la posición anterior
 * al reasignar una nueva, así que A14 quedó huérfana desde entonces. El
 * pedido en sí ya está fuera del sistema (estado SALIDA_MANUAL, silueta
 * vacía) -- esto SOLO borra el resto de OCUPACION, no toca el pedido.
 * (Colocada al PRINCIPIO del archivo a propósito -- el desplegable de
 * funciones del editor solo se puede hacer scroll de forma fiable con
 * clics por coordenada, así que las funciones que hay que ejecutar una vez
 * y de forma puntual van mejor cerca del principio, visibles sin desplazar.)
 *
 * INTENTO 1 (fallido, 2026-08-11 11:01): liberarPosiciones (que usa
 * sheet.deleteRow) lanzó "No se pueden eliminar todas las filas que no
 * estén inmovilizadas" -- resulta que estas 2 filas son AHORA MISMO las
 * ÚNICAS filas de datos de toda la hoja OCUPACION_SILUETAS, y Sheets no
 * permite borrar filas si eso deja la hoja sin NINGUNA fila sin inmovilizar
 * por debajo de la cabecera. Fix: en vez de borrar la fila entera, se vacía
 * su contenido (clearContent) -- incluidas en el rango de lectura de
 * leerHoja() como filas con todos los campos vacíos, que ningún filtro del
 * código real trata como un pedido válido (todos comprueban pedido/silueta
 * con valor, nunca asumen que toda fila tiene datos), así que quedan
 * completamente inertes.
 */
function limpiarHuecoFantasma976313() {
  var antes = leerHoja('OCUPACION').filter(function(o) { return String(o.pedido).trim() === '976313'; });
  Logger.log('Filas OCUPACION antes de limpiar: ' + JSON.stringify(antes));
  if (!antes.length) { Logger.log('Nada que limpiar -- ya no hay filas de OCUPACION para 976313.'); return { antes: 0, despues: 0 }; }
  var sheet = getHoja('OCUPACION');
  var numCols = COLUMNAS.OCUPACION.length;
  var limpiadas = 0;
  antes.forEach(function(o) {
    sheet.getRange(o._fila, 1, 1, numCols).clearContent();
    limpiadas++;
  });
  eliminarOcupacionSupabase_('A', 14, 14, '976313');
  var despues = leerHoja('OCUPACION').filter(function(o) { return String(o.pedido).trim() === '976313'; });
  Logger.log('Filas vaciadas: ' + limpiadas + ' -- filas OCUPACION con pedido=976313 después: ' + despues.length + ' (debería ser 0)');
  return { antes: antes.length, limpiadas: limpiadas, despues: despues.length };
}

/**
 * Sanity check de solo lectura (no escribe nada) para el alta del transporte
 * GruaRemansur (2026-08-07): comprueba que el flujo nuevo está bien enganchado
 * en los 4 mapas de configuración que usan cambiarFlujoPedido/el croquis/las
 * pantallas de "cambiar tipo de transporte" -- sin esto, cambiarFlujoPedido
 * rechazaría 'grua_remansur' con "Tipo de transporte no válido" (mira
 * FLUJO_A_TRANSPORTISTA) aunque el resto de la app pareciera correcto.
 */
function test_configGruaRemansur() {
  _assert(CONFIG.TRANSPORTISTAS_FLUJO['GruaRemansur'] === 'grua_remansur', 'TRANSPORTISTAS_FLUJO no mapea GruaRemansur→grua_remansur');
  _assert(CONFIG.FLUJO_LETRA.grua_remansur === 'G', 'FLUJO_LETRA.grua_remansur no es "G"');
  _assert(CONFIG.FLUJO_LABEL.grua_remansur === 'GruaRemansur', 'FLUJO_LABEL.grua_remansur incorrecto');
  _assert(FLUJO_A_TRANSPORTISTA.grua_remansur === 'GruaRemansur', 'FLUJO_A_TRANSPORTISTA.grua_remansur incorrecto -- cambiarFlujoPedido lo rechazaría');
  _assert(esRemansur('grua_remansur') === false, 'esRemansur("grua_remansur") debería ser false (posición entera, no comparte delante)');
  Logger.log('✓ test_configGruaRemansur: 5/5 asserts PASS');
}

/**
 * DIAGNÓSTICO (solo lectura, 2026-08-03): el usuario reportó un fallo NUEVO
 * -- artículos duplicados al sacar pedidos (ejemplo real: una dirección que
 * debía llevar 2 cerraduras aparece con 4, la línea de 2 se ve duplicada).
 * Hipótesis directa: es la MISMA causa raíz que el bug de pedidos duplicados
 * de hoy (v193) -- LINEAS se filtra siempre por `idPedido` (nunca por qué
 * fila de PEDIDOS la creó), así que cuando `importarClasificacion` creaba
 * dos filas de PEDIDOS con el mismo id (condición de carrera, ya corregida),
 * las DOS generaciones de líneas quedaban con el mismo idPedido y se ven
 * fusionadas/dobladas en cualquier sitio que las liste -- exactamente lo que
 * describe el usuario. Al limpiar los 6 duplicados de hoy, se dejó dicho
 * explícitamente que las líneas NO se tocaban (ver borrarPedidosFantasma...
 * no, ver limpiarPedidosDuplicadosImportacion_20260803): "se acepta como
 * deuda cosmética menor" -- este reporte demuestra que NO es cosmética,
 * afecta a la preparación real.
 * Esta función barre TODAS las líneas activas (pedidos no terminales, para
 * cubrir picking en curso) agrupadas por idPedido, y dentro de cada grupo
 * busca pares que compartan ref+dir+ctd (mismo artículo, misma dirección,
 * misma cantidad) -- la firma de una línea duplicada. Marca también si el
 * pedido tiene una fila de PEDIDOS duplicada AHORA MISMO (ya no debería,
 * tras la limpieza) para distinguir "resto de un duplicado ya limpiado
 * -- líneas huérfanas dobles" de "duplicado nuevo, aparecido después del
 * fix" (este segundo caso sería grave: significaría que el fix de v193/v195
 * no cerró el agujero del todo, o que hay OTRA vía de duplicar líneas,
 * p.ej. renovarDireccionesPedidoExistente corriendo dos veces a la vez).
 */
function auditarLineasDuplicadas() {
  var pedidos = leerHoja('PEDIDOS').filter(function(p) { return !ESTADOS_TERMINALES[p.estado]; });
  var porId = {};
  leerHoja('PEDIDOS').forEach(function(p) { (porId[p.id] = porId[p.id] || []).push(p); });

  var lineas = leerHoja('LINEAS');
  var lineasPorPedido = {};
  lineas.forEach(function(l) { (lineasPorPedido[l.idPedido] = lineasPorPedido[l.idPedido] || []).push(l); });

  var casos = [];
  pedidos.forEach(function(p) {
    var lineasPed = lineasPorPedido[p.id] || [];
    if (lineasPed.length < 2) return;
    var vistos = {};
    var duplicadas = [];
    lineasPed.forEach(function(l) {
      var clave = String(l.ref) + '|' + String(l.dir) + '|' + String(l.ctd);
      if (!vistos[clave]) vistos[clave] = [];
      vistos[clave].push(l);
    });
    Object.keys(vistos).forEach(function(clave) {
      if (vistos[clave].length > 1) duplicadas.push(vistos[clave]);
    });
    if (duplicadas.length) {
      casos.push({ pedido: p, duplicadas: duplicadas, filasPedidoConEsteId: (porId[p.id] || []).length });
    }
  });

  Logger.log('Pedidos activos revisados: ' + pedidos.length + ' · con líneas duplicadas: ' + casos.length);
  if (!casos.length) { Logger.log('OK -- ninguna línea duplicada detectada en pedidos activos.'); return 'sin casos'; }

  casos.forEach(function(c) {
    var p = c.pedido;
    Logger.log('=== ' + p.id + ' (ped ' + p.ped + ', ' + p.tienda + ') estado=' + p.estado +
      ' silueta=' + (p.silueta || '(sin)') + ' nLin=' + p.nLin +
      ' -- filas de PEDIDOS con este id AHORA: ' + c.filasPedidoConEsteId +
      (c.filasPedidoConEsteId > 1 ? ' (¡SIGUE DUPLICADO, revisar ya!)' : ' (fila única -- huérfanas de un duplicado viejo, o duplicado nuevo por otra vía)') + ' ===');
    c.duplicadas.forEach(function(grupo) {
      Logger.log('  DUPLICADA x' + grupo.length + ': ref=' + grupo[0].ref + ' dir=' + grupo[0].dir + ' ctd=' + grupo[0].ctd + ' des=' + grupo[0].des);
      grupo.forEach(function(l) {
        Logger.log('    fila ' + l._fila + ' id=' + l.id + ' idx=' + l.idx + ' estado=' + l.estado + ' ts=' + (l.ts || '(vacío)') + ' operario=' + (l.operario || ''));
      });
    });
  });
  return casos.length + ' pedido(s) con líneas duplicadas -- ver log';
}

/**
 * REPARACIÓN PUNTUAL (2026-08-03, autorizada por el usuario tras
 * auditarLineasDuplicadas() -- bug real "salen 4 cerraduras en vez de 2").
 * RE-ESCANEA en vivo (no usa ninguna lista fija de antemano -- misma
 * disciplina que limpiarPedidosDuplicadosImportacion_20260803) y, para cada
 * grupo de líneas que siga compartiendo ref+dir+ctd EXACTOS dentro del mismo
 * pedido, conserva la de `_fila` más baja (la primera creada) y borra el
 * resto. Después recalcula nLin/nUbic del pedido a partir de las líneas que
 * quedan de verdad (antes podían estar infladas por las duplicadas) y
 * resincroniza el pedido a Supabase. Solo toca pedidos activos (no
 * ESTADOS_TERMINALES) -- los 10 encontrados hoy están todos COMPLETADO_LISTO
 * (ya cerrados, nadie los está preparando ahora mismo), así que no hay
 * riesgo de borrar una línea que un operario esté tocando en este instante.
 * No reordena `idx` de las líneas que quedan (dejarlas con huecos en la
 * numeración es inofensivo -- nada depende de que sean consecutivas, solo
 * de que sean únicas dentro del pedido, y ya lo son tras borrar la copia).
 */
function limpiarLineasDuplicadas_20260803() {
  var pedidos = leerHoja('PEDIDOS').filter(function(p) { return !ESTADOS_TERMINALES[p.estado]; });
  var lineas = leerHoja('LINEAS');
  var lineasPorPedido = {};
  lineas.forEach(function(l) { (lineasPorPedido[l.idPedido] = lineasPorPedido[l.idPedido] || []).push(l); });

  var aBorrar = [];
  var aActualizarPedido = [];
  var omitidos = [];

  pedidos.forEach(function(p) {
    var lineasPed = lineasPorPedido[p.id] || [];
    if (lineasPed.length < 2) return;
    var grupos = {};
    lineasPed.forEach(function(l) {
      var clave = String(l.ref) + '|' + String(l.dir) + '|' + String(l.ctd);
      (grupos[clave] = grupos[clave] || []).push(l);
    });
    var borrarDeEstePedido = [];
    Object.keys(grupos).forEach(function(clave) {
      var grupo = grupos[clave];
      if (grupo.length < 2) return;
      grupo.sort(function(a, b) { return a._fila - b._fila; });
      // Se queda grupo[0] (la primera creada); el resto se borra.
      for (var i = 1; i < grupo.length; i++) borrarDeEstePedido.push(grupo[i]);
    });
    if (!borrarDeEstePedido.length) return;
    borrarDeEstePedido.forEach(function(l) { aBorrar.push(l); });
    aActualizarPedido.push({ pedido: p, filasABorrarIds: borrarDeEstePedido.map(function(l) { return l._fila; }) });
  });

  Logger.log('Pedidos con líneas duplicadas a limpiar: ' + aActualizarPedido.length + ' · líneas a borrar: ' + aBorrar.length);
  if (!aBorrar.length) { Logger.log('OK -- nada que limpiar (ya no hay líneas duplicadas en pedidos activos).'); return 'Nada que limpiar'; }

  // Borrar de abajo a arriba (todas las líneas de todos los pedidos juntas,
  // ordenadas una sola vez) para no desajustar filas entre borrados.
  var sheetLineas = getHoja('LINEAS');
  aBorrar.sort(function(a, b) { return b._fila - a._fila; });
  aBorrar.forEach(function(l) {
    Logger.log('BORRADA línea duplicada: pedido ' + l.idPedido + ' fila ' + l._fila + ' ref=' + l.ref + ' dir=' + l.dir + ' ctd=' + l.ctd);
    sheetLineas.deleteRow(l._fila);
  });

  // Recalcular nLin/nUbic de cada pedido afectado a partir de sus líneas
  // reales YA CORREGIDAS (releer LINEAS fresco, no fiarse de lo calculado
  // antes de borrar -- los números de fila ya cambiaron).
  var lineasFrescas = leerHoja('LINEAS');
  aActualizarPedido.forEach(function(entry) {
    var p = entry.pedido;
    var lineasReales = lineasFrescas.filter(function(l) { return l.idPedido === p.id; });
    var dirsUnicas = {};
    lineasReales.forEach(function(l) { dirsUnicas[l.dir] = true; });
    var cambiosLimpieza = { nLin: lineasReales.length, nUbic: Object.keys(dirsUnicas).length, actualizado: new Date().toISOString() };
    actualizarFila('PEDIDOS', p._fila, cambiosLimpieza);
    sincronizarPedidoSupabase_(p, cambiosLimpieza);
    logActividad('LIMPIAR_LINEAS_DUPLICADAS', 'Pedido ' + p.ped + ' (' + p.id + '): nLin ' + p.nLin + ' → ' + cambiosLimpieza.nLin +
      ' tras borrar ' + entry.filasABorrarIds.length + ' línea(s) duplicada(s)', 'admin');
    Logger.log('Pedido ' + p.id + ' actualizado: nLin ' + p.nLin + ' → ' + cambiosLimpieza.nLin + ', nUbic ' + p.nUbic + ' → ' + cambiosLimpieza.nUbic);
  });

  marcarResumenObsoleto();
  Logger.log('LISTO: ' + aBorrar.length + ' línea(s) duplicada(s) borrada(s) en ' + aActualizarPedido.length + ' pedido(s).');
  return 'OK: ' + aBorrar.length + ' líneas borradas en ' + aActualizarPedido.length + ' pedidos';
}

/**
 * DIAGNÓSTICO (solo lectura, 2026-08-03): el usuario reportó dos síntomas
 * reales en la pantalla del operario -- (1) pedidos duplicados en la lista
 * de "por preparar" (captura real: nº 286006 aparecía DOS veces seguidas en
 * Málaga, mismo estado/tienda) y (2) pedidos que se cierran y, al refrescar
 * pantalla, vuelven a salir como pendientes. Esta función ataca el síntoma
 * 1: `id` (codigoTienda+nº) es la clave única de TODA la app -- si aparece
 * duplicada en PEDIDOS es, por definición, un bug. Por cada grupo duplicado
 * saca el timeline completo (HIST_TRANSP + LOG_ACTIVIDAD) de las dos filas.
 * Hipótesis a confirmar/descartar con esto: `importarClasificacion`
 * (ImportarClasificacion.gs) NO tiene candado LockService, a diferencia de
 * `resincronizarPedidosActivos` (que sí lo tiene y documenta explícitamente
 * el motivo: dos ejecuciones a la vez podrían leer PEDIDOS antes de que
 * ninguna termine de escribir y crear la misma fila duplicada). Si las dos
 * filas duplicadas tienen `actualizado` a segundos de diferencia, es la
 * huella de esa misma condición de carrera en `importarClasificacion` (p.ej.
 * doble clic, o reintento tras un timeout percibido, en "Importar al
 * sistema" / "Importación directa").
 */
function auditarPedidosDuplicadosPorId() {
  var pedidos = leerHoja('PEDIDOS');
  var porId = {};
  pedidos.forEach(function(p) {
    if (!porId[p.id]) porId[p.id] = [];
    porId[p.id].push(p);
  });
  var grupos = Object.keys(porId).filter(function(id) { return porId[id].length > 1; });
  Logger.log('Total filas PEDIDOS: ' + pedidos.length + ' · ids duplicados: ' + grupos.length);
  if (!grupos.length) { Logger.log('OK -- ninguna fila de PEDIDOS comparte id con otra.'); return 'sin duplicados'; }

  var hist = leerHoja('HIST_TRANSP');
  var log = leerHoja('LOG');

  grupos.forEach(function(id) {
    Logger.log('=== DUPLICADO ' + id + ' (' + porId[id].length + ' filas) ===');
    porId[id].forEach(function(p) {
      Logger.log('  fila ' + p._fila + ': estado=' + p.estado + ' silueta=' + (p.silueta || '(vacío)') +
        ' posIni=' + p.posIni + ' nLin=' + p.nLin + ' nUbic=' + p.nUbic + ' operario=' + p.operario +
        ' actualizado=' + p.actualizado + ' enRevision=' + p.enRevision + ' parcial=' + p.parcial);
    });
    var histPed = hist.filter(function(h) { return h.idPedido === id; })
      .sort(function(a, b) { return String(a.fecha).localeCompare(String(b.fecha)); });
    Logger.log('  HISTORIAL_TRANSPORTISTA (' + histPed.length + ' eventos):');
    histPed.forEach(function(h) { Logger.log('    ' + h.fecha + ' · ' + h.evento + ' · ' + h.transportista + '/' + h.flujo); });
    var num = porId[id][0].ped;
    var logPed = log.filter(function(l) { return String(l.detalle).indexOf(String(num)) !== -1; })
      .sort(function(a, b) { return String(a.ts).localeCompare(String(b.ts)); });
    Logger.log('  LOG_ACTIVIDAD relacionado (' + logPed.length + '):');
    logPed.forEach(function(l) { Logger.log('    ' + l.ts + ' · ' + l.tipo + ' · ' + l.detalle); });
  });
  return grupos.length + ' id(s) duplicados -- ver log';
}

/**
 * DIAGNÓSTICO (solo lectura, 2026-08-03): ataca el síntoma 2 del mismo
 * reporte -- pedidos que un operario cierra y que, al refrescar, vuelven a
 * salir como pendientes. Busca pedidos HOY activos (estado no terminal, SIN
 * silueta -- por tanto visibles de nuevo en "por preparar") que YA tienen al
 * menos un evento CIERRE_PEDIDO o CIERRE_SIN_SILUETA anotado en el LOG: si
 * hay uno, alguien ya lo cerró antes y sin embargo ha vuelto. Para cada caso
 * saca también sus LINEAS (dir/ref/estado/ts) -- hipótesis a confirmar:
 * `renovarDireccionesPedidoExistente` (ImportarClasificacion.gs:300, llamada
 * tanto al reimportar como por el auto-resync cada 15 min) resetea a
 * PENDIENTE una línea YA preparada si Pyxis le cambia la dirección (pensado
 * para un artículo que pasa de tránsito/Muelle a su ubicación final) -- si
 * el pedido ya estaba completo pero SIN silueta aún (el operario lo terminó
 * pero no había llegado a asignarle hueco), esto lo revierte entero a
 * pendiente sin que nadie lo haya tocado.
 * OJO: el nº de pedido NO es único entre tiendas, así que un cruce por `ped`
 * contra el LOG (que no guarda tienda) puede dar algún falso positivo si
 * otra tienda cerró un pedido con el mismo número -- se imprime tienda y
 * fecha para poder descartarlo a ojo.
 */
function auditarPedidosReabiertosTrasCierre() {
  var pedidos = leerHoja('PEDIDOS');
  var activos = pedidos.filter(function(p) { return !ESTADOS_TERMINALES[p.estado] && !p.silueta; });
  var log = leerHoja('LOG').filter(function(l) { return l.tipo === 'CIERRE_PEDIDO' || l.tipo === 'CIERRE_SIN_SILUETA'; });

  var cierresPorNum = {};
  log.forEach(function(l) {
    var m = /^Pedido (\S+)/.exec(String(l.detalle || ''));
    if (!m) return;
    if (!cierresPorNum[m[1]]) cierresPorNum[m[1]] = [];
    cierresPorNum[m[1]].push(l);
  });

  var reabiertos = activos.filter(function(p) { return cierresPorNum[String(p.ped)]; });
  Logger.log('Pedidos activos (no terminal, sin silueta): ' + activos.length + ' · con cierre PREVIO en el log: ' + reabiertos.length);
  if (!reabiertos.length) { Logger.log('OK -- ningún pedido activo ahora mismo tiene un cierre previo registrado.'); return 'sin casos'; }

  var lineas = leerHoja('LINEAS');
  reabiertos.forEach(function(p) {
    Logger.log('=== REABIERTO: ' + p.id + ' (ped ' + p.ped + ', ' + p.tienda + ') estado=' + p.estado +
      ' nLin=' + p.nLin + ' nUbic=' + p.nUbic + ' actualizado=' + p.actualizado + ' ===');
    cierresPorNum[String(p.ped)].forEach(function(l) { Logger.log('  cierre previo: ' + l.ts + ' · ' + l.tipo + ' · ' + l.detalle); });
    var lineasPed = lineas.filter(function(l) { return l.idPedido === p.id; }).sort(function(a, b) { return Number(a.idx) - Number(b.idx); });
    lineasPed.forEach(function(l) {
      Logger.log('  línea idx=' + l.idx + ' ref=' + l.ref + ' dir=' + l.dir + ' estado=' + l.estado + ' ts=' + (l.ts || '(vacío)') + ' tipoUbic=' + l.tipoUbic);
    });
  });
  return reabiertos.length + ' reabierto(s) -- ver log';
}

/**
 * PRUEBA (segura, no toca datos reales): llama a importarClasificacion con
 * un lote vacío para comprobar que el candado LockService nuevo (2026-08-03)
 * se adquiere y se libera sin lanzar excepción, y que el diferido de la
 * sincronización a Supabase (pendientesSyncSupabase, vacío aquí porque no se
 * crea ningún pedido) no rompe nada. No crea ni modifica ninguna fila.
 */
function test_importarClasificacionCandado() {
  var vacio = { Transporte: [], Instalaciones: [], PRO: [], Remansur: [] };
  var r = importarClasificacion(vacio, {});
  Logger.log('Resultado: ' + JSON.stringify(r));
  _assert(r.ok === true, 'debe devolver ok=true con un lote vacío');
  _assert(r.creados.length === 0, 'lote vacío -> 0 creados');
  _assert(r.omitidos.length === 0, 'lote vacío -> 0 omitidos');
  _assert(r.noEncontrados.length === 0, 'lote vacío -> 0 no encontrados');
  return 'OK -- candado adquirido/liberado sin error, nada tocado';
}

/**
 * PRUEBA (segura, no toca datos reales): llama a cerrarPedido con un idPedido
 * que no existe, para comprobar que el candado nuevo (2026-08-03) se
 * adquiere y se libera sin excepción incluso en el camino de salida
 * temprana ("Pedido no encontrado", antes de llegar a ninguna escritura).
 * No crea ni modifica ninguna fila real.
 */
function test_cerrarPedidoCandado() {
  var r = cerrarPedido('000::NOEXISTE_TEST', 'A', 1, [], 'test');
  Logger.log('Resultado: ' + JSON.stringify(r));
  _assert(r.ok === false, 'un idPedido inexistente debe devolver ok=false');
  _assert(r.error === 'Pedido no encontrado', 'mensaje de error esperado');
  return 'OK -- candado adquirido/liberado sin error en salida temprana';
}

/**
 * PRUEBA CRÍTICA (solo lectura de comportamiento del runtime, no toca
 * datos): verifica si LockService.getScriptLock().tryLock() se comporta de
 * forma reentrante DENTRO de la MISMA ejecución -- es decir, si una función
 * que YA tiene el candado (p.ej. cerrarPedido, tras el fix del 2026-08-03)
 * llama a otra que ADEMÁS pide su PROPIO candado (p.ej.
 * intentarCompartirFrenteRemansur), ¿la segunda adquisición es instantánea
 * (misma ejecución = mismo dueño) o se queda esperando el tryLock(N) entero
 * antes de rendirse? Si fuera lo segundo, cada cierre de un pedido Remansur
 * que comparte delante tardaría ~10s de más POR CULPA del candado nuevo --
 * una regresión grave de rendimiento en el camino más usado de la app.
 * Un comentario antiguo en purgarPedidosAntiguos() documentaba que una
 * versión anterior evitó ESTE mismo anidamiento a propósito por esta duda
 * -- esta prueba responde la duda con datos reales del runtime en vez de
 * asumir.
 */
function test_reentradaCandadoScriptLock() {
  var t0 = new Date().getTime();
  var lockA = LockService.getScriptLock();
  var okA = lockA.tryLock(5000);
  var t1 = new Date().getTime();
  Logger.log('1ª adquisición: ok=' + okA + ' · tardó ' + (t1 - t0) + ' ms');

  var lockB = LockService.getScriptLock();
  var okB = lockB.tryLock(5000);
  var t2 = new Date().getTime();
  Logger.log('2ª adquisición (misma ejecución, candado YA en manos propias): ok=' + okB + ' · tardó ' + (t2 - t1) + ' ms');

  if (okB) { try { lockB.releaseLock(); } catch (e) {} }
  if (okA) { try { lockA.releaseLock(); } catch (e) {} }

  var ms = t2 - t1;
  Logger.log(ms < 500
    ? '=> REENTRANTE / instantáneo: anidar candados en la misma ejecución es SEGURO y rápido.'
    : '=> BLOQUEANTE: la 2ª adquisición esperó ~' + ms + ' ms -- anidar candados SÍ introduce una espera real, hay que quitar los candados internos redundantes de las funciones ahora anidadas.');
  return { ok1: okA, ms1: (t1 - t0), ok2: okB, ms2: ms };
}

/**
 * REPARACIÓN PUNTUAL (2026-08-03, autorizada por el usuario -- "Borrar las
 * fantasma y liberar hueco") -- limpia los 6 pedidos duplicados encontrados
 * por auditarPedidosDuplicadosPorId (causa raíz: importarClasificacion sin
 * candado LockService, ver v193 en memoria). Para cada id, RE-VERIFICA en
 * vivo cuántas filas tiene AHORA MISMO (nunca confía ciegamente en la lista
 * fija de abajo -- misma lección del incidente de compactar-siluetas) y
 * decide cuál es la "fantasma" a borrar:
 *   - si una copia tiene silueta y la otra no -> se borra la SIN silueta
 *     (nadie trabajó esa copia; la real ya está colocada de verdad).
 *   - si NINGUNA tiene silueta (286006: dos copias idénticas sin tocar) ->
 *     se borra la creada MÁS TARDE (por `actualizado`), se queda la primera
 *     -- exactamente la fila que cerrarPedido/marcarDireccion ya resuelven
 *     siempre por `.find()`.
 *   - si LAS DOS tienen silueta -> caso ambiguo no anticipado por el
 *     diagnóstico -- se omite avisando, no se borra nada a ciegas.
 * IMPORTANTE -- a propósito NO se tocan LINEAS: las líneas de las dos copias
 * comparten el mismo idPedido (no hay forma fiable de distinguir a qué
 * generación pertenece cada una -- ambas comparten hasta el mismo id de
 * línea, p.ej. "036::283278::L0"), así que borrar por idPedido borraría
 * TAMBIÉN las líneas de la copia que se queda. Se acepta como deuda
 * cosmética menor (líneas repetidas si algún día se listan en detalle)
 * antes que arriesgar el histórico real de un pedido ya trabajado.
 * Tampoco se llama a eliminarPedidoSupabase_(id): el id sigue vivo en la
 * copia que se queda, así que borrar en Supabase por id borraría TAMBIÉN su
 * registro. En su lugar, se vuelve a sincronizar la copia que se queda (por
 * si la fantasma escribió encima la última vez, antes de este fix).
 */
var PEDIDOS_DUPLICADOS_IMPORTACION_20260803 = ['036::283278', '036::283683', '036::284948', '036::285396', '036::286006', '036::275813'];

function limpiarPedidosDuplicadosImportacion_20260803() {
  var pedidos = leerHoja('PEDIDOS');
  var porId = {};
  pedidos.forEach(function(p) { (porId[p.id] = porId[p.id] || []).push(p); });

  var aBorrar = [], aResincronizar = [], omitidos = [];

  PEDIDOS_DUPLICADOS_IMPORTACION_20260803.forEach(function(id) {
    var grupo = porId[id] || [];
    if (grupo.length !== 2) {
      omitidos.push(id + ' -> tiene ' + grupo.length + ' fila(s) ahora mismo (se esperaban 2) -- no se toca, revisar a mano');
      return;
    }
    var conSilueta = grupo.filter(function(p) { return !!p.silueta; });
    var sinSilueta = grupo.filter(function(p) { return !p.silueta; });
    var real, fantasma;
    if (conSilueta.length === 1 && sinSilueta.length === 1) {
      real = conSilueta[0]; fantasma = sinSilueta[0];
    } else if (conSilueta.length === 0) {
      var ordenadas = grupo.slice().sort(function(a, b) { return String(a.actualizado).localeCompare(String(b.actualizado)); });
      real = ordenadas[0]; fantasma = ordenadas[1];
    } else {
      omitidos.push(id + ' -> las dos filas tienen silueta asignada, caso ambiguo -- no se toca');
      return;
    }
    aBorrar.push(fantasma);
    aResincronizar.push(real);
  });

  omitidos.forEach(function(m) { Logger.log('OMITIDO ** ' + m); });
  Logger.log('A borrar: ' + aBorrar.length + ' · omitidos: ' + omitidos.length);
  if (!aBorrar.length) return 'Nada que borrar';

  var sheetPedidos = getHoja('PEDIDOS');
  aBorrar.sort(function(a, b) { return b._fila - a._fila; }); // de abajo a arriba: borrar de arriba desplazaría las siguientes
  aBorrar.forEach(function(p) {
    sheetPedidos.deleteRow(p._fila);
    Logger.log('BORRADO: ' + p.id + ' (ped ' + p.ped + ') fila ' + p._fila + ' -- copia duplicada PENDIENTE sin silueta');
    logActividad('BORRAR_PEDIDO_DUPLICADO', 'Pedido ' + p.ped + ' (' + p.id + ') fila ' + p._fila +
      ' borrado: copia duplicada de importarClasificacion sin candado (bug corregido en v193)', 'admin');
  });

  // Re-sincronizar a Supabase la copia que SÍ se queda (por si la fantasma
  // escribió encima la última vez, con datos viejos/incompletos, antes de
  // este fix -- el upsert por id no distingue qué copia "gana").
  aResincronizar.forEach(function(p) {
    try { sincronizarPedidoSupabase_(p, {}); } catch (e) { logActividad('ERROR_SYNC_SUPABASE', 'Resync tras limpieza duplicados: ' + p.id + ' -> ' + e, 'admin'); }
  });

  marcarResumenObsoleto();
  Logger.log('LISTO: ' + aBorrar.length + ' fila(s) duplicada(s) borrada(s), ' + aResincronizar.length + ' resincronizada(s) a Supabase, ' + omitidos.length + ' omitida(s).');
  return 'OK: ' + aBorrar.length + ' borradas, ' + omitidos.length + ' omitidas';
}

/**
 * REPARACIÓN PUNTUAL (2026-07-31) -- BORRA filas de PEDIDOS. Autorizada
 * expresamente por el usuario tras el diagnóstico de pedidos fantasma
 * (altas manuales hechas con la tienda equivocada: ver la guarda añadida en
 * registrarPedidoManual, v190). Elimina SOLO estas 3 filas concretas y
 * libera sus huecos de silueta para que se puedan reutilizar.
 *
 * SEGURIDAD (lección del incidente de compactar-siluetas, donde una errata
 * mía en la lista de reparación hizo que se saltara un pedido en silencio y
 * acabó duplicándolo): antes de borrar nada se RE-VERIFICA cada fila contra
 * el inventario real. Si alguna resulta NO ser fantasma (su tienda sí
 * coincide con el inventario) o no se encuentra, se OMITE y se avisa a
 * gritos en el log -- nunca se borra "a ciegas" por estar en esta lista.
 */
var FANTASMAS_CONFIRMADOS_20260731 = ['036::967353', '036::965229', '036::284960'];

function borrarPedidosFantasmaConfirmados() {
  var inv;
  try { inv = cargarInventario(); }
  catch (e) { Logger.log('ABORTADO: no se pudo cargar el inventario (' + e + ') -- sin él no se puede verificar nada.'); return 'ABORTADO'; }

  var pedidos = leerHoja('PEDIDOS');
  var aBorrar = [], omitidos = [];

  FANTASMAS_CONFIRMADOS_20260731.forEach(function(id) {
    var p = pedidos.find(function(x) { return x.id === id; });
    if (!p) { omitidos.push(id + ' -> NO ENCONTRADO en PEDIDOS'); return; }
    var entry = inv.indice[String(p.ped).trim()];
    if (!entry) { omitidos.push(id + ' -> el pedido NO está en ningún inventario; no puedo confirmar que sea fantasma'); return; }
    var tiendasInv = Object.keys(entry.porTienda);
    if (tiendasInv.indexOf(String(p.tienda)) !== -1) {
      omitidos.push(id + ' -> NO es fantasma: su tienda (' + p.tienda + ') SÍ está en el inventario (' + tiendasInv.join('/') + ')');
      return;
    }
    aBorrar.push(p);
  });

  omitidos.forEach(function(m) { Logger.log('OMITIDO ** ' + m); });
  Logger.log('Verificadas ' + FANTASMAS_CONFIRMADOS_20260731.length + ' -> se borrarán ' + aBorrar.length + ', omitidas ' + omitidos.length);
  if (!aBorrar.length) { _verificarSinFantasmasActivos(); return 'Nada que borrar'; }

  // 1) Liberar el hueco de silueta de cada uno (OCUPACION + Supabase). El
  //    filtro de liberarPosiciones es silueta+rango de posiciones+nº pedido,
  //    así que no puede tocar la fila BUENA del mismo número (que está en
  //    otra posición o sin silueta).
  aBorrar.forEach(function(p) {
    if (p.silueta && p.posIni !== '' && p.posIni !== null && p.posIni !== undefined) {
      try { liberarPosiciones(p.silueta, Number(p.posIni), Number(p.posFin), p.ped); }
      catch (e) { Logger.log('Aviso: no se pudo liberar ' + p.silueta + p.posIni + ' de ' + p.id + ': ' + e); }
    }
    if (p.numeroCarga) { try { _quitarPedidoDeSuCargaActiva(p.numeroCarga, p.ped); } catch (e) {} }
  });

  // 2) Borrar sus LINEAS (estas altas manuales suelen tener 0, pero por si acaso).
  var sheetLineas = getHoja('LINEAS');
  var idsBorrar = {};
  aBorrar.forEach(function(p) { idsBorrar[p.id] = true; });
  var lineas = leerHoja('LINEAS').filter(function(l) { return idsBorrar[l.idPedido]; });
  lineas.sort(function(a, b) { return b._fila - a._fila; }); // de abajo a arriba
  lineas.forEach(function(l) { sheetLineas.deleteRow(l._fila); });

  // 3) Borrar las filas de PEDIDOS, SIEMPRE de abajo a arriba: borrar de
  //    arriba a abajo desplazaría las filas siguientes y se borraría la que
  //    no toca.
  var sheetPedidos = getHoja('PEDIDOS');
  aBorrar.sort(function(a, b) { return b._fila - a._fila; });
  aBorrar.forEach(function(p) {
    sheetPedidos.deleteRow(p._fila);
    eliminarPedidoSupabase_(p.id);
    Logger.log('BORRADO: ' + p.id + ' (ped ' + p.ped + ', decía tienda "' + p.tienda + '") · hueco liberado: ' + p.silueta + p.posIni);
    logActividad('BORRAR_PEDIDO_FANTASMA', 'Pedido ' + p.ped + ' (' + p.id + ') borrado: la ficha decía ' + p.tienda +
      ' pero el inventario dice otra tienda · hueco ' + p.silueta + p.posIni + ' liberado', 'admin');
  });

  marcarResumenObsoleto();
  Logger.log('LISTO: ' + aBorrar.length + ' fantasma(s) borrados, ' + lineas.length + ' líneas, huecos liberados.');
  _verificarSinFantasmasActivos();
  return 'OK: ' + aBorrar.length + ' borrados, ' + omitidos.length + ' omitidos';
}

/**
 * Comprobación posterior: relee PEDIDOS y lista los fantasma que TODAVÍA
 * ocupan hueco. Solo cuentan los que tienen silueta: los ENTREGADO sin hueco
 * que saca auditarPedidosFantasma son en su mayoría falsos positivos por
 * reutilización de números entre tiendas con el tiempo, y además no aparecen
 * en ninguna lista. Solo lectura, seguro llamarla suelta.
 */
function _verificarSinFantasmasActivos() {
  var inv;
  try { inv = cargarInventario(); } catch (e) { Logger.log('VERIFICACIÓN: no se pudo cargar el inventario.'); return; }
  var activos = leerHoja('PEDIDOS').filter(function(p) {
    if (!p.silueta || !p.tienda) return false;
    var entry = inv.indice[String(p.ped).trim()];
    if (!entry) return false;
    var t = Object.keys(entry.porTienda);
    return t.length && t.indexOf(String(p.tienda)) === -1;
  });
  Logger.log('VERIFICACIÓN -> fantasma que AÚN ocupan hueco: ' + activos.length);
  activos.forEach(function(p) {
    Logger.log('   PENDIENTE: ' + p.id + ' ped=' + p.ped + ' dice "' + p.tienda + '" en ' + p.silueta + p.posIni);
  });
  if (!activos.length) Logger.log('   OK -- ninguna silueta tiene ya un pedido de otra tienda mal etiquetado.');
}

/**
 * MIGRACIÓN PUNTUAL (una sola vez): añade la cabecera 'parcial' en la hoja
 * PEDIDOS real, en la posición que le corresponde según COLUMNAS.PEDIDOS
 * (el código accede a las columnas por POSICIÓN según ese array, no por el
 * texto de la cabecera -- de hecho, al comprobar la hoja real, las 5
 * columnas anteriores (intentoCarga, comentario, tipoEntrega, enRevision,
 * sdImpreso) NUNCA tuvieron texto de cabecera puesto, así que buscar por
 * nombre de cabecera no sirve aquí). No toca ninguna fila de datos
 * existente: en blanco se lee como "no parcial", correcto para todo pedido
 * ya existente. Comprueba que la celda destino esté vacía antes de escribir
 * (salvo que ya diga "parcial", caso en que no hace nada -- idempotente).
 */
function migrarColumnaParcialPedidos() {
  var sheet = getHoja('PEDIDOS');
  var colIdx = COLUMNAS.PEDIDOS.indexOf('parcial') + 1; // 1-based
  if (colIdx < 1) throw new Error('"parcial" no está en COLUMNAS.PEDIDOS -- nada que migrar.');
  var actual = sheet.getRange(1, colIdx).getValue();
  if (actual === 'parcial') {
    Logger.log('Ya existe la cabecera "parcial" en la columna ' + colIdx + ' -- nada que hacer.');
    return 'OK (ya existía)';
  }
  if (actual !== '' && actual !== null && actual !== undefined) {
    throw new Error('La columna ' + colIdx + ' de PEDIDOS (donde debería ir "parcial") ya tiene contenido: "' + actual + '" -- revisa antes de continuar, no se ha escrito nada.');
  }
  sheet.getRange(1, colIdx).setValue('parcial');
  Logger.log('✓ Cabecera "parcial" añadida en la columna ' + colIdx + ' de PEDIDOS.');
  return 'OK';
}

/**
 * PRUEBA (solo lectura): busca en el inventario real un pedido que exista en
 * más de una tienda a la vez, y comprueba que obtenerPedido() ahora exige
 * elegir tienda (dirs vacío) en vez de devolver las direcciones de una al
 * azar como antes.
 */
function test_obtenerPedidoConColision() {
  var inv = cargarInventario();
  var ejemplo = null;
  for (var k in inv.indice) {
    var tiendas = Object.keys(inv.indice[k].porTienda);
    if (tiendas.length > 1) { ejemplo = { ped: k, tiendas: tiendas }; break; }
  }
  if (!ejemplo) { Logger.log('No se encontró ningún pedido en varias tiendas en el inventario actual -- nada que probar ahora mismo.'); return 'sin ejemplo'; }
  Logger.log('Ejemplo encontrado: ' + ejemplo.ped + ' en ' + ejemplo.tiendas.join(', '));

  var sinTienda = obtenerPedido(ejemplo.ped);
  Logger.log('Sin tienda elegida -> tiendas=' + sinTienda.tiendas.join(',') + ' tienda=' + sinTienda.tienda + ' dirs=' + sinTienda.dirs.length);
  _assert(sinTienda.tiendas.length > 1, 'debe reportar más de una tienda');
  _assert(sinTienda.tienda === null, 'sin tienda elegida, tienda debe ser null (antes se asumía la primera)');
  _assert(sinTienda.dirs.length === 0, 'sin tienda elegida, no debe dar direcciones de ninguna');

  var tiendaElegida = ejemplo.tiendas[ejemplo.tiendas.length - 1]; // la última, para no coincidir con el viejo tiendas[0] por casualidad
  var conTienda = obtenerPedido(ejemplo.ped, tiendaElegida);
  Logger.log('Con tienda "' + tiendaElegida + '" -> tienda=' + conTienda.tienda + ' dirs=' + conTienda.dirs.length);
  _assert(conTienda.tienda === tiendaElegida, 'debe devolver la tienda pedida, no otra');
  _assert(conTienda.dirs.length > 0, 'con tienda elegida sí debe dar direcciones');
  return 'OK';
}

function _assert(cond, msg) {
  if (!cond) { Logger.log('FAIL: ' + msg); throw new Error('FAIL: ' + msg); }
  Logger.log('PASS: ' + msg);
}

/**
 * DIAGNÓSTICO (solo lectura, no toca nada): para cada pedido que PEDIDOS dice
 * que está en una silueta (silueta no vacía, posIni>0, estado no terminal),
 * comprueba si existe de verdad una fila en OCUPACION_SILUETAS que lo
 * confirme en esa silueta+posición. Si no la hay, lo reporta junto con dónde
 * dice OCUPACION que está REALMENTE ese pedido (si está en algún otro sitio).
 * Motivo: la pantalla de siluetas (mapa físico) pinta desde OCUPACION; la
 * lista "Resto en silueta, sin cargar aún" pinta desde PEDIDOS.silueta/
 * posIni -- si ambas fuentes se desincronizan, cada pantalla cuenta una
 * historia distinta sin que nada lo avise.
 */
function diagnosticarDriftPedidosOcupacion() {
  var pedidos = leerHoja('PEDIDOS');
  var ocup = leerHoja('OCUPACION');
  var enSilueta = pedidos.filter(function(p) { return p.silueta && Number(p.posIni) > 0 && !ESTADOS_TERMINALES[p.estado]; });

  var faltantes = [];
  enSilueta.forEach(function(p) {
    var posIni = Number(p.posIni), posFin = Number(p.posFin) || posIni;
    var encontrado = ocup.some(function(o) {
      return String(o.pedido) === String(p.ped) && o.silueta === p.silueta &&
        Number(o.pos) >= posIni && Number(o.pos) <= posFin;
    });
    if (!encontrado) faltantes.push(p);
  });

  Logger.log('Pedidos con silueta+posición asignada en PEDIDOS (no bulto, no terminal): ' + enSilueta.length);
  Logger.log('De ellos, SIN ninguna fila real en OCUPACION que lo confirme ahí: ' + faltantes.length);
  faltantes.forEach(function(p) {
    var real = ocup.filter(function(o) { return String(o.pedido) === String(p.ped); });
    var realTxt = real.length
      ? real.map(function(o) { return o.silueta + o.pos + '(' + o.layer + (o.reservado === true || o.reservado === 'true' ? ',reservado' : '') + ')'; }).join(' / ')
      : 'NINGUNA fila en OCUPACION (no aparece en ningún sitio del mapa físico)';
    Logger.log('PED ' + p.ped + ' (' + p.tienda + '/' + p.transportista + '): PEDIDOS dice ' +
      p.silueta + p.posIni + (p.posIni !== p.posFin ? '-' + p.posFin : '') +
      ' [numeroCarga=' + (p.numeroCarga || '-') + ', actualizado=' + p.actualizado + '] · OCUPACION real: ' + realTxt);
  });
  return { totalEnSilueta: enSilueta.length, drift: faltantes.length };
}

/**
 * REPARACIÓN PUNTUAL (una sola vez): la ejecución de aplicarCompactarSiluetas
 * del 30/07/2026 10:34 (ver Ejecuciones -- "No se pueden eliminar todas las
 * filas que no estén inmovilizadas", lanzada desde liberarPosicionesLote)
 * dejó 11 pedidos con PEDIDOS.silueta/posIni apuntando a la posición NUEVA
 * "compactada" que la función pretendía darles, sin que OCUPACION_SILUETAS
 * (el mapa físico real, fuente de verdad de la Pantalla) se moviera de
 * verdad -- diagnosticado con diagnosticarDriftPedidosOcupacion().  Esta
 * función deshace SOLO esa escritura a medias: reescribe silueta/posIni/
 * posFin de esos 11 pedidos para que vuelvan a coincidir con OCUPACION.
 * Antes de tocar cada uno comprueba que siga exactamente como se
 * diagnosticó -- si algo cambió mientras tanto (p.ej. ya se entregó), lo
 * omite y lo reporta en vez de sobrescribir a ciegas.
 */
function repararDriftCompactadoFallido() {
  var CORRECCIONES = [
    { ped: '973821', siluetaMala: 'A', posIniMala: 1,  siluetaReal: 'A', posIniReal: 15, posFinReal: 15 },
    { ped: '264553', siluetaMala: 'A', posIniMala: 2,  siluetaReal: 'B', posIniReal: 2,  posFinReal: 2 },
    { ped: '973450', siluetaMala: 'A', posIniMala: 3,  siluetaReal: 'B', posIniReal: 5,  posFinReal: 5 },
    { ped: '270171', siluetaMala: 'A', posIniMala: 4,  siluetaReal: 'C', posIniReal: 1,  posFinReal: 1 },
    { ped: '253964', siluetaMala: 'A', posIniMala: 5,  siluetaReal: 'C', posIniReal: 2,  posFinReal: 2 },
    { ped: '253982', siluetaMala: 'A', posIniMala: 6,  siluetaReal: 'C', posIniReal: 3,  posFinReal: 4 },
    { ped: '287120', siluetaMala: 'A', posIniMala: 8,  siluetaReal: 'C', posIniReal: 5,  posFinReal: 5 },
    { ped: '96657',  siluetaMala: 'A', posIniMala: 9,  siluetaReal: 'C', posIniReal: 6,  posFinReal: 6 },
    { ped: '961071', siluetaMala: 'A', posIniMala: 10, siluetaReal: 'C', posIniReal: 7,  posFinReal: 7 },
    { ped: '281946', siluetaMala: 'A', posIniMala: 11, siluetaReal: 'C', posIniReal: 8,  posFinReal: 8 },
    { ped: '966576', siluetaMala: 'A', posIniMala: 12, siluetaReal: 'C', posIniReal: 9,  posFinReal: 9 }
  ];

  var pedidos = leerHoja('PEDIDOS');
  var porPed = {};
  pedidos.forEach(function(p) { porPed[String(p.ped)] = p; });

  var reparados = [], omitidos = [];
  CORRECCIONES.forEach(function(c) {
    var p = porPed[c.ped];
    if (!p) { omitidos.push(c.ped + ' (ya no existe en PEDIDOS)'); return; }
    if (String(p.silueta) !== c.siluetaMala || Number(p.posIni) !== c.posIniMala) {
      omitidos.push(c.ped + ' (ya no coincide con lo diagnosticado: ahora dice ' + p.silueta + p.posIni + ' -- revisar a mano, no se ha tocado)');
      return;
    }
    var cambios = {
      silueta: c.siluetaReal, posIni: c.posIniReal, posFin: c.posFinReal,
      actualizado: new Date().toISOString()
    };
    actualizarFila('PEDIDOS', p._fila, cambios);
    sincronizarPedidoSupabase_(p, cambios);
    reparados.push(c.ped + ': ' + c.siluetaMala + c.posIniMala + ' -> ' + c.siluetaReal + c.posIniReal + (c.posIniReal !== c.posFinReal ? '-' + c.posFinReal : ''));
  });

  logActividad('REPARAR_DRIFT_COMPACTADO', reparados.length + ' pedido(s) corregidos para que coincidan con OCUPACION real' + (omitidos.length ? ' · ' + omitidos.length + ' omitidos: ' + omitidos.join(' | ') : ''), 'admin');
  Logger.log('Reparados (' + reparados.length + '): ' + reparados.join(' / '));
  if (omitidos.length) Logger.log('Omitidos (' + omitidos.length + '): ' + omitidos.join(' / '));
  marcarResumenObsoleto();
  return { reparados: reparados.length, omitidos: omitidos.length, detalleReparados: reparados, detalleOmitidos: omitidos };
}

/**
 * DIAGNÓSTICO puntual (solo lectura): vuelca TODAS las filas crudas de
 * PEDIDOS y de OCUPACION para los números de pedido indicados -- incluye
 * la propia fila física (_fila) para poder distinguir si "duplicado" es
 * más de una fila en PEDIDOS (dos altas distintas para el mismo nº) o más
 * de una fila en OCUPACION para el mismo pedido en posiciones distintas
 * (huecos viejos nunca liberados).
 */
function volcarPedidoYOcupacion(numerosPed) {
  var pedidos = leerHoja('PEDIDOS');
  var ocup = leerHoja('OCUPACION');
  numerosPed.forEach(function(num) {
    Logger.log('===== PED ' + num + ' =====');
    var filasPedidos = pedidos.filter(function(p) { return String(p.ped) === String(num); });
    Logger.log('PEDIDOS: ' + filasPedidos.length + ' fila(s)');
    filasPedidos.forEach(function(p) {
      Logger.log('  _fila=' + p._fila + ' id=' + p.id + ' tienda=' + p.tienda + ' estado=' + p.estado +
        ' silueta=' + p.silueta + ' posIni=' + p.posIni + ' posFin=' + p.posFin +
        ' numeroCarga=' + p.numeroCarga + ' actualizado=' + p.actualizado);
    });
    var filasOcup = ocup.filter(function(o) { return String(o.pedido) === String(num); });
    Logger.log('OCUPACION: ' + filasOcup.length + ' fila(s)');
    filasOcup.forEach(function(o) {
      Logger.log('  silueta=' + o.silueta + ' pos=' + o.pos + ' layer=' + o.layer +
        ' reservado=' + o.reservado + ' tienda=' + o.tienda + ' flujo=' + o.flujo);
    });
  });
  return 'OK, mira el Registro de ejecución';
}

function test_volcarPedidoDuplicados() {
  return volcarPedidoYOcupacion(['253992', '253982', '283900']);
}

/**
 * REPARACIÓN PUNTUAL (una sola vez): limpia filas HUÉRFANAS de OCUPACION
 * para los pedidos indicados -- filas que quedaron de una posición VIEJA
 * que aplicarCompactarSiluetas debería haber liberado y no liberó (porque
 * PEDIDOS.silueta/posIni ya estaba mal ANTES de mover, ver
 * lm-malaga-bug-compactar-siluetas), dejando al pedido "duplicado": una
 * copia en su sitio real de siempre y otra en el destino nuevo. Se apoya
 * SIEMPRE en el PEDIDOS actual (ya correcto) para decidir qué conservar --
 * nunca toca PEDIDOS, solo borra en OCUPACION lo que sobra.
 */
function limpiarOcupacionDuplicadaPedidos(numerosPed) {
  var pedidos = leerHoja('PEDIDOS');
  var porPed = {};
  pedidos.forEach(function(p) { porPed[String(p.ped)] = p; });

  var rangosLiberar = [];
  var resumen = [];
  numerosPed.forEach(function(num) {
    var p = porPed[String(num)];
    if (!p) { resumen.push(num + ': no existe en PEDIDOS -- no se toca'); return; }
    if (!p.silueta || Number(p.posIni) <= 0) { resumen.push(num + ': sin posición real asignada ahora mismo -- no se toca'); return; }
    var posIniActual = Number(p.posIni), posFinActual = Number(p.posFin) || posIniActual;
    var ocup = leerHoja('OCUPACION').filter(function(o) { return String(o.pedido) === String(num); });
    var viejos = ocup.filter(function(o) { return !(o.silueta === p.silueta && Number(o.pos) >= posIniActual && Number(o.pos) <= posFinActual); });
    if (!viejos.length) { resumen.push(num + ': sin duplicado -- nada que limpiar'); return; }
    var porSilueta = {};
    viejos.forEach(function(o) {
      var k = o.silueta;
      if (!porSilueta[k]) porSilueta[k] = { min: Number(o.pos), max: Number(o.pos) };
      porSilueta[k].min = Math.min(porSilueta[k].min, Number(o.pos));
      porSilueta[k].max = Math.max(porSilueta[k].max, Number(o.pos));
    });
    Object.keys(porSilueta).forEach(function(sil) {
      rangosLiberar.push({ silueta: sil, posIni: porSilueta[sil].min, posFin: porSilueta[sil].max, pedido: num });
    });
    resumen.push(num + ': limpiado duplicado en ' + Object.keys(porSilueta).map(function(s) { return s + porSilueta[s].min + '-' + porSilueta[s].max; }).join(', ') + ' (se conserva ' + p.silueta + posIniActual + '-' + posFinActual + ')');
  });

  if (rangosLiberar.length) liberarPosicionesLote(rangosLiberar);
  logActividad('LIMPIAR_OCUPACION_DUPLICADA', resumen.join(' | '), 'admin');
  Logger.log(resumen.join('\n'));
  marcarResumenObsoleto();
  return resumen;
}

function test_limpiarOcupacionDuplicadaPedidos() {
  return limpiarOcupacionDuplicadaPedidos(['253992', '283900']);
}

/**
 * PRUEBA (no escribe nada): comprueba que generarScriptRobotInventariosBucle()
 * genera de verdad un script completo -- URL/token sustituidos, sin ningún
 * "__" de placeholder sin resolver, sin Read-Host (bloquearía el bucle
 * desatendido para siempre) y con el anti-suspensión presente.
 */
function test_enviarSugerencia() {
  var r = enviarSugerencia({ tipo: 'Sugerencia', autor: 'Prueba automática (borrar)', texto: 'Esto es una prueba real del botón de sugerencias -- ignora este correo.' });
  Logger.log(JSON.stringify(r));
  _assert(r.ok === true, 'debe devolver ok:true si el correo se envía bien: ' + JSON.stringify(r));
  return r;
}

function test_generarScriptRobotInventariosBucle() {
  var script = generarScriptRobotInventariosBucle();
  Logger.log('Longitud total: ' + script.length);
  Logger.log('Primeras 200 chars: ' + script.substring(0, 200));
  Logger.log('Últimas 400 chars: ' + script.substring(script.length - 400));
  _assert(script.indexOf('__WEBAPP_URL__') === -1, 'no debe quedar __WEBAPP_URL__ sin resolver');
  _assert(script.indexOf('__TOKEN__') === -1, 'no debe quedar __TOKEN__ sin resolver');
  _assert(script.indexOf('Read-Host') === -1, 'no debe haber ningún Read-Host (bloquearía el bucle para siempre)');
  _assert(script.indexOf('SetThreadExecutionState') > -1, 'debe tener el anti-suspensión');
  _assert(script.indexOf('while ($true)') > -1, 'debe tener el bucle infinito');
  _assert(script.indexOf('Exportar-InventarioTienda') > -1, 'debe conservar la función de exportación real');
  _assert(script.indexOf('Subir-Inventarios') > -1, 'debe conservar la función de subida real');
  return 'OK, longitud ' + script.length;
}

/**
 * PRUEBA AISLADA (no toca Sheets): confirma que renovarDireccionesPedidoExistente
 * respeta PEDIDOS.parcial y no añade/actualiza nada para un pedido marcado
 * así, usando los parámetros pedidosPre/lineasPre para pasarle datos falsos
 * en memoria en vez de leer la hoja real.
 */
function testRenovarDireccionesRespetaParcial() {
  var pedidoFalso = { id: 'TEST_PARCIAL_borrar', ped: '999993', tienda: 'Málaga', transportista: 'Correcaminos', silueta: '', parcial: true };
  var lineasExistentesFalsas = [
    { idPedido: 'TEST_PARCIAL_borrar', ref: 'REF1', dir: 'A-01', idx: 0 }
  ];
  var lineasNuevasFalsas = [
    { dir: 'A-01', ref: 'REF1', ean: '', des: 'Artículo 1', ctd: 1 },
    { dir: 'B-02', ref: 'REF2', ean: '', des: 'Artículo 2 (excluido a propósito)', ctd: 1 }
  ];
  var r = renovarDireccionesPedidoExistente('TEST_PARCIAL_borrar', lineasNuevasFalsas, 'Correcaminos', [pedidoFalso], lineasExistentesFalsas);
  _assert(r.esParcial === true, 'debe devolver esParcial:true');
  _assert(r.nuevas === 0, 'no debe añadir la dirección B-02 aunque venga en los datos nuevos (nuevas=' + r.nuevas + ')');
  _assert(r.actualizadas === 0, 'no debe tocar ninguna línea existente (actualizadas=' + r.actualizadas + ')');
  Logger.log('✓ Pedido parcial respetado: no se añadió/actualizó nada.');
}

/**
 * PRUEBA DE CONECTIVIDAD SALIENTE (no toca nada de la app, solo lee de fuera).
 * Comprueba si UrlFetchApp puede llamar a una API externa desde este entorno
 * de Adeo. El bloqueo que ya conocemos (ANYONE access disabled) es sobre quién
 * puede ENTRAR al Web App; esto comprueba si hay también restricción sobre las
 * llamadas SALIENTES, que es lo que necesitaríamos para hablar con una base de
 * datos externa (Firestore/Supabase) en vez de escribir en Sheets.
 * Ejecutar desde el editor y mirar el log.
 */
function testUrlFetchExterno() {
  var pruebas = [
    { nombre: 'httpbin.org (HTTPS genérico)', url: 'https://httpbin.org/get' },
    { nombre: 'jsonplaceholder (API REST típica)', url: 'https://jsonplaceholder.typicode.com/todos/1' },
    { nombre: 'firestore.googleapis.com (Firebase)', url: 'https://firestore.googleapis.com' },
    { nombre: 'supabase.co (dominio genérico Supabase)', url: 'https://supabase.co' }
  ];
  pruebas.forEach(function(p) {
    try {
      var resp = UrlFetchApp.fetch(p.url, { muteHttpExceptions: true, followRedirects: true });
      Logger.log('OK  · ' + p.nombre + ' → HTTP ' + resp.getResponseCode());
    } catch (e) {
      Logger.log('FAIL · ' + p.nombre + ' → ' + e.message);
    }
  });
  Logger.log('--- Fin de la prueba de conectividad saliente ---');
}

/**
 * PRUEBA DE CONEXIÓN REAL contra el proyecto Supabase de lm-malaga (creado
 * 2026-07-28, ver docs/superpowers/specs/2026-07-28-migracion-sheets-supabase-design.md).
 * Solo lee (GET a la raíz de PostgREST) — no escribe nada, no toca la app.
 * SUPABASE_URL / SUPABASE_SERVICE_KEY ya están guardadas en Propiedades del
 * script (Configuración del proyecto), no en este archivo.
 * Ejecutar desde el editor y mirar el log.
 */
function testConexionSupabase() {
  var p = PropertiesService.getScriptProperties();
  var url = p.getProperty('SUPABASE_URL');
  var key = p.getProperty('SUPABASE_SERVICE_KEY');
  if (!url || !key) { Logger.log('FALTAN SUPABASE_URL / SUPABASE_SERVICE_KEY en Propiedades del script'); return; }

  var resp = UrlFetchApp.fetch(url + '/rest/v1/', {
    method: 'get',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'User-Agent': 'GoogleAppsScript-lm_produccion' },
    muteHttpExceptions: true
  });
  Logger.log('HTTP ' + resp.getResponseCode());
  Logger.log(resp.getContentText().slice(0, 300));
}

/**
 * PRUEBA AISLADA de sincronizarPedidoSupabase_() (Fase 1 de la migración).
 * NO toca ningún pedido real — usa un objeto de pedido inventado con un id
 * de prueba reconocible ('TEST_SYNC_borrar'). Sirve para comprobar que la
 * función escribe correctamente en Supabase antes de conectarla de verdad a
 * cerrarPedido() en producción. Después de ejecutarla, hay que borrar la fila
 * de prueba a mano desde el SQL Editor de Supabase:
 *   delete from pedidos where id = 'TEST_SYNC_borrar';
 * Ejecutar desde el editor y mirar el log.
 */
function testSincronizarPedidoSupabase() {
  var pedidoFalso = {
    id: 'TEST_SYNC_borrar', ped: '999999', tienda: 'Málaga',
    transportista: 'Correcaminos', flujo: 'transporte', pct: 100,
    operario: 'Prueba', comentario: '', tipoEntrega: '', enRevision: false,
    sdImpreso: '', nLin: 3, nUbic: 2, intentoCarga: ''
  };
  var cambios = {
    estado: 'COMPLETADO_LISTO', silueta: 'A', posIni: 5, posFin: 5,
    soportes: [{ tipoId: 'palet_euro', tipo: 'Palet Euro', cant: 2 }],
    operario: 'Prueba', actualizado: new Date().toISOString()
  };
  sincronizarPedidoSupabase_(pedidoFalso, cambios);
  Logger.log('Hecho. Revisa en Supabase (SQL Editor): select * from pedidos where id = \'TEST_SYNC_borrar\';');
  Logger.log('Si algo falló, se habrá registrado en LOG_ACTIVIDAD como ERROR_SYNC_SUPABASE (revisar con leerHoja(\'LOG\')).');
}

/**
 * PRUEBA AISLADA de sincronizarVisaSupabase_() y eliminarVisaSupabase_()
 * (Fase 1). Usa un id de prueba reconocible ('TEST_SYNC_borrar_visa').
 * El propio test limpia el dato al final (no hace falta borrar a mano).
 */
function testSincronizarVisaSupabase() {
  var visaFalsa = {
    id: 'TEST_SYNC_borrar_visa', ped: '999994', tienda: 'Málaga', estado: 'PENDIENTE',
    numeroCarga: '', fechaAlta: new Date().toISOString(), fechaResuelta: '', motivoAlerta: ''
  };
  sincronizarVisaSupabase_(visaFalsa, {});
  Logger.log('1ª llamada (alta). Comprueba: select * from visas where id = \'TEST_SYNC_borrar_visa\';');
  sincronizarVisaSupabase_(visaFalsa, { estado: 'EN_CARGA', numeroCarga: 999993 });
  Logger.log('2ª llamada (solo cambios de estado/numeroCarga). Esperado: estado=EN_CARGA, numero_carga=999993, ped/tienda siguen igual.');
  Logger.log('--- Ahora borrando la visa de prueba ---');
  eliminarVisaSupabase_('TEST_SYNC_borrar_visa');
  Logger.log('Hecho. Comprueba que ya no aparece: select * from visas where id = \'TEST_SYNC_borrar_visa\'; (esperado: 0 filas).');
  Logger.log('Si algo falló, se habrá registrado en LOG_ACTIVIDAD como ERROR_SYNC_SUPABASE.');
}

/**
 * PRUEBA AISLADA de sincronizarCargaSupabase_() (Fase 1). Usa un id de carga
 * de prueba reconocible ('TEST_SYNC_borrar_carga'). Mismo patrón que
 * sincronizarPedidoSupabase_: se le pasa la fila ORIGINAL + los cambios, y
 * la función manda siempre la fila completa fusionada (nunca un payload
 * parcial, porque num_carga/fecha son NOT NULL en Supabase).
 * Tras ejecutarla, borrar a mano en Supabase:
 *   delete from cargas where id = 'TEST_SYNC_borrar_carga';
 */
function testSincronizarCargaSupabase() {
  var cargaFalsa = {
    id: 'TEST_SYNC_borrar_carga', numCarga: 999995, fecha: new Date().toISOString(),
    estado: 'GENERADA', responsable: 'Prueba'
  };
  sincronizarCargaSupabase_(cargaFalsa, {});
  Logger.log('1ª llamada hecha (fila completa). Comprueba: select * from cargas where id = \'TEST_SYNC_borrar_carga\';');
  sincronizarCargaSupabase_(cargaFalsa, { estado: 'CERRADA' });
  Logger.log('2ª llamada hecha (fila original + solo {estado} de cambio). Vuelve a comprobar la misma fila.');
  Logger.log('Esperado: estado=CERRADA, num_carga=999995, responsable=Prueba (todo correcto, sin violar NOT NULL).');
  Logger.log('Si algo falló, se habrá registrado en LOG_ACTIVIDAD como ERROR_SYNC_SUPABASE.');
}

/**
 * PRUEBA AISLADA de sincronizarCargaPedidoSupabase_() y
 * eliminarCargaPedidoSupabase_() (Fase 1). Usa ids de prueba reconocibles que
 * NO existen en pedidos/cargas -- confirma que las 2 FK ya quitadas no
 * bloquean. No hace falta limpieza: el propio test añade y borra la fila.
 */
function testCargaPedidoSupabase() {
  var cargaIdFalsa = 'TEST_SYNC_borrar_carga2', pedidoIdFalso = 'TEST_SYNC_borrar_pedido';
  sincronizarCargaPedidoSupabase_(cargaIdFalsa, pedidoIdFalso, 0);
  Logger.log('Insertado el enlace. Comprueba: select * from cargas_pedidos where carga_id = \'TEST_SYNC_borrar_carga2\';');
  Logger.log('--- Ahora borrando el enlace ---');
  eliminarCargaPedidoSupabase_(cargaIdFalsa, pedidoIdFalso);
  Logger.log('Hecho. Vuelve a comprobar la misma consulta -- esperado: 0 filas.');
  Logger.log('Si algo falló, se habrá registrado en LOG_ACTIVIDAD como ERROR_SYNC_SUPABASE.');
}

/**
 * PRUEBA AISLADA de sincronizarHistorialTransportistaSupabase_() (Fase 1).
 * Llama DIRECTAMENTE a la función de sincronización (no a
 * registrarHistorialTransportista(), que también escribiría en la Hoja real
 * HIST_TRANSP) -- usa un id_pedido/pedido de prueba reconocible ('999996')
 * que no existe en producción. Comprueba también que el id_pedido de prueba
 * NO choca con la FK (ya se quitó) aunque ese id no exista en pedidos.
 * Tras ejecutarla, borrar a mano en Supabase:
 *   delete from historial_transportista where ped = '999996';
 */
function testSincronizarHistorialTransportistaSupabase() {
  var filaFalsa = {
    id: 'TEST_SYNC_borrar::999996', idPedido: 'TEST_SYNC_borrar_no_existe',
    ped: '999996', tienda: 'Málaga', transportista: 'Correcaminos',
    flujo: 'transporte', evento: 'REABIERTO', fecha: new Date().toISOString()
  };
  sincronizarHistorialTransportistaSupabase_(filaFalsa);
  Logger.log('Hecho. Revisa en Supabase (SQL Editor): select * from historial_transportista where ped = \'999996\';');
  Logger.log('Importante: debe aparecer la fila SIN error, aunque id_pedido (TEST_SYNC_borrar_no_existe) no exista en pedidos -- confirma que la FK ya no bloquea.');
  Logger.log('Si algo falló, se habrá registrado en LOG_ACTIVIDAD como ERROR_SYNC_SUPABASE.');
}

/**
 * PRUEBA AISLADA de la sincronización añadida en confirmarEntregas() (Fase 1):
 * mismas cambios que se mandan de verdad al marcar un pedido ENTREGADO (con
 * silueta/posIni/posFin vacíos, que deben llegar como NULL a Supabase, no
 * como texto vacío). No toca ningún pedido real.
 */
function testSincronizarEntregaSupabase() {
  var pedidoFalso = {
    id: 'TEST_SYNC_borrar', ped: '999999', tienda: 'Málaga',
    transportista: 'Correcaminos', flujo: 'transporte', pct: 100,
    operario: 'Prueba', comentario: '', tipoEntrega: '', enRevision: false,
    sdImpreso: '', nLin: 3, nUbic: 2, soportes: '[]',
    silueta: 'A', posIni: 5, posFin: 5, intentoCarga: ''
  };
  var cambios = {
    estado: 'ENTREGADO', silueta: '', posIni: '', posFin: '',
    actualizado: new Date().toISOString(), intentoCarga: ''
  };
  sincronizarPedidoSupabase_(pedidoFalso, cambios);
  Logger.log('Hecho. Revisa en Supabase (SQL Editor): select id, estado, silueta, pos_ini, pos_fin, intento_carga from pedidos where id = \'TEST_SYNC_borrar\';');
  Logger.log('Esperado: estado=ENTREGADO, silueta=NULL, pos_ini=NULL, pos_fin=NULL, intento_carga=NULL.');
  Logger.log('Si algo falló, se habrá registrado en LOG_ACTIVIDAD como ERROR_SYNC_SUPABASE.');
}

/**
 * PRUEBA AISLADA de que sincronizarPedidoSupabase_() ya manda numero_carga
 * (Fase 1, campo añadido tras quitar la FK pedidos_numero_carga_fkey que
 * apuntaba mal a cargas.id en vez de cargas.num_carga). Usa un pedido de
 * prueba reconocible ('999998') que no existe en producción. Tras
 * ejecutarla, borrar a mano en Supabase:
 *   delete from pedidos where id = 'TEST_SYNC_borrar_numcarga';
 */
function testSincronizarNumeroCargaSupabase() {
  var pedidoFalso = {
    id: 'TEST_SYNC_borrar_numcarga', ped: '999998', tienda: 'Málaga',
    transportista: 'Correcaminos', flujo: 'transporte', pct: 100,
    operario: 'Prueba', comentario: '', tipoEntrega: '', enRevision: false,
    sdImpreso: '', nLin: 1, nUbic: 1, soportes: '[]',
    silueta: 'A', posIni: 9, posFin: 9, intentoCarga: '', estado: 'COMPLETADO_LISTO'
  };
  // 1ª llamada: pedido metido en una carga (numeroCarga con valor).
  sincronizarPedidoSupabase_(pedidoFalso, { numeroCarga: 3 });
  Logger.log('1ª llamada hecha (numeroCarga=3). Comprueba: select numero_carga from pedidos where id = \'TEST_SYNC_borrar_numcarga\';');
  Logger.log('Esperado: numero_carga = \'3\' (sin error de FK -- ya se quitó pedidos_numero_carga_fkey).');
  // 2ª llamada: se saca de la carga (numeroCarga vuelve a estar en blanco).
  sincronizarPedidoSupabase_(pedidoFalso, { numeroCarga: '' });
  Logger.log('2ª llamada hecha (numeroCarga=\'\'). Vuelve a comprobar la misma fila -- esperado: numero_carga = NULL.');
  Logger.log('Si algo falló, se habrá registrado en LOG_ACTIVIDAD como ERROR_SYNC_SUPABASE.');
}

/**
 * PRUEBA AISLADA de sincronizarHistorialEntregasSupabase_() (Fase 1). Usa un
 * pedido de prueba reconocible ('999997') que no existe en producción. Tras
 * ejecutarla, borrar a mano en Supabase:
 *   delete from historial_entregas where pedido = '999997';
 */
function testSincronizarHistorialEntregasSupabase() {
  var filasFalsas = [
    { pedido: '999997', tienda: 'Málaga', transportista: 'Correcaminos', silueta: 'A', posIni: 3, posFin: 3,
      cargador: 'Prueba', ts: new Date().toISOString(), confirmadoTs: new Date().toISOString(), responsable: 'Prueba' }
  ];
  sincronizarHistorialEntregasSupabase_(filasFalsas);
  Logger.log('Hecho. Revisa en Supabase (SQL Editor): select * from historial_entregas where pedido = \'999997\';');
  Logger.log('Si algo falló, se habrá registrado en LOG_ACTIVIDAD como ERROR_SYNC_SUPABASE.');
}

/**
 * PRUEBA AISLADA de sincronizarOcupacionSupabase_() (Fase 1). NO toca ninguna
 * posición real — usa una silueta de prueba reconocible ('Z') que no existe
 * en CONFIG.SILUETAS. Después de ejecutarla, borrar a mano en Supabase:
 *   delete from ocupacion_siluetas where silueta = 'Z';
 * Ejecutar desde el editor y mirar el log.
 */
function testSincronizarOcupacionSupabase() {
  var filasFalsas = [
    { silueta: 'Z', pos: 99, layer: 'back', pedido: '999999', tienda: 'Málaga', flujo: 'transporte', reservado: false },
    { silueta: 'Z', pos: 99, layer: 'front', pedido: '999999', tienda: 'Málaga', flujo: 'transporte', reservado: true }
  ];
  sincronizarOcupacionSupabase_(filasFalsas);
  Logger.log('Hecho. Revisa en Supabase (SQL Editor): select * from ocupacion_siluetas where silueta = \'Z\';');
  Logger.log('Si algo falló, se habrá registrado en LOG_ACTIVIDAD como ERROR_SYNC_SUPABASE.');
}

/**
 * PRUEBA AISLADA de eliminarOcupacionSupabase_() (Fase 1) -- la contrapartida
 * de borrado que usan liberarPosiciones()/liberarPosicionesLote(). Usa la
 * misma silueta de prueba 'Z' con posiciones 97-99 y un pedido de prueba
 * distinto ('999998') para no chocar con otras pruebas. Inserta 3 filas,
 * borra solo el rango 97-98 (debe sobrevivir la 99) y comprueba que el pos
 * en texto ('10' vs '9') no rompe el filtro, probando también con pos=100.
 */
function testEliminarOcupacionSupabase() {
  var filasFalsas = [
    { silueta: 'Z', pos: 97, layer: 'back', pedido: '999998', tienda: 'Málaga', flujo: 'transporte', reservado: false },
    { silueta: 'Z', pos: 98, layer: 'back', pedido: '999998', tienda: 'Málaga', flujo: 'transporte', reservado: false },
    { silueta: 'Z', pos: 100, layer: 'back', pedido: '999998', tienda: 'Málaga', flujo: 'transporte', reservado: false }
  ];
  sincronizarOcupacionSupabase_(filasFalsas);
  Logger.log('Insertadas 3 filas de prueba (pos 97, 98, 100). Comprueba en Supabase: select pos from ocupacion_siluetas where silueta = \'Z\' and pedido = \'999998\' order by pos;');
  Logger.log('--- Ahora borrando el rango 97-100 (debe quedar 0 filas de este pedido de prueba) ---');
  eliminarOcupacionSupabase_('Z', 97, 100, '999998');
  Logger.log('Hecho. Vuelve a comprobar: select pos from ocupacion_siluetas where silueta = \'Z\' and pedido = \'999998\';');
  Logger.log('Esperado: 0 filas (las 3 posiciones, incluida la 100, deben haberse borrado -- confirma que "pos" en texto no rompe el filtro IN).');
  Logger.log('Si algo falló, se habrá registrado en LOG_ACTIVIDAD como ERROR_SYNC_SUPABASE.');
}

/**
 * Lectura rápida de los últimos errores de sincronización con Supabase
 * (columna 'tipo' = ERROR_SYNC_SUPABASE en LOG_ACTIVIDAD). Solo lee, no toca nada.
 * Ejecutar desde el editor y mirar el log.
 */
function verUltimosErroresSync() {
  var log = leerHoja('LOG');
  var errores = log.filter(function(l) { return l.tipo === 'ERROR_SYNC_SUPABASE'; });
  Logger.log('Total errores ERROR_SYNC_SUPABASE: ' + errores.length);
  errores.slice(-10).forEach(function(e) { Logger.log(e.ts + ' | ' + e.detalle); });
}

/**
 * Historial de las comprobaciones nocturnas Sheets↔Supabase (SYNC_CHECK_OK /
 * SYNC_CHECK_DIVERGENCIA en LOG_ACTIVIDAD, registradas por
 * verificarSincronizacionSupabase() cada noche vía procesoDiarioSnapshots()).
 * El plan de migración (Fase 1 → Fase 2) exige "cero divergencias durante al
 * menos una semana completa" antes de avanzar -- esta función muestra las
 * últimas ejecuciones para poder comprobar ese gate de un vistazo. Solo lee,
 * no toca nada. Ejecutar desde el editor y mirar el log.
 */
function verHistorialSyncNocturno() {
  var log = leerHoja('LOG');
  var checks = log.filter(function(l) { return l.tipo === 'SYNC_CHECK_OK' || l.tipo === 'SYNC_CHECK_DIVERGENCIA'; });
  checks.sort(function(a, b) { return new Date(a.ts) - new Date(b.ts); });
  Logger.log('Total comprobaciones registradas: ' + checks.length);
  if (!checks.length) {
    Logger.log('Ninguna todavía -- verificarSincronizacionSupabase() no se ha ejecutado nunca o el log está vacío.');
    return;
  }

  var ultimas = checks.slice(-14);
  ultimas.forEach(function(c) {
    Logger.log('--- ' + c.ts + ' [' + c.tipo + '] ---');
    Logger.log(c.detalle);
  });

  var rachaLimpia = 0;
  for (var i = checks.length - 1; i >= 0; i--) {
    if (checks[i].tipo !== 'SYNC_CHECK_OK') break;
    rachaLimpia++;
  }
  Logger.log('=== Racha de noches limpias consecutivas (más reciente hacia atrás): ' + rachaLimpia + ' ===');
  var props = PropertiesService.getScriptProperties();
  Logger.log('ULTIMA_VERIFICACION_SYNC_OK: ' + (props.getProperty('ULTIMA_VERIFICACION_SYNC_OK') || '(nunca)'));
}

/**
 * PERFILADO DE SOLO LECTURA para fijar el DDL de la migración a Supabase con
 * datos reales, no supuestos (ver docs/superpowers/specs/2026-07-28-migracion-
 * sheets-supabase-design.md §2, que marca varias columnas como "tipo asumido,
 * confirmar"). No escribe nada. Para cada columna listada, cuenta valores
 * distintos (máx. 30, si hay más es texto libre y se muestran solo ejemplos)
 * y cuántas filas vienen vacías/null — así sabemos si hace falta NOT NULL,
 * CHECK/enum, o dejarlo como texto libre.
 * Ejecutar desde el editor y mirar el log (puede ser largo, usar el panel
 * "Registro de ejecución" con scroll).
 */
function perfilarDatosParaMigracion() {
  var objetivo = {
    PEDIDOS: ['estado', 'flujo', 'transportista', 'tienda', 'tipoEntrega', 'pct', 'enRevision', 'sdImpreso', 'intentoCarga', 'soportes'],
    LINEAS: ['tipoUbic', 'esPicking', 'estado', 'motivo', 'muelleHecho', 'ctd'],
    OCUPACION: ['silueta', 'layer', 'flujo', 'reservado'],
    CARGAS: ['estado']
  };

  Object.keys(objetivo).forEach(function(clave) {
    var datos = leerHoja(clave);
    Logger.log('=== ' + clave + ' (' + HOJAS[clave] + ') — ' + datos.length + ' filas ===');
    if (!datos.length) { Logger.log('  (vacía)'); return; }

    objetivo[clave].forEach(function(col) {
      var valores = {};
      var vacios = 0;
      var totalNoVacio = 0;
      datos.forEach(function(fila) {
        var v = fila[col];
        if (v === '' || v === null || v === undefined) { vacios++; return; }
        totalNoVacio++;
        var key = typeof v + ':' + String(v).slice(0, 40);
        valores[key] = (valores[key] || 0) + 1;
      });
      var distintos = Object.keys(valores);
      if (distintos.length === 0) {
        Logger.log('  ' + col + ': TODO vacío (' + vacios + '/' + datos.length + ')');
      } else if (distintos.length <= 30) {
        var resumen = distintos.sort(function(a, b) { return valores[b] - valores[a]; })
          .map(function(k) { return k + ' x' + valores[k]; }).join(', ');
        Logger.log('  ' + col + ': ' + distintos.length + ' distintos, ' + vacios + ' vacíos → ' + resumen);
      } else {
        var ejemplos = distintos.slice(0, 5).join(' | ');
        Logger.log('  ' + col + ': ' + distintos.length + ' distintos (texto libre), ' + vacios + ' vacíos, ejemplos: ' + ejemplos);
      }
    });
  });
  Logger.log('=== FIN PERFILADO ===');
}

/**
 * Diagnóstico de SOLO LECTURA (no escribe nada) para comprobar que PEDIDOS y
 * OCUPACION siguen coherentes entre sí. Se añadió tras un error real al
 * aplicar "Compactar siluetas" (2026-07-28) para descartar que quedara algún
 * dato a medio mover. Ejecutar desde el editor y mirar el log.
 */
function diagnosticoConsistenciaSiluetas() {
  var pedidos = leerHoja('PEDIDOS').filter(function(p) {
    return p.silueta && p.silueta !== 'Recogidas' && p.silueta !== 'Ya Cargados' && !ESTADOS_TERMINALES[p.estado];
  });
  var ocupacion = leerHoja('OCUPACION');
  var problemas = [];

  var ocupPorClave = {}; // 'silueta|pos|layer' -> [pedido,...]
  ocupacion.forEach(function(o) {
    var k = o.silueta + '|' + o.pos + '|' + o.layer;
    (ocupPorClave[k] = ocupPorClave[k] || []).push(String(o.pedido));
  });

  // 1) Pedido con posición real (posIni>0) sin su fila OCUPACION 'back'.
  pedidos.forEach(function(p) {
    if (Number(p.posIni) === 0) return; // bulto: sin OCUPACION esperada
    for (var pos = Number(p.posIni); pos <= Number(p.posFin); pos++) {
      var lista = ocupPorClave[p.silueta + '|' + pos + '|back'] || [];
      if (lista.indexOf(String(p.ped)) === -1) {
        problemas.push({ tipo: 'PEDIDO_SIN_OCUPACION', ped: p.ped, tienda: p.tienda, silueta: p.silueta, pos: pos });
      }
    }
  });

  // 2) Fila OCUPACION 'back' que no coincide con NINGÚN pedido activo en esa
  //    silueta+posición (huérfana, o apuntando a un pedido que ya no está ahí).
  var pedidoEnPos = {}; // 'silueta|pos' -> ped
  pedidos.forEach(function(p) {
    if (Number(p.posIni) === 0) return;
    for (var pos = Number(p.posIni); pos <= Number(p.posFin); pos++) {
      pedidoEnPos[p.silueta + '|' + pos] = String(p.ped);
    }
  });
  ocupacion.forEach(function(o) {
    if (o.layer !== 'back') return;
    var esperado = pedidoEnPos[o.silueta + '|' + o.pos];
    if (!esperado) {
      problemas.push({ tipo: 'OCUPACION_HUERFANA', ped: o.pedido, silueta: o.silueta, pos: o.pos });
    } else if (esperado !== String(o.pedido)) {
      problemas.push({ tipo: 'OCUPACION_DESAJUSTADA', pedOcupacion: o.pedido, pedEsperado: esperado, silueta: o.silueta, pos: o.pos });
    }
  });

  // 3) Dos pedidos DISTINTOS compartiendo el mismo back (no debería pasar,
  //    a diferencia del front que sí puede compartirse en Remansur).
  Object.keys(ocupPorClave).forEach(function(k) {
    if (k.indexOf('|back') === -1) return;
    var unicos = {};
    ocupPorClave[k].forEach(function(ped) { unicos[ped] = true; });
    var claves = Object.keys(unicos);
    if (claves.length > 1) {
      problemas.push({ tipo: 'DOBLE_OCUPACION_BACK', clave: k, pedidos: claves });
    }
  });

  // 4) Bultos: comprobar que no quedó ninguno con posIni=0 pero posFin!=0 (o
  //    viceversa), un estado a medio migrar que no debería poder darse.
  pedidos.forEach(function(p) {
    var ini = Number(p.posIni), fin = Number(p.posFin);
    if ((ini === 0) !== (fin === 0)) {
      problemas.push({ tipo: 'BULTO_POSICION_MIXTA', ped: p.ped, silueta: p.silueta, posIni: p.posIni, posFin: p.posFin });
    }
  });

  Logger.log('Pedidos revisados: ' + pedidos.length + ' · Filas OCUPACION: ' + ocupacion.length);
  Logger.log('PROBLEMAS ENCONTRADOS: ' + problemas.length);
  problemas.forEach(function(pr) { Logger.log(JSON.stringify(pr)); });
  if (!problemas.length) Logger.log('Todo consistente, sin problemas detectados.');
  return { totalProblemas: problemas.length, problemas: problemas };
}

/**
 * Repara SOLO los dos tipos de problema inequívocos que puede detectar
 * diagnosticoConsistenciaSiluetas() -- donde PEDIDOS es fuente de verdad
 * clara y OCUPACION está simplemente desactualizada:
 *   - OCUPACION_HUERFANA: fila de ocupación de un pedido que ya no está ahí
 *     (p.ej. se entregó, o se movió a otro sitio) -- se borra.
 *   - DOBLE_OCUPACION_BACK: dos pedidos comparten el mismo back; se borra el
 *     que NO coincide con la posición actual real de PEDIDOS (el otro se
 *     deja intacto).
 * NO toca 'PEDIDO_SIN_OCUPACION' (puede ser un front compartido legítimo de
 * Remansur, sin fila 'back' propia a propósito) ni 'BULTO_POSICION_MIXTA'
 * (revisar a mano) -- ambos se quedan solo como aviso en el log.
 */
function repararOcupacionInconsistente() {
  var diag = diagnosticoConsistenciaSiluetas();
  var pedidos = leerHoja('PEDIDOS');
  var pedidoEnPos = {}; // 'silueta|pos' -> ped (posición real actual, terminal excluido)
  pedidos.filter(function(p) {
    return p.silueta && p.silueta !== 'Recogidas' && p.silueta !== 'Ya Cargados' && !ESTADOS_TERMINALES[p.estado] && Number(p.posIni) !== 0;
  }).forEach(function(p) {
    for (var pos = Number(p.posIni); pos <= Number(p.posFin); pos++) {
      pedidoEnPos[p.silueta + '|' + pos] = String(p.ped);
    }
  });

  var borrados = 0;
  diag.problemas.forEach(function(pr) {
    if (pr.tipo === 'OCUPACION_HUERFANA') {
      Logger.log('Borrando huerfana: pedido ' + pr.ped + ' en ' + pr.silueta + pr.pos);
      liberarPosiciones(pr.silueta, pr.pos, pr.pos, pr.ped);
      borrados++;
    } else if (pr.tipo === 'DOBLE_OCUPACION_BACK') {
      var partes = pr.clave.split('|'); // silueta|pos|back
      var silueta = partes[0], pos = Number(partes[1]);
      var legitimo = pedidoEnPos[silueta + '|' + pos];
      pr.pedidos.forEach(function(ped) {
        if (ped !== legitimo) {
          Logger.log('Borrando duplicado: pedido ' + ped + ' en ' + silueta + pos + ' (el real ahi es ' + (legitimo || '¿ninguno?') + ')');
          liberarPosiciones(silueta, pos, pos, ped);
          borrados++;
        }
      });
    } else {
      Logger.log('SIN TOCAR (revisar a mano): ' + JSON.stringify(pr));
    }
  });
  Logger.log('Filas de pedidos afectadas por borrado: ' + borrados);

  var diag2 = diagnosticoConsistenciaSiluetas();
  Logger.log('Problemas restantes tras reparar: ' + diag2.totalProblemas);
  return { borrados: borrados, problemasRestantes: diag2.totalProblemas };
}

/**
 * Vuelca el detalle crudo (silueta/pos/soportes/actualizado + filas OCUPACION
 * asociadas) de una lista concreta de pedidos, para investigar a mano un
 * problema ya detectado por diagnosticoConsistenciaSiluetas(). Solo lectura.
 */
function detallePedidosSospechosos() {
  var PEDS = ['281312', '973801', '971253', '970573', '969311', '273854', '974207'];
  var pedidos = leerHoja('PEDIDOS');
  var ocupacion = leerHoja('OCUPACION');
  PEDS.forEach(function(numPed) {
    var filas = pedidos.filter(function(p) { return String(p.ped) === numPed; });
    filas.forEach(function(p) {
      Logger.log('PEDIDO ' + numPed + ': silueta=' + p.silueta + ' posIni=' + p.posIni + ' posFin=' + p.posFin +
        ' estado=' + p.estado + ' soportes=' + p.soportes + ' actualizado=' + p.actualizado);
    });
    if (!filas.length) Logger.log('PEDIDO ' + numPed + ': no encontrado en PEDIDOS');
    var ocs = ocupacion.filter(function(o) { return String(o.pedido) === numPed; });
    ocs.forEach(function(o) {
      Logger.log('  OCUPACION ' + numPed + ': silueta=' + o.silueta + ' pos=' + o.pos + ' layer=' + o.layer + ' reservado=' + o.reservado);
    });
    if (!ocs.length) Logger.log('  OCUPACION ' + numPed + ': ninguna fila');
  });
}

function test_crearPedidoConLineas() {
  limpiarHoja('PEDIDOS'); limpiarHoja('LINEAS');
  var lineas = [
    { dir: '29031', ref: 'R1', ean: 'E1', des: 'Mesa', ctd: 1 },
    { dir: 'BULTO', ref: 'R2', ean: 'E2', des: 'Tornillos', ctd: 5 },
    { dir: '29030', ref: 'R3', ean: 'E3', des: 'Silla', ctd: 2 }
  ];
  crearPedidoConLineas('036::999001', '999001', 'Málaga', 'Correcaminos', lineas);

  var peds = leerHoja('PEDIDOS');
  _assert(peds.length === 1, 'se creó 1 pedido');
  _assert(peds[0].id === '036::999001', 'idPedido correcto');
  _assert(peds[0].flujo === 'transporte', 'flujo derivado de transportista');
  _assert(Number(peds[0].nUbic) === 3, 'nUbic = 3');

  var lin = leerHoja('LINEAS');
  _assert(lin.length === 3, '3 líneas creadas');
  var bulto = lin.find(function(l) { return l.dir === 'BULTO'; });
  _assert(Number(bulto.idx) === 2, 'la línea de picking va al final');
  _assert(bulto.esPicking === true || bulto.esPicking === 'true', 'BULTO marcado esPicking');
  Logger.log('test_crearPedidoConLineas OK');
}

function test_calcularPosiciones() {
  // 2 palet euro (0.5) → 1 posición con back+front
  var r1 = calcularPosiciones([{ tipoId: 'palet_euro', cant: 2 }]);
  _assert(r1.length === 1, '2 euro = 1 posición');
  _assert(r1[0].back === true && r1[0].front === true, '2 euro llenan back+front');

  // 1 palet euro → 1 posición, front reservado
  var r2 = calcularPosiciones([{ tipoId: 'palet_euro', cant: 1 }]);
  _assert(r2.length === 1, '1 euro = 1 posición');
  _assert(r2[0].front === 'reservado', '1 euro reserva el front');

  // 1 palet doble → 1 posición completa
  var r3 = calcularPosiciones([{ tipoId: 'palet_doble', cant: 1 }]);
  _assert(r3.length === 1 && r3[0].front === true, '1 doble llena la posición');

  // 3 euro → 2 posiciones (2 emparejados + 1 con front reservado)
  var r4 = calcularPosiciones([{ tipoId: 'palet_euro', cant: 3 }]);
  _assert(r4.length === 2, '3 euro = 2 posiciones');

  // 1 palet medio (0.25) → 1 posición, front reservado
  var r5 = calcularPosiciones([{ tipoId: 'palet_medio', cant: 1 }]);
  _assert(r5.length === 1 && r5[0].front === 'reservado', '1 medio reserva front');

  // bulto (0) → 0 posiciones
  var r6 = calcularPosiciones([{ tipoId: 'bulto', cant: 5 }]);
  _assert(r6.length === 0, 'bultos no ocupan');
  Logger.log('test_calcularPosiciones OK');
}

// obtenerDatosDashboard() debe exponer 'soportes' por pedido: el resumen
// "0 · 📦" de la Pantalla (Index.html) y del TV (Dashboard.html) necesita
// saber qué soportes lleva cada pedido para poder detectar los que llevan
// un bulto MEZCLADO con un palet/jaula real (el pedido vive en su posición
// numerada normal, pero el bulto se cuenta también en la zona 0) -- sin
// este campo no hay forma de distinguirlos desde el cliente. Solo lectura,
// no toca ninguna hoja.
function test_dashboardIncluyeSoportes() {
  var d = obtenerDatosDashboard();
  _assert(Array.isArray(d.pedidos), 'obtenerDatosDashboard debe devolver pedidos[]');
  if (d.pedidos.length) {
    _assert(Array.isArray(d.pedidos[0].soportes), 'cada pedido del dashboard debe incluir soportes[] (array, aunque esté vacío)');
  }
  Logger.log('test_dashboardIncluyeSoportes OK');
}

function test_zonaTransportista() {
  _assert(ZONA_TRANSPORTISTA['Transporte'] === 'Correcaminos', 'Transporte→Correcaminos');
  _assert(ZONA_TRANSPORTISTA['Instalaciones'] === 'Correcaminos Instalaciones', 'Instalaciones→Correcaminos Instalaciones');
  _assert(ZONA_TRANSPORTISTA['PRO'] === 'Correcaminos PRO', 'PRO→Correcaminos PRO');
  _assert(ZONA_TRANSPORTISTA['Remansur'] === 'Remansur', 'Remansur→Remansur');
  Logger.log('test_zonaTransportista OK');
}

/**
 * Smoke test end-to-end (ejecutar en el editor). NO requiere inventario de Drive:
 * crea un pedido directamente y recorre todo el flujo. ¡LIMPIA las hojas de datos!
 * No ejecutar en producción con datos reales cargados.
 */
function verificarSistema() {
  limpiarHoja('PEDIDOS'); limpiarHoja('LINEAS'); limpiarHoja('OCUPACION'); limpiarHoja('CARGAS'); limpiarHoja('HISTORIAL'); limpiarHoja('HIST_TRANSP');
  var pid = '036::999777';

  // 1) Carga de pedido
  crearPedidoConLineas(pid, '999777', 'Málaga', 'Correcaminos', [
    { dir: '29031', ref: 'R1', ean: 'E1', des: 'Mesa', ctd: 1 },
    { dir: '29032', ref: 'R2', ean: 'E2', des: 'Silla', ctd: 2 }
  ]);

  // 2) Preparación: marcar ambas líneas PREPARADO
  marcarLinea(pid, 0, 'PREPARADO', '', 'Pedro Gil', false);
  marcarLinea(pid, 1, 'PREPARADO', '', 'Pedro Gil', false);
  var ped = leerHoja('PEDIDOS').find(function(p) { return p.id === pid; });
  _assert(ped.estado === 'COMPLETADO_LISTO', 'pedido COMPLETADO_LISTO tras preparar todo');

  // 3) Cierre a silueta A con 2 palet euro (1 posición)
  var rc = cerrarPedido(pid, 'A', 1, [{ tipoId: 'palet_euro', cant: 2 }], 'Pedro Gil');
  _assert(rc.ok, 'cierre OK');
  _assert(rc.posIni === 1 && rc.posFin === 1, 'ocupa 1 posición (2 euro)');
  _assert(obtenerOcupacionSilueta('A').length === 2, 'back+front ocupados en A1');

  // 4) Crear carga
  var cc = crearCarga(['999777']);
  _assert(cc.ok && Number(cc.carga.numCarga) === 1, 'carga 1 creada');

  // 5) Confirmar entrega
  var ce = confirmarEntregas(cc.carga.id, ['999777']);
  _assert(ce.entregados === 1, '1 entregado');
  _assert(obtenerOcupacionSilueta('A').length === 0, 'silueta A liberada tras entrega');
  var pedFinal = leerHoja('PEDIDOS').find(function(p) { return p.id === pid; });
  _assert(pedFinal.estado === 'ENTREGADO', 'pedido ENTREGADO');

  Logger.log('✓✓ verificarSistema OK — pipeline completo verificado');
}

/**
 * DIAGNÓSTICO (solo lectura): el usuario reporta que al generar la lista de
 * Store Delivery de una tienda concreta salen pedidos de TODAS las tiendas, y
 * que el escaneo masivo dice "no está en la lista" para pedidos que sí se ven
 * en pantalla. Reproduce exactamente el filtro de obtenerStoreDelivery() y
 * vuelca qué tiendas salen realmente, más el tipo de dato de p.ped (por si es
 * Number en vez de String, lo que rompería una comparación === con un string
 * escrito/escaneado).
 */
function diagnosticarStoreDeliveryTiendas(tiendaFiltro, flujoGrupo) {
  tiendaFiltro = tiendaFiltro || 'Málaga';
  flujoGrupo = flujoGrupo || 'correcaminos';
  var flujosPermitidos = (flujoGrupo === 'remansur')
    ? { remansur_transporte: true, remansur_pro: true }
    : { transporte: true, instalacion: true, pro: true };
  var todos = leerHoja('PEDIDOS');
  Logger.log('Total filas en PEDIDOS: ' + todos.length);

  var tiendasDistintas = {};
  todos.forEach(function(p) { tiendasDistintas[JSON.stringify(p.tienda)] = (tiendasDistintas[JSON.stringify(p.tienda)] || 0) + 1; });
  Logger.log('Valores DISTINTOS de p.tienda en toda la hoja (con comillas para ver espacios raros): ' + JSON.stringify(tiendasDistintas));

  var candidatos = todos.filter(function(p) {
    return p.tienda === tiendaFiltro && flujosPermitidos[p.flujo] && p.silueta &&
      p.silueta !== 'Recogidas' && p.silueta !== 'Ya Cargados' && esHoyMadrid(p.actualizado) &&
      !esHoyMadrid(p.sdImpreso);
  });
  Logger.log('candidatos.length (tienda=' + tiendaFiltro + ', flujoGrupo=' + flujoGrupo + '): ' + candidatos.length);

  var porTiendaReal = {};
  candidatos.forEach(function(p) { porTiendaReal[p.tienda] = (porTiendaReal[p.tienda] || 0) + 1; });
  Logger.log('Distribución REAL de p.tienda dentro de los candidatos devueltos: ' + JSON.stringify(porTiendaReal));

  Logger.log('--- primeros 8 candidatos (ped/tipo/tienda/silueta/flujo) ---');
  candidatos.slice(0, 8).forEach(function(p) {
    Logger.log('ped=' + JSON.stringify(p.ped) + ' typeof(ped)=' + (typeof p.ped) + ' tienda=' + p.tienda + ' silueta=' + p.silueta + ' flujo=' + p.flujo + ' actualizado=' + p.actualizado + ' sdImpreso=' + p.sdImpreso);
  });

  return { totalPedidos: todos.length, tiendasDistintas: tiendasDistintas, candidatos: candidatos.length, porTiendaReal: porTiendaReal };
}

/**
 * DIAGNÓSTICO (solo lectura): vuelca TODAS las filas de PEDIDOS con este
 * número, sea cual sea su tienda -- para el caso real reportado: el pedido
 * 965229 (Marbella) salió en la lista de Store Delivery de Málaga. Si hay más
 * de una fila con el mismo nº, aquí se ve exactamente qué tienda/id/estado
 * tiene cada una y si alguna tiene el campo tienda mal escrito.
 */
function diagnosticarPedidoEnPedidos(numPed) {
  var num = String(numPed || '965229').trim();
  var todos = leerHoja('PEDIDOS');
  var filas = todos.filter(function(p) { return String(p.ped).trim() === num; });
  Logger.log('Filas en PEDIDOS con ped=' + num + ': ' + filas.length);
  filas.forEach(function(p) {
    Logger.log('_fila=' + p._fila + ' id=' + JSON.stringify(p.id) + ' ped=' + JSON.stringify(p.ped) +
      ' tienda=' + JSON.stringify(p.tienda) + ' transportista=' + p.transportista + ' flujo=' + p.flujo +
      ' estado=' + p.estado + ' silueta=' + JSON.stringify(p.silueta) + ' posIni=' + p.posIni + ' posFin=' + p.posFin +
      ' tipoEntrega=' + JSON.stringify(p.tipoEntrega) + ' parcial=' + p.parcial +
      ' actualizado=' + p.actualizado + ' sdImpreso=' + p.sdImpreso);
  });
  if (!filas.length) Logger.log('No hay NINGUNA fila con ese número en PEDIDOS.');
  return filas;
}


/**
 * DIAGNÓSTICO (solo lectura): barre TODA la hoja PEDIDOS buscando "pedidos
 * fantasma" -- filas cuya tienda CONTRADICE al inventario real de Pyxis
 * (el número existe en el inventario, pero en otra(s) tienda(s), no en la que
 * dice la fila). Es el rastro que deja un alta manual a silueta hecha con el
 * desplegable de tienda equivocado (ver la guarda añadida en
 * registrarPedidoManual, v190). No modifica nada: solo lista lo que habría
 * que revisar, con su silueta/posición para poder comprobarlo físicamente.
 */
function auditarPedidosFantasma() {
  var inv;
  try { inv = cargarInventario(); }
  catch (e) { Logger.log('No se pudo cargar el inventario: ' + e); return []; }
  var todos = leerHoja('PEDIDOS');
  var sospechosos = [];
  todos.forEach(function(p) {
    var num = String(p.ped || '').trim();
    if (!num || !p.tienda) return;
    var entry = inv.indice[num];
    if (!entry) return; // no está en ningún inventario -> alta legítima, no se puede juzgar
    var tiendasInv = Object.keys(entry.porTienda);
    if (!tiendasInv.length || tiendasInv.indexOf(String(p.tienda)) !== -1) return; // coincide, OK
    sospechosos.push({
      fila: p._fila, id: p.id, ped: num, tiendaFila: p.tienda, tiendasInventario: tiendasInv.join('/'),
      estado: p.estado, silueta: p.silueta, posIni: p.posIni, posFin: p.posFin,
      actualizado: p.actualizado, sdImpreso: p.sdImpreso
    });
  });
  Logger.log('=== PEDIDOS FANTASMA (tienda de la fila != tienda del inventario): ' + sospechosos.length + ' ===');
  sospechosos.forEach(function(s) {
    Logger.log('fila=' + s.fila + ' id=' + s.id + ' ped=' + s.ped +
      ' | la fila dice "' + s.tiendaFila + '" pero el inventario dice "' + s.tiendasInventario + '"' +
      ' | estado=' + s.estado + ' silueta=' + JSON.stringify(s.silueta) + ' pos=' + s.posIni + '-' + s.posFin +
      ' actualizado=' + s.actualizado);
  });
  if (!sospechosos.length) Logger.log('Ninguno. Todas las filas de PEDIDOS concuerdan con el inventario.');
  return sospechosos;
}

/**
 * DIAGNÓSTICO (solo lectura): el usuario insiste en que Málaga NO PUEDE tener
 * pedidos con la numeración de 965229/967353 (contradice mi conclusión
 * anterior de "coincidencia de número entre tiendas"). Vuelca el HISTORIAL_
 * TRANSPORTISTA completo (ALTA/REIMPORTADO/CAMBIO_MANUAL/...) de cada fila de
 * PEDIDOS con esos números, en cualquier tienda, para ver EXACTAMENTE cuándo
 * y con qué tienda se dio de alta cada una -- si las dos entradas "Málaga"
 * comparten fecha de alta, apunta a un import hecho con la tienda equivocada
 * seleccionada, no a una coincidencia real de Pyxis.
 */
function diagnosticarHistorialPedidos(numsPed) {
  numsPed = numsPed || ['965229', '967353'];
  var todos = leerHoja('PEDIDOS');
  var hist = leerHoja('HIST_TRANSP');
  // CLAVE: ¿el INVENTARIO real (los Excel de Pyxis en Drive, fuente de verdad
  // de qué pedido pertenece a qué tienda) dice que este pedido es de Málaga?
  // Si el inventario NO lo tiene en Málaga pero PEDIDOS sí, la fila de PEDIDOS
  // se creó con la tienda equivocada -- no es coincidencia de numeración.
  var inv = null;
  try { inv = cargarInventario(); } catch (e) { Logger.log('No se pudo cargar inventario: ' + e); }
  numsPed.forEach(function(num) {
    num = String(num).trim();
    Logger.log('========== PEDIDO ' + num + ' ==========');
    if (inv) {
      var entry = inv.indice[num];
      Logger.log('  INVENTARIO REAL (Drive/Pyxis) -> ' + (entry
        ? 'existe en tiendas: ' + Object.keys(entry.porTienda).join(', ')
        : 'NO EXISTE en ningún inventario'));
    }
    var filas = todos.filter(function(p) { return String(p.ped).trim() === num; });
    Logger.log('Filas en PEDIDOS: ' + filas.length);
    filas.forEach(function(p) {
      Logger.log('  PEDIDOS: _fila=' + p._fila + ' id=' + JSON.stringify(p.id) + ' tienda=' + JSON.stringify(p.tienda) +
        ' transportista=' + p.transportista + ' flujo=' + p.flujo + ' estado=' + p.estado +
        ' silueta=' + JSON.stringify(p.silueta) + ' posIni=' + p.posIni + ' posFin=' + p.posFin +
        ' actualizado=' + p.actualizado + ' sdImpreso=' + p.sdImpreso);
      var eventos = hist.filter(function(h) { return h.idPedido === p.id; })
        .sort(function(a, b) { return String(a.fecha).localeCompare(String(b.fecha)); });
      Logger.log('  Historial de id=' + p.id + ' (' + eventos.length + ' eventos):');
      eventos.forEach(function(h) {
        Logger.log('    fecha=' + h.fecha + ' evento=' + h.evento + ' tienda=' + h.tienda + ' transportista=' + h.transportista + ' flujo=' + h.flujo);
      });
    });
  });
  return 'OK';
}

/**
 * DIAGNÓSTICO (solo lectura, no toca ninguna hoja): incidente real reportado
 * por el usuario (2026-08-11) -- el pedido 976313 lleva 2 días "bloqueado" en
 * su silueta, no se puede ni cargar (meter en una carga) ni borrar/liberar.
 * Vuelca TODO lo relacionado con ese número en un solo pase: la(s) fila(s)
 * completas de PEDIDOS (incluidos numeroCarga/comentario/enRevision/
 * intentoCarga/soportes, que diagnosticarPedidoEnPedidos NO imprime), sus
 * filas de OCUPACION_SILUETAS, en qué CARGAS aparece (y en qué estado),
 * su HISTORIAL_TRANSPORTISTA completo, y cualquier entrada de LOG_ACTIVIDAD
 * que lo mencione -- para diagnosticar sin tener que adivinar cuál de las
 * hojas es la culpable.
 */
function diagnosticarPedidoBloqueado(numPed) {
  var num = String(numPed || '976313').trim();
  Logger.log('========== DIAGNÓSTICO PEDIDO ' + num + ' ==========');

  var pedidos = leerHoja('PEDIDOS');
  var filas = pedidos.filter(function(p) { return String(p.ped).trim() === num; });
  Logger.log('--- PEDIDOS: ' + filas.length + ' fila(s) ---');
  filas.forEach(function(p) {
    Logger.log('_fila=' + p._fila + ' id=' + JSON.stringify(p.id) + ' tienda=' + JSON.stringify(p.tienda) +
      ' transportista=' + p.transportista + ' flujo=' + p.flujo + ' estado=' + p.estado + ' pct=' + p.pct +
      ' silueta=' + JSON.stringify(p.silueta) + ' posIni=' + p.posIni + ' posFin=' + p.posFin +
      ' numeroCarga=' + JSON.stringify(p.numeroCarga) + ' soportes=' + JSON.stringify(p.soportes) +
      ' nLin=' + p.nLin + ' nUbic=' + p.nUbic + ' intentoCarga=' + p.intentoCarga +
      ' comentario=' + JSON.stringify(p.comentario) + ' tipoEntrega=' + JSON.stringify(p.tipoEntrega) +
      ' enRevision=' + p.enRevision + ' sdImpreso=' + p.sdImpreso + ' parcial=' + p.parcial +
      ' actualizado=' + p.actualizado);
  });
  if (!filas.length) Logger.log('No hay NINGUNA fila con ese número en PEDIDOS.');

  var ocup = leerHoja('OCUPACION');
  var ocupRel = ocup.filter(function(o) { return String(o.pedido).trim() === num; });
  Logger.log('--- OCUPACION_SILUETAS: ' + ocupRel.length + ' fila(s) con pedido=' + num + ' ---');
  ocupRel.forEach(function(o) {
    Logger.log('silueta=' + o.silueta + ' pos=' + o.pos + ' layer=' + o.layer + ' tienda=' + o.tienda + ' flujo=' + o.flujo + ' reservado=' + o.reservado);
  });

  if (filas.length) {
    var p0 = filas[0];
    var otrosEnHueco = ocup.filter(function(o) {
      return o.silueta === p0.silueta && Number(o.pos) === Number(p0.posIni) && String(o.pedido).trim() !== num;
    });
    Logger.log('--- Otras filas de OCUPACION en el MISMO hueco (' + p0.silueta + ',' + p0.posIni + ') pero con OTRO pedido: ' + otrosEnHueco.length + ' ---');
    otrosEnHueco.forEach(function(o) { Logger.log(JSON.stringify(o)); });
  }

  var cargas = leerHoja('CARGAS');
  var enCarga = cargas.filter(function(c) {
    var items = parseJSON(c.items, []);
    return items.some(function(it) { return String(it.ped).trim() === num; });
  });
  Logger.log('--- CARGAS que contienen ' + num + ': ' + enCarga.length + ' ---');
  enCarga.forEach(function(c) {
    var items = parseJSON(c.items, []);
    var item = items.filter(function(it) { return String(it.ped).trim() === num; })[0];
    Logger.log('id=' + c.id + ' numCarga=' + c.numCarga + ' estado=' + c.estado + ' fecha=' + c.fecha +
      ' fechaCierre=' + c.fechaCierre + ' responsable=' + c.responsable + ' cargador=' + c.cargador +
      ' | item.estado=' + (item && item.estado));
  });

  var hist = leerHoja('HIST_TRANSP');
  var idsRelevantes = filas.map(function(p) { return p.id; });
  var eventos = hist.filter(function(h) { return idsRelevantes.indexOf(h.idPedido) !== -1; })
    .sort(function(a, b) { return String(a.fecha).localeCompare(String(b.fecha)); });
  Logger.log('--- HISTORIAL_TRANSPORTISTA: ' + eventos.length + ' evento(s) ---');
  eventos.forEach(function(h) {
    Logger.log('fecha=' + h.fecha + ' idPedido=' + h.idPedido + ' evento=' + h.evento + ' tienda=' + h.tienda + ' transportista=' + h.transportista + ' flujo=' + h.flujo);
  });

  var log = leerHoja('LOG');
  var logRel = log.filter(function(l) { return String(l.detalle || '').indexOf(num) !== -1; })
    .sort(function(a, b) { return String(a.ts).localeCompare(String(b.ts)); });
  Logger.log('--- LOG_ACTIVIDAD que menciona ' + num + ': ' + logRel.length + ' entrada(s) ---');
  logRel.forEach(function(l) {
    Logger.log('ts=' + l.ts + ' tipo=' + l.tipo + ' usuario=' + l.usuario + ' detalle=' + l.detalle);
  });

  return { filasPedidos: filas.length, filasOcupacion: ocupRel.length, cargas: enCarga.length, eventosHistorial: eventos.length, logs: logRel.length };
}
