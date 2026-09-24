// Cloudflare Worker — puente hacia la API de retiradas de Leroy Merlin.
//
// POR QUÉ EXISTE: Leroy Merlin (o el filtro delante de su API) bloquea las
// peticiones que salen directamente de Google Apps Script (UrlFetchApp) con
// "400 Solicitud incorrecta", incluso replicando fielmente las cabeceras de
// un navegador real. Confirmado por descarte: la misma URL funciona bien
// desde un navegador, desde curl sin cabeceras especiales, y desde otras
// herramientas — el bloqueo es específico de la infraestructura de salida
// de Google Apps Script (probablemente por rango de IP). Este Worker hace
// la llamada real desde fuera de Google y actúa de intermediario.
//
// SEGURIDAD:
// - Solo reenvía a UN destino fijo (LM_BASE, hardcodeado) — nunca a una URL
//   que decida quien llama, para no ser un proxy abierto/SSRF.
// - Exige un secreto compartido en la cabecera X-Proxy-Secret; sin él,
//   devuelve 401. Cualquiera que descubra la URL de este Worker SIN el
//   secreto no puede usarlo para nada.
// - La ruta GET valida que tienda/pedido sean solo dígitos, para que nada
//   raro pueda colarse en la URL de destino.
//
// DESPLIEGUE: se pega tal cual en el editor de Cloudflare Workers (dashboard
// → Workers & Pages → Create → pegar código → Deploy). El secreto se
// configura como "Secret" en Settings → Variables, con nombre PROXY_SECRET.

const LM_BASE = 'https://store-delivery-api-pro.sales-pro-eslm.tech.adeo.cloud/v1/commands/check';

export default {
  async fetch(request, env) {
    const secret = request.headers.get('X-Proxy-Secret');
    if (!secret || secret !== env.PROXY_SECRET) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const url = new URL(request.url);
    const path = url.pathname; // "/check/{tienda}/{pedido}" (GET) o "/check" (POST)

    if (request.method === 'GET' && path.startsWith('/check/')) {
      const resto = path.slice('/check'.length); // "/{tienda}/{pedido}"
      if (!/^\/[0-9]+\/[0-9]+$/.test(resto)) {
        return new Response(JSON.stringify({ error: 'ruta inválida' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const resp = await fetch(LM_BASE + resto, { method: 'GET' });
      const body = await resp.text();
      return new Response(body, {
        status: resp.status,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (request.method === 'POST' && path === '/check') {
      const body = await request.text();
      const resp = await fetch(LM_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body
      });
      const respBody = await resp.text();
      return new Response(respBody, {
        status: resp.status,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ error: 'no encontrado' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
