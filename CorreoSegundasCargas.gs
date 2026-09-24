/**
 * ============================================================
 * CorreoSegundasCargas.gs
 * Correo automático cuando una carga deja pedidos para 2ª carga
 * ============================================================
 *
 * Se dispara desde confirmarEntregas() (al "Finalizar carga"): los pedidos
 * que no se escanearon como entregados pasan a CARGA_2 y se envía este correo
 * a los destinatarios configurados.
 *
 * Sin arrow functions ni template literals (compatibilidad Apps Script V8).
 * El cuerpo HTML usa estilos EN LÍNEA (los clientes de correo ignoran <style>).
 */

// Destinatarios por defecto. Se pueden cambiar sin tocar código guardando un
// JSON en la propiedad 'DEST_SEGUNDAS_CARGAS' (ver setDestinatariosSegundasCargas).
var DESTINATARIOS_SEGUNDAS_CARGAS = [
  'infocorrecaminosmalaga@gmail.com',
  'pedidocliente.alm-malaga@leroymerlin.es',
  'jose-manuel.lachambre@leroymerlin.es'
];

function getDestinatariosSegundasCargas() {
  var raw = PropertiesService.getScriptProperties().getProperty('DEST_SEGUNDAS_CARGAS');
  if (raw) {
    try { var a = JSON.parse(raw); if (a && a.length) return a; } catch (e) {}
  }
  return DESTINATARIOS_SEGUNDAS_CARGAS;
}

function setDestinatariosSegundasCargas(lista) {
  var out = [];
  (lista || []).forEach(function(s) { var n = String(s).trim(); if (n) out.push(n); });
  PropertiesService.getScriptProperties().setProperty('DEST_SEGUNDAS_CARGAS', JSON.stringify(out));
  Logger.log('Destinatarios guardados: ' + out.join(', '));
  return out;
}

// Destinatarios independientes para los pendientes de GruaRemansur (no pasan
// por Correcaminos -- ver enviarCorreosSegundasCargas). Mismo patrón que los
// de arriba: editable sin tocar código guardando un JSON en
// 'DEST_SEGUNDAS_CARGAS_GRUA'.
var DESTINATARIOS_SEGUNDAS_CARGAS_GRUA = [
  'antonia.zambrano@leroymerlin.es',
  'pedidocliente.alm-malaga@leroymerlin.es',
  'jose-manuel.lachambre@leroymerlin.es'
];

function getDestinatariosSegundasCargasGrua() {
  var raw = PropertiesService.getScriptProperties().getProperty('DEST_SEGUNDAS_CARGAS_GRUA');
  if (raw) {
    try { var a = JSON.parse(raw); if (a && a.length) return a; } catch (e) {}
  }
  return DESTINATARIOS_SEGUNDAS_CARGAS_GRUA;
}

function setDestinatariosSegundasCargasGrua(lista) {
  var out = [];
  (lista || []).forEach(function(s) { var n = String(s).trim(); if (n) out.push(n); });
  PropertiesService.getScriptProperties().setProperty('DEST_SEGUNDAS_CARGAS_GRUA', JSON.stringify(out));
  Logger.log('Destinatarios (GruaRemansur) guardados: ' + out.join(', '));
  return out;
}

/**
 * Construye el asunto + cuerpo (HTML y texto plano) del correo de segundas cargas.
 * info = { numCarga, fecha, chofer, cargador, pendientes:[{ped,tienda,transportista,silueta,posIni,posFin,soportes}] }
 */
function construirCorreoSegundasCargas(info) {
  var fecha;
  try { fecha = Utilities.formatDate(new Date(info.fecha || new Date()), 'Europe/Madrid', "dd/MM/yyyy 'a las' HH:mm"); }
  catch (e) { fecha = String(info.fecha || ''); }
  var pendientes = info.pendientes || [];

  var filas = '';
  for (var i = 0; i < pendientes.length; i++) {
    var p = pendientes[i];
    var pos = (Number(p.posIni) === Number(p.posFin)) ? p.posIni : (p.posIni + '-' + p.posFin);
    var sops = '—';
    if (p.soportes && p.soportes.length) {
      var parts = [];
      for (var j = 0; j < p.soportes.length; j++) {
        var s = p.soportes[j];
        parts.push((s.cant || '') + '× ' + esc(s.tipo || s.tipoId || ''));
      }
      sops = parts.join(', ');
    }
    var bg = (i % 2 === 0) ? '#ffffff' : '#f7f7f9';
    var ubic = p.silueta ? (esc(p.silueta) + ' · ' + pos) : '—';
    filas += '<tr style="background:' + bg + '">' +
      '<td style="padding:9px 10px;border-bottom:1px solid #e5e5e5;font-family:monospace;font-size:15px;font-weight:bold;color:#111">' + esc(p.ped) + '</td>' +
      '<td style="padding:9px 10px;border-bottom:1px solid #e5e5e5;font-size:13px;color:#333">' + esc(p.tienda) + '</td>' +
      '<td style="padding:9px 10px;border-bottom:1px solid #e5e5e5;font-size:13px;color:#333">' + esc(p.transportista) + '</td>' +
      '<td style="padding:9px 10px;border-bottom:1px solid #e5e5e5;font-size:14px;font-weight:bold;color:#e30613;text-align:center;white-space:nowrap">' + ubic + '</td>' +
      '<td style="padding:9px 10px;border-bottom:1px solid #e5e5e5;font-size:12px;color:#555">' + sops + '</td>' +
      '</tr>';
  }

  var subject = 'Segundas cargas · Carga ' + info.numCarga + ' · ' + pendientes.length + ' pedido(s) pendientes';

  var html = '' +
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:680px;margin:0 auto;border:1px solid #e0e0e0;border-radius:10px;overflow:hidden">' +
      '<div style="background:#080a10;padding:18px 22px;border-bottom:3px solid #e30613">' +
        '<div style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:.5px">Expedición · Leroy Merlin Málaga</div>' +
        '<div style="color:#e30613;font-size:13px;font-weight:700;margin-top:2px">TAISA Logistics · Pedidos para segunda carga</div>' +
      '</div>' +
      '<div style="padding:20px 22px">' +
        '<p style="font-size:14px;color:#222;margin:0 0 16px">Los siguientes pedidos <b>no salieron</b> en la carga ' + esc(info.numCarga) + ' y quedan pendientes para una <b>segunda carga</b>:</p>' +
        '<div style="background:#f7f7f9;border:1px solid #ececec;border-radius:8px;padding:12px 14px;margin-bottom:16px;font-size:13px;color:#444;line-height:1.7">' +
          '<div><b>Carga:</b> ' + esc(info.numCarga) + '</div>' +
          (info.chofer ? '<div><b>Chofer:</b> ' + esc(info.chofer) + '</div>' : '') +
          (info.cargador ? '<div><b>Cargador:</b> ' + esc(info.cargador) + '</div>' : '') +
          '<div><b>Fecha:</b> ' + fecha + '</div>' +
          '<div><b>Pedidos pendientes:</b> ' + pendientes.length + '</div>' +
        '</div>' +
        '<table style="width:100%;border-collapse:collapse;border:1px solid #e5e5e5">' +
          '<thead><tr style="background:#e30613">' +
            '<th style="padding:9px 10px;text-align:left;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Nº Pedido</th>' +
            '<th style="padding:9px 10px;text-align:left;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Tienda</th>' +
            '<th style="padding:9px 10px;text-align:left;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Transportista</th>' +
            '<th style="padding:9px 10px;text-align:center;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Silueta · Pos.</th>' +
            '<th style="padding:9px 10px;text-align:left;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Soportes</th>' +
          '</tr></thead>' +
          '<tbody>' + filas + '</tbody>' +
        '</table>' +
        '<p style="font-size:11px;color:#999;margin-top:18px">Correo automático del sistema de expedición de última milla · LM Málaga (TAISA Logistics). No responder a este mensaje.</p>' +
      '</div>' +
    '</div>';

  var plano = 'SEGUNDAS CARGAS - Carga ' + info.numCarga + ' (' + fecha + ')\n' +
    (info.chofer ? 'Chofer: ' + info.chofer + '\n' : '') +
    (info.cargador ? 'Cargador: ' + info.cargador + '\n' : '') +
    'Pedidos pendientes: ' + pendientes.length + '\n\n';
  for (var k = 0; k < pendientes.length; k++) {
    var pp = pendientes[k];
    var pos2 = (Number(pp.posIni) === Number(pp.posFin)) ? pp.posIni : (pp.posIni + '-' + pp.posFin);
    plano += '- ' + pp.ped + ' | ' + pp.tienda + ' | ' + pp.transportista + ' | ' +
      (pp.silueta ? (pp.silueta + ' ' + pos2) : '(sin silueta)') + '\n';
  }

  return { subject: subject, htmlBody: html, plainBody: plano };
}

/**
 * Envía el correo de segundas cargas a los destinatarios configurados.
 * Se llama automáticamente desde confirmarEntregas() (vía
 * enviarCorreosSegundasCargas, que reparte por grupo de transportista).
 * destinatariosOverride (opcional): lista de direcciones a usar en vez de
 * getDestinatariosSegundasCargas() -- la usa enviarCorreosSegundasCargas para
 * el grupo de GruaRemansur.
 */
function enviarCorreoSegundasCargas(info, destinatariosOverride) {
  try {
    var dest = destinatariosOverride || getDestinatariosSegundasCargas();
    if (!dest || !dest.length) return { ok: false, error: 'Sin destinatarios configurados' };
    var msg = construirCorreoSegundasCargas(info);
    MailApp.sendEmail({
      to: dest.join(','),
      subject: msg.subject,
      htmlBody: msg.htmlBody,
      body: msg.plainBody,
      name: 'Expedición LM Málaga · TAISA'
    });
    if (typeof logActividad === 'function') {
      logActividad('CORREO_SEGUNDAS', 'Carga ' + info.numCarga + ' · ' + (info.pendientes ? info.pendientes.length : 0) + ' pedidos → ' + dest.length + ' destinatarios', info.cargador || '');
    }
    return { ok: true, destinatarios: dest.length };
  } catch (e) {
    console.error('Error enviando correo de segundas cargas:', e);
    if (typeof logActividad === 'function') logActividad('CORREO_SEGUNDAS_ERROR', e.toString(), '');
    return { ok: false, error: e.toString() };
  }
}

/**
 * Reparte los pendientes de 2ª carga por grupo de transportista y manda un
 * correo por cada grupo que tenga pendientes de verdad -- GruaRemansur no
 * pasa por Correcaminos, así que sus pendientes van a destinatarios
 * distintos (ver getDestinatariosSegundasCargasGrua) y nunca deben
 * mezclarse con los del resto de transportistas en el mismo correo. Si una
 * carga es de un solo grupo (el caso normal), se manda un único correo,
 * igual que antes de existir esta función.
 * infoBase: mismo shape que construirCorreoSegundasCargas espera, salvo que
 * infoBase.pendientes puede mezclar transportistas -- aquí se separan.
 */
function enviarCorreosSegundasCargas(infoBase) {
  var pendientes = infoBase.pendientes || [];
  var deGrua = pendientes.filter(function(p) { return p.transportista === 'GruaRemansur'; });
  var resto = pendientes.filter(function(p) { return p.transportista !== 'GruaRemansur'; });
  var resultados = [];
  if (deGrua.length) {
    resultados.push(enviarCorreoSegundasCargas(
      Object.assign({}, infoBase, { pendientes: deGrua }),
      getDestinatariosSegundasCargasGrua()
    ));
  }
  if (resto.length) {
    resultados.push(enviarCorreoSegundasCargas(Object.assign({}, infoBase, { pendientes: resto })));
  }
  return {
    ok: resultados.length > 0 && resultados.every(function(r) { return r.ok; }),
    correos: resultados
  };
}

/**
 * AUTORIZA el permiso de envío de correo y manda un correo de PRUEBA.
 * Ejecutar UNA VEZ desde el editor de Apps Script: la primera vez Google pedirá
 * permiso para enviar correos en tu nombre (acéptalo). Envía un ejemplo con datos
 * ficticios a pedro.gil@ext.leroymerlin.es para ver el formato.
 */
function autorizarYProbarCorreo() {
  return _enviarPruebaCorreo('pedro.gil@ext.leroymerlin.es');
}

/**
 * Versión llamable desde la app (botón "Probar correo"). Requiere que el permiso
 * de correo ya esté concedido (ejecutar autorizarYProbarCorreo desde el editor
 * la primera vez).
 */
function probarCorreoSegundasCargas(destino) {
  return _enviarPruebaCorreo(destino || 'pedro.gil@ext.leroymerlin.es');
}

function _enviarPruebaCorreo(destino) {
  var info = {
    numCarga: 99,
    fecha: new Date().toISOString(),
    chofer: 'Correcaminos · 1234-ABC',
    cargador: 'Pedro Gil',
    pendientes: [
      { ped: '942687', tienda: 'Málaga',   transportista: 'Correcaminos',     silueta: 'C', posIni: 4,  posFin: 5,  soportes: [{ tipo: 'Palet Euro', cant: 2 }] },
      { ped: '274601', tienda: 'Marbella',  transportista: 'Correcaminos PRO', silueta: 'A', posIni: 9,  posFin: 9,  soportes: [{ tipo: 'Jaula', cant: 1 }] },
      { ped: '936120', tienda: 'Mijas',     transportista: 'Remansur',         silueta: 'F', posIni: 12, posFin: 13, soportes: [{ tipo: 'Palet Doble', cant: 1 }] }
    ]
  };
  var msg = construirCorreoSegundasCargas(info);
  var aviso = '<div style="background:#fff3cd;border:1px solid #ffe69c;border-radius:8px;padding:10px 14px;font-family:Arial;font-size:13px;color:#664d03;max-width:680px;margin:0 auto 14px">' +
    '⚠️ <b>Correo de PRUEBA</b> con datos de ejemplo, solo para ver el formato. ' +
    'Los reales se enviarán automáticamente a Correcaminos y Leroy Merlin cuando una carga deje pedidos para segunda carga.</div>';
  try {
    MailApp.sendEmail({
      to: destino,
      subject: '[PRUEBA] ' + msg.subject,
      htmlBody: aviso + msg.htmlBody,
      body: '[PRUEBA - datos de ejemplo]\n\n' + msg.plainBody,
      name: 'Expedición LM Málaga · TAISA'
    });
    Logger.log('✓ Correo de prueba enviado a ' + destino);
    return { ok: true, destino: destino };
  } catch (e) {
    Logger.log('✗ Error: ' + e.toString());
    return { ok: false, error: e.toString() };
  }
}
