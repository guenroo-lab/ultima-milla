/**
 * ============================================================
 * Pieza3Publico.gs · Helper RPC contra el esquema PRODUCCIÓN (public)
 * ============================================================
 * Fase 3 "Pieza 3" -- corte real. Mismo patrón que _rpcStaging_
 * (MigracionFase3Lote1.gs), pero con Accept-Profile/Content-Profile:
 * public -- apunta a datos REALES, no a staging. Usa la misma
 * SUPABASE_SERVICE_KEY (service_role, bypassa RLS, ya con permiso de
 * ejecución otorgado a las 23 funciones promovidas -- ver
 * supabase/migrations/promote_public_lote*).
 *
 * Se activa función por función en Backend.gs, con checkpoint tras cada
 * una -- ver aviso al usuario 2026-09-03 antes de empezar el corte real.
 */
function _rpcPublic_(nombreFuncion, payload) {
  var cfg = getSupabaseConfig_();
  if (!cfg) throw new Error('Supabase no configurado (Propiedades del script vacías)');
  var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/rpc/' + nombreFuncion, {
    method: 'post',
    headers: {
      apikey: cfg.key, Authorization: 'Bearer ' + cfg.key,
      'Content-Type': 'application/json',
      'Accept-Profile': 'public', 'Content-Profile': 'public',
      'User-Agent': 'GoogleAppsScript-lm_produccion-pieza3-public'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var body = resp.getContentText();
  if (resp.getResponseCode() >= 300) {
    throw new Error('_rpcPublic_(' + nombreFuncion + '): HTTP ' + resp.getResponseCode() + ' ' + body.slice(0, 500));
  }
  return body ? JSON.parse(body) : null;
}

/**
 * Petición REST directa contra public (SELECT/INSERT/PATCH/DELETE de tabla,
 * no una RPC) -- mismo patrón que _restStaging_. `tablaConFiltro` incluye el
 * nombre de tabla y, si aplica, el filtro PostgREST tras `?`.
 */
function _restPublic_(metodo, tablaConFiltro, payload, prefer) {
  var cfg = getSupabaseConfig_();
  if (!cfg) throw new Error('Supabase no configurado (Propiedades del script vacías)');
  var opciones = {
    method: metodo,
    headers: {
      apikey: cfg.key, Authorization: 'Bearer ' + cfg.key,
      'Content-Type': 'application/json',
      'Accept-Profile': 'public', 'Content-Profile': 'public',
      'User-Agent': 'GoogleAppsScript-lm_produccion-pieza3-public'
    },
    muteHttpExceptions: true
  };
  if (prefer) opciones.headers.Prefer = prefer;
  else if (metodo === 'post') opciones.headers.Prefer = 'return=representation';
  else if (metodo === 'patch') opciones.headers.Prefer = 'return=minimal';
  if (payload !== undefined) opciones.payload = JSON.stringify(payload);
  var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + tablaConFiltro, opciones);
  var body = resp.getContentText();
  if (resp.getResponseCode() >= 300) {
    throw new Error('_restPublic_(' + metodo + ' ' + tablaConFiltro + '): HTTP ' + resp.getResponseCode() + ' ' + body.slice(0, 500));
  }
  return body ? JSON.parse(body) : null;
}

// ============================================================
// CAPA DE COMPATIBILIDAD Sheets↔Postgres
// ============================================================
// getHoja/leerHoja/actualizarFila/anadirFila/anadirFilas/actualizarColumnaLote
// (EstructuraSheets.gs) son genéricas -- las llamadas ya existentes en
// Backend.gs/otros archivos siguen funcionando SIN tocarlas: solo cambia,
// para cada clave listada en TABLAS_PUBLIC_, DÓNDE leen/escriben.
// Pieza 3 (2026-09-04): PEDIDOS/LINEAS/OCUPACION/HIST_TRANSP.
// Pieza 4a (2026-09-05): + VISAS/HISTORIAL (ambas ya tenían Fase 1 en vivo,
// solo hacía falta el corte de lectura + retirar el doble-escrito).
// Pieza 4b (2026-09-05): + LOG (backfill incremental del hueco 13/08->hoy
// antes de cortar, ver ejecutarBackfillLogActividadPublico en
// MigracionFase2.gs).
// Pieza 4c (2026-09-05): + CARGAS (columna items jsonb nueva + backfill de
// las 461 filas ya existentes, ver ejecutarBackfillItemsCargasPublico en
// MigracionFase2.gs).
// Pieza 4d (2026-09-05): + RETIRADAS (sin escritor/lector activo, ya
// sincronizada 1:1, solo hacía falta añadirle una PK real). Con esto, las
// 9 hojas oficiales de Sheets viven en Postgres -- Sheets queda como copia
// congelada de referencia, ya no recibe escrituras para ninguna clave aquí.
//
// _fila: en Sheets es el nº de fila real. Aquí, para PEDIDOS/LINEAS es el
// `id` real de Postgres (texto). OCUPACION no tiene id propio (PK compuesta
// silueta+pos+layer) -- aquí _fila es esa clave compuesta serializada con
// '|||' (separador que no aparece en esos valores reales).
var TABLAS_PUBLIC_ = {
  PEDIDOS: {
    tabla: 'pedidos',
    campos: {
      id:'id', ped:'ped', tienda:'tienda', transportista:'transportista', flujo:'flujo',
      estado:'estado', pct:'pct', operario:'operario', silueta:'silueta', posIni:'pos_ini',
      posFin:'pos_fin', numeroCarga:'numero_carga', soportes:'soportes', nLin:'n_lin',
      nUbic:'n_ubic', actualizado:'actualizado', intentoCarga:'intento_carga',
      comentario:'comentario', tipoEntrega:'tipo_entrega', enRevision:'en_revision',
      sdImpreso:'sd_impreso', parcial:'parcial'
    },
    clave: 'id'
  },
  LINEAS: {
    tabla: 'lineas_preparacion',
    campos: {
      id:'id', idPedido:'id_pedido', idx:'idx', dir:'dir', ref:'ref', ean:'ean', des:'des',
      ctd:'ctd', tipoUbic:'tipo_ubic', esPicking:'es_picking', estado:'estado', motivo:'motivo',
      operario:'operario', ts:'ts', muelleHecho:'muelle_hecho'
    },
    clave: 'id'
  },
  OCUPACION: {
    tabla: 'ocupacion_siluetas',
    campos: { silueta:'silueta', pos:'pos', layer:'layer', pedido:'pedido', tienda:'tienda', flujo:'flujo', reservado:'reservado' },
    clave: null // PK compuesta -- ver _claveCompuestaOcup_/_filtroPorClave_
  },
  HIST_TRANSP: {
    tabla: 'historial_transportista',
    campos: { id:'id', idPedido:'id_pedido', ped:'ped', tienda:'tienda', transportista:'transportista', flujo:'flujo', evento:'evento', fecha:'fecha' },
    clave: 'id'
  },
  VISAS: {
    // Pieza 4a (2026-09-05): ya tenía sincronización Fase 1 en vivo
    // (sincronizarVisaSupabase_ etc., ahora retirada -- el corte pasa a
    // escribir aquí directamente). id es el mismo id de PEDIDOS (texto).
    tabla: 'visas',
    campos: {
      id:'id', ped:'ped', tienda:'tienda', estado:'estado',
      numeroCarga:'numero_carga', fechaAlta:'fecha_alta',
      fechaResuelta:'fecha_resuelta', motivoAlerta:'motivo_alerta'
    },
    clave: 'id'
  },
  HISTORIAL: {
    // Pieza 4a (2026-09-05): append-only, ya tenía Fase 1 en vivo
    // (sincronizarHistorialEntregasSupabase_, ahora retirada). Sin 'id' en
    // Sheets -- Postgres lo genera solo (bigint identity), por eso NO se
    // mapea id aquí (nunca se lee/escribe desde el código de la app; sin
    // actualizarFila/borrarFila para esta clave, _fila no se usa en la práctica).
    tabla: 'historial_entregas',
    campos: {
      pedido:'pedido', tienda:'tienda', transportista:'transportista', silueta:'silueta',
      posIni:'pos_ini', posFin:'pos_fin', cargador:'cargador', ts:'ts',
      confirmadoTs:'confirmado_ts', responsable:'responsable'
    },
    clave: 'id'
  },
  LOG: {
    // Pieza 4b (2026-09-05): NUNCA tuvo Fase 1 en vivo (volumen demasiado
    // alto, una llamada por cada acción de la app) -- solo el volcado
    // histórico de una vez (13/08) + el backfill incremental que cerró el
    // hueco hasta hoy (ver ejecutarBackfillLogActividadPublico,
    // MigracionFase2.gs) justo antes de este corte. Igual que HISTORIAL, sin
    // 'id' en Sheets -- Postgres lo genera solo.
    tabla: 'log_actividad',
    campos: { ts:'ts', tipo:'tipo', detalle:'detalle', usuario:'usuario' },
    clave: 'id'
  },
  CARGAS: {
    // Pieza 4c (2026-09-05): ya tenía Fase 1 en vivo (sincronizarCargaSupabase_,
    // ahora retirada), pero esa función NUNCA mandó 'items' -- el diseño
    // original apostaba por reconstruirlo vía JOIN con cargas_pedidos, que
    // resultó insuficiente (le falta estado/snapshot por pedido: silueta,
    // posición, soportes... datos que YA NO EXISTEN en el pedido en vivo una
    // vez la carga se cierra). Se optó por columna `items jsonb` en `cargas`
    // (añadida hoy, backfill de las 461 filas ya existentes vía
    // ejecutarBackfillItemsCargasPublico, MigracionFase2.gs) -- mismo trato
    // que 'soportes' en PEDIDOS: array real, nunca ''. `cargas_pedidos` se
    // deja tal cual (nadie la lee desde la app, solo Fase 1 la sigue
    // sincronizando -- vale para SQL/reporting futuro, no se toca).
    tabla: 'cargas',
    campos: {
      id:'id', numCarga:'num_carga', fecha:'fecha', estado:'estado',
      items:'items', responsable:'responsable', cargador:'cargador',
      fechaCierre:'fecha_cierre'
    },
    clave: 'id'
  },
  RETIRADAS: {
    // Pieza 4d (2026-09-05, última pieza): sin escritor NI lector activo en
    // el código hoy -- 11 filas ya sincronizadas 1:1 (volcado histórico único
    // del 13/08, sin cambios desde entonces en ninguno de los 2 lados, así
    // que no hace falta backfill). Añadido `id bigint identity` como PK real
    // (la tabla no tenía ninguna) para poder tratarla igual que el resto --
    // sin 'id' en Sheets, Postgres lo genera solo, igual que LOG/HISTORIAL.
    tabla: 'retiradas_stock',
    campos: {
      fecha:'fecha', tienda:'tienda', pedido:'pedido', cliente:'cliente',
      resultado:'resultado', code:'code', ts:'ts'
    },
    clave: 'id'
  }
};

function _esTablaPublic_(clave) { return !!TABLAS_PUBLIC_[clave]; }

function _claveCompuestaOcup_(obj) {
  return String(obj.silueta) + '|||' + String(obj.pos) + '|||' + String(obj.layer);
}
function _filtroPorFila_(clave, fila) {
  if (clave === 'OCUPACION') {
    var partes = String(fila).split('|||');
    return 'silueta=eq.' + encodeURIComponent(partes[0]) + '&pos=eq.' + encodeURIComponent(partes[1]) + '&layer=eq.' + encodeURIComponent(partes[2]);
  }
  return 'id=eq.' + encodeURIComponent(fila);
}

// snake_case (Postgres) -> camelCase (Sheets), usando el mapa de la tabla.
function _filaPgAObjSheet_(clave, filaPg) {
  var cfg = TABLAS_PUBLIC_[clave];
  var obj = {};
  Object.keys(cfg.campos).forEach(function(camel) {
    var col = cfg.campos[camel];
    var v = filaPg[col];
    obj[camel] = (v === null || v === undefined) ? '' : v;
  });
  obj._fila = (clave === 'OCUPACION') ? _claveCompuestaOcup_(filaPg) : String(filaPg.id);
  return obj;
}

// camelCase (Sheets) -> snake_case (Postgres), solo las claves presentes en cambios.
function _cambiosSheetAPg_(clave, cambios) {
  var cfg = TABLAS_PUBLIC_[clave];
  var out = {};
  Object.keys(cambios).forEach(function(camel) {
    var col = cfg.campos[camel];
    if (!col) return; // campo desconocido para esta tabla -- se ignora, igual que una columna que no existiera en COLUMNAS
    var v = cambios[camel];
    // soportes (PEDIDOS) e items (CARGAS) son siempre array real, nunca ''
    // de verdad -- si algún día llegan vacíos son [] (falsy-ish pero no ''),
    // así que la regla general '' -> null no debe tocarlos.
    out[col] = (v === '' && camel !== 'soportes' && camel !== 'items') ? null : v;
  });
  return out;
}

function leerHojaPublic_(clave) {
  var cfg = TABLAS_PUBLIC_[clave];
  // OCUPACION no tiene id propio -- ordenar solo por 'silueta' (columna NO
  // única, muchas filas por silueta) hacía la paginación insegura de verdad:
  // sin un desempate único, Postgres no garantiza un orden estable entre
  // páginas separadas bajo escritura concurrente (fila saltada o repetida en
  // el límite de página). silueta,pos,layer es la PK compuesta -- único de
  // verdad (revisión adversarial, 2026-09-05; hoy enmascarado porque
  // OCUPACION cabe en una sola página, pero no seguiría siendo seguro si
  // creciera).
  var orderCol = (clave === 'OCUPACION') ? 'silueta,pos,layer' : 'id';
  var filas = _restPublicTodasFilas_(cfg.tabla, orderCol);
  return (filas || []).map(function(f) { return _filaPgAObjSheet_(clave, f); });
}

/**
 * Lectura FILTRADA (un único viaje HTTP, sin paginar -- pensada para "dame la
 * fila con id=X" o "dame las líneas de ESTE pedido", nunca para volcar la
 * tabla entera). Contrapartida de rendimiento real (2026-09-04, encontrado
 * porque el usuario notó la app lenta): `leerHoja(clave).find(...)`/`.filter(...)`
 * sobre una clave migrada pagina la tabla ENTERA (miles de filas, varios
 * viajes HTTP) para acabar quedándose con una sola fila o un puñado -- muy
 * notable en el punto más caliente de la app (abrir un pedido / refrescarlo
 * tras cada marca). `valores` puede ser un solo valor o un array (usa `in.()`).
 */
function leerFilasPublicFiltro_(clave, campoCamel, valores) {
  var cfg = TABLAS_PUBLIC_[clave];
  var col = cfg.campos[campoCamel];
  if (!col) throw new Error('leerFilasPublicFiltro_(' + clave + '): campo desconocido "' + campoCamel + '"');
  var lista = Array.isArray(valores) ? valores : [valores];
  if (!lista.length) return [];
  var orderCol = (clave === 'OCUPACION') ? 'silueta,pos,layer' : 'id';

  // Bug real (2026-09-10, pantalla Muelles): un `id=in.(...)` con TODA la
  // lista va en la URL -- en un día cargado obtenerMuellesHoy pide ~130
  // pedidos, ~8 KB de URL, y UrlFetchApp de Apps Script revienta a los
  // ~2 KB ("Límite excedido: Longitud de URL de URLFetch"). Se trocea la
  // lista en lotes que dejan cada URL muy por debajo de ese tope (60 ids ×
  // ~30 chars codificados + base ~= 1.9 KB). Para una lista corta (el caso
  // normal, 1 pedido) sigue siendo un único viaje, cero cambio.
  var LOTE = 60;
  var todas = [];
  for (var i = 0; i < lista.length; i += LOTE) {
    var trozo = lista.slice(i, i + LOTE);
    var filtro = col + '=in.(' + trozo.map(function(v) { return encodeURIComponent(String(v)); }).join(',') + ')';
    var filas = _restPublic_('get', cfg.tabla + '?select=*&' + filtro + '&order=' + orderCol);
    if (filas && filas.length) todas = todas.concat(filas);
  }
  if (clave !== 'OCUPACION' && lista.length > LOTE) {
    todas.sort(function(a, b) { return String(a.id) < String(b.id) ? -1 : (String(a.id) > String(b.id) ? 1 : 0); });
  }
  return todas.map(function(f) { return _filaPgAObjSheet_(clave, f); });
}

/**
 * Lectura filtrada por una condición PostgREST YA CONSTRUIDA (un único viaje
 * HTTP, sin paginar -- pensada para "no vacío"/"distinto de"/rangos, casos
 * que un simple IN por un campo (leerFilasPublicFiltro_) no cubre).
 * `filtroQS` son columnas reales (snake_case) y valores ya codificados --
 * responsabilidad del llamador. Solo para filtros que reducen el resultado
 * a un puñado de filas (no para volcar media tabla) -- si el resultado
 * pudiera superar el tope "Max Rows" del proyecto, usar leerHojaPublic_ en
 * su lugar (esa sí pagina).
 */
function leerHojaPublicConFiltro_(clave, filtroQS) {
  var cfg = TABLAS_PUBLIC_[clave];
  var orderCol = (clave === 'OCUPACION') ? 'silueta,pos,layer' : 'id';
  var filas = _restPublic_('get', cfg.tabla + '?select=*&' + filtroQS + '&order=' + orderCol);
  return (filas || []).map(function(f) { return _filaPgAObjSheet_(clave, f); });
}

// Bug real (2026-09-04): PostgREST aplica el tope "Max Rows" del proyecto
// aunque el cliente no pida limit -- sin paginar, una tabla con más filas que
// ese tope se trunca en SILENCIO (HTTP 200, sin error), devolviendo solo las
// primeras N filas por 'order'. PEDIDOS/LINEAS/HIST_TRANSP ya tienen miles de
// filas históricas (Postgres nunca se purga como se purgaba Sheets) -- sin
// esto, leerHoja() devolvía un puñado arbitrario de filas (las primeras por
// id) en vez de la hoja entera: dashboard con conteos absurdamente bajos,
// pedidos "invisibles" si su id caía fuera de esa primera página. Pagina con
// Range/Content-Range hasta cubrir la tabla ENTERA, adaptándose sola al tope
// real del proyecto (no hace falta conocerlo).
function _restPublicTodasFilas_(tabla, orderCol) {
  var cfg = getSupabaseConfig_();
  if (!cfg) throw new Error('Supabase no configurado (Propiedades del script vacías)');
  var todas = [];
  var offset = 0;
  while (true) {
    var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + tabla + '?select=*&order=' + orderCol, {
      method: 'get',
      headers: {
        apikey: cfg.key, Authorization: 'Bearer ' + cfg.key,
        'Accept-Profile': 'public',
        'Range-Unit': 'items', 'Range': offset + '-' + (offset + 9999),
        'Prefer': 'count=exact',
        'User-Agent': 'GoogleAppsScript-lm_produccion-pieza3-public'
      },
      muteHttpExceptions: true
    });
    var code = resp.getResponseCode();
    if (code >= 300) throw new Error('_restPublicTodasFilas_(' + tabla + '): HTTP ' + code + ' ' + resp.getContentText().slice(0, 500));
    var pagina = JSON.parse(resp.getContentText() || '[]');
    todas = todas.concat(pagina);
    if (!pagina.length) break;
    var cr = resp.getHeaders()['Content-Range'] || resp.getHeaders()['content-range'] || '';
    var total = Number(String(cr).split('/')[1]);
    offset += pagina.length;
    if (isNaN(total) || offset >= total) break;
  }
  return todas;
}

// Igual que _restPublicTodasFilas_ pero con un filtro PostgREST -- para leer
// TODAS las filas que cumplen ese filtro cuando el resultado también puede
// superar el tope "Max Rows" (p.ej. CIERRE_PEDIDO acumulado de semanas/mes
// para el ranking de operarios). leerHojaPublicConFiltro_ NO pagina -- vale
// para filtros que ya dejan pocas filas (PEDIDOS activos), pero aquí se
// truncaría en silencio el mismo bug que motivó _restPublicTodasFilas_.
function _restPublicFiltradoTodasFilas_(tabla, filtroQS, orderCol) {
  var cfg = getSupabaseConfig_();
  if (!cfg) throw new Error('Supabase no configurado (Propiedades del script vacías)');
  var todas = [];
  var offset = 0;
  while (true) {
    var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + tabla + '?select=*&' + filtroQS + '&order=' + (orderCol || 'id'), {
      method: 'get',
      headers: {
        apikey: cfg.key, Authorization: 'Bearer ' + cfg.key,
        'Accept-Profile': 'public',
        'Range-Unit': 'items', 'Range': offset + '-' + (offset + 9999),
        'Prefer': 'count=exact',
        'User-Agent': 'GoogleAppsScript-lm_produccion-pieza3-public'
      },
      muteHttpExceptions: true
    });
    var code = resp.getResponseCode();
    if (code >= 300) throw new Error('_restPublicFiltradoTodasFilas_(' + tabla + '): HTTP ' + code + ' ' + resp.getContentText().slice(0, 500));
    var pagina = JSON.parse(resp.getContentText() || '[]');
    todas = todas.concat(pagina);
    if (!pagina.length) break;
    var cr = resp.getHeaders()['Content-Range'] || resp.getHeaders()['content-range'] || '';
    var total = Number(String(cr).split('/')[1]);
    offset += pagina.length;
    if (isNaN(total) || offset >= total) break;
  }
  return todas;
}

// Lee LOG filtrado (p.ej. 'tipo=eq.CIERRE_PEDIDO&ts=gte....') paginando
// completo, ya mapeado a objetos estilo Sheets (ts/tipo/detalle/usuario).
function leerLogPublicFiltradoTodasFilas_(filtroQS) {
  var filas = _restPublicFiltradoTodasFilas_(TABLAS_PUBLIC_.LOG.tabla, filtroQS, 'ts');
  return filas.map(function(f) { return _filaPgAObjSheet_('LOG', f); });
}

function actualizarFilaPublic_(clave, fila, cambios) {
  var cfg = TABLAS_PUBLIC_[clave];
  var pg = _cambiosSheetAPg_(clave, cambios);
  _restPublic_('patch', cfg.tabla + '?' + _filtroPorFila_(clave, fila), pg);
}

function anadirFilaPublic_(clave, obj) {
  var cfg = TABLAS_PUBLIC_[clave];
  var pg = _cambiosSheetAPg_(clave, obj);
  var res = _restPublic_('post', cfg.tabla, pg);
  return res && res[0] ? _filaPgAObjSheet_(clave, res[0])._fila : null;
}

function anadirFilasPublic_(clave, objs) {
  if (!objs || !objs.length) return;
  var cfg = TABLAS_PUBLIC_[clave];
  var pg = objs.map(function(obj) { return _cambiosSheetAPg_(clave, obj); });
  _restPublic_('post', cfg.tabla, pg);
}

function actualizarColumnaLotePublic_(clave, filas, nombreCol, valor) {
  if (!filas || !filas.length) return;
  var cfg = TABLAS_PUBLIC_[clave];
  var col = cfg.campos[nombreCol];
  if (!col) return;
  var pg = {}; pg[col] = (valor === '') ? null : valor;
  // Requests en paralelo (fetchAll) -- mismo motivo que _dispararEnParalelo_:
  // un `for` secuencial sería lento para lotes de decenas de filas.
  var supaCfg = getSupabaseConfig_();
  var requests = filas.map(function(fila) {
    return {
      url: supaCfg.url + '/rest/v1/' + cfg.tabla + '?' + _filtroPorFila_(clave, fila),
      method: 'patch',
      headers: {
        apikey: supaCfg.key, Authorization: 'Bearer ' + supaCfg.key,
        'Content-Type': 'application/json',
        'Accept-Profile': 'public', 'Content-Profile': 'public',
        'Prefer': 'return=minimal',
        'User-Agent': 'GoogleAppsScript-lm_produccion-pieza3-public'
      },
      payload: JSON.stringify(pg),
      muteHttpExceptions: true
    };
  });
  var responses = UrlFetchApp.fetchAll(requests);
  responses.forEach(function(r, i) {
    if (r.getResponseCode() >= 300) {
      throw new Error('actualizarColumnaLotePublic_(' + clave + '): HTTP ' + r.getResponseCode() + ' fila ' + filas[i] + ' ' + r.getContentText().slice(0, 300));
    }
  });
}

function borrarFilaPublic_(clave, fila) {
  var cfg = TABLAS_PUBLIC_[clave];
  _restPublic_('delete', cfg.tabla + '?' + _filtroPorFila_(clave, fila), undefined, 'return=minimal');
}
