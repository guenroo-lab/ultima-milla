/**
 * ============================================================
 * NotificacionesChat.gs
 * Envío de incidencias al espacio de Google Chat vía webhook
 * ============================================================
 *
 * CÓMO OBTENER EL WEBHOOK (una sola vez):
 * 1. Abre Google Chat → entra al Espacio donde quieres recibir avisos
 * 2. Nombre del espacio (arriba) → "Aplicaciones e integraciones"
 * 3. "Añadir webhooks" → ponle un nombre (ej: "Incidencias Almacén")
 * 4. Copia la URL y ejecuta UNA VEZ desde el editor: configurarWebhook('LA_URL')
 *    (se guarda en PropertiesService; no se hardcodea aquí)
 *
 * Esa URL es secreta: cualquiera con ella puede publicar en el espacio.
 */

/**
 * Envía una notificación de incidencia al espacio de Chat.
 * Llamada desde el frontend con google.script.run.enviarNotificacionChat(datos)
 *
 * datos = { pedido, ubicacion, motivo, operario, hora }
 */
function enviarNotificacionChat(datos) {
  try {
    var url = getWebhookChat();
    if (!url) {
      if (typeof logActividad === 'function') logActividad('NOTIF_CHAT_SKIP', 'Sin webhook configurado', datos.operario);
      return { ok: false, error: 'Webhook no configurado' };
    }

    // Mensaje con formato de tarjeta (card) para que se vea limpio en Chat
    var payload = {
      cardsV2: [{
        cardId: 'incidencia-' + new Date().getTime(),
        card: {
          header: {
            title: '⚠️ Incidencia de preparación',
            subtitle: 'No localizado · ' + datos.motivo,
            imageType: 'CIRCLE'
          },
          sections: [{
            widgets: [
              { decoratedText: { topLabel: 'Pedido',    text: '<b>' + datos.pedido + '</b>' } },
              { decoratedText: { topLabel: 'Ubicación', text: datos.ubicacion } },
              { decoratedText: { topLabel: 'Motivo',    text: datos.motivo } },
              { decoratedText: { topLabel: 'Operario',  text: datos.operario } },
              { decoratedText: { topLabel: 'Hora',      text: datos.hora } }
            ]
          }]
        }
      }]
    };

    var opciones = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    var resp = UrlFetchApp.fetch(url, opciones);
    var code = resp.getResponseCode();

    if (typeof logActividad === 'function') logActividad('NOTIF_CHAT', 'Pedido ' + datos.pedido + ' · ' + datos.motivo + ' (HTTP ' + code + ')', datos.operario);
    return { ok: code === 200, code: code };

  } catch (e) {
    console.error('Error enviando a Chat:', e);
    if (typeof logActividad === 'function') logActividad('NOTIF_CHAT_ERROR', e.toString(), datos.operario);
    return { ok: false, error: e.toString() };
  }
}

/**
 * Alternativa: mensaje de texto simple (sin tarjeta).
 * Úsala si prefieres algo más sencillo.
 */
function enviarNotificacionChatTexto(datos) {
  const texto = '⚠️ *Incidencia · No localizado*\n' +
    '• *Pedido:* ' + datos.pedido + '\n' +
    '• *Ubicación:* ' + datos.ubicacion + '\n' +
    '• *Motivo:* ' + datos.motivo + '\n' +
    '• *Operario:* ' + datos.operario + '\n' +
    '• *Hora:* ' + datos.hora;

  const opciones = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: texto }),
    muteHttpExceptions: true
  };

  try {
    var url = getWebhookChat();
    if (!url) return { ok: false, error: 'Webhook no configurado' };
    var resp = UrlFetchApp.fetch(url, opciones);
    return { ok: resp.getResponseCode() === 200 };
  } catch (e) {
    console.error(e);
    return { ok: false, error: e.toString() };
  }
}

/**
 * Función de prueba: ejecútala desde el editor de Apps Script
 * para comprobar que el webhook funciona antes de usarlo en la app.
 */
function probarNotificacion() {
  const r = enviarNotificacionChat({
    pedido: '942687',
    ubicacion: '29031',
    motivo: 'No encontrado',
    operario: 'Pedro Gil',
    hora: new Date().toLocaleString('es-ES')
  });
  Logger.log(r);
}

/**
 * Guarda la URL del webhook en las propiedades del script.
 * Ejecutar UNA VEZ desde el editor: configurarWebhook('https://chat.googleapis.com/...')
 */
function configurarWebhook(url) {
  setWebhookChat(url);
  Logger.log('Webhook configurado.');
  return 'OK';
}

/**
 * Guarda el webhook desde la app (panel admin). Devuelve si quedó configurado.
 */
function guardarWebhookChat(url) {
  setWebhookChat(String(url || '').trim());
  return { ok: true, configurado: !!getWebhookChat() };
}

/**
 * Envía un aviso de PRUEBA a la sala de Chat (botón "Probar" del panel admin).
 */
function probarAvisoChat() {
  return enviarNotificacionChat({
    pedido: '999999',
    ubicacion: 'PRUEBA-A-1',
    motivo: 'No sale · Mercancía rota — Ref 0000000 (2 uds)',
    operario: 'Prueba',
    hora: Utilities.formatDate(new Date(), 'Europe/Madrid', 'dd/MM HH:mm')
  });
}
