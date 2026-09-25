# CC.Granada — Diseño

## Contexto

Granada ya existe *a medias* en el código desde hace tiempo, pero deliberadamente bloqueada:

- `CONFIG.CODIGO_TIENDA` ya incluye `'Granada': '043'` (Configuracion.gs:37) — es un código de sitio Pyxis real, confirmado también en el script del robot de inventario (`GRANADA=043`, Backend.gs:3649 y 4677) y en el `.bat` que abre las 4 tiendas en Pyxis a diario.
- `CONFIG.TIENDAS` (Configuracion.gs:34) — la lista que gobierna el pipeline real de expedición — solo tiene `['Málaga','Marbella','Mijas']`. Granada queda fuera a propósito.
- `ImportarClasificacion.gs:81` (y su espejo en `supabase/migrations/2026081321_importar_clasificacion.sql:63`) rechazan cualquier pedido cuya tienda resuelva a Granada con el mensaje `"<tienda> fuera de expedición"`. Hay un test de regresión (`PruebasLote3Staging.gs:561`) que fija ese bloqueo como comportamiento intencional.
- Nunca ha entrado un solo pedido real con tienda=Granada en producción.
- No existe ningún `CHECK` constraint sobre la columna `tienda` en Supabase (es `text not null`, sin enum, decisión de diseño explícita) — el bloqueo es solo de aplicación, no de base de datos.

Dos docs de diseño anteriores (2026-06-24, 2026-07-28) ya señalaron esta inconsistencia como "a confirmar con el equipo" y nunca se resolvió. Este documento la resuelve.

## Decisiones ya acordadas con el usuario

1. **Granada pasa a ser una 4ª tienda real**, no un flujo/transportista tipo Remansur. Reutiliza el código Pyxis `043` ya existente en el sistema. Los pedidos entran por el pipeline normal de Pyxis/Clasificador, igual que Málaga/Marbella/Mijas — la fuente es la 043 ("saco los pedidos de la 043").
2. **No ocupa hueco físico en las siluetas A-F.** Al cerrar un pedido de Granada, en vez de asignarle una posición física, va a una lista/cubo transitorio propio — "es una silueta transitoria de expedición y carga".
3. **Se cargan todos juntos en un transporte** — el flujo natural es acumular pedidos de Granada en ese cubo hasta reunir los de una carga, y meterlos todos de una vez en una Carga (como ya funciona `crearCarga` hoy).
4. **Debe tener su propio apartado**, no vivir escondido dentro de otra pantalla (descartado: barrerlos a mano dentro de la pantalla Silueta como hace hoy "Recogidas"/"Ya Cargados").
5. **Se sigue pidiendo número y formato de soportes al cerrar el pedido** — a diferencia de "Recogidas"/"Ya Cargados" (que explícitamente NO llevan soportes, por ser una reconversión admin de un pedido que ya estaba resuelto), un pedido de Granada SÍ se está cerrando por primera vez desde el picking del operario, con artículos reales preparados, así que el paso 1 de `pantallaCerrarPedido` ("Soportes del pedido": tipo + cantidad, `addSop()`) se mantiene igual que hoy — lo que cambia es el paso 2 (silueta física), que se sustituye por el cierre directo a CC.Granada.

## Por qué NO es el mismo mecanismo que Recogidas/Ya Cargados

Es tentador asumir que "cubo sin hueco físico" = mismo código que `registrarRecogidasMasivo`/`registrarYaCargadosMasivo`, pero son cosas distintas:

- Recogidas/Ya Cargados son una **reconversión admin posterior**: se aplican pegando números de pedido que YA están resueltos/en una silueta física, para liberar ese hueco. Por diseño, "no hay soportes que corregir" en esa silueta ficticia (Index.html:799) — se pierden a propósito.
- CC.Granada es parte del **cierre normal del operario**, la primera vez que el pedido se resuelve — con artículos reales preparados y soportes reales que hay que conservar para saber qué (y cuánto) se va a cargar en el transporte.

Por eso hace falta una rama nueva en `pantallaCerrarPedido`, no reutilizar `registrarRecogidasMasivo` tal cual.

## Diseño técnico (a confirmar en el plan de implementación)

### 1. Tienda

- Añadir `'Granada'` a `CONFIG.TIENDAS` (Configuracion.gs:34). Esto solo, automáticamente:
  - Desbloquea el gate de `ImportarClasificacion.gs:81` y su espejo SQL (comprueban `CONFIG.TIENDAS.indexOf(tienda) !== -1`) — sin tocar las 4 zonas del Clasificador (Transporte/Instalaciones/PRO/Remansur): un pedido de Granada clasificado en cualquiera de esas 4 zonas dejará de rechazarse, igual que ya pasa con las otras 3 tiendas.
  - Hace que `obtenerConfig()` (Backend.gs:20) exponga Granada al cliente vía `tiendas: CONFIG.TIENDAS`, así que cualquier `<select>` de tienda ya generado desde ese array (manual a silueta, Store Delivery, importación directa) la ofrecerá automáticamente sin más cambios de frontend por ese lado.
- Confirmar con el usuario si el robot de inventario (fuera de este repo, carpeta "Robots Taisa") realmente descarga hoy `043.xlsx` a `INVENTARIO_FOLDER_ID` a diario, o si hace falta activarlo — el código YA sabe leerlo (`Inventario.gs` reconoce 014/036/043/279 por nombre de archivo).

### 2. Cierre del operario (Index.html, `pantallaCerrarPedido`)

- Mantener el paso "1 · Soportes del pedido" (`addSop()`) exactamente igual.
- Si `estado.pedidoActivo.tienda === 'Granada'`, sustituir el paso "2 · Silueta" (grid físico) por un botón único, en el mismo estilo que la rama ya existente "todo faltante" (Index.html:2230-2241): `"🏗️ Cerrar a CC.Granada"`.
- Nueva función cliente `confirmarCierreGranada()` (paralela a `confirmarCierre()`/`confirmarCierreSinSilueta()`), que envía `cierre.soportes` (mismo formato que hoy: `{tipo, tipoId, cant, ocupa}`) sin `silueta`/`posIni`/`posFin` reales.

### 3. Backend — nueva función `cerrarPedidoAGranada(idPedido, operario, soportes)`

Modelada sobre `cerrarPedidoSinSilueta` (Backend.gs:1175) pero guardando soportes:

- `silueta = 'CC.Granada'` (valor fijo, igual patrón que `'Recogidas'`/`'Ya Cargados'` — sin fila nueva en `OCUPACION_SILUETAS`, sin límite de capacidad).
- `estado = 'COMPLETADO_LISTO'` (mismo estado en el que quedan Recogidas/Ya Cargados, según el comentario de `registrarYaCargadosMasivo` — confirmar en el plan que esto no reintroduce el pedido en `listarPedidos()`, ya que esa función solo filtra por `ESTADOS_TERMINALES` + `enRevision`, y `COMPLETADO_LISTO` no es terminal; puede hacer falta un filtro adicional por `p.silueta` truthy, a verificar leyendo `listarPedidos` con lupa antes de escribir el plan).
- `soportes = soportes` (guardado tal cual, para que sea corregible después — a diferencia de Recogidas, que expresamente no lo permite).
- `posIni`/`posFin` vacíos (sin posición real).
- Sincronizar a Supabase igual que el resto de cierres (`sincronizarPedidoSupabase_`).

### 4. Apartado admin nuevo — pestaña "🏗️ CC.Granada"

- Añadir a `TABS_ADMIN` (Index.html:881) y al dispatcher de `switchTab()` (Index.html:899), mismo patrón que cualquier tab existente.
- Nueva función `pantallaCCGranada()`: lista los pedidos con `silueta === 'CC.Granada'` (backend: nueva función `listarPedidosCCGranada()`, filtra `PEDIDOS` por ese valor), mostrando por pedido: número, soportes (tipo + cantidad), fecha de cierre.
- Botón "Crear carga con todos" (o selección manual + el mismo flujo de `pantallaCargaInicio`/`crearCarga` ya existente — `crearCarga` ya acepta cualquier pedido con `p.silueta` truthy y `p.estado !== 'ENTREGADO'`, así que los de CC.Granada encajan sin tocar esa función).

## Alcance explícitamente fuera (YAGNI)

- No se toca el concepto Remansur — sigue siendo un flujo/transportista ortogonal a la tienda, sin relación con este cambio.
- No se añade una 5ª zona al Clasificador — Granada usa las 4 zonas existentes (Transporte/Instalaciones/PRO/Remansur), solo que ahora su tienda no se rechaza.
- No se construye una silueta física ni colores nuevos de silueta para Granada (el color `--t-Granada` que ya existe en Clasificador.html es del módulo de clasificación, no de la silueta — no aplica aquí).
- No se decide en este documento si algún día Granada necesitará siluetas físicas propias — hoy explícitamente no las tiene.

## Preguntas abiertas para el plan de implementación

1. ¿Confirma el usuario que el robot de inventario ya descarga `043.xlsx` a diario, o hay que activarlo/pedirlo aparte?
2. Verificar `listarPedidos()` con lupa: si un pedido en estado `COMPLETADO_LISTO` con `silueta='CC.Granada'` podría reaparecer en la lista de preparación del operario (no debería, pero hay que comprobarlo antes de fijar el estado a usar).
3. `public.registrar_recogidas_masivo`/`registrar_ya_cargados_masivo` (las RPC "hermanas" más parecidas) viven en Postgres fuera de los ficheros de migración versionados en este repo (promovidas de staging→public en Fase 3, 2026-09-04, sin bajarlas a git) — para escribir la RPC nueva de Granada con seguridad, conviene mirar su código real en Supabase en el momento del plan, no asumir que es idéntica a la versión `staging` que sí está en git.
