'use strict';
const C=window.CONFIG,sb=supabase.createClient(C.SUPABASE_URL,C.SUPABASE_KEY);
const PAD='#obed',TZ='Asia/Almaty',BONUS=0.05;
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt=n=>Number(n).toLocaleString('ru-RU').replace(/\u00a0/g,' ')+' ₸';
const kz=()=>Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(x=>[x.type,x.value]));
const today=()=>{const p=kz();return p.year+'-'+p.month+'-'+p.day};
const tomorrow=()=>{const p=kz();return new Date(Date.UTC(+p.year,+p.month-1,+p.day+1)).toISOString().slice(0,10)};
// день заказа идёт с 08:00 до 08:00: до 08:00 ещё «сегодняшний» день, с 08:00 — «завтрашний»
const orderDay=()=>+kz().hour<8?today():tomorrow();
const isOpen=()=>!!S.settings.any_time||+kz().hour>=18||+kz().hour<8;
const normPhone=p=>{let d=String(p).replace(/\D/g,'');if(d.length===11&&d[0]==='8')d='7'+d.slice(1);if(d.length===10)d='7'+d;return d};
const showPhone=p=>p&&p.length===11?'8'+p.slice(1):(p||'');
const UP='АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯӘҒҚҢӨҰҮҺІABCDEFGHIJKLMNOPQRSTUVWXYZ',LO='абвгдеёжзийклмнопрстуфхцчшщъыьэюяәғқңөұүһіabcdefghijklmnopqrstuvwxyz';
// нормализация имени: регистр и лишние пробелы не важны. То же самое делает SQL-функция norm_name
const normName=s=>[...String(s).normalize('NFC')].map(c=>{const i=UP.indexOf(c);return i<0?c:LO[i]}).join('').replace(/\s+/g,' ').trim();
// технический адрес для входа: хеш имени (должен совпадать с SQL-функцией login_email)
const emailOfName=async n=>{const h=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(normName(n)));return 'obed.n.'+[...new Uint8Array(h)].slice(0,20).map(x=>x.toString(16).padStart(2,'0')).join('')+'@'+C.EMAIL_DOMAIN};
const pw=x=>x+PAD; // пароль «123» принимается: служебная приставка делает его достаточно длинным для Supabase
const items=o=>o.order_items||[];
const isPaid=o=>o.status==='paid';
const earned=o=>isPaid(o)&&!o.manual?Math.floor((o.total-(o.bonus_used||0))*BONUS):0;
const bonusPend=()=>S.mine.filter(o=>!isPaid(o)).reduce((b,o)=>b+Math.floor((o.total-(o.bonus_used||0))*BONUS),0);
const split=t=>{const o=Math.round(t*.90),m=Math.round(t*.05);return {o,m,r:t-o-m}};

/* ---------- диалоги внутри страницы ---------- */
function dlg(text,o={}){return new Promise(res=>{const w=document.createElement('div');w.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px;z-index:99';
  const inp=o.input!==undefined;w.innerHTML=`<div class="card" style="max-width:360px;width:100%;margin:0"><p style="margin:0 0 10px">${esc(text)}</p>${inp?`<input id="dg" value="${esc(o.input)}">`:''}<div class="row" style="justify-content:flex-end;gap:8px">${o.info?'':'<button class="btn sm" id="dn">Отмена</button>'}<button class="btn sm pri" id="dy">OK</button></div></div>`;
  document.body.appendChild(w);const done=v=>{w.remove();res(v)};
  w.querySelector('#dy').onclick=()=>done(inp?w.querySelector('#dg').value:true);const n=w.querySelector('#dn');if(n)n.onclick=()=>done(inp?null:false)})}
const ask=t=>dlg(t),tell=t=>dlg(t,{info:true}),prm=(t,v)=>dlg(t,{input:v});
const bonusInfo=()=>tell(`Ваши бонусы: ${fmt(S.bonus)}. За каждый оплаченный заказ начисляется 5%, бонусами можно оплатить заказ (1 бонус = 1 ₸).`+(bonusPend()?` Ожидает начисления после оплаты: ${fmt(bonusPend())}.`:''));

const S={ready:false,profile:null,admin:false,companies:[],depts:[],foods:[],settings:{},mine:[],bonus:0,orders:[],clients:[],
 step:'home',cart:{},view:'user',tab:'orders',adate:orderDay(),auth:'login',err:'',flash:'',useBonus:false,team:[],edit:null,odate:orderDay(),
 draft:{n:'',p:'',w:'',c:'',d:''},pd:{c:'',d:''},nd:{c:'',s:'',q:{},dt:orderDay()}};
function set(o){Object.assign(S,o);render()}
const val=id=>($('#'+id)?.value||'').trim();
const go=(a,f)=>set({auth:a,err:'',flash:f||''});
const fail=e=>tell(e&&e.message?e.message:String(e));

/* ---------- загрузка данных ---------- */
async function loadCatalog(){
  const [c,d,f,s]=await Promise.all([sb.from('companies').select('*').order('name'),sb.from('departments').select('*').order('name'),sb.from('foods').select('*').order('created_at'),sb.from('settings').select('*').eq('id',1).maybeSingle()]);
  S.companies=c.data||[];S.depts=d.data||[];S.foods=f.data||[];S.settings=s.data||{};
}
async function refreshUser(){
  const [o,b,t]=await Promise.all([sb.from('orders').select('*,order_items(*)').eq('user_id',S.profile.id).order('for_date',{ascending:false}).order('created_at',{ascending:false}),sb.rpc('my_bonus'),sb.rpc('dept_orders',{p_date:orderDay()})]);
  S.mine=o.data||[];S.bonus=b.data||0;S.team=t.data||[];
}
async function refreshAdmin(){
  const since=new Date(Date.now()-120*864e5).toISOString().slice(0,10);
  const [o,c]=await Promise.all([sb.from('orders').select('*,order_items(*)').gte('for_date',since).order('created_at'),sb.rpc('admin_clients')]);
  S.orders=o.data||[];S.clients=c.data||[];
}
async function loadUser(){
  const {data:{session}}=await sb.auth.getSession();
  if(!session){S.profile=null;S.admin=false;return}
  const {data:p}=await sb.from('profiles').select('*').eq('id',session.user.id).maybeSingle();
  if(!p){await sb.auth.signOut();S.profile=null;return}
  S.profile=p;S.admin=!!p.is_admin;await refreshUser();if(S.admin)await refreshAdmin();
}
async function boot(){
  try{await loadCatalog();await loadUser()}catch(e){console.error(e)}
  S.ready=true;render();setInterval(tick,20000);
}
async function tick(){
  if(!S.profile||document.hidden||S.pend)return;
  const safe=(S.view==='user'&&S.step==='home')||(S.view==='admin'&&['orders','stats','clients'].includes(S.tab));
  if(!safe)return;
  try{await loadCatalog();await refreshUser();if(S.admin)await refreshAdmin();render()}catch(e){}
}

/* ---------- каркас ---------- */
const ICON='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-label="Профиль"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>';
function header(){return `<div class="top"><div><h1>🍽 Обед</h1></div><div>${S.admin?`<button class="tab" onclick="set({view:S.view==='admin'?'user':'admin'})">${S.view==='admin'?'← Меню':'⚙ Админка'}</button>`:''}${S.profile&&S.view!=='admin'?(S.view==='profile'?`<button class="tab" onclick="set({view:'user',err:'',flash:''})">← Назад</button>`:`<button class="tab" onclick="bonusInfo()" style="vertical-align:middle">💎 ${S.bonus.toLocaleString('ru-RU')}</button><button class="tab" onclick="openProfile()" style="padding:8px 10px;vertical-align:middle">${ICON}</button>`):''}</div></div>`}
function render(){
  const a=$('#app');a.style.maxWidth=(S.view==='admin'&&S.admin)?'980px':'560px';
  if(!S.ready)return a.innerHTML='Загрузка…';
  if(!S.profile)return a.innerHTML=header()+authView();
  if(S.view==='admin'&&S.admin)return a.innerHTML=header()+adminView();
  a.innerHTML=header()+(S.view==='profile'?profileView():userView());
}

/* ---------- вход и регистрация ---------- */
function orgPicker(D,pre){
  const ds=S.depts.filter(d=>d.company_id===D.c),o=(l,v)=>l.map(x=>`<option value="${x.id}" ${v===x.id?'selected':''}>${esc(x.name)}</option>`).join('');
  return `<div class="tabs"><button class="tab on">🏢 Компания</button><button class="tab" disabled style="opacity:.45">🧺 Базар — скоро</button><button class="tab" disabled style="opacity:.45">🛒 Магазины — скоро</button></div>
  <select onchange="${pre}.c=this.value;${pre}.d='';render()"><option value="">${S.companies.length?'Выберите компанию':'Компаний пока нет'}</option>${o(S.companies,D.c)}</select>
  <select onchange="${pre}.d=this.value" ${D.c?'':'disabled'}><option value="">Выберите департамент</option>${o(ds,D.d)}</select>`}
function authView(){
  const m=(S.err?`<div class="warn">${esc(S.err)}</div>`:'')+(S.flash?`<div class="ok" style="margin:8px 0">${esc(S.flash)}</div>`:'');
  const lnk=(a,t)=>`<button class="back" onclick="go('${a}')">${t}</button>`,A=S.auth||'login';
  if(A==='reg'){const D=S.draft;return `<h2>Регистрация</h2>${m}<div class="card"><input placeholder="Имя — по нему вы будете входить" value="${esc(D.n)}" oninput="S.draft.n=this.value" autocomplete="name"><input type="tel" placeholder="Номер телефона" value="${esc(D.p)}" oninput="S.draft.p=this.value" autocomplete="tel"><input type="password" placeholder="Пароль" value="${esc(D.w)}" oninput="S.draft.w=this.value" autocomplete="new-password"><div class="mu" style="margin-top:10px">Откуда заказываете</div>${orgPicker(D,'S.draft')}<button class="btn pri" onclick="register()">Зарегистрироваться</button></div>${lnk('login','← Уже есть аккаунт? Войти')}`}
  if(A==='forgot'){const n=String(S.settings.wa_phone||S.settings.pay_phone||'').replace(/\D/g,'');return `<h2>Забыли пароль?</h2><div class="card"><p>Напишите администратору — он сбросит пароль, и вы войдёте с новым.</p>${n?`<a class="btn pri" target="_blank" rel="noopener" href="https://wa.me/${n.length===11&&n[0]==='8'?'7'+n.slice(1):n}?text=${encodeURIComponent('Здравствуйте! Я забыл(а) пароль. Моё имя: ')}">💬 Написать в WhatsApp</a>`:''}</div>${lnk('login','← Назад ко входу')}`}
  return `<h2>Вход</h2>${m}<div class="card"><input id="ll" placeholder="Ваше имя, например Айгерим" autocomplete="username"><input id="lw" type="password" placeholder="Пароль" autocomplete="current-password"><button class="btn pri" onclick="login()">Войти</button></div>${lnk('forgot','Забыли пароль?')}<br>${lnk('reg','Регистрация')}`}
async function register(){
  const D=S.draft,name=D.n.trim().replace(/\s+/g,' '),ph=D.p.trim()?normPhone(D.p):'';
  if(!name)return set({err:'Введите имя'});
  if(ph&&!/^7\d{10}$/.test(ph))return set({err:'Номер телефона введён не полностью (или оставьте поле пустым)'});
  if(!D.w)return set({err:'Введите пароль'});
  const c=S.companies.find(x=>x.id===D.c),d=S.depts.find(x=>x.id===D.d);
  if(!c||!d)return set({err:'Выберите компанию и департамент'});
  const {data,error}=await sb.auth.signUp({email:await emailOfName(name),password:pw(D.w),options:{data:{name,phone:ph,company_id:c.id,department_id:d.id}}});
  if(error)return set({err:/registered|already|Database error|занято/i.test(error.message)?'Это имя (или номер) уже занято. Добавьте к имени фамилию или цифру.':'Не удалось зарегистрироваться: '+error.message});
  if(!data.session)return set({err:'Включено подтверждение email. Выключите «Confirm email» в Supabase (см. README).'});
  S.draft={n:'',p:'',w:'',c:'',d:''};await loadUser();set({err:'',flash:'',step:'home',view:'user'});
}
async function login(){
  const id=val('ll'),w=$('#lw').value;
  if(!id)return set({err:'Введите имя'});
  const {error}=await sb.auth.signInWithPassword({email:await emailOfName(id),password:pw(w)});
  if(error)return set({err:'Неверное имя или пароль'});
  await loadUser();set({err:'',flash:'',step:'home',view:'user'});
}
async function logout(){await sb.auth.signOut();set({profile:null,admin:false,mine:[],bonus:0,orders:[],clients:[],step:'home',cart:{},view:'user',auth:'login',err:'',flash:''})}

/* ---------- профиль ---------- */
function openProfile(){const p=S.profile;set({view:'profile',pd:{c:p.company_id||'',d:p.department_id||''},err:'',flash:''})}
function profileView(){const p=S.profile;
  const m=(S.err?`<div class="warn">${esc(S.err)}</div>`:'')+(S.flash?`<div class="ok" style="margin:8px 0">${esc(S.flash)}</div>`:'');
  return `<h2>Профиль</h2>${m}<div class="card"><b>${esc(p.name)}</b>${p.phone?`<div class="mu">${esc(showPhone(p.phone))}</div>`:''}</div><div class="card"><b>Откуда заказываете</b>${orgPicker(S.pd,'S.pd')}<button class="btn pri" onclick="saveProfile()">Сохранить</button></div><button class="btn" onclick="logout()">Выйти из аккаунта</button>`}
async function saveProfile(){
  if(!S.pd.c||!S.pd.d)return set({err:'Выберите компанию и департамент',flash:''});
  const {error}=await sb.from('profiles').update({company_id:S.pd.c,department_id:S.pd.d}).eq('id',S.profile.id);
  if(error)return set({err:'Не удалось сохранить: '+error.message,flash:''});
  Object.assign(S.profile,{company_id:S.pd.c,department_id:S.pd.d});await refreshUser();set({err:'',flash:'Сохранено ✓'});
}

/* ---------- пользователь ---------- */
const org=p=>{const c=S.companies.find(x=>x.id===p.company_id),d=S.depts.find(x=>x.id===p.department_id);return (c?c.name:'—')+' · '+(d?d.name:'—')};
const back=s=>`<button class="back" onclick="set({step:'${s}'})">← Назад</button>`;
const dlabel=k=>{const d=new Date(k+'T00:00:00'),t=k===tomorrow()?'Завтра, ':k===today()?'Сегодня, ':'';return t+d.toLocaleDateString('ru-RU',{day:'numeric',month:'long',weekday:'short'})};
const waNum=()=>{let d=String(S.settings.wa_phone||S.settings.pay_phone||'').replace(/\D/g,'');if(d.length===11&&d[0]==='8')d='7'+d.slice(1);if(d.length===10)d='7'+d;return d};
const waText=o=>{const b=o.bonus_used||0,cash=o.total-b;
  const pay=b?`💰 Сумма: ${fmt(o.total)}\n💎 Оплачено бонусами: ${fmt(b)}\n`+(cash>0?`💳 К оплате переводом: ${fmt(cash)}`:'✅ Оплачено полностью бонусами'):`💰 Сумма: ${fmt(o.total)}`;
  return `Здравствуйте! 👋\n\nЗаказ на ${dlabel(o.for_date).replace(/^Завтра/,'завтра').replace(/^Сегодня/,'сегодня')}\n👤 ${o.customer_name}\n🏢 ${o.company_name} · ${o.department_name}\n\n${items(o).map(i=>'• '+i.name+' ×'+i.qty).join('\n')}\n\n${pay}\n\n`+(cash>0?'Отправляю чек 🧾':'Чек не требуется.')};
const waLink=o=>waNum()?'https://wa.me/'+waNum()+'?text='+encodeURIComponent(waText(o)):'#';
const stat=o=>isPaid(o)?`<span class="st p">Оплачен</span>`:`<span class="st c">Создан · ждёт оплаты</span>`;
const bonusRows=o=>{const b=o.bonus_used||0,e=Math.floor((o.total-b)*BONUS);
  return (b?`<div class="row mu"><span>💎 Оплачено бонусами</span><span>−${fmt(b)}</span></div>${o.total-b>0?`<div class="row mu"><span>Переводом</span><span>${fmt(o.total-b)}</span></div>`:''}`:'')+(e>0&&!o.manual?`<div style="margin-top:4px;font-size:14px">${isPaid(o)?`<span class="ok">+${fmt(e)} бонусов начислено</span>`:`<span class="mu">+${fmt(e)} бонусов будет начислено после оплаты</span>`}</div>`:'')};
const ph=f=>f.image_url?`<img class="ph" src="${esc(f.image_url)}" alt="" loading="lazy">`:`<div class="ph"></div>`;
const cartItems=()=>S.foods.filter(f=>S.cart[f.id]).map(f=>({id:f.id,name:f.name,price:+f.price,qty:S.cart[f.id]}));
function userView(){
  const p=S.profile,has=p.company_id&&p.department_id;
  if(S.step==='menu')return menuView();
  if(S.step==='pay')return payView();
  if(S.step==='edit')return editView();
  return `<p class="mu">Здравствуйте, ${esc(p.name)}</p>`+
  (has?`<div class="mu">🏢 ${esc(org(p))}</div>`:`<div class="warn">Выберите компанию и департамент в профиле (значок вверху справа)</div>`)+
  (isOpen()?'':`<div class="warn">Приём заказов ежедневно с 18:00 до 08:00. Сейчас заказ оформить нельзя.</div>`)+
  `<button class="btn pri" style="font-size:19px;padding:20px" onclick="showMenuBook()">📖 Меню</button>`+`<button class="btn pri" style="font-size:19px;padding:20px" ${has&&isOpen()?'':'disabled'} onclick="set({step:'menu',odate:orderDay()})">🍽 Заказать на ${orderDay()===today()?'сегодня':'завтра'}</button>`+teamView()+`<h2>Мои заказы</h2>`+(S.mine.length?S.mine.map(o=>`<div class="card ord ${isPaid(o)?'p':'c'}"><div class="row"><b>${dlabel(o.for_date)}</b>${stat(o)}</div>${items(o).map(i=>`<div class="row"><span>${esc(i.name)} × ${i.qty}</span><span>${fmt(i.price*i.qty)}</span></div>`).join('')}<div class="row"><b>Итого</b><b>${fmt(o.total)}</b></div>${bonusRows(o)}${!isPaid(o)?`<div class="row" style="margin-top:6px"><a class="btn sm pri" href="${waLink(o)}" target="_blank" rel="noopener">💬 Отправить чек</a>${o.for_date>=today()&&isOpen()?`<button class="btn sm" onclick="openEdit('${o.id}')">✏️ Изменить заказ</button>`:''}</div>`:''}</div>`).join(''):'<p class="mu">Заказов пока нет.</p>')}
function showMenuBook(){
  const p=S.profile,can=!!(p.company_id&&p.department_id&&isOpen());
  openMenuBook(S.foods.filter(f=>f.active!==false),{fmt,canOrder:can,note:'Заказ принимается ежедневно с 18:00 до 08:00',onOrder:()=>set({step:'menu',odate:orderDay()})});
}
function teamView(){
  const p=S.profile;if(!p.department_id)return '';
  const d=S.depts.find(x=>x.id===p.department_id);
  return `<div class="card"><b>Оплаченные заказы по департаментам</b> <span class="mu">· ${esc(dlabel(orderDay()))}</span>`+(S.team.length?`<div style="margin-top:10px"><b>${esc(d?d.name:'')}</b> <span class="mu">(${S.team.length})</span><ul style="margin:4px 0 0;padding-left:20px">${S.team.map(o=>`<li>${esc(o.customer_name)} — ${(o.items||[]).map(i=>esc(i.name)+' ×'+i.qty).join(', ')}</li>`).join('')}</ul></div>`:'<div class="mu" style="margin-top:10px">Оплаченных заказов нет</div>')+`</div>`}
async function cancelMine(id){
  if(!(await ask('Отменить заказ?')))return;
  const {error}=await sb.rpc('cancel_order',{p_id:id});if(error)return fail(error);
  await refreshUser();set({step:'home',edit:null});
}
function openEdit(id,adm){
  const o=(adm?S.orders:S.mine).find(x=>x.id===id);if(!o)return;const q={},lost=[];
  items(o).forEach(i=>{const f=S.foods.find(x=>x.name===i.name&&x.active!==false);if(f)q[f.id]=(q[f.id]||0)+i.qty;else lost.push(i.name)});
  set(Object.assign({edit:{id,q,d:o.for_date,adm:!!adm}},adm?{tab:'edit'}:{step:'edit'}));
  if(lost.length)tell('Этих блюд уже нет в меню, они будут убраны из заказа: '+lost.join(', '));
}
function eq(id,d){S.edit.q[id]=Math.max(0,(S.edit.q[id]||0)+d);render()}
function setEd(v){const E=S.edit;if(!v||(!E.adm&&v<today())){tell('Нельзя выбрать прошедшую дату');return render()}E.d=v;render()}
function editView(){
  const E=S.edit,o=E&&(E.adm?S.orders:S.mine).find(x=>x.id===E.id);
  const bk=E&&E.adm?`<button class="back" onclick="set({tab:'orders',edit:null})">← Назад</button>`:back('home');
  if(!o)return bk;
  const list=S.foods.filter(f=>f.active!==false);
  const grp=(t,l)=>{const l2=list.filter(f=>(f.kind||'food')===t);return l2.length?`<h2>${l}</h2>`+l2.map(f=>`<div class="item row"><div class="row" style="justify-content:flex-start;gap:12px">${ph(f)}<div><div>${esc(f.name)}</div><div class="mu">${fmt(f.price)}</div></div></div><div class="qty"><button onclick="eq('${f.id}',-1)">−</button><b>${E.q[f.id]||0}</b><button onclick="eq('${f.id}',1)">+</button></div></div>`).join(''):''};
  const n=list.reduce((s,f)=>s+(E.q[f.id]||0),0),tot=list.reduce((s,f)=>s+(E.q[f.id]||0)*f.price,0),b=Math.min(o.bonus_used||0,tot);
  const body=bk+`<h2>Изменить заказ</h2>${E.adm?`<div class="mu">${esc(o.customer_name)} · ${esc(o.department_name)}</div>`:''}
  <h2>Дата заказа</h2><input type="date" ${E.adm?'':`min="${today()}"`} value="${E.d}" onchange="setEd(this.value)"><div class="mu">${esc(dlabel(E.d))}</div>`
  +grp('food','Горячее')+grp('salad','Салаты')
  +`<div class="card"><div class="row"><b>Итого</b><b>${fmt(tot)}</b></div>${b?`<div class="row mu"><span>💎 Оплачено бонусами</span><span>−${fmt(b)}</span></div><div class="row mu"><span>Переводом</span><span>${fmt(tot-b)}</span></div>`:''}</div>
  <button class="btn" style="color:#c0392b" onclick="${E.adm?`delFromEdit('${o.id}')`:`cancelMine('${o.id}')`}">${E.adm?'Удалить заказ':'Отменить заказ'}</button>
  <div class="bar"><div><button class="btn pri" style="margin:0" ${n?'':'disabled'} onclick="saveEdit()">${n?`Сохранить · ${n} шт · ${fmt(tot)}`:'Выберите блюда'}</button></div></div>`;
  return E.adm?`<div style="max-width:560px;margin:0 auto">${body}</div>`:body}
async function saveEdit(){
  const E=S.edit,its=Object.entries(E.q).filter(([,q])=>q>0).map(([food_id,qty])=>({food_id,qty}));
  if(!its.length)return tell('Добавьте хотя бы одно блюдо или удалите/отмените заказ');
  const {error}=await sb.rpc(E.adm?'admin_update_order':'update_order',{p_id:E.id,p_items:its,p_date:E.d});if(error)return fail(error);
  if(E.adm){await refreshAdmin();await refreshUser();set({tab:'orders',adate:E.d,edit:null})}
  else{await refreshUser();set({step:'home',edit:null})}
}
async function delFromEdit(id){if(!(await ask('Удалить заказ?')))return;const {error}=await sb.rpc('admin_delete_order',{p_id:id});if(error)return fail(error);await refreshAdmin();set({tab:'orders',edit:null})}
function menuView(){
  const list=S.foods.filter(f=>f.active!==false);
  const grp=(t,l)=>{const l2=list.filter(f=>(f.kind||'food')===t);return l2.length?`<h2>${l}</h2>`+l2.map(f=>`<div class="item row"><div class="row" style="justify-content:flex-start;gap:12px">${ph(f)}<div><div>${esc(f.name)}</div><div class="mu">${fmt(f.price)}</div></div></div><div class="qty"><button onclick="chg('${f.id}',-1)">−</button><b>${S.cart[f.id]||0}</b><button onclick="chg('${f.id}',1)">+</button></div></div>`).join(''):''};
  const n=cartItems().reduce((s,i)=>s+i.qty,0),tot=cartItems().reduce((s,i)=>s+i.qty*i.price,0);
  return back('home')+`<h2>Дата заказа</h2><input type="date" min="${today()}" value="${S.odate}" onchange="setOdate(this.value)"><div class="mu">${esc(dlabel(S.odate))}</div>`+grp('food','Горячее')+grp('salad','Салаты')+(list.length?'':'<p class="mu">Меню пока пусто.</p>')+
  `<div class="bar"><div><button class="btn pri" style="margin:0" ${n&&isOpen()?'':'disabled'} onclick="set({step:'pay'})">${n?`К оплате · ${n} шт · ${fmt(tot)}`:'Выберите блюда'}</button></div></div>`}
function setOdate(v){if(!v||v<today()){tell('Нельзя выбрать прошедшую дату');S.odate=orderDay()}else S.odate=v;render()}
function chg(id,d){S.cart[id]=Math.max(0,(S.cart[id]||0)+d);render()}
function payView(){
  const it=cartItems(),tot=it.reduce((s,i)=>s+i.qty*i.price,0),num=S.settings.pay_phone,bal=S.bonus;
  const bu=S.useBonus?Math.min(bal,tot):0,cash=tot-bu;
  return back('menu')+`<h2>Оплата</h2><div class="card"><div class="row mu"><span>Заказ на</span><span>${esc(dlabel(S.odate))}</span></div>${it.map(i=>`<div class="row"><span>${esc(i.name)} × ${i.qty}</span><span>${fmt(i.price*i.qty)}</span></div>`).join('')}<div class="row"><b>Итого</b><b>${fmt(tot)}</b></div>${bu?`<div class="row"><span>💎 Бонусами</span><span>−${fmt(bu)}</span></div><div class="row"><b>К переводу</b><b>${fmt(cash)}</b></div>`:''}</div>
  ${bal>0?`<label class="card row" style="cursor:pointer"><span>💎 Оплатить бонусами<br><span class="mu">Доступно: ${fmt(bal)}</span></span><input type="checkbox" ${S.useBonus?'checked':''} onchange="set({useBonus:this.checked})" style="width:24px;height:24px;margin:0"></label>`:''}
  ${cash>0?`<div class="card"><div class="mu">Переведите <b>${fmt(cash)}</b> через Kaspi, Halyk или Freedom Bank на номер:</div><div style="font-size:26px;font-weight:700;margin:8px 0">${esc(num||'—')}</div>${num?`<button class="btn sm" onclick="copyNum()">Скопировать номер</button>`:''}</div>
  ${num?'':'<div class="warn">Номер для оплаты ещё не указан. Обратитесь к администратору.</div>'}
  <p class="mu">После нажатия «Заказать» заказ появится на главной. Оплатите и нажмите «Отправить чек» рядом с заказом, чтобы отправить чек в WhatsApp. Статус станет «Оплачен», когда администратор проверит оплату.</p>`:`<p class="mu">Заказ будет полностью оплачен бонусами, чек не нужен.</p>`}
  <button class="btn pri" ${(cash===0||num)&&it.length?'':'disabled'} onclick="send()">${cash>0?'Заказать':'Заказать за бонусы'}</button>`}
async function copyNum(){try{await navigator.clipboard.writeText(S.settings.pay_phone);tell('Номер скопирован')}catch(e){tell('Выделите номер и скопируйте вручную')}}
async function send(){
  if(S.odate<today())return tell('Нельзя заказать на прошедшую дату');
  const {error}=await sb.rpc('place_order',{p_items:cartItems().map(i=>({food_id:i.id,qty:i.qty})),p_use_bonus:S.useBonus,p_date:S.odate});
  if(error)return fail(error);
  await refreshUser();
  set({step:'home',cart:{},useBonus:false});
}

/* ---------- админка ---------- */
function adminView(){
  const T=[['orders','📋 Заказы'],['stats','📊 Аналитика'],['new','➕ Новый заказ'],['menu','🍲 Меню'],['clients','👥 Клиенты'],['set','⏰ Настройки'],['org','🏢 Компании']];
  return `<div class="tabs">${T.map(([k,l])=>`<button class="tab ${S.tab===k||(k==='clients'&&S.tab==='cedit')?'on':''}" onclick="set({tab:'${k}'})">${l}</button>`).join('')}</div>`+({orders:aOrders,stats:aStats,new:aNew,menu:aMenu,clients:aClients,set:aSet,org:aOrg,edit:editView,cedit:clientEdit}[S.tab])()}
async function adminRefresh(){await refreshAdmin();render()}
function ocard(o){return `<div class="oc" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','${o.id}')"><div><b>${esc(o.customer_name)}</b> <span class="mu">${esc(o.department_name)}${o.customer_phone?' · '+esc(showPhone(o.customer_phone)):''}</span></div><div>${items(o).map(i=>esc(i.name)+' ×'+i.qty).join(', ')}</div><div><b>${fmt(o.total)}</b>${o.bonus_used?` <span class="mu">· 💎 ${fmt(o.bonus_used)} бонусами, переводом ${fmt(o.total-o.bonus_used)}</span>`:''}</div><div><button class="btn sm" onclick="setSt('${o.id}','${isPaid(o)?'created':'paid'}')">${isPaid(o)?'← Создан':'→ Оплачен'}</button><button class="btn sm" onclick="openEdit('${o.id}',true)">Изменить</button></div></div>`}
function aOrders(){
  const os=S.orders.filter(o=>o.for_date===S.adate).sort((a,b)=>a.created_at.localeCompare(b.created_at));
  const cr=os.filter(o=>!isPaid(o)),pd=os.filter(isPaid);
  const col=(t,k,l,c)=>`<div class="col" ondragover="event.preventDefault()" ondrop="event.preventDefault();setSt(event.dataTransfer.getData('text/plain'),'${k}')"><h2 style="color:${c}">${t} <span class="mu">(${l.length})</span></h2>${l.map(ocard).join('')||'<div class="mu">Пусто</div>'}</div>`;
  const byD={};pd.forEach(o=>(byD[o.department_name]=byD[o.department_name]||[]).push(o));
  const dish={};pd.forEach(o=>items(o).forEach(i=>{const d=dish[i.name]=dish[i.name]||{q:0,sum:0};d.q+=i.qty;d.sum+=i.qty*i.price}));
  const rows=Object.entries(dish),tq=rows.reduce((s,[,d])=>s+d.q,0),ts=rows.reduce((s,[,d])=>s+d.sum,0),sp=split(ts);
  return `<input type="date" value="${S.adate}" onchange="set({adate:this.value})" style="max-width:220px">
  <div class="board">${col('🟠 Создан','created',cr,'var(--or)')}${col('🟢 Оплачен','paid',pd,'var(--ok)')}</div>
  <p class="mu">Перетащите заказ в «Оплачен» после проверки чека (или нажмите кнопку на карточке).</p>
  <div class="card"><b>Оплаченные заказы по департаментам</b> <span class="mu">· ${esc(dlabel(S.adate))}</span>${Object.entries(byD).map(([d,l])=>`<div style="margin-top:10px"><b>${esc(d)}</b> <span class="mu">(${l.length})</span><ul style="margin:4px 0 0;padding-left:20px">${l.map(o=>`<li>${esc(o.customer_name)} — ${items(o).map(i=>esc(i.name)+' ×'+i.qty).join(', ')}</li>`).join('')}</ul></div>`).join('')||'<div class="mu">Оплаченных заказов нет</div>'}</div>
  <div class="card"><table class="tb"><thead><tr><th>Блюдо на ${esc(dlabel(S.adate).replace(/^(Завтра|Сегодня), /,''))}</th><th class="n">Порций</th><th class="n">Сумма</th></tr></thead><tbody>${rows.map(([n,d])=>`<tr><td>${esc(n)}</td><td class="n">${d.q}</td><td class="n">${fmt(d.sum)}</td></tr>`).join('')||'<tr><td colspan="3" class="mu">Нет данных</td></tr>'}</tbody><tfoot><tr><td>Итого</td><td class="n">${tq}</td><td class="n">${fmt(ts)}</td></tr><tr><td style="font-weight:400">Владельцу · 90%</td><td></td><td class="n" style="font-weight:400">${fmt(sp.o)}</td></tr><tr><td style="font-weight:400">Моя доля · 5%</td><td></td><td class="n" style="font-weight:400">${fmt(sp.m)}</td></tr><tr><td style="font-weight:400">Резерв на бонусы · 5%</td><td></td><td class="n" style="font-weight:400">${fmt(sp.r)}</td></tr></tfoot></table></div>`}
async function setSt(id,status){
  const o=S.orders.find(x=>x.id===id);if(!o||o.status===status)return;
  const prev={status:o.status,paid_at:o.paid_at};
  o.status=status;o.paid_at=status==='paid'?new Date().toISOString():null;render(); // сразу показываем результат
  S.pend=(S.pend||0)+1;
  const {error}=await sb.rpc('set_order_status',{p_id:id,p_status:status});
  S.pend--;
  if(error){o.status=prev.status;o.paid_at=prev.paid_at;render();return fail(error)}
}
function aStats(){
  const days={};S.orders.filter(isPaid).forEach(o=>{const d=days[o.for_date]=days[o.for_date]||{n:0,sum:0,b:0};d.n++;d.sum+=o.total;d.b+=o.bonus_used||0});
  const rows=Object.entries(days).sort((a,b)=>b[0].localeCompare(a[0])).map(([k,d])=>({k,...d,...split(d.sum)}));
  const T=rows.reduce((t,d)=>({n:t.n+d.n,sum:t.sum+d.sum,b:t.b+d.b,o:t.o+d.o,m:t.m+d.m,r:t.r+d.r}),{n:0,sum:0,b:0,o:0,m:0,r:0});
  const tr=(l,d)=>`<tr><td>${l}</td><td class="n">${d.n}</td><td class="n">${fmt(d.sum)}</td><td class="n">${fmt(d.o)}</td><td class="n">${fmt(d.m)}</td><td class="n">${fmt(d.r)}</td><td class="n">${fmt(d.b)}</td><td class="n">${fmt(d.sum-d.b)}</td></tr>`;
  return `<div class="card scroll"><b>Выручка по дням</b><p class="mu" style="margin:4px 0">Только оплаченные заказы за последние 120 дней. 90% — владельцу, 5% — ваша доля, 5% — резерв на бонусы.</p><table class="tb" style="min-width:760px;white-space:nowrap"><thead><tr><th>День</th><th class="n">Заказов</th><th class="n">Выручка</th><th class="n">90%</th><th class="n">5%</th><th class="n">5%</th><th class="n">Бонусами</th><th class="n">Деньгами</th></tr></thead><tbody>${rows.map(d=>tr(esc(dlabel(d.k)),d)).join('')||'<tr><td colspan="8" class="mu">Нет данных</td></tr>'}</tbody><tfoot>${tr('Итого',T)}</tfoot></table></div>`}
const clRow=a=>`<div class="row"><div><b>${esc(a.name)}</b><div class="mu">${esc(showPhone(a.phone))}${a.company_name?' · '+esc(a.company_name):''}${a.department_name?' · '+esc(a.department_name):''}</div></div><span class="mu" style="white-space:nowrap">💎 ${fmt(a.bonus||0)}</span></div>`;
function clientList(){
  const q=S.nd.s.trim().toLowerCase();let d=q.replace(/\D/g,'');if(d[0]==='8')d='7'+d.slice(1);
  if(!q)return '<div class="mu">Начните вводить имя или телефон клиента</div>';
  const m=S.clients.filter(a=>a.name.toLowerCase().includes(q)||(d&&a.phone.includes(d)));
  return (m.slice(0,8).map(a=>`<button class="btn" style="padding:10px 12px;margin:4px 0" onclick="pickClient('${a.id}')">${clRow(a)}</button>`).join('')||'<div class="mu">Клиент не найден. Он должен сначала зарегистрироваться на сайте.</div>')+(m.length>8?'<div class="mu">Показаны первые 8, уточните поиск</div>':'')}
function pickClient(id){S.nd.c=id;render()}
function aNew(){
  const D=S.nd,fs=S.foods.filter(f=>f.active!==false),tot=fs.reduce((t,f)=>t+(D.q[f.id]||0)*f.price,0),a=S.clients.find(x=>x.id===D.c);
  return `<div class="card"><b>Новый заказ</b><div class="mu" style="margin:4px 0 8px">Только для зарегистрированных клиентов: им начисляются бонусы. Заказ сразу создаётся оплаченным.</div>
  ${a?`<div style="border:1px solid var(--ac);border-radius:12px;padding:10px">${clRow(a)}<button class="btn sm" style="margin:8px 0 0" onclick="S.nd.c='';render()">Сменить клиента</button></div>`:`<input placeholder="Поиск клиента: имя или телефон" value="${esc(D.s)}" oninput="S.nd.s=this.value;$('#cl').innerHTML=clientList()"><div id="cl">${clientList()}</div>`}
  <div class="mu" style="margin-top:8px">Дата заказа</div><input type="date" value="${D.dt}" onchange="S.nd.dt=this.value"></div>
  <div class="card"><b>Блюда</b>${fs.map(f=>`<div class="item row"><div class="row" style="justify-content:flex-start;gap:12px">${ph(f)}<div><div>${esc(f.name)}</div><div class="mu">${fmt(f.price)}</div></div></div><div class="qty"><button onclick="ndq('${f.id}',-1)">−</button><b>${D.q[f.id]||0}</b><button onclick="ndq('${f.id}',1)">+</button></div></div>`).join('')||'<div class="mu">Меню пусто</div>'}</div>
  <button class="btn pri" onclick="manual()">Создать заказ${tot?' · '+fmt(tot):''}</button>`}
function ndq(id,d){S.nd.q[id]=Math.max(0,(S.nd.q[id]||0)+d);render()}
async function manual(){
  const D=S.nd,its=S.foods.filter(f=>D.q[f.id]>0).map(f=>({food_id:f.id,qty:D.q[f.id]}));
  if(!D.c||!D.dt||!its.length)return tell('Выберите клиента, дату и блюда');
  const {error}=await sb.rpc('admin_create_order',{p_user:D.c,p_items:its,p_date:D.dt});if(error)return fail(error);
  const nd=D.dt;S.nd={c:'',s:'',q:{},dt:orderDay()};await refreshAdmin();await tell('Заказ создан');set({tab:'orders',adate:nd});
}
function shrink(file,max=900){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>{const im=new Image();im.onload=()=>{const k=Math.min(1,max/Math.max(im.width,im.height)),c=document.createElement('canvas');c.width=Math.round(im.width*k);c.height=Math.round(im.height*k);c.getContext('2d').drawImage(im,0,0,c.width,c.height);c.toBlob(b=>b?res(b):rej(new Error('Не удалось обработать фото')),'image/jpeg',.8)};im.onerror=()=>rej(new Error('Не удалось прочитать фото'));im.src=r.result};r.onerror=rej;r.readAsDataURL(file)})}
async function uploadPhoto(file){const blob=await shrink(file),path=crypto.randomUUID()+'.jpg';
  const {error}=await sb.storage.from('food').upload(path,blob,{contentType:'image/jpeg'});if(error)throw error;
  return sb.storage.from('food').getPublicUrl(path).data.publicUrl}
function pickImg(id){const i=document.createElement('input');i.type='file';i.accept='image/*';i.onchange=async()=>{if(!i.files[0])return;try{const url=await uploadPhoto(i.files[0]);await upd('foods',id,{image_url:url})}catch(e){fail(e)}};i.click()}
async function upd(t,id,o){const {error}=await sb.from(t).update(o).eq('id',id);if(error)return fail(error);await loadCatalog();render()}
async function del(t,id){if(!(await ask('Удалить?')))return;const {error}=await sb.from(t).delete().eq('id',id);if(error)return fail(error);await loadCatalog();render()}
function aMenu(){return `<div class="card"><b>Добавить блюдо</b><input id="fn" placeholder="Название"><input id="fp" type="number" placeholder="Цена, ₸"><select id="ft"><option value="food">Горячее</option><option value="salad">Салат</option></select><div class="mu" style="margin-top:6px">Фото (необязательно)</div><input id="ff" type="file" accept="image/*"><button class="btn pri" onclick="addFood()">Добавить</button></div>`+
  S.foods.map(f=>`<div class="card row" style="flex-wrap:wrap"><div class="row" style="justify-content:flex-start;gap:12px">${ph(f)}<div>${esc(f.name)}<div class="mu">${fmt(f.price)} · ${f.kind==='salad'?'салат':'горячее'}${f.active===false?' · скрыто':''}</div></div></div><div><button class="btn sm" onclick="pickImg('${f.id}')">📷 Фото</button><button class="btn sm" onclick="editFood('${f.id}')">Цена</button><button class="btn sm" onclick="upd('foods','${f.id}',{active:${f.active===false}})">${f.active===false?'Показать':'Скрыть'}</button><button class="btn sm" onclick="del('foods','${f.id}')">✕</button></div></div>`).join('')}
async function addFood(){const n=val('fn'),p=+val('fp'),f=$('#ff').files[0];if(!n||!p)return tell('Название и цена');
  try{const d={name:n,price:p,kind:$('#ft').value,active:true};if(f)d.image_url=await uploadPhoto(f);const {error}=await sb.from('foods').insert(d);if(error)throw error;await loadCatalog();render()}catch(e){fail(e)}}
async function editFood(id){const f=S.foods.find(x=>x.id===id),p=await prm('Новая цена, ₸',f.price);if(p&&+p>0)upd('foods',id,{price:+p})}
function aClients(){
  const list=S.clients;
  return `<div class="card"><b>Клиенты</b> <span class="mu">(${list.length})</span><p class="mu" style="margin:4px 0">Нажмите «Изменить»: имя, телефон, компания, бонусы, права админа, пароль, удаление.</p>`+(list.map(a=>`<div class="item row"><div><div><b>${esc(a.name)}</b>${a.is_admin?' <span class="st p">Админ</span>':''}</div><div class="mu">${esc([a.phone?showPhone(a.phone):'',a.company_name,a.department_name].filter(Boolean).join(' · '))}</div><div class="mu">💎 ${fmt(a.bonus||0)}</div></div><button class="btn sm" onclick="openClient('${a.id}')">✏️ Изменить</button></div>`).join('')||'<p class="mu">Клиентов пока нет.</p>')+`</div>`}
function openClient(id){
  const a=S.clients.find(x=>x.id===id);if(!a)return;
  set({tab:'cedit',ce:{id,n:a.name,p:a.phone?showPhone(a.phone):'',c:a.company_id||'',d:a.department_id||'',b:String(a.bonus||0),adm:!!a.is_admin,orig:{bonus:a.bonus||0}}});
}
function clientEdit(){
  const E=S.ce,a=E&&S.clients.find(x=>x.id===E.id),bk=`<button class="back" onclick="set({tab:'clients',ce:null})">← Назад</button>`;
  if(!a)return bk;const me=a.id===S.profile.id;
  return `<div style="max-width:560px;margin:0 auto">${bk}<h2>Изменить клиента</h2>
  <div class="card"><div class="mu">Имя — по нему клиент входит</div><input value="${esc(E.n)}" oninput="S.ce.n=this.value"><div class="mu" style="margin-top:8px">Номер телефона</div><input type="tel" placeholder="не указан" value="${esc(E.p)}" oninput="S.ce.p=this.value"></div>
  <div class="card"><b>Откуда заказывает</b>${orgPicker(E,'S.ce')}</div>
  <div class="card"><b>Бонусы</b><div class="mu">Сейчас на счёте: ${fmt(E.orig.bonus)}. Впишите, сколько должно стать.</div><input type="number" inputmode="numeric" min="0" value="${esc(E.b)}" oninput="S.ce.b=this.value"></div>
  <div class="card"><div class="row"><div><b>Доступ в админку</b>${me?'<div class="mu">Со своего аккаунта права снять нельзя</div>':''}</div><input type="checkbox" class="sw" ${E.adm?'checked':''} ${me?'disabled':''} onchange="S.ce.adm=this.checked"></div></div>
  <button class="btn pri" onclick="saveClient()">Сохранить</button>
  <button class="btn" onclick="resetPw('${a.id}')">Сбросить пароль</button>
  ${me?'':`<button class="btn" style="color:#c0392b" onclick="delClient('${a.id}')">Удалить пользователя</button>`}</div>`}
async function saveClient(){
  const E=S.ce,name=E.n.trim().replace(/\s+/g,' '),ph=E.p.trim()?normPhone(E.p):'';
  if(!name)return tell('Введите имя');
  if(ph&&!/^7\d{10}$/.test(ph))return tell('Номер телефона введён не полностью (или оставьте поле пустым)');
  if(!E.c||!E.d)return tell('Выберите компанию и департамент');
  if(E.b!==''&&!(+E.b>=0))return tell('Бонусы — число, 0 или больше');
  const {error}=await sb.rpc('admin_update_client',{p_id:E.id,p_name:name,p_phone:ph,p_company:E.c,p_dept:E.d,p_bonus:E.b===''?null:Math.round(+E.b),p_admin:E.adm});
  if(error)return fail(error);
  await refreshAdmin();await refreshUser();set({tab:'clients',ce:null});tell('Сохранено');
}
async function delClient(id){
  const a=S.clients.find(x=>x.id===id);
  if(!(await ask('Удалить пользователя «'+(a?a.name:'')+'»? Его заказы останутся в истории, но вход и бонусы пропадут. Отменить нельзя.')))return;
  const {error}=await sb.rpc('admin_delete_user',{p_id:id});if(error)return fail(error);
  await refreshAdmin();set({tab:'clients',ce:null});
}
async function resetPw(id){
  const a=S.clients.find(x=>x.id===id),p=await prm('Новый пароль для '+(a?a.name:'')+' (от 1 символа):','');
  if(!p)return;const {error}=await sb.rpc('admin_reset_password',{p_id:id,p_password:pw(p)});
  if(error)return fail(error);tell('Пароль изменён. Сообщите его человеку.');
}
function aSet(){const s=S.settings;return `<div class="card"><b>Оплата</b><p class="mu">Номер Kaspi / Halyk / Freedom Bank, на который переводят деньги, и номер WhatsApp для чеков (если пусто, берётся первый).</p><input id="sp" type="tel" placeholder="Номер для перевода, 87771112233" value="${esc(s.pay_phone||'')}"><input id="sw" type="tel" placeholder="Номер WhatsApp (если другой)" value="${esc(s.wa_phone||'')}"><button class="btn pri" onclick="savePay()">Сохранить</button></div>
<div class="card"><b>Приём заказов</b><p class="mu">Обычно с 18:00 до 08:00 по времени Астаны. Для проверки можно открыть приём в любое время.</p><button class="btn pri" onclick="saveSetting({any_time:${!s.any_time}})">${s.any_time?'Вернуть 18:00–08:00':'Открыть в любое время (тест)'}</button></div>`}
async function saveSetting(o){const {error}=await sb.from('settings').update(o).eq('id',1);if(error)return fail(error);await loadCatalog();render()}
async function savePay(){await saveSetting({pay_phone:val('sp'),wa_phone:val('sw')});tell('Сохранено')}
function aOrg(){return `<div class="card"><b>Новая компания</b><input id="cn" placeholder="Название, например ЦЭФ"><button class="btn pri" onclick="addCo()">Добавить компанию</button></div>`+
  S.companies.map(c=>`<div class="card"><div class="row"><b>${esc(c.name)}</b><button class="btn sm" onclick="delCo('${c.id}')">Удалить</button></div>${S.depts.filter(d=>d.company_id===c.id).map(d=>`<div class="row item"><span>${esc(d.name)}</span><button class="btn sm" onclick="del('departments','${d.id}')">✕</button></div>`).join('')}<input id="d_${c.id}" placeholder="Новый департамент"><button class="btn sm" onclick="addDept('${c.id}')">+ Добавить департамент</button></div>`).join('')}
async function addCo(){const n=val('cn');if(!n)return;const {error}=await sb.from('companies').insert({name:n});if(error)return fail(error);await loadCatalog();render()}
async function addDept(cid){const n=val('d_'+cid);if(!n)return;const {error}=await sb.from('departments').insert({company_id:cid,name:n});if(error)return fail(error);await loadCatalog();render()}
async function delCo(id){if(!(await ask('Удалить компанию и её департаменты?')))return;const {error}=await sb.from('companies').delete().eq('id',id);if(error)return fail(error);await loadCatalog();render()}

boot();
