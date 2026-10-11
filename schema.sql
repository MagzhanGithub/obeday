-- ОБЕД: схема базы данных. Вставьте целиком в Supabase -> SQL Editor -> Run.
create extension if not exists pgcrypto with schema extensions;

create table public.companies (id uuid primary key default gen_random_uuid(), name text not null, created_at timestamptz default now());
create table public.departments (id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies on delete cascade, name text not null);
create table public.foods (id uuid primary key default gen_random_uuid(), name text not null, price int not null check (price > 0), kind text not null default 'food' check (kind in ('food','salad')), active boolean not null default true, image_url text, created_at timestamptz default now());
create table public.settings (id int primary key default 1 check (id = 1), pay_phone text default '', wa_phone text default '', any_time boolean default false);
insert into public.settings (id) values (1);
create table public.profiles (id uuid primary key references auth.users on delete cascade, name text not null, phone text not null unique, company_id uuid references public.companies on delete set null, department_id uuid references public.departments on delete set null, is_admin boolean not null default false, created_at timestamptz default now());
create table public.orders (id uuid primary key default gen_random_uuid(), user_id uuid references public.profiles on delete set null, customer_name text not null, customer_phone text default '', company_name text default '', department_name text default '', for_date date not null, total int not null, bonus_used int not null default 0, status text not null default 'created' check (status in ('created','paid')), manual boolean not null default false, created_at timestamptz default now(), paid_at timestamptz);
create table public.order_items (id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders on delete cascade, name text not null, price int not null, qty int not null);
create index on public.orders (for_date); create index on public.orders (user_id); create index on public.order_items (order_id);

-- профиль создаётся автоматически при регистрации
create function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, phone, company_id, department_id)
  values (new.id, coalesce(nullif(trim(new.raw_user_meta_data->>'name'),''),'Без имени'), coalesce(new.raw_user_meta_data->>'phone',''),
          nullif(new.raw_user_meta_data->>'company_id','')::uuid, nullif(new.raw_user_meta_data->>'department_id','')::uuid);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- вспомогательные функции
create function public.is_admin() returns boolean language sql stable security definer set search_path = public as
$$ select coalesce((select is_admin from public.profiles where id = auth.uid()), false) $$;
create function public.kz_now() returns timestamp language sql stable as $$ select now() at time zone 'Asia/Almaty' $$;
create function public.order_window_open() returns boolean language sql stable security definer set search_path = public as
$$ select coalesce((select any_time from public.settings where id = 1), false)
       or (extract(hour from public.kz_now()) >= 18 and extract(hour from public.kz_now()) < 22) $$;
-- баланс бонусов = 5% с оплаченных заказов (от суммы деньгами) минус потраченное
create function public.bonus_balance(uid uuid) returns int language sql stable security definer set search_path = public as
$$ select coalesce(sum((case when status = 'paid' and not manual then floor((total - bonus_used) * 0.05)::int else 0 end) - bonus_used), 0)::int
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
create function public.place_order(p_items jsonb, p_use_bonus boolean default false) returns uuid language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); pr public.profiles; co public.companies; de public.departments; v_total int; v_bonus int := 0; v_id uuid := gen_random_uuid();
begin
  if uid is null then raise exception 'Войдите в аккаунт'; end if;
  if not public.order_window_open() then raise exception 'Приём заказов с 18:00 до 22:00'; end if;
  select * into pr from public.profiles where id = uid;
  if pr.company_id is null or pr.department_id is null then raise exception 'Выберите компанию и департамент в профиле'; end if;
  select * into co from public.companies where id = pr.company_id;
  select * into de from public.departments where id = pr.department_id;
  perform pg_advisory_xact_lock(hashtext(uid::text));
  v_total := public._items_total(p_items);
  if p_use_bonus then v_bonus := least(public.bonus_balance(uid), v_total); end if;
  insert into public.orders (id, user_id, customer_name, customer_phone, company_name, department_name, for_date, total, bonus_used, status, paid_at)
  values (v_id, uid, pr.name, pr.phone, co.name, de.name, public.kz_now()::date + 1, v_total, v_bonus,
          case when v_total - v_bonus <= 0 then 'paid' else 'created' end, case when v_total - v_bonus <= 0 then now() end);
  perform public._insert_items(v_id, p_items);
  return v_id;
end $$;

create function public.cancel_order(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.order_window_open() then raise exception 'Отмена возможна только с 18:00 до 22:00'; end if;
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
create function public.admin_create_order(p_name text, p_company uuid, p_dept uuid, p_items jsonb) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid := gen_random_uuid(); co public.companies; de public.departments; v_total int;
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  select * into co from public.companies where id = p_company; select * into de from public.departments where id = p_dept;
  if co.id is null or de.id is null or coalesce(trim(p_name),'') = '' then raise exception 'Укажите имя, компанию и департамент'; end if;
  v_total := public._items_total(p_items);
  insert into public.orders (id, customer_name, company_name, department_name, for_date, total, status, manual, paid_at)
  values (v_id, trim(p_name), co.name, de.name, public.kz_now()::date + 1, v_total, 'paid', true, now());
  perform public._insert_items(v_id, p_items);
  return v_id;
end $$;
create function public.admin_clients() returns table (id uuid, name text, phone text, company_name text, department_name text, is_admin boolean, bonus int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  return query select p.id, p.name, p.phone, c.name, d.name, p.is_admin, public.bonus_balance(p.id)
    from public.profiles p left join public.companies c on c.id = p.company_id left join public.departments d on d.id = p.department_id order by p.name;
end $$;
create function public.set_admin(p_id uuid, p_value boolean) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  if p_id = auth.uid() and not p_value then raise exception 'Нельзя снять права с себя'; end if;
  update public.profiles set is_admin = p_value where id = p_id;
end $$;
create function public.admin_reset_password(p_id uuid, p_password text) returns void language plpgsql security definer set search_path = public, extensions, auth as $$
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  if length(coalesce(p_password,'')) < 6 then raise exception 'Слишком короткий пароль'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now() where id = p_id;
end $$;

-- права на функции: анонимам закрыто
revoke execute on function public.bonus_balance(uuid), public._items_total(jsonb), public._insert_items(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.my_bonus(), public.place_order(jsonb, boolean), public.cancel_order(uuid), public.set_order_status(uuid, text), public.admin_delete_order(uuid),
  public.admin_create_order(text, uuid, uuid, jsonb), public.admin_clients(), public.set_admin(uuid, boolean), public.admin_reset_password(uuid, text) from public, anon;

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
grant update (name, company_id, department_id) on public.profiles to authenticated;
revoke insert, update, delete on public.orders, public.order_items from anon, authenticated;

-- фото блюд
insert into storage.buckets (id, name, public) values ('food', 'food', true) on conflict (id) do nothing;
create policy "food read" on storage.objects for select using (bucket_id = 'food');
create policy "food insert" on storage.objects for insert to authenticated with check (bucket_id = 'food' and public.is_admin());
create policy "food update" on storage.objects for update to authenticated using (bucket_id = 'food' and public.is_admin());
create policy "food delete" on storage.objects for delete to authenticated using (bucket_id = 'food' and public.is_admin());
