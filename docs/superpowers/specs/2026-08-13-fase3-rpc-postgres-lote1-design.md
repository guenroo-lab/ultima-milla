# Fase 3 (pieza 1) — Capa de RPC y constraints en Postgres para sustituir `LockService`

> Este documento es una sub-pieza de la Fase 3 descrita en `2026-07-28-migracion-sheets-supabase-design.md` (§3, §6). Cubre **solo** la sustitución de los 26 sitios de `LockService.getScriptLock()` por su equivalente en Postgres — construida y probada contra el esquema `staging` de Supabase (`lm-malaga`, ref `erinkqzsywhuiilirhdc`), **sin tocar Backend.gs todavía**. Las lecturas de la app siguen viniendo de Sheets durante todo este documento.
>
> Explícitamente fuera de alcance de este documento (piezas futuras, cada una con su propia sesión de diseño):
> - **Pieza 2**: reescribir `EstructuraSheets.gs`/`Backend.gs` para llamar a estas funciones en vez de a `LockService` + Sheets, y auditar los usos de `._fila`.
> - **Pieza 3**: el corte real de lecturas (ventana 22:00-06:00), ensayo de rollback, runbook.

---

## 1. Categorización completa de los 26 candados

Se leyó el código real de las 29 ubicaciones de `LockService.getScriptLock()` (26 sitios lógicos, algunos comparten el mismo punto de escritura) en `Backend.gs`, `ImportarClasificacion.gs` y `EstructuraSheets.gs`, y se contrastó contra el esquema real ya existente en Supabase (`list_tables`, schema `public`).

**Sin RPC, solo constraint + llamada PostgREST directa (3):**

| Función Sheets | Reemplazo Postgres |
|---|---|
| `actualizarPosicionesSilueta` | Upsert en `config_siluetas` (PK `silueta` ya existe) |
| `confirmarEntregas` (solo el "reclamo" inicial) | `PATCH cargas?id=eq.<id>&estado=eq.GENERADA` body `{estado:'CERRADA'}` — 0 filas afectadas = ya reclamada por otro |
| `liberarPosicionesLote` | N `DELETE ocupacion_siluetas?silueta=eq.X&pedido=eq.Y&pos=gte.ini&pos=lte.fin` independientes |

**Desaparecen del todo (4)** — condicionado a que la Pieza 2 reescriba la pantalla de carga para leer `flujo`/`transportista`/`silueta`/posición con un `JOIN` en vivo contra `pedidos`, en vez de un snapshot congelado (que es justo la intención original del diseño de `cargas_pedidos`, confirmada ahora: la tabla no tiene columnas de snapshot):
`_sincronizarFlujoEnCargaActiva`, `sincronizarPosicionEnCargaActiva`, `_sincronizarPosicionesEnCargasLote`, `anadirFilas` (capacidad de grid, concepto que no existe en Postgres).

**Necesitan una función RPC en PL/pgSQL (21 funciones únicas):**

| Grupo | Funciones RPC | Funciones "solo constraint" del mismo lote |
|---|---|---|
| Reclamo de posición (**Lote 1**, este documento) | `compartir_frente_remansur` (interna), `cerrar_pedido`, `mover_pedido_de_silueta`, `corregir_soportes_pedido`, `liberar_pedido_de_silueta`, `aplicar_compactar_siluetas` | `liberarPosicionesLote` |
| Cargas (Lote 2) | `crear_carga`, `quitar_pedido_de_carga`, `eliminar_carga_completa`, `anadir_pedido_a_carga` | `confirmarEntregas` |
| Ciclo de vida de pedidos (Lote 3) | `importar_clasificacion`, `resincronizar_pedidos_activos`, `registrar_pedido_manual`, `registrar_recogidas_masivo`, `registrar_ya_cargados_masivo`, `reabrir_pedido`, `borrar_pedido_no_sacado`, `cambiar_flujo_pedido`, `cambiar_flujo_pedidos_masivo` | — |
| Hot path + mantenimiento (Lote 4) | `marcar_lineas_direccion`, `purgar_pedidos_antiguos` | `actualizarPosicionesSilueta` |

Las 4 funciones que "desaparecen" (§1) no pertenecen a ningún lote — se resuelven solas cuando la Pieza 2 reescriba la pantalla de carga para leer en vivo.

## 2. Orden de los 4 lotes

| Lote | Prioridad | Motivo |
|---|---|---|
| **1 — Reclamo de posición** | Máxima — se implementa ya | Es el "hallazgo más importante" del diseño original: la carrera que ya causó un bug real de pedidos duplicados en producción (v193). |
| 2 — Cargas | Alta, después del 1 | Depende de que `pedidos`/`ocupacion_siluetas` ya tengan su capa RPC de referencia. |
| 3 — Ciclo de vida de pedidos | Media | Grupo grande pero repetitivo: mismo patrón "upsert condicional" una y otra vez. |
| 4 — Hot path + mantenimiento | Última | `marcar_lineas_direccion` corre en cada escaneo de artículo — se aísla a propósito para medir su latencia real con calma, no mezclada con el resto. |

Este documento diseña **solo el Lote 1** en detalle. Los Lotes 2-4 quedan con la lista de funciones y tablas ya identificadas (tabla de arriba) como punto de partida cuando se retomen, pero sin firma ni comportamiento detallado todavía — eso se hace en su propia sesión, no aquí, para no adivinar detalles de código que no se ha vuelto a leer.

---

## 3. Reglas de negocio que el Lote 1 DEBE preservar exactamente

Estas reglas están confirmadas leyendo el código real (`Backend.gs`), no supuestas — cualquier implementación de las funciones de abajo que no las respete es un bug de regresión, no una simplificación válida:

1. **Remansur se salta la validación de conflicto por completo** (`validarAsignacionManual`, línea 525): si `flujo` es `remansur_transporte` o `remansur_pro`, la posición se reclama "como decida el operario", sin comprobar si ya está ocupada — solo se valida que no se salga del rango físico de la silueta. Para cualquier otro flujo, sí se exige que las posiciones estén libres.
2. **Bultos (0 posiciones) no generan filas de `ocupacion_siluetas`**: si `calcularPosiciones(soportes)` da 0 posiciones, el pedido va a la "posición 0" (ilimitada, varios pedidos la comparten) — no hay nada que reclamar ni validar.
3. **Reparto de delante Remansur**: un pedido Remansur de un solo soporte de media posición (`ocupa === 0.5`) puede ocupar el `front` de una posición cuyo `back` ya es de OTRO pedido Remansur y cuyo `front` sigue `reservado`, en vez de abrir una posición física nueva. Esto exige mirar la fila `back` de la MISMA posición al decidir si la fila `front` se puede escribir — no es expresable como un filtro PostgREST plano (necesita ver dos filas relacionadas a la vez), de ahí que sea RPC.
4. **`calcularPosiciones`**: ordena los soportes de mayor a menor ocupación; cada soporte con `ocupa >= 1.0` reclama una posición entera (`back`+`front`); cada par de soportes con `ocupa === 0.5` comparte una posición (dos "medios" → una posición `back`+`front`); un soporte con `ocupa === 0.5` suelto (sin pareja) reclama una posición con `front: reservado` (medio ocupado, medio disponible para compartir); soportes con `ocupa === 0` (bultos) no reclaman nada. Esta función es pura (sin I/O) — se traduce literalmente a PL/pgSQL o se mantiene en Apps Script y se le pasa el resultado ya calculado a la RPC (ver §5, decisión de diseño).
5. **Mover/corregir**: solo se libera el hueco viejo DESPUÉS de validar que el destino es válido — nunca debe quedar un pedido sin ningún hueco a medio camino si el destino falla.
6. **Ambigüedad de número de pedido entre tiendas**: `numPed` no es único por sí solo (el id real es tienda+número). Si se pasa `tienda`, se exige coincidencia exacta; si no se pasa y hay más de un candidato, se rechaza por ambigüedad — nunca "adivinar" cuál.

## 4. Decisión de diseño: ¿dónde vive `calcularPosiciones`?

`calcularPosiciones(soportes)` es lógica pura de empaquetado (ordenar soportes, decidir cuántas posiciones y con qué layout `back`/`front`/`reservado`) — no toca ninguna tabla. Dos opciones:

- **(A) Reimplementarla en PL/pgSQL** dentro de `cerrar_pedido`/`mover_pedido_de_silueta`/etc. — evita depender de que el llamador la calcule bien, pero duplica lógica de negocio en dos lenguajes (riesgo ya señalado en el documento de diseño padre, §8.3: bifurcación JS/PL/pgSQL).
- **(B) Mantenerla en Apps Script** (o, tras la Pieza 2, en el propio cliente/Backend.gs) y pasar el resultado ya calculado (`posiciones: [{back, front}, ...]`) como parámetro `jsonb` a la RPC, que solo se encarga de la parte que SÍ necesita atomicidad (reclamar filas, validar conflicto, escribir `pedidos`).

**Recomendación: (B).** `calcularPosiciones` no tiene ninguna condición de carrera (es una función pura sobre el input que ya tiene el cliente) — no hay ninguna razón de concurrencia para moverla a Postgres, y mantenerla en un solo lenguaje reduce superficie de PL/pgSQL nuevo, justo el riesgo que el documento padre ya señalaba como el más caro de esta migración. Las RPC de este lote reciben `p_posiciones jsonb` ya calculado, no `p_soportes` crudo.

---

## 5. Diseño de las funciones del Lote 1

Todas viven en un nuevo archivo de migración `supabase/migrations/<timestamp>_lote1_reclamo_posicion.sql` (ver §7), aplicadas primero contra `staging` vía `apply_migration` (MCP), nunca escritas a mano en el SQL Editor de producción.

### 5.1 `_liberar_ocupacion(p_silueta text, p_pos_ini int, p_pos_fin int, p_pedido text)` — función interna (no expuesta como RPC)

Reemplaza `liberarPosiciones()`. Un único `DELETE`:

```sql
create or replace function _liberar_ocupacion(p_silueta text, p_pos_ini int, p_pos_fin int, p_pedido text)
returns void language sql as $$
  delete from ocupacion_siluetas
  where silueta = p_silueta and pos between p_pos_ini and p_pos_fin and pedido = p_pedido;
$$;
```

Nota: filtra también por `pedido` (no solo silueta+pos), igual que el original — con el reparto de delante Remansur, dos pedidos distintos pueden compartir una posición (uno en `back`, otro en `front`); liberar uno no debe tocar la fila del otro.

### 5.2 `compartir_frente_remansur(p_silueta text, p_pos int, p_ped text, p_tienda text, p_flujo text)` — función interna

Reemplaza `intentarCompartirFrenteRemansur()`. Reclamo condicional de una fila `front` mirando la fila `back` de la misma posición — necesita `UPDATE ... FROM` (self-join), no expresable en un filtro PostgREST plano:

```sql
create or replace function compartir_frente_remansur(p_silueta text, p_pos int, p_ped text, p_tienda text, p_flujo text)
returns boolean language plpgsql as $$
declare v_ok boolean := false;
begin
  update ocupacion_siluetas front
  set pedido = p_ped, tienda = p_tienda, flujo = p_flujo, reservado = false
  from ocupacion_siluetas back
  where front.silueta = p_silueta and front.pos = p_pos and front.layer = 'front'
    and back.silueta = p_silueta and back.pos = p_pos and back.layer = 'back'
    and back.flujo in ('remansur_transporte', 'remansur_pro')
    and front.reservado = true;
  get diagnostics v_ok = row_count;
  return v_ok > 0;
end $$;
```

### 5.3 `cerrar_pedido(p_id_pedido text, p_silueta text, p_pos_ini int, p_posiciones jsonb, p_soportes jsonb, p_operario text)`

Reemplaza `cerrarPedido()`. Devuelve `{ok, silueta, pos_ini, pos_fin, compartido, error}` — mismo contrato que hoy.

```sql
create or replace function cerrar_pedido(
  p_id_pedido text, p_silueta text, p_pos_ini int,
  p_posiciones jsonb,   -- [{back:true,front:true|false|'reservado'}, ...] ya calculado en el cliente
  p_soportes jsonb, p_operario text
) returns jsonb language plpgsql as $$
declare
  v_pedido pedidos%rowtype;
  v_num_pos int := jsonb_array_length(p_posiciones);
  v_pos_fin int;
  v_compartido boolean := false;
  v_i int; v_pos int; v_def jsonb;
begin
  select * into v_pedido from pedidos where id = p_id_pedido for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Pedido no encontrado'); end if;

  -- Bultos: sin posiciones físicas, ubicación 0
  if v_num_pos = 0 then
    update pedidos set estado='COMPLETADO_LISTO', silueta=p_silueta, pos_ini=0, pos_fin=0,
      soportes=p_soportes, operario=coalesce(p_operario, v_pedido.operario), actualizado=now()
      where id = p_id_pedido;
    return jsonb_build_object('ok', true, 'silueta', p_silueta, 'pos_ini', 0, 'pos_fin', 0);
  end if;

  -- Reparto de delante Remansur: 1 sola posición de media (front='reservado' en el cálculo)
  if v_num_pos = 1 and (p_posiciones->0->>'front') = 'reservado'
     and v_pedido.flujo in ('remansur_transporte','remansur_pro') then
    v_compartido := compartir_frente_remansur(p_silueta, p_pos_ini, v_pedido.ped, v_pedido.tienda, v_pedido.flujo);
    if v_compartido then
      update pedidos set estado='COMPLETADO_LISTO', silueta=p_silueta, pos_ini=p_pos_ini, pos_fin=p_pos_ini,
        soportes=p_soportes, operario=coalesce(p_operario, v_pedido.operario), actualizado=now()
        where id = p_id_pedido;
      return jsonb_build_object('ok', true, 'silueta', p_silueta, 'pos_ini', p_pos_ini, 'pos_fin', p_pos_ini, 'compartido', true);
    end if;
    -- si no era compartible, sigue el flujo normal de abajo
  end if;

  v_pos_fin := p_pos_ini + v_num_pos - 1;

  -- Validación: Remansur se SALTA el chequeo de conflicto (regla de negocio §3.1)
  if v_pedido.flujo not in ('remansur_transporte','remansur_pro') then
    if exists (
      select 1 from ocupacion_siluetas
      where silueta = p_silueta and pos between p_pos_ini and v_pos_fin
        and (layer = 'back' or reservado = false)
    ) then
      return jsonb_build_object('ok', false, 'error', 'Posición ya ocupada');
    end if;
  end if;

  -- Reclamar: back siempre, front según definición de cada posición
  for v_i in 0 .. v_num_pos - 1 loop
    v_pos := p_pos_ini + v_i;
    v_def := p_posiciones -> v_i;
    insert into ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
      values (p_silueta, v_pos, 'back', v_pedido.ped, v_pedido.tienda, v_pedido.flujo, false);
    if (v_def->>'front') = 'true' then
      insert into ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
        values (p_silueta, v_pos, 'front', v_pedido.ped, v_pedido.tienda, v_pedido.flujo, false);
    elsif (v_def->>'front') = 'reservado' then
      insert into ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
        values (p_silueta, v_pos, 'front', v_pedido.ped, v_pedido.tienda, v_pedido.flujo, true);
    end if;
  end loop;

  update pedidos set estado='COMPLETADO_LISTO', silueta=p_silueta, pos_ini=p_pos_ini, pos_fin=v_pos_fin,
    soportes=p_soportes, operario=coalesce(p_operario, v_pedido.operario), actualizado=now()
    where id = p_id_pedido;

  return jsonb_build_object('ok', true, 'silueta', p_silueta, 'pos_ini', p_pos_ini, 'pos_fin', v_pos_fin);
end $$;
```

**Por qué el `for update` en la primera línea es lo que sustituye al `LockService`**: bloquea la fila del pedido hasta el `COMMIT` de la transacción de la llamada RPC (PostgREST envuelve cada llamada RPC en su propia transacción), así que dos llamadas a `cerrar_pedido` para pedidos DISTINTOS en la MISMA silueta no chocan entre sí en la fila de `pedidos` (no la necesitan), pero sí serializan correctamente frente al `EXISTS` de conflicto de `ocupacion_siluetas` porque ese `SELECT`+`INSERT` ocurre dentro de la misma transacción PL/pgSQL — dos llamadas concurrentes para el mismo rango de posiciones: la segunda ve ya las filas que la primera insertó (aislamiento `READ COMMITTED` por defecto de Postgres es suficiente aquí porque el `INSERT` de la primera ya hizo commit visible antes de que la segunda evalúe su `EXISTS`, o si corren en el mismo instante, el `INSERT` de la que llega segunda espera el lock de fila de la primera si hay solape real de posición). Esto se **valida explícitamente** con la prueba de concurrencia real de §6, no se asume por diseño.

### 5.4 `mover_pedido_de_silueta`, `corregir_soportes_pedido`, `liberar_pedido_de_silueta`, `aplicar_compactar_siluetas`

Mismo patrón estructural que `cerrar_pedido` (validar destino respetando la regla Remansur, `_liberar_ocupacion` del hueco viejo, reclamar el nuevo, actualizar `pedidos`) — se implementan en el mismo archivo de migración siguiendo el mismo esqueleto ya validado por `cerrar_pedido`, no se repite aquí el SQL completo de las 3 restantes para no arrastrar una copia desincronizada; se escriben durante la implementación real (Tarea del plan), leyendo el cuerpo completo de cada función Sheets en ese momento (ya identificadas y resumidas en el informe de categorización de §1). `aplicar_compactar_siluetas(p_movimientos jsonb)` recibe un array de movimientos y los aplica dentro de la MISMA transacción, validando cada destino contra el estado ya modificado por los movimientos anteriores del mismo lote (no contra una foto tomada al principio) — igual que hace hoy la versión Sheets tras el bug v182.

### 5.5 `liberarPosicionesLote` — sin función nueva

No necesita RPC ni función auxiliar propia: la Pieza 2 la sustituye directamente por N llamadas `DELETE ocupacion_siluetas?silueta=eq.X&pedido=eq.Y&pos=gte.ini&pos=lte.fin` (una por rango de la lista recibida), apoyadas en la PK compuesta `(silueta,pos,layer)` ya existente. Se documenta aquí solo para que quede completo el cierre del Lote 1 — no hay nada que construir en esta pieza para ella.

---

## 6. Estrategia de pruebas de concurrencia

Para cada RPC que reclama una posición (`cerrar_pedido`, `mover_pedido_de_silueta`, `corregir_soportes_pedido`, `aplicar_compactar_siluetas`) o comparte un frente (`compartir_frente_remansur`), la prueba de corrección NO es solo "llamarla una vez y ver que el resultado es correcto" — hay que demostrar que dos llamadas **verdaderamente simultáneas** al mismo hueco no lo corrompen:

1. Poblar `staging.pedidos`/`staging.ocupacion_siluetas` con 2 pedidos de prueba y una silueta con huecos libres conocidos.
2. Disparar 2 peticiones HTTP `POST .../rpc/cerrar_pedido` en paralelo real (no secuenciales) contra la MISMA posición destino — usando `Promise.all`/llamadas paralelas reales, no un bucle `for` de Apps Script (que es de un solo hilo y nunca simularía la carrera real).
3. Verificar: exactamente una llamada devuelve `ok:true`, la otra `ok:false` con el error de conflicto; `ocupacion_siluetas` tiene exactamente las filas de la que ganó, ninguna fila huérfana ni duplicada.
4. Repetir el mismo patrón para el caso Remansur (dos pedidos Remansur al mismo hueco: ambos deben poder "ganar" porque Remansur no valida conflicto — confirmar que esto es el comportamiento DESEADO, no un bug, según regla §3.1) y para `compartir_frente_remansur` (dos intentos simultáneos de compartir el mismo `front`: solo uno debe ganar el `reservado=false`).

Cada función del lote se da por cerrada solo cuando su prueba de concurrencia específica pasa contra `staging`, no solo su prueba funcional en solitario.

## 7. Organización de las migraciones SQL

- Nuevo directorio `supabase/migrations/` en el repo del proyecto (no existe todavía) — un archivo por lote (`2026-08-13_lote1_reclamo_posicion.sql`, etc.), aplicado con `apply_migration` (MCP) contra `staging` primero, y contra `public` solo tras la confirmación explícita del usuario para ESE lote (mismo patrón ya seguido en Fase 2: nunca escribir contra `public` sin pedir permiso primero, ver hallazgo del clasificador de modo automático).
- Cada RPC se prueba con `execute_sql` (llamadas SQL directas simulando lo que hará PostgREST) antes de exponerla como endpoint — más rápido de iterar que pasar por `UrlFetchApp`/HTTP en cada ciclo.
- Los permisos (`grant execute on function ... to service_role`) se añaden explícitamente en la misma migración — igual que se tuvo que hacer con los `grant`/`alter default privileges` de `staging` en Fase 2, no se heredan solos.

---

## 8. Riesgos específicos de este documento

1. **PL/pgSQL es un lenguaje nuevo para el equipo** (ya señalado en el documento padre, §8.3) — el diseño de §4 (mantener `calcularPosiciones` fuera de Postgres) reduce la superficie nueva a propósito, pero las funciones de §5 sí son PL/pgSQL real y deben probarse con el mismo rigor que código nuevo en cualquier lenguaje, no con menos por "ser solo SQL".
2. **`READ COMMITTED` es el nivel de aislamiento por defecto de Postgres/Supabase** — el razonamiento de "por qué serializa" en §5.3 depende de eso. Si en algún momento se cambia el nivel de aislamiento de la conexión (no hay ninguna razón prevista para hacerlo), hay que revisar si el razonamiento sigue siendo válido.
3. **Esta pieza no reduce ningún riesgo hasta que la Pieza 2 la conecte** — mientras Backend.gs siga escribiendo en Sheets, estas RPC son código muerto en producción real (viven y se prueban solo en `staging`). No hay urgencia de negocio en tenerlas en `public` hasta que la Pieza 2 esté lista para llamarlas.
