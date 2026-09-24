# Migración Google Sheets → Supabase — LM Málaga

Decisión y plan de migración del backend de `lm_produccion` (hoy Google Apps Script + Google Sheets) a un datastore externo, tras confirmar que las llamadas salientes (`UrlFetchApp`) SÍ funcionan desde el entorno de Adeo (no solo el acceso entrante al Web App está restringido). Basado en el inventario técnico exacto en `2026-07-28-migracion-sheets-inventario.md` y en un diseño paralelo independiente para Firestore vs Supabase (comparados abajo). Firestore fue descartado — el análisis completo de esa opción, si hace falta revisarlo, está en el historial del workflow (preguntar a Claude, referencia `wf_6f2439b8-e2f`).

---

## Estado real (actualizado 2026-07-28, después de escribir el diseño)

**Fase 0 arrancada de verdad**, no solo planeada:

- Proyecto Supabase **`lm-malaga`** creado (org `guenroo@gmail.com's Org`, región `eu-west-1`, ref `erinkqzsywhuiilirhdc`). Aún sin tablas.
- `SUPABASE_URL` (`https://erinkqzsywhuiilirhdc.supabase.co`) y `SUPABASE_SERVICE_KEY` ya guardadas en **Propiedades del script** de Apps Script (Configuración del proyecto → Propiedades de script) — no en el código fuente, no en el historial de versiones.
- **Hallazgo importante que corrige el diseño de abajo**: Supabase tiene DOS sistemas de claves en paralelo. Las claves nuevas (`sb_secret_...`, pestaña "Publishable and secret API keys") **rechazan la petición con HTTP 401** (`"Forbidden use of secret API key in browser"`) cuando se llaman desde `UrlFetchApp` de Apps Script — Supabase las bloquea con una heurística anti-fuga que las detecta como "de navegador" (probado: ni siquiera un `User-Agent` personalizado lo evita). La clave que **sí funciona** desde Apps Script es la **`service_role` clásica (JWT, pestaña "Legacy anon, service_role API keys")** — probado con éxito: `GET {url}/rest/v1/` responde HTTP 200 con el JSON de OpenAPI/PostgREST. **Usar siempre la clave legacy `service_role` para `SUPABASE_SERVICE_KEY`, no la nueva `sb_secret_...`**, mientras se llame desde Apps Script.
- Función de prueba `testConexionSupabase()` añadida a `Pruebas.gs` (solo lee, no escribe nada) — reutilizable para verificar la conexión en cualquier momento desde el editor.
- **Perfilado real de datos ejecutado** (`perfilarDatosParaMigracion()` en `Pruebas.gs`, solo lectura, contra las hojas reales de producción — 1918 filas en PEDIDOS, 7063 en LINEAS_PREPARACION, 198 en OCUPACION_SILUETAS, 184 en CARGAS). Sustituye los "tipo asumido, confirmar" de la Parte 2 por valores reales — ver §2 actualizado. Dos correcciones importantes que el diseño original tenía mal: `soportes` NO es un entero, es un array JSON de composición variable; `sdImpreso` NO es booleano, es una fecha de impresión (string ISO) o vacío.
- **Decisiones de producto resueltas por el usuario (2026-07-28)**: el checkbox "Store Delivery" de `RESUMEN_ADMIN` no es relevante hoy — se excluye del alcance de la migración, no hace falta decidir dónde vive. La ventana operativa 22:00-06:00 sigue siendo válida para el corte de Fase 3.

~~Aplicar el DDL de la Parte 2 (§2) contra este proyecto de Supabase~~ — **Hecho 2026-07-29**: las 11 tablas (9 oficiales + `cargas_pedidos` + `config_siluetas`) están creadas en `lm-malaga`, verificado con `select table_name from information_schema.tables`. Fase 0 completa.

~~Fase 1 (escritura en sombra desde Apps Script) — todavía no empezada, cero conexión desde el código de producción a Supabase~~ — **Nota (2026-08-03): esta frase quedó obsoleta poco después de escribirse.** Fase 1 lleva en marcha semanas: `sincronizarPedidoSupabase_`/`sincronizarOcupacionSupabase_`/`sincronizarCargaSupabase_`/etc. (`Backend.gs`) escriben en sombra desde prácticamente todos los puntos de escritura reales, best-effort y no bloqueante, tal como describe el plan de fases más abajo. Quien retome este documento: tratar el estado real de Fase 1 como "en marcha, sin fecha de cierre documentada todavía" y verificar contra `verificarSincronizacionSupabase()` (Backend.gs), no contra esta frase.

**Actualización 2026-08-03 — hallazgo relevante para la Fase 2/3 (migración planificada para los próximos días):** un bug real en producción (pedidos duplicados por una condición de carrera en `importarClasificacion`, sin candado) resultó ser exactamente la misma familia de problema que la sección 3 de este documento ya señalaba como "el hallazgo más importante para la migración" (la carrera de `cerrarPedido()`). Se investigó, se confirmó con datos reales (6 pedidos duplicados en PEDIDOS, limpiados) y se mitigó del lado de Apps Script con `LockService` en **14 funciones** que hasta hoy escribían PEDIDOS/OCUPACION/CARGAS sin ninguna protección (inventario completo y detalle función por función en §3, tabla actualizada). Esto NO sustituye el trabajo de la Fase 2/3 (las constraints de Postgres siguen siendo la solución correcta y definitiva, ver más abajo) pero cambia el punto de partida: la carrera ya no está "aceptada sin mitigar" en producción, así que la migración puede tratar esto como "sustituir un lock que ya funciona por una constraint más robusta", no como "arreglar un bug vivo bajo presión de tiempo". Ver `lm-malaga-pipeline-implementacion.md` (memoria) entradas v193-v195 para el detalle completo, incluida la confirmación empírica de que anidar candados de `LockService` dentro de una misma ejecución es instantáneo (no bloquea), dato reutilizable si en Fase 2/3 aparecen dudas equivalentes sobre transacciones anidadas en Postgres.

---

# Parte 1 — Recomendación y plan

## Recomendación

**Supabase.** Para este perfil de equipo (un solo desarrollador sin backend dedicado, app en producción usada a diario por operarios de almacén, dependencia de Claude Code como principal apoyo técnico) la decisión no es cercana: Supabase gana en los tres ejes que priorizaste — autenticación trivial y sin dependencia de aprobaciones de gobernanza de Adeo, menor riesgo de migración porque SQL/Postgres es un terreno mucho más conocido y depurado que la REST API de transacciones de Firestore, y una vía de reserva real para que alguien no técnico siga mirando/editando datos (Table Editor tipo hoja de cálculo) sin depender de que el admin de GCP de Adeo conceda roles IAM. El único punto donde Firestore gana con claridad — coste teórico más bajo, porque no fuerza un tier de pago desde el día uno — es irrelevante frente al riesgo de que la vía de autenticación de Firestore (sección 1 de ese diseño) dependa de decisiones organizativas de Adeo que ya sabemos que son restrictivas y que este equipo no controla ni puede acelerar.

---

## Comparativa clave

| Eje | Firestore | Supabase |
|---|---|---|
| **Autenticación** | Cuenta de servicio + JWT firmado a mano (`computeRsaSha256Signature`) + intercambio OAuth2 + caché/renovación de token + reintento en 401 (~60-80 líneas nuevas). Viable solo si Adeo permite crear claves de cuenta de servicio (`iam.disableServiceAccountKeyCreation` podría estar activa) y vincular el proyecto de Apps Script a un GCP estándar con `oauthScopes` ampliados — dos aprobaciones fuera del control de este equipo. | Dos cabeceras HTTP estáticas (`apikey` + `Authorization: Bearer`) guardadas en `PropertiesService`, sin flujo OAuth, sin reloj que desincronizar. Cero dependencia del GCP de Adeo — el proyecto Supabase es una cuenta aparte que el propio desarrollador da de alta. |
| **Modelo de datos** | Documental; `LINEAS_PREPARACION` exige subcolección + collection group query (concepto nuevo). La búsqueda por subcadena de `buscarPedidosFiltro` **no tiene** traducción nativa — hay que dejarla como excepción de lectura completa + filtro en memoria. | Relacional directo (las hojas ya son de facto tablas). `CARGAS.items` se normaliza a `cargas_pedidos`, eliminando el patrón "JSON blob + candado". La búsqueda por subcadena **sí** tiene solución nativa razonable (`WHERE ped ILIKE '%texto%'`) — ventaja real que el diseño Supabase no llegó a señalar explícitamente pero se deriva directamente de tener SQL. |
| **Concurrencia** | Sin mutex nativo; hay que simular `tryLock()` con documento-candado + `exists=false`, y las 9 operaciones compuestas restantes necesitan transacciones optimistas (`beginTransaction`/`batchGet`/`commit`) con reintento manual en `409 ABORTED` — patrón correcto pero no obvio, fácil de implementar mal a la primera. | Constraints declarativas (`UNIQUE(silueta,pos,layer)`, `ON CONFLICT`) hacen ciertos estados irrepresentables sin código adicional; los 7 sitios de `LockService` sobre `CARGAS.items` desaparecen al normalizar. La lógica compuesta se mueve a funciones PL/pgSQL — más simple conceptualmente que el REST de transacciones de Firestore, pero introduce un segundo lenguaje (SQL/PL/pgSQL) que el equipo no usa hoy. |
| **Visibilidad manual** | Cloud Console → Firestore Data: editor de campos crudo, sin checkboxes reales, sin filtros de columna; exige rol IAM por persona, gestionado por el admin de GCP de Adeo. `RESUMEN_ADMIN` no tiene equivalente nativo — hay que construir una pantalla HTML nueva desde cero. | Table Editor: rejilla tipo hoja de cálculo (filtros, orden, edición de celda, FKs navegables) — más cercano a la ergonomía de Sheets. Pero exige alta de usuario en el proyecto Supabase + RLS si se quiere limitar qué ve cada persona, y no hay app móvil equivalente a Sheets para consulta casual desde el suelo de nave. |
| **Coste** | Tier gratuito probablemente suficiente (50k lecturas/20k escrituras diarias); riesgo real no es el dinero sino la **paginación** (~300 docs/página → ~14 llamadas HTTP secuenciales para leer `LINEAS_PREPARACION` completa, consumiendo cuota de `UrlFetchApp` de forma nueva). | Tier gratuito **se pausa tras ~1 semana de inactividad**, incompatible con disparadores nocturnos desatendidos → obliga a plan Pro (~25 $/mes) desde el día uno, por disponibilidad, no por volumen. A cambio, PostgREST no tiene el límite de ~300 filas/página de Firestore (confirmar el `db-max-rows` configurado, pero por defecto es mucho más generoso), por lo que las lecturas de tabla completa —el patrón dominante de la app en 60+ sitios— probablemente necesiten muchas menos llamadas HTTP que con Firestore. |
| **Riesgo de migración** | Depende de aprobaciones organizativas de Adeo (creación de claves de servicio, vinculación de proyecto GCP, posibles políticas de acceso condicional/VPC-SC) que ya sabemos restrictivas por precedente en este mismo proyecto (el desplegable "Cualquier usuario" deshabilitado). Puede bloquearse por completo antes de escribir una línea de producción. | Sin dependencia de aprobaciones de Adeo para arrancar. El riesgo se traslada a la concentración de poder en la `service_role key` (equivalente a superusuario de la BD) y a la necesidad de mover lógica compuesta a PL/pgSQL sin saltarse ese paso (si no, se reintroducen las condiciones de carrera sin ningún lock que las mitigue). |

---

## Plan de implementación por fases

**Fase 0 — Preparación (sin tocar producción)**
- Crear proyecto Supabase (y un segundo de staging — hoy no existe ningún entorno de pruebas).
- Aplicar el DDL de la sección 2 del diseño Supabase; diseñar políticas RLS desde ya aunque el único cliente sea `service_role` (evita retrofitarlas bajo presión el día que se abra el Table Editor a más personas).
- Añadir toggle `ENTORNO=STAGE|PROD` en `PropertiesService`.
- ~~Muestreo real de `PEDIDOS`/`LINEAS_PREPARACION`/`OCUPACION_SILUETAS`/`CARGAS`~~ — **Hecho 2026-07-28** vía `perfilarDatosParaMigracion()`, tipos y valores reales ya incorporados al DDL de §2.
- **Se prueba antes de avanzar:** que el DDL acepta un `INSERT` masivo con datos reales de muestra sin fallos de tipo; que las cabeceras estáticas autentican correctamente contra el proyecto de staging desde una función de una línea en el editor de Apps Script.

**Fase 1 — Escritura en sombra (dual-write)**
- Los helpers nuevos escriben en Sheets (fuente de verdad) **y** en Supabase (best-effort, no bloqueante); las lecturas siguen en Sheets.
- Mínimo 1-2 semanas operativas, cubriendo al menos un ciclo de purga y un ciclo de snapshot nocturno.
- **Se prueba antes de avanzar:** comparación nocturna de recuento de filas y checksums entre Sheets y Supabase; cero divergencias no explicadas durante al menos una semana completa.

**Fase 2 — Migración de datos históricos y decisiones de producto pendientes**
- Export por lotes de las 9 hojas vía `POST` masivo a PostgREST, troceado por los límites de `UrlFetchApp` (payload y 6 minutos/ejecución). **Filtrar antes las filas completamente vacías de `OCUPACION_SILUETAS`** (2 de 198, ver §2) para no romper el `primary key`.
- Migrar explícitamente el override de `PropertiesService` de posiciones por silueta → `config_siluetas` (el checkbox de `RESUMEN_ADMIN` queda fuera de alcance, ver §2).
- **Se prueba antes de avanzar:** los datos migrados producen los mismos resultados que Sheets en las funciones de lectura críticas (dashboard, listado de pedidos, ocupación de siluetas) ejecutadas en paralelo contra staging.

**Fase 3 — Corte de lecturas (dentro de la ventana 22:00-06:00 ya validada por el propio sistema)**
- Ensayar el rollback **al menos una vez** contra staging antes del corte real.
- Parar el dual-write, apuntar `leerHoja`/`actualizarFila` solo a Supabase, ejecutar la purga/snapshot nocturna ya contra Supabase, reabrir operativa a las 06:00.
- Mantener Sheets en modo lectura como fallback inmediato unos días más.
- **Se prueba antes de avanzar:** el ciclo de purga nocturno corre limpio contra Supabase al menos una vez; el rollback ensayado funciona sin pérdida de datos.

**Fase 4 — Fin de la doble escritura**
- Solo tras al menos un ciclo de purga limpio en producción. Sheets pasa a ser exportación de solo lectura, no se borra.

---

## Qué necesito de ti para empezar

- ~~Cuenta/proyecto Supabase~~ — **Hecho**: proyecto `lm-malaga` creado.
- ~~Credenciales~~ — **Hecho**: `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` (legacy JWT) en Propiedades del script.
- ~~Decisión del checkbox "Store Delivery"~~ — **Resuelto 2026-07-28**: no es relevante hoy, fuera de alcance.
- ~~Valores reales de `estado`/`soportes`/`intento_carga`~~ — **Resuelto 2026-07-28**: perfilado real ejecutado, ver §2.
- ~~Ventana operativa 22:00-06:00~~ — **Confirmada 2026-07-28** por el usuario, sigue siendo válida para el corte de Fase 3.
- **Pendiente — Acceso de Editor al proyecto de Apps Script**: confirmar quién lo tiene hoy y si conviene restringirlo antes del corte, dado que esa persona podrá leer la `service_role key` completa desde `PropertiesService`.
- **Pendiente — segundo proyecto Supabase de staging**: hoy solo existe `lm-malaga` (que será producción). Antes de aplicar el DDL en real conviene decidir si se crea un proyecto de staging aparte para ensayar Fase 0-2 sin tocar el que será producción.

---

## Riesgos que NO desaparecen con esta migración

- **La `service_role key` concentra el riesgo**: pasa de "quien tiene Editor del Spreadsheet" a "quien tiene Editor del script puede leer una clave con acceso de superusuario a toda la base de datos". Requiere disciplina de acceso y un runbook de rotación que hoy no existe para nada equivalente.
- **Se pierde el "deshacer" informal de Sheets** (Ctrl+Z, historial de versiones). Postgres tiene Point-in-Time Recovery en el plan Pro, pero restaurar a un punto en el tiempo no es tan directo como pulsar deshacer para alguien no técnico.
- **La lógica de negocio se bifurca entre dos lenguajes**: si se saltan las funciones PL/pgSQL y en su lugar se encadenan llamadas PostgREST sueltas desde Apps Script para las operaciones compuestas sobre `cargas_pedidos`, se reintroducen las mismas condiciones de carrera que existen hoy — sin ningún lock que las mitigue. Esto exige que el desarrollador adquiera soltura real en PL/pgSQL, no es opcional si se quiere preservar la atomicidad.
- **Estado fuera de las 9 hojas oficiales sigue siendo el candidato más probable a perderse**: si el alcance se acota estrictamente a "migrar las 9 hojas", los checkboxes de `RESUMEN_ADMIN` y el override de `PropertiesService` quedan fuera por defecto y se pierden — hay que nombrarlos explícitamente en el alcance, no dar por hecho que "ya se verá".
- **Dependencias externas cercanas al código que se va a tocar**: el Spreadsheet externo de Disponibilidad (gestionado por otro equipo) y los snapshots diarios en Drive usan `getRange`/`setValue` en bruto justo al lado de `EstructuraSheets.gs`. Deben quedar marcados explícitamente como fuera de alcance en el propio código, no solo en un documento aparte, para que no se toquen "por limpieza" sin darse cuenta.
- **`RETIRADAS_STOCK` sigue sin arreglarse por cambiar de base de datos**: la funcionalidad real vive en un script PowerShell local precisamente porque Adeo bloquea tráfico saliente desde plataformas cloud. Supabase también es una plataforma cloud — si en algún momento se plantea "que el PowerShell escriba directamente a Supabase", ese tráfico probablemente seguiría bloqueado por el mismo motivo. No es un efecto colateral que esta migración resuelva.
- **La carrera de `cerrarPedido()`/`confirmarEntregas()`** (ver §3) no se corrige automáticamente por migrar — la constraint `UNIQUE(silueta,pos,layer)` la resuelve, pero solo si se decide explícitamente implementarla como parte del trabajo, no como algo que "ya viene resuelto" por elegir Postgres. **Actualización 2026-08-03**: ya no está "aceptada sin mitigar" — `cerrarPedido()` y 13 funciones más ganaron candado de `LockService` en Apps Script tras un bug real (ver §3) — pero eso es una mitigación de aplicación, no la garantía a nivel de dato que da la constraint; sigue habiendo que implementarla explícitamente en Postgres, no asumir que "ya viene resuelto" ni por elegir Postgres ni porque Apps Script ya lo mitigue hoy.
- **No hay entorno de pruebas hoy**, y construirlo (proyecto de staging + toggle de entorno) es trabajo real de esta migración, no algo que Supabase provea gratis por sí solo.
- **El número real de usos de `._fila` en `Backend.gs` no está cuantificado** — el cambio de contrato de "número de fila" a "id de negocio" toca potencialmente muchos puntos de `Backend.gs`; hace falta ese grep antes de dar por buena cualquier estimación de esfuerzo.

---

# Parte 2 — Diseño técnico detallado (Supabase)

# Diseño de migración — LM Málaga: Google Sheets → Supabase (Postgres) con Apps Script como capa de servicio

Basado en el inventario técnico verificado en `INVENTARIO_MIGRACION_LM_MALAGA.md` (citas de archivo:línea del código real en `lm_produccion`). No es una venta de la idea — cada sección incluye los problemas reales que esta opción concreta introduce.

---

## 0. Encaje arquitectónico (qué cambia y qué no)

```
Hoy:      Navegador (dominio Adeo) → Web App (Index.html + WebApp.gs)
                                          → Backend.gs → EstructuraSheets.gs → SpreadsheetApp (Sheets)

Propuesto: Navegador (dominio Adeo) → Web App (Index.html + WebApp.gs)  [SIN CAMBIOS]
                                          → Backend.gs → EstructuraSheets.gs → UrlFetchApp → PostgREST (Supabase)
```

Lo único que cambia es el interior de `EstructuraSheets.gs`. `WebApp.gs`, `Index.html`, la autenticación por dominio de Adeo y el modelo de despliegue de la Web App **no se tocan**. Esto es deliberado y limita el alcance del riesgo, pero implica que **toda la lógica de negocio compuesta que hoy vive en `Backend.gs`** (cerrar pedido, gestionar cargas) sigue en Apps Script salvo que se decida explícitamente moverla a funciones de Postgres (ver §3–4).

---

## 1. Autenticación: Apps Script ↔ Supabase

### Cómo es en la práctica

Supabase expone Postgres vía PostgREST sobre HTTPS. La autenticación son **dos cabeceras HTTP estáticas**, sin flujo OAuth, sin tokens que caduquen:

```javascript
function supaHeaders_() {
  var p = PropertiesService.getScriptProperties();
  return {
    apikey: p.getProperty('SUPABASE_SERVICE_KEY'),
    Authorization: 'Bearer ' + p.getProperty('SUPABASE_SERVICE_KEY'),
    'Content-Type': 'application/json'
  };
}
```

`SUPABASE_URL` y `SUPABASE_SERVICE_KEY` se guardan una vez en `PropertiesService.getScriptProperties()` (el mismo sitio donde hoy vive el ID del Spreadsheet, `POSICIONES_POR_SILUETA_OVERRIDE`, etc. — patrón ya usado en el proyecto). No hay refresco de token, no hay `Utilities.computeRsaSha256Signature`, no hay reloj que se pueda desincronizar.

### Comparación honesta con Firestore

Con Firestore, Apps Script no tiene SDK nativo — tendría que hablar con la REST API de Firestore vía `UrlFetchApp`, y eso exige una de estas dos rutas:

1. **Cuenta de servicio + JWT firmado a mano**: pegar una clave privada RSA en `PropertiesService` (como texto, con los `\n` escapados — fuente típica de errores), firmar un JWT con `Utilities.computeRsaSha256Signature`, intercambiarlo por un access token OAuth2 en `https://oauth2.googleapis.com/token`, cachear el token (caduca al cabo de 1 hora) y renovarlo antes de cada llamada o al recibir un 401. Esto es lógica adicional real que hay que escribir y mantener en Apps Script, no una cabecera fija.
2. **Librería `OAuth2 for Apps Script`** (de terceros, no oficial): reduce el código pero añade una dependencia externa a un proyecto que hoy no tiene ninguna.

Conclusión honesta: en el eje "complejidad de autenticación desde `UrlFetchApp`", Supabase es objetivamente más simple que Firestore — dos cabeceras estáticas contra un ciclo OAuth2/JWT con renovación. Esto **no** es un argumento a favor de Supabase en general (Firestore tiene otras ventajas ajenas a esto), es específico a lo fácil que es hablar con cada uno desde GAS.

### El problema real que esto introduce

`SUPABASE_SERVICE_KEY` con rol `service_role` **se salta RLS por completo** — es equivalente a superusuario de la base de datos. Hoy, "quién puede hacer daño" se limita a quien tiene permiso de Editor sobre el proyecto de Apps Script (y ese permiso ya existe y se audita, según el patrón del proyecto). Tras la migración, **cualquiera con acceso de Editor al script puede leer `PropertiesService.getScriptProperties()` y obtener esa clave**, y con ella tiene lectura/escritura sin restricción sobre toda la base de datos — no solo sobre "este Spreadsheet". Un `Logger.log(PropertiesService.getScriptProperties().getProperties())` de depuración, dejado sin querer, expone la clave completa en los logs de ejecución.

Mitigaciones concretas a decidir, no opcionales:
- Restringir quién tiene Editor sobre el proyecto Apps Script tan estrictamente como hoy se restringiría el acceso "root" a la base de datos.
- Tener un runbook de rotación de la `service_role key` (Supabase permite regenerarla) para el día en que alguien salga del equipo o se sospeche una fuga.
- Evaluar si de verdad hace falta `service_role`, o si con `anon` + políticas RLS bien escritas (dado que el único cliente es el propio Apps Script, autenticado por IP/servicio, no por usuario final) es suficiente — usar `service_role` es más simple hoy pero centraliza el riesgo.

---

## 2. Modelo de datos: de hojas a tablas

El mapeo es, como anticipa el inventario, el más directo posible — las 9 hojas ya son relacionales de facto (filas con `_fila` como identificador implícito, referencias cruzadas por `id`/`ped`/`numeroCarga`). El cambio real no es el mapeo columna-a-columna, es sustituir **el patrón "leer JSON de una celda, modificarlo en memoria, reescribir la celda entera"** (`CARGAS.items`, `PropertiesService` de siluetas) por tablas normalizadas — eso es lo que de verdad simplifica la concurrencia (ver §3).

### Perfilado real ejecutado (2026-07-28) — sustituye los supuestos iniciales

Se ejecutó `perfilarDatosParaMigracion()` (solo lectura) contra las hojas reales de producción. Resultados completos por columna:

**`PEDIDOS` (1918 filas, 0 filas totalmente vacías):**
- `estado`: **8 valores reales**, 0 vacíos → `ENTREGADO`(1764), `COMPLETADO_LISTO`(98), `SALIDA_MANUAL`(27), `CERRADO_SIN_SILUETA`(14), `DEVUELTO_ALMACEN`(7), `ENVIADO_TIENDA`(5), `EN_PREPARACION`(2), `PENDIENTE`(1). **Decisión: NO poner `CHECK`/enum** — con volumen tan desigual (1 sola fila en `PENDIENTE`) es probable que el negocio añada estados nuevos y un `CHECK` rígido rompería el primer `INSERT`/`UPDATE` con un estado legítimo no previsto. Se documenta la lista en un comentario, se deja `text not null`.
- `flujo`: 5 valores, 0 vacíos → `transporte`(931), `instalacion`(577), `remansur_transporte`(363), `pro`(45), `remansur_pro`(2) — coincide exactamente con `CONFIG.TRANSPORTISTAS_FLUJO`. Mismo criterio: `text`, sin `CHECK`.
- `transportista`: 6 valores, 0 vacíos → incluye tanto `Correcaminos Instalaciones`(566) como `Correcaminos Inst.`(11) — **inconsistencia real de nombrado ya en los datos de producción**, no un artefacto de la migración. `text` sin `CHECK` es obligatorio aquí (un enum rechazaría directamente datos reales existentes); si se quiere limpiar, es una decisión de negocio aparte (¿normalizar a un solo nombre?), no algo que la migración deba decidir por su cuenta.
- `tienda`: 3 valores, 0 vacíos → `Málaga`(991), `Marbella`(523), `Mijas`(404). **Granada no aparece ni una vez** en los pedidos reales, pese a estar en `CONFIG.CODIGO_TIENDA` y en los mapas de Disponibilidad — confirma la inconsistencia ya señalada en el inventario §4.
- `tipoEntrega`: 3 valores, **1298 vacíos de 1918** (mayoría sin dato) → `delivery`(560), `parcial`(64), `vonzu`(4) — este último valor es raro/posible resto histórico; no bloquea nada, se deja como texto libre.
- `pct`: numérico limpio, 0 vacíos → 100(1901), 0(6), 67(3), 88(2), 75(2), 80(2), 11(1), 50(1). `numeric` confirmado.
- `enRevision`: booleano, 1917 vacíos de 1918 (solo 1 fila en `true`) — flag casi sin uso real, pero semántica booleana confirmada.
- **`sdImpreso`: CORRECCIÓN — no es booleano.** 77 valores distintos, todos son **timestamps ISO** (p.ej. `2026-07-14T15:30:47.792Z`), 1311 vacíos de 1918. Es la fecha en que se imprimió el "SD", no un flag sí/no. Tipo correcto: `timestamptz null` (vacío = no impreso todavía).
- **`intentoCarga`: confirmado.** Solo aparece el valor `2` (6 veces), vacío en 1912/1918 filas. Es un contador de intentos, `integer null` es correcto tal cual estaba.
- **`soportes`: CORRECCIÓN — no es un entero.** 207 valores distintos, **0 vacíos** (siempre hay algo), y es JSON con forma variable según cuándo se guardó: `[{"tipoId":"bulto","tipo":"Bulto","cant":2}]`, `[{"cant":1,"ocupa":0.5,"tipoId":"jaula"}]`, `[{"tipoId":"palet_euro","tipo":"Palet Euro","cant":3}]` — a veces trae `tipo` (nombre legible) y a veces no, a veces trae `ocupa` embebido y a veces no (arrastre de versiones antiguas del código). Tipo correcto: **`jsonb`**, no `integer`.

**`LINEAS_PREPARACION` (7063 filas):**
- `tipoUbic`: 5 valores, 21 vacíos → `palet`(5636), `transitoria`(732), `cantilever`(580), `zona_especial`(88), `expedicion`(6).
- `esPicking`: booleano, 21 vacíos → `false`(6462), `true`(580).
- `estado`: 4 valores, 21 vacíos → `PREPARADO`(6639), `NO_SALE`(335), `PENDIENTE`(57), `POSPUESTO`(11).
- `motivo`: 54 valores distintos (texto libre genuino, no enum — incluye referencias embebidas tipo `"No sale · Mercancía faltante – Ref 19396"`), 6717 vacíos (solo se rellena en excepciones).
- `muelleHecho`: booleano, 6978 vacíos de 7063 (solo `true` cuando se marca, nunca `false` explícito — vacío = false).
- `ctd`: 111 valores numéricos distintos **incluyendo decimales** (`12.6`), 21 vacíos — confirma `numeric`, no `integer`.

**`OCUPACION_SILUETAS` (198 filas) — hallazgo de calidad de datos:**
- Las 4 columnas comprobadas (`silueta`, `layer`, `flujo`, `reservado`) reportan **exactamente 2 filas vacías cada una**, siempre las mismas 2 filas (98+98+2=198 en `layer`, 148+48+2=198 en `reservado`, etc. — cuadra en todas). Son 2 filas en blanco al final del rango usado de la hoja (probablemente restos de un `getDataRange()` que arrastra el rango tras borrados anteriores), **no ocupación real**. **Acción para la migración de datos**: filtrar y descartar cualquier fila completamente vacía de `OCUPACION_SILUETAS` antes del `INSERT` a `ocupacion_siluetas` — si no, el `primary key (silueta, pos, layer)` fallaría con NULLs.
- `silueta`: A(30), B(30), C(30), D(30), E(46), F(30) — coincide con `CONFIG.SILUETAS` y con `E` teniendo más capacidad (`POSICIONES_POR_SILUETA.E=27`).

**`CARGAS` (184 filas):**
- `estado`: en el momento del perfilado, **el 100% está en `CERRADA`** (184/184) — no hay ninguna carga `GENERADA` activa ahora mismo (coherente si se consultó fuera del ciclo de preparación). El código (`_disponiblesDesde`, Backend.gs) confirma que `GENERADA` es un estado real usado en producción aunque no aparezca en esta foto puntual — el esquema debe contemplar ambos, no solo lo que salió en el perfilado de este momento.

### `pedidos` (de `PEDIDOS`, 21 columnas exactas del código, `Configuracion.gs:140-141`)

```sql
create table pedidos (
  id              text primary key,              -- confirmar formato real del id actual antes de fijar tipo/generación
  ped             text not null,                 -- número de pedido "de negocio"; texto para no perder ceros a la izquierda
  tienda          text not null,                  -- confirmado: 'Málaga'(991)|'Marbella'(523)|'Mijas'(404) en datos reales. 'Granada' no aparece nunca — ver inconsistencia CONFIG.TIENDAS vs mapas de disponibilidad (inventario §4)
  transportista   text,                           -- confirmado 6 valores reales, incluye inconsistencia de nombrado ya existente ('Correcaminos Instalaciones' vs 'Correcaminos Inst.') — NO forzar CHECK, rechazaría datos reales
  flujo           text,                           -- confirmado 5 valores = CONFIG.TRANSPORTISTAS_FLUJO exacto: transporte/instalacion/remansur_transporte/pro/remansur_pro
  estado          text not null,                  -- confirmado 8 valores reales (ENTREGADO/COMPLETADO_LISTO/SALIDA_MANUAL/CERRADO_SIN_SILUETA/DEVUELTO_ALMACEN/ENVIADO_TIENDA/EN_PREPARACION/PENDIENTE) — NO poner CHECK/enum: la distribución tan desigual sugiere que puede aparecer un estado nuevo, y un CHECK rígido rompería el primer INSERT/UPDATE legítimo
  pct             numeric(5,2),                   -- confirmado numérico limpio, 0 vacíos
  operario        text,
  silueta         text,
  pos_ini         text,
  pos_fin         text,
  numero_carga    text references cargas(id),
  soportes        jsonb not null,                 -- CORREGIDO tras perfilado real: NO es entero, es array JSON de forma variable (ej. [{"tipoId":"palet_euro","tipo":"Palet Euro","cant":3}]) — 207 formas distintas observadas, 0 vacíos
  n_lin           integer,
  n_ubic          integer,
  actualizado     timestamptz not null default now(),  -- usado por la purga a 90 días (Backend.gs:4602) — clave que quede bien indexado
  intento_carga   integer,                        -- confirmado: solo aparece el valor 2 en datos reales (6 veces), resto vacío — contador de intentos
  comentario      text,
  tipo_entrega    text,                           -- confirmado 3 valores (delivery/parcial/vonzu), 1298/1918 vacíos — mayoritariamente sin dato
  en_revision     boolean not null default false, -- confirmado booleano, casi sin uso real (1/1918 en true)
  sd_impreso      timestamptz                     -- CORREGIDO tras perfilado real: NO es booleano, es la fecha/hora de impresión del SD (string ISO), null = no impreso. 1311/1918 vacíos
);

create index idx_pedidos_estado_actualizado on pedidos (estado, actualizado);  -- para la purga y para buscarPedidosFiltro()
create index idx_pedidos_tienda on pedidos (tienda);
```

### `lineas_preparacion` (de `LINEAS_PREPARACION`, 15 columnas, `Configuracion.gs:142-143`)

```sql
create table lineas_preparacion (
  id            text primary key,
  id_pedido     text not null references pedidos(id) on delete cascade,  -- ver nota: hoy la purga borra PEDIDOS y LINEAS por separado; con FK+cascade se vuelve una sola operación atómica
  idx           integer not null,
  dir           text,
  ref           text,
  ean           text,                              -- texto, NO numérico: un EAN con ceros a la izquierda se corrompe si se tipa integer/bigint
  des           text,
  ctd           numeric,                            -- confirmado: 111 valores reales incluyendo decimales (ej. 12.6) — numeric correcto, NO integer
  tipo_ubic     text,                               -- confirmado 5 valores: palet(5636)/transitoria(732)/cantilever(580)/zona_especial(88)/expedicion(6)
  es_picking    boolean,                             -- confirmado booleano: false(6462)/true(580)
  estado        text,                               -- confirmado 4 valores: PREPARADO(6639)/NO_SALE(335)/PENDIENTE(57)/POSPUESTO(11)
  motivo        text,                               -- confirmado texto libre genuino (54 valores distintos, embebe referencias tipo "Ref 19396") — NO enum
  operario      text,
  ts            timestamptz,
  muelle_hecho  boolean default false               -- confirmado: solo aparece 'true' cuando se marca (85 veces), vacío=false, nunca 'false' explícito
);

create index idx_lineas_id_pedido on lineas_preparacion (id_pedido);
```

### `ocupacion_siluetas` (de `OCUPACION_SILUETAS`, 7 columnas, `Configuracion.gs:144`)

```sql
create table ocupacion_siluetas (
  silueta    text not null,                          -- confirmado 6 valores = CONFIG.SILUETAS (A/B/C/D/E/F), E con más filas (capacidad mayor)
  pos        text not null,
  layer      text not null,                          -- confirmado: back/front
  pedido     text,                                   -- CORREGIDO 2026-07-29: SIN "references pedidos(id)". En OCUPACION_SILUETAS.pedido siempre se guarda el número de pedido "de negocio" (p.ped, ej. '999999'), NUNCA el id interno — una FK contra pedidos(id) rechaza TODAS las filas reales con "violates foreign key constraint" (probado con datos de prueba antes de desplegar, no en producción). Descubierto y corregido en Fase 1 antes de que afectara a datos reales.
  tienda     text,
  flujo      text,                                   -- confirmado 4 valores: transporte/instalacion/pro/remansur_pro
  reservado  boolean not null default false,
  primary key (silueta, pos, layer)                 -- ESTA constraint es la pieza clave de §3: hace irrepresentable que dos pedidos ocupen la misma posición
);
-- IMPORTANTE (hallazgo del perfilado real): la hoja OCUPACION_SILUETAS tiene HOY 2 filas
-- completamente vacías al final de su rango usado (de 198 filas totales) — resto de un
-- getDataRange() que arrastra el rango tras borrados anteriores, no ocupación real.
-- El script de migración de datos DEBE descartar cualquier fila con todas las columnas
-- vacías antes de insertar aquí, o el INSERT fallará contra el primary key (NULLs).
```

### `cargas` (de `CARGAS`, 8 columnas, `Configuracion.gs:145`) — **normalizada, no como blob JSON**

```sql
create table cargas (
  id            text primary key,
  num_carga     text not null unique,
  fecha         date not null,
  estado        text not null,                    -- perfilado real solo capturó 'CERRADA' (184/184, no había ninguna GENERADA en ese momento) — el código (_disponiblesDesde, Backend.gs) confirma que 'GENERADA' es un segundo estado real en uso; el esquema debe admitir ambos aunque el perfilado puntual no lo mostrara
  responsable   text,
  cargador      text,
  fecha_cierre  timestamptz
  -- SIN columna "items" jsonb: se sustituye por la tabla de unión de abajo
);

create table cargas_pedidos (
  carga_id   text not null references cargas(id) on delete cascade,
  pedido_id  text not null references pedidos(id),
  posicion   integer,                               -- orden dentro de la carga, si el JSON original lo llevaba
  added_at   timestamptz not null default now(),
  primary key (carga_id, pedido_id)
);
```

Esta es la decisión de diseño más importante de toda la migración: **`CARGAS.items` hoy es un único JSON con el snapshot completo de pedidos de la carga**, y de las 12 llamadas a `LockService` del inventario, **7** (`quitarPedidoDeCarga`, `_quitarPedidoDeSuCargaActiva`, `_sincronizarFlujoEnCargaActiva`, `eliminarCargaCompleta`, `anadirPedidoACarga`, `sincronizarPosicionEnCargaActiva`, `_sincronizarPosicionesEnCargasLote`) existen **únicamente** porque leer-modificar-reescribir un blob JSON no es seguro sin candado. Normalizando a `cargas_pedidos`, esas 7 operaciones se convierten en `DELETE`/`UPDATE`/`INSERT` ordinarios sobre filas concretas, y Postgres las hace atómicas sin ningún lock de aplicación (ver §3).

### Resto de hojas (mapeo directo, sin sorpresas de concurrencia)

```sql
create table historial_entregas (         -- append-only, de HISTORIAL_ENTREGAS
  id            bigint generated always as identity primary key,
  pedido        text, tienda text, transportista text, silueta text,
  pos_ini text, pos_fin text, cargador text,
  ts timestamptz, confirmado_ts timestamptz, responsable text
);

create table log_actividad (              -- de LOG_ACTIVIDAD, envuelto en try/catch en el código (EstructuraSheets.gs:319-333)
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(), tipo text, detalle text, usuario text
);

create table visas (                      -- de VISAS
  id text primary key, ped text, tienda text, estado text,
  numero_carga text, fecha_alta timestamptz, fecha_resuelta timestamptz, motivo_alerta text
);

create table retiradas_stock (            -- de RETIRADAS_STOCK — ver §8: hoja sin lector/escritor activo hoy
  fecha date, tienda text, pedido text, cliente text, resultado text, code text, ts timestamptz
);

create table historial_transportista (    -- append-only, de HISTORIAL_TRANSPORTISTA
  id text primary key, id_pedido text references pedidos(id),
  ped text, tienda text, transportista text, flujo text, evento text, fecha timestamptz
);
```

### Lo que NO está en las 9 hojas y hay que decidir dónde va (inventario §5)

- ~~Checkboxes "Store Delivery" de `RESUMEN_ADMIN`~~ — **Descartado 2026-07-28 por decisión del usuario**: no es relevante ni necesario hoy, se suprime del alcance de la migración. No hace falta ninguna columna nueva para esto.
- **Override de capacidad de silueta** (5.2, hoy en `PropertiesService`): tabla `config_siluetas(silueta text primary key, posiciones integer not null)`. Ganancia real: el `UPDATE` sobre una fila concreta ya serializa correctamente sin necesitar el lock de 10s de `actualizarPosicionesSilueta` (Backend.gs:94) — hoy hace falta el lock porque es "un JSON con todas las siluetas dentro"; en Postgres cada silueta es su propia fila.

---

## 3. Concurrencia: sustituir `LockService`

Postgres da dos primitivas que `LockService` no tiene: **constraints declarativas** (hacen ciertos estados irrepresentables, no solo improbables) y **transacciones con bloqueo de fila real** (`SELECT ... FOR UPDATE`, `INSERT ... ON CONFLICT`). Repaso de las 12 ocurrencias del inventario original (2026-07-28):

| Sitio actual (`LockService`) | Reemplazo en Postgres | Tipo de cambio |
|---|---|---|
| `EstructuraSheets.gs:258` `anadirFilas` (capacidad de grid) | Ninguno necesario — Postgres no tiene "grid" que ampliar; un `INSERT` multi-fila es atómico de por sí | El lock **desaparece**, no se traduce |
| `Backend.gs:94` `actualizarPosicionesSilueta` (JSON único de siluetas) | `UPDATE config_siluetas SET posiciones=$1 WHERE silueta=$2` — el `UPDATE` de una fila ya serializa | Constraint/normalización sustituye al lock |
| `Backend.gs:299` `marcarDireccion` (recalcular pct/estado del pedido) | `SELECT ... FOR UPDATE` sobre la fila del pedido dentro de una función RPC, o mejor: calcular `pct` con una subquery dentro del propio `UPDATE` en vez de leer-en-JS-y-reescribir | Transacción de fila |
| `Backend.gs:553` `intentarCompartirFrenteRemansur` | `INSERT INTO ocupacion_siluetas (...) ON CONFLICT (silueta,pos,layer) DO ...` — el propio `PRIMARY KEY` compuesto decide atómicamente quién "gana" la posición | **Constraint UNIQUE**, sin lock |
| `Backend.gs:886/933/958/1010/1048/3716/3742` (7 sitios sobre `CARGAS.items`) | `DELETE`/`UPDATE`/`INSERT` sobre `cargas_pedidos` (tabla normalizada, §2) | El problema **desaparece** al normalizar, no hace falta reemplazar el lock por nada equivalente |
| `Backend.gs:3602` `liberarPosicionesLote` | `UPDATE ocupacion_siluetas SET reservado=false WHERE (silueta,pos) IN (...)` — una sola sentencia | Sin lock |
| `Backend.gs:4648` `purgarPedidosAntiguos` | `DELETE FROM pedidos WHERE estado = ANY($1) AND actualizado < now() - interval '90 days'` en una transacción — decisión y borrado son la misma sentencia, no hay ventana entre "decidir" y "borrar" | Transacción única |
| `ImportarClasificacion.gs:154` `resincronizarPedidosActivos` (evitar líneas duplicadas) | Mejor opción: `UNIQUE(id_pedido, idx)` (o la combinación real que identifica una línea) en `lineas_preparacion` + `INSERT ... ON CONFLICT DO NOTHING` — convierte el problema de "no solapar reimportaciones" en una propiedad del dato, no en temporización de locks | Constraint reemplaza lógica de timeout |

### Inventario ampliado (2026-08-03) — 14 candados nuevos, encontrados por un bug real

Un pedido duplicado en producción (ver memoria, v193) llevó a auditar **todo** `Backend.gs`/`ImportarClasificacion.gs` en busca del mismo patrón "leer estado compartido → decidir → escribir sin candado". Resultado: 14 sitios más, ya corregidos con `LockService` en Apps Script (v193-v195, todos con Supabase diferido a después de soltar el candado, mismo criterio que el resto del código). **Todos caen en los MISMOS dos patrones de reemplazo ya identificados arriba** — no cambia el diseño de Postgres, solo amplía la lista de sitios a migrar:

| Función (candado añadido 2026-08-03) | Mismo patrón de reemplazo que… |
|---|---|
| `ImportarClasificacion.gs` `importarClasificacion` | fila `resincronizarPedidosActivos` de arriba — `UNIQUE(id)` en `pedidos` + `ON CONFLICT` en vez de "leer existentes en un mapa JS y decidir crear-o-actualizar" |
| `Backend.gs` `registrarPedidoManual`, `registrarRecogidasMasivo`, `registrarYaCargadosMasivo` | mismo `UNIQUE(id)` que arriba — las 3 crean filas `pedidos` nuevas con el mismo riesgo de duplicado que `importarClasificacion` |
| `Backend.gs` `cerrarPedido` (el que este documento ya señalaba como "el hallazgo más importante", ver justo abajo), `moverPedidoDeSilueta`, `corregirSoportesPedido`, `liberarPedidoDeSilueta`, `aplicarCompactarSiluetas` | fila `intentarCompartirFrenteRemansur` de arriba — `PRIMARY KEY (silueta,pos,layer)` + `ON CONFLICT` decide atómicamente quién gana la posición, sin lock |
| `Backend.gs` `crearCarga` | numeración secuencial (`SELECT max(num_carga)+1`) — en Postgres, una `SEQUENCE` o `nextval()` dentro de la misma transacción del `INSERT` resuelve esto de raíz, sin necesitar ni lock ni constraint de unicidad a posteriori |
| `Backend.gs` `cambiarFlujoPedido`, `cambiarFlujoPedidosMasivo`, `borrarPedidoNoSacado`, `reabrirPedido` | riesgo menor (no crean fila nueva ni reclaman posición física), pero mismo criterio de "transacción de fila" que `marcarDireccion` de arriba |

Nota aparte para cuando se audite esto en Postgres: `marcarPedidoEntregado` (Backend.gs) resultó ser **código muerto** (sin ninguna llamada real en toda la app) al hacer este inventario — no migrar su lógica sin más, tiene además su propio bug latente (no libera `ocupacion_siluetas`). Decidir explícitamente si se recupera o se borra, no arrastrarla "por si acaso".

### El hallazgo más importante para la migración: la carrera de `cerrarPedido()` — YA mitigada en Apps Script, pendiente de solución definitiva en Postgres

~~El propio código documenta (`Backend.gs:4627-4641`) que `cerrarPedido()`/`confirmarEntregas()` **no tienen lock propio** y que el riesgo se acepta conscientemente porque *"la operativa está CERRADA de 22:00 a 06:00"*.~~ **Actualización 2026-08-03: esto ya no es exacto.** `confirmarEntregas()` ya tenía candado propio desde antes de este documento (patrón "reclamo temprano": adquiere el candado solo para marcar la carga como CERRADA, lo suelta enseguida y hace el resto del trabajo sin él). `cerrarPedido()` **no lo tenía** cuando se escribió este párrafo — confirmado real con un bug en producción (pedidos duplicados, no exactamente el mismo síntoma que aquí se anticipaba pero la MISMA causa raíz) — y **ya tiene candado propio desde el 2026-08-03** (`LockService.getScriptLock()`, ver inventario ampliado arriba). El riesgo de dos operarios chocando en la misma posición está mitigado hoy en Apps Script, no solo "aceptado por el cierre nocturno".

La constraint `primary key (silueta, pos, layer)` de `ocupacion_siluetas` (§2) sigue siendo la solución CORRECTA y DEFINITIVA para cuando se migre: un `INSERT ... ON CONFLICT (silueta,pos,layer) DO NOTHING RETURNING *` le dice atómicamente a `cerrarPedido()` si consiguió la posición o si otro pedido se le adelantó, sin ningún lock explícito — más robusto que un `LockService` de aplicación, que solo protege si TODOS los caminos de escritura pasan por el candado (un futuro sitio nuevo que se olvide de adquirirlo reintroduciría el bug; una constraint de base de datos no se puede "olvidar poner" en un INSERT). **La migración no es ya "corregir una carrera sin mitigar", es "sustituir una mitigación de aplicación por una garantía de base de datos"** — sigue siendo trabajo real y sigue siendo necesario, pero el nivel de riesgo de partida es menor del que este documento describía originalmente.

Esto **no es solo portar el comportamiento actual, es corregirlo** — y eso es una decisión de negocio, no solo técnica: hoy, si dos operarios chocan, el candado de `LockService` serializa el segundo intento (espera y reintenta, o falla con un mensaje claro si el candado no llega a tiempo) — ya no "gana en silencio" dejando datos inconsistentes como cuando se escribió este documento. Con la constraint de Postgres, el segundo en escribir **recibe un conflicto explícito** igualmente, pero sin depender de que la aplicación recuerde adquirir el candado. Si la migración a Supabase coincide con abrir más de una tienda operando a la vez o extender el horario, este cambio de comportamiento sigue siendo importante de verificar antes de ir a producción, aunque ya no sea urgente por sí solo.

### Coste real de esta sustitución

Sustituir los locks (7 del inventario original + 14 añadidos el 2026-08-03 = 21 en total, ver ambas tablas arriba) exige mover la lógica compuesta (leer→decidir→escribir sobre varias filas relacionadas) a **funciones de Postgres (RPC)**, no simplemente cambiar la URL a la que apunta `UrlFetchApp` — ver §4. Si no se hace así y en su lugar se encadenan varias llamadas PostgREST sueltas desde Apps Script (un `GET`, luego un `DELETE`, luego un `UPDATE`, cada uno una petición HTTP independiente), **se pierde la atomicidad que hoy da `LockService`** — sería peor que el sistema actual, no igual.

---

## 4. Sustitución de los helpers (`EstructuraSheets.gs`)

### `getSS()` / `getHoja()` desaparecen

No hay "abrir el Spreadsheet" ni "hoja física que autocrear" — el nombre de tabla es un string fijo. La memoización de 0,5s deja de tener sentido (no hay ese coste de apertura), pero conviene guardar `SUPABASE_URL` una vez por ejecución igual que hoy se guarda el ID del Spreadsheet.

```javascript
function supaConfig_() {
  var p = PropertiesService.getScriptProperties();
  return { url: p.getProperty('SUPABASE_URL'), key: p.getProperty('SUPABASE_SERVICE_KEY') };
}
```

### `leerHoja(clave)` → `GET` con filtros PostgREST

```javascript
function leerHoja(tabla, filtroPostgrest) {
  // filtroPostgrest opcional, p.ej. "estado=eq.ABIERTO&order=actualizado.desc&limit=200"
  var cfg = supaConfig_();
  var url = cfg.url + '/rest/v1/' + tabla + '?select=*' + (filtroPostgrest ? '&' + filtroPostgrest : '');
  var resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() >= 300) throw new Error('leerHoja(' + tabla + '): ' + resp.getContentText());
  return JSON.parse(resp.getContentText());   // ya no hace falta añadir obj._fila: el id real hace ese papel
}
```

**Cambio de call-site no trivial**: hoy medio código depende de `obj._fila` (número de fila 1-based) para poder escribir después con `actualizarFila(clave, numFila, ...)`. Con PostgREST no hay "número de fila" — todo update/delete filtra por `id=eq.xxx`. Esto obliga a **auditar cada sitio que hoy usa `._fila`** y sustituirlo por el `id` de negocio; no es un cambio interno del helper, es un cambio de contrato que toca `Backend.gs` en muchos puntos (el inventario no cuantifica cuántos usos de `._fila` hay — habría que hacer ese `grep` antes de estimar el esfuerzo real).

### `anadirFila` / `anadirFilas` → `POST`

```javascript
function anadirFilas(tabla, objs) {           // ya no hace falta lock de "capacidad de grid": no existe ese concepto en Postgres
  var cfg = supaConfig_();
  var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + tabla, {
    method: 'post',
    headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key,
               'Content-Type': 'application/json', Prefer: 'return=representation' },
    payload: JSON.stringify(objs),             // PostgREST acepta array → inserta varias filas en una sola llamada
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() >= 300) throw new Error('anadirFilas(' + tabla + '): ' + resp.getContentText());
  return JSON.parse(resp.getContentText());
}
```

### `actualizarFila` / `escribirFila` → colapsan en UNA función

En Sheets hacía falta distinguir "releer y fusionar cambios parciales" (`actualizarFila`) de "escribir un objeto ya completo" (`escribirFila`) porque `setValues` sobre una fila exige la fila entera. **PostgREST `PATCH` ya es parcial por naturaleza** — esta distinción deja de existir:

```javascript
function actualizarFila(tabla, id, cambiosParciales) {
  var cfg = supaConfig_();
  var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + tabla + '?id=eq.' + encodeURIComponent(id), {
    method: 'patch',
    headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json' },
    payload: JSON.stringify(cambiosParciales),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() >= 300) throw new Error('actualizarFila(' + tabla + '): ' + resp.getContentText());
}
```

### `actualizarColumnaLote` → `PATCH` con filtro `in.(...)`

```javascript
function actualizarColumnaLote(tabla, ids, columna, valor) {
  var cfg = supaConfig_();
  var filtro = 'id=in.(' + ids.map(encodeURIComponent).join(',') + ')';
  var cuerpo = {}; cuerpo[columna] = valor;
  UrlFetchApp.fetch(cfg.url + '/rest/v1/' + tabla + '?' + filtro, {
    method: 'patch',
    headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json' },
    payload: JSON.stringify(cuerpo)
  });
}
```

### `limpiarHoja` → necesita una función RPC, no un `DELETE` directo

PostgREST exige un filtro explícito en `DELETE` (medida de seguridad real de PostgREST — no deja borrar tabla entera sin condición), y no expone `TRUNCATE`. Hace falta una función de Postgres expuesta como RPC:

```sql
create or replace function limpiar_tabla(p_tabla text) returns void language plpgsql as $$
begin
  execute format('truncate table %I', p_tabla);
end $$;
```
```javascript
UrlFetchApp.fetch(cfg.url + '/rest/v1/rpc/limpiar_tabla', {
  method: 'post', headers: {...}, payload: JSON.stringify({p_tabla: 'log_actividad'})
});
```

### Las operaciones compuestas (7 sitios de `CARGAS.items`) → funciones RPC, no varias llamadas sueltas

```sql
create or replace function quitar_pedido_de_carga(p_carga_id text, p_pedido_id text)
returns void language plpgsql as $$
begin
  delete from cargas_pedidos where carga_id = p_carga_id and pedido_id = p_pedido_id;
  update pedidos set numero_carga = null where id = p_pedido_id;
end $$;
```
```javascript
function quitarPedidoDeCarga(cargaId, pedidoId) {
  var cfg = supaConfig_();
  var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/rpc/quitar_pedido_de_carga', {
    method: 'post',
    headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json' },
    payload: JSON.stringify({ p_carga_id: cargaId, p_pedido_id: pedidoId }),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() >= 300) throw new Error('quitarPedidoDeCarga: ' + resp.getContentText());
}
```

Esto es el cambio de fondo que pide el punto 3: **la lógica de negocio compuesta se mueve, en parte, a PL/pgSQL dentro de Postgres**. Ver el coste de esto en §8 — no es gratis en términos de mantenimiento del equipo.

---

## 5. Visibilidad manual: ¿el Table Editor de Supabase cubre lo que hoy cubre Sheets?

El Table Editor de Supabase **sí** es una rejilla tipo hoja de cálculo (filtros, orden, edición de celda, relaciones por FK navegables) — para el caso de uso de la sección 5.8 del inventario (funciones de mantenimiento tipo `repararOcupacionInconsistente()` lanzadas a mano para arreglar un caso puntual) lo cubre igual o mejor: se puede filtrar por SQL en vez de buscar visualmente en 1.300+ filas.

Pero hay tres usos de Sheets en el inventario que **no** se cubren igual:

1. **Checkboxes de `RESUMEN_ADMIN` (5.1)**: aquí Postgres en realidad mejora el problema de fondo — con `pedidos.store_delivery_marcado boolean` normal, ya no hace falta el patrón "leer el checkbox antes de borrar la hoja, reescribirlo después" (`storeDeliveryPrevio`, Backend.gs:5477-5486); el dato simplemente persiste en su fila y una vista (`RESUMEN_ADMIN` como `VIEW` SQL) se regenera sin destruir nada. Es una ganancia real, no una pérdida — pero exige decidir el sitio del dato (ver §2) antes del corte, si no, se repite el mismo problema con otro nombre.
2. **Acceso "abrir desde Drive" (5.5) y compartir por enlace de Google**: hoy cualquiera con el enlace de Drive y permiso de visor abre `RESUMEN_ADMIN` sin credenciales adicionales. El Table Editor de Supabase exige **login en el proyecto de Supabase** y, por defecto, un usuario con acceso ve **todo el esquema**, no una pestaña concreta — si se quiere dar a un admin de tienda solo esa vista, hay que dar de alta su usuario en el proyecto de Supabase y escribir políticas RLS que limiten qué ve, gestión de identidad que hoy no existe (hoy es "compartir la Sheet"). Esto es trabajo adicional real de la migración, no un simple "usa el Table Editor en vez de Sheets".
3. **Consulta casual desde el móvil / autoservicio de negocio**: la app de Google Sheets en el móvil es trivial para un supervisor de almacén; Supabase Studio es una consola web pensada para desarrolladores, no para consulta casual desde el suelo de nave. Tampoco tiene fórmulas/pivotes/gráficos ad hoc — cualquier análisis de negocio autoservicio que hoy alguien resuelva con una fórmula de Sheets pasaría a depender de que alguien escriba SQL o una vista.

**Recomendación concreta**: no asumir que el Table Editor sustituye 1:1 el hábito de "abrir la Sheet de RESUMEN_ADMIN desde Drive". O se mantiene una hoja de solo lectura, sincronizada una vez al día desde Supabase mediante un trigger de Apps Script (lee de Postgres, escribe en una Sheet de solo consulta), o se construye una pantalla específica dentro de la propia Web App para el caso de los checkboxes — no dejarlo para "ya se verá con el Table Editor".

---

## 6. Estrategia de migración: corte y rollback

### Por fases, no big-bang — aprovechando una ventana que el propio sistema ya usa

La operativa está cerrada de 22:00 a 06:00 y el sistema **ya** ejecuta cada noche a las 23:00 su propio proceso de snapshot/purga (`SnapshotDiario.gs`) — esa ventana nocturna es el punto de corte natural, no hay que inventarla.

**Fase 0 — Preparación (sin tocar producción)**
- Crear proyecto Supabase, aplicar el DDL de §2, decidir políticas RLS (aunque el único cliente sea Apps Script con `service_role`, diseñar las políticas desde ya evita tener que retrofitarlas bajo presión el día que se abra el Table Editor a más personas — ver §5).
- Crear un **segundo proyecto Supabase de staging** — hoy no existe ningún entorno de pruebas (un solo Spreadsheet ID en `PropertiesService` = un solo entorno); añadir un toggle `ENTORNO=STAGE|PROD` en `PropertiesService` como parte de esta migración, no después.

**Fase 1 — Escritura en sombra (dual-write)**
Los nuevos helpers escriben en Sheets **y** en Supabase durante N días; las lecturas siguen viniendo de Sheets. Comparar cada noche recuento de filas y checksums entre ambos. Esto es lo que da un punto de rollback limpio más adelante — sin esta fase, el primer test real del datastore nuevo sería producción.

**Fase 2 — Migración de datos históricos**
Export por lotes de las 9 hojas (con el volumen citado — 4014 líneas/1313 pedidos solo en Málaga en un momento dado, multiplicado por 3-4 tiendas — probablemente varias decenas de miles de filas totales) vía `POST` masivo a PostgREST, troceado para respetar los límites de `UrlFetchApp` (payload y los 6 minutos de ejecución por invocación de Apps Script). Migrar explícitamente, y no como "vacío":
- Los checkboxes actuales de `RESUMEN_ADMIN` → columna decidida en §2, no dejarlos en blanco.
- El override de `PropertiesService` de posiciones por silueta → `config_siluetas`.

**Fase 3 — Corte de lecturas (dentro de la ventana 22:00–06:00)**
Parar el dual-write, apuntar `leerHoja`/`actualizarFila` solo a Supabase, ejecutar la purga/snapshot nocturna ya contra Supabase, reabrir operativa a las 06:00. La copia de Sheets queda congelada (de solo lectura) como fallback inmediato.

**Rollback**
Como el despliegue de Apps Script es versionado, el rollback es "volver a desplegar la versión anterior de la Web App", que sigue apuntando a Sheets — y Sheets sigue teniendo datos frescos (como mucho unas horas desactualizados) gracias a la Fase 1. **Este rollback hay que ensayarlo al menos una vez antes del corte real**, no asumir que "simplemente funcionará" la noche del corte.

**Explícitamente fuera del alcance de este corte** (para no repetir el error de "romper algo por refactorizar cerca"): el Spreadsheet externo de Disponibilidad (5.3) y los snapshots diarios en Drive (5.4) siguen escribiéndose exactamente igual que hoy, con `getRange`/`setValue` en bruto — no tocar ese código al mismo tiempo que se reescribe `EstructuraSheets.gs`.

---

## 7. Coste y límites

Cifras de referencia del tier gratuito de Supabase (verificar en la página de precios vigente antes de comprometerse, puede haber cambiado): ~500 MB de base de datos, proyecto que **se pausa tras ~1 semana de inactividad**.

- **Volumen**: con la cifra real del inventario (4014 líneas → 1313 pedidos en Málaga en un momento dado) y purga a 90 días, el total activo en las 4 tiendas probablemente se mueve en decenas de miles de filas — trivialmente por debajo de 500 MB. **El almacenamiento no es la restricción real.**
- **La restricción real es la pausa por inactividad del tier gratuito**: este sistema corre disparadores nocturnos desatendidos (purga, snapshot) todos los días laborables — un proyecto gratuito que se pausa por "falta de actividad" (definida por Supabase, no controlable desde el código) rompería silenciosamente esos disparadores en cuanto pasara una semana sin ellos activarse (p. ej. vacaciones, cierre por fiestas). **Esto obliga a tier de pago (Pro, dato de referencia ~25 $/mes) desde el primer día**, no por volumen ni por tráfico, sino únicamente por la garantía de disponibilidad 24/7 sin pausas.
- **Conexiones/requests**: el patrón de Apps Script (muchas peticiones HTTP cortas y sin estado vía `UrlFetchApp`, no conexiones persistentes) encaja bien con el *pooler* de PostgREST — cada llamada es una petición HTTP normal, no una conexión de base de datos retenida. Es poco probable que el límite de conexiones concurrentes sea un problema a esta escala, pero **no hay datos en el inventario de peticiones/día actuales** para confirmarlo con números — medirlo, no asumirlo.
- **El límite que sí puede morder es el de `UrlFetchApp` del lado de Google** (cuota diaria de llamadas salientes compartida por todos los scripts del dominio de Workspace), no nada del lado de Supabase — como hoy "TODA la app lee esas hojas enteras en casi cada petición" (`Backend.gs:4610`), el número de llamadas HTTP no debería aumentar mucho al migrar (una lectura sigue siendo una llamada), pero conviene medir el conteo actual antes de asumir que no habrá impacto.

---

## 8. Riesgos concretos de esta opción (no genéricos)

1. **Concentración de la `service_role key`** (ya detallado en §1): pasa de "quien tiene Editor del Spreadsheet" a "quien tiene Editor del script puede leer una clave que da acceso root a toda la base de datos". Requiere disciplina de acceso y un runbook de rotación que hoy no existe para nada equivalente.
2. **Pérdida del "deshacer" implícito de Sheets**: Ctrl+Z y el historial de versiones de Google Sheets dan una red de seguridad informal contra errores humanos que Postgres no tiene de forma nativa. Un error en una función RPC (p. ej. una condición mal escrita en `quitar_pedido_de_carga`) puede corromper datos sin un "deshacer" accesible a un no-técnico — mitigable con Point-in-Time Recovery (incluido en Supabase Pro) pero eso exige que alguien sepa restaurar a un punto en el tiempo, no es tan directo como pulsar Ctrl+Z.
3. **Bifurcación de la lógica de negocio entre dos lenguajes**: para preservar la atomicidad que hoy da `LockService` en las 7 operaciones sobre `CARGAS.items` (§3), la forma correcta es mover esa lógica a funciones PL/pgSQL en Postgres. El equipo que mantiene hoy el sistema trabaja en JavaScript/Apps Script — introducir PL/pgSQL como "la forma correcta de hacerlo" exige una competencia nueva; si se salta este paso y en su lugar se encadenan llamadas PostgREST sueltas desde Apps Script, **se reintroducen las mismas condiciones de carrera que el sistema actual, sin ningún lock que las mitigue** — peor que hoy, no igual.
4. **La carrera hoy "aceptada conscientemente" deja de ser aceptable si cambia el contexto operativo**: el propio código dice que el riesgo de `cerrarPedido()`/`confirmarEntregas()` sin lock se acepta *porque* la operativa está cerrada de noche. Si esta migración se hace a la vez que se plantea abrir más tiendas concurrentes u horarios extendidos, ese riesgo pasa a ser inaceptable y **debe** resolverse con la constraint `UNIQUE(silueta,pos,layer)` de §2/§3 antes de ir a producción — es una decisión de negocio que hay que forzar explícitamente, no dejar que se cuele como "detalle técnico ya resuelto".
5. **Estado que vive fuera de las 9 hojas oficiales es el candidato más probable a perderse el día del corte**: los checkboxes de `RESUMEN_ADMIN` (5.1) y el override de `PropertiesService` (5.2) no están en el esquema de las 9 hojas — si el proyecto de migración se acota estrictamente a "migrar las 9 hojas" (como el propio inventario aclara que fue su alcance deliberado), estos dos quedan fuera por defecto y se pierden exactamente como ya advierte la propia UI de la app (*"no se recuperan"*). Este es el riesgo de regresión más concreto y más fácil de prevenir con solo nombrarlo a tiempo.
6. **Dependencias externas cerca del código que se va a tocar, fáciles de romper por "limpieza" accidental**: el Spreadsheet externo de Disponibilidad (5.3, gestionado a mano por otro equipo) y los snapshots de Drive (5.4) usan `getRange`/`setValue` en bruto, justo al lado del código que se va a reescribir. Un ingeniero bien intencionado puede verlos como "código legado a limpiar" y tocarlos sin darse cuenta de que otro equipo depende de ellos — deben quedar marcados explícitamente como fuera de alcance en el propio código, no solo en un documento aparte.
7. **`RETIRADAS_STOCK` (5.6) no se arregla solo por cambiar de base de datos**: es una hoja del esquema sin lector/escritor activo — la funcionalidad real vive en un script de PowerShell que el operario ejecuta en su propio PC precisamente porque **Adeo bloquea el tráfico saliente desde plataformas cloud** (Apps Script, Cloudflare Workers, ya probado). Supabase también es una plataforma cloud — si en algún momento se plantea "ya que migramos, hagamos que el PowerShell escriba directamente a Supabase", ese tráfico seguiría bloqueado por el mismo motivo que impidió la arquitectura server-side original. Vale la pena decirlo explícitamente para que no se intente "arreglar" esto como efecto colateral de esta migración.
8. **No hay entorno de pruebas hoy** (un solo Spreadsheet ID = un solo entorno): si la migración no incluye desde el principio un proyecto Supabase de staging y un toggle de entorno en `PropertiesService`, el primer test real del nuevo datastore es la propia producción — coherente con lo señalado en §6, pero merece constar aquí como riesgo de proceso, no solo de arquitectura.