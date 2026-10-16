-- ОБЕД: схема базы данных. Вставьте целиком в Supabase -> SQL Editor -> Run.
create extension if not exists pgcrypto with schema extensions;

create table public.companies (id uuid primary key default gen_random_uuid(), name text not null, created_at timestamptz default now());
create table public.departments (id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies on delete cascade, name text not null);
create table public.foods (id uuid primary key default gen_random_uuid(), name text not null, price int not null check (price > 0), kind text not null default 'food' check (kind in ('food','salad')), active boolean not null default true, image_url text, created_at timestamptz default now());
create table public.settings (id int primary key default 1 check (id = 1), pay_phone text default '', wa_phone text default '', any_time boolean default false);
insert into public.settings (id) values (1);
create table public.profiles (id uuid primary key references auth.users on delete cascade, name text not null, phone text not null default '', company_id uuid references public.companies on delete set null, department_id uuid references public.departments on delete set null, is_admin boolean not null default false, bonus_adjust int not null default 0, created_at timestamptz default now());
create table public.orders (id uuid primary key default gen_random_uuid(), user_id uuid references public.profiles on delete set null, customer_name text not null, customer_phone text default '', company_name text default '', department_name text default '', for_date date not null, total int not null, bonus_used int not null default 0, status text not null default 'created' check (status in ('created','paid')), manual boolean not null default false, created_at timestamptz default now(), paid_at timestamptz);
create table public.order_items (id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders on delete cascade, name text not null, price int not null, qty int not null);
create index on public.orders (for_date); create index on public.orders (user_id); create index on public.order_items (order_id);
create unique index profiles_phone_uq on public.profiles (phone) where phone <> '';

-- профиль создаётся автоматически при регистрации
create function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare v_name text := btrim(regexp_replace(coalesce(nullif(trim(new.raw_user_meta_data->>'name'),''),'Без имени'), '\s+', ' ', 'g'));
begin
  -- имя = логин для входа, поэтому оно должно быть уникальным (без учёта регистра и лишних пробелов)
  if exists (select 1 from public.profiles where public.norm_name(name) = public.norm_name(v_name)) then raise exception 'Это имя уже занято'; end if;
  insert into public.profiles (id, name, phone, company_id, department_id)
  values (new.id, v_name, coalesce(trim(new.raw_user_meta_data->>'phone'),''),
          nullif(new.raw_user_meta_data->>'company_id','')::uuid, nullif(new.raw_user_meta_data->>'department_id','')::uuid);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- вспомогательные функции
create function public.norm_name(p_name text) returns text language sql immutable as $$
  select btrim(regexp_replace(translate(normalize(coalesce(p_name,''), nfc), 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯӘҒҚҢӨҰҮҺІABCDEFGHIJKLMNOPQRSTUVWXYZ', 'абвгдеёжзийклмнопрстуфхцчшщъыьэюяәғқңөұүһіabcdefghijklmnopqrstuvwxyz'), '\s+', ' ', 'g'))
$$;
-- технический адрес для входа из имени. Должен давать то же, что emailOfName() в app.js; домен — как EMAIL_DOMAIN в config.js
create function public.login_email(p_name text) returns text language sql immutable set search_path = public, extensions as $$
  select 'obed.n.' || substr(encode(extensions.digest(convert_to(public.norm_name(p_name), 'UTF8'), 'sha256'), 'hex'), 1, 40) || '@gmail.com'
$$;
create function public.is_admin() returns boolean language sql stable security definer set search_path = public as
$$ select coalesce((select is_admin from public.profiles where id = auth.uid()), false) $$;
create function public.kz_now() returns timestamp language sql stable as $$ select now() at time zone 'Asia/Almaty' $$;
-- день заказа идёт с 08:00 до 08:00: до 08:00 это ещё сегодняшняя дата, с 08:00 — завтрашняя
create function public.order_day() returns date language sql stable as $$ select case when extract(hour from public.kz_now()) < 8 then public.kz_now()::date else public.kz_now()::date + 1 end $$;
create function public.order_window_open() returns boolean language sql stable security definer set search_path = public as
$$ select coalesce((select any_time from public.settings where id = 1), false)
       or extract(hour from public.kz_now()) >= 18 or extract(hour from public.kz_now()) < 8 $$;
-- баланс бонусов = 5% с оплаченных заказов (от суммы деньгами) минус потраченное, плюс ручная корректировка админа
create function public.bonus_balance(uid uuid) returns int language sql stable security definer set search_path = public as
$$ select (coalesce(sum((case when status = 'paid' and not manual then floor((total - bonus_used) * 0.05)::int else 0 end) - bonus_used), 0)
          + coalesce((select bonus_adjust from public.profiles where id = uid), 0))::int
   from public.orders where user_id = uid $$;
create function public.my_bonus() returns int language sql stable security definer set search_path = public as $$ select public.bonus_balance(auth.uid()) $$;

create function public._items_total(p_items jsonb) returns int language plpgsql stable security definer set search_path = public as $$
declare t int := 0; it jsonb; f public.foods; q int;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Пустой заказ'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    q := (it->>'qty')::int;
    select * into f from public.foods where id = (it->>'food_id')::uuid and active;
    if f.id is null or q is null or q < 1 or q > 50 then raise exception 'Неверный состав заказа'; end if;
    t := t + f.price * q;
  end loop;
  return t;
end $$;
create function public._insert_items(p_order uuid, p_items jsonb) returns void language plpgsql security definer set search_path = public as $$
declare it jsonb; f public.foods;
begin
  for it in select * from jsonb_array_elements(p_items) loop
    select * into f from public.foods where id = (it->>'food_id')::uuid;
    insert into public.order_items (order_id, name, price, qty) values (p_order, f.name, f.price, (it->>'qty')::int);
  end loop;
end $$;

-- заказ пользователя: цены и время проверяются на сервере
create function public.place_order(p_items jsonb, p_use_bonus boolean default false, p_date date default null) returns uuid language plpgsql security definer set search_path = public as $$
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

create function public.cancel_order(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.order_window_open() then raise exception 'Отмена возможна только с 18:00 до 08:00'; end if;
  delete from public.orders where id = p_id and user_id = auth.uid() and status = 'created';
  if not found then raise exception 'Заказ нельзя отменить'; end if;
end $$;

-- функции администратора
create function public.set_order_status(p_id uuid, p_status text) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  update public.orders set status = p_status, paid_at = case when p_status = 'paid' then now() end where id = p_id;
end $$;
create function public.admin_delete_order(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  delete from public.orders where id = p_id;
end $$;
create function public.admin_create_order(p_user uuid, p_items jsonb, p_date date default null) returns uuid language plpgsql security definer set search_path = public as $$
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
create function public.admin_clients() returns table (id uuid, name text, phone text, company_id uuid, department_id uuid, company_name text, department_name text, is_admin boolean, bonus int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  return query select p.id, p.name, p.phone, p.company_id, p.department_id, c.name, d.name, p.is_admin, public.bonus_balance(p.id)
    from public.profiles p left join public.companies c on c.id = p.company_id left join public.departments d on d.id = p.department_id order by p.name;
end $$;
create function public.admin_reset_password(p_id uuid, p_password text) returns void language plpgsql security definer set search_path = public, extensions, auth as $$
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  if length(coalesce(p_password,'')) < 6 then raise exception 'Слишком короткий пароль'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now() where id = p_id;
end $$;

-- изменение клиента админом: имя (= логин, адрес для входа обновляется сам), телефон, компания/департамент, бонусы, права админа
create function public.admin_update_client(p_id uuid, p_name text, p_phone text, p_company uuid, p_dept uuid, p_bonus int, p_admin boolean) returns void language plpgsql security definer set search_path = public, auth as $$
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
-- удаление пользователя: заказы остаются в истории (user_id станет пустым), бонусы и вход пропадают
create function public.admin_delete_user(p_id uuid) returns void language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  if p_id = auth.uid() then raise exception 'Нельзя удалить самого себя'; end if;
  delete from auth.users where id = p_id;
end $$;

-- изменение своего заказа (пока он не оплачен и идёт приём заказов): блюда и дата
create function public.update_order(p_id uuid, p_items jsonb, p_date date default null) returns void language plpgsql security definer set search_path = public as $$
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
-- изменение любого заказа администратором (без ограничений по времени и дате)
create function public.admin_update_order(p_id uuid, p_items jsonb, p_date date default null) returns void language plpgsql security definer set search_path = public as $$
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

-- оплаченные заказы своего департамента (включая свои) на дату, по умолчанию завтра: только имя и блюда
create function public.dept_orders(p_date date default null) returns table (customer_name text, items jsonb)
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

-- права на функции: анонимам закрыто
revoke execute on function public.bonus_balance(uuid), public._items_total(jsonb), public._insert_items(uuid, jsonb), public.norm_name(text), public.login_email(text) from public, anon, authenticated;
revoke execute on function public.my_bonus(), public.dept_orders(date), public.place_order(jsonb, boolean, date), public.cancel_order(uuid), public.update_order(uuid, jsonb, date), public.admin_update_order(uuid, jsonb, date), public.set_order_status(uuid, text), public.admin_delete_order(uuid),
  public.admin_create_order(uuid, jsonb, date), public.admin_clients(), public.admin_update_client(uuid, text, text, uuid, uuid, int, boolean), public.admin_delete_user(uuid), public.admin_reset_password(uuid, text) from public, anon;

-- защита таблиц (RLS)
alter table public.companies enable row level security; alter table public.departments enable row level security; alter table public.foods enable row level security;
alter table public.settings enable row level security; alter table public.profiles enable row level security; alter table public.orders enable row level security; alter table public.order_items enable row level security;

create policy read_all on public.companies for select using (true);
create policy admin_all on public.companies for all using (public.is_admin()) with check (public.is_admin());
create policy read_all on public.departments for select using (true);
create policy admin_all on public.departments for all using (public.is_admin()) with check (public.is_admin());
create policy read_all on public.foods for select using (true);
create policy admin_all on public.foods for all using (public.is_admin()) with check (public.is_admin());
create policy read_all on public.settings for select using (true);
create policy admin_all on public.settings for all using (public.is_admin()) with check (public.is_admin());
create policy own_or_admin on public.profiles for select using (id = auth.uid() or public.is_admin());
create policy own_update on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());
create policy own_or_admin on public.orders for select using (user_id = auth.uid() or public.is_admin());
create policy own_or_admin on public.order_items for select using (exists (select 1 from public.orders o where o.id = order_id and (o.user_id = auth.uid() or public.is_admin())));

-- пользователь может менять в профиле только имя, компанию и департамент (не is_admin!)
revoke insert, update, delete on public.profiles from anon, authenticated;
grant update (company_id, department_id) on public.profiles to authenticated;
revoke insert, update, delete on public.orders, public.order_items from anon, authenticated;

-- фото блюд
insert into storage.buckets (id, name, public) values ('food', 'food', true) on conflict (id) do nothing;
create policy "food read" on storage.objects for select using (bucket_id = 'food');
create policy "food insert" on storage.objects for insert to authenticated with check (bucket_id = 'food' and public.is_admin());
create policy "food update" on storage.objects for update to authenticated using (bucket_id = 'food' and public.is_admin());
create policy "food delete" on storage.objects for delete to authenticated using (bucket_id = 'food' and public.is_admin());
