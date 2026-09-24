/**
 * ============================================================
 * SnapshotDiario.gs
 * Archivo diario PERMANENTE de pedidos por tienda, en Drive
 * ============================================================
 *
 * Cada día laborable (lunes a viernes), a las 23:00, se crea un Google Sheet
 * nuevo con el estado de TODOS los pedidos del día, agrupados por tienda, y
 * se guarda en Drive dentro de una carpeta por MES → SEMANA. Es un archivo
 * PERMANENTE (no se borra solo): sirve de histórico para revisar que se ha
 * sacado todo y en qué estado quedó cada pedido.
 *
 * INSTALACIÓN (una sola vez, desde el editor de Apps Script):
 *   Ejecutar instalarTriggerSnapshots()
 * Para generar un archivo AHORA MISMO sin esperar al disparador diario:
 *   Ejecutar probarSnapshotAhora()
 */

var SNAPSHOT_HORA_EJECUCION = 23; // hora del día (0-23), huso del proyecto (Europe/Madrid)
var ARCHIVO_NOMBRE_CARPETA_RAIZ = 'Archivo de pedidos · LM Málaga';

function getSnapshotFolderId() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SNAPSHOT_FOLDER_ID');
  if (id) {
    try {
      var f = DriveApp.getFolderById(id);
      if (f.getName() !== ARCHIVO_NOMBRE_CARPETA_RAIZ) { try { f.setName(ARCHIVO_NOMBRE_CARPETA_RAIZ); } catch (e2) {} }
      return id;
    } catch (e) { /* el id guardado ya no es válido: se recrea abajo */ }
  }
  var folder = DriveApp.createFolder(ARCHIVO_NOMBRE_CARPETA_RAIZ);
  props.setProperty('SNAPSHOT_FOLDER_ID', folder.getId());
  return folder.getId();
}

function esFinDeSemana(fecha) {
  var dia = fecha.getDay(); // 0=domingo, 6=sábado
  return dia === 0 || dia === 6;
}

// Encuentra (o crea) una subcarpeta por nombre dentro de 'padre'.
function carpetaOCrear(padre, nombre) {
  var it = padre.getFoldersByName(nombre);
  if (it.hasNext()) return it.next();
  return padre.createFolder(nombre);
}

// "Semana N" DENTRO DEL MES (empieza a contar en el lunes de la semana del
// día 1). Devuelve {numero, lunes}.
function semanaDelMes(fecha) {
  var primerDiaMes = new Date(fecha.getFullYear(), fecha.getMonth(), 1);
  var diaSemana = fecha.getDay();
  var offset = (diaSemana === 0) ? 6 : diaSemana - 1;
  var lunesDeFecha = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate() - offset);
  var diaSemanaPrimero = primerDiaMes.getDay();
  var offsetPrimero = (diaSemanaPrimero === 0) ? 6 : diaSemanaPrimero - 1;
  var lunesDePrimero = new Date(primerDiaMes.getFullYear(), primerDiaMes.getMonth(), primerDiaMes.getDate() - offsetPrimero);
  var diffSemanas = Math.round((lunesDeFecha.getTime() - lunesDePrimero.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return { numero: diffSemanas + 1, lunes: lunesDeFecha };
}

/**
 * Devuelve (creando si hace falta) la carpeta Mes → Semana donde debe ir el
 * archivo de una fecha concreta.
 */
function carpetaDelDia(fecha) {
  var raiz = DriveApp.getFolderById(getSnapshotFolderId());
  var MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  var nombreMes = Utilities.formatDate(fecha, 'Europe/Madrid', 'yyyy-MM') + ' ' + MESES[fecha.getMonth()];
  var carpetaMes = carpetaOCrear(raiz, nombreMes);

  var sem = semanaDelMes(fecha);
  var viernes = new Date(sem.lunes.getFullYear(), sem.lunes.getMonth(), sem.lunes.getDate() + 4);
  var rango = Utilities.formatDate(sem.lunes, 'Europe/Madrid', 'dd/MM') + '–' + Utilities.formatDate(viernes, 'Europe/Madrid', 'dd/MM');
  var nombreSemana = 'Semana ' + sem.numero + ' (' + rango + ')';
  return carpetaOCrear(carpetaMes, nombreSemana);
}

/**
 * Función que llama el disparador diario: comprueba si ya toca la purga
 * periódica de pedidos antiguos (cada PURGA_INTERVALO_DIAS, ver más abajo) y
 * la sincronización con Supabase.
 */
function procesoDiarioSnapshots() {
  var hoy = new Date();
  if (esFinDeSemana(hoy)) return;
  // Snapshot diario a Drive DESACTIVADO (2026-09-05, a petición del usuario:
  // "nadie lo revisa"). Alimentaba el botón "🗄️ Archivo de pedidos" del
  // panel admin, ya quitado en v216 por la misma razón ("no sirve para nada
  // hoy") -- sin botón, nadie tenía forma de abrir la carpeta desde la app.
  // Su otra razón original (respaldo antes de purgar) tampoco aplica ya, con
  // la purga automática también desactivada (ver más abajo). `generarSnapshotPedidos()`
  // se deja intacta por si algún día hace falta generar un archivo a mano
  // (`probarSnapshotAhora()`).
  // Purga automática de pedidos antiguos DESACTIVADA (2026-09-05, a petición
  // del usuario) -- análisis real de capacidad de Supabase (plan free, 500 MB)
  // muestra ~32 MB usados y un ritmo de crecimiento de ~1.3 MB/semana: quedan
  // años de margen antes de que el límite del plan sea un problema real. La
  // purga se diseñó originalmente por rendimiento de Sheets (hojas enteras
  // creciendo sin límite), motivo que ya no aplica igual ahora que PEDIDOS/
  // LINEAS viven en Postgres con lectura filtrada. `ejecutarPurgaSiToca()`/
  // `purgarPedidosAntiguos()`/`probarPurgaAhora()` (más abajo y en Backend.gs)
  // se dejan intactas por si algún día hace falta volver a activarla o
  // lanzarla a mano -- solo se quita esta llamada automática diaria.
  try { verificarSincronizacionSupabase(); }
  catch (e) { logActividad('SYNC_CHECK_ERROR', 'Al comprobar sincronización Supabase: ' + e.toString(), ''); }
}

/**
 * Prueba manual: lanza AHORA MISMO la comprobación nocturna de sincronización
 * con Supabase (Fase 1 de la migración, Backend.gs), sin esperar al
 * disparador ni comprobar fin de semana. Solo lee, no toca nada. Mirar el
 * resultado en el Registro de ejecución o en LOG_ACTIVIDAD (tipo
 * SYNC_CHECK_OK / SYNC_CHECK_DIVERGENCIA).
 */
function probarVerificacionSincronizacionAhora() {
  var r = verificarSincronizacionSupabase();
  Logger.log(JSON.stringify(r, null, 2));
  return r;
}

// ============================================================
// PURGA PERIÓDICA DE PEDIDOS ANTIGUOS (cada PURGA_INTERVALO_DIAS)
// ============================================================
var PURGA_INTERVALO_DIAS = 90;

/**
 * Comprueba si han pasado ya PURGA_INTERVALO_DIAS desde la última purga
 * (guardado en PropertiesService) y, si toca, ejecuta purgarPedidosAntiguos()
 * (Backend.gs). Se llama desde el propio disparador diario de snapshots —
 * así no hace falta instalar un segundo disparador solo para esto. El
 * histórico de lo purgado sigue disponible en el archivo diario de Drive.
 */
function ejecutarPurgaSiToca() {
  var props = PropertiesService.getScriptProperties();
  var ultimaStr = props.getProperty('ULTIMA_PURGA_PEDIDOS');
  var ahora = new Date();
  if (ultimaStr) {
    var ultima = new Date(ultimaStr);
    var diasDesde = (ahora.getTime() - ultima.getTime()) / (24 * 60 * 60 * 1000);
    if (diasDesde < PURGA_INTERVALO_DIAS) return { ok: true, ejecutado: false };
  }
  var r = purgarPedidosAntiguos();
  props.setProperty('ULTIMA_PURGA_PEDIDOS', ahora.toISOString());
  return { ok: true, ejecutado: true, resultado: r };
}

/**
 * Prueba manual (desde el editor): fuerza la purga AHORA MISMO, sin esperar
 * a que toquen los PURGA_INTERVALO_DIAS, y actualiza igualmente la fecha de
 * "última purga" guardada. IMPORTANTE: ejecutar solo entre 22:00 y 06:00
 * (confirmado por el usuario: la operativa está cerrada en ese tramo, nadie
 * gestiona nada) — ver el riesgo residual documentado en purgarPedidosAntiguos
 * (Backend.gs) sobre desplazamiento de números de fila.
 */
function probarPurgaAhora() {
  var r = purgarPedidosAntiguos();
  PropertiesService.getScriptProperties().setProperty('ULTIMA_PURGA_PEDIDOS', new Date().toISOString());
  Logger.log('✓ Purga de prueba ejecutada: ' + JSON.stringify(r));
  return r;
}

/**
 * Genera el Google Sheet de hoy con los pedidos agrupados por tienda, dentro
 * de la carpeta Mes → Semana correspondiente. Devuelve la URL del archivo.
 */
function generarSnapshotPedidos() {
  var pedidos = leerHoja('PEDIDOS');
  var lineasPorPedido = agruparLineasPorPedido();
  var fechaHoy = new Date();
  var nombreArchivo = Utilities.formatDate(fechaHoy, 'Europe/Madrid', 'yyyy-MM-dd');
  var horaGeneracion = Utilities.formatDate(fechaHoy, 'Europe/Madrid', "dd/MM/yyyy 'a las' HH:mm");

  var nombreSoporte = {};
  CONFIG.SOPORTES.forEach(function(s) { nombreSoporte[s.id] = s.nombre; });

  var ORDEN_ESTADO = {
    PENDIENTE: 0, EN_PREPARACION: 1, PARCIAL_LISTO: 2,
    COMPLETADO_LISTO: 3, COMPLETADO: 3, CARGA_2: 4, ENTREGADO: 5,
    DEVUELTO_ALMACEN: 6, ENVIADO_TIENDA: 6, SALIDA_MANUAL: 6, CERRADO_SIN_SILUETA: 6
  };
  function ordenDe(p) { return ORDEN_ESTADO.hasOwnProperty(p.estado) ? ORDEN_ESTADO[p.estado] : 7; }

  // Agrupar por tienda (las conocidas primero, cualquier otro valor se añade igual).
  var grupos = {};
  var ordenTiendas = CONFIG.TIENDAS.slice();
  pedidos.forEach(function(p) {
    var t = p.tienda || 'Sin tienda';
    if (ordenTiendas.indexOf(t) === -1) ordenTiendas.push(t);
    if (!grupos[t]) grupos[t] = [];
    grupos[t].push(p);
  });

  var nombreCompleto = 'Pedidos ' + nombreArchivo;
  var folder = carpetaDelDia(fechaHoy);

  // Al ser un archivo PERMANENTE (ya no se autoborra), si ya existe uno con
  // este mismo nombre en la carpeta del día (p.ej. se generó a mano dos veces,
  // o el disparador se disparó por duplicado), lo mandamos a la papelera antes
  // de crear el nuevo — así nunca quedan dos "Pedidos AAAA-MM-DD" confundiendo
  // cuál es el bueno.
  var existentes = folder.getFilesByName(nombreCompleto);
  while (existentes.hasNext()) {
    try { existentes.next().setTrashed(true); } catch (e) {}
  }

  var ss = SpreadsheetApp.create(nombreCompleto);
  // SpreadsheetApp.create() deja el archivo en la raíz de Drive: lo movemos a
  // la carpeta Mes → Semana que corresponda.
  var archivo = DriveApp.getFileById(ss.getId());
  folder.addFile(archivo);
  try { DriveApp.getRootFolder().removeFile(archivo); } catch (e) {}

  var cab = ['Nº Pedido', 'Transportista', 'Flujo', 'Estado', 'Tipo', 'Silueta', 'Posición', 'Soportes', 'Ubicaciones', 'Operario', 'Actualizado'];

  // --- Pestaña de Resumen (primera) ---
  var resumen = ss.getSheets()[0];
  resumen.setName('Resumen');
  var cabResumen = ['Tienda', 'Total', 'Pendiente', 'En preparación', 'Listo', 'Carga 2', 'Entregado', 'Resuelto (manual)'];
  var filasResumen = [cabResumen];
  ordenTiendas.forEach(function(t) {
    var lista = grupos[t] || [];
    var c = { PENDIENTE: 0, EN_PREPARACION: 0, LISTO: 0, CARGA_2: 0, ENTREGADO: 0, RESUELTO: 0 };
    lista.forEach(function(p) {
      if (p.estado === 'PENDIENTE') c.PENDIENTE++;
      else if (p.estado === 'EN_PREPARACION') c.EN_PREPARACION++;
      else if (p.estado === 'PARCIAL_LISTO' || p.estado === 'COMPLETADO_LISTO' || p.estado === 'COMPLETADO') c.LISTO++;
      else if (p.estado === 'CARGA_2') c.CARGA_2++;
      else if (p.estado === 'ENTREGADO') c.ENTREGADO++;
      else if (p.estado === 'DEVUELTO_ALMACEN' || p.estado === 'ENVIADO_TIENDA' || p.estado === 'SALIDA_MANUAL' || p.estado === 'CERRADO_SIN_SILUETA') c.RESUELTO++;
    });
    filasResumen.push([t, lista.length, c.PENDIENTE, c.EN_PREPARACION, c.LISTO, c.CARGA_2, c.ENTREGADO, c.RESUELTO]);
  });
  resumen.getRange(1, 1).setValue('Archivo generado: ' + horaGeneracion).setFontStyle('italic').setFontColor('#6b7899');
  resumen.getRange(3, 1, filasResumen.length, cabResumen.length).setValues(filasResumen);
  resumen.getRange(3, 1, 1, cabResumen.length).setFontWeight('bold').setBackground('#e30613').setFontColor('#ffffff');
  resumen.setFrozenRows(3);
  try { resumen.autoResizeColumns(1, cabResumen.length); } catch (e) {}

  // --- Una pestaña por tienda, con TODOS sus pedidos ---
  ordenTiendas.forEach(function(t) {
    var lista = (grupos[t] || []).slice();
    lista.sort(function(a, b) {
      var oa = ordenDe(a), ob = ordenDe(b);
      if (oa !== ob) return oa - ob;
      return String(a.ped).localeCompare(String(b.ped));
    });
    var hoja = ss.insertSheet(t);
    var filas = [cab];
    lista.forEach(function(p) {
      var sops = parseJSON(p.soportes, []);
      var sopsTxt = (sops && sops.length) ? sops.map(function(s) {
        return (s.cant || '') + '× ' + (nombreSoporte[s.tipoId] || s.tipoId || '');
      }).join(', ') : '';
      var pos = '';
      if (p.silueta) {
        if (Number(p.posIni) === 0) {
          pos = '0 (bulto)';
        } else {
          pos = String(p.posIni || '');
          if (p.posFin && String(p.posFin) !== String(p.posIni)) pos += '–' + p.posFin;
        }
      }
      filas.push([
        p.ped, p.transportista, (CONFIG.FLUJO_LABEL[p.flujo] || p.flujo),
        (ESTADO_LABEL[p.estado] || p.estado), tipoParcialCompleto(p, lineasPorPedido),
        p.silueta || '', pos, sopsTxt,
        p.nUbic || '', p.operario || '',
        p.actualizado ? String(p.actualizado).replace('T', ' ').substring(0, 16) : ''
      ]);
    });
    hoja.getRange(1, 1, filas.length, cab.length).setValues(filas);
    hoja.getRange(1, 1, 1, cab.length).setFontWeight('bold').setBackground('#e30613').setFontColor('#ffffff');
    hoja.setFrozenRows(1);
    try { hoja.autoResizeColumns(1, cab.length); } catch (e) {}
  });

  logActividad('SNAPSHOT_CREADO', 'Archivo ' + nombreArchivo + ' · ' + pedidos.length + ' pedidos', '');
  return ss.getUrl();
}

/**
 * Devuelve la URL de la carpeta RAÍZ del archivo de pedidos (la crea si
 * todavía no existe). Dentro están las carpetas por mes → semana. Usada por
 * el botón "🗄️ Archivo de pedidos" del panel de administración.
 */
function obtenerLinkSnapshots() {
  var folder = DriveApp.getFolderById(getSnapshotFolderId());
  return folder.getUrl();
}

/**
 * INSTALAR (una sola vez, desde el editor): crea el disparador diario que
 * genera el archivo de cada día laborable. Seguro de volver a ejecutar: quita
 * cualquier disparador anterior de esta misma función antes de crear el
 * nuevo (no duplica). IMPORTANTE: si ya lo instalaste antes de este cambio
 * (a las 22:00), vuelve a ejecutar esta función para que pase a las 23:00.
 */
function instalarTriggerSnapshots() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(t) {
    if (t.getHandlerFunction() === 'procesoDiarioSnapshots') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('procesoDiarioSnapshots')
    .timeBased()
    .everyDays(1)
    .atHour(SNAPSHOT_HORA_EJECUCION)
    .create();
  Logger.log('✓ Disparador diario instalado (se ejecuta sobre las ' + SNAPSHOT_HORA_EJECUCION + ':00, de lunes a viernes).');
  return 'OK';
}

/**
 * Prueba manual: genera un archivo AHORA MISMO (sin esperar al disparador ni
 * comprobar si es fin de semana) y devuelve su URL.
 */
function probarSnapshotAhora() {
  var url = generarSnapshotPedidos();
  Logger.log('✓ Archivo de prueba creado: ' + url);
  return url;
}
