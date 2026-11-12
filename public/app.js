'use strict';
const icons = {
 grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
 people:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
 layers:'<path d="m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5"/>',
 activity:'<path d="M3 12h4l3-8 4 16 3-8h4"/>',
 plug:'<path d="M8 3v5M16 3v5M5 8h14v3a7 7 0 0 1-14 0zM12 18v4"/>',
 settings:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="currentColor"/><circle cx="15" cy="17" r="3" fill="currentColor"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',
 arrow:'<path d="M5 12h14M13 6l6 6-6 6"/>',
 refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 2M18 18A8 8 0 0 1 5 16"/>',
 shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-5"/>',
 pause:'<path d="M8 5v14M16 5v14"/>',play:'<path d="m8 4 12 8-12 8z"/>',
 edit:'<path d="m14 5 5 5M4 20l5-1L20 8a3.5 3.5 0 0 0-5-5L4 14z"/>',
 key:'<circle cx="8" cy="9" r="5"/><path d="m12 13 8 8M16 17l3-3M19 20l3-3"/>',
 lock:'<rect x="4" y="10" width="16" height="12" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
 check:'<path d="m5 12 4 4L19 6"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',
 copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
 server:'<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
 logout:'<path d="M9 4H4v16h5M10 12h11M17 8l4 4-4 4"/>',
 info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
 external:'<path d="M14 3h7v7M21 3 10 14M10 3H3v18h18v-7"/>',
 trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
 upload:'<path d="M12 16V3M7 8l5-5 5 5M4 16v5h16v-5"/>',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.info}</svg>`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct = value => `${Math.round(Number(value) * 10) / 10}%`;
const switchWindowLabel = member => ({hourly:'Hourly session',weekly:'Weekly',both:'Hourly or weekly'}[member.personalSwitchWindow??'both']);
const count = value => Number(value || 0).toLocaleString();
const age = time => !time ? 'Not checked yet' : Date.now()-time<60000 ? 'Just now' : `${Math.floor((Date.now()-time)/60000)} min ago`;
const reset = time => { const mins = Math.ceil((time-Date.now())/60000); if(mins<=0)return 'Awaiting reset';return mins<60?`Resets in ${mins}m`:mins<1440?`Resets in ${Math.floor(mins/60)}h ${mins%60}m`:`Resets in ${Math.floor(mins/1440)}d ${Math.floor(mins%1440/60)}h`; };
const tabs = [['overview','grid','Overview'],['people','people','People'],['accounts','layers','Accounts'],['activity','activity','Activity'],['reviews','shield','Reviews'],['connect','plug','Connect T3 Code'],['settings','settings','Settings']];
const basePath = new URL(document.currentScript.src).pathname.replace(/\/app\.js$/, '');
const memberView = location.pathname === `${basePath}/me` || location.pathname === `${basePath}/me/`;
let state = null, session = null, page = location.hash.slice(1).split('?')[0] || 'overview', loading = false, secretKey = '', oauth = null;
const app = document.querySelector('#app'), modal = document.querySelector('#modal');
let toastTimer;
let reviewTab='pending', notifications=null, notificationsLoading=false;
const reviewIdFromHash=()=>new URLSearchParams(location.hash.split('?')[1]||'').get('review');
let lastRefreshAt = 0;
const activityFilters = { search: '', person: '', account: '', result: '', model: '', provider: '', route: '', endpoint: '', time: '' };
let activityPage = null, activityController = null, activityTimer, activityVersion = 0, activityLoading = false;
const activityPaging = { offset: 0, limit: 100, snapshot: null };
function toast(message, error=false) { const el=document.querySelector('#toast');el.textContent=message;el.className=`show${error?' error':''}`;clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.className='',5000); }
async function api(path, options={}) {
  const response=await fetch(`${basePath}/api${path}`,{...options,headers:{'Content-Type':'application/json',...(session?.csrf?{'X-CSRF-Token':session.csrf}:{}),...options.headers},...(options.body?{body:JSON.stringify(options.body)}:{})});
  const result=await response.json();if(!response.ok){if(response.status===401&&session?.authenticated&&!path.endsWith('/login')){session.authenticated=false;state=null;renderLogin();}throw new Error(result.error?.message||'Request failed');}return result;
}
async function load(silent=false) {
  if(loading)return;loading=true;
  try {
    state=await api(memberView?'/member/state':'/state');
    session.csrf=state.csrf;lastRefreshAt=Date.now();
    const drafts=[...document.querySelectorAll('form[data-dirty]')].map(form=>[form.id,form]);
    render();
    for(const [id,draft] of drafts)document.getElementById(id)?.replaceWith(draft);
  } catch(error) { if(!silent)toast(error.message,true); } finally { loading=false; }
}
function brand(){return '<div class="brand"><span class="brand-mark">v</span>vibe<span class="brand-tag">HUB</span></div>';}
function renderLogin(){
 app.innerHTML=`<main class="login-screen"><div class="login-card">${brand()}<h1>${memberView?'Your access':'Admin sign-in'}</h1><form id="login-form"><div class="field"><label for="admin-key">${memberView?'Access key':'Password'}</label><input id="admin-key" name="token" type="password" required autocomplete="current-password" placeholder="${memberView?'vcp_…':'Password'}"></div><div id="login-error" class="session-error" role="alert"></div><button class="primary" type="submit">Sign in ${icon('arrow')}</button></form><p class="login-note">${icon('lock')} Tailscale access required.</p></div></main>`;
}
function render(){
 if(!state)return;
 if(memberView){renderMember();return;}
 if(!tabs.some(t=>t[0]===page))page='overview';
 const current=tabs.find(t=>t[0]===page), healthy=!state.proxy.error, name=new URL(state.publicBaseUrl).hostname.split('.')[0];
 app.innerHTML=`<div class="layout"><aside class="sidebar">${brand()}<div class="workspace"><div class="workspace-icon">${icon('server')}</div><div><b>${escape(name)}</b><span>Personal workspace</span></div><i class="dot ${healthy?'':'warn'}"></i></div><div class="nav-label">Workspace</div><nav aria-label="Main navigation">${tabs.map(([id,i,label])=>`<button data-page="${id}" class="${page===id?'active':''}" ${page===id?'aria-current="page"':''}>${icon(i)}${label}${id==='people'?`<span class="nav-count">${state.members.length}</span>`:id==='reviews'&&state.reviews?.pendingCount?`<span class="nav-count">${count(state.reviews.pendingCount)}</span>`:''}</button>`).join('')}</nav><div class="sidebar-bottom"><div class="host-note">${icon('lock')} Tailscale only</div><div class="identity"><span class="avatar">N</span><div><b>Your workspace</b><span>Administrator</span></div><button class="ghost icon-button" data-action="logout" aria-label="Sign out">${icon('logout')}</button></div></div></aside><main class="main"><header class="topbar"><div class="breadcrumb">Workspace<span>/</span><b>${current[2]}</b></div><div class="top-actions"><span class="status-pill"><i class="dot ${state.settings.paused?'warn':healthy?'':'warn'}"></i>${state.settings.paused?'Sharing paused':healthy?'Hub online':'Needs attention'}</span><button class="ghost small" data-action="refresh" aria-label="Refresh hub">${icon('refresh')}<span>Refresh</span></button></div></header><div class="content">${state.proxy.error?`<div class="alert">${icon('info')}${escape(state.proxy.error)}</div>`:''}${state.settings.paused?`<div class="alert">${icon('pause')}Backup access paused.<button class="small ghost" data-action="toggle-global">Resume</button></div>`:''}${renderPage()}<footer class="footer"><span>${icon('shield')} Private hub</span><span>${icon('server')} Hosted on ${escape(name)} <span>·</span> Quota checked ${age(state.proxy.lastSync).toLowerCase()}</span></footer></div></main></div>`;
 if(page==='activity')void loadActivity();
 else {activityController?.abort();clearTimeout(activityTimer);}
 if(page==='settings'&&!notifications&&!notificationsLoading)void loadNotifications();
}
function heading(eyebrow,title,subtitle,actions=''){return `<div class="page-heading"><div><h1>${title}</h1>${subtitle?`<p class="subtext">${subtitle}</p>`:''}</div>${actions?`<div class="heading-actions">${actions}</div>`:''}</div>`;}
function metric(label,value,foot,i){return `<div class="metric"><div class="metric-top">${label}${icon(i)}</div><div class="metric-value">${value}</div><div class="metric-foot">${foot}</div></div>`;}
function allocation(value=20){return `<div class="allocation-intro"><div class="allocation-number">${Math.round(value)}<small>%</small></div><div class="allocation-label">shared usage ceiling<br>for each account</div></div><div class="segmented-bar" role="img" aria-label="${value}% shared ceiling, ${100-value}% protected reserve"><div class="shared" style="width:${value}%"></div></div><div class="allocation-legend"><span class="legend-item"><i class="swatch"></i>Shared ceiling · <b data-share-label>${pct(value)}</b></span><span class="legend-item"><i class="swatch reserve"></i>Protected for you · <b data-reserve-label>${pct(100-value)}</b></span></div>`;}
function renderPage(){
 switch(page){case 'people':return renderPeople();case 'accounts':return renderAccounts();case 'activity':return renderActivity();case 'reviews':return renderReviews();case 'connect':return renderConnect();case 'settings':return renderSettings();default:return renderOverview();}
}
function renderOverview(){
 const enabled=state.members.filter(m=>!m.paused&&(!m.expiresAt||m.expiresAt>Date.now())), ready=state.accounts.filter(a=>!a.error&&a.enabled&&a.available&&a.windows.length&&Date.now()-a.checkedAt<=120000&&a.windows.every(w=>w.resetsAt>Date.now())), share=state.members[0]?.sharePercent??20;
 return heading('A LITTLE ACCESS. A LOT OF POSSIBILITY.','Overview','',`<button data-action="toggle-global">${icon(state.settings.paused?'play':'pause')}${state.settings.paused?'Resume sharing':'Pause sharing'}</button><button class="primary" data-action="add-person">${icon('plus')}Add a person</button>`)+
 `<section class="metrics" aria-label="Hub statistics">${metric('Connected accounts',`${state.accounts.length}<small>accounts</small>`,`<span class="green">${ready.length} reporting quota</span> · Codex & Claude`,'layers')}${metric('People with access',count(enabled.length),`${state.members.length} ${state.members.length===1?'person':'people'} in your workspace`,'people')}${metric('Requests · last 24h',count(state.summary.today.requests),`${count(state.summary.today.successful)} completed successfully`,'activity')}${metric('Reserve protections',count(state.summary.today.blocked),'Requests stopped by sharing controls','shield')}</section>`+
 `<div class="overview-grid"><section class="card"><div class="card-head"><div><h2>Shared ceiling</h2><p>${state.members.length?`Usage ceiling for ${escape(state.members[0].name)}`:'Default for new people'}</p></div><span class="tag green">${icon('shield')} RESERVE PROTECTED</span></div><div class="card-pad" style="padding-top:8px">${allocation(share)}<div class="reserve-note">${icon('shield')}<span>Backup stops at ${pct(share)} total usage. Your usage counts too.</span></div><div class="quick-links"><button class="small ghost" data-action="${state.members.length?'edit-first':'add-person'}">${state.members.length?'Adjust this ceiling':'Set up shared access'} ${icon('arrow')}</button></div></div></section><section class="card"><div class="card-head"><div><h2>Requests</h2><p>Last 24 hours</p></div><span class="tag">24 HOURS</span></div>${renderChart()}</section><section class="card full-width"><div class="card-head"><div><h2>People</h2><p></p></div><button class="ghost small" data-page="people">Manage people ${icon('arrow')}</button></div>${state.members.length?state.members.slice(0,3).map(personRow).join(''):peopleEmpty()}</section></div><section class="section-gap"><div class="section-title"><h2>Accounts</h2><button class="ghost small" data-page="accounts">View accounts ${icon('arrow')}</button></div>${state.accounts.length?`<div class="account-grid">${state.accounts.slice(0,2).map(accountCard).join('')}</div>`:accountEmpty()}</section>`;
}
function renderChart(){
 const end=Math.floor(Date.now()/3600000)*3600000, buckets=Array.from({length:24},(_,i)=>{const h=end-(23-i)*3600000;return {hour:h,requests:Number(state.summary.hourly.find(x=>x.hour===h)?.requests||0)};}),max=Math.max(1,...buckets.map(x=>x.requests));
 return `<div class="activity-chart"><div class="chart-key"><span class="legend-item"><i class="swatch"></i>Requests</span><span class="muted">${count(state.summary.today.requests)} total</span></div><div class="chart-area" role="img" aria-label="Hourly requests over the last 24 hours. ${count(state.summary.today.requests)} total.">${buckets.map(b=>`<div class="chart-bar" style="height:${b.requests?Math.max(3,b.requests/max*90):0}%" title="${new Date(b.hour).toLocaleTimeString([],{hour:'2-digit'})}: ${b.requests} requests"></div>`).join('')}${!state.summary.today.requests?'<div class="chart-empty"><b>No requests yet</b><span></span></div>':''}</div><div class="chart-labels"><span>24h ago</span><span>18h</span><span>12h</span><span>6h</span><span>Now</span></div></div>`;
}
function peopleEmpty(){return `<div class="empty"><div class="empty-icon">${icon('people')}</div><h3>No people yet</h3><button class="primary" data-action="add-person">${icon('plus')}Add a person</button></div>`;}
function personRow(m){
 const expired=m.expiresAt&&m.expiresAt<=Date.now(),allowed=m.access.some(a=>a.allowed),status=m.paused?'Paused':expired?'Expired':allowed?'Active':state.settings.paused?'Backup paused':state.accounts.length?'Reserve protected':'Awaiting accounts';
 return `<div class="person"><div class="person-id"><span class="avatar">${escape(m.name.slice(0,2).toUpperCase())}</span><div><div class="person-name"><b>${escape(m.name)}</b>${m.personalOnly?'<span class="tag warn">Use mine</span>':''}<span class="tag ${status==='Active'?'green':m.paused?'':'warn'}">${status}</span></div><div class="person-key">vcp_••••${escape(m.keyHint)} · ${m.rpm} req/min</div></div></div><div><div class="mini-share"><div class="segmented-bar"><div class="shared" style="width:${m.sharePercent}%"></div></div><b>${pct(m.sharePercent)}</b></div><p class="subtext" style="font-size:10px">${m.fallbackOnly?`Personal → backup at ${pct(m.personalSwitchPercent??100)} used · ${switchWindowLabel(m).toLowerCase()}`:`Backup at ${pct(m.personalSwitchPercent??100)} used · ${switchWindowLabel(m).toLowerCase()} · direct access allowed`} · ${pct(100-m.sharePercent)} reserved</p></div><div class="person-actions"><button class="small" data-action="pause-backup" data-id="${escape(m.id)}">${m.backupPaused?'Resume backup':'Pause backup'}</button><button class="ghost icon-button small" data-action="pause-person" data-id="${m.id}" aria-label="${m.paused?'Resume':'Pause'} ${escape(m.name)}">${icon(m.paused?'play':'pause')}</button><button class="small" data-action="edit-person" data-id="${m.id}">${icon('edit')}<span class="edit-label">Manage</span></button></div></div>`;
}
function renderPeople(){return heading('SHARE THE POSSIBILITY','People','',`<button class="primary" data-action="add-person">${icon('plus')}Add a person</button>`)+`<div class="info-note" style="margin-bottom:24px">${icon('info')}<span>Percentages apply to total account usage. People share the same pool.</span></div><section class="card">${state.members.length?state.members.map(personRow).join(''):peopleEmpty()}</section>`;}
function accountEmpty(){return `<section class="card"><div class="empty"><div class="empty-icon">${icon('layers')}</div><h3>No accounts connected</h3><button class="primary" data-action="connect-account">${icon('plus')}Connect an account</button></div></section>`;}
function accountCard(a){
 const fresh=Date.now()-a.checkedAt<=120000&&a.windows.every(w=>w.resetsAt>Date.now()),status=!a.enabled?'Disabled':!a.available?'Unavailable':a.error?'Quota unavailable':!fresh?'Reading stale':'Connected';
 return `<article class="card card-pad" data-account-card="${escape(a.id)}"><div class="account-head"><div class="provider-icon ${a.provider}">${a.provider==='claude'?'✳':icon('layers')}</div><div><div class="account-email">${escape(a.email)}</div><span class="subtext">${a.provider==='codex'?'Codex':'Claude'} subscription</span></div><span class="tag ${status==='Connected'?'green':'warn'}"><i class="dot ${status==='Connected'?'':'warn'}"></i>${status}</span></div>${a.windows.length?a.windows.map(w=>`<div class="quota-row"><div class="quota-label"><span>${escape(w.label)}</span><span>${pct(w.usedPercent)} used</span></div><div class="quota-track"><div style="width:${w.usedPercent}%"></div></div><div class="quota-caption"><span>${pct(100-w.usedPercent)} remaining</span><span>${reset(w.resetsAt)}</span></div></div>`).join(''):'<p class="subtext" style="margin:20px 0">Waiting for the provider’s first quota reading.</p>'}${a.error?`<div class="alert" style="margin:16px 0">${escape(a.error)}. Shared access is blocked.</div>`:''}${!memberView?`<div class="field account-owner"><label for="owner-${escape(a.prefix)}">Account owner</label><select id="owner-${escape(a.prefix)}" data-owner="${escape(a.id)}"><option value="" ${a.ownerMemberId===null?'selected':''}>You · shared backup</option>${a.ownerMemberId&&!state.members.some(m=>m.id===a.ownerMemberId)?'<option selected disabled>Removed person · private</option>':''}${state.members.map(m=>`<option value="${m.id}" ${a.ownerMemberId===m.id?'selected':''}>${escape(m.name)} · personal</option>`).join('')}</select></div>`:''}<div class="account-footer"><span>${a.models.length} models available</span><span>Checked ${age(a.checkedAt).toLowerCase()}</span>${!memberView||a.personal?`<button class="ghost danger small" data-action="remove-account" data-id="${escape(a.id)}" aria-label="Remove account ${escape(a.email)}">${icon('trash')}Remove</button>`:''}</div></article>`;
}
function renderAccounts(){return heading('ONE POOL. YOUR ACCOUNTS.','Accounts','',`<button class="primary" data-action="connect-account">${icon('plus')}Connect an account</button>`)+`<div class="info-note" style="margin-bottom:24px">${icon('shield')}<span>Personal accounts first. Your accounts are backup. Quota refreshes every minute.</span></div>${state.accounts.length?`<div class="account-grid">${state.accounts.map(accountCard).join('')}</div>`:accountEmpty()}`;}
function activityResult(event) {
 if(event.status===102)return event.details?.state==='queued'?'Queued':event.details?.state==='receiving'?'Receiving':'Running';
 if(event.status>=200&&event.status<300)return 'Completed';
 if(event.status===499)return 'Cancelled';
 if(event.reason==='access_changed')return 'Stopped';
 if(event.reason==='hub_restarting')return 'Restarting';
 if(event.reason==='reserve_protected')return 'Reserve protected';
 if(event.reason==='task_review_required')return 'Owner review';
 if(event.reason==='task_blocked')return 'Blocked by rule';
 if(event.status===429)return 'Limited';
 return `HTTP ${event.status}`;
}
function activityTone(event) {
 if(event.status===102)return 'green';
 if(event.status>=200&&event.status<300)return 'green';
 if(event.status===429||event.status===499||event.reason==='access_changed'||event.reason==='hub_restarting')return 'warn';
 return 'red';
}
function activityAccount(event) { return event.details?.accountLabel || state.accounts.find(account=>account.id===event.account_id)?.email || event.account_id || 'No account selected'; }
function activityRoute(event) { return event.details?.route==='shared'?'Shared backup':event.details?.route==='personal'?'Personal':event.account_id?'Not recorded':'Not routed'; }
function activityRows(events) {
 return events.map(event => {
  const details = event.details;
  const route = activityRoute(event);
  const duration = event.status===102?Date.now()-event.at:event.duration;
  return `<tr><td>${escape(event.member_name)}</td><td class="request-cell"><b class="mono">${escape(event.model||'—')}</b><span class="request-path">${escape(details?`${details.method} ${details.path}`:'')}</span>${details?.promptPreview?`<span class="request-excerpt">${escape(details.promptPreview.slice(0,140))}</span>`:''}</td><td class="request-account">${escape(activityAccount(event))}</td><td>${route}</td><td><span class="tag ${activityTone(event)}">${activityResult(event)}</span></td><td class="mono">${(duration/1000).toFixed(1)}s</td><td title="${new Date(event.at).toLocaleString()}">${new Date(event.at).toLocaleString()}</td><td><button class="ghost small" data-action="request-details" data-id="${escape(event.id)}">Details</button></td></tr>`;
 }).join('') || '<tr><td colspan="8" class="muted">No matching requests</td></tr>';
}
function activitySelect(name, label, options) {
 const selected = activityFilters[name];
 // Keep historical selections visible while refreshing filter options.
 if(selected && !options.some(([value])=>value===selected))options=[...options,[selected,selected]];
 return `<label>${label}<select data-activity-filter="${name}" aria-label="Filter requests by ${label.toLowerCase()}">${options.map(([value,text])=>`<option value="${escape(value)}" ${selected===value?'selected':''}>${escape(text)}</option>`).join('')}</select></label>`;
}
function renderActivity() {
 const options = activityOptions();
 const events = activityPage?.events ?? [];
 return heading('','Activity','','') + `<div class="activity-filters" role="group" aria-label="Request filters">
 <label class="activity-search">Search<input data-activity-filter="search" aria-label="Search requests" placeholder="Search prompts, models, errors…" value="${escape(activityFilters.search)}"></label>
 ${activitySelect('person','Person',options.person)}
 ${activitySelect('account','Account',options.account)}
 ${activitySelect('result','Result',[['','All results'],['active','In progress'],['receiving','Receiving'],['queued','Queued'],['running','Running'],['completed','Completed'],['cancelled','Cancelled'],['errors','Errors and limits'],['limited','Rate limited (429)']])}
 ${activitySelect('model','Model',options.model)}
 ${activitySelect('provider','Provider',[['','All providers'],['codex','Codex'],['claude','Claude']])}
 ${activitySelect('route','Route',[['','All routes'],['personal','Personal'],['shared','Shared backup'],['unknown','Route not recorded']])}
 ${activitySelect('endpoint','Endpoint',options.endpoint)}
 ${activitySelect('time','Time range',[['','Any time'],['900000','Last 15 minutes'],['3600000','Last hour'],['86400000','Last 24 hours'],['604800000','Last 7 days']])}
 <button type="button" data-action="clear-activity-filters" ${Object.values(activityFilters).some(Boolean)?'':'disabled'}>Clear filters</button>
 </div><div class="card" id="activity-results" aria-busy="true"><div class="card-head"><div><h2>Request history</h2><p>Search and filter all retained requests · History 90 days · Previews 7 days</p></div><span class="tag" id="activity-count" role="status">Loading…</span></div><div class="table-wrap"><table><thead><tr><th>Person</th><th>Request</th><th>Account</th><th>Route</th><th>Result</th><th>Duration</th><th>When</th><th></th></tr></thead><tbody id="activity-rows">${activityRows(events)}</tbody></table></div><div id="activity-pagination">${activityPagination()}</div></div>`;
}
function activityOptions() {
 const options = activityPage?.options;
 const accounts = new Map(state.accounts.map(account=>[account.id,account.email]));
 for(const account of options?.accounts ?? [])if(!accounts.has(account.id))accounts.set(account.id,account.label);
 return {
  person:[['','All people'],...(options?.people ?? state.members.map(member=>({id:member.id,label:member.name}))).map(person=>[person.id,person.label])],
  account:[['','All accounts'],...[...accounts].sort((a,b)=>a[1].localeCompare(b[1]))],
  model:[['','All models'],...(options?.models ?? []).map(value=>[value,value])],
  endpoint:[['','All endpoints'],...(options?.endpoints ?? []).map(value=>[value,value])],
 };
}
function activityPagination() {
 const total=activityPage?.total ?? 0, offset=activityPage?.offset ?? 0, size=activityPaging.limit;
 return `<div class="activity-pagination"><span role="status">${activityLoading?'Loading…':total?`${count(offset+1)}–${count(Math.min(offset+size,total))} of ${count(total)}`:'0 requests'}</span><label>Per page <select data-activity-page-size aria-label="Requests per page">${[25,50,100].map(value=>`<option value="${value}" ${size===value?'selected':''}>${value}</option>`).join('')}</select></label><div class="activity-page-actions"><button class="small" data-action="activity-latest" ${activityLoading?'disabled':''}>Latest</button><button class="small" data-action="activity-newer" ${activityLoading||offset===0?'disabled':''}>← Newer</button><button class="small" data-action="activity-older" ${activityLoading||offset+size>=total?'disabled':''}>Older →</button></div></div>`;
}
async function loadActivity() {
 clearTimeout(activityTimer);
 activityController?.abort();
 const controller=activityController=new AbortController(), version=++activityVersion;
 const params=new URLSearchParams(Object.entries(activityFilters).filter(([,value])=>value));
 params.set('offset',String(activityPaging.offset));params.set('limit',String(activityPaging.limit));
 if(activityPaging.offset>0 && activityPaging.snapshot!==null)params.set('snapshot',String(activityPaging.snapshot));
 activityLoading=true;
 const results=document.querySelector('#activity-results');
 if(!results)return;
 results.setAttribute('aria-busy','true');
 document.querySelector('#activity-count').textContent='Loading…';
 document.querySelector('#activity-pagination').innerHTML=activityPagination();
 try {
  const data=await api(`/activity?${params}`,{signal:controller.signal});
  if(version!==activityVersion || page!=='activity' || !session?.authenticated)return;
  activityPage=data;activityPaging.offset=data.offset;activityPaging.snapshot=data.snapshot;
  document.querySelector('#activity-rows').innerHTML=activityRows(data.events);
  document.querySelector('#activity-count').textContent=`${count(data.total)} requests`;
  for(const [name,options] of Object.entries(activityOptions())){
   const template=document.createElement('template');template.innerHTML=activitySelect(name,name,options);
   document.querySelector(`[data-activity-filter="${name}"]`).innerHTML=template.content.querySelector('select').innerHTML;
  }
 } catch(error) {
  if(error.name==='AbortError' || version!==activityVersion)return;
  activityPage=null;
  if(document.querySelector('#activity-results')){
   document.querySelector('#activity-rows').innerHTML='<tr><td colspan="8" class="muted">Could not load requests. Select Latest to retry.</td></tr>';
   document.querySelector('#activity-count').textContent='Requests unavailable';
  }
  toast(error.message,true);
 } finally {
  if(version===activityVersion){
   activityLoading=false;
   document.querySelector('#activity-results')?.setAttribute('aria-busy','false');
   const pagination=document.querySelector('#activity-pagination');if(pagination)pagination.innerHTML=activityPagination();
  }
 }
}
function updateActivityFilter(event) {
 const name = event.target.dataset.activityFilter;
 if(!name || !Object.hasOwn(activityFilters,name))return;
 activityFilters[name] = event.target.value;
 activityPaging.offset=0;activityPaging.snapshot=null;
 document.querySelector('[data-action="clear-activity-filters"]').disabled = !Object.values(activityFilters).some(Boolean);
 clearTimeout(activityTimer);
 // Invalidate in-flight searches immediately, including during the debounce.
 activityController?.abort();activityVersion++;
 document.querySelector('#activity-results').setAttribute('aria-busy','true');
 if(name==='search')activityTimer=setTimeout(()=>void loadActivity(),200);else void loadActivity();
}
function requestDetails(id) {
 const event = activityPage?.events.find(row=>row.id===id) ?? state.history.find(row=>row.id===id);
 if(!event)return toast('Request is no longer on this page.');
 const details = event.details;
 const field = (name,value) => `<div><dt>${name}</dt><dd>${escape(value??'—')}</dd></div>`;
 const bytes = value => value===undefined?'—':value<1024?`${value} B`:value<1048576?`${(value/1024).toFixed(1)} KB`:`${(value/1048576).toFixed(2)} MB`;
 const duration = event.status===102?Date.now()-event.at:event.duration;
 const route = activityRoute(event);
 openModal(`${modalTop('Request details',`${escape(event.member_name)} · ${escape(activityResult(event))}`)}<div class="request-id"><code>${escape(event.id)}</code><button class="ghost small" data-action="copy-request-id" data-id="${escape(event.id)}" aria-label="Copy request ID">${icon('copy')}</button></div><dl class="request-details">${field('Received',new Date(event.at).toLocaleString())}${field('Finished',details?.finishedAt?new Date(details.finishedAt).toLocaleString():event.status===102?'In progress':'—')}${field('Endpoint',details?`${details.method} ${details.path}`:null)}${field('Model',event.model)}${field('Provider',details?.provider)}${field('Route',route)}${field('Account',activityAccount(event))}${field('HTTP result',event.status===102?'Pending':event.status)}${field('Reason',event.reason)}${field('Stopped during',details?.errorPhase)}${field('Total time',`${(duration/1000).toFixed(2)}s`)}${field('Queue time',details?`${(details.queueMs/1000).toFixed(2)}s`:null)}${field('First response byte',details?.firstByteMs===undefined?null:`${(details.firstByteMs/1000).toFixed(2)}s`)}${field('Request size',bytes(details?.requestBytes))}${field('Declared size',bytes(details?.declaredBytes))}${field('Response size',bytes(details?.responseBytes))}${field('Input items',details?.inputItems)}${field('Tools',details?.tools)}${field('Streaming',details?.stream===undefined?null:details.stream?'Yes':'No')}${field('Client',details?.client)}</dl>${details?.screening?`<div class="field"><span class="field-label">Screening result</span><pre class="request-preview">${escape(typeof details.screening==='string'?details.screening:JSON.stringify(details.screening,null,2))}</pre>${details.reviewId?`<button type="button" data-action="open-review" data-id="${escape(details.reviewId)}">Open review</button>`:''}</div>`:details?.reviewId?`<button type="button" data-action="open-review" data-id="${escape(details.reviewId)}">Open review</button>`:''}${details?.errorMessage?`<div class="field"><span class="field-label">Error</span><pre class="request-preview">${escape(details.errorMessage)}</pre></div>`:''}${details?.promptPreview?`<div class="field"><span class="field-label">Latest user prompt · preview</span><pre class="request-preview">${escape(details.promptPreview)}</pre></div>`:''}${!details?'<p class="help-text">Recorded before detailed logging was enabled.</p>':''}${event.status===102?`<div class="form-actions"><button data-action="refresh-request" data-id="${escape(event.id)}">Refresh request</button></div>`:''}`);
}
function renderConnect(){
 const base=`${state.publicBaseUrl}/v1`;
 return heading('','Connection','','')+`<div class="setup-grid"><section class="card card-pad"><h2>API endpoint</h2><div class="code-box code-row"><code>${escape(base)}</code><button class="ghost icon-button small" data-action="copy-url" aria-label="Copy endpoint">${icon('copy')}</button></div><p class="subtext">Use a person’s vcp_ key. Tailscale required.</p></section><section class="card card-pad"><h2>Friend dashboard</h2><div class="code-box code-row"><a href="${escape(state.publicBaseUrl)}/me" target="_blank" rel="noopener noreferrer">${escape(state.publicBaseUrl)}/me</a></div><p class="subtext">Sign in with the same access key.</p></section><section class="card card-pad full-width"><h2>Client configuration</h2><details open><summary>Codex · config.toml</summary><pre class="code-box">model_provider = "vibe"

[model_providers.vibe]
name = "Vibe Hub"
base_url = "${escape(base)}"
env_key = "VIBE_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false</pre><p class="subtext">Edit config.toml in the CODEX_HOME shown for each T3 server’s Codex provider. Save VIBE_API_KEY as a sensitive provider environment variable. Choose a model from /v1/models.</p></details><details><summary>Claude Code · environment</summary><pre class="code-box">ANTHROPIC_BASE_URL=${escape(state.publicBaseUrl)}
ANTHROPIC_AUTH_TOKEN=&lt;vcp_ key&gt;</pre></details></section></div>`;
}
function renderReviews(){
 const r=state.reviews;if(!r)return heading('','Reviews','Review information is unavailable.');
 const selected=reviewIdFromHash(), item=r.items.find(x=>x.id===selected);
 if(item)reviewTab=item.status==='pending'?'pending':'history';
 const latest=new Map();
 for(const decision of r.decisions||[])if(!latest.has(decision.id))latest.set(decision.id,decision);
 const isCurrentDecision=(current,decision)=>current&&current.status===decision.status&&(current.generation??0)===(decision.generation??0);
 const items=reviewTab==='pending'?r.items.filter(x=>x.status==='pending').map(item=>({item,current:true,key:`review-${item.id}`})):[
  ...(r.decisions||[]).map((item,index)=>({item,current:latest.get(item.id)===item&&isCurrentDecision(r.items.find(x=>x.id===item.id),item),key:`decision-${index}-${item.id}`})),
  ...r.items.filter(item=>item.status!=='pending'&&!isCurrentDecision(item,latest.get(item.id)||{})).map(item=>({item,current:true,key:`review-${item.id}`}))
 ].sort((a,b)=>b.item.updatedAt-a.item.updatedAt);
 return heading('','Reviews','Review shared backup requests and manage screening rules.',`<button data-page="settings">Notification settings</button>`)+
 `<div class="review-summary"><span class="tag ${r.configured?'green':'warn'}">${r.configured?'Screening configured':'Screening key not configured'}</span><span>${r.settings.enabled?escape(r.settings.mode):'Screening off'}</span><span>${count(r.pendingCount)} pending</span><span>Today $${Number(r.usage.todayUsd).toFixed(2)} · Month $${Number(r.usage.monthUsd).toFixed(2)}</span><span>${count(r.usage.checks)} checks · ${count(r.usage.cacheHits)} cache hits</span></div><div class="review-tabs" role="tablist" aria-label="Reviews">${['pending','history','rules'].map(t=>`<button role="tab" aria-selected="${reviewTab===t}" class="${reviewTab===t?'active':''}" data-action="review-tab" data-tab="${t}">${t[0].toUpperCase()+t.slice(1)}${t==='pending'?` (${count(r.pendingCount)})`:''}</button>`).join('')}</div>`+
 (r.settings.enabled&&r.settings.mode==='observe'?'<div class="alert">Observe mode records matches for review. Requests are not paused and notifications are not sent until enforce mode is enabled.</div>':'')+
 (reviewTab==='rules'?renderRules(r):`${selected&&!item?'<div class="alert">This review could not be found.</div>':''}<div class="review-list">${items.length?items.map(entry=>reviewCard(entry.item,entry.current,entry.key)).join(''):'<div class="card empty"><h3>No reviews here</h3><p>Items will appear here when screening creates a review.</p></div>'}</div>`);
}
function reviewCard(item,current=true,key=`review-${item.id}`){
 const selected=current&&reviewIdFromHash()===item.id;
 return `<article class="card card-pad review-card ${selected?'review-selected':''}" id="${escape(key)}"><div class="section-title"><div><h2>${escape(item.title||'Shared backup request')}</h2><p class="subtext">${escape(item.memberName)} · ${new Date(item.updatedAt).toLocaleString()} · ${count(item.requestCount)} requests</p></div><span class="tag ${item.status==='pending'?'warn':'green'}">${escape(item.status)}</span></div><p>${escape(item.reason)}</p><p class="subtext">${escape((item.ruleNames||[]).join(', ')||'No rule named')} · Policy ${escape(item.policyVersion)}</p>${item.objectivePreview?`<div class="field"><span class="field-label">Task objective · redacted preview</span><pre class="request-preview">${escape(item.objectivePreview)}</pre></div>`:''}${item.latestPreview?`<div class="field"><span class="field-label">Latest request · redacted preview</span><pre class="request-preview">${escape(item.latestPreview)}</pre></div>`:''}${item.hardBlocked?'<div class="alert">Blocked by an owner rule. This task cannot be approved or reopened while the block rule applies.</div>':!item.contextKnown?'<div class="alert">Task context is unknown, so this review cannot be approved.</div>':''}${item.note?`<p class="subtext">Decision note: ${escape(item.note)}</p>`:''}${item.approvalExpiresAt?`<p class="subtext">Approval expires ${new Date(item.approvalExpiresAt).toLocaleString()} · ${count(item.approvalRemaining)} requests remaining</p>`:''}<div class="quick-links">${!current||item.hardBlocked?'':item.status==='pending'?`<button class="primary" data-action="review-decision" data-id="${escape(item.id)}" data-decision="approve" ${item.contextKnown?'':'disabled'}>Approve this task</button><button data-action="review-decision" data-id="${escape(item.id)}" data-decision="deny">${state.reviews.settings.mode==='observe'?'Deny task':'Keep paused'}</button>`:item.status==='denied'?`<button data-action="review-decision" data-id="${escape(item.id)}" data-decision="reopen">Reopen review</button>`:''}</div></article>`;
}
function renderRules(r){const s=r.settings;return `<div class="review-rules"><form id="review-settings-form" class="card card-pad"><h2>Screening settings</h2><p class="subtext">Model: ${escape(r.model||'Not configured')}. The API key is configured on the server. Observe records results; enforce applies your rules to shared backup.</p><div class="field"><label><input type="checkbox" name="enabled" ${s.enabled?'checked':''}> Enable screening</label></div><div class="field"><label for="review-mode">Mode</label><select id="review-mode" name="mode"><option value="observe" ${s.mode==='observe'?'selected':''}>Observe</option><option value="enforce" ${s.mode==='enforce'?'selected':''}>Enforce</option></select></div><div class="form-row"><div class="field"><label for="daily-budget">Daily budget (USD)</label><input id="daily-budget" name="dailyBudgetUsd" type="number" min="0" step="any" required value="${escape(s.dailyBudgetUsd)}"></div><div class="field"><label for="monthly-budget">Monthly budget (USD)</label><input id="monthly-budget" name="monthlyBudgetUsd" type="number" min="0" step="any" required value="${escape(s.monthlyBudgetUsd)}"></div></div><div class="field"><label for="cache-seconds">Cache expiry (seconds)</label><input id="cache-seconds" name="cacheSeconds" type="number" min="0" step="1" required value="${escape(s.cacheSeconds)}"></div><div class="form-actions"><button class="primary" type="submit">Save settings</button></div></form><section><div class="section-title"><h2>Rules</h2><button data-action="edit-rule">${icon('plus')}Add rule</button></div><p class="subtext">Changing a rule invalidates cached decisions and old approvals. Paused reviews stay pending.</p>${r.rules.length?r.rules.map(rule=>`<article class="card card-pad section-gap"><div class="section-title"><div><h3>${escape(rule.name)}</h3><p class="subtext">${escape(rule.action)} · ${rule.enabled?'Enabled':'Disabled'} · ${rule.memberIds.length?`${count(rule.memberIds.length)} people`:'Everyone'} · Version ${count(rule.version)}</p></div><span class="review-actions"><button class="small" data-action="edit-rule" data-id="${escape(rule.id)}">Edit</button><button class="small danger" data-action="delete-rule" data-id="${escape(rule.id)}">Delete</button></span></div><p>${escape(rule.description)}</p></article>`).join(''):'<div class="card empty section-gap"><h3>No rules yet</h3></div>'}</section></div>`;}
function ruleModal(id){const r=state.reviews.rules.find(x=>x.id===id);openModal(`${modalTop(r?'Edit rule':'Add rule','Changing rules invalidates cached decisions and old approvals.')}<form id="rule-form" data-id="${escape(id||'')}"><div class="field"><label for="rule-name">Name</label><input id="rule-name" name="name" required value="${escape(r?.name||'')}"></div><div class="field"><label for="rule-description">What should this catch?</label><textarea id="rule-description" name="description" required>${escape(r?.description||'')}</textarea></div><div class="field"><label for="rule-exceptions">Exceptions</label><textarea id="rule-exceptions" name="exceptions">${escape(r?.exceptions||'')}</textarea></div><div class="field"><label for="rule-pause">Examples to catch · one per line</label><textarea id="rule-pause" name="pauseExamples">${escape((r?.pauseExamples||[]).join('\n'))}</textarea></div><div class="field"><label for="rule-allow">Examples to allow · one per line</label><textarea id="rule-allow" name="allowExamples">${escape((r?.allowExamples||[]).join('\n'))}</textarea></div><div class="field"><span class="field-label">People · leave all unchecked for everyone</span><div class="checkbox-list">${state.members.map(m=>`<label><input type="checkbox" name="memberIds" value="${escape(m.id)}" ${r?.memberIds.includes(m.id)?'checked':''}>${escape(m.name)}</label>`).join('')}</div></div><div class="field"><label for="rule-action">Action</label><select id="rule-action" name="action">${[['review','Pause for review'],['block','Block'],['record','Record only']].map(([v,l])=>`<option value="${v}" ${r?.action===v?'selected':''}>${l}</option>`).join('')}</select></div><div class="field"><label><input type="checkbox" name="enabled" ${r?.enabled!==false?'checked':''}> Enabled</label></div><div class="form-actions"><button type="button" data-action="close-modal">Cancel</button><button class="primary" type="submit">Save rule</button></div></form>`);}
function reviewDecisionModal(id,decision){const item=state.reviews.items.find(x=>x.id===id);if(!item)return;if(item.hardBlocked&&decision!=='deny')throw new Error('This task is blocked by an owner rule');if(decision==='approve'&&!item.contextKnown)throw new Error('Cannot approve unknown task context');openModal(`${modalTop(decision==='approve'?'Approve this task':decision==='deny'?(state.reviews.settings.mode==='observe'?'Deny this task':'Keep this task paused'):'Reopen review',escape(item.title))}<form id="decision-form" data-id="${escape(id)}" data-decision="${escape(decision)}">${decision==='approve'?'<p class="help-text">Approval applies only to this task context. Normal quota limits still apply.</p><div class="form-row"><div class="field"><label for="approval-minutes">Minutes</label><input id="approval-minutes" name="minutes" type="number" min="1" required value="30"></div><div class="field"><label for="approval-requests">Maximum requests</label><input id="approval-requests" name="maxRequests" type="number" min="1" required value="25"></div></div>':''}<div class="field"><label for="decision-note">Note · optional</label><textarea id="decision-note" name="note"></textarea></div><div class="form-actions"><button type="button" data-action="close-modal">Cancel</button><button class="primary" type="submit">${decision==='approve'?'Approve task':decision==='deny'?(state.reviews.settings.mode==='observe'?'Deny task':'Keep paused'):'Reopen'}</button></div></form>`);}
async function loadNotifications(){if(memberView)return;notificationsLoading=true;try{notifications=await api('/notifications');if(page==='settings'&&state){const drafts=[...document.querySelectorAll('form[data-dirty]')].map(f=>[f.id,f]);render();for(const [id,f] of drafts)document.getElementById(id)?.replaceWith(f);}}catch(error){notifications={error:error.message};if(page==='settings'&&state)render();}finally{notificationsLoading=false;}}
function renderNotifications(){if(!notifications)return '<section class="card card-pad section-gap"><h2>Notifications</h2><p class="subtext">Loading notification settings…</p></section>';if(notifications.error)return `<section class="card card-pad section-gap"><h2>Notifications</h2><p class="subtext">Could not load notification settings: ${escape(notifications.error)}. Refresh to retry.</p></section>`;return `<section class="card card-pad section-gap" id="notifications"><h2>Notifications</h2><p class="subtext">Notifications open the dashboard for your decision. Browser and operating system permission is required; your browser may need to be running.</p><form id="notification-settings-form"><div class="field"><label><input type="checkbox" name="enabled" ${notifications.enabled?'checked':''}> Enable notification delivery</label></div><div class="field"><label for="reminder-minutes">Reminder interval (minutes)</label><input id="reminder-minutes" name="reminderMinutes" type="number" min="0" step="1" required value="${escape(notifications.reminderMinutes)}"></div><button type="submit">Save notification settings</button></form><form id="notification-device-form"><div class="field"><label for="notification-label">This device label</label><input id="notification-label" placeholder="e.g. My laptop" maxlength="100"></div></form><div class="quick-links"><button data-action="notification-enable">Enable on this device</button><button data-action="notification-test">Send test notification</button><button data-action="notification-refresh">Refresh delivery history</button></div><p class="help-text">${notifications.publicKey?'':'Push is not configured on the server. '}If permission is blocked, allow notifications in your browser settings and try again.</p><div class="notification-list">${(notifications.subscriptions||[]).map(x=>`<div class="settings-row"><div><h3>${escape(x.label||'Browser')}</h3><p class="subtext">Added ${new Date(x.createdAt).toLocaleString()}</p></div><button class="small" data-action="notification-remove" data-id="${escape(x.id)}">Remove</button></div>`).join('')||'<p class="subtext">No devices registered.</p>'}</div>${(notifications.history||[]).length?`<h3 class="section-gap">Recent delivery</h3>${notifications.history.slice(0,10).map(h=>`<p class="subtext">${escape(h.kind)} · ${escape(h.status)} · ${new Date(h.createdAt).toLocaleString()}${h.error?` · ${escape(h.error)}`:''}</p>`).join('')}`:''}</section>`;}
function pushKey(value){const s=value.replace(/-/g,'+').replace(/_/g,'/');return Uint8Array.from(atob(s.padEnd(Math.ceil(s.length/4)*4,'=')),c=>c.charCodeAt(0));}
async function enableNotifications(){if(!window.isSecureContext||!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window))throw new Error('Push notifications need a supported browser and a secure connection (HTTPS).');if(!notifications?.publicKey)throw new Error('Push is not configured on the server.');const permission=await Notification.requestPermission();if(permission!=='granted')throw new Error('Notification permission was not granted. Allow notifications in your browser settings and try again.');const label=document.querySelector('#notification-label')?.value.trim()||'Browser';const registration=await navigator.serviceWorker.register(`${basePath}/sw.js`,{scope:`${basePath}/`});await navigator.serviceWorker.ready;const existing=await registration.pushManager.getSubscription();const mapped=localStorage.getItem(`${basePath}:push-device`);if(existing&&mapped&&(notifications.subscriptions||[]).some(x=>x.id===mapped)){toast('This browser is already registered. Send a test to verify delivery.');return;}const subscription=existing||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:pushKey(notifications.publicKey)});const data=subscription.toJSON();const before=new Set((notifications.subscriptions||[]).map(x=>x.id));const result=await api('/notifications/subscriptions',{method:'POST',body:{endpoint:data.endpoint,keys:data.keys,label}});await loadNotifications();const id=(typeof result==='string'?result:result.id||result.subscription?.id)||(notifications.subscriptions||[]).find(x=>!before.has(x.id))?.id;if(id)localStorage.setItem(`${basePath}:push-device`,id);toast('This browser is registered. Send a test to verify delivery.');}
async function removeNotification(id){const local=localStorage.getItem(`${basePath}:push-device`);if(local===id&&'serviceWorker' in navigator){const registration=await navigator.serviceWorker.getRegistration(`${basePath}/`);const subscription=await registration?.pushManager.getSubscription();if(subscription&&!await subscription.unsubscribe())throw new Error('Could not unsubscribe this browser. Check browser permissions and try again.');}await api(`/notifications/subscriptions/${encodeURIComponent(id)}`,{method:'DELETE'});if(local===id)localStorage.removeItem(`${basePath}:push-device`);await loadNotifications();toast('Device removed');}

function renderSettings(){
 const limits = Object.entries(state.requestLimits).map(([key, limit]) => `
  <div class="settings-row request-setting">
   <div><label for="setting-${key}">${escape(limit.label)}</label><p id="help-${key}" class="subtext">${escape(limit.description)}</p>
    <small class="muted">Default ${count(limit.default)} ${escape(limit.unit)} · ${count(limit.min)}–${count(limit.max)} allowed</small></div>
   <div class="field"><span class="muted" aria-hidden="true">${escape(limit.unit)}</span>
    <input id="setting-${key}" name="${key}" type="number" required min="${limit.min}" max="${limit.max}" step="1" value="${state.settings[key]}" aria-describedby="help-${key}"></div>
  </div>`).join('');
 return heading('','Settings','')+`
  ${renderNotifications()}
  <section class="card card-pad">
   <h2>Sharing</h2>
   <div class="settings-row"><div><h3>Shared access</h3><p class="subtext">Pausing cancels active shared requests and blocks new backup requests. Personal accounts keep working.</p></div><button data-action="toggle-global" class="${state.settings.paused?'primary':''}">${icon(state.settings.paused?'play':'pause')}${state.settings.paused?'Resume':'Pause sharing'}</button></div>
   <form id="margin-form" class="settings-row"><div><h3>Early-stop margin</h3><p class="subtext">Subtracts percentage points from each person's shared ceiling. A 2-point margin stops a 20% ceiling at 18% total usage. Increase this to leave more room for delayed quota readings. Default 2 points.</p></div><div class="setting-actions"><div class="field"><label for="margin" class="muted">Percentage points</label><input class="setting-margin" id="margin" name="margin" type="number" min="0" max="20" step="0.5" value="${state.settings.safetyMargin}"></div><button class="small" type="submit">Save</button></div></form>
   <div class="settings-row"><div><h3>Per-person limits</h3><p class="subtext">Set total-usage ceilings, requests per minute, expiry, allowed models, account pools, and personal-first routing for each person.</p></div><button data-page="people">Manage people</button></div>
  </section>
  <form id="request-limits-form" class="card card-pad section-gap">
   <h2>Request limits</h2>
   ${limits}
   <p class="subtext">Saving updates the hub immediately. Queue wait is set when routing starts, and body size when the upload is read. Provider timeout and output limits are set when its provider call starts. Active provider calls keep their existing limits. Client timeouts may end requests sooner.</p>
   <div class="form-actions"><button class="primary" type="submit">Save request limits</button></div>
  </form>
  <section class="card card-pad section-gap">
   <h2>Logging</h2>
   <div class="settings-row"><div><h3>Prompt previews</h3><p class="subtext">Records up to 600 characters from the latest user prompt for 7 days, visible to the owner. Turning this off stops new previews. Existing previews expire on schedule. Common credentials are redacted.</p></div><button data-action="toggle-prompt-previews" class="${state.settings.promptPreviews?'primary':''}">${state.settings.promptPreviews?'Enabled':'Disabled'}</button></div>
   <div class="settings-row"><div><h3>Request history</h3><p class="subtext">Request details stay on ewaste for 90 days. Access keys are stored as hashes.</p></div><span class="tag">Fixed</span></div>
  </section>
  <section class="card card-pad section-gap">
   <h2>Built-in safeguards</h2>
   <div class="settings-row"><div><h3>Quota freshness</h3><p class="subtext">Quota probes run at most once a minute. Failed or missing readings, readings older than 2 minutes, and reset windows awaiting confirmation block admission. Provider rate limits can delay probes further. Running requests can cross the usage ceiling while readings lag.</p></div><span class="tag">Fixed</span></div>
   <div class="settings-row"><div><h3>Account routing</h3><p class="subtext">Personal accounts are used first. Set each person’s switchover percentage in People → Manage. With the personal usage requirement enabled, every personal account supporting the model must have fresh usage at or above that threshold before shared backup can be used. Busy accounts below the threshold wait in the queue.</p></div><span class="tag">Fixed</span></div>
   <div class="settings-row"><div><h3>Uploads and dashboard writes</h3><p class="subtext">Requests have 30 seconds to upload their body and 15 seconds to send headers. Dashboard JSON is limited to 4 MiB. Model and compaction requests use the body limit above.</p></div><span class="tag">Fixed</span></div>
   <div class="settings-row"><div><h3>Model transport</h3><p class="subtext">HTTP and streamed HTTP responses are supported. WebSocket connections receive HTTP 426.</p></div><span class="tag">Fixed</span></div>
  </section>`;
}
let cancelPersonalHold = null;
function openModal(html){cancelPersonalHold?.();document.querySelector('#modal-content').innerHTML=html;if(!modal.open)modal.showModal();}
function personalRoutingCard(m, primary, expired) {
 return `<section class="card card-pad section-gap" aria-labelledby="personal-routing-title"><div class="section-title"><h2 id="personal-routing-title">Use mine</h2><span class="tag ${m.personalOnly?'warn':''}">${m.personalOnly?'Personal accounts only':'Optional'}</span></div><p class="subtext">${m.personalOnly?'Your personal accounts can keep going past the switchover percentage until their provider quota runs out. Shared backup is off. This stays on until you restore automatic routing, including after quota resets.':'Keep using your own accounts past the switchover percentage. Shared backup stays off while this mode is on.'}</p><div class="quick-links">${!m.paused&&!expired?m.personalOnly?'<button data-action="restore-routing">Restore automatic routing</button>':`<button data-action="use-mine" ${primary.length?'':'disabled'}>Use mine</button>`:''}</div>${!primary.length?'<p class="help-text">Connect a personal account to use this mode.</p>':''}</section>`;
}
function useMineModal() {
 openModal(`${modalTop('Use only your accounts?', 'Continue past your personal switchover percentage')}<div id="use-mine-warning" class="alert">${icon('info')}<span>You could use up all your remaining personal quota and have to wait for it to reset. Requests will use only your own connected accounts. You will not draw from the hub owner’s accounts, even if yours run out or become unavailable. Any shared backup request currently running will stop.</span></div><p class="help-text">Your provider’s actual limits still apply. This mode stays on until you choose Restore automatic routing. That restores the switchover percentage and shared backup rules set by the hub owner.</p><p id="hold-hint" class="help-text" role="status">Hold the button for 2 seconds to confirm. Release early to cancel. You can also hold Space or Enter.</p><div class="form-actions"><button data-action="close-modal">Cancel</button><button id="hold-use-mine" class="hold-confirm" aria-label="Hold to use mine" aria-describedby="use-mine-warning hold-hint"><span class="hold-label">Hold to use mine</span><span class="hold-timer" aria-hidden="true">2.0s</span></button></div>`);
 const button = document.querySelector('#hold-use-mine'), hint = document.querySelector('#hold-hint');
 const listeners = new AbortController();
 let frame = 0, started = null;
 function resetHold() {
  cancelAnimationFrame(frame); started = null;
  button.classList.remove('is-holding');
  button.style.setProperty('--hold-progress', '0%');
  button.querySelector('.hold-timer').textContent = '2.0s';
  hint.textContent = 'Hold the button for 2 seconds to confirm. Release early to cancel. You can also hold Space or Enter.';
 }
 cancelPersonalHold = () => { resetHold(); listeners.abort(); cancelPersonalHold = null; };
 async function confirm() {
  cancelPersonalHold(); button.disabled = true; hint.textContent = 'Switching to your accounts…';
  button.classList.add('is-holding');
  button.style.setProperty('--hold-progress', '100%');
  button.querySelector('.hold-timer').textContent = '0.0s';
  try {
   await api('/member/routing', {method:'PATCH', body:{personalOnly:true, confirmed:true}});
   modal.close(); await load(); toast('Use mine is on. Shared backup is off.');
  } catch(error) { toast(error.message, true); modal.close(); }
 }
 function step(now) {
  if(started === null)return;
  const progress = Math.min(1, (now - started) / 2000);
  button.style.setProperty('--hold-progress', `${progress * 100}%`);
  button.querySelector('.hold-timer').textContent = `${(Math.ceil((1 - progress) * 20) / 10).toFixed(1)}s`;
  if(progress === 1)void confirm(); else frame = requestAnimationFrame(step);
 }
 function startHold(event) {
  if(button.disabled || started !== null)return;
  event.preventDefault(); started = performance.now();
  button.classList.add('is-holding');
  hint.textContent = 'Keep holding… Release to cancel.';
  frame = requestAnimationFrame(step);
 }
 const on = (target, name, handler) => target.addEventListener(name, handler, {signal:listeners.signal});
 on(button, 'pointerdown', event => { if(event.button === 0 && event.isPrimary)startHold(event); });
 for(const name of ['pointerup','pointercancel','pointerleave','blur'])on(button, name, resetHold);
 on(button, 'keydown', event => { if([' ', 'Enter'].includes(event.key)){event.preventDefault();if(!event.repeat)startHold(event);} });
 on(button, 'keyup', event => { if([' ', 'Enter'].includes(event.key)){event.preventDefault();resetHold();} });
 on(button, 'contextmenu', event => event.preventDefault());
 on(window, 'blur', resetHold);
 on(document, 'visibilitychange', () => { if(document.hidden)resetHold(); });
 on(modal, 'cancel', resetHold);
}
function modalTop(title,subtitle){return `<div class="modal-top"><div><h2>${title}</h2><p>${subtitle}</p></div><button class="ghost icon-button" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button></div>`;}
function personModal(id){
 const m=state.members.find(m=>m.id===id),value=m?.sharePercent??20,models=[...new Set(state.accounts.flatMap(a=>a.models))];
 openModal(`${modalTop(m?'Edit access':'Add a person','')}<form id="person-form" data-id="${id||''}"><div class="field"><label for="person-name">Name</label><input id="person-name" name="name" maxlength="60" required autocomplete="off" value="${escape(m?.name||'')}" placeholder="Your friend’s name"></div><div class="field"><label for="share">Protect my reserve</label><div id="share-preview">${allocation(value)}</div><input id="share" name="share" type="range" min="0" max="100" step="1" value="${value}" aria-label="Shared usage ceiling"><small>Stops backup at this total usage. Includes your usage; applies to all windows.</small></div><div class="form-row"><div class="field"><label for="rpm">Requests per minute</label><input id="rpm" name="rpm" type="number" min="1" max="6000" required value="${m?.rpm??20}"><small>1–6,000 requests/minute. This limit is separate from backup quota, queue capacity, and provider limits.</small></div><div class="field"><label for="expires">Key expiry · optional</label><input id="expires" name="expires" type="date" value="${m?.expiresAt?new Date(m.expiresAt).toISOString().slice(0,10):''}"></div></div><div class="field"><label for="personal-switch-window">Switchover quota window</label><select id="personal-switch-window" name="personalSwitchWindow"><option value="hourly" ${m?.personalSwitchWindow==='hourly'?'selected':''}>Hourly (session)</option><option value="weekly" ${m?.personalSwitchWindow==='weekly'?'selected':''}>Weekly</option><option value="both" ${!m?.personalSwitchWindow||m.personalSwitchWindow==='both'?'selected':''}>Both (either window)</option></select><small>Hourly uses the provider’s session window, such as 5 hours. Both switches as soon as either window reaches the percentage. A fully exhausted provider window always requires backup.</small></div><div class="field"><label for="personal-switch">Switch to backup at personal usage (%)</label><input id="personal-switch" name="personalSwitchPercent" type="number" min="1" max="100" step="any" required value="${m?.personalSwitchPercent??100}" aria-describedby="personal-switch-help"><small id="personal-switch-help">Choose any percentage from 1 to 100, such as 20, 30, 40, or 50. Each personal account must reach this usage in the selected window before switching. 100 waits until quota runs out. Fresh readings below this threshold return requests to personal accounts. Usage readings may lag; running requests finish.</small></div><div class="field"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="fallback" ${m?.fallbackOnly!==false?'checked':''}>Require personal accounts to reach the switchover threshold before backup</label><small>When unchecked, backup can also be used without an available personal account.</small></div><div class="field"><label for="allowed-models">Allowed models · optional</label><textarea id="allowed-models" name="models" placeholder="All models by default. For restrictions, enter one exact model ID per line.">${escape(m?.allowedModels.join('\n')||'')}</textarea><small>${models.length?`Available: ${escape(models.slice(0,8).join(', '))}`:'Connect an account to see its model IDs.'}</small></div>${state.accounts.length||m?.accountIds.length?`<div class="field"><span class="field-label">Account pool</span><div class="checkbox-list">${state.accounts.map(a=>`<label><input type="checkbox" name="account" value="${escape(a.id)}" ${m?.accountIds.includes(a.id)?'checked':''}>${escape(a.email)} · ${a.provider}</label>`).join('')}${(m?.accountIds||[]).filter(id=>!state.accounts.some(a=>a.id===id)).map(id=>`<label><input type="checkbox" name="account" value="${escape(id)}" checked>Removed account · unavailable</label>`).join('')}</div><small>No selection means all connected accounts, including accounts you add later.</small></div>`:''}<div class="info-note">${icon('shield')}<span>${state.settings.safetyMargin}-point early-stop margin applies to the backup ceiling. Readings may lag.</span></div><div class="form-actions">${m?`<button type="button" class="ghost danger" data-action="delete-person" data-id="${m.id}" style="margin-right:auto">${icon('trash')}Remove</button><button type="button" data-action="rotate-key" data-id="${m.id}">${icon('key')}New key</button>`:'<button type="button" class="ghost" data-action="close-modal">Cancel</button>'}<button type="submit" class="primary">${m?'Save changes':'Create access'} ${icon('arrow')}</button></div></form>`);
}
function showKey(key,name='your friend'){
 secretKey=key;openModal(`${modalTop('Access key',`Share this with ${escape(name)}. It will only be shown once.`)}<div class="key-display mono">${escape(key)}</div><button class="primary" data-action="copy-key">${icon('copy')}Copy access key</button><div class="field"><span class="field-label">API base URL</span><div class="code-box code-row"><code>${escape(state.publicBaseUrl)}/v1</code><button type="button" class="ghost small" data-action="copy-url">${icon('copy')}</button></div></div><div class="info-note">${icon('lock')}<span>This key opens model access and the friend dashboard.</span></div><div class="form-actions"><button class="primary" data-action="close-modal">Done ${icon('check')}</button></div>`);
}
const oauthPath = () => memberView ? '/member/oauth' : '/oauth';
function connectModal(){oauth=null;openModal(`${modalTop('Connect an account','Codex or Claude subscription')}<p class="help-text">Sign in, then paste the localhost callback URL—even if the browser cannot load it.</p><div class="quick-links"><button class="primary" data-action="oauth-start" data-provider="codex">${icon('layers')}Connect Codex</button><button data-action="oauth-start" data-provider="claude">✳ Connect Claude</button></div><div id="oauth-flow"></div>${memberView?'':`<div class="field" style="border-top:1px solid var(--border);padding-top:20px;margin-top:25px"><label for="auth-file">Import CLIProxy auth JSON</label><input id="auth-file" type="file" accept="application/json,.json"><small>Codex or Claude auth JSON only.</small></div>`}`);}
async function copy(value){try{await navigator.clipboard.writeText(value);toast('Copied to clipboard');}catch{toast('Clipboard unavailable. Select and copy the text.',true);}}
document.addEventListener('click',async event=>{
 const button=event.target.closest('button');if(!button)return;
 const dest=button.dataset.page;if(dest){page=dest;if(location.hash.slice(1)===page)render();else location.hash=page;return;}
 const action=button.dataset.action,id=button.dataset.id;if(!action)return;
 try{
  switch(action){
   case 'review-tab':reviewTab=button.dataset.tab;location.hash='reviews';render();break;
   case 'open-review':modal.close();reviewTab='pending';location.hash=`reviews?review=${encodeURIComponent(id)}`;if(page==='reviews')render();break;
   case 'edit-rule':ruleModal(id);break;
   case 'delete-rule':if(confirm('Delete this rule? Existing paused reviews remain pending.')){await api(`/review-rules/${encodeURIComponent(id)}`,{method:'DELETE'});await load();toast('Rule deleted');}break;
   case 'review-decision':reviewDecisionModal(id,button.dataset.decision);break;
   case 'pause-backup':{const m=state.members.find(m=>m.id===id);await api(`/members/${encodeURIComponent(id)}`,{method:'PATCH',body:{backupPaused:!m.backupPaused}});await load();toast(m.backupPaused?'Backup resumed':'Backup paused');break;}
   case 'notification-enable':await enableNotifications();break;
   case 'notification-remove':await removeNotification(id);break;
   case 'notification-refresh':await loadNotifications();toast('Delivery history refreshed');break;
   case 'notification-test':await api('/notifications/test',{method:'POST'});toast('Test queued. Check delivery history and your browser notifications.');await loadNotifications();break;
   case 'add-person':personModal();break;
   case 'edit-person':personModal(id);break;
   case 'edit-first':personModal(state.members[0]?.id);break;
   case 'close-modal':modal.close();break;
   case 'connect-account':connectModal();break;
   case 'use-mine':useMineModal();break;
   case 'restore-routing':button.disabled=true;await api('/member/routing',{method:'PATCH',body:{personalOnly:false}});await load();toast('Automatic routing restored');break;
   case 'remove-account':{
    const account=state.accounts.find(a=>a.id===id);if(!account||(memberView&&!account.personal))throw new Error('Account not found');
    openModal(`${modalTop(`Remove ${escape(account.email)}?`,account.provider==='codex'?'Codex connection':'Claude connection')}<p class="help-text">This removes the saved connection from this hub and stops requests currently using it. Request history is kept. To reconnect, sign in to the account again.</p><div class="form-actions"><button type="button" data-action="close-modal">Cancel</button><button type="button" class="danger" data-action="confirm-remove-account" data-id="${escape(id)}">Remove account</button></div>`);break;
   }
   case 'confirm-remove-account':button.disabled=true;await api(memberView?'/member/accounts':'/accounts',{method:'DELETE',body:{accountId:id}});modal.close();await load();toast('Account removed');break;
   case 'copy-key':await copy(secretKey);break;
   case 'copy-url':await copy(`${state.publicBaseUrl}/v1`);break;
   case 'toggle-global':await api('/settings',{method:'PATCH',body:{paused:!state.settings.paused}});await load();toast(state.settings.paused?'Shared access paused':'Shared access resumed');break;
   case 'pause-person':{const m=state.members.find(m=>m.id===id);await api(`/members/${id}`,{method:'PATCH',body:{paused:!m.paused}});await load();toast(m.paused?'Access resumed':'Access paused');break;}
   case 'request-details':requestDetails(id);break;
   case 'clear-activity-filters':for(const name of Object.keys(activityFilters))activityFilters[name]='';activityPaging.offset=0;activityPaging.snapshot=null;render();break;
   case 'activity-older':activityPaging.offset+=activityPaging.limit;await loadActivity();break;
   case 'activity-newer':activityPaging.offset=Math.max(0,activityPaging.offset-activityPaging.limit);await loadActivity();break;
   case 'activity-latest':activityPaging.offset=0;activityPaging.snapshot=null;await loadActivity();break;
   case 'copy-request-id':await copy(id);break;
   case 'refresh-request':await load();await loadActivity();requestDetails(id);break;
   case 'toggle-prompt-previews':await api('/settings',{method:'PATCH',body:{promptPreviews:!state.settings.promptPreviews}});await load();break;
   case 'refresh':button.disabled=true;await api('/refresh',{method:'POST'});await load();toast('Hub refreshed. Provider quota pacing still applies.');break;
   case 'logout':await api(memberView?'/member/logout':'/logout',{method:'POST'});session.authenticated=false;state=null;renderLogin();break;
   case 'rotate-key':{const m=state.members.find(m=>m.id===id);openModal(`${modalTop('Replace this access key?',`The current key for ${escape(m.name)} will stop working immediately.`)}<div class="form-actions"><button data-action="edit-person" data-id="${id}">Go back</button><button class="primary" data-action="confirm-rotate" data-id="${id}">Replace key</button></div>`);break;}
   case 'confirm-rotate':{const name=state.members.find(m=>m.id===id)?.name;const r=await api(`/members/${id}/rotate`,{method:'POST'});await load();showKey(r.key,name);break;}
   case 'delete-person':{const m=state.members.find(m=>m.id===id);openModal(`${modalTop(`Remove ${escape(m.name)}?`,'Their key will stop working immediately. Request history is retained.')}<div class="form-actions"><button data-action="edit-person" data-id="${id}">Go back</button><button class="danger" data-action="confirm-delete" data-id="${id}">Remove access</button></div>`);break;}
   case 'confirm-delete':await api(`/members/${id}`,{method:'DELETE'});modal.close();await load();toast('Access removed');break;
   case 'oauth-start':{
    button.disabled=true;const provider=button.dataset.provider;const flow=document.querySelector('#oauth-flow');
    try{const r=await api(`${oauthPath()}/start`,{method:'POST',body:{provider}});const u=new URL(r.url);if(u.protocol!=='https:')throw new Error('Provider returned an invalid sign-in URL');oauth={provider,state:r.state};flow.innerHTML=`<div class="field"><a href="${escape(u.href)}" target="_blank" rel="noopener noreferrer">Open ${provider==='codex'?'Codex':'Claude'} sign-in ${icon('external')}</a></div><form id="oauth-form"><div class="field"><label for="callback-url">Paste the complete localhost callback URL</label><textarea id="callback-url" name="callback" required placeholder="http://localhost:…?code=…&state=…"></textarea></div><div class="quick-links"><button class="primary" type="submit">Finish connecting ${icon('arrow')}</button><button type="button" data-action="oauth-check">Check status</button></div><p id="oauth-status" class="help-text"></p></form>`;}finally{button.disabled=false;}break;
   }
   case 'oauth-check':await checkOAuth();break;
  }
 }catch(error){toast(error.message,true);if(button.isConnected)button.disabled=false;}
});
async function checkOAuth(){if(!oauth)return;const r=await api(`${oauthPath()}/status?state=${encodeURIComponent(oauth.state)}`);const status=document.querySelector('#oauth-status');if(r.status==='ok'){oauth=null;modal.close();await load();toast('Account connected');}else if(status)status.textContent=r.status==='wait'?'Sign-in is still pending. Finish provider sign-in and paste the callback URL.':r.error||'Sign-in could not be completed. Start again.';}
document.addEventListener('input',event=>{if(event.target.id==='share'){document.querySelector('#share-preview').innerHTML=allocation(Number(event.target.value));}if(event.target.closest('#request-limits-form, #review-settings-form, #notification-settings-form, #notification-device-form'))event.target.closest('form').dataset.dirty='true';});
document.addEventListener('submit',async event=>{
 event.preventDefault();const form=event.target,submit=form.querySelector('[type=submit]');if(submit)submit.disabled=true;
 try{
  if(form.id==='login-form'){const r=await api(memberView?'/member/login':'/login',{method:'POST',body:memberView?{token:new FormData(form).get('token')}:{password:new FormData(form).get('token')}});session={...session,authenticated:true,csrf:r.csrf};await load();}
  if(form.id==='person-form'){
   const d=new FormData(form),id=form.dataset.id,models=String(d.get('models')||'').split(/[\n,]/).map(s=>s.trim()).filter(Boolean),expires=String(d.get('expires')||'');
   const body={name:d.get('name'),sharePercent:Number(d.get('share')),personalSwitchPercent:Number(d.get('personalSwitchPercent')),personalSwitchWindow:d.get('personalSwitchWindow'),rpm:Number(d.get('rpm')),allowedModels:models,accountIds:d.getAll('account'),expiresAt:expires?new Date(`${expires}T23:59:59Z`).getTime():null,fallbackOnly:d.has('fallback')};
   const r=await api(id?`/members/${id}`:'/members',{method:id?'PATCH':'POST',body});modal.close();await load();if(r.key)showKey(r.key,body.name);else toast('Sharing controls saved');
  }
  if(form.id==='margin-form'){await api('/settings',{method:'PATCH',body:{safetyMargin:Number(new FormData(form).get('margin'))}});await load();toast('Safety margin saved');}
  if(form.id==='request-limits-form'){
   const data=new FormData(form),body=Object.fromEntries(Object.keys(state.requestLimits).map(key=>[key,Number(data.get(key))]));
   await api('/settings',{method:'PATCH',body});delete form.dataset.dirty;await load();toast('Request limits saved');
  }
  if(form.id==='review-settings-form'){const d=new FormData(form);await api('/review-settings',{method:'PATCH',body:{enabled:d.has('enabled'),mode:d.get('mode'),dailyBudgetUsd:Number(d.get('dailyBudgetUsd')),monthlyBudgetUsd:Number(d.get('monthlyBudgetUsd')),cacheSeconds:Number(d.get('cacheSeconds'))}});delete form.dataset.dirty;await load();toast('Screening settings saved');}
  if(form.id==='rule-form'){const d=new FormData(form),id=form.dataset.id,lines=name=>String(d.get(name)||'').split('\n').map(x=>x.trim()).filter(Boolean);await api(id?`/review-rules/${encodeURIComponent(id)}`:'/review-rules',{method:id?'PATCH':'POST',body:{name:d.get('name'),description:d.get('description'),exceptions:d.get('exceptions'),pauseExamples:lines('pauseExamples'),allowExamples:lines('allowExamples'),memberIds:d.getAll('memberIds'),action:d.get('action'),enabled:d.has('enabled')}});modal.close();await load();toast('Rule saved');}
  if(form.id==='decision-form'){const d=new FormData(form);await api(`/reviews/${encodeURIComponent(form.dataset.id)}/decision`,{method:'POST',body:{decision:form.dataset.decision,minutes:Number(d.get('minutes')||30),maxRequests:Number(d.get('maxRequests')||25),note:d.get('note')||''}});modal.close();await load();toast('Review updated');}
  if(form.id==='notification-settings-form'){const d=new FormData(form);await api('/notifications',{method:'PATCH',body:{enabled:d.has('enabled'),reminderMinutes:Number(d.get('reminderMinutes'))}});delete form.dataset.dirty;await loadNotifications();toast('Notification settings saved');}
  if(form.id==='oauth-form'){await api(`${oauthPath()}/callback`,{method:'POST',body:{state:oauth.state,provider:oauth.provider,redirectUrl:new FormData(form).get('callback')}});form.reset();document.querySelector('#oauth-status').textContent='Callback received. The provider is finishing sign-in. Check status in a moment.';}
 }catch(error){if(form.id==='login-form')document.querySelector('#login-error').textContent=error.message;else toast(error.message,true);}finally{if(submit?.isConnected)submit.disabled=false;}
});
document.addEventListener('change',async event=>{if(event.target.id!=='auth-file')return;const file=event.target.files?.[0];if(!file)return;try{if(file.size>1024*1024)throw new Error('Choose an auth file smaller than 1 MB');await api('/accounts/import',{method:'POST',body:{auth:JSON.parse(await file.text())}});modal.close();await load();toast('Account imported');}catch(error){toast(error.message,true);}});
modal.addEventListener('close',()=>{if(modal.open)return;cancelPersonalHold?.();if(memberView&&oauth){void api('/member/oauth/cancel',{method:'POST',body:{state:oauth.state}}).catch(()=>{});}secretKey='';oauth=null;document.querySelector('#modal-content').innerHTML='';});
modal.addEventListener('click',event=>{if(event.target===modal){const r=modal.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)modal.close();}});
window.addEventListener('hashchange',()=>{page=location.hash.slice(1).split('?')[0]||'overview';render();});
setInterval(()=>{const interval=!memberView&&page==='activity'?5000:30000;if(Date.now()-lastRefreshAt>=interval&&session?.authenticated&&!modal.open&&!document.hidden&&!document.querySelector('input:focus, [data-activity-filter]:focus')&&!document.querySelector('form[data-dirty]'))void load(true);},5000);
(async()=>{try{session=await api(memberView?'/member/session':'/session');if(session.authenticated)await load();else renderLogin();}catch{app.innerHTML='<div class="boot"><p>Could not reach the hub. Reload to try again.</p></div>';}})();

function renderMember(){
 const m=state.member,primary=state.accounts.filter(a=>a.personal),backup=state.accounts.filter(a=>!a.personal),expired=m.expiresAt&&m.expiresAt<=Date.now();
 const confirmed=primary.length>0&&primary.every(a=>a.switchReached), personalReady=primary.some(a=>a.enabled&&a.available&&!a.error&&Date.now()-a.checkedAt<=120000&&!a.switchReached&&a.windows.length>0&&a.windows.every(w=>w.resetsAt>Date.now()));
 const backupReady=!m.personalOnly&&!state.settings.paused&&(!m.fallbackOnly||confirmed)&&backup.some(a=>a.enabled&&a.available&&!a.error&&a.headroom>0&&Date.now()-a.checkedAt<=120000);
 const status=m.paused?'Paused':expired?'Expired':m.personalOnly?(personalReady?'Personal account':'Personal quota unavailable'):personalReady?'Personal account':backupReady?'Backup available':!primary.length&&m.fallbackOnly?'Connect personal account':'Waiting for quota';
 const rows=state.history.map(e=>`<tr><td class="mono">${escape(e.model||'—')}</td><td><span class="tag ${activityTone(e)}">${activityResult(e)}</span></td><td class="mono">${(e.duration/1000).toFixed(1)}s</td><td>${age(e.at)}</td></tr>`).join('');
 app.innerHTML=`<main class="member-layout"><header class="member-header">${brand()}<div class="top-actions"><span class="status-pill"><i class="dot ${m.paused||expired?'warn':''}"></i>${status}</span><button class="ghost icon-button small" data-action="logout" aria-label="Sign out">${icon('logout')}</button></div></header><div class="content"><div class="page-heading"><div><h1>${escape(m.name)}</h1></div><span class="tag">${m.rpm} REQUESTS / MIN</span></div>${m.paused||expired?`<div class="alert">${icon('pause')}${expired?'Access key expired.':'Access paused.'}</div>`:''}${state.proxy.error?`<div class="alert">${icon('info')}${escape(state.proxy.error)}</div>`:''}${(state.reviewStatus?.enabled||state.reviewStatus?.pendingCount)?`<div class="info-note">${icon('shield')}<span>Shared backup requests may be reviewed by the hub owner. ${count(state.reviewStatus.pendingCount)} of your tasks ${state.reviewStatus.pendingCount===1?'is':'are'} paused for review. ${state.reviewStatus.backupPaused?'Your shared backup is paused; personal accounts can continue.':''}</span></div>`:state.reviewStatus?.backupPaused?`<div class="alert">Shared backup is paused. Personal accounts can continue.</div>`:''}<section class="metrics member-metrics">${metric('Routing',state.currentRoute==='backup'?'Backup':state.currentRoute==='personal'?'Personal':'Standby',m.personalOnly?'Use mine · shared backup off':state.settings.paused?'Backup paused · using personal quota':`Backup at ${pct(m.personalSwitchPercent??100)} · ${switchWindowLabel(m).toLowerCase()}`,'layers')}${metric('Backup ceiling',pct(m.sharePercent),`Early stop at ${pct(Math.max(0,m.sharePercent-state.settings.safetyMargin))} total usage`,'shield')}${metric('Requests · last 24h',count(state.summary.today.requests),`${count(state.summary.today.successful)} completed`,'activity')}</section>${personalRoutingCard(m,primary,expired)}<section class="card card-pad section-gap" aria-labelledby="member-switchover-title"><div class="section-title"><h2 id="member-switchover-title">Switch to backup</h2><span class="tag">Set by hub owner</span></div><p class="range-value">${pct(m.personalSwitchPercent??100)} personal usage</p><p class="subtext">${switchWindowLabel(m)} quota</p>${m.personalOnly?'<p class="help-text">Use mine is on. This switchover percentage is bypassed and shared backup is off until you restore automatic routing.</p>':''}${state.settings.paused&&!m.personalOnly?'<p class="help-text">Shared backup is paused. Your personal accounts continue until their provider quota runs out; the switchover percentage resumes when sharing is enabled.</p>':''}<p class="subtext">${m.fallbackOnly?'Backup becomes available when each personal account for the requested model reaches this usage in the selected quota window.':'Personal accounts stop at this usage. Backup is also allowed when no personal account is available.'} ${m.personalSwitchWindow==='both'||!m.personalSwitchWindow?'Either hourly or weekly usage can trigger backup.':'Hourly means the provider’s session window, such as 5 hours.'} With automatic routing, a fully exhausted provider window also triggers backup. While automatic routing and sharing are enabled, personal accounts resume when fresh usage falls below the threshold. Backup usage limits still apply.</p></section><div class="section-title section-gap"><h2>Your accounts</h2>${!m.paused&&!expired?`<button class="primary small" data-action="connect-account">${icon('plus')}Connect an account</button>`:''}</div>${primary.length?`<div class="account-grid">${primary.map(accountCard).join('')}</div>`:'<div class="card empty"><h3>No personal account connected</h3><p>Connect your Codex or Claude subscription.</p></div>'}<section class="section-gap"><div class="section-title"><h2>Shared backup</h2><span class="tag ${backupReady?'green':'warn'}">${m.personalOnly?'Off · Use mine':state.settings.paused||m.backupPaused?'Paused':backupReady?'Available':m.fallbackOnly&&!confirmed?'Personal quota first':'Protected'}</span></div>${backup.length?`<div class="account-grid">${backup.map(a=>`<article class="card card-pad"><div class="section-title"><h3>${escape(a.email)} · ${a.provider==='codex'?'Codex':'Claude'}</h3><span class="tag">${pct(m.sharePercent)} ceiling</span></div>${a.windows.map(w=>`<div class="quota-row"><div class="quota-label"><span>${escape(w.label)}</span><span>${pct(w.usedPercent)} total used</span></div><div class="quota-track"><div style="width:${w.usedPercent}%"></div></div><div class="quota-caption"><span>${pct(Math.max(0,m.sharePercent-state.settings.safetyMargin-w.usedPercent))} until stop</span><span>${reset(w.resetsAt)}</span></div></div>`).join('')}${a.error?'<span class="tag warn">Quota unavailable</span>':''}</article>`).join('')}</div>`:'<div class="card empty"><h3>No backup accounts</h3></div>'}</section><section class="card section-gap"><div class="card-head"><h2>Connection</h2><span class="tag">TAILSCALE</span></div><div class="card-pad" style="padding-top:0"><div class="code-box code-row"><code>${escape(state.publicBaseUrl)}/v1</code><button class="ghost icon-button small" data-action="copy-url" aria-label="Copy API endpoint">${icon('copy')}</button></div><p class="subtext">Use the access key you signed in with.</p>${state.settings.promptPreviews?'<p class="subtext">Short prompt previews are visible to the hub owner.</p>':''}<details><summary>T3 Code usage hub</summary><p class="subtext">Settings → Providers → Usage providers → Add hub</p><div class="code-box">${escape(state.publicBaseUrl)}</div><p class="subtext">Management key: your access key. Quota access only; no admin permissions.</p></details></div></section><section class="card section-gap"><div class="card-head"><h2>Your activity</h2><span class="tag">LAST 100</span></div>${rows?`<div class="table-wrap"><table><thead><tr><th>Model</th><th>Result</th><th>Duration</th><th>When</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<div class="empty"><h3>No requests yet</h3></div>'}</section></div></main>`;
}
document.addEventListener('change',async event=>{
 const select=event.target;if(!select.matches('[data-owner]'))return;
 select.disabled=true;try{await api('/accounts/owner',{method:'PATCH',body:{accountId:select.dataset.owner,memberId:select.value||null}});await load();toast('Account owner saved');}catch(error){toast(error.message,true);}finally{if(select.isConnected)select.disabled=false;}
});

document.addEventListener('input',event=>{if(event.target.dataset.activityFilter==='search')updateActivityFilter(event);});
document.addEventListener('change',event=>{if(event.target.dataset.activityFilter&&event.target.dataset.activityFilter!=='search')updateActivityFilter(event);});
document.addEventListener('change',event=>{if(event.target.matches('[data-activity-page-size]')){activityPaging.limit=Number(event.target.value);activityPaging.offset=0;activityPaging.snapshot=null;void loadActivity();}});
