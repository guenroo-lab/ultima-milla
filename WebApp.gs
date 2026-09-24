/**
 * ============================================================
 * WebApp.gs
 * Punto de entrada de la aplicación web (doGet)
 * ============================================================
 *
 * IMPORTANTE: doGet NUNCA debe hacer operaciones lentas de Sheets.
 * Solo sirve el HTML. Los datos se piden después vía google.script.run.
 *
 * URL de despliegue:
 *   ...?vista=app        → app principal (operario, carga, buscador)
 *   ...?vista=dashboard  → dashboard TV de pared
 */

function doGet(e) {
  var vista = (e && e.parameter && e.parameter.vista) ? e.parameter.vista : 'app';

  // Dashboard TV: archivo propio (pantalla completa, para la pared).
  if (vista === 'dashboard') {
    return HtmlService.createTemplateFromFile('Dashboard').evaluate()
      .setTitle('LM Málaga · Pantalla')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
      .setFaviconUrl('https://www.google.com/favicon.ico');
  }

  // Importador embebible (se incrusta en la pestaña "Importar" del panel admin).
  if (vista === 'importador') {
    return HtmlService.createTemplateFromFile('Clasificador').evaluate()
      .setTitle('Importar pedidos')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
  }

  // Página mínima para el robot de inventarios: se abre en el navegador YA
  // autenticado (sesión de Google del dominio), y el propio robot hace clic
  // en "Seleccionar archivo" -- así se sube por google.script.run (con
  // sesión real) sin depender de un despliegue público, que Adeo bloquea a
  // nivel de política de Workspace.
  if (vista === 'subirInventarioRobot') {
    var tSubida = HtmlService.createTemplateFromFile('SubirInventarioRobot');
    tSubida.token = getOCrearTokenRobotInventario();
    return tSubida.evaluate().setTitle('Robot Inventarios');
  }

  // Pagina generica de subida para TOM y StockSearch (Power BI): mismo
  // patron que subirInventarioRobot -- se abre en el navegador ya
  // autenticado y el propio robot hace clic en "Seleccionar archivo".
  if (vista === 'subirArchivoRobot') {
    var tArchivo = HtmlService.createTemplateFromFile('SubirArchivoRobot');
    tArchivo.token = getOCrearTokenRobotArchivo();
    tArchivo.destino = (e.parameter.destino || '');
    return tArchivo.evaluate().setTitle('Robot Archivos');
  }

  // El resto es Index.html en dos modos:
  //   - 'admin'    (?vista=admin / ?vista=clasificador): importar + cargas + pantalla
  //   - 'operario' (por defecto, ?vista=app): operario + buscar
  var modo = (vista === 'admin' || vista === 'clasificador') ? 'admin' : 'operario';
  var t = HtmlService.createTemplateFromFile('Index');
  t.modo = modo;
  t.execUrl = ScriptApp.getService().getUrl();
  return t.evaluate()
    .setTitle(modo === 'admin' ? 'LM Málaga · Administración' : 'LM Málaga · Operario')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
    .setFaviconUrl('https://www.google.com/favicon.ico');
}

/**
 * Permite incluir archivos HTML parciales con <?!= include('archivo') ?>
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

