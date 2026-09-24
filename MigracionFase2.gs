/**
 * ============================================================
 * MigracionFase2.gs · Volcado masivo de históricos a Supabase
 * ============================================================
 * Fase 2 de la migración a Supabase (ver docs/superpowers/specs/
 * 2026-07-28-migracion-sheets-supabase-design.md, §6): la Fase 1 (escritura
 * en sombra, v168 en adelante) solo copia lo que se TOCA desde que se activó
 * -- todo lo que ya existía antes en Sheets nunca se copió. Este archivo hace
 * ese volcado histórico completo, una vez, por lotes (PostgREST no acepta
 * arrays gigantes de golpe con garantías, y Apps Script tiene un límite de
 * 6 minutos por ejecución).
 *
 * SIEMPRE se prueba primero contra el esquema `staging` (creado 2026-08-12
 * dentro del mismo proyecto Supabase `lm-malaga`, ver memoria del proyecto)
 * antes de tocar `public` (producción real, ya en escritura en sombra activa
 * desde Fase 1). Por eso cada función pide el esquema explícitamente, sin
 * valor por defecto -- una llamada sin especificar esquema es un error, no
 * un silencioso "voy a public".
 *
 * Idempotente: todas las tablas con clave primaria real usan
 * `Prefer: resolution=merge-duplicates`, así que volver a ejecutar cualquier
 * exportador no duplica nada, solo re-escribe con los valores actuales de
 * Sheets (útil para re-lanzar tras corregir un error a mitad de volcado).
 * Excepción: RETIRADAS_STOCK no tiene clave natural en Supabase (columna sin
 * PK) -- su exportador comprueba que el destino esté vacío antes de insertar,
 * para no duplicar si se llama dos veces.
 */

/**
 * Wrapper de una línea, colocado a propósito como PRIMERA función del
 * archivo -- el desplegable de funciones del editor de Apps Script es poco
 * fiable seleccionando funciones que no son la primera del archivo (varias
 * veces esta sesión ha mostrado un nombre en el toolbar y ejecutado OTRA
 * función distinta, sin avisar de nada raro en el log). Al ser la primera
 * función, se autoselecciona sola al abrir el archivo -- cero interacción
 * con el desplegable, cero ambigüedad sobre qué se ha ejecutado de verdad.
 *
 * BACKFILL de `items` en public.cargas (Pieza 4c, 2026-09-05): `items` es
 * columna NUEVA (jsonb, añadida hoy) -- las 461 filas ya existentes en
 * `cargas` (sincronizadas en vivo desde Fase 1, v175) nunca la tuvieron,
 * porque `sincronizarCargaSupabase_()` nunca mandó ese campo (decisión
 * original: CARGAS era relacional vía cargas_pedidos -- ver Pieza3Publico.gs
 * para el porqué de cambiar de idea). CARGAS TODAVÍA no está en
 * TABLAS_PUBLIC_ al ejecutar esto -- `leerHoja('CARGAS')` lee Sheets de
 * verdad (fuente real, con `items` completo). Reenvía la fila COMPLETA de
 * cada carga (no solo `items`) porque el upsert con `merge-duplicates` exige
 * las columnas NOT NULL (num_carga, fecha, estado) en el candidato a
 * insertar -- mismo patrón que `sincronizarCargaSupabase_`/
 * `exportarCargasHistorico`. Seguro de re-ejecutar (upsert por `id`, la PK
 * real): si se llama dos veces, la segunda solo re-escribe los mismos
 * valores.
 */
function ejecutarBackfillItemsCargasPublico() {
  var filas = leerHoja('CARGAS').map(function(f) {
    return {
      id: f.id, num_carga: String(f.numCarga), fecha: f.fecha ? String(f.fecha).slice(0, 10) : null,
      estado: f.estado, responsable: f.responsable || null, cargador: f.cargador || null,
      fecha_cierre: f.fechaCierre || null, items: parseJSON(f.items, [])
    };
  });
  Logger.log('ejecutarBackfillItemsCargasPublico: ' + filas.length + ' cargas en Sheets a reenviar con items');
  var resumen = postgrestUpsertLote_('cargas', filas, { schema: 'public' });
  Logger.log('ejecutarBackfillItemsCargasPublico RESULTADO: ' + JSON.stringify(resumen).slice(0, 1000));
  return resumen;
}

/**
 * Wrapper de una línea, colocado a propósito como PRIMERA función del
 * archivo -- el desplegable de funciones del editor de Apps Script es poco
 * fiable seleccionando funciones que no son la primera del archivo (varias
 * veces esta sesión ha mostrado un nombre en el toolbar y ejecutado OTRA
 * función distinta, sin avisar de nada raro en el log). Al ser la primera
 * función, se autoselecciona sola al abrir el archivo -- cero interacción
 * con el desplegable, cero ambigüedad sobre qué se ha ejecutado de verdad.
 *
 * BACKFILL INCREMENTAL de log_actividad (Pieza 4b, 2026-09-05): el volcado
 * histórico de una vez (exportarLogActividadHistorico, más abajo) se hizo el
 * 2026-08-13 (8897 filas) -- LOG_ACTIVIDAD NUNCA tuvo sincronización en vivo
 * de Fase 1 (volumen demasiado alto, una llamada por cada acción de la app,
 * ver comentario de exportarLogActividadHistorico), así que todo lo escrito
 * en Sheets desde esa fecha hasta hoy solo existe en Sheets. Antes de cortar
 * la lectura/escritura de LOG a Postgres, este backfill cierra ese hueco:
 * calcula el `ts` MÁS RECIENTE ya presente en Supabase (consulta en vivo, no
 * una fecha fija) y manda solo las filas de Sheets POSTERIORES a ese punto
 * -- INSERT normal, sin upsert (la tabla no tiene clave natural para
 * deduplicar), así que el corte por fecha en vivo es la única defensa contra
 * duplicados: es seguro volver a ejecutar esto más de una vez, cada
 * ejecución solo manda lo que de verdad sea nuevo desde la última.
 * `ts` en Sheets puede volver como objeto Date real (Sheets coacciona
 * columnas de fecha/hora aunque el código siempre escriba un string ISO --
 * mismo gotcha ya documentado para RETIRADAS_STOCK.fecha) o como string ISO
 * -- _tsComoIso_ normaliza ambos casos antes de comparar/enviar.
 */
function ejecutarBackfillLogActividadPublico() {
  var cfg = getSupabaseConfig_();
  if (!cfg) throw new Error('Supabase no configurado');
  var headersGet = { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, 'User-Agent': 'GoogleAppsScript-lm_produccion-migracion' };
  var respMax = UrlFetchApp.fetch(cfg.url + '/rest/v1/log_actividad?select=ts&order=ts.desc&limit=1', { method: 'get', headers: headersGet, muteHttpExceptions: true });
  if (respMax.getResponseCode() >= 300) throw new Error('No se pudo leer el ts más reciente de log_actividad: HTTP ' + respMax.getResponseCode() + ' ' + respMax.getContentText().slice(0, 300));
  var filasMax = JSON.parse(respMax.getContentText() || '[]');
  var desdeTs = filasMax.length ? filasMax[0].ts : null;
  Logger.log('ejecutarBackfillLogActividadPublico: ts más reciente ya en Supabase = ' + desdeTs);

  var todas = _leerHojaSheetsCruda_('LOG');
  var nuevas = todas.filter(function(r) {
    var ts = _tsComoIso_(r.ts);
    return ts && (!desdeTs || new Date(ts) > new Date(desdeTs));
  });
  Logger.log('ejecutarBackfillLogActividadPublico: ' + todas.length + ' filas en Sheets, ' + nuevas.length + ' nuevas a mandar (posteriores a ' + desdeTs + ')');

  var filas = nuevas.map(function(r) {
    return { ts: _tsComoIso_(r.ts), tipo: r.tipo || null, detalle: r.detalle || null, usuario: r.usuario || null };
  });
  var resumen = postgrestUpsertLote_('log_actividad', filas, { schema: 'public', sinUpsert: true });
  Logger.log('ejecutarBackfillLogActividadPublico RESULTADO: ' + JSON.stringify(resumen).slice(0, 1000));
  return resumen;
}

function _tsComoIso_(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * Wrapper de una línea, colocado a propósito como PRIMERA función del
 * archivo -- el desplegable de funciones del editor de Apps Script es poco
 * fiable seleccionando funciones que no son la primera del archivo (varias
 * veces esta sesión ha mostrado un nombre en el toolbar y ejecutado OTRA
 * función distinta, sin avisar de nada raro en el log). Al ser la primera
 * función, se autoselecciona sola al abrir el archivo -- cero interacción
 * con el desplegable, cero ambigüedad sobre qué se ha ejecutado de verdad.
 *
 * Recarga de historial_entregas en public, 2026-08-13 -- confirmado por el
 * usuario. public.historial_entregas se vació a mano (TRUNCATE, vía el
 * conector Supabase MCP) justo antes de desplegar esto, así que la guarda
 * "si el destino ya tiene filas, no reenvíes" de exportarHistorialEntregasHistorico
 * ahora deja pasar el volcado completo sin duplicar nada.
 */
function ejecutarRecargaHistorialEntregasPublico() {
  return exportarHistorialEntregasHistorico('public');
}

/**
 * Recarga SOLO lineas_preparacion en public desde la copia CONGELADA de
 * Sheets (2026-09-04, tras el corte de Pieza 3). LINEAS nunca tuvo sync en
 * vivo durante Fase 1 (decisión deliberada) -- el único volcado que tuvo fue
 * el histórico del 2026-08-13. Cualquier pedido reabierto/reimportado/creado
 * en Sheets DESPUÉS de esa fecha y ANTES del corte de hoy tiene sus líneas
 * reales solo en Sheets, invisibles para Postgres -- este wrapper cierra ese
 * hueco. Upsert por `id` (Prefer: resolution=merge-duplicates): solo AÑADE o
 * ACTUALIZA filas cuyo id exista en la copia congelada de Sheets, nunca borra
 * nada -- una línea marcada por un operario YA vía Postgres (después del
 * corte, con el mismo id que tenía en Sheets) SÍ se pisaría con el valor
 * viejo de Sheets si existe esa coincidencia exacta -- confirmar con el
 * usuario que no ha habido actividad real de picking entre el despliegue de
 * v212/213 y la ejecución de este wrapper antes de lanzarlo.
 */
function ejecutarRecargaLineasPublico() {
  return exportarLineasHistorico('public');
}

/**
 * VOLCADO A PRODUCCION (public), 2026-08-13, tras validar sin errores contra
 * staging. Comprobado antes con select count(*) real: public YA tiene datos
 * en pedidos/ocupacion/cargas/cargas_pedidos/historial_transportista (Fase 1
 * activa desde julio) -- las 5 usan upsert por PK real, reenviar el
 * historico completo es seguro (sobrescribe con el mismo valor o uno mas
 * fresco, crea lo que falte). lineas_preparacion/visas/retiradas_stock/
 * log_actividad estan confirmadas vacias en public, su guarda no bloquea
 * nada. historial_entregas es la UNICA excepcion: ya tiene 1189 filas en
 * public (si se sincroniza en vivo desde v173) y no tiene clave natural
 * para upsert -- se deja fuera de este wrapper a proposito, se trata aparte
 * (usuario confirmo el paso general, pendiente confirmar el vaciado
 * concreto de esa tabla).
 */
function ejecutarVolcadoPublico() {
  var resultados = [
    exportarPedidosHistorico('public'),
    exportarLineasHistorico('public'),
    exportarOcupacionHistorico('public'),
    exportarCargasHistorico('public'),
    exportarCargasPedidosHistorico('public'),
    exportarHistorialTransportistaHistorico('public'),
    exportarVisasHistorico('public'),
    exportarRetiradasHistorico('public'),
    exportarLogActividadHistorico('public')
  ];
  Logger.log('=== RESUMEN VOLCADO HISTORICO A PUBLIC (sin historial_entregas) ===');
  var totalErrores = 0;
  resultados.forEach(function(r) {
    totalErrores += r.errores.length;
    Logger.log(r.tabla + ': ' + r.enviadas + '/' + r.total + ' filas OK' + (r.omitido ? ' (omitido: ' + r.omitido + ')' : '') + (r.errores.length ? ' -- ' + r.errores.length + ' LOTE(S) CON ERROR' : ''));
  });
  Logger.log(totalErrores ? ('*** ' + totalErrores + ' lote(s) con error en total -- revisar arriba ***') : '*** Todo OK, cero errores (historial_entregas pendiente aparte) ***');
  return resultados;
}

function ejecutarVolcadoStaging() {
  return migrarTodoHistoricoAStaging();
}

/**
 * Envía `filas` a la tabla PostgREST `tabla`, troceadas en lotes de
 * `opciones.tamanoLote` (500 por defecto). `opciones.schema` es OBLIGATORIO
 * ('staging' o 'public') -- se manda como cabecera Content-Profile cuando no
 * es 'public' (el esquema por defecto de PostgREST no necesita cabecera).
 * Devuelve un resumen {tabla, total, enviadas, lotes, errores[]} en vez de
 * lanzar excepción en el primer fallo -- un lote malo no debe tirar abajo
 * los 20 lotes buenos que le siguen; los errores quedan listados para poder
 * reintentarlos aparte.
 */
function postgrestUpsertLote_(tabla, filas, opciones) {
  opciones = opciones || {};
  if (opciones.schema !== 'public' && opciones.schema !== 'staging') {
    throw new Error('postgrestUpsertLote_(' + tabla + '): opciones.schema debe ser "public" o "staging" explícitamente, no ' + JSON.stringify(opciones.schema));
  }
  var cfg = getSupabaseConfig_();
  if (!cfg) throw new Error('Supabase no configurado (SUPABASE_URL/SUPABASE_SERVICE_KEY vacíos en Propiedades del script)');
  var tamanoLote = opciones.tamanoLote || 500;

  var headers = {
    apikey: cfg.key, Authorization: 'Bearer ' + cfg.key,
    'Content-Type': 'application/json',
    Prefer: (opciones.sinUpsert ? 'return=minimal' : 'resolution=merge-duplicates,return=minimal'),
    'User-Agent': 'GoogleAppsScript-lm_produccion-migracion'
  };
  if (opciones.schema !== 'public') headers['Content-Profile'] = opciones.schema;

  var enviadas = 0, lotes = 0, errores = [];
  for (var i = 0; i < filas.length; i += tamanoLote) {
    var lote = filas.slice(i, i + tamanoLote);
    lotes++;
    var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + tabla, {
      method: 'post', headers: headers, payload: JSON.stringify(lote), muteHttpExceptions: true
    });
    var codigo = resp.getResponseCode();
    if (codigo >= 300) {
      errores.push({ desde: i, hasta: i + lote.length, codigo: codigo, texto: resp.getContentText().slice(0, 500) });
    } else {
      enviadas += lote.length;
    }
  }
  var resumen = { tabla: tabla, esquema: opciones.schema, total: filas.length, enviadas: enviadas, lotes: lotes, errores: errores };
  Logger.log('postgrestUpsertLote_ ' + tabla + ' (' + opciones.schema + '): ' + enviadas + '/' + filas.length + ' filas OK en ' + lotes + ' lote(s), ' + errores.length + ' lote(s) con error');
  if (errores.length) Logger.log('  Errores: ' + JSON.stringify(errores).slice(0, 1000));
  return resumen;
}

// Convierte '' / null / undefined a null; cualquier otra cosa a Number().
function _numONulo(v) { return (v === '' || v === null || v === undefined) ? null : Number(v); }
// Igual que _numONulo pero el resultado se manda como texto (columnas pos_ini/pos_fin/pos son `text` en Supabase).
function _numComoTextoONulo(v) { var n = _numONulo(v); return n === null ? null : String(v); }
function _esVerdadero(v) { return v === true || v === 'true' || v === 'TRUE' || v === 1; }
// Fecha-solo-día robusta: Sheets devuelve a veces un objeto Date real (celdas con formato fecha,
// p.ej. RETIRADAS_STOCK) y otras veces ya un string ISO escrito por código (p.ej. CARGAS.fecha,
// que sale de new Date().toISOString()). String(dateObj).slice(0,10) rompe con el primer caso
// (da "Tue Jul 21" en vez de "2026-07-21") -- Postgres lo rechaza como `date` inválido.
function _fechaSoloDia(v) {
  if (!v) return null;
  if (v instanceof Date) return Utilities.formatDate(v, 'Europe/Madrid', 'yyyy-MM-dd');
  return String(v).slice(0, 10);
}
/**
 * Deduplica `filas` por la clave que devuelva `claveFn(fila)`, quedándose con
 * la ÚLTIMA aparición de cada clave. Necesario porque PostgREST/Postgres
 * rechaza el LOTE ENTERO (no solo la fila repetida) con "ON CONFLICT DO
 * UPDATE command cannot affect row a second time" si dos filas del MISMO
 * lote comparten clave -- encontrado de verdad probando contra staging
 * (2026-08-12): LINEAS_PREPARACION e OCUPACION_SILUETAS tienen ahora mismo
 * mismo alguna fila duplicada por su clave real, y CARGAS.items puede traer
 * el mismo pedido dos veces dentro de la misma carga. Deduplicar aquí no
 * "arregla" esos datos (siguen duplicados en Sheets), solo evita que el
 * volcado entero de ese lote se pierda por un puñado de filas repetidas.
 */
function _dedupPorClave(filas, claveFn) {
  var porClave = {};
  filas.forEach(function(f) { porClave[claveFn(f)] = f; });
  var out = Object.keys(porClave).map(function(k) { return porClave[k]; });
  if (out.length !== filas.length) Logger.log('_dedupPorClave: ' + (filas.length - out.length) + ' fila(s) duplicada(s) por clave descartadas (se conserva la última de cada grupo).');
  return out;
}

/** PEDIDOS → public.pedidos / staging.pedidos. Mismo mapeo de campos que sincronizarPedidoSupabase_ (Backend.gs) -- MANTENER SINCRONIZADOS si uno cambia. */
function exportarPedidosHistorico(schema) {
  // Fase 3, Pieza 3 (2026-09-04): leerHoja('PEDIDOS') ya redirige a Postgres --
  // este exportador existe para llevar Sheets->Postgres, así que tiene que
  // leer la copia CONGELADA de Sheets sin pasar por esa redirección.
  var filas = _leerHojaSheetsCruda_('PEDIDOS').map(function(f) {
    return {
      id: f.id, ped: f.ped, tienda: f.tienda,
      transportista: f.transportista || null, flujo: f.flujo || null,
      estado: f.estado, pct: _numONulo(f.pct), operario: f.operario || null,
      silueta: f.silueta || null,
      pos_ini: _numComoTextoONulo(f.posIni), pos_fin: _numComoTextoONulo(f.posFin),
      soportes: (typeof f.soportes === 'string') ? parseJSON(f.soportes, []) : (f.soportes || []),
      n_lin: _numONulo(f.nLin), n_ubic: _numONulo(f.nUbic),
      actualizado: f.actualizado || new Date().toISOString(),
      intento_carga: _numONulo(f.intentoCarga), comentario: f.comentario || null,
      tipo_entrega: f.tipoEntrega || null, en_revision: _esVerdadero(f.enRevision),
      sd_impreso: f.sdImpreso || null,
      numero_carga: (f.numeroCarga === '' || f.numeroCarga === null || f.numeroCarga === undefined) ? null : String(f.numeroCarga),
      parcial: _esVerdadero(f.parcial)
    };
  });
  return postgrestUpsertLote_('pedidos', filas, { schema: schema });
}

/**
 * LINEAS_PREPARACION → lineas_preparacion. Nunca sincronizada en Fase 1
 * (decisión deliberada, ver memoria) -- este es el primer volcado que le
 * llega, mapeo nuevo directo camelCase→snake_case desde COLUMNAS.LINEAS.
 *
 * Dos protecciones añadidas tras probar contra staging (2026-08-12), las dos
 * por datos reales encontrados en Sheets, no por suposición:
 * 1. Deduplicado por `id` (ver _dedupPorClave) -- LINEAS_PREPARACION tiene
 *    ahora mismo id's repetidos (posible cola del bug de v196, o uno nuevo).
 * 2. Filtro de huérfanas: `id_pedido` tiene FK real contra pedidos(id) en
 *    Supabase (a propósito, para detectar justo esto) -- algunas filas de
 *    LINEAS apuntan a pedidos que ya NO existen en la hoja PEDIDOS (purgados
 *    en algún momento sin limpiar sus líneas). Se excluyen del volcado y se
 *    cuentan en el log; la hoja Sheets NO se toca aquí.
 */
function exportarLineasHistorico(schema) {
  // Fase 3, Pieza 3 (2026-09-04): mismo motivo que exportarPedidosHistorico --
  // leerHoja('PEDIDOS'/'LINEAS') ya redirige a Postgres, bypass a la copia
  // congelada de Sheets con _leerHojaSheetsCruda_. LINEAS nunca tuvo sync en
  // vivo durante Fase 1 (decisión deliberada, ver memoria del proyecto) --
  // esta es la única vía por la que Postgres puede quedar al día con lo que
  // pasó en Sheets entre el volcado del 2026-08-13 y el corte de hoy.
  var idsPedidoValidos = {};
  _leerHojaSheetsCruda_('PEDIDOS').forEach(function(p) { idsPedidoValidos[p.id] = true; });

  var todas = _leerHojaSheetsCruda_('LINEAS');
  var huerfanas = todas.filter(function(f) { return !idsPedidoValidos[f.idPedido]; });
  if (huerfanas.length) Logger.log('exportarLineasHistorico: ' + huerfanas.length + ' línea(s) excluida(s) por apuntar a un pedido que ya no existe en PEDIDOS (huérfanas) -- ejemplos: ' + huerfanas.slice(0, 5).map(function(f) { return f.idPedido; }).join(', '));

  var filas = todas.filter(function(f) { return idsPedidoValidos[f.idPedido]; }).map(function(f) {
    return {
      id: f.id, id_pedido: f.idPedido, idx: _numONulo(f.idx) || 0,
      dir: f.dir || null, ref: f.ref || null, ean: f.ean || null, des: f.des || null,
      ctd: _numONulo(f.ctd), tipo_ubic: f.tipoUbic || null,
      es_picking: f.esPicking === '' || f.esPicking === null || f.esPicking === undefined ? null : _esVerdadero(f.esPicking),
      estado: f.estado || null, motivo: f.motivo || null, operario: f.operario || null,
      ts: f.ts || null, muelle_hecho: _esVerdadero(f.muelleHecho)
    };
  });
  filas = _dedupPorClave(filas, function(f) { return f.id; });
  return postgrestUpsertLote_('lineas_preparacion', filas, { schema: schema });
}

/**
 * OCUPACION_SILUETAS → ocupacion_siluetas. Mismo mapeo que
 * sincronizarOcupacionSupabase_, MÁS: (1) un filtro de filas vacías
 * (silueta/pos/layer son la PK compuesta, NOT NULL -- una fila vaciada con
 * clearContent, como la del incidente del pedido 976313, rompería el insert
 * si no se filtra); (2) deduplicado por silueta+pos+layer -- probado contra
 * staging (2026-08-12), la hoja tiene ahora mismo alguna combinación
 * repetida (mismo hallazgo de fondo que el incidente 976313: algo deja más
 * de una fila para el mismo hueco físico).
 */
function exportarOcupacionHistorico(schema) {
  // Fase 3, Pieza 3 (2026-09-04): bypass a Sheets, mismo motivo que arriba.
  var filas = _leerHojaSheetsCruda_('OCUPACION')
    .filter(function(r) { return r.silueta && r.pos !== '' && r.pos !== null && r.pos !== undefined && r.layer; })
    .map(function(r) {
      return {
        silueta: r.silueta, pos: String(r.pos), layer: r.layer,
        pedido: r.pedido || null, tienda: r.tienda || null, flujo: r.flujo || null,
        reservado: _esVerdadero(r.reservado)
      };
    });
  filas = _dedupPorClave(filas, function(f) { return f.silueta + '|' + f.pos + '|' + f.layer; });
  return postgrestUpsertLote_('ocupacion_siluetas', filas, { schema: schema });
}

/** CARGAS → cargas. Mismo mapeo que sincronizarCargaSupabase_ (fecha ya viene como string ISO de new Date().toISOString(), no necesita _fechaSoloDia). */
function exportarCargasHistorico(schema) {
  var filas = leerHoja('CARGAS').map(function(f) {
    return {
      id: f.id, num_carga: String(f.numCarga), fecha: f.fecha ? String(f.fecha).slice(0, 10) : null,
      estado: f.estado, responsable: f.responsable || null, cargador: f.cargador || null,
      fecha_cierre: f.fechaCierre || null
    };
  });
  return postgrestUpsertLote_('cargas', filas, { schema: schema });
}

/**
 * CARGAS.items (JSON embebido) → tabla de unión cargas_pedidos. Reconstruye
 * la MISMA forma que sincronizarCargaPedidoSupabase_(cargaId, pedidoId, idx)
 * -- posicion = índice dentro del array items, no una posición física (ver
 * crearCarga, Backend.gs:1603-1627). Deduplicado por carga_id+pedido_id
 * (PK real de la tabla) -- probado contra staging (2026-08-12): algunas
 * cargas tienen el MISMO pedido repetido dentro de su array items.
 */
function exportarCargasPedidosHistorico(schema) {
  var filas = [];
  leerHoja('CARGAS').forEach(function(c) {
    var items = parseJSON(c.items, []);
    items.forEach(function(item, idx) {
      if (!item || !item.idPedido) return;
      filas.push({ carga_id: c.id, pedido_id: item.idPedido, posicion: idx });
    });
  });
  filas = _dedupPorClave(filas, function(f) { return f.carga_id + '|' + f.pedido_id; });
  return postgrestUpsertLote_('cargas_pedidos', filas, { schema: schema });
}

/** HISTORIAL_ENTREGAS → historial_entregas. Mismo mapeo que sincronizarHistorialEntregasSupabase_. Tabla append-only con id autonumérico en Supabase -- reenviar el histórico completo crea filas NUEVAS cada vez (no hay clave natural para deduplicar), así que esta función NO es segura de re-ejecutar sin más. Se protege igual que retiradas_stock: si el esquema destino ya tiene filas, no hace nada. */
function exportarHistorialEntregasHistorico(schema) {
  var cfg = getSupabaseConfig_();
  if (!cfg) throw new Error('Supabase no configurado');
  var headersGet = { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, 'User-Agent': 'GoogleAppsScript-lm_produccion-migracion' };
  if (schema !== 'public') headersGet['Accept-Profile'] = schema;
  var yaHay = UrlFetchApp.fetch(cfg.url + '/rest/v1/historial_entregas?select=id&limit=1', { method: 'get', headers: headersGet, muteHttpExceptions: true });
  if (yaHay.getResponseCode() < 300 && JSON.parse(yaHay.getContentText()).length) {
    Logger.log('exportarHistorialEntregasHistorico (' + schema + '): ya hay filas en destino, no se reenvía (tabla append-only sin clave natural para deduplicar). Vacía la tabla a mano si quieres repetir el volcado.');
    return { tabla: 'historial_entregas', esquema: schema, total: 0, enviadas: 0, lotes: 0, errores: [], omitido: 'destino no vacío' };
  }
  var filas = leerHoja('HISTORIAL').map(function(r) {
    return {
      pedido: r.pedido || null, tienda: r.tienda || null, transportista: r.transportista || null,
      silueta: r.silueta || null, pos_ini: _numComoTextoONulo(r.posIni), pos_fin: _numComoTextoONulo(r.posFin),
      cargador: r.cargador || null, ts: r.ts || null, confirmado_ts: r.confirmadoTs || null,
      responsable: r.responsable || null
    };
  });
  return postgrestUpsertLote_('historial_entregas', filas, { schema: schema, sinUpsert: true });
}

/** HISTORIAL_TRANSPORTISTA → historial_transportista. Mismo mapeo que sincronizarHistorialTransportistaSupabase_ (esta SÍ tiene id propio de negocio, upsert seguro de re-ejecutar). */
function exportarHistorialTransportistaHistorico(schema) {
  // Fase 3, Pieza 3 (2026-09-04): bypass a Sheets, mismo motivo que arriba.
  var filas = _leerHojaSheetsCruda_('HIST_TRANSP').map(function(f) {
    return {
      id: f.id, id_pedido: f.idPedido || null, ped: f.ped || null, tienda: f.tienda || null,
      transportista: f.transportista || null, flujo: f.flujo || null, evento: f.evento || null,
      fecha: f.fecha || null
    };
  });
  return postgrestUpsertLote_('historial_transportista', filas, { schema: schema });
}

/** VISAS → visas. Mismo mapeo que sincronizarVisaSupabase_. Hoy 0 filas en Sheets (se vacía cada madrugada), así que este exportador normalmente no tiene nada que hacer -- se deja completo por si algún día hay que repetir el volcado con datos presentes. */
function exportarVisasHistorico(schema) {
  var filas = leerHoja('VISAS').map(function(f) {
    return {
      id: f.id, ped: f.ped || null, tienda: f.tienda || null, estado: f.estado || null,
      numero_carga: f.numeroCarga ? String(f.numeroCarga) : null,
      fecha_alta: f.fechaAlta || null, fecha_resuelta: f.fechaResuelta || null,
      motivo_alerta: f.motivoAlerta || null
    };
  });
  return postgrestUpsertLote_('visas', filas, { schema: schema });
}

/** RETIRADAS_STOCK → retiradas_stock. Sin lector/escritor activo en el código (ver memoria) y sin columna id/PK en Supabase -- no hay forma de deduplicar con upsert, así que se protege igual que historial_entregas: si el destino ya tiene filas, no reenvía. */
function exportarRetiradasHistorico(schema) {
  var cfg = getSupabaseConfig_();
  if (!cfg) throw new Error('Supabase no configurado');
  var headersGet = { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, 'User-Agent': 'GoogleAppsScript-lm_produccion-migracion' };
  if (schema !== 'public') headersGet['Accept-Profile'] = schema;
  var yaHay = UrlFetchApp.fetch(cfg.url + '/rest/v1/retiradas_stock?select=pedido&limit=1', { method: 'get', headers: headersGet, muteHttpExceptions: true });
  if (yaHay.getResponseCode() < 300 && JSON.parse(yaHay.getContentText()).length) {
    Logger.log('exportarRetiradasHistorico (' + schema + '): ya hay filas en destino, no se reenvía. Vacía la tabla a mano si quieres repetir el volcado.');
    return { tabla: 'retiradas_stock', esquema: schema, total: 0, enviadas: 0, lotes: 0, errores: [], omitido: 'destino no vacío' };
  }
  var filas = leerHoja('RETIRADAS').map(function(r) {
    return {
      fecha: _fechaSoloDia(r.fecha), tienda: r.tienda || null,
      pedido: r.pedido || null, cliente: r.cliente || null, resultado: r.resultado || null,
      code: r.code || null, ts: r.ts || null
    };
  });
  return postgrestUpsertLote_('retiradas_stock', filas, { schema: schema, sinUpsert: true });
}

/** LOG_ACTIVIDAD → log_actividad. Tabla append-only con id autonumérico, mismo criterio que historial_entregas: protegida contra reenvío si el destino ya tiene filas. Volumen alto (miles de filas) -- es la razón por la que se excluyó de la sincronización EN VIVO de Fase 1 (ver memoria), pero para el volcado histórico de UNA vez entra igual que las demás 9 hojas oficiales. */
function exportarLogActividadHistorico(schema) {
  var cfg = getSupabaseConfig_();
  if (!cfg) throw new Error('Supabase no configurado');
  var headersGet = { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, 'User-Agent': 'GoogleAppsScript-lm_produccion-migracion' };
  if (schema !== 'public') headersGet['Accept-Profile'] = schema;
  var yaHay = UrlFetchApp.fetch(cfg.url + '/rest/v1/log_actividad?select=id&limit=1', { method: 'get', headers: headersGet, muteHttpExceptions: true });
  if (yaHay.getResponseCode() < 300 && JSON.parse(yaHay.getContentText()).length) {
    Logger.log('exportarLogActividadHistorico (' + schema + '): ya hay filas en destino, no se reenvía. Vacía la tabla a mano si quieres repetir el volcado.');
    return { tabla: 'log_actividad', esquema: schema, total: 0, enviadas: 0, lotes: 0, errores: [], omitido: 'destino no vacío' };
  }
  var filas = leerHoja('LOG').map(function(r) {
    return { ts: r.ts || null, tipo: r.tipo || null, detalle: r.detalle || null, usuario: r.usuario || null };
  });
  return postgrestUpsertLote_('log_actividad', filas, { schema: schema, sinUpsert: true });
}

/**
 * Orquestador: ejecuta las 9 exportadoras EN ORDEN contra `staging` y
 * devuelve un resumen conjunto. El orden importa: cargas_pedidos referencia
 * carga_id/pedido_id que deben existir antes en pedidos/cargas para que
 * tenga sentido comprobar los resultados (no hay FK real que lo exija, pero
 * facilita verificar a ojo en el Table Editor). Pensada para ejecutarse UNA
 * vez desde el editor y leer el resumen completo en el log.
 */
function migrarTodoHistoricoAStaging() {
  var resultados = [
    exportarPedidosHistorico('staging'),
    exportarLineasHistorico('staging'),
    exportarOcupacionHistorico('staging'),
    exportarCargasHistorico('staging'),
    exportarCargasPedidosHistorico('staging'),
    exportarHistorialEntregasHistorico('staging'),
    exportarHistorialTransportistaHistorico('staging'),
    exportarVisasHistorico('staging'),
    exportarRetiradasHistorico('staging'),
    exportarLogActividadHistorico('staging')
  ];
  Logger.log('=== RESUMEN VOLCADO HISTÓRICO A STAGING ===');
  var totalErrores = 0;
  resultados.forEach(function(r) {
    totalErrores += r.errores.length;
    Logger.log(r.tabla + ': ' + r.enviadas + '/' + r.total + ' filas OK' + (r.omitido ? ' (omitido: ' + r.omitido + ')' : '') + (r.errores.length ? ' -- ' + r.errores.length + ' LOTE(S) CON ERROR' : ''));
  });
  Logger.log(totalErrores ? ('*** ' + totalErrores + ' lote(s) con error en total -- revisar arriba ***') : '*** Todo OK, cero errores ***');
  return resultados;
}
