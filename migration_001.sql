-- Для УЖЕ работающей базы: Supabase -> SQL Editor -> вставить целиком -> Run. Можно запускать повторно.
-- Скрипт выполняется целиком или не выполняется совсем: если где-то будет ошибка, база останется как была.
-- Свежая установка берёт всё из schema.sql, этот файл ей не нужен.
-- ВАЖНО: сначала запустите этот файл, и только потом выкладывайте новую версию сайта.

-- старые варианты функций (у которых изменились параметры или результат)
drop function if exists public.place_order(jsonb, boolean);
drop function if exists public.admin_create_order(text, uuid, uuid, jsonb);
drop function if exists public.admin_create_order(text, uuid, uuid, jsonb, date);
drop function if exists public.update_order(uuid, jsonb, text);
drop function if exists public.dept_orders();
drop function if exists public.admin_clients();
drop function if exists public.admin_update_client(uuid, text, text, uuid, uuid, int, boolean, text);
drop function if exists public.set_admin(uuid, boolean);

-- профили: телефон необязателен (но уникален, если указан); ручная корректировка бонусов
alter table public.orders drop column if exists delivery_time;
alter table public.profiles drop constraint if exists profiles_phone_key;
alter table public.profiles alter column phone set default '';
create unique index if not exists profiles_phone_uq on public.profiles (phone) where phone <> '';
alter table public.profiles add column if not exists bonus_adjust int not null default 0;

create or replace function public.order_day() returns date language sql stable as $$ select case when extract(hour from public.kz_now()) < 8 then public.kz_now()::date else public.kz_now()::date + 1 end $$;

create or replace function public.order_window_open() returns boolean language sql stable security definer set search_path = public as
$$ select coalesce((select any_time from public.settings where id = 1), false)
       or extract(hour from public.kz_now()) >= 18 or extract(hour from public.kz_now()) < 8 $$;

create or replace function public.norm_name(p_name text) returns text language sql immutable as $$
  select btrim(regexp_replace(translate(normalize(coalesce(p_name,''), nfc), 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯӘҒҚҢӨҰҮҺІABCDEFGHIJKLMNOPQRSTUVWXYZ', 'абвгдеёжзийклмнопрстуфхцчшщъыьэюяәғқңөұүһіabcdefghijklmnopqrstuvwxyz'), '\s+', ' ', 'g'))
$$;

create or replace function public.login_email(p_name text) returns text language sql immutable set search_path = public, extensions as $$
  select 'obed.n.' || substr(encode(extensions.digest(convert_to(public.norm_name(p_name), 'UTF8'), 'sha256'), 'hex'), 1, 40) || '@gmail.com'
$$;

create or replace function public.bonus_balance(uid uuid) returns int language sql stable security definer set search_path = public as
$$ select (coalesce(sum((case when status = 'paid' and not manual then floor((total - bonus_used) * 0.05)::int else 0 end) - bonus_used), 0)
          + coalesce((select bonus_adjust from public.profiles where id = uid), 0))::int
   from public.orders where user_id = uid $$;

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare v_name text := btrim(regexp_replace(coalesce(nullif(trim(new.raw_user_meta_data->>'name'),''),'Без имени'), '\s+', ' ', 'g'));
begin
  -- имя = логин для входа, поэтому оно должно быть уникальным (без учёта регистра и лишних пробелов)
  if exists (select 1 from public.profiles where public.norm_name(name) = public.norm_name(v_name)) then raise exception 'Это имя уже занято'; end if;
  insert into public.profiles (id, name, phone, company_id, department_id)
  values (new.id, v_name, coalesce(trim(new.raw_user_meta_data->>'phone'),''),
          nullif(new.raw_user_meta_data->>'company_id','')::uuid, nullif(new.raw_user_meta_data->>'department_id','')::uuid);
  return new;
end $$;

create or replace function public.place_order(p_items jsonb, p_use_bonus boolean default false, p_date date default null) returns uuid language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); pr public.profiles; co public.companies; de public.departments; v_total int; v_bonus int := 0; v_id uuid := gen_random_uuid(); v_date date := coalesce(p_date, public.order_day());
begin
  if uid is null then raise exception 'Войдите в аккаунт'; end if;
  if not public.order_window_open() then raise exception 'Приём заказов с 18:00 до 08:00'; end if;
  if v_date < public.kz_now()::date then raise exception 'Нельзя заказать на прошедшую дату'; end if;
  select * into pr from public.profiles where id = uid;
  if pr.company_id is null or pr.department_id is null then raise exception 'Выберите компанию и департамент в профиле'; end if;
  select * into co from public.companies where id = pr.company_id;
  select * into de from public.departments where id = pr.department_id;
  perform pg_advisory_xact_lock(hashtext(uid::text));
  v_total := public._items_total(p_items);
  if p_use_bonus then v_bonus := least(public.bonus_balance(uid), v_total); end if;
  insert into public.orders (id, user_id, customer_name, customer_phone, company_name, department_name, for_date, total, bonus_used, status, paid_at)
  values (v_id, uid, pr.name, pr.phone, co.name, de.name, v_date, v_total, v_bonus,
          case when v_total - v_bonus <= 0 then 'paid' else 'created' end, case when v_total - v_bonus <= 0 then now() end);
  perform public._insert_items(v_id, p_items);
  return v_id;
end $$;

create or replace function public.cancel_order(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.order_window_open() then raise exception 'Отмена возможна только с 18:00 до 08:00'; end if;
  delete from public.orders where id = p_id and user_id = auth.uid() and status = 'created';
  if not found then raise exception 'Заказ нельзя отменить'; end if;
end $$;

create or replace function public.update_order(p_id uuid, p_items jsonb, p_date date default null) returns void language plpgsql security definer set search_path = public as $$
declare o public.orders; v_total int; v_bonus int; v_date date;
begin
  if not public.order_window_open() then raise exception 'Изменение возможно только с 18:00 до 08:00'; end if;
  perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
  select * into o from public.orders where id = p_id and user_id = auth.uid() and status = 'created' for update;
  if o.id is null then raise exception 'Заказ нельзя изменить'; end if;
  v_date := coalesce(p_date, o.for_date);
  if v_date <> o.for_date and v_date < public.kz_now()::date then raise exception 'Нельзя выбрать прошедшую дату'; end if;
  v_total := public._items_total(p_items);
  v_bonus := least(o.bonus_used, v_total);
  delete from public.order_items where order_id = p_id;
  perform public._insert_items(p_id, p_items);
  update public.orders set total = v_total, bonus_used = v_bonus, for_date = v_date,
    status = case when v_total - v_bonus <= 0 then 'paid' else 'created' end, paid_at = case when v_total - v_bonus <= 0 then now() end where id = p_id;
end $$;

create or replace function public.admin_update_order(p_id uuid, p_items jsonb, p_date date default null) returns void language plpgsql security definer set search_path = public as $$
declare o public.orders; v_total int; v_bonus int;
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  select * into o from public.orders where id = p_id for update;
  if o.id is null then raise exception 'Заказ не найден'; end if;
  v_total := public._items_total(p_items);
  v_bonus := least(o.bonus_used, v_total);
  delete from public.order_items where order_id = p_id;
  perform public._insert_items(p_id, p_items);
  update public.orders set total = v_total, bonus_used = v_bonus, for_date = coalesce(p_date, o.for_date),
    status = case when o.status = 'created' and v_total - v_bonus <= 0 then 'paid' else o.status end,
    paid_at = case when o.status = 'created' and v_total - v_bonus <= 0 then now() else o.paid_at end where id = p_id;
end $$;

create or replace function public.admin_create_order(p_user uuid, p_items jsonb, p_date date default null) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid := gen_random_uuid(); pr public.profiles; co public.companies; de public.departments; v_total int; v_date date := coalesce(p_date, public.order_day());
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  select * into pr from public.profiles where id = p_user;
  if pr.id is null then raise exception 'Выберите клиента из списка'; end if;
  select * into co from public.companies where id = pr.company_id; select * into de from public.departments where id = pr.department_id;
  v_total := public._items_total(p_items);
  -- заказ привязан к клиенту (manual = false), поэтому ему начисляются бонусы; оплачен сразу
  insert into public.orders (id, user_id, customer_name, customer_phone, company_name, department_name, for_date, total, status, paid_at)
  values (v_id, pr.id, pr.name, pr.phone, coalesce(co.name,''), coalesce(de.name,''), v_date, v_total, 'paid', now());
  perform public._insert_items(v_id, p_items);
  return v_id;
end $$;

create or replace function public.dept_orders(p_date date default null) returns table (customer_name text, items jsonb)
language sql stable security definer set search_path = public as $$
  select o.customer_name,
    coalesce((select jsonb_agg(jsonb_build_object('name', i.name, 'qty', i.qty) order by i.name) from public.order_items i where i.order_id = o.id), '[]'::jsonb)
  from public.orders o
  join public.profiles me on me.id = auth.uid()
  join public.companies cc on cc.id = me.company_id
  join public.departments dd on dd.id = me.department_id
  where o.department_name = dd.name and o.company_name = cc.name
    and o.status = 'paid' and o.for_date = coalesce(p_date, public.order_day())
  order by o.created_at
$$;

create or replace function public.admin_clients() returns table (id uuid, name text, phone text, company_id uuid, department_id uuid, company_name text, department_name text, is_admin boolean, bonus int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  return query select p.id, p.name, p.phone, p.company_id, p.department_id, c.name, d.name, p.is_admin, public.bonus_balance(p.id)
    from public.profiles p left join public.companies c on c.id = p.company_id left join public.departments d on d.id = p.department_id order by p.name;
end $$;

create or replace function public.admin_update_client(p_id uuid, p_name text, p_phone text, p_company uuid, p_dept uuid, p_bonus int, p_admin boolean) returns void language plpgsql security definer set search_path = public, auth as $$
declare pr public.profiles; v_name text := btrim(regexp_replace(coalesce(p_name,''), '\s+', ' ', 'g')); v_phone text := coalesce(trim(p_phone),''); v_email text;
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  select * into pr from public.profiles where id = p_id for update;
  if pr.id is null then raise exception 'Клиент не найден'; end if;
  if v_name = '' then raise exception 'Введите имя'; end if;
  if p_id = auth.uid() and not p_admin then raise exception 'Нельзя снять права с себя'; end if;
  if exists (select 1 from public.profiles where id <> p_id and public.norm_name(name) = public.norm_name(v_name)) then raise exception 'Это имя уже занято'; end if;
  if v_phone <> '' and exists (select 1 from public.profiles where id <> p_id and phone = v_phone) then raise exception 'Этот номер уже занят'; end if;
  if p_dept is not null and not exists (select 1 from public.departments where id = p_dept and company_id = p_company) then raise exception 'Департамент не относится к выбранной компании'; end if;
  v_email := public.login_email(v_name);
  begin
    update auth.users set email = v_email, updated_at = now() where id = p_id and email <> v_email;
    update auth.identities set identity_data = jsonb_set(identity_data, '{email}', to_jsonb(v_email)), updated_at = now()
      where user_id = p_id and provider = 'email' and identity_data->>'email' is distinct from v_email;
  exception when unique_violation then raise exception 'Это имя уже занято';
  end;
  update public.profiles set name = v_name, phone = v_phone, company_id = p_company, department_id = p_dept, is_admin = p_admin,
    bonus_adjust = case when p_bonus is null then bonus_adjust else bonus_adjust + greatest(p_bonus, 0) - public.bonus_balance(p_id) end
  where id = p_id;
end $$;

create or replace function public.admin_delete_user(p_id uuid) returns void language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  if p_id = auth.uid() then raise exception 'Нельзя удалить самого себя'; end if;
  delete from auth.users where id = p_id;
end $$;

-- САМОПРОВЕРКА: хеш имени в базе должен совпасть с тем, что считает сайт. Если нет — выполнение
-- останавливается с ошибкой, и ничего не меняется (иначе люди не смогли бы войти).
do $$ begin
  if public.login_email(E'Айгерим') <> 'obed.n.1e3be78252e0aa2b99c798ead5c26e1586e186db@gmail.com' or
     public.login_email(E'  ТЕСТ   Қанат ') <> 'obed.n.0b7c0fcd613ff00705956bc4a0d9b26b03cf4ad3@gmail.com' or
     public.login_email(E'Ёжик Aigerim') <> 'obed.n.2d7ace5e2bb3c0913dbde550e430d8ecda99e257@gmail.com' or
     public.login_email(E'ҒҚҢӨҰҮҺІ Ә\tДа') <> 'obed.n.7f6d565e52332292e6829a0daad7d118dc15fc10@gmail.com' then
    raise exception 'Самопроверка не пройдена: хеш входа в базе не совпадает с сайтом. Ничего не изменено.';
  end if;
end $$;

-- ПЕРЕВОД ВСЕХ НА ВХОД ПО ИМЕНИ
do $$
declare r record; v_name text; n int; v_email text;
begin
  -- 1) логин = имя, значит имена должны быть уникальными: повторы получают номер (Мага, Мага 2, ...)
  for r in select id, name, row_number() over (partition by public.norm_name(name) order by created_at, id) as rn from public.profiles loop
    if r.rn > 1 then
      n := r.rn;
      loop
        v_name := r.name || ' ' || n;
        exit when not exists (select 1 from public.profiles where public.norm_name(name) = public.norm_name(v_name));
        n := n + 1;
      end loop;
      update public.profiles set name = v_name where id = r.id;
    end if;
  end loop;
  -- 2) технический адрес каждого аккаунта становится адресом по имени (пароли не меняются)
  for r in select p.id, p.name from public.profiles p join auth.users u on u.id = p.id where u.email <> public.login_email(p.name) loop
    v_email := public.login_email(r.name);
    update auth.users set email = v_email, updated_at = now() where id = r.id;
    update auth.identities set identity_data = jsonb_set(identity_data, '{email}', to_jsonb(v_email)), updated_at = now()
      where user_id = r.id and provider = 'email';
  end loop;
end $$;

-- клиент сам может менять только компанию и департамент (имя меняет админ)
revoke update on public.profiles from authenticated;
grant update (company_id, department_id) on public.profiles to authenticated;

revoke execute on function public.norm_name(text), public.login_email(text) from public, anon, authenticated;
revoke execute on function public.place_order(jsonb, boolean, date), public.admin_create_order(uuid, jsonb, date),
  public.update_order(uuid, jsonb, date), public.admin_update_order(uuid, jsonb, date), public.dept_orders(date),
  public.admin_clients(), public.admin_update_client(uuid, text, text, uuid, uuid, int, boolean), public.admin_delete_user(uuid) from public, anon;

notify pgrst, 'reload schema';
