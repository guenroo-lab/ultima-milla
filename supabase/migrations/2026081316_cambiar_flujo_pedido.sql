create or replace function staging.cambiar_flujo_pedido(p_num_ped text, p_nuevo_flujo text)
returns jsonb language plpgsql as $$
declare
  v_pedido staging.pedidos%rowtype;
  v_flujo_anterior text;
  v_transportista text;
  v_ahora timestamptz := now();
begin
  v_transportista := case p_nuevo_flujo
    when 'transporte' then 'Correcaminos'
    when 'instalacion' then 'Correcaminos Instalaciones'
    when 'pro' then 'Correcaminos PRO'
    when 'remansur_transporte' then 'Remansur'
    when 'remansur_pro' then 'Remansur PRO'
    when 'grua_remansur' then 'GruaRemansur'
    else null
  end;
  if v_transportista is null then
    return jsonb_build_object('ok', false, 'error', 'Tipo de transporte no válido');
  end if;

  select * into v_pedido from staging.pedidos where ped = p_num_ped order by id limit 1 for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Pedido no encontrado');
  end if;

  v_flujo_anterior := v_pedido.flujo;

  update staging.pedidos set flujo = p_nuevo_flujo, transportista = v_transportista, actualizado = v_ahora
    where id = v_pedido.id;

  if v_flujo_anterior is distinct from p_nuevo_flujo then
    begin
      insert into staging.historial_transportista (id, id_pedido, ped, tienda, transportista, flujo, evento, fecha)
        values (v_pedido.id || '::' || (extract(epoch from v_ahora) * 1000)::bigint::text,
          v_pedido.id, v_pedido.ped, v_pedido.tienda, v_transportista, p_nuevo_flujo, 'CAMBIO_MANUAL', v_ahora);
    exception when others then
      null;
    end;
  end if;

  if v_pedido.silueta is not null then
    update staging.ocupacion_siluetas set flujo = p_nuevo_flujo
      where silueta = v_pedido.silueta and tienda = v_pedido.tienda and pedido = v_pedido.ped;
  end if;

  return jsonb_build_object('ok', true, 'flujo', p_nuevo_flujo, 'transportista', v_transportista);
end $$;

grant execute on function staging.cambiar_flujo_pedido(text, text) to service_role;
