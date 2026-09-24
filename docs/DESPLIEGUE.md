# Despliegue — LM Málaga Expedición

Pasos para poner el sistema en producción (Google Apps Script + Sheets).

1. **Subir el código**
   - `clasp create --type webapp --title "LM Málaga Expedición"` y `clasp push`
   - O crear el proyecto en script.google.com y pegar todos los `.gs` y `.html`.
   - Archivos HTML que deben existir con esos nombres exactos: `Index`, `Dashboard`, `Clasificador`.

2. **Habilitar el servicio avanzado Drive**
   - Editor de Apps Script → Servicios (+) → "Drive API" → Añadir.
   - Necesario para importar inventarios Excel y para `importarDesdeArchivo`.

3. **Inicializar el sistema** (una vez)
   - Ejecutar `inicializarSistema()` desde el editor → crea el Spreadsheet con todas las hojas y guarda su ID. Anotar la URL del log.

4. **Configurar la carpeta de inventarios**
   - En `Inventario.gs`, comprobar `INVENTARIO_FOLDER_ID` (carpeta de Drive con un archivo por tienda; el nombre debe contener el código 014/036/043/279).
   - Probar con `probarInventario()` → debe loguear las tiendas y nº de pedidos.

5. **Webhook de Google Chat** (opcional)
   - Espacio de Chat → Aplicaciones e integraciones → Webhooks → Añadir → copiar URL.
   - Ejecutar `configurarWebhook('LA_URL')` y luego `probarNotificacion()` → debe llegar la tarjeta.

6. **Verificar el backend** (una vez, antes de desplegar)
   - Ejecutar `test_calcularPosiciones`, `test_crearPedidoConLineas`, `test_zonaTransportista` → todos `OK` en el log.
   - Ejecutar `verificarSistema()` → debe loguear `✓✓ verificarSistema OK`.
   - ⚠️ `verificarSistema()` LIMPIA las hojas de datos: ejecútalo antes de cargar datos reales.

7. **Desplegar como web app**
   - Implementar → Nueva implementación → Aplicación web.
   - Ejecutar como: **Yo**. Acceso: según política (organización o cualquiera).
   - Copiar la URL del despliegue.

8. **URLs de uso**
   - App operario:  `.../exec`  (o `?vista=app`)
   - Clasificador (admin):  `.../exec?vista=clasificador`
   - Dashboard TV:  `.../exec?vista=dashboard`

9. **Recorrido manual de aceptación**
   1. `?vista=clasificador` → pegar pedidos reales → **Clasificar** → **Importar al sistema**.
   2. `?vista=app` → operario → flujo → tienda → preparar un pedido (swipe) → cerrar a silueta.
   3. Pestaña Cargador → crear carga → imprimir hoja → confirmar entregas (escanear).
   4. Pestaña Buscar → consultar un pedido.
   5. `?vista=dashboard` en la TV → ver KPIs y siluetas, modo según hora.

## Notas de mantenimiento
- `Backend.calcularPosiciones` (servidor) y `empaquetarSoportes` en `Index.html` (cliente) implementan el MISMO algoritmo de empaquetado. Si se cambia uno, cambiar el otro.
- La importación es idempotente: reimportar respeta pedidos ya existentes no entregados.
- El inventario de Pyxis es la fuente de verdad: un pedido entregado desaparece del inventario.
