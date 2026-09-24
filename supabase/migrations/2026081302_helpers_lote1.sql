create or replace function staging._max_pos_silueta(p_silueta text) returns int
language sql stable as $$
  select posiciones from staging.config_siluetas where silueta = p_silueta
$$;

create or replace function staging._liberar_ocupacion(p_silueta text, p_pos_ini int, p_pos_fin int, p_pedido text)
returns void language sql as $$
  delete from staging.ocupacion_siluetas
  where silueta = p_silueta and pos::int between p_pos_ini and p_pos_fin and pedido = p_pedido;
$$;
