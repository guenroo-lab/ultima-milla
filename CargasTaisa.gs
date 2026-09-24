/**
 * ============================================================
 * CargasTaisa.gs
 * ============================================================
 * Exporta cargas marcadas "Camión Grúa" a la hoja externa "PANEL RUTAS GRÚA
 * MÁLAGA" (pestaña CARGAS TAISA), mantenida por otro equipo. Los datos de
 * localidad/CP/peso/tipo cliente no existen en el inventario Pyxis que ya
 * importa esta app -- salen de pedidos_totales.csv, un export completo de
 * Pyxis que vive en la MISMA carpeta de Drive que los inventarios por tienda
 * (INVENTARIO_FOLDER_ID), actualizado a diario por el propio Pyxis.
 * Ver docs/superpowers/specs/2026-09-01-camion-grua-cargas-taisa-design.md
 */

var CARGAS_TAISA_SHEET_ID = '1BShlbVdf3UWetJlOGKzFsOO19VwxWd2DkTkqO2XqJjg';
var CARGAS_TAISA_TAB = 'CARGAS TAISA';
var CACHE_PREFIX_PEDIDOS_TOTALES = 'idxGrua_';
var CACHE_TTL_PEDIDOS_TOTALES = 21600; // 6h -- máximo real que permite CacheService.put

/**
 * Índice ped -> {peso, cp, ciudad, esPro} de pedidos_totales.csv, con caché troceada
 * (confirmado en vivo el 2026-09-01: 7.129 pedidos únicos, índice ~440KB, parseo completo
 * ~13s -- ver ejecutarDiagnosticoTamanoPedidosTotales en Pruebas.gs).
 */
function _indicePedidosTotales() {
  var cache = CacheService.getScriptCache();
  var reensamblado = _leerIndiceCacheado(cache);
  if (reensamblado) return reensamblado;

  var indice = _construirIndicePedidosTotales();
  _guardarIndiceEnCache(cache, indice);
  return indice;
}

function _leerIndiceCacheado(cache) {
  var meta = cache.get(CACHE_PREFIX_PEDIDOS_TOTALES + 'meta');
  if (!meta) return null;
  var n = Number(meta);
  var partes = [];
  for (var i = 0; i < n; i++) {
    var parte = cache.get(CACHE_PREFIX_PEDIDOS_TOTALES + i);
    if (!parte) return null; // caché parcialmente caducada -- recalcular todo
    partes.push(parte);
  }
  try { return JSON.parse(partes.join('')); } catch (e) { return null; }
}

function _guardarIndiceEnCache(cache, indice) {
  var json = JSON.stringify(indice);
  var TAM_TROZO = 90000; // margen bajo el límite real de 100KB por clave
  var n = Math.ceil(json.length / TAM_TROZO) || 1;
  try {
    for (var i = 0; i < n; i++) {
      cache.put(CACHE_PREFIX_PEDIDOS_TOTALES + i, json.substr(i * TAM_TROZO, TAM_TROZO), CACHE_TTL_PEDIDOS_TOTALES);
    }
    cache.put(CACHE_PREFIX_PEDIDOS_TOTALES + 'meta', String(n), CACHE_TTL_PEDIDOS_TOTALES);
  } catch (e) {
    // Si guardar la caché fallara por lo que sea, no pasa nada -- se
    // recalcula la próxima vez, más lento pero sin romper nada.
  }
}

function _construirIndicePedidosTotales() {
  var carpeta = DriveApp.getFolderById(INVENTARIO_FOLDER_ID);
  var it = carpeta.getFilesByName('pedidos_totales.csv');
  if (!it.hasNext()) return {};
  var file = it.next();
  var texto = file.getBlob().getDataAsString('UTF-8').replace(/^﻿/, '');
  var lineas = texto.split('\n');
  if (!lineas.length) return {};

  var cab = lineas[0].split(';').map(function(c) { return c.replace(/"/g, '').trim(); });
  var idxPed = cab.indexOf('Nº Pedido cliente');
  var idxPro = cab.indexOf('Cliente PRO');
  var idxPeso = cab.indexOf('Peso');
  var idxCp = cab.indexOf('Código postal envío');
  var idxCiudad = cab.indexOf('Ciudad envío');
  if (idxPed === -1) return {}; // cabecera cambió de formato -- mejor vacío que datos mal alineados

  var indice = {};
  for (var i = 1; i < lineas.length; i++) {
    if (!lineas[i]) continue;
    var f = lineas[i].split(';');
    var ped = (f[idxPed] || '').replace(/"/g, '').trim();
    if (!ped || indice[ped]) continue; // primera aparición de cada pedido -- cabecera de línea es idéntica en todas sus filas
    indice[ped] = {
      peso: (f[idxPeso] || '').replace(/"/g, '').trim(),
      cp: (f[idxCp] || '').replace(/"/g, '').trim(),
      ciudad: (f[idxCiudad] || '').replace(/"/g, '').trim(),
      esPro: (f[idxPro] || '').replace(/"/g, '').trim().toLowerCase() === 'si'
    };
  }
  return indice;
}

/**
 * Añade una fila por pedido a la pestaña CARGAS TAISA de la hoja externa.
 * Pensada para llamarse DESPUÉS de crear la carga real (fuera del candado de
 * crearCarga) -- un fallo aquí no debe deshacer ni bloquear la carga, que ya
 * se creó bien. items: mismo array que ya construye crearCarga ({ped,tienda,...}).
 * Devuelve el número de filas escritas.
 */
function _exportarCargaTaisa_(agencia, fechaIso, items) {
  var indice = _indicePedidosTotales();
  var ss = SpreadsheetApp.openById(CARGAS_TAISA_SHEET_ID);
  var hoja = ss.getSheetByName(CARGAS_TAISA_TAB);
  if (!hoja) throw new Error('No existe la pestaña "' + CARGAS_TAISA_TAB + '" en la hoja externa');

  var fechaCorta = Utilities.formatDate(new Date(fechaIso), 'Europe/Madrid', 'dd/MM/yyyy');
  // Convención real de la hoja externa: agencia en MAYÚSCULAS (confirmado viendo las filas
  // ya existentes -- REMANSUR/CORRECAMINOS/MALAGA TRANSPORT). El valor interno de la carga
  // (carga.agencia) se guarda tal cual eligió el usuario; solo se normaliza aquí, al exportar.
  var agenciaMayus = (agencia || '').toUpperCase();
  var filas = items.map(function(item) {
    var datos = indice[String(item.ped)] || {};
    var codigo = codigoTienda(item.tienda);
    return [
      agenciaMayus, fechaCorta, codigo ? Number(codigo) : item.tienda, item.ped,
      datos.esPro === true ? 'PRO' : (datos.esPro === false ? 'PARTICULAR' : ''),
      datos.ciudad || '', datos.cp || '', datos.peso || '', ''
    ];
  });
  if (filas.length) {
    hoja.getRange(hoja.getLastRow() + 1, 1, filas.length, 9).setValues(filas);
  }
  return filas.length;
}
