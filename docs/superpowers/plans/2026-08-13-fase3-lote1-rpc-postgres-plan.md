# Fase 3 — Lote 1: RPC de reclamo de posición (Postgres) — Plan de implementación

> **Para quien ejecute este plan:** usa la skill `superpowers:executing-plans` (o `superpowers:subagent-driven-development` si hay subagentes disponibles). Sigue las tareas en orden — cada una tiene sus propios pasos numerados con checkbox.

**Goal:** Construir, aplicar y validar contra el esquema `staging` de Supabase las 6 funciones RPC + 2 helpers que sustituyen los 6 candados `LockService` del "Lote 1" (reclamo de posición física) descritos en `docs/superpowers/specs/2026-08-13-fase3-rpc-postgres-lote1-design.md`. **No se toca Backend.gs ni `public` (producción) en este plan** — eso es la Pieza 2 y una confirmación aparte, respectivamente.

**Architecture:** Cada función Sheets se traduce a una función PL/pgSQL expuesta como RPC de Supabase (`POST .../rest/v1/rpc/<nombre>`), aplicada vía la herramienta MCP `apply_migration` contra el proyecto `erinkqzsywhuiilirhdc` (`lm-malaga`), schema `staging`. Cada función se prueba con `execute_sql` (llamadas SQL directas, más rápido que pasar por HTTP) antes de darla por cerrada — primero un caso funcional simple, luego (para las que reclaman posición) una prueba de concurrencia real con llamadas verdaderamente paralelas.

**Tech Stack:** PostgreSQL 15 / PL-pgSQL (Supabase). Herramientas: MCP de Supabase (`apply_migration`, `execute_sql`, `list_tables`). Para las pruebas de concurrencia: llamadas HTTP paralelas reales vía PostgREST (no Apps Script, que es de un solo hilo).

**Hallazgo de esquema importante (verificado 2026-08-13, no asumido):** `ocupacion_siluetas.pos`, `pedidos.pos_ini` y `pedidos.pos_fin` son **`text`**, no `integer` (mismo gotcha ya documentado en Fase 1 para los filtros PostgREST: comparar como texto ordena mal — `'10' BETWEEN '1' AND '9'` da `true` porque lexicográficamente `'10' < '9'`). Todo el SQL de este plan castea explícitamente a `::int` para comparar/hacer aritmética y de vuelta a `::text` para escribir. `cargas_pedidos.pedido_id` sí almacena el `id` interno del pedido (verificado con una consulta real: `pedido_id='279::289161'` coincide con `pedidos.id`, no con `pedidos.ped`).

---

## File Structure

- Create: `supabase/migrations/` (directorio nuevo en el repo, no existe todavía)
- Create: `supabase/migrations/2026081301_seed_config_siluetas.sql`
- Create: `supabase/migrations/2026081302_helpers_lote1.sql`
- Create: `supabase/migrations/2026081303_compartir_frente_remansur.sql`
- Create: `supabase/migrations/2026081304_cerrar_pedido.sql`
- Create: `supabase/migrations/2026081305_mover_pedido_de_silueta.sql`
- Create: `supabase/migrations/2026081306_corregir_soportes_pedido.sql`
- Create: `supabase/migrations/2026081307_liberar_pedido_de_silueta.sql`
- Create: `supabase/migrations/2026081308_aplicar_compactar_siluetas.sql`
- Create: `supabase/migrations/2026081309_grants_lote1.sql`
- Modify: `Pruebas.gs` (un único diagnóstico de solo lectura, Tarea 1)

Cada `.sql` es el registro local exacto de lo que se aplica con `apply_migration` — un archivo por migración, mismo criterio que ya usó el propio Supabase en Fase 2 (`crear_esquema_staging_fase2`, `exponer_esquema_staging_en_api`).

---

## Tarea 1: Descubrir y sembrar las capacidades reales de silueta

`config_siluetas` existe pero está VACÍA (0 filas, verificado). Las 4 funciones que validan rango (`cerrar_pedido`, `mover_pedido_de_silueta`, `corregir_soportes_pedido`, indirectamente `aplicar_compactar_siluetas` vía los movimientos ya validados en `previsualizarCompactarSiluetas`) necesitan que `config_siluetas` tenga una fila por silueta con la capacidad EFECTIVA real (que puede llevar un override de admin aplicado en `PropertiesService`, no solo el valor por defecto del código) — no se puede adivinar, hay que leerlo de Apps Script.

- [ ] **Paso 1: Añadir diagnóstico de solo lectura a `Pruebas.gs`**

Como primera función física del archivo (patrón ya establecido: el editor autoselecciona la primera función al abrir, evita el desplegable de funciones no fiable):

```javascript
function ejecutarDiagnosticoCapacidadesSiluetas() {
  var out = CONFIG.SILUETAS.map(function(s) {
    return { silueta: s, posiciones: posicionesDeSilueta(s) };
  });
  Logger.log(JSON.stringify(out));
  return out;
}
```

Insertar esta función ANTES de cualquier otra en `Pruebas.gs` (mover el resto del archivo debajo, sin modificar nada más de su contenido).

- [ ] **Paso 2: Verificar sintaxis**

```bash
cp Pruebas.gs /tmp/check.js && node --check /tmp/check.js
```
Expected: sin salida (sintaxis válida). Si `node --check` falla por sintaxis de Apps Script no soportada en Node puro (poco probable en este archivo), verificar visualmente el diff en vez de bloquear en esto.

- [ ] **Paso 3: `clasp push` y ejecutar**

```bash
clasp push -f
```
Expected: lista de archivos subida, incluyendo `Pruebas.gs`.

Abrir el editor de Apps Script (proyecto `EXPPC`, script ID `17qJXVe6FDCHHTet2AqZivZExnjGI6EYS4Q6oc5_hKEV4S3QbN61JuO8-`) en el navegador, ir a `Pruebas.gs`, confirmar por zoom que el toolbar autoseleccionó `ejecutarDiagnosticoCapacidadesSiluetas` (NO tocar el desplegable), pulsar Ejecutar, esperar, abrir el registro de ejecución.

Expected: una línea de log con un array JSON de 6 objetos `{silueta, posiciones}` — uno por cada letra A-F.

- [ ] **Paso 4: Sembrar `config_siluetas` en staging con los valores REALES leídos**

Con los 6 valores exactos del log del Paso 3 (sustituir `<A>`...`<F>` por los números reales, NO asumir 16/16/16/16/27/27 aunque ese sea el valor por defecto esperado si nunca se ha usado el override):

```sql
insert into staging.config_siluetas (silueta, posiciones) values
  ('A', <A>), ('B', <B>), ('C', <C>), ('D', <D>), ('E', <E>), ('F', <F>)
on conflict (silueta) do update set posiciones = excluded.posiciones;
```

Ejecutar con `execute_sql` (`project_id: erinkqzsywhuiilirhdc`). Guardar este SQL con los valores reales ya sustituidos en `supabase/migrations/2026081301_seed_config_siluetas.sql`.

- [ ] **Paso 5: Verificar**

```sql
select * from staging.config_siluetas order by silueta;
```
Expected: 6 filas, valores coincidentes con el log del Paso 3.

---

## Tarea 2: Helpers `_max_pos_silueta` y `_liberar_ocupacion`

- [ ] **Paso 1: Escribir la migración**

`supabase/migrations/2026081302_helpers_lote1.sql`:

```sql
create or replace function staging._max_pos_silueta(p_silueta text) returns int
language sql stable as $$
  select posiciones from staging.config_siluetas where silueta = p_silueta
$$;

create or replace function staging._liberar_ocupacion(p_silueta text, p_pos_ini int, p_pos_fin int, p_pedido text)
returns void language sql as $$
  delete from staging.ocupacion_siluetas
  where silueta = p_silueta and pos::int between p_pos_ini and p_pos_fin and pedido = p_pedido;
$$;
```

- [ ] **Paso 2: Aplicar con `apply_migration`**

`name: "lote1_helpers"`, `project_id: "erinkqzsywhuiilirhdc"`, `query`: el contenido de arriba.

- [ ] **Paso 3: Probar `_liberar_ocupacion` con datos de prueba**

```sql
insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado) values
  ('A', '1', 'back', 'TEST001', 'Málaga', 'transporte', false),
  ('A', '1', 'front', 'TEST001', 'Málaga', 'transporte', false);
select staging._liberar_ocupacion('A', 1, 1, 'TEST001');
select count(*) from staging.ocupacion_siluetas where pedido = 'TEST001';
```
Expected: el `count(*)` final es `0`.

---

## Tarea 3: `compartir_frente_remansur`

- [ ] **Paso 1: Escribir la migración**

`supabase/migrations/2026081303_compartir_frente_remansur.sql`:

```sql
create or replace function staging.compartir_frente_remansur(
  p_silueta text, p_pos int, p_ped text, p_tienda text, p_flujo text
) returns boolean language plpgsql as $$
declare v_filas int;
begin
  update staging.ocupacion_siluetas front
  set pedido = p_ped, tienda = p_tienda, flujo = p_flujo, reservado = false
  from staging.ocupacion_siluetas back
  where front.silueta = p_silueta and front.pos::int = p_pos and front.layer = 'front'
    and back.silueta = p_silueta and back.pos::int = p_pos and back.layer = 'back'
    and back.flujo in ('remansur_transporte', 'remansur_pro')
    and front.reservado = true;
  get diagnostics v_filas = row_count;
  return v_filas > 0;
end $$;
```

- [ ] **Paso 2: Aplicar** (`name: "lote1_compartir_frente_remansur"`)

- [ ] **Paso 3: Prueba funcional — caso que SÍ comparte**

```sql
insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado) values
  ('B', '5', 'back', 'TESTR01', 'Málaga', 'remansur_transporte', false),
  ('B', '5', 'front', null, null, null, true);
select staging.compartir_frente_remansur('B', 5, 'TESTR02', 'Marbella', 'remansur_pro');
select * from staging.ocupacion_siluetas where silueta='B' and pos='5' and layer='front';
```
Expected: la función devuelve `true`; la fila `front` ahora tiene `pedido='TESTR02', tienda='Marbella', flujo='remansur_pro', reservado=false`.

- [ ] **Paso 4: Prueba funcional — caso que NO comparte (back no es Remansur)**

```sql
insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado) values
  ('B', '6', 'back', 'TESTN01', 'Málaga', 'transporte', false),
  ('B', '6', 'front', null, null, null, true);
select staging.compartir_frente_remansur('B', 6, 'TESTR03', 'Mijas', 'remansur_pro');
```
Expected: devuelve `false`; la fila `front` de la posición 6 sigue sin cambios (`pedido` sigue `null`).

- [ ] **Paso 5: Prueba de concurrencia real**

Preparar un tercer hueco compartible (`silueta='B', pos=7`, back Remansur, front reservado). Disparar 2 llamadas HTTP `POST` **verdaderamente paralelas** (`Promise.all` o dos peticiones lanzadas sin esperar la primera) contra:
```
POST https://erinkqzsywhuiilirhdc.supabase.co/rest/v1/rpc/compartir_frente_remansur
Content-Profile: staging
Accept-Profile: staging
apikey/Authorization: <service_role key>
body: {"p_silueta":"B","p_pos":7,"p_ped":"TESTC01","p_tienda":"Málaga","p_flujo":"remansur_pro"}
```
y la misma petición con `p_ped:"TESTC02"`. Expected: exactamente una responde `true`, la otra `false`; la fila `front` final tiene el `pedido` de la que ganó (no un resultado mezclado).

- [ ] **Paso 6: Limpiar datos de prueba**

```sql
delete from staging.ocupacion_siluetas where pedido like 'TEST%';
```

---

## Tarea 4: `cerrar_pedido`

Contrato de entrada: `p_posiciones` es el resultado YA CALCULADO de `calcularPosiciones(soportes)` en el cliente (decisión de diseño §4 del spec: esta lógica pura no se traduce a PL/pgSQL). Forma: `[{"back":true,"front":true|false|"reservado"}, ...]`.

- [ ] **Paso 1: Escribir la migración**

`supabase/migrations/2026081304_cerrar_pedido.sql`:

```sql
create or replace function staging.cerrar_pedido(
  p_id_pedido text, p_silueta text, p_pos_ini int,
  p_posiciones jsonb, p_soportes jsonb, p_operario text
) returns jsonb language plpgsql as $$
declare
  v_pedido staging.pedidos%rowtype;
  v_num_pos int := jsonb_array_length(p_posiciones);
  v_pos_fin int;
  v_compartido boolean;
  v_max_pos int;
  v_i int; v_pos int; v_def jsonb;
  v_conflicto boolean;
begin
  select * into v_pedido from staging.pedidos where id = p_id_pedido for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Pedido no encontrado'); end if;

  if v_num_pos = 0 then
    update staging.pedidos set estado='COMPLETADO_LISTO', silueta=p_silueta, pos_ini='0', pos_fin='0',
      soportes=p_soportes, operario=coalesce(p_operario, v_pedido.operario), actualizado=now()
      where id = p_id_pedido;
    return jsonb_build_object('ok', true, 'silueta', p_silueta, 'pos_ini', 0, 'pos_fin', 0);
  end if;

  if v_num_pos = 1 and (p_posiciones->0->>'front') = 'reservado'
     and v_pedido.flujo in ('remansur_transporte','remansur_pro') then
    v_compartido := staging.compartir_frente_remansur(p_silueta, p_pos_ini, v_pedido.ped, v_pedido.tienda, v_pedido.flujo);
    if v_compartido then
      update staging.pedidos set estado='COMPLETADO_LISTO', silueta=p_silueta, pos_ini=p_pos_ini::text, pos_fin=p_pos_ini::text,
        soportes=p_soportes, operario=coalesce(p_operario, v_pedido.operario), actualizado=now()
        where id = p_id_pedido;
      return jsonb_build_object('ok', true, 'silueta', p_silueta, 'pos_ini', p_pos_ini, 'pos_fin', p_pos_ini, 'compartido', true);
    end if;
  end if;

  v_pos_fin := p_pos_ini + v_num_pos - 1;
  v_max_pos := staging._max_pos_silueta(p_silueta);
  if v_max_pos is null then return jsonb_build_object('ok', false, 'error', 'Silueta desconocida'); end if;
  if v_pos_fin > v_max_pos then
    return jsonb_build_object('ok', false, 'error', 'Se sale del rango (máx ' || v_max_pos || ')');
  end if;

  if v_pedido.flujo not in ('remansur_transporte','remansur_pro') then
    select exists (
      select 1 from staging.ocupacion_siluetas
      where silueta = p_silueta and pos::int between p_pos_ini and v_pos_fin
        and (layer = 'back' or reservado = false)
    ) into v_conflicto;
    if v_conflicto then return jsonb_build_object('ok', false, 'error', 'Posición ya ocupada'); end if;
  end if;

  begin
    for v_i in 0 .. v_num_pos - 1 loop
      v_pos := p_pos_ini + v_i;
      v_def := p_posiciones -> v_i;
      insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
        values (p_silueta, v_pos::text, 'back', v_pedido.ped, v_pedido.tienda, v_pedido.flujo, false);
      if (v_def->>'front') = 'true' then
        insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
          values (p_silueta, v_pos::text, 'front', v_pedido.ped, v_pedido.tienda, v_pedido.flujo, false);
      elsif (v_def->>'front') = 'reservado' then
        insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
          values (p_silueta, v_pos::text, 'front', v_pedido.ped, v_pedido.tienda, v_pedido.flujo, true);
      end if;
    end loop;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'Posición ya ocupada (reclamada por otra operación al mismo tiempo)');
  end;

  update staging.pedidos set estado='COMPLETADO_LISTO', silueta=p_silueta, pos_ini=p_pos_ini::text, pos_fin=v_pos_fin::text,
    soportes=p_soportes, operario=coalesce(p_operario, v_pedido.operario), actualizado=now()
    where id = p_id_pedido;

  return jsonb_build_object('ok', true, 'silueta', p_silueta, 'pos_ini', p_pos_ini, 'pos_fin', v_pos_fin);
end $$;
```

- [ ] **Paso 2: Aplicar** (`name: "lote1_cerrar_pedido"`)

- [ ] **Paso 3: Preparar un pedido de prueba**

```sql
insert into staging.pedidos (id, ped, tienda, transportista, flujo, estado, operario, soportes, actualizado) values
  ('TST::CP001', 'CP001', 'Málaga', 'Correcaminos', 'transporte', 'PARCIAL_LISTO', 'test', '[]'::jsonb, now());
```

- [ ] **Paso 4: Prueba funcional — rama bultos**

```sql
select staging.cerrar_pedido('TST::CP001', 'A', 1, '[]'::jsonb, '[{"tipoId":"bulto","tipo":"Bulto","cant":2}]'::jsonb, 'operario1');
select silueta, pos_ini, pos_fin, estado from staging.pedidos where id='TST::CP001';
```
Expected: `{"ok":true,"silueta":"A","pos_ini":0,"pos_fin":0}`; la fila de `pedidos` queda con `pos_ini='0'`, `estado='COMPLETADO_LISTO'`; CERO filas nuevas en `ocupacion_siluetas`.

- [ ] **Paso 5: Prueba funcional — rama normal (un palet entero, back+front)**

```sql
update staging.pedidos set silueta=null, pos_ini=null, pos_fin=null, estado='PARCIAL_LISTO' where id='TST::CP001';
select staging.cerrar_pedido('TST::CP001', 'A', 2, '[{"back":true,"front":true}]'::jsonb, '[{"tipoId":"palet_euro","tipo":"Palet Euro","cant":1}]'::jsonb, 'operario1');
select * from staging.ocupacion_siluetas where silueta='A' and pos='2' order by layer;
```
Expected: `{"ok":true,"silueta":"A","pos_ini":2,"pos_fin":2}`; 2 filas nuevas (`back` y `front`, `reservado=false` ambas).

- [ ] **Paso 6: Prueba funcional — conflicto (posición ya ocupada, flujo NO Remansur)**

```sql
insert into staging.pedidos (id, ped, tienda, flujo, estado, soportes, actualizado) values
  ('TST::CP002', 'CP002', 'Málaga', 'transporte', 'PARCIAL_LISTO', '[]'::jsonb, now());
select staging.cerrar_pedido('TST::CP002', 'A', 2, '[{"back":true,"front":true}]'::jsonb, '[{"tipoId":"palet_euro","cant":1}]'::jsonb, 'operario1');
```
Expected: `{"ok":false,"error":"Posición ya ocupada"}` (posición A2 ya reclamada en el Paso 5).

- [ ] **Paso 7: Prueba funcional — Remansur SE SALTA la validación de conflicto (regla de negocio §3.1 del spec)**

```sql
update staging.pedidos set flujo='remansur_pro' where id='TST::CP002';
select staging.cerrar_pedido('TST::CP002', 'A', 2, '[{"back":true,"front":true}]'::jsonb, '[{"tipoId":"palet_euro","cant":1}]'::jsonb, 'operario1');
```
Expected: `{"ok":true,...}` — a pesar de que A2 ya tenía ocupación de otro pedido, Remansur puede colocarse igualmente (comportamiento DESEADO, no un bug — confirmar visualmente que ahora hay filas de AMBOS pedidos en A2, exactamente como en Sheets).

- [ ] **Paso 8: Prueba funcional — fuera de rango**

```sql
select staging.cerrar_pedido('TST::CP001', 'A', 999, '[{"back":true,"front":true}]'::jsonb, '[]'::jsonb, 'op');
```
Expected: `{"ok":false,"error":"Se sale del rango (máx <N>)"}` con `<N>` = la capacidad real de A sembrada en la Tarea 1.

- [ ] **Paso 9: Prueba de concurrencia real**

Preparar 2 pedidos de prueba nuevos, NO Remansur, con soportes de 1 posición entera cada uno. Disparar 2 `POST .../rpc/cerrar_pedido` paralelos reales apuntando ambos a `silueta='C', pos_ini=1`. Expected: exactamente uno `ok:true`, el otro `{"ok":false,"error":"Posición ya ocupada"}` **o** `{"ok":false,"error":"Posición ya ocupada (reclamada por otra operación al mismo tiempo)"}` (cualquiera de los 2 mensajes es correcto — depende de si la carrera la atrapó el `EXISTS` previo o la constraint física); nunca los dos `ok:true`; `ocupacion_siluetas` para `C|1` tiene exactamente 2 filas (back+front) de UN SOLO pedido, ninguna huérfana.

- [ ] **Paso 10: Limpiar datos de prueba**

```sql
delete from staging.ocupacion_siluetas where pedido like 'CP%' or pedido like 'C1%';
delete from staging.pedidos where id like 'TST::%';
```

---

## Tarea 5: `mover_pedido_de_silueta`

Contrato: `p_posiciones` = `calcularPosiciones(pedido.soportes)` ya calculado en el cliente (los soportes NO cambian al mover, solo la posición — se recalculan las posiciones que ya tenía).

- [ ] **Paso 1: Escribir la migración**

`supabase/migrations/2026081305_mover_pedido_de_silueta.sql`:

```sql
create or replace function staging.mover_pedido_de_silueta(
  p_num_ped text, p_nueva_silueta text, p_nueva_pos_ini int, p_posiciones jsonb, p_tienda text default null
) returns jsonb language plpgsql as $$
declare
  v_pedido staging.pedidos%rowtype;
  v_candidatos int;
  v_silueta_vieja text; v_pos_ini_vieja int; v_pos_fin_vieja int;
  v_num_pos int; v_compartido boolean; v_max_pos int; v_pos_fin_nueva int;
  v_i int; v_pos int; v_def jsonb; v_conflicto boolean;
begin
  if p_tienda is not null then
    select * into v_pedido from staging.pedidos where ped = p_num_ped and tienda = p_tienda and silueta is not null for update;
    if not found then
      select count(*) into v_candidatos from staging.pedidos where ped = p_num_ped and silueta is not null;
      return jsonb_build_object('ok', false, 'error',
        case when v_candidatos > 0 then 'Este pedido no coincide con la tienda esperada — refresca el mapa e inténtalo de nuevo'
        else 'Pedido no encontrado en silueta' end);
    end if;
  else
    select count(*) into v_candidatos from staging.pedidos where ped = p_num_ped and silueta is not null;
    if v_candidatos > 1 then
      return jsonb_build_object('ok', false, 'error', 'Hay varios pedidos con este número en tiendas distintas — ábrelo desde Buscar para identificar la tienda correcta');
    end if;
    select * into v_pedido from staging.pedidos where ped = p_num_ped and silueta is not null for update;
    if not found then return jsonb_build_object('ok', false, 'error', 'Pedido no encontrado en silueta'); end if;
  end if;

  v_silueta_vieja := v_pedido.silueta;
  v_pos_ini_vieja := nullif(v_pedido.pos_ini, '')::int;
  v_pos_fin_vieja := nullif(v_pedido.pos_fin, '')::int;
  v_num_pos := jsonb_array_length(p_posiciones);

  if v_num_pos = 0 then
    update staging.pedidos set silueta = p_nueva_silueta, pos_ini = '0', pos_fin = '0', actualizado = now() where id = v_pedido.id;
    return jsonb_build_object('ok', true, 'silueta', p_nueva_silueta, 'pos_ini', 0, 'pos_fin', 0);
  end if;

  if v_silueta_vieja = p_nueva_silueta and v_pos_ini_vieja = p_nueva_pos_ini then
    return jsonb_build_object('ok', true, 'silueta', p_nueva_silueta, 'pos_ini', p_nueva_pos_ini,
      'pos_fin', p_nueva_pos_ini + v_num_pos - 1, 'sin_cambios', true);
  end if;

  if v_num_pos = 1 and (p_posiciones->0->>'front') = 'reservado' and v_pedido.flujo in ('remansur_transporte','remansur_pro') then
    v_compartido := staging.compartir_frente_remansur(p_nueva_silueta, p_nueva_pos_ini, v_pedido.ped, v_pedido.tienda, v_pedido.flujo);
    if v_compartido then
      if v_pos_ini_vieja is not null then perform staging._liberar_ocupacion(v_silueta_vieja, v_pos_ini_vieja, v_pos_fin_vieja, v_pedido.ped); end if;
      update staging.pedidos set silueta = p_nueva_silueta, pos_ini = p_nueva_pos_ini::text, pos_fin = p_nueva_pos_ini::text, actualizado = now() where id = v_pedido.id;
      return jsonb_build_object('ok', true, 'silueta', p_nueva_silueta, 'pos_ini', p_nueva_pos_ini, 'pos_fin', p_nueva_pos_ini, 'compartido', true);
    end if;
  end if;

  v_pos_fin_nueva := p_nueva_pos_ini + v_num_pos - 1;
  v_max_pos := staging._max_pos_silueta(p_nueva_silueta);
  if v_max_pos is null then return jsonb_build_object('ok', false, 'error', 'Silueta desconocida'); end if;
  if v_pos_fin_nueva > v_max_pos then
    return jsonb_build_object('ok', false, 'error', 'Se sale del rango (máx ' || v_max_pos || ')');
  end if;

  if v_pedido.flujo not in ('remansur_transporte','remansur_pro') then
    select exists (
      select 1 from staging.ocupacion_siluetas
      where silueta = p_nueva_silueta and pos::int between p_nueva_pos_ini and v_pos_fin_nueva
        and (layer = 'back' or reservado = false) and pedido <> v_pedido.ped
    ) into v_conflicto;
    if v_conflicto then
      return jsonb_build_object('ok', false, 'error', 'Posición ' || p_nueva_pos_ini || ' ya ocupada');
    end if;
  end if;

  if v_pos_ini_vieja is not null then perform staging._liberar_ocupacion(v_silueta_vieja, v_pos_ini_vieja, v_pos_fin_vieja, v_pedido.ped); end if;

  begin
    for v_i in 0 .. v_num_pos - 1 loop
      v_pos := p_nueva_pos_ini + v_i;
      v_def := p_posiciones -> v_i;
      insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
        values (p_nueva_silueta, v_pos::text, 'back', v_pedido.ped, v_pedido.tienda, v_pedido.flujo, false);
      if (v_def->>'front') = 'true' then
        insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
          values (p_nueva_silueta, v_pos::text, 'front', v_pedido.ped, v_pedido.tienda, v_pedido.flujo, false);
      elsif (v_def->>'front') = 'reservado' then
        insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
          values (p_nueva_silueta, v_pos::text, 'front', v_pedido.ped, v_pedido.tienda, v_pedido.flujo, true);
      end if;
    end loop;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'Posición ya ocupada (reclamada por otra operación al mismo tiempo) -- el pedido quedó SIN silueta, hay que reintentar');
  end;

  update staging.pedidos set silueta = p_nueva_silueta, pos_ini = p_nueva_pos_ini::text, pos_fin = v_pos_fin_nueva::text, actualizado = now() where id = v_pedido.id;
  return jsonb_build_object('ok', true, 'silueta', p_nueva_silueta, 'pos_ini', p_nueva_pos_ini, 'pos_fin', v_pos_fin_nueva);
end $$;
```

**Nota de comportamiento (documentada a propósito, no es un descuido):** si la constraint física atrapa la carrera (rama `exception`), el pedido queda temporalmente SIN silueta — en Sheets esto no puede pasar porque `LockService` serializa TODO globalmente. Es un caso extremadamente raro (la comprobación `EXISTS` previa ya descarta el 99% de los casos) y no corrompe datos, pero la Pieza 2 debe mostrar el mensaje de error y dejar que el operario reintente, no asumir que el pedido conservó su silueta anterior.

- [ ] **Paso 2: Aplicar** (`name: "lote1_mover_pedido_de_silueta"`)

- [ ] **Paso 3: Prueba funcional — mover un pedido ya en silueta a un hueco libre**

```sql
insert into staging.pedidos (id, ped, tienda, flujo, estado, silueta, pos_ini, pos_fin, soportes, actualizado) values
  ('TST::MV001', 'MV001', 'Málaga', 'transporte', 'COMPLETADO_LISTO', 'D', '1', '1', '[{"tipoId":"palet_euro","cant":1}]'::jsonb, now());
insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado) values
  ('D', '1', 'back', 'MV001', 'Málaga', 'transporte', false),
  ('D', '1', 'front', 'MV001', 'Málaga', 'transporte', false);
select staging.mover_pedido_de_silueta('MV001', 'D', 3, '[{"back":true,"front":true}]'::jsonb, 'Málaga');
select silueta, pos from staging.ocupacion_siluetas where pedido='MV001';
select silueta, pos_ini, pos_fin from staging.pedidos where id='TST::MV001';
```
Expected: `{"ok":true,"silueta":"D","pos_ini":3,"pos_fin":3}`; SOLO quedan filas en `pos='3'` (las de `pos='1'` se liberaron); `pedidos` refleja D3.

- [ ] **Paso 4: Prueba funcional — destino ocupado por OTRO pedido (rechazado)**

```sql
insert into staging.pedidos (id, ped, tienda, flujo, estado, silueta, pos_ini, pos_fin, soportes, actualizado) values
  ('TST::MV002', 'MV002', 'Málaga', 'transporte', 'COMPLETADO_LISTO', 'D', '5', '5', '[{"tipoId":"palet_euro","cant":1}]'::jsonb, now());
insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado) values
  ('D', '5', 'back', 'MV002', 'Málaga', 'transporte', false), ('D', '5', 'front', 'MV002', 'Málaga', 'transporte', false);
select staging.mover_pedido_de_silueta('MV001', 'D', 5, '[{"back":true,"front":true}]'::jsonb, 'Málaga');
```
Expected: `{"ok":false,"error":"Posición 5 ya ocupada"}`; MV001 sigue en D3 (nada se liberó, la validación ocurre ANTES de liberar el origen).

- [ ] **Paso 5: Prueba funcional — mover a un hueco que se solapa con SU PROPIO hueco actual (exclusión de sí mismo)**

```sql
select staging.mover_pedido_de_silueta('MV001', 'D', 3, '[{"back":true,"front":true}]'::jsonb, 'Málaga');
```
Expected: `{"ok":true,...,"sin_cambios":true}` (mismo sitio, atajo). Probar también un solape real distinto, p.ej. mover un pedido de 2 posiciones D3-D4 a D2-D3 — debe funcionar sin "chocar consigo mismo" (verificar que el filtro `pedido <> v_pedido.ped` en el `EXISTS` hace su trabajo).

- [ ] **Paso 6: Prueba de concurrencia real**

Dos pedidos de prueba en huecos distintos, ambos moviéndose SIMULTÁNEAMENTE (llamadas paralelas reales) al MISMO destino libre. Expected: exactamente uno gana.

- [ ] **Paso 7: Limpiar**

```sql
delete from staging.ocupacion_siluetas where pedido like 'MV%';
delete from staging.pedidos where id like 'TST::MV%';
```

---

## Tarea 6: `corregir_soportes_pedido`

- [ ] **Paso 1: Escribir la migración**

`supabase/migrations/2026081306_corregir_soportes_pedido.sql`:

```sql
create or replace function staging.corregir_soportes_pedido(
  p_num_ped text, p_nuevos_soportes jsonb, p_posiciones jsonb,
  p_nueva_silueta text default null, p_nueva_pos_ini int default null, p_tienda text default null
) returns jsonb language plpgsql as $$
declare
  v_pedido staging.pedidos%rowtype;
  v_candidatos int;
  v_silueta_vieja text; v_pos_ini_vieja int; v_pos_fin_vieja int;
  v_tenia_hueco boolean;
  v_num_pos int;
  v_dest_silueta text; v_dest_pos_ini int; v_mismo_sitio boolean;
  v_compartido boolean;
  v_filas_viejas jsonb;
  v_max_pos int; v_pos_fin_nueva int;
  v_i int; v_pos int; v_def jsonb; v_conflicto boolean;
begin
  if p_tienda is not null then
    select * into v_pedido from staging.pedidos where ped = p_num_ped and tienda = p_tienda and silueta is not null for update;
    if not found then
      select count(*) into v_candidatos from staging.pedidos where ped = p_num_ped and silueta is not null;
      return jsonb_build_object('ok', false, 'error',
        case when v_candidatos > 0 then 'Este pedido no coincide con la tienda esperada — refresca e inténtalo de nuevo'
        else 'Pedido no encontrado en silueta' end);
    end if;
  else
    select count(*) into v_candidatos from staging.pedidos where ped = p_num_ped and silueta is not null;
    if v_candidatos > 1 then
      return jsonb_build_object('ok', false, 'error', 'Hay varios pedidos con este número en tiendas distintas — ábrelo desde Buscar para identificar la tienda correcta');
    end if;
    select * into v_pedido from staging.pedidos where ped = p_num_ped and silueta is not null for update;
    if not found then return jsonb_build_object('ok', false, 'error', 'Pedido no encontrado en silueta'); end if;
  end if;

  if v_pedido.silueta in ('Recogidas', 'Ya Cargados') then
    return jsonb_build_object('ok', false, 'error', 'Este pedido está en "' || v_pedido.silueta || '" (silueta ficticia, sin posiciones reales) — no hay soportes que corregir');
  end if;

  v_silueta_vieja := v_pedido.silueta;
  v_pos_ini_vieja := nullif(v_pedido.pos_ini, '')::int;
  v_pos_fin_vieja := nullif(v_pedido.pos_fin, '')::int;
  v_tenia_hueco := v_pos_ini_vieja is not null and v_pos_ini_vieja <> 0;
  v_num_pos := jsonb_array_length(p_posiciones);
  v_dest_silueta := coalesce(p_nueva_silueta, v_silueta_vieja);
  v_dest_pos_ini := coalesce(p_nueva_pos_ini, v_pos_ini_vieja, 0);
  v_mismo_sitio := v_tenia_hueco and v_dest_silueta = v_silueta_vieja and v_dest_pos_ini = v_pos_ini_vieja;

  if v_num_pos = 0 then
    if v_tenia_hueco then perform staging._liberar_ocupacion(v_silueta_vieja, v_pos_ini_vieja, v_pos_fin_vieja, v_pedido.ped); end if;
    update staging.pedidos set soportes = p_nuevos_soportes, silueta = v_dest_silueta, pos_ini = '0', pos_fin = '0', actualizado = now() where id = v_pedido.id;
    return jsonb_build_object('ok', true, 'silueta', v_dest_silueta, 'pos_ini', 0, 'pos_fin', 0);
  end if;

  -- REMANSUR compartir delante -- SOLO si el destino NO es el mismo sitio que el pedido
  -- ya ocupa (si no, compartiría consigo mismo -- bug real ya corregido en el original, ver spec §3).
  if not v_mismo_sitio and v_num_pos = 1 and (p_posiciones->0->>'front') = 'reservado'
     and v_pedido.flujo in ('remansur_transporte','remansur_pro') then
    v_compartido := staging.compartir_frente_remansur(v_dest_silueta, v_dest_pos_ini, v_pedido.ped, v_pedido.tienda, v_pedido.flujo);
    if v_compartido then
      if v_tenia_hueco then perform staging._liberar_ocupacion(v_silueta_vieja, v_pos_ini_vieja, v_pos_fin_vieja, v_pedido.ped); end if;
      update staging.pedidos set soportes = p_nuevos_soportes, silueta = v_dest_silueta, pos_ini = v_dest_pos_ini::text, pos_fin = v_dest_pos_ini::text, actualizado = now() where id = v_pedido.id;
      return jsonb_build_object('ok', true, 'silueta', v_dest_silueta, 'pos_ini', v_dest_pos_ini, 'pos_fin', v_dest_pos_ini, 'compartido', true);
    end if;
  end if;

  -- Capturar filas REALES (no reconstrucción teórica) para poder deshacer si el destino no cabe
  v_filas_viejas := '[]'::jsonb;
  if v_tenia_hueco then
    select coalesce(jsonb_agg(jsonb_build_object(
        'silueta', silueta, 'pos', pos, 'layer', layer, 'pedido', pedido,
        'tienda', tienda, 'flujo', flujo, 'reservado', reservado
      )), '[]'::jsonb)
      into v_filas_viejas
      from staging.ocupacion_siluetas
      where silueta = v_silueta_vieja and pos::int between v_pos_ini_vieja and v_pos_fin_vieja and pedido = v_pedido.ped;
    perform staging._liberar_ocupacion(v_silueta_vieja, v_pos_ini_vieja, v_pos_fin_vieja, v_pedido.ped);
  end if;

  v_pos_fin_nueva := v_dest_pos_ini + v_num_pos - 1;
  v_max_pos := staging._max_pos_silueta(v_dest_silueta);
  v_conflicto := (v_max_pos is null) or (v_pos_fin_nueva > v_max_pos);
  if not v_conflicto and v_pedido.flujo not in ('remansur_transporte','remansur_pro') then
    select exists (
      select 1 from staging.ocupacion_siluetas
      where silueta = v_dest_silueta and pos::int between v_dest_pos_ini and v_pos_fin_nueva
        and (layer = 'back' or reservado = false)
    ) into v_conflicto;
  end if;

  if v_conflicto then
    if jsonb_array_length(v_filas_viejas) > 0 then
      insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
        select x->>'silueta', x->>'pos', x->>'layer', x->>'pedido', x->>'tienda', x->>'flujo', (x->>'reservado')::boolean
        from jsonb_array_elements(v_filas_viejas) x
        on conflict (silueta, pos, layer) do nothing;
    end if;
    return jsonb_build_object('ok', false, 'error', 'Posición ' || v_dest_pos_ini || ' ya ocupada');
  end if;

  begin
    for v_i in 0 .. v_num_pos - 1 loop
      v_pos := v_dest_pos_ini + v_i;
      v_def := p_posiciones -> v_i;
      insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
        values (v_dest_silueta, v_pos::text, 'back', v_pedido.ped, v_pedido.tienda, v_pedido.flujo, false);
      if (v_def->>'front') = 'true' then
        insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
          values (v_dest_silueta, v_pos::text, 'front', v_pedido.ped, v_pedido.tienda, v_pedido.flujo, false);
      elsif (v_def->>'front') = 'reservado' then
        insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
          values (v_dest_silueta, v_pos::text, 'front', v_pedido.ped, v_pedido.tienda, v_pedido.flujo, true);
      end if;
    end loop;
  exception when unique_violation then
    if jsonb_array_length(v_filas_viejas) > 0 then
      insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
        select x->>'silueta', x->>'pos', x->>'layer', x->>'pedido', x->>'tienda', x->>'flujo', (x->>'reservado')::boolean
        from jsonb_array_elements(v_filas_viejas) x
        on conflict (silueta, pos, layer) do nothing;
    end if;
    return jsonb_build_object('ok', false, 'error', 'Posición ya ocupada (reclamada por otra operación al mismo tiempo)');
  end;

  update staging.pedidos set soportes = p_nuevos_soportes, silueta = v_dest_silueta, pos_ini = v_dest_pos_ini::text, pos_fin = v_pos_fin_nueva::text, actualizado = now() where id = v_pedido.id;
  return jsonb_build_object('ok', true, 'silueta', v_dest_silueta, 'pos_ini', v_dest_pos_ini, 'pos_fin', v_pos_fin_nueva);
end $$;
```

- [ ] **Paso 2: Aplicar** (`name: "lote1_corregir_soportes_pedido"`)

- [ ] **Paso 3: Prueba funcional — corrección que SÍ cabe en el mismo sitio**

```sql
insert into staging.pedidos (id, ped, tienda, flujo, estado, silueta, pos_ini, pos_fin, soportes, actualizado) values
  ('TST::CS001', 'CS001', 'Málaga', 'transporte', 'COMPLETADO_LISTO', 'E', '1', '1', '[{"tipoId":"jaula","cant":1}]'::jsonb, now());
insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado) values
  ('E', '1', 'back', 'CS001', 'Málaga', 'transporte', false), ('E', '1', 'front', 'CS001', 'Málaga', 'transporte', false);
select staging.corregir_soportes_pedido('CS001', '[{"tipoId":"palet_euro","cant":1}]'::jsonb, '[{"back":true,"front":true}]'::jsonb, null, null, 'Málaga');
```
Expected: `ok:true`, mismo sitio E1, `pedidos.soportes` actualizado al nuevo valor.

- [ ] **Paso 4: Prueba funcional — ROLLBACK cuando el destino no cabe**

```sql
insert into staging.pedidos (id, ped, tienda, flujo, estado, silueta, pos_ini, pos_fin, soportes, actualizado) values
  ('TST::CS002', 'CS002', 'Málaga', 'transporte', 'COMPLETADO_LISTO', 'E', '10', '10', '[{"tipoId":"jaula","cant":1}]'::jsonb, now());
insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado) values
  ('E', '10', 'back', 'CS002', 'Málaga', 'transporte', false), ('E', '10', 'front', 'CS002', 'Málaga', 'transporte', false),
  ('E', '11', 'back', 'OTRO01', 'Málaga', 'transporte', false), ('E', '11', 'front', 'OTRO01', 'Málaga', 'transporte', false);
select staging.corregir_soportes_pedido('CS002', '[{"tipoId":"palet_euro","cant":2}]'::jsonb, '[{"back":true,"front":true},{"back":true,"front":true}]'::jsonb, 'E', 10, 'Málaga');
select * from staging.ocupacion_siluetas where pedido = 'CS002';
```
Expected: `{"ok":false,"error":"Posición 10 ya ocupada"}` (2 posiciones nuevas chocan con OTRO01 en E11); **la consulta final debe seguir mostrando las 2 filas ORIGINALES de CS002 en E10** (el rollback restauró exactamente lo que había) — este es el caso más importante de esta función, no darlo por bueno sin comprobar la consulta.

- [ ] **Paso 5: Limpiar**

```sql
delete from staging.ocupacion_siluetas where pedido in ('CS001','CS002','OTRO01');
delete from staging.pedidos where id like 'TST::CS%';
```

---

## Tarea 7: `liberar_pedido_de_silueta`

- [ ] **Paso 1: Escribir la migración**

`supabase/migrations/2026081307_liberar_pedido_de_silueta.sql`:

```sql
create or replace function staging.liberar_pedido_de_silueta(
  p_num_ped text, p_disposicion text, p_motivo text default null, p_tienda text default null
) returns jsonb language plpgsql as $$
declare
  v_pedido staging.pedidos%rowtype;
  v_candidatos int;
  v_estado_nuevo text;
  v_pos_ini int; v_pos_fin int;
begin
  if p_tienda is not null then
    select * into v_pedido from staging.pedidos where ped = p_num_ped and tienda = p_tienda and silueta is not null for update;
    if not found then
      select count(*) into v_candidatos from staging.pedidos where ped = p_num_ped and silueta is not null;
      return jsonb_build_object('ok', false, 'error',
        case when v_candidatos > 0 then 'Este pedido no coincide con la tienda esperada — refresca el mapa e inténtalo de nuevo'
        else 'Pedido no encontrado en silueta' end);
    end if;
  else
    select count(*) into v_candidatos from staging.pedidos where ped = p_num_ped and silueta is not null;
    if v_candidatos > 1 then
      return jsonb_build_object('ok', false, 'error', 'Hay varios pedidos con este número en tiendas distintas — ábrelo desde 🔍 Buscar para identificar la tienda correcta');
    end if;
    select * into v_pedido from staging.pedidos where ped = p_num_ped and silueta is not null for update;
    if not found then return jsonb_build_object('ok', false, 'error', 'Pedido no encontrado en silueta'); end if;
  end if;

  v_pos_ini := nullif(v_pedido.pos_ini, '')::int;
  v_pos_fin := nullif(v_pedido.pos_fin, '')::int;
  if v_pos_ini is not null then
    perform staging._liberar_ocupacion(v_pedido.silueta, v_pos_ini, v_pos_fin, v_pedido.ped);
  end if;

  v_estado_nuevo := case p_disposicion
    when 'almacen' then 'DEVUELTO_ALMACEN'
    when 'tienda' then 'ENVIADO_TIENDA'
    when 'desmarcar' then 'COMPLETADO_LISTO'
    else 'SALIDA_MANUAL'
  end;

  -- Quita el pedido de su carga activa si tenía (mismo criterio que
  -- _quitarPedidoDeSuCargaActiva: solo si la carga sigue GENERADA -- si ya
  -- está CERRADA, su membresía se conserva como registro histórico).
  delete from staging.cargas_pedidos
    where pedido_id = v_pedido.id
      and carga_id in (select id from staging.cargas where estado = 'GENERADA');

  update staging.pedidos set estado = v_estado_nuevo, silueta = null, pos_ini = null, pos_fin = null, numero_carga = null, actualizado = now()
    where id = v_pedido.id;

  return jsonb_build_object('ok', true, 'silueta', v_pedido.silueta, 'estado', v_estado_nuevo);
end $$;
```

**Nota de alcance:** esta función NO reemplaza a `quitar_pedido_de_carga` (Lote 2) — solo replica el efecto secundario mínimo que el `liberarPedidoDeSilueta` original ya provocaba (borrar el vínculo de una carga activa). Cuando se construya el Lote 2, `quitar_pedido_de_carga` puede reutilizar exactamente el mismo `DELETE` si conviene extraerlo a un helper compartido — no se hace ahora por YAGNI (una sola línea, duplicarla no cuesta nada; abstraerla antes de tener el segundo caso real sí sería prematuro).

- [ ] **Paso 2: Aplicar** (`name: "lote1_liberar_pedido_de_silueta"`)

- [ ] **Paso 3: Prueba funcional — liberar con disposición "almacén", sin carga activa**

```sql
insert into staging.pedidos (id, ped, tienda, flujo, estado, silueta, pos_ini, pos_fin, soportes, actualizado) values
  ('TST::LB001', 'LB001', 'Málaga', 'transporte', 'COMPLETADO_LISTO', 'F', '1', '1', '[{"tipoId":"palet_euro","cant":1}]'::jsonb, now());
insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado) values
  ('F', '1', 'back', 'LB001', 'Málaga', 'transporte', false), ('F', '1', 'front', 'LB001', 'Málaga', 'transporte', false);
select staging.liberar_pedido_de_silueta('LB001', 'almacen', 'prueba', 'Málaga');
select estado, silueta, pos_ini from staging.pedidos where id='TST::LB001';
select count(*) from staging.ocupacion_siluetas where pedido='LB001';
```
Expected: `{"ok":true,"silueta":"F","estado":"DEVUELTO_ALMACEN"}`; `pedidos.silueta` es `NULL`; 0 filas en `ocupacion_siluetas`.

- [ ] **Paso 4: Prueba funcional — con carga activa (verifica el `DELETE` de `cargas_pedidos`)**

```sql
insert into staging.cargas (id, num_carga, fecha, estado) values ('TST::CARGA01', '99999', current_date, 'GENERADA');
insert into staging.pedidos (id, ped, tienda, flujo, estado, silueta, pos_ini, pos_fin, numero_carga, soportes, actualizado) values
  ('TST::LB002', 'LB002', 'Málaga', 'transporte', 'COMPLETADO_LISTO', 'F', '2', '2', '99999', '[{"tipoId":"palet_euro","cant":1}]'::jsonb, now());
insert into staging.cargas_pedidos (carga_id, pedido_id) values ('TST::CARGA01', 'TST::LB002');
select staging.liberar_pedido_de_silueta('LB002', 'desmarcar', null, 'Málaga');
select count(*) from staging.cargas_pedidos where pedido_id='TST::LB002';
select numero_carga from staging.pedidos where id='TST::LB002';
```
Expected: `count(*)=0` en `cargas_pedidos`; `numero_carga` es `NULL`.

- [ ] **Paso 5: Limpiar**

```sql
delete from staging.cargas_pedidos where carga_id='TST::CARGA01';
delete from staging.cargas where id='TST::CARGA01';
delete from staging.ocupacion_siluetas where pedido like 'LB%';
delete from staging.pedidos where id like 'TST::LB%';
```

---

## Tarea 8: `aplicar_compactar_siluetas`

Contrato de entrada, un array de movimientos (calculados en el cliente por `previsualizarCompactarSiluetas`, que NO se toca en este plan — sigue en Apps Script): cada elemento debe incluir un campo nuevo `posiciones` (el resultado de `calcularPosiciones` para ESE pedido) que el original no llevaba — se añade en la Pieza 2, no aquí; para las pruebas de este plan se construye a mano.

```json
{"ped":"...", "tienda":"...", "transportista":"...", "flujo":"...",
 "siluetaVieja":"...", "posIniVieja":N, "posFinVieja":N,
 "siluetaNueva":"...", "posIniNueva":N, "posFinNueva":N,
 "posiciones":[...]}
```

**Nota de comportamiento preservada del original (no es un descuido nuevo):** igual que `_aplicarCompactarSiluetasInterno`, el reemparejamiento pedido↔fila se hace por `ped` (número de negocio), sin desambiguar por `tienda` — si dos pedidos activos comparten número en tiendas distintas Y ambos están siendo compactados a la vez, cuál de los dos "gana" el emparejamiento no está definido. Es una limitación preexistente del propio diseño Sheets (`previsualizarCompactarSiluetas` no la resuelve tampoco), no algo que este Lote 1 deba arreglar por su cuenta.

**Nota de robustez:** a diferencia de las otras 4 funciones, esta NO envuelve el bucle de inserción final en un manejador de `unique_violation` — si una colisión física genuina se cuela a pesar de la revalidación en memoria (Fase B de abajo), toda la llamada aborta y NINGÚN movimiento del lote se aplica (transacción única). Dado el historial real de bugs de esta función (v182) y que es una acción de admin supervisada (no un camino caliente), preferir un aborto completo y claro (el admin repite previsualizar+aplicar) antes que una recuperación parcial más compleja de razonar.

- [ ] **Paso 1: Escribir la migración**

`supabase/migrations/2026081308_aplicar_compactar_siluetas.sql`:

```sql
create or replace function staging.aplicar_compactar_siluetas(p_movimientos jsonb) returns jsonb language plpgsql as $$
declare
  v_omitidos text[] := '{}';
  v_aplicados jsonb := '[]'::jsonb;
  v_mov jsonb;
  v_ped record;
  v_origen_real boolean;
  v_idx int := 0;
begin
  if p_movimientos is null or jsonb_array_length(p_movimientos) = 0 then
    return jsonb_build_object('ok', true, 'aplicados', 0, 'movimientos', '[]'::jsonb, 'omitidos', '[]'::jsonb);
  end if;

  create temporary table _cs_validos (
    idx int, ped text, tienda text, flujo text,
    silueta_vieja text, pos_ini_vieja int, pos_fin_vieja int,
    silueta_nueva text, pos_ini_nueva int, pos_fin_nueva int,
    posiciones jsonb, pedido_id text
  ) on commit drop;

  -- Fase A: validar el ORIGEN de cada movimiento contra el estado real actual
  for v_mov in select * from jsonb_array_elements(p_movimientos)
  loop
    select id, silueta, nullif(pos_ini,'')::int as pos_ini into v_ped from staging.pedidos where ped = (v_mov->>'ped');
    if not found then
      v_omitidos := array_append(v_omitidos, (v_mov->>'ped') || ' (el pedido ya no existe)');
      continue;
    end if;
    if v_ped.silueta is distinct from (v_mov->>'siluetaVieja')
       or coalesce(v_ped.pos_ini, -1) is distinct from (v_mov->>'posIniVieja')::int then
      v_omitidos := array_append(v_omitidos, (v_mov->>'ped') || ' (cambió de posición mientras tanto)');
      continue;
    end if;
    if (v_mov->>'posIniVieja')::int > 0 then
      select exists (
        select 1 from staging.ocupacion_siluetas
        where silueta = (v_mov->>'siluetaVieja') and pedido = (v_mov->>'ped')
          and pos::int between (v_mov->>'posIniVieja')::int and (v_mov->>'posFinVieja')::int
      ) into v_origen_real;
      if not v_origen_real then
        v_omitidos := array_append(v_omitidos, (v_mov->>'ped') || ' (PEDIDOS decía ' || (v_mov->>'siluetaVieja') ||
          (v_mov->>'posIniVieja') || ' pero el mapa físico no tiene ninguna fila ahí -- no se mueve, para no duplicarlo; revisar a mano)');
        continue;
      end if;
    end if;
    insert into _cs_validos values (
      v_idx, v_mov->>'ped', v_mov->>'tienda', v_mov->>'flujo',
      v_mov->>'siluetaVieja', (v_mov->>'posIniVieja')::int, (v_mov->>'posFinVieja')::int,
      v_mov->>'siluetaNueva', (v_mov->>'posIniNueva')::int, (v_mov->>'posFinNueva')::int,
      coalesce(v_mov->'posiciones', '[]'::jsonb), v_ped.id
    );
    v_idx := v_idx + 1;
  end loop;

  -- Fase B: mapa virtual de ocupación EN VIVO, liberando los orígenes de TODOS los válidos de golpe
  create temporary table _cs_ocupado (silueta text, pos int, primary key (silueta, pos)) on commit drop;
  insert into _cs_ocupado select silueta, pos::int from staging.ocupacion_siluetas on conflict do nothing;
  delete from _cs_ocupado o using _cs_validos v
    where v.pos_ini_vieja > 0 and o.silueta = v.silueta_vieja and o.pos between v.pos_ini_vieja and v.pos_fin_vieja;

  create temporary table _cs_aplicar (
    ped text, pedido_id text, tienda text, silueta_vieja text, pos_ini_vieja int, pos_fin_vieja int,
    silueta_nueva text, pos_ini_nueva int, pos_fin_nueva int, posiciones jsonb, flujo text
  ) on commit drop;

  for v_ped in select * from _cs_validos order by idx
  loop
    if v_ped.pos_ini_nueva = 0 then
      insert into _cs_aplicar values (v_ped.ped, v_ped.pedido_id, v_ped.tienda, v_ped.silueta_vieja, v_ped.pos_ini_vieja, v_ped.pos_fin_vieja,
        v_ped.silueta_nueva, 0, 0, '[]'::jsonb, v_ped.flujo);
      continue;
    end if;
    if exists (
      select 1 from generate_series(v_ped.pos_ini_nueva, v_ped.pos_fin_nueva) p
      where exists (select 1 from _cs_ocupado o where o.silueta = v_ped.silueta_nueva and o.pos = p)
    ) then
      v_omitidos := array_append(v_omitidos, v_ped.ped || ' (el destino ' || v_ped.silueta_nueva || v_ped.pos_ini_nueva || ' ya no estaba libre)');
      continue;
    end if;
    insert into _cs_ocupado select v_ped.silueta_nueva, p from generate_series(v_ped.pos_ini_nueva, v_ped.pos_fin_nueva) p on conflict do nothing;
    insert into _cs_aplicar values (v_ped.ped, v_ped.pedido_id, v_ped.tienda, v_ped.silueta_vieja, v_ped.pos_ini_vieja, v_ped.pos_fin_vieja,
      v_ped.silueta_nueva, v_ped.pos_ini_nueva, v_ped.pos_fin_nueva, v_ped.posiciones, v_ped.flujo);
  end loop;

  -- Fase C: aplicar de verdad -- primero liberar TODO lo viejo, luego crear TODO lo nuevo
  for v_ped in select * from _cs_aplicar where pos_ini_vieja > 0
  loop
    perform staging._liberar_ocupacion(v_ped.silueta_vieja, v_ped.pos_ini_vieja, v_ped.pos_fin_vieja, v_ped.ped);
  end loop;

  for v_ped in select * from _cs_aplicar
  loop
    if v_ped.pos_ini_nueva > 0 then
      declare
        v_i int; v_pos int; v_def jsonb; v_num_pos int := jsonb_array_length(v_ped.posiciones);
      begin
        for v_i in 0 .. v_num_pos - 1 loop
          v_pos := v_ped.pos_ini_nueva + v_i;
          v_def := v_ped.posiciones -> v_i;
          insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
            values (v_ped.silueta_nueva, v_pos::text, 'back', v_ped.ped, v_ped.tienda, v_ped.flujo, false);
          if (v_def->>'front') = 'true' then
            insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
              values (v_ped.silueta_nueva, v_pos::text, 'front', v_ped.ped, v_ped.tienda, v_ped.flujo, false);
          elsif (v_def->>'front') = 'reservado' then
            insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado)
              values (v_ped.silueta_nueva, v_pos::text, 'front', v_ped.ped, v_ped.tienda, v_ped.flujo, true);
          end if;
        end loop;
      end;
    end if;
    update staging.pedidos set silueta = v_ped.silueta_nueva, pos_ini = v_ped.pos_ini_nueva::text, pos_fin = v_ped.pos_fin_nueva::text, actualizado = now()
      where id = v_ped.pedido_id;
    v_aplicados := v_aplicados || jsonb_build_object('ped', v_ped.ped, 'siluetaNueva', v_ped.silueta_nueva, 'posIniNueva', v_ped.pos_ini_nueva, 'posFinNueva', v_ped.pos_fin_nueva);
  end loop;

  return jsonb_build_object('ok', true, 'aplicados', jsonb_array_length(v_aplicados), 'movimientos', v_aplicados, 'omitidos', to_jsonb(v_omitidos));
end $$;
```

- [ ] **Paso 2: Aplicar** (`name: "lote1_aplicar_compactar_siluetas"`)

- [ ] **Paso 3: Prueba funcional — compactar 2 pedidos hacia huecos libres anteriores**

```sql
insert into staging.pedidos (id, ped, tienda, flujo, estado, silueta, pos_ini, pos_fin, soportes, actualizado) values
  ('TST::CP101', 'CP101', 'Málaga', 'transporte', 'COMPLETADO_LISTO', 'A', '5', '5', '[{"tipoId":"palet_euro","cant":1}]'::jsonb, now()),
  ('TST::CP102', 'CP102', 'Málaga', 'transporte', 'COMPLETADO_LISTO', 'A', '6', '6', '[{"tipoId":"palet_euro","cant":1}]'::jsonb, now());
insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado) values
  ('A', '5', 'back', 'CP101', 'Málaga', 'transporte', false), ('A', '5', 'front', 'CP101', 'Málaga', 'transporte', false),
  ('A', '6', 'back', 'CP102', 'Málaga', 'transporte', false), ('A', '6', 'front', 'CP102', 'Málaga', 'transporte', false);

select staging.aplicar_compactar_siluetas('[
  {"ped":"CP101","tienda":"Málaga","flujo":"transporte","siluetaVieja":"A","posIniVieja":5,"posFinVieja":5,"siluetaNueva":"A","posIniNueva":1,"posFinNueva":1,"posiciones":[{"back":true,"front":true}]},
  {"ped":"CP102","tienda":"Málaga","flujo":"transporte","siluetaVieja":"A","posIniVieja":6,"posFinVieja":6,"siluetaNueva":"A","posIniNueva":2,"posFinNueva":2,"posiciones":[{"back":true,"front":true}]}
]'::jsonb);
select silueta, pos_ini from staging.pedidos where id in ('TST::CP101','TST::CP102') order by ped;
select silueta, pos from staging.ocupacion_siluetas where pedido in ('CP101','CP102') order by pedido, pos;
```
Expected: `{"ok":true,"aplicados":2,"omitidos":[]}`; CP101→A1, CP102→A2; ninguna fila residual en A5/A6.

- [ ] **Paso 4: Prueba funcional — un movimiento con origen desincronizado se OMITE (no se aplica a ciegas)**

```sql
insert into staging.pedidos (id, ped, tienda, flujo, estado, silueta, pos_ini, pos_fin, soportes, actualizado) values
  ('TST::CP103', 'CP103', 'Málaga', 'transporte', 'COMPLETADO_LISTO', 'A', '9', '9', '[{"tipoId":"palet_euro","cant":1}]'::jsonb, now());
-- OJO: a propósito NO se inserta ninguna fila en ocupacion_siluetas para CP103 en A9 -- simula el drift real que ya causó el bug v182.
select staging.aplicar_compactar_siluetas('[
  {"ped":"CP103","tienda":"Málaga","flujo":"transporte","siluetaVieja":"A","posIniVieja":9,"posFinVieja":9,"siluetaNueva":"A","posIniNueva":3,"posFinNueva":3,"posiciones":[{"back":true,"front":true}]}
]'::jsonb);
```
Expected: `{"ok":true,"aplicados":0,"omitidos":["CP103 (PEDIDOS decía A9 pero el mapa físico no tiene ninguna fila ahí -- no se mueve, para no duplicarlo; revisar a mano)"]}`; `pedidos.silueta` de CP103 SIGUE en A9 (no se tocó).

- [ ] **Paso 5: Limpiar**

```sql
delete from staging.ocupacion_siluetas where pedido like 'CP1%';
delete from staging.pedidos where id like 'TST::CP1%';
```

---

## Tarea 9: `liberarPosicionesLote` — verificar el reemplazo sin RPC

No requiere función nueva (§5.5 del spec) — la Pieza 2 hará N `DELETE` directos. Verificarlo ahora contra `staging` deja cerrado el Lote 1 al completo, no solo las 6 funciones RPC.

- [ ] **Paso 1: Probar el patrón de `DELETE` directo**

```sql
insert into staging.ocupacion_siluetas (silueta, pos, layer, pedido, tienda, flujo, reservado) values
  ('B', '1', 'back', 'LP001', 'Málaga', 'transporte', false), ('B', '1', 'front', 'LP001', 'Málaga', 'transporte', false),
  ('B', '2', 'back', 'LP001', 'Málaga', 'transporte', false);
delete from staging.ocupacion_siluetas where silueta = 'B' and pedido = 'LP001' and pos::int between 1 and 2;
select count(*) from staging.ocupacion_siluetas where pedido = 'LP001';
```
Expected: `count(*) = 0`. Confirma que la Pieza 2 puede reemplazar `liberarPosicionesLote` con N llamadas `DELETE .../ocupacion_siluetas?silueta=eq.X&pedido=eq.Y&pos=in.(1,2)` (usar `pos=in.(...)` con la lista exacta, NO `pos=gte...&pos=lte...` — mismo gotcha de texto ya documentado).

---

## Tarea 10: Grants

- [ ] **Paso 1: Escribir y aplicar la migración de permisos**

`supabase/migrations/2026081309_grants_lote1.sql`:

```sql
grant execute on function staging._max_pos_silueta(text) to service_role;
grant execute on function staging._liberar_ocupacion(text, int, int, text) to service_role;
grant execute on function staging.compartir_frente_remansur(text, int, text, text, text) to service_role;
grant execute on function staging.cerrar_pedido(text, text, int, jsonb, jsonb, text) to service_role;
grant execute on function staging.mover_pedido_de_silueta(text, text, int, jsonb, text) to service_role;
grant execute on function staging.corregir_soportes_pedido(text, jsonb, jsonb, text, int, text) to service_role;
grant execute on function staging.liberar_pedido_de_silueta(text, text, text, text) to service_role;
grant execute on function staging.aplicar_compactar_siluetas(jsonb) to service_role;
```

Aplicar con `apply_migration` (`name: "lote1_grants"`).

- [ ] **Paso 2: Verificar con una llamada HTTP real (no `execute_sql`, que ya tiene privilegios de superusuario y no prueba nada del grant)**

```
POST https://erinkqzsywhuiilirhdc.supabase.co/rest/v1/rpc/cerrar_pedido
Content-Profile: staging
apikey / Authorization: Bearer <SUPABASE_SERVICE_KEY del proyecto>
body: {"p_id_pedido":"no-existe","p_silueta":"A","p_pos_ini":1,"p_posiciones":[],"p_soportes":[],"p_operario":"test"}
```
Expected: HTTP 200 con `{"ok":false,"error":"Pedido no encontrado"}` (NO un 401/403 de permisos, NO un error "function does not exist").

---

## Tarea 11: Limpieza final y checkpoint de cierre del Lote 1

- [ ] **Paso 1: Confirmar que no queda ningún dato de prueba en `staging`**

```sql
select count(*) from staging.pedidos where id like 'TST::%';
select count(*) from staging.ocupacion_siluetas where pedido like 'TEST%' or pedido like 'CP%' or pedido like 'MV%' or pedido like 'CS%' or pedido like 'LB%' or pedido like 'LP%';
select count(*) from staging.cargas where id like 'TST::%';
```
Expected: los 3 devuelven `0`.

- [ ] **Paso 2: Resumen para el usuario**

Confirmar por escrito: las 6 funciones RPC + 2 helpers están aplicadas y probadas (funcional + concurrencia real donde aplica) contra `staging`; `liberarPosicionesLote` verificado sin necesitar RPC; grants confirmados con una llamada HTTP real, no solo `execute_sql`. **Nada de esto está en `public` (producción) todavía** — eso requiere una confirmación explícita aparte del usuario, igual que en Fase 2.

- [ ] **Paso 3 (solo si el usuario confirma explícitamente aplicar a producción):**

Repetir las migraciones de las Tareas 2-4, 5-8 y 10 sustituyendo `staging.` por `public.` en cada `create or replace function` y en cada referencia interna (`staging.pedidos` → `public.pedidos`, etc.) — **no reutilizar los mismos archivos `.sql`, crear versiones `_public` nuevas** para mantener el historial de qué se aplicó dónde. Ejecutar `config_siluetas` (Tarea 1) también contra `public` primero (hoy vacía en producción igual que en staging antes de este plan). No ejecutar este paso sin preguntar primero — coherente con el resto de esta migración.
