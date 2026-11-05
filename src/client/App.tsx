import { Fragment, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { Assignment, DashboardData, Equipment, Member, SessionUser, SocietyEvent } from '../shared/types';
import { MEMBER_CODE_PATTERN, MEMBER_CODE_FORMAT_MESSAGE, composeMemberId, digitsOnly, memberIdYears, parseMemberId } from '../shared/member-id';

/** Shape returned by GET /api/search ΓÇö one query across members, events, and gear. */
interface UnifiedSearchResult { q: string; members: { id:number; memberCode:string; fullName:string; grade:string; className:string; status:string }[]; events: { id:number; eventCode:string; name:string; eventDate:string; startTime?:string; venue?:string; status:string }[]; gear: { id:number; equipmentCode:string; brand:string; model:string; itemName?:string; focalLength?:string; availability:string; categoryName:string; ownerName?:string; ownerId?:number }[]; }

const navItems = [
  ['/', 'dashboard', 'Dashboard'], ['/members', 'group', 'Members'], ['/creative-team', 'palette', 'Creative Team'], ['/events', 'event', 'Event Management'], ['/event-assignments', 'assignment_turned_in', 'Event Assignments'], ['/equipment', 'photo_camera', 'Gear Directory'], ['/reports', 'bar_chart', 'Reports'], ['/settings', 'settings', 'Settings'],
] as const;

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find((v) => v.startsWith('rcpas_csrf='))?.split('=')[1];
  const response = await fetch(`/api${path}`, { credentials: 'include', ...options, headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': decodeURIComponent(csrf) } : {}), ...(options.headers || {}) } });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(typeof payload === 'string' ? payload : payload.error || 'The operation could not be completed.');
  return payload as T;
}

/** Like `api`, but returns the full payload/status instead of throwing, so warnings and override codes survive. */
async function apiRaw<T = any>(path: string, options: RequestInit = {}): Promise<{ ok: boolean; status: number; body: T }> {
  const csrf = document.cookie.split('; ').find((v) => v.startsWith('rcpas_csrf='))?.split('=')[1];
  const response = await fetch(`/api${path}`, { credentials: 'include', ...options, headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': decodeURIComponent(csrf) } : {}), ...(options.headers || {}) } });
  const contentType = response.headers.get('content-type') || '';
  const body = (contentType.includes('application/json') ? await response.json() : await response.text()) as T;
  return { ok: response.ok, status: response.status, body };
}

function useResource<T>(path: string, enabled = true) { const [state, setState] = useState<{data?:T;loading:boolean;error?:string}>({loading:enabled}); const reload = () => { if (!enabled) return; setState({loading:true}); api<T>(path).then((data) => setState({data,loading:false})).catch((e) => setState({loading:false,error:e.message})); }; useEffect(reload, [path, enabled]); return {...state, reload}; }
function initials(name?: string) { return (name || 'RCPAS').split(' ').map((v) => v[0]).slice(0,2).join('').toUpperCase(); }
function statusClass(status: string) { if (['Active','Available','Confirmed','Completed','Ready','Good','Excellent','Confirmed for Event','Waived'].includes(status)) return 'green'; if (['Planning','Contact Pending','Contacted','Proposed','On Leave','Needs Service','Offered','Awaiting Confirmation','Awaiting Response','High'].includes(status)) return 'amber'; if (['Cancelled','Unavailable','Damaged','Inactive','Declined','Reassignment Needed','Released','Critical'].includes(status)) return 'red'; return 'slate'; }
const MONTHS_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
function eventDateParts(dateStr: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr || '');
  if (m) return { mon: MONTHS_SHORT[Number(m[2]) - 1] || '', day: String(Number(m[3])).padStart(2, '0') };
  const dt = new Date(dateStr);
  if (!Number.isNaN(dt.getTime())) return { mon: MONTHS_SHORT[dt.getMonth()] || '', day: String(dt.getDate()).padStart(2, '0') };
  return { mon: '', day: '' };
}
function timeAgo(v?: string | null) {
  if (!v) return '';
  const raw = String(v);
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const t = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`).getTime();
  if (Number.isNaN(t)) return '';
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(t).toLocaleDateString();
}
function humanize(s: string) {
  return String(s).replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());
}
function activityTone(entityType: string, i: number) {
  const t = (entityType || '').toLowerCase();
  if (t.includes('equip')) return 'amber';
  if (t.includes('event')) return 'gold';
  if (t.includes('assign') || t.includes('member')) return 'navy';
  return ['gold', 'navy', 'amber', 'slate'][i % 4];
}

function BootSplash({message}:{message?:string}) { return <div className="boot-splash" role="status" aria-live="polite"><div className="boot-card"><div className="boot-mark"><img src="/logo.png" alt="RCPAS crest"/></div><div className="boot-name">RCPAS</div><div className="boot-sub">Rahula College Photographic Art Society</div><div className="boot-bar"><span/></div><div className="boot-status">{message || 'Preparing your workspace…'}</div></div><div className="boot-credit">Developed by Hirun Hansaka</div></div>; }

function App() { const [user,setUser] = useState<SessionUser|null|undefined>(undefined); const [bootMsg,setBootMsg]=useState<string|undefined>(undefined); useEffect(() => { try { if (sessionStorage.getItem('rcpas_after_login') === '1') { sessionStorage.removeItem('rcpas_after_login'); setBootMsg('Signing you in…'); } } catch {} api<{user:SessionUser|null}>('/auth/session').then((r) => setUser(r.user)).catch(() => setUser(null)); }, []); if (user === undefined) return <BootSplash message={bootMsg}/>; return user ? <AuthedApp user={user} setUser={setUser}/> : <LoginPage/>; }

function LoginPage() {
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [reveal,setReveal]=useState(false);
  const submit=async(e:React.FormEvent)=>{
    e.preventDefault();
    if(!email.trim()||!password){ setError('Enter your official email and password.'); return; }
    setBusy(true); setError('');
    try { await api('/auth/password/login',{method:'POST',body:JSON.stringify({email:email.trim(),password})}); try{sessionStorage.setItem('rcpas_after_login','1');}catch{} window.location.assign('/'); }
    catch(err){ setError((err as Error).message || 'Sign in failed. Please try again.'); }
    finally { setBusy(false); }
  };
  return (
    <div className="login-split">
      <section className="lp-brand">
        <div className="lp-glow-a"/><div className="lp-glow-b"/><div className="lp-lens"/>
        <div className="lp-ring outer"/><div className="lp-ring inner"/><div className="lp-glow-c"/>

        <div className="lp-topbar">
          <div className="lp-topbar-left">
            <span className="lp-live"><span className="lp-live-dot"/><span className="lp-live-label">RCPAS</span></span>
          </div>
          <p className="lp-place">Photography Society Management</p>
        </div>

        <div className="lp-hero">
          <div className="lp-lockup">
            <div className="lp-mark-wrap">
              <div className="lp-mark-halo"/>
              <div className="lp-mark"><img src="/logo.png" alt="Rahula College Photographic Art Society official emblem"/></div>
            </div>
            <div className="lp-identity">
              <p className="lp-portal-label">Rahula College</p>
              <span className="lp-nexus">Photographic Art Society</span>
            </div>
          </div>

          <div className="lp-titleblock">
            <h1 className="lp-title">Member & Event Management Portal</h1>
            <p className="lp-lede">Manage members, events, assignments, gear, and reports in one place.</p>
          </div>
        </div>

        <div className="lp-brand-foot">
          <span className="lp-foot-fine">Made by Hirun Hansaka</span>
        </div>

        <div className="lp-curve" aria-hidden="true">
          <svg viewBox="0 0 100 1000" preserveAspectRatio="none" fill="currentColor">
            <path d="M0,0 C45,280 95,350 40,650 C10,800 65,920 100,1000 L100,0 Z"/>
          </svg>
        </div>
      </section>

      <section className="lp-panel">
        <div className="lp-form-wrap">
          <span className="lp-auth-tag">Sign in</span>
          <h2 className="lp-heading">Admin Portal</h2>
          <p className="lp-sub">Use your official account to access the Society management dashboard.</p>
          {error && <div className="alert error" role="alert" style={{marginTop:18,marginBottom:0}}><span className="material-symbols-outlined">error</span>{error}</div>}
          <form onSubmit={submit} className="lp-form">
            <div className="lp-field">
              <div className="lp-label-row"><label className="lp-label" htmlFor="lp-email">Email</label></div>
              <span className="lp-input">
                <span className="material-symbols-outlined">badge</span>
                <input id="lp-email" type="text" autoComplete="username" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="official@rcpas.local"/>
              </span>
            </div>
            <div className="lp-field">
              <div className="lp-label-row">
                <label className="lp-label" htmlFor="lp-password">Password</label>
                <button type="button" className="lp-forgot" onClick={()=>window.alert('Contact the system administrator to reset your password.')}>Forgot password?</button>
              </div>
              <span className="lp-input">
                <span className="material-symbols-outlined">lock</span>
                <input id="lp-password" type={reveal?'text':'password'} autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)} placeholder="Enter password"/>
                <button type="button" className="lp-reveal" onClick={()=>setReveal(!reveal)} aria-label={reveal?'Hide password':'Show password'} title={reveal?'Hide password':'Show password'}>
                  <span className="material-symbols-outlined">{reveal?'visibility_off':'visibility'}</span>
                </button>
              </span>
            </div>
            <button className="lp-submit" disabled={busy}>
              {busy ? <><span className="spinner small-spinner"/>Signing in…</> : <><span>Sign in</span><span className="material-symbols-outlined">arrow_forward</span></>}
            </button>
          </form>
        </div>
        <div className="lp-legal">Developed by Hirun Hansaka</div>
      </section>
    </div>
  );
}

function AuthedApp({user,setUser}:{user:SessionUser;setUser:(u:SessionUser|null)=>void}) { const [mobileOpen,setMobileOpen] = useState(false); const navigate = useNavigate(); const location = useLocation(); const [gq,setGq]=useState(''); const [gres,setGres]=useState<UnifiedSearchResult|null>(null); const [gloading,setGloading]=useState(false); const [gopen,setGopen]=useState(false); useEffect(()=>{const term=gq.trim();if(term.length<2){setGres(null);setGloading(false);return}setGloading(true);const t=setTimeout(()=>{api<UnifiedSearchResult>(`/search?q=${encodeURIComponent(term)}&limit=8`).then((r)=>{setGres(r);setGloading(false)}).catch(()=>{setGres(null);setGloading(false)})},250);return ()=>clearTimeout(t)},[gq]); const logout = async () => { try { await api('/auth/logout',{method:'POST'}); } finally { window.location.replace('/login'); } }; return <div className="app-shell"><aside className={`sidebar ${mobileOpen?'open':''}`}><div><div className="brand"><div className="brand-crest"><img src="/logo.png" alt="Rahula College crest"/></div><div><div className="brand-title">RCPAS</div><div className="brand-subtitle">Rahula College</div></div></div><div className="sidebar-nav"><div className="nav-caption">Administration</div>{navItems.map(([to,icon,label]) => <Link key={to} onClick={() => setMobileOpen(false)} className={`nav-link ${location.pathname===to?'active':''}`} to={to}><span className="material-symbols-outlined">{icon}</span><span>{label}</span>{label==='Gear Directory' && <span className="nav-count">vault</span>}</Link>)}</div></div><div className="profile-card"><div className="avatar">{initials(user.displayName)}</div><div className="profile-meta"><strong>{user.displayName}</strong><span>{user.roles.join(' / ') || 'Authorized official'}</span></div><button className="logout-button" onClick={logout} title="Sign out"><span className="material-symbols-outlined">logout</span></button></div></aside><div className="main-wrap"><header className="topbar"><button className="icon-button mobile-menu" onClick={() => setMobileOpen(!mobileOpen)}><span className="material-symbols-outlined">menu</span></button><div className="breadcrumb"><strong>RCPAS</strong><span className="material-symbols-outlined">chevron_right</span><span>Rahula College Photographic Art Society</span></div><div className="top-actions"><div className="search-wrap"><span className="material-symbols-outlined">search</span><input className="global-search" placeholder="Search members, events, gearΓÇª" value={gq} onChange={(e)=>{setGq(e.target.value);setGopen(true)}} onFocus={()=>setGopen(true)} onKeyDown={(e)=>{if(e.key==='Enter'){setGopen(false);navigate(`/search?q=${encodeURIComponent(gq)}`)}if(e.key==='Escape')setGopen(false)}}/>{gopen&&gq.trim().length>=2&&<div className="search-pop">{gloading&&<div className="search-pop-hint">SearchingΓÇª</div>}{!gloading&&gres&&gres.members.length===0&&gres.events.length===0&&gres.gear.length===0&&<div className="search-pop-hint">No members, events, or gear match ΓÇ£{gq}ΓÇ¥.</div>}{!gloading&&gres&&<>{gres.members.length>0&&<div className="search-pop-group">Members</div>}{gres.members.slice(0,5).map(m=><button key={`m${m.id}`} className="search-pop-item" onMouseDown={(e)=>e.preventDefault()} onClick={()=>{setGopen(false);navigate(`/members?search=${encodeURIComponent(m.memberCode)}`)}}><span className="material-symbols-outlined">person</span><span className="search-pop-text"><strong>{m.fullName}</strong><small>{m.memberCode} ┬╖ Grade {m.grade} {m.className}</small></span></button>)}{gres.events.length>0&&<div className="search-pop-group">Events</div>}{gres.events.slice(0,5).map(ev=><button key={`e${ev.id}`} className="search-pop-item" onMouseDown={(e)=>e.preventDefault()} onClick={()=>{setGopen(false);navigate(`/events?search=${encodeURIComponent(ev.name)}`)}}><span className="material-symbols-outlined">event</span><span className="search-pop-text"><strong>{ev.name}</strong><small>{ev.eventCode} ┬╖ {ev.eventDate}{ev.venue?` ┬╖ ${ev.venue}`:''}</small></span></button>)}{gres.gear.length>0&&<div className="search-pop-group">Gear</div>}{gres.gear.slice(0,5).map(gd=><button key={`g${gd.id}`} className="search-pop-item" onMouseDown={(e)=>e.preventDefault()} onClick={()=>{setGopen(false);navigate(`/equipment?search=${encodeURIComponent(gd.equipmentCode)}`)}}><span className="material-symbols-outlined">photo_camera</span><span className="search-pop-text"><strong>{gd.brand} {gd.model}</strong><small>{gd.equipmentCode} ┬╖ {gd.categoryName}{gd.ownerName?` ┬╖ ${gd.ownerName}`:''}</small></span></button>)}<button className="search-pop-all" onMouseDown={(e)=>e.preventDefault()} onClick={()=>{setGopen(false);navigate(`/search?q=${encodeURIComponent(gq)}`)}}><span>See all results</span><span className="material-symbols-outlined">arrow_forward</span></button></>}</div>}</div><button className="icon-button" title="Documentation & Help" onClick={() => alert('Use the module help text and role handbook in Settings.') }><span className="material-symbols-outlined">help_outline</span></button><button className="icon-button" title="Notifications" onClick={() => navigate('/reports')}><span className="material-symbols-outlined">notifications</span></button><div className="avatar">{initials(user.displayName)}</div></div></header><Routes><Route path="/" element={<DashboardPage/>}/><Route path="/members" element={<MembersPage user={user}/>}/><Route path="/creative-team" element={<CreativeTeamPage/>}/><Route path="/events" element={<EventsPage/>}/><Route path="/event-assignments" element={<AssignmentsPage/>}/><Route path="/equipment" element={<EquipmentPage/>}/><Route path="/search" element={<SearchResultsPage/>}/><Route path="/reports" element={<ReportsPage user={user}/>}/><Route path="/settings" element={<SettingsPage user={user} setUser={setUser}/>} /><Route path="*" element={<NotFound/>}/></Routes></div></div>; }

function PageHeader({eyebrow,title,subtitle,actions}:{eyebrow:string;title:ReactNode;subtitle:string;actions?:ReactNode}) { return <div className="page-header"><div><div className="eyebrow"><span className="dot"/>{eyebrow}</div><h1>{title}</h1><p className="subtitle">{subtitle}</p></div>{actions && <div className="page-actions">{actions}</div>}</div>; }
function Loading() { return <div className="loading"><span className="spinner"/>Loading live recordsΓÇª</div>; }
function ErrorState({message,retry}:{message:string;retry?:()=>void}) { return <div className="alert error"><span className="material-symbols-outlined">error</span><div><strong>Unable to load this view.</strong><div>{message}</div>{retry && <button className="button ghost" style={{paddingLeft:0}} onClick={retry}>Try again</button>}</div></div>; }
function Empty({label,icon='inventory_2'}:{label:string;icon?:string}) { return <div className="empty"><span className="material-symbols-outlined">{icon}</span><div>{label}</div></div>; }
function Modal({title,onClose,children,wide=false}:{title:string;onClose:()=>void;children:React.ReactNode;wide?:boolean}) { return <div className="modal-backdrop" onMouseDown={(e) => { if(e.target===e.currentTarget) onClose(); }}><div className={`modal ${wide?'wide':''}`}><div className="modal-header"><h2>{title}</h2><button className="icon-button" onClick={onClose}><span className="material-symbols-outlined">close</span></button></div>{children}</div></div>; }
function Field({label,children,full=false}:{label:string;children:React.ReactNode;full?:boolean}) { return <label className={`form-field ${full?'full':''}`}><span className="form-label">{label}</span>{children}</label>; }
function FormActions({busy,onClose,submitLabel='Save record'}:{busy:boolean;onClose:()=>void;submitLabel?:string}) { return <div className="modal-footer"><button type="button" className="button outline" onClick={onClose}>Cancel</button><button type="submit" className="button primary" disabled={busy}>{busy?'SavingΓÇª':submitLabel}</button></div>; }

function DashboardPage() {
  const navigate = useNavigate();
  const resource = useResource<DashboardData>('/dashboard');
  const d = resource.data;
  const w = d?.welcome;
  const firstName = (w?.displayName || '').trim().split(/\s+/)[0] || 'official';
  const nextEvent = d?.upcomingEvents?.[0];
  const crewTotal = d ? d.metrics.photographers + d.metrics.editors + d.metrics.designers + d.metrics.videographers : 0;
  const kpis = d ? [
    { label: 'Total Members', value: d.metrics.totalMembers, icon: 'groups', tone: 'brand', sub: `${d.metrics.activeMembers} active on roster`, to: '/members' },
    { label: 'Upcoming Events', value: d.metrics.upcomingEvents, icon: 'calendar_today', tone: 'gold', sub: nextEvent ? `Next: ${nextEvent.name}` : 'No events scheduled', to: '/events' },
    { label: 'Equipment Confirmed', value: d.metrics.equipmentConfirmed, icon: 'camera_enhance', tone: 'amber', sub: `${d.metrics.equipmentAwaiting} awaiting confirmation`, to: '/equipment' },
    { label: 'Creative Crew', value: crewTotal, icon: 'badge', tone: 'blue', sub: `${d.metrics.photographers} photographers`, to: '/creative-team' },
  ] : [];
  const quickActions = [
    ...(w?.canCreateEvent ? [{ label: 'New Event', icon: 'calendar_add_on', tone: 'brand', to: '/events' }] : []),
    { label: 'Assign Crew', icon: 'group_add', tone: 'gold', to: '/event-assignments' },
    { label: 'Gear Custody', icon: 'qr_code_scanner', tone: 'amber', to: '/equipment' },
    ...(w?.canViewReports ? [{ label: 'Generate Report', icon: 'picture_as_pdf', tone: 'blue', to: '/reports' }] : []),
  ];
  return (
    <main className="page">
      <div className="db-welcome">
        <div>
          <h1 className="db-welcome-title">Welcome back, {firstName}</h1>
          <p className="db-welcome-sub">{w ? `${w.roles.join(' ┬╖ ') || 'Authorized official'} ┬╖ ${w.upcoming} upcoming ┬╖ ${w.awaitingResponses} response(s) due ┬╖ ${w.unfilledRoles} unfilled role(s)` : 'Rahula College Photographic Art Society Portal'}</p>
        </div>
        <div className="db-welcome-actions">
          {w?.canViewReports && <button className="button outline" onClick={() => navigate('/reports')}><span className="material-symbols-outlined">bar_chart</span> View reports</button>}
          {w?.canCreateEvent && <button className="button primary" onClick={() => navigate('/events')}><span className="material-symbols-outlined">add</span> New event</button>}
        </div>
      </div>
      {resource.loading && <Loading />}
      {resource.error && <ErrorState message={resource.error} retry={resource.reload} />}
      {d && (
        <>
          <div className="db-kpis">
            {kpis.map((k) => (
              <div className="db-kpi" key={k.label} role="button" tabIndex={0} onClick={() => navigate(k.to)} onKeyDown={(e) => { if (e.key === 'Enter') navigate(k.to); }}>
                <div className="db-kpi-head">
                  <span className="db-kpi-label">{k.label}</span>
                  <span className={`db-kpi-icon ${k.tone}`}><span className="material-symbols-outlined">{k.icon}</span></span>
                </div>
                <div>
                  <div className="db-kpi-value">{k.value}</div>
                  <div className="db-kpi-sub">{k.sub}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="db-cols">
            <section className="db-panel db-panel-events">
              <div className="db-panel-head">
                <div>
                  <h2 className="db-panel-title">Upcoming Events</h2>
                  <p className="db-panel-sub">Scheduled coverage and crew assignments</p>
                </div>
                <button className="db-panel-link" onClick={() => navigate('/events')}>View all events <span className="material-symbols-outlined">arrow_forward</span></button>
              </div>
              <div className="db-events">
                {d.upcomingEvents.length ? d.upcomingEvents.map((e) => {
                  const p = eventDateParts(e.eventDate);
                  return (
                    <div className="db-event" key={e.id}>
                      <div className="db-event-date"><span className="db-event-mon">{p.mon}</span><span className="db-event-day">{p.day}</span></div>
                      <div className="db-event-body">
                        <h3 className="db-event-title">{e.name}</h3>
                        <div className="db-event-meta">
                          <span className="db-event-venue"><span className="material-symbols-outlined">location_on</span>{e.venue || 'Venue TBA'}</span>
                          <span>ΓÇó</span>
                          <span className="db-event-crew">{e.assignmentCount} Crew assigned</span>
                        </div>
                      </div>
                      <button className="db-event-manage" onClick={() => navigate(`/events?search=${encodeURIComponent(e.name)}`)}>Manage</button>
                    </div>
                  );
                }) : <Empty label="No upcoming events have been scheduled." icon="event_busy" />}
              </div>
            </section>
            <div className="db-side">
              <section className="db-panel">
                <h2 className="db-panel-title">Quick Actions</h2>
                <div className="db-actions">
                  {quickActions.map((a) => (
                    <button className="db-action" key={a.label} onClick={() => navigate(a.to)}>
                      <span className={`db-action-icon ${a.tone}`}><span className="material-symbols-outlined">{a.icon}</span></span>
                      <span className="db-action-label">{a.label}</span>
                    </button>
                  ))}
                </div>
              </section>
              <section className="db-panel">
                <h2 className="db-panel-title">Recent Activity</h2>
                {d.recentActivity === null ? (
                  <p className="db-empty-note">The audit trail requires the <code>audit.read</code> permission, which your role does not hold.</p>
                ) : d.recentActivity.length ? (
                  <div className="db-activity">
                    {d.recentActivity.slice(0, 6).map((a, i) => {
                      const details = (a.details && typeof a.details === 'object') ? (a.details as Record<string, unknown>) : {};
                      const desc = typeof details.description === 'string' ? details.description : '';
                      return (
                        <div className="db-act-item" key={`${a.createdAt}-${i}`}>
                          <span className={`db-dot ${activityTone(a.entityType, i)}`} />
                          <div className="db-act-body">
                            <p className="db-act-text"><strong>{humanize(a.action)}</strong>{desc ? ` ΓÇö ${desc}` : ''}</p>
                            <span className="db-act-meta">{a.actorName || 'Authorized official'}{a.entityType ? ` ┬╖ ${humanize(a.entityType)}` : ''}{a.entityId ? ` #${a.entityId}` : ''} ┬╖ {timeAgo(a.createdAt)}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="db-empty-note">No administrative activity has been recorded yet.</p>
                )}
              </section>
            </div>
          </div>
        </>
      )}
    </main>
  );
}

function SearchResultsPage() {
  const location = useLocation();
  const q = new URLSearchParams(location.search).get('q') || '';
  const res = useResource<UnifiedSearchResult>(`/search?q=${encodeURIComponent(q)}&limit=25`, q.trim().length >= 2);
  if (q.trim().length < 2) return <main className="page"><PageHeader eyebrow="Unified search" title="Search members, events, and gear" subtitle="Type at least two characters in the top search bar to look across the directory, event schedule, and gear vault." /><div className="empty-state"><span className="material-symbols-outlined">search</span><h3>Start typing to search</h3><p>Results appear here and in the search bar as you type.</p></div></main>;
  if (res.loading) return <main className="page"><PageHeader eyebrow="Unified search" title="Search results" subtitle={`Searching for ΓÇ£${q}ΓÇ¥ΓÇª`} /><div className="empty-state"><span className="material-symbols-outlined">progress_activity</span><h3>SearchingΓÇª</h3></div></main>;
  if (res.error) return <main className="page"><PageHeader eyebrow="Unified search" title="Search results" subtitle={`Results for ΓÇ£${q}ΓÇ¥`} /><ErrorState message={res.error} retry={res.reload}/></main>;
  const data = res.data!;
  const total = data.members.length + data.events.length + data.gear.length;
  return <main className="page">
    <PageHeader eyebrow="Unified search" title="Search results" subtitle={`${total} result${total===1?'':'s'} for ΓÇ£${q}ΓÇ¥ across members, events, and gear.`} />
    <section className="card" style={{marginBottom:20}}>
      <div className="card-header"><div><h3>Members ({data.members.length})</h3><p>Matching name, member code, email, phone, or skills.</p></div></div>
      {data.members.length===0 ? <div className="empty-state" style={{padding:'18px 0'}}><span className="material-symbols-outlined">person_off</span><h3>No members match</h3><p>Nothing in the member directory matches ΓÇ£{q}ΓÇ¥.</p></div>
        : <div className="table-wrap"><table><thead><tr><th>Member</th><th>Grade & class</th><th>Status</th><th></th></tr></thead><tbody>{data.members.map(m=><tr key={m.id}><td><div className="row-title">{m.fullName}</div><div className="row-subtitle">{m.memberCode}</div></td><td>Grade {m.grade} {m.className}</td><td><span className={`chip ${statusClass(m.status)}`}>{m.status}</span></td><td><div className="table-actions"><Link className="icon-button" title="Open in Members" to={`/members?search=${encodeURIComponent(m.memberCode)}`}><span className="material-symbols-outlined">open_in_new</span></Link></div></td></tr>)}</tbody></table></div>}
    </section>
    <section className="card" style={{marginBottom:20}}>
      <div className="card-header"><div><h3>Events ({data.events.length})</h3><p>Matching event name, code, venue, or category.</p></div></div>
      {data.events.length===0 ? <div className="empty-state" style={{padding:'18px 0'}}><span className="material-symbols-outlined">event_busy</span><h3>No events match</h3><p>Nothing in the event schedule matches ΓÇ£{q}ΓÇ¥.</p></div>
        : <div className="table-wrap"><table><thead><tr><th>Event</th><th>Date</th><th>Venue</th><th>Status</th><th></th></tr></thead><tbody>{data.events.map(ev=><tr key={ev.id}><td><div className="row-title">{ev.name}</div><div className="row-subtitle">{ev.eventCode}</div></td><td>{ev.eventDate}{ev.startTime?` ${ev.startTime}`:''}</td><td>{ev.venue||'ΓÇö'}</td><td><span className={`chip ${statusClass(ev.status)}`}>{ev.status}</span></td><td><div className="table-actions"><Link className="icon-button" title="Open in Events" to={`/events?search=${encodeURIComponent(ev.name)}`}><span className="material-symbols-outlined">open_in_new</span></Link></div></td></tr>)}</tbody></table></div>}
    </section>
    <section className="card">
      <div className="card-header"><div><h3>Gear ({data.gear.length})</h3><p>Matching code, brand, model, item name, category, or owner.</p></div></div>
      {data.gear.length===0 ? <div className="empty-state" style={{padding:'18px 0'}}><span className="material-symbols-outlined">photo_camera</span><h3>No gear matches</h3><p>Nothing in the gear vault matches ΓÇ£{q}ΓÇ¥.</p></div>
        : <div className="table-wrap"><table><thead><tr><th>Gear</th><th>Category</th><th>Owner</th><th>Availability</th><th></th></tr></thead><tbody>{data.gear.map(gd=><tr key={gd.id}><td><div className="row-title">{gd.brand} {gd.model}{gd.focalLength?` A┬╖ ${gd.focalLength}`:''}</div><div className="row-subtitle">{gd.equipmentCode}</div></td><td>{gd.categoryName}</td><td>{gd.ownerName||'Society item ΓÇö no member owner'}</td><td><span className={`chip ${statusClass(gd.availability)}`}>{gd.availability}</span></td><td><div className="table-actions"><Link className="icon-button" title="Open in Gear Directory" to={`/equipment?search=${encodeURIComponent(gd.equipmentCode)}`}><span className="material-symbols-outlined">open_in_new</span></Link></div></td></tr>)}</tbody></table></div>}
    </section>
  </main>;
}

function MembersPage({user}:{user:SessionUser}) { const location=useLocation(); const canRegister=user.permissions.includes('members.register'); const [search,setSearch]=useState(()=>new URLSearchParams(location.search).get('search')||''); const [status,setStatus]=useState(''); const [grade,setGrade]=useState(''); const [className,setClassName]=useState(''); const [role,setRole]=useState(''); const [sort,setSort]=useState('name'); const [page,setPage]=useState(1); const [modal,setModal]=useState<'add'|'edit'|null>(null); const [selected,setSelected]=useState<Member|null>(null); const [notice,setNotice]=useState(''); const roles=useResource<{roles:{id:number;name:string}[]}>('/roles'); const gearCategories=useResource<{categories:{id:number;name:string}[]}>('/equipment/categories'); const resource=useResource<{data:Member[];meta:{page:number;pageSize:number;total:number;pageCount:number}}>(`/members?search=${encodeURIComponent(search)}&status=${encodeURIComponent(status)}&grade=${encodeURIComponent(grade)}&className=${encodeURIComponent(className)}&role=${encodeURIComponent(role)}&sort=${sort}&page=${page}&pageSize=10`); const reload=resource.reload; useEffect(()=>{setPage(1)},[search,status,grade,className,role,sort]); useEffect(()=>{if(canRegister&&new URLSearchParams(location.search).get('new')==='1'){setSelected(null);setModal('add')}},[location.search,canRegister]); const openEdit=(m:Member)=>{setSelected(m);setModal('edit')}; const archive=async(id:number)=>{if(!confirm('Archive this member? Historical records will be preserved.'))return;try{await api(`/members/${id}`,{method:'DELETE'});setNotice('Member archived successfully.');reload()}catch(e){setNotice((e as Error).message)}}; const clear=()=>{setSearch('');setStatus('');setGrade('');setClassName('');setRole('');setSort('name');setPage(1)}; return <main className="page"><PageHeader eyebrow="Society membership directory" title="Registered member management" subtitle="Review registered student members, track domains, availability, grade assignments, and verified creative credentials." actions={<><a className="button outline" href="/api/members/export.csv"><span className="material-symbols-outlined">file_download</span> Export CSV</a>{canRegister&&<button className="button primary" onClick={()=>{setSelected(null);setModal('add')}}><span className="material-symbols-outlined">person_add</span> Register member</button>}</>}/>{notice&&<div className="alert info">{notice}</div>}<div className="toolbar"><div className="search-wrap"><span className="material-symbols-outlined">search</span><input placeholder="Search name, ID, grade, class, role, skill, contact or gear (70-200, Canon, telephoto)ΓÇª" value={search} onChange={e=>setSearch(e.target.value)}/></div><input style={{width:100}} placeholder="Grade" value={grade} onChange={e=>setGrade(e.target.value)}/><input style={{width:100}} placeholder="Class" value={className} onChange={e=>setClassName(e.target.value)}/><select value={role} onChange={e=>setRole(e.target.value)}><option value="">All roles</option>{roles.data?.roles.map(r=><option key={r.id}>{r.name}</option>)}</select><select value={status} onChange={e=>setStatus(e.target.value)}><option value="">All statuses</option><option>Active</option><option>On Leave</option><option>Alumni</option><option>Inactive</option></select><select value={sort} onChange={e=>setSort(e.target.value)}><option value="name">Sort by name</option><option value="grade">Sort by grade</option><option value="updated">Recently updated</option></select><button className="button outline" onClick={clear}>Clear filters</button></div><section className="card">{resource.loading?<Loading/>:resource.error?<ErrorState message={resource.error} retry={reload}/>:resource.data?.data.length?<><div className="table-wrap"><table><thead><tr><th>Member</th><th>Grade / Class</th><th>Creative roles</th><th>Availability</th><th>Status</th><th></th></tr></thead><tbody>{resource.data.data.map((m)=><tr key={m.id}><td><div className="row-title">{m.fullName}</div><div className="row-subtitle">{m.memberCode} ┬╖ {m.email || 'No email recorded'}</div></td><td>{m.grade} ┬╖ {m.className}</td><td><div style={{display:'flex',gap:4,flexWrap:'wrap'}}>{m.roles.length?m.roles.map(r=><span className="chip slate" key={r.id}>{r.name}</span>):<span className="muted">Not assigned</span>}</div></td><td className="small">{m.availability || 'Not recorded'}</td><td><span className={`chip ${statusClass(m.status)}`}>{m.status}</span></td><td><div className="table-actions"><button className="icon-button" title="Edit" onClick={()=>openEdit(m)}><span className="material-symbols-outlined">edit</span></button><button className="icon-button" title="Archive" onClick={()=>archive(m.id)}><span className="material-symbols-outlined">archive</span></button></div></td></tr>)}</tbody></table></div><div className="pagination"><span>{resource.data.meta.total} member records</span><span><button className="button ghost" disabled={page<=1} onClick={()=>setPage(p=>p-1)}>Previous</button> Page {resource.data.meta.page} of {resource.data.meta.pageCount} <button className="button ghost" disabled={page>=resource.data.meta.pageCount} onClick={()=>setPage(p=>p+1)}>Next</button></span></div></>:<Empty label="No members match the current filters." icon="group_off"/>}</section>{modal&&<MemberModal roles={roles.data?.roles||[]} member={selected} categories={gearCategories.data?.categories||[]} onClose={()=>setModal(null)} onSaved={()=>{setModal(null);reload();setNotice('Member saved successfully.')}}/>}</main>; }
function MemberGearModal({categories,ownerLabel,onClose,onAdd}:{categories:{id:number;name:string}[];ownerLabel:string;onClose:()=>void;onAdd:(gear:any)=>void}) {
  const [form,setForm]=useState<any>({equipmentCode:'',assetId:'',itemName:'',categoryId:'',brand:'',model:'',focalLength:'',lensMount:'',keywords:'',quantity:1,ownership:'Personally Owned',conditionStatus:'Good',availability:'Available',notes:''});
  const [error,setError]=useState('');
  const [added,setAdded]=useState('');
  const u=(k:string,v:any)=>{setAdded('');setForm((f:any)=>({...f,[k]:v}));};
  const save=(e:React.FormEvent)=>{e.preventDefault();if(!form.categoryId){setError('Select a category for this gear.');return;}if(!String(form.brand).trim()||!String(form.model).trim()){setError('Brand and model are required.');return;}
    onAdd({...form,categoryId:Number(form.categoryId),quantity:Number(form.quantity)});
    setAdded(`Added ${form.brand} ${form.model}. Add another item below, or close when you're done.`);setError('');
    setForm((f:any)=>({...f,assetId:'',itemName:'',brand:'',model:'',focalLength:'',lensMount:'',keywords:'',notes:''}));};
  return <Modal title="Register gear for this member" onClose={onClose} wide><form onSubmit={save}><div className="modal-body">{error&&<div className="alert error">{error}</div>}{added&&<div className="alert info">{added}</div>}<div className="alert info" style={{marginBottom:14}}>Owner: <strong>{ownerLabel}</strong>. This gear is registered to the member you're saving. The equipment code is generated by the server.</div><div className="form-grid">
    <Field label="Equipment code"><input className="form-control" placeholder="Assigned automatically ΓÇö leave blank" value={form.equipmentCode} onChange={e=>u('equipmentCode',e.target.value)}/></Field>
    <Field label="Asset ID (optional)"><input className="form-control" value={form.assetId} onChange={e=>u('assetId',e.target.value)}/></Field>
    <Field label="Item name (optional)"><input className="form-control" placeholder="My main portrait lens" value={form.itemName} onChange={e=>u('itemName',e.target.value)}/></Field>
    <Field label="Category"><select className="form-control" required value={form.categoryId} onChange={e=>u('categoryId',e.target.value)}><option value="">Select category</option>{categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
    <Field label="Brand"><input className="form-control" required value={form.brand} onChange={e=>u('brand',e.target.value)}/></Field>
    <Field label="Model"><input className="form-control" required value={form.model} onChange={e=>u('model',e.target.value)}/></Field>
    <Field label="Focal length (e.g. 70-200mm)"><input className="form-control" placeholder="70-200mm" value={form.focalLength} onChange={e=>u('focalLength',e.target.value)}/></Field>
    <Field label="Lens mount / compatibility"><input className="form-control" placeholder="Canon EF, Sony EΓÇª" value={form.lensMount} onChange={e=>u('lensMount',e.target.value)}/></Field>
    <Field label="Quantity"><input type="number" min="1" className="form-control" required value={form.quantity} onChange={e=>u('quantity',e.target.value)}/></Field>
    <Field label="Condition"><select className="form-control" value={form.conditionStatus} onChange={e=>u('conditionStatus',e.target.value)}><option>Excellent</option><option>Good</option><option>Needs Service</option><option>Damaged</option><option>Unavailable</option></select></Field>
    <Field label="Availability"><select className="form-control" value={form.availability} onChange={e=>u('availability',e.target.value)}><option>Available</option><option>Allocated</option><option>Unavailable</option></select></Field>
    <Field label="Search keywords" full><input className="form-control" placeholder="telephoto, wedding, wildlifeΓÇª" value={form.keywords} onChange={e=>u('keywords',e.target.value)}/></Field>
    <Field label="Notes (condition, limits, availability)" full><textarea className="form-control" value={form.notes} onChange={e=>u('notes',e.target.value)}/></Field>
  </div></div><FormActions busy={false} onClose={onClose} submitLabel="Add gear to member"/></form></Modal>;
}

const MEMBER_ID_YEARS: string[] = memberIdYears().map(String); function MemberModal({roles,member,categories,onClose,onSaved}:{roles:{id:number;name:string}[];member:Member|null;categories:{id:number;name:string}[];onClose:()=>void;onSaved:()=>void}) { const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const [pendingGear,setPendingGear]=useState<any[]>([]); const [gearModal,setGearModal]=useState(false); const [existingGear,setExistingGear]=useState<any[]>([]); const [form,setForm]=useState<any>(member?{...member,roleIds:member.roles.map(r=>r.id)}:{memberCode:'',fullName:'',grade:'',className:'',membershipStart:new Date().toISOString().slice(0,10),status:'Active',phone:'',email:'',experience:'',skills:'',availability:'',notes:'',roleIds:[]}); const update=(k:string,v:any)=>setForm((f:any)=>({...f,[k]:v})); useEffect(()=>{ if(member?.id){ api<{data:any[]}>(`/members/${member.id}/equipment`).then(r=>setExistingGear(r.data||[])).catch(()=>{}); } else { setExistingGear([]); } },[member?.id]); const idParts=parseMemberId(form.memberCode); const idYear=idParts?idParts.year:String(new Date().getFullYear()); const idNumber=idParts?idParts.number:''; const yearOptions=MEMBER_ID_YEARS.includes(idYear)?MEMBER_ID_YEARS:[idYear,...MEMBER_ID_YEARS]; const setId=(year:string,num:string)=>update('memberCode',composeMemberId(year,num)); const save=async(e:React.FormEvent)=>{e.preventDefault();if(!MEMBER_CODE_PATTERN.test(String(form.memberCode||'').trim())){setError(MEMBER_CODE_FORMAT_MESSAGE);return;}setBusy(true);setError('');try{const result=await api<{id:number}>(member?`/members/${member.id}`:'/members',{method:member?'PATCH':'POST',body:JSON.stringify(form)});const memberId=member?member.id:result?.id;const failed:string[]=[];for(const g of pendingGear){try{await api(`/members/${memberId}/equipment`,{method:'POST',body:JSON.stringify({...g,ownership:'Personally Owned',responsibleMemberId:memberId})});}catch(err){failed.push(`${g.brand} ${g.model}: ${(err as Error).message}`);}}if(failed.length){setPendingGear((prev)=>prev.filter((_,i)=>false));setError(`Member saved as ${form.memberCode}, but ${failed.length} gear record(s) could not be saved. Add them again from the member record. Details: ${failed.join('; ')}`);setBusy(false);return;}onSaved()}catch(err){setError((err as Error).message)}finally{setBusy(false)}};return <><Modal title={member?'Edit member':'Add member'} onClose={onClose} wide><form onSubmit={save}><div className="modal-body">{error&&<div className="alert error">{error}</div>}<div className="form-grid"><div className="form-field full"><span className="form-label">Member ID</span><div className="member-id"><div className="member-id-inputs"><span className="member-id-literal">RCPAS/</span><select className="form-control member-id-year" aria-label="Batch year" value={idYear} onChange={e=>setId(e.target.value,idNumber)}>{yearOptions.map(y=><option key={y} value={y}>{y}</option>)}</select><span className="member-id-literal">/</span><input className="form-control member-id-num" aria-label="Member number" inputMode="numeric" pattern="[0-9]*" maxLength={12} placeholder="135" required value={idNumber} onChange={e=>setId(idYear,digitsOnly(e.target.value))}/></div><div className="member-id-preview">{idNumber?composeMemberId(idYear,idNumber):<span className="member-id-empty">Choose a batch year, then type the member number</span>}</div></div></div><Field label="Full name"><input className="form-control" required value={form.fullName} onChange={e=>update('fullName',e.target.value)}/></Field><Field label="Grade"><input className="form-control" required value={form.grade} onChange={e=>update('grade',e.target.value)}/></Field><Field label="Class"><input className="form-control" required value={form.className} onChange={e=>update('className',e.target.value)}/></Field><Field label="Membership start"><input type="date" className="form-control" required value={form.membershipStart} onChange={e=>update('membershipStart',e.target.value)}/></Field><Field label="Status"><select className="form-control" value={form.status} onChange={e=>update('status',e.target.value)}><option>Active</option><option>On Leave</option><option>Alumni</option><option>Inactive</option></select></Field><Field label="Email"><input type="email" className="form-control" value={form.email||''} onChange={e=>update('email',e.target.value)}/></Field><Field label="Phone"><input className="form-control" value={form.phone||''} onChange={e=>update('phone',e.target.value)}/></Field><Field label="Availability"><input className="form-control" placeholder="Weekdays after 3pm" value={form.availability||''} onChange={e=>update('availability',e.target.value)}/></Field><Field label="Experience"><input className="form-control" value={form.experience||''} onChange={e=>update('experience',e.target.value)}/></Field><Field label="Skills & interests" full><textarea className="form-control" value={form.skills||''} onChange={e=>update('skills',e.target.value)}/></Field><Field label="Organizer notes" full><textarea className="form-control" value={form.notes||''} onChange={e=>update('notes',e.target.value)}/></Field><Field label="Creative roles" full><div className="checkbox-list">{roles.map(r=><label className="check" key={r.id}><input type="checkbox" checked={form.roleIds.includes(r.id)} onChange={(e)=>update('roleIds',e.target.checked?[...form.roleIds,r.id]:form.roleIds.filter((id:number)=>id!==r.id))}/>{r.name}</label>)}</div></Field>{categories.length>0&&<div className="form-field full" style={{marginTop:10,borderTop:'1px solid var(--border)',paddingTop:16}}><div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,marginBottom:10}}><div><span className="form-label">Gear owned by this member</span><p className="small" style={{marginTop:2,color:'var(--muted)'}}>Register gear this member owns. New-member gear is held here and saved together with the member.</p></div><button type="button" className="button outline" onClick={()=>setGearModal(true)}><span className="material-symbols-outlined" style={{fontSize:16,verticalAlign:'text-bottom'}}>add</span> Register gear</button></div>{existingGear.length>0&&<div className="pending-gear-list"><div className="pending-gear-head">Saved gear ({existingGear.length})</div>{existingGear.map(g=><div className="pending-gear-item" key={g.id}><span className="pending-gear-text"><strong>{g.brand} {g.model}</strong><small>{g.equipmentCode} ┬╖ {g.categoryName}{g.focalLength?` ┬╖ ${g.focalLength}`:''}</small></span><button type="button" className="icon-button" title="Remove this gear record" onClick={async()=>{if(!confirm('Remove this gear record from the directory? It stays in reports and history.'))return;try{await api(`/equipment/${g.id}`,{method:'DELETE'});setExistingGear((list)=>list.filter((x)=>x.id!==g.id));}catch(err){setError((err as Error).message);}}}><span className="material-symbols-outlined">delete</span></button></div>)}</div>}{pendingGear.length>0&&<div className="pending-gear-list"><div className="pending-gear-head">Gear to save with this member ({pendingGear.length})</div>{pendingGear.map((g,i)=><div className="pending-gear-item" key={`p${i}`}><span className="pending-gear-text"><strong>{g.brand} {g.model}</strong><small>{categories.find(c=>c.id===g.categoryId)?.name||''}{g.focalLength?` ┬╖ ${g.focalLength}`:''} ┬╖ saved when you save the member</small></span><button type="button" className="icon-button" title="Remove this gear entry" onClick={()=>setPendingGear((list)=>list.filter((_,x)=>x!==i))}><span className="material-symbols-outlined">delete</span></button></div>)}</div>}{existingGear.length===0&&pendingGear.length===0&&<p className="small" style={{color:'var(--muted)'}}>No gear registered for this member yet.</p>}</div>}</div></div><FormActions busy={busy} onClose={onClose}/></form></Modal>{gearModal&&<MemberGearModal categories={categories} ownerLabel={form.fullName||'this member'} onClose={()=>setGearModal(false)} onAdd={(g)=>{setPendingGear((list)=>[...list,g]);}}/>}</>; }

function CreativeTeamPage() { const location=useLocation(); const members=useResource<{data:Member[];meta:any}>('/members'); const roles=useResource<{roles:{id:number;name:string}[]}>('/roles'); const [role,setRole]=useState(()=>new URLSearchParams(location.search).get('role')||''); const [search,setSearch]=useState(''); useEffect(()=>{setRole(new URLSearchParams(location.search).get('role')||'')},[location.search]); const filtered=members.data?.data.filter(m=>(!role||m.roles.some(r=>r.name===role))&&(!search||`${m.fullName} ${m.memberCode} ${m.skills||''}`.toLowerCase().includes(search.toLowerCase())))||[]; return <main className="page"><PageHeader eyebrow="Creative capability directory" title="Creative team operations" subtitle="See the member-to-role relationships that power coverage, editing, design, video, and social media work." actions={<button className="button outline" onClick={()=>window.print()}><span className="material-symbols-outlined">print</span> Print directory</button>}/><div className="toolbar"><div className="search-wrap"><span className="material-symbols-outlined">search</span><input placeholder="Search creative staffΓÇª" value={search} onChange={e=>setSearch(e.target.value)}/></div><select value={role} onChange={e=>setRole(e.target.value)}><option value="">All roles</option>{roles.data?.roles.map(r=><option key={r.id}>{r.name}</option>)}</select><button className="button outline" onClick={()=>{setRole('');setSearch('')}}>Clear filters</button></div><section className="card"><div className="card-header"><span className="card-title">Role distribution and availability</span><span className="small">{filtered.length} visible members</span></div>{members.loading?<Loading/>:members.error?<ErrorState message={members.error}/>:filtered.length?<div className="table-wrap"><table><thead><tr><th>Member</th><th>Roles</th><th>Skills & experience</th><th>Availability</th><th>Assignments</th></tr></thead><tbody>{filtered.map(m=><tr key={m.id}><td><div className="row-title">{m.fullName}</div><div className="row-subtitle">{m.memberCode} ┬╖ Grade {m.grade}</div></td><td><div style={{display:'flex',gap:4,flexWrap:'wrap'}}>{m.roles.map(r=><span className="chip green" key={r.id}>{r.name}</span>)}</div></td><td className="small">{m.skills||m.experience||'No skills recorded'}</td><td className="small">{m.availability||'Not recorded'}</td><td><button className="button ghost" onClick={()=>window.location.href=`/event-assignments?member=${m.id}`}>View workload <span className="material-symbols-outlined">arrow_forward</span></button></td></tr>)}</tbody></table></div>:<Empty label="No creative members match the current filters." icon="group_off"/>}</section></main>; }

function EventsPage() { const location = useLocation(); const [modal,setModal]=useState(false); const [notice,setNotice]=useState(''); const [search,setSearch]=useState(()=>new URLSearchParams(location.search).get('search')||''); const [status,setStatus]=useState(''); const [category,setCategory]=useState(''); const [view,setView]=useState<'list'|'calendar'>('list'); const [selectedEvent,setSelectedEvent]=useState<SocietyEvent|null>(null); const [planning,setPlanning]=useState<SocietyEvent|null>(null); const [planReload,setPlanReload]=useState(0); const removeEvent=async(id:number)=>{if(!confirm('Remove this event? It will be cancelled, its gear reservations released, and it leaves the active list. History stays in reports.'))return;try{await api(`/events/${id}`,{method:'DELETE'});setNotice('Event removed. Gear reservations released.');events.reload()}catch(e){setNotice((e as Error).message)}}; const events=useResource<{data:SocietyEvent[]}>(`/events?search=${encodeURIComponent(search)}&status=${encodeURIComponent(status)}&category=${encodeURIComponent(category)}`); const members=useResource<{data:Member[]}>('/members'); const updateStatus=async(id:number,nextStatus:string)=>{const e=events.data?.data.find(x=>x.id===id);if(!e)return;try{await api(`/events/${id}`,{method:'PATCH',body:JSON.stringify({eventCode:e.eventCode,name:e.name,description:e.description||'',category:e.category,eventDate:e.eventDate,startTime:e.startTime,venue:e.venue,organizerMemberId:e.organizerMemberId||null,priority:e.priority,requiredTeamSize:e.requiredTeamSize,additionalInstructions:e.additionalInstructions||'',photographyRequirements:e.photographyRequirements||'',creativeRequirements:e.creativeRequirements||'',status:nextStatus,isDraft:e.isDraft,notes:e.notes||'',endsAt:null})});setNotice(`Event marked ${nextStatus.toLowerCase()}.`);events.reload()}catch(err){setNotice((err as Error).message)}}; const duplicate=async(id:number)=>{try{await api(`/events/${id}/duplicate`,{method:'POST'});events.reload();setNotice('Event duplicated as a new upcoming record.')}catch(err){setNotice((err as Error).message)}}; const clear=()=>{setSearch('');setStatus('');setCategory('')}; useEffect(()=>{if(!planning)return;const fresh=(events.data?.data||[]).find((x)=>x.id===planning.id);if(fresh&&fresh.updatedAt!==planning.updatedAt)setPlanning(fresh);},[events.data,planning]); return <main className="page"><PageHeader eyebrow="Event operations ledger" title="Events management" subtitle="Plan, staff, complete, cancel, and preserve the full history of society coverage events." actions={<><div className="page-actions"><button className={`button ${view==='list'?'navy':'outline'}`} onClick={()=>setView('list')}><span className="material-symbols-outlined">view_list</span>List</button><button className={`button ${view==='calendar'?'navy':'outline'}`} onClick={()=>setView('calendar')}><span className="material-symbols-outlined">calendar_month</span>Calendar</button><button className="button primary" onClick={()=>{setSelectedEvent(null);setModal(true)}}><span className="material-symbols-outlined">add</span>Create event</button></div></>}/>{notice&&<div className="alert info">{notice}</div>}<div className="toolbar"><div className="search-wrap"><span className="material-symbols-outlined">search</span><input placeholder="Search events, venues, and event IDsΓÇª" value={search} onChange={e=>setSearch(e.target.value)}/></div><select value={status} onChange={e=>setStatus(e.target.value)}><option value="">All statuses</option><option>Planning</option><option>Ready</option><option>Confirmed</option><option>Completed</option><option>Cancelled</option></select><select value={category} onChange={e=>setCategory(e.target.value)}><option value="">All categories</option><option>School Coverage</option><option>Competition</option><option>Workshop</option><option>Ceremony</option></select><button className="button outline" onClick={clear}>Clear filters</button></div><section className="card">{events.loading?<Loading/>:events.error?<ErrorState message={events.error} retry={events.reload}/>:events.data?.data.length?(view==='list'?<div className="table-wrap"><table><thead><tr><th>Event</th><th>When & where</th><th>Staffing</th><th>Status</th><th></th></tr></thead><tbody>{events.data.data.map(e=><tr key={e.id}><td><div className="row-title">{e.name}</div><div className="row-subtitle">{e.eventCode} ┬╖ {e.category}</div></td><td><div>{e.eventDate} at {e.startTime}</div><div className="row-subtitle">{e.venue} ┬╖ {e.priority||'Normal'} priority{e.isDraft?' ┬╖ draft':''}</div></td><td><span className="chip slate">{e.assignmentCount} crew</span><span className="chip slate">{e.equipmentCount} gear</span></td><td><span className={`chip ${statusClass(e.status)}`}>{e.status}</span></td><td><div className="table-actions"><button className="icon-button" title="Open the planning workspace" onClick={()=>{setPlanReload((n)=>n+1);setPlanning(e)}}><span className="material-symbols-outlined">workflow</span></button><button className="icon-button" title="Edit event" onClick={()=>{setSelectedEvent(e);setModal(true)}}><span className="material-symbols-outlined">edit</span></button><button className="icon-button" title="Assign crew" onClick={()=>window.location.href=`/event-assignments?event=${e.id}`}><span className="material-symbols-outlined">group_add</span></button><button className="icon-button" title="Duplicate" onClick={()=>duplicate(e.id)}><span className="material-symbols-outlined">content_copy</span></button>{['Planning','Ready','Confirmed'].includes(e.status)&&<button className="icon-button" title="Mark completed" onClick={()=>updateStatus(e.id,'Completed')}><span className="material-symbols-outlined">task_alt</span></button>}{e.status!=='Cancelled'&&<button className="icon-button" title="Cancel event" onClick={()=>{if(confirm('Cancel this event while preserving its history?'))updateStatus(e.id,'Cancelled')}}><span className="material-symbols-outlined">event_busy</span></button>}{e.status!=='Cancelled'&&<button className="icon-button" title="Remove event (cancel + release gear)" onClick={()=>removeEvent(e.id)}><span className="material-symbols-outlined">delete</span></button>}</div></td></tr>)}</tbody></table></div>:<div className="card-body"><div className="split-grid">{events.data.data.map(e=><article className="card" key={e.id}><div className="card-body"><div className="eyebrow"><span className="dot"/>{e.eventDate} ┬╖ starts {e.startTime} (SL time)</div><h3 style={{marginTop:8}}>{e.name}</h3><p className="small">{e.venue}{e.priority&&e.priority!=='Normal'?` ┬╖ ${e.priority} priority`:''}{e.isDraft?' ┬╖ draft':''}</p><div style={{display:'flex',gap:6,marginTop:12}}><span className={`chip ${statusClass(e.status)}`}>{e.status}</span><span className="chip slate">{e.assignmentCount} crew</span></div><div style={{display:'flex',gap:6,marginTop:15}}><button className="button outline" onClick={()=>window.location.href=`/event-assignments?event=${e.id}`}>Staff event</button><button className="button ghost" onClick={()=>duplicate(e.id)}>Duplicate</button><button className="button ghost" style={{color:"var(--danger,#b91c1c)"}} onClick={()=>removeEvent(e.id)}>Remove</button></div></div></article>)}</div></div>):<Empty label="No events match the current filters." icon="event_busy"/>}</section>{modal&&<EventModal event={selectedEvent} members={members.data?.data||[]} onClose={()=>setModal(false)} onSaved={()=>{setModal(false);events.reload();setPlanReload((n)=>n+1);setNotice('Event saved successfully.')}}/>}{planning&&<EventPlanPanel event={planning} reloadKey={planReload} onClose={()=>{setPlanning(null);events.reload()}} onEdit={()=>{setSelectedEvent(planning);setModal(true)}} onMessage={setNotice}/>}</main>; }

function EventModal({event,members,onClose,onSaved}:{event?:SocietyEvent|null;members:Member[];onClose:()=>void;onSaved:()=>void}) {const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [form,setForm]=useState<any>(event?{eventCode:event.eventCode,name:event.name,description:event.description||'',category:event.category,eventDate:event.eventDate,startTime:event.startTime,venue:event.venue,organizerMemberId:event.organizerMemberId||null,priority:event.priority||'Normal',requiredTeamSize:event.requiredTeamSize||0,additionalInstructions:event.additionalInstructions||'',photographyRequirements:event.photographyRequirements||'',creativeRequirements:event.creativeRequirements||'',status:event.status,isDraft:event.isDraft,notes:event.notes||''}:{eventCode:`EVT-${new Date().getFullYear()}-`,name:'',description:'',category:'School Coverage',eventDate:new Date().toISOString().slice(0,10),startTime:'09:00',venue:'',organizerMemberId:null,priority:'Normal',requiredTeamSize:0,additionalInstructions:'',photographyRequirements:'',creativeRequirements:'',status:'Planning',isDraft:true,notes:''});const u=(k:string,v:any)=>setForm((f:any)=>({...f,[k]:v}));const save=async(e:React.FormEvent)=>{e.preventDefault();setBusy(true);setError('');try{await api(event?`/events/${event.id}`:'/events',{method:event?'PATCH':'POST',body:JSON.stringify({...form,organizerMemberId:form.organizerMemberId?Number(form.organizerMemberId):null,requiredTeamSize:Number(form.requiredTeamSize)||0,endsAt:null})});onSaved()}catch(err){setError((err as Error).message)}finally{setBusy(false)}};const saveDraft=async()=>{setBusy(true);setError('');try{await api(event?`/events/${event.id}`:'/events',{method:event?'PATCH':'POST',body:JSON.stringify({...form,isDraft:true,status:'Planning',organizerMemberId:form.organizerMemberId?Number(form.organizerMemberId):null,requiredTeamSize:Number(form.requiredTeamSize)||0,endsAt:null})});onSaved()}catch(err){setError((err as Error).message)}finally{setBusy(false)}};return <Modal title={event?'Edit event':'Create new event'} onClose={onClose} wide><form onSubmit={save}><div className="modal-body">{error&&<div className="alert error">{error}</div>}<div className="form-grid"><Field label="Event ID"><input className="form-control" required value={form.eventCode} onChange={e=>u('eventCode',e.target.value)}/></Field><Field label="Event name" full><input className="form-control" required minLength={2} value={form.name} onChange={e=>u('name',e.target.value)}/></Field><Field label="Category / type"><input className="form-control" required value={form.category} onChange={e=>u('category',e.target.value)}/></Field><Field label="Description and purpose"><input className="form-control" value={form.description} onChange={e=>u('description',e.target.value)}/></Field><Field label="Event date"><input type="date" className="form-control" required value={form.eventDate} onChange={e=>u('eventDate',e.target.value)}/></Field><Field label="Start time (Sri Lanka)"><input type="time" className="form-control" required value={form.startTime} onChange={e=>u('startTime',e.target.value)}/></Field><Field label="Venue"><input className="form-control" required minLength={2} value={form.venue} onChange={e=>u('venue',e.target.value)}/></Field><Field label="Organizing teacher / official"><select className="form-control" value={form.organizerMemberId||''} onChange={e=>u('organizerMemberId',e.target.value)}><option value="">Not assigned</option>{members.map(m=><option key={m.id} value={m.id}>{m.fullName}</option>)}</select></Field><Field label="Priority"><select className="form-control" value={form.priority} onChange={e=>u('priority',e.target.value)}><option>Low</option><option>Normal</option><option>High</option><option>Critical</option></select></Field><Field label="Required team size"><input type="number" min="0" max="500" className="form-control" value={form.requiredTeamSize} onChange={e=>u('requiredTeamSize',e.target.value)}/></Field><Field label="Event status"><select className="form-control" value={form.status} onChange={e=>u('status',e.target.value)}><option>Planning</option><option>Ready</option><option>Confirmed</option><option>Completed</option><option>Cancelled</option></select></Field><Field label="Required creative roles (one per line or comma separated)" full><textarea className="form-control" placeholder="Lead Photographer&#10;Photo Editor&#10;Videographer" value={form.creativeRequirements} onChange={e=>u('creativeRequirements',e.target.value)}/></Field><Field label="Required equipment" full><textarea className="form-control" placeholder="70-200mm lens, tripod, flash" value={form.photographyRequirements} onChange={e=>u('photographyRequirements',e.target.value)}/></Field><Field label="Additional instructions" full><textarea className="form-control" value={form.additionalInstructions} onChange={e=>u('additionalInstructions',e.target.value)}/></Field><Field label="Notes" full><textarea className="form-control" value={form.notes} onChange={e=>u('notes',e.target.value)}/></Field></div><div className="alert info" style={{marginTop:12}}><strong>Single-day events.</strong> This form records one date and one start time. No end time or duration is required. The system can flag members already assigned to another event on the same date, but it cannot determine whether two events actually overlap in time without an optional end time.</div></div><div className="modal-footer"><button type="button" className="button outline" onClick={onClose}>Cancel</button><button type="button" className="button outline" disabled={busy} onClick={saveDraft}>Save draft</button><button type="submit" className="button primary" disabled={busy}>{busy?'SavingΓÇª':'Save event'}</button></div></form></Modal>}

function AssignmentsPage() { const location=useLocation(); const [eventId,setEventId]=useState(()=>new URLSearchParams(location.search).get('event')||''); const [statusFilter,setStatusFilter]=useState(''); const assignments=useResource<{data:Assignment[]}>(`/assignments?eventId=${encodeURIComponent(eventId)}&status=${encodeURIComponent(statusFilter)}`); const events=useResource<{data:SocietyEvent[]}>('/events'); const members=useResource<{data:Member[]}>('/members'); const [modal,setModal]=useState(false); const [notice,setNotice]=useState(''); const setStatus=async(id:number,status:string)=>{try{const r=await apiRaw(`/assignments/${id}/contact`,{method:'PATCH',body:JSON.stringify({status})});if(!r.ok)throw new Error((r.body as any).error||'Could not update the response status.');setNotice('Response status updated and recorded in the audit log.');assignments.reload()}catch(e){setNotice((e as Error).message)}}; const cancel=async(id:number)=>{if(!confirm('Cancel this assignment?'))return;try{await api(`/assignments/${id}`,{method:'DELETE'});assignments.reload();setNotice('Assignment cancelled.')}catch(e){setNotice((e as Error).message)}};return <main className="page"><PageHeader eyebrow="Crew deployment and workload" title="Event assignments" subtitle="Assign real members to event responsibilities with conflict warnings, availability checks, and recorded overrides." actions={<button className="button primary" onClick={()=>setModal(true)}><span className="material-symbols-outlined">group_add</span>Assign creative team</button>}/>{notice&&<div className="alert info">{notice}</div>}<div className="toolbar"><select value={eventId} onChange={e=>setEventId(e.target.value)}><option value="">All events</option>{(events.data?.data||[]).map(e=><option key={e.id} value={e.id}>{e.name} ┬╖ {e.eventDate}</option>)}</select><select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}><option value="">All statuses</option>{['Proposed','Contact Pending','Contacted','Confirmed','Declined','Reassignment Needed','Completed','Cancelled'].map(s=><option key={s}>{s}</option>)}</select><button className="button outline" onClick={()=>{setEventId('');setStatusFilter('')}}>Clear filters</button></div><section className="card">{assignments.loading?<Loading/>:assignments.error?<ErrorState message={assignments.error} retry={assignments.reload}/>:assignments.data?.data.length?<div className="table-wrap"><table><thead><tr><th>Member</th><th>Event</th><th>Responsibility</th><th>Status</th><th>Response recorded</th><th></th></tr></thead><tbody>{assignments.data.data.map(a=><tr key={a.id}><td><div className="row-title">{a.memberName}</div><div className="row-subtitle">{(a as any).memberCode||`Member #${a.memberId}`}</div></td><td><div className="row-title">{a.eventName}</div><div className="row-subtitle">{(a as any).eventDate||new Date(a.startsAt).toLocaleDateString()} at {(a as any).startTime||new Date(a.startsAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div></td><td>{a.responsibility}</td><td><span className={`chip ${statusClass(a.status)}`}>{a.status}</span></td><td><div className="small">{(a as any).contactedAt?`Contacted ${new Date((a as any).contactedAt).toLocaleString()}`:'Not contacted'}</div>{(a as any).confirmedAt&&<div className="small">Confirmed {new Date((a as any).confirmedAt).toLocaleString()}</div>}</td><td><div className="table-actions"><button className="icon-button" title="Mark contacted" onClick={()=>setStatus(a.id,'Contacted')}><span className="material-symbols-outlined">call</span></button><button className="icon-button" title="Mark confirmed" onClick={()=>setStatus(a.id,'Confirmed')}><span className="material-symbols-outlined">task_alt</span></button><button className="icon-button" title="Mark declined" onClick={()=>setStatus(a.id,'Declined')}><span className="material-symbols-outlined">thumb_down</span></button><button className="icon-button" title="Cancel assignment" onClick={()=>cancel(a.id)}><span className="material-symbols-outlined">cancel</span></button></div></td></tr>)}</tbody></table></div>:<Empty label="No assignments match the current filters." icon="assignment_late"/>}</section>{modal&&<AssignmentModal events={events.data?.data||[]} members={members.data?.data||[]} onClose={()=>setModal(false)} onSaved={(message)=>{setModal(false);assignments.reload();setNotice(message)}}/>}</main>; }
function MemberPicker({value,onChange}:{value:string;onChange:(id:string)=>void}) {
  const [query,setQuery]=useState('');
  const [results,setResults]=useState<any[]>([]);
  const [loading,setLoading]=useState(false);
  const [open,setOpen]=useState(false);
  useEffect(()=>{
    let cancelled=false; setLoading(true);
    const t=window.setTimeout(()=>{
      api<{data:any[]}>(`/members?search=${encodeURIComponent(query.trim())}&pageSize=25&sort=name`)
        .then((r)=>{ if(!cancelled){ setResults(r.data||[]); setLoading(false);} })
        .catch(()=>{ if(!cancelled){ setResults([]); setLoading(false);} });
    },300);
    return ()=>{ cancelled=true; window.clearTimeout(t); };
  },[query]);
  const selected=results.find((m)=>String(m.id)===value);
  return <div className="member-picker">
    <input className="form-control" placeholder="Search member or gear (e.g. 70-200, Canon, tripod)" value={query} onChange={(e)=>{setQuery(e.target.value);setOpen(true);}} onFocus={()=>setOpen(true)}/>
    {selected&&<div className="mp-selected">Selected: <strong>{selected.fullName}</strong> ┬╖ {selected.memberCode}{selected.equipment?` ΓÇö ${selected.equipment}`:''}</div>}
    {open&&<div className="mp-results">
      {loading&&<div className="mp-note">SearchingΓÇª</div>}
      {!loading&&results.length===0&&<div className="mp-note">No members match. Try a name, role, or gear term like 70-200.</div>}
      {results.map((m)=><button type="button" key={m.id} className={`mp-item${String(m.id)===value?' active':''}`} onClick={()=>{onChange(String(m.id));setOpen(false);}}>
        <div className="mp-head"><strong>{m.fullName}</strong><span className="mp-code">{m.memberCode}</span><span className="mp-status">{m.status}</span></div>
        {m.roles&&m.roles.length?<div className="mp-sub">{m.roles.map((r:any)=>r.name).join(' ┬╖ ')}</div>:null}
        {m.equipment?<div className="mp-gear">Gear: {m.equipment}</div>:(m.equipmentCount?<div className="mp-gear">{m.equipmentCount} gear item(s)</div>:<div className="mp-sub">No gear registered</div>)}
      </button>)}
    </div>}
  </div>;
}
function AssignmentModal({events,members,onClose,onSaved}:{events:SocietyEvent[];members:Member[];onClose:()=>void;onSaved:(message:string)=>void}) {const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [form,setForm]=useState<any>({eventId:'',memberId:'',responsibility:'Lead Photographer',status:'Proposed',notes:'',overrideWarnings:false,overrideReason:''});const u=(k:string,v:any)=>setForm((f:any)=>({...f,[k]:v}));const save=async(e:React.FormEvent)=>{e.preventDefault();if(!form.memberId){setError('Pick a member from the search results before assigning.');return;}setBusy(true);try{const r=await api<{warnings?:string[]}>('/assignments',{method:'POST',body:JSON.stringify({...form,eventId:Number(form.eventId),memberId:Number(form.memberId)})});onSaved(r.warnings?.length?'Assignment saved with authorized warning override.':'Assignment saved successfully.')}catch(err){setError((err as Error).message)}finally{setBusy(false)}};return <Modal title="Assign creative team" onClose={onClose}><form onSubmit={save}><div className="modal-body">{error&&<div className="alert error">{error}<div style={{marginTop:8}}><label className="check"><input type="checkbox" checked={form.overrideWarnings} onChange={e=>u('overrideWarnings',e.target.checked)}/> I have permission to override a scheduling warning</label>{form.overrideWarnings&&<input className="form-control" style={{marginTop:8}} required placeholder="Reason for override" value={form.overrideReason} onChange={e=>u('overrideReason',e.target.value)}/>}</div></div>}<div className="form-grid"><Field label="Event" full><select className="form-control" required value={form.eventId} onChange={e=>u('eventId',e.target.value)}><option value="">Select event</option>{events.filter(e=>e.status!=='Cancelled').map(e=><option key={e.id} value={e.id}>{e.name} ┬╖ {e.eventDate} at {e.startTime}</option>)}</select></Field><Field label="Member" full><MemberPicker value={form.memberId} onChange={(id)=>u('memberId',id)}/></Field><Field label="Responsibility" full><select className="form-control" value={form.responsibility} onChange={e=>u('responsibility',e.target.value)}>{['Lead Photographer','Photographer','Second Shooter','Assistant Photographer','Photo Editor','Graphic Designer','Videographer','Social Media Creator','Event Coordinator','Equipment Coordinator'].map(r=><option key={r}>{r}</option>)}</select></Field><Field label="Status"><select className="form-control" value={form.status} onChange={e=>u('status',e.target.value)}><option>Contact Pending</option><option>Proposed</option><option>Contacted</option><option>Confirmed</option><option>Declined</option><option>Reassignment Needed</option><option>Completed</option></select></Field><Field label="Assignment notes"><input className="form-control" value={form.notes} onChange={e=>u('notes',e.target.value)}/></Field></div></div><FormActions busy={busy} onClose={onClose}/></form></Modal>}

/** Contact / profile detail for one gear owner, shown from the Gear Directory. */
function OwnerModal({hit,mode,events,contactsVisible,onClose,onMessage}:{hit:any;mode:'view'|'contact';events:SocietyEvent[];contactsVisible:boolean;onClose:()=>void;onMessage:(m:string,kind?:'info'|'error')=>void}) {
  const owner=hit.owner;
  const [eventId,setEventId]=useState('');
  const [copied,setCopied]=useState('');
  const chosen=events.find((e)=>String(e.id)===eventId);
  const gearLabel=`${hit.brand} ${hit.model}${hit.focalLength?` (${hit.focalLength})`:''}`;
  const draft=chosen?`Hello ${owner.fullName}, we would like to request your ${gearLabel} for ${chosen.name} on ${chosen.eventDate} starting at ${chosen.startTime} at ${chosen.venue}. Your assigned role is still to be confirmed. Could you bring it? Please reply so we can mark it as confirmed.`:'Choose an event to prepare a request message.';
  const phone=contactsVisible?(owner.phone||''):''; const email=contactsVisible?(owner.email||''):'';
  const wa=phone?`https://wa.me/${phone.replace(/[^0-9]/g,'')}`:'';
  const copy=async(text:string,label:string)=>{try{await navigator.clipboard.writeText(text);setCopied(label);onMessage(`${label} copied to the clipboard. Nothing has been sent.`);}catch{onMessage('The browser blocked clipboard access. Select and copy manually.','error');}};
  return <Modal title={mode==='contact'?`Contact ${owner.fullName}`:`${owner.fullName}`} onClose={onClose}>
    <div className="modal-body">
      <div className="form-grid">
        <div><div className="eyebrow">Member ID</div><strong>{owner.memberCode}</strong></div>
        <div><div className="eyebrow">Grade / class</div><strong>{owner.grade} {owner.className}</strong></div>
        <div><div className="eyebrow">Member status</div><span className={`chip ${statusClass(owner.status)}`}>{owner.status}</span></div>
        <div><div className="eyebrow">Availability</div><strong>{owner.availability||'Not specified'}</strong></div>
        <div><div className="eyebrow">Creative roles</div><strong>{owner.roles?.join(', ')||'None recorded'}</strong></div>
        <div><div className="eyebrow">Gear record</div><strong>{hit.equipmentCode}</strong></div>
        <div><div className="eyebrow">Gear</div><strong>{gearLabel}</strong></div>
        <div><div className="eyebrow">Availability for this gear</div><strong>{hit.availability}</strong></div>
      </div>
      {owner.assignmentsOnDate>0&&<div className="alert info" style={{marginTop:12}}>This owner already has {owner.assignmentsOnDate} assignment(s) on that event date. Only dates and start times are stored, so no time overlap is claimed.</div>}

      {mode==='contact'&&<>
        <div className="eyebrow" style={{marginTop:16}}>Contact details</div>
        {!contactsVisible
          ? <div className="alert info" style={{marginTop:8}}>Your role does not hold the <code>contacts.read</code> permission, so contact details are hidden.</div>
          : (phone||email
            ? <div className="form-grid" style={{marginTop:8}}>
                <div><div className="eyebrow">Phone</div><strong>{phone||'Not recorded'}</strong></div>
                <div><div className="eyebrow">Email</div><strong>{email||'Not recorded'}</strong></div>
              </div>
            : <div className="alert info" style={{marginTop:8}}>This member has no phone or email on file.</div>)}

        <div className="eyebrow" style={{marginTop:16}}>Prepare a request message</div>
        <select className="form-control" style={{marginTop:8}} value={eventId} onChange={(e)=>setEventId(e.target.value)}>
          <option value="">Choose an eventΓÇª</option>
          {events.map((e)=><option key={e.id} value={e.id}>{e.name} ┬╖ {e.eventDate} ┬╖ {e.startTime}</option>)}
        </select>
        <pre style={{whiteSpace:'pre-wrap',marginTop:10}} className="small">{draft}</pre>
        <div className="toolbar" style={{marginTop:10}}>
          <button className="button outline" disabled={!chosen} onClick={()=>copy(draft,'Message draft')}><span className="material-symbols-outlined">content_copy</span> Copy message</button>
          <button className="button outline" disabled={!contactsVisible||(!phone&&!email)} onClick={()=>copy(`${owner.fullName} ΓÇö ${phone||'no phone'} ΓÇö ${email||'no email'}`,'Contact details')}><span className="material-symbols-outlined">contact_page</span> Copy contact details</button>
          {wa&&<a className="button outline" href={wa} target="_blank" rel="noreferrer"><span className="material-symbols-outlined">chat</span> Open WhatsApp</a>}
        </div>
        <p className="small" style={{marginTop:10,marginBottom:0}}>Opening WhatsApp or copying text does not send a message. The system only ever records a status you set yourself ΓÇö it never claims a message was delivered or read.</p>
        {copied&&<div className="alert info" style={{marginTop:10}}>{copied} copied.</div>}
      </>}
    </div>
  </Modal>;
}

/** Request a member's gear for one event: adds the requirement, then asks the owner. */
function RequestForEventModal({hit,events,onClose,onMessage,onDone}:{hit:any;events:SocietyEvent[];onClose:()=>void;onMessage:(m:string,kind?:'info'|'error')=>void;onDone:()=>void}) {
  const [eventId,setEventId]=useState(events[0]?String(events[0].id):'');
  const [priority,setPriority]=useState('Required');
  const [quantity,setQuantity]=useState('1');
  const [notes,setNotes]=useState('');
  const [busy,setBusy]=useState(false);
  const label=`${hit.brand} ${hit.model}${hit.focalLength?` (${hit.focalLength})`:''}`;
  const chosen=events.find((e)=>String(e.id)===eventId);
  const submit=async()=>{
    if(!chosen){onMessage('Choose the event you are requesting this gear for.','error');return;}
    setBusy(true);
    const requirement=await apiRaw(`/events/${chosen.id}/requirements`,{method:'POST',body:JSON.stringify({description:label,equipmentId:hit.equipmentId,quantity:Number(quantity)||1,priority,notes:notes.trim()})});
    const duplicate=(requirement.body as any)?.code==='DUPLICATE_REQUIREMENT';
    if(!requirement.ok&&!duplicate){setBusy(false);onMessage((requirement.body as any).error||'Could not add the gear requirement.','error');return;}
    const commitment=await apiRaw(`/events/${chosen.id}/commitments`,{method:'POST',body:JSON.stringify({equipmentId:hit.equipmentId,status:'Awaiting Confirmation',notes:notes.trim()})});
    setBusy(false);
    onDone();
    if(!commitment.ok){
      const detail=(commitment.body as any).error||'unknown error';
      onMessage(`The requirement ${duplicate?'already existed and was reused':'was saved'}, but the request could not be recorded: ${detail}`,'error');
      onClose();
      return;
    }
    onMessage(`Requested for ${chosen.name}. Recorded as Awaiting Response ΓÇö the owner has not confirmed yet.`);
    onClose();
  };
  return <Modal title="Request gear for an event" onClose={onClose}>
    <div className="modal-body">
      <div className="alert info">You are requesting <strong>{label}</strong>, owned by <strong>{hit.owner.fullName}</strong> ({hit.owner.memberCode}). The gear record is reused ΓÇö no duplicate is created.</div>
      <div className="form-grid">
        <Field label="Event" full><select className="form-control" value={eventId} onChange={(e)=>setEventId(e.target.value)}>
          <option value="">Choose an eventΓÇª</option>
          {events.filter((e)=>e.status!=='Cancelled').map((e)=><option key={e.id} value={e.id}>{e.name} ┬╖ {e.eventDate} ┬╖ {e.startTime}</option>)}
        </select></Field>
        <Field label="Quantity"><input className="form-control" type="number" min={1} value={quantity} onChange={(e)=>setQuantity(e.target.value)}/></Field>
        <Field label="Priority"><select className="form-control" value={priority} onChange={(e)=>setPriority(e.target.value)}><option>Optional</option><option>Required</option><option>Critical</option></select></Field>
        <Field label="Notes to the owner" full><input className="form-control" value={notes} onChange={(e)=>setNotes(e.target.value)} placeholder="Anything the owner should know"/></Field>
      </div>
      <p className="small" style={{marginTop:10,marginBottom:0}}>This adds the requirement to the event and records the gear as <strong>Awaiting Response</strong>. Nothing is treated as confirmed until the owner confirms.</p>
      <div className="toolbar" style={{marginTop:12}}>
        <button className="button primary" disabled={busy||!chosen} onClick={submit}><span className="material-symbols-outlined">event_available</span> Request for event</button>
        <button className="button outline" onClick={onClose}>Cancel</button>
      </div>
    </div>
  </Modal>;
}

/** Module 2 ΓÇö the Gear Directory: member-owned gear, searchable and reusable across events. */
function EquipmentPage() {
  const eqLocation = useLocation();
  const [search,setSearch]=useState(()=>new URLSearchParams(eqLocation.search).get('search')||'');
  const [debounced,setDebounced]=useState(()=>new URLSearchParams(eqLocation.search).get('search')||'');
  const [categoryId,setCategoryId]=useState('');
  const [availability,setAvailability]=useState('');
  const [ownership,setOwnership]=useState('');
  const [role,setRole]=useState('');
  const [grade,setGrade]=useState('');
  const [eventId,setEventId]=useState('');
  const [confirmationStatus,setConfirmationStatus]=useState('');
  const [modal,setModal]=useState(false);
  const [allocationModal,setAllocationModal]=useState(false);
  const [showAllocations,setShowAllocations]=useState(false);
  const [notice,setNotice]=useState('');
  const [viewOwner,setViewOwner]=useState<any|null>(null);
  const [contactOwner,setContactOwner]=useState<any|null>(null);
  const [requestGear,setRequestGear]=useState<any|null>(null);
  useEffect(()=>{const t=setTimeout(()=>setDebounced(search),300);return ()=>clearTimeout(t);},[search]);

  const categories=useResource<{categories:{id:number;name:string}[]}>('/equipment/categories');
  const roleGroups=useResource<{groups:{key:string;count:number}[]}>('/members/groups?by=role');
  const gradeGroups=useResource<{groups:{key:string;count:number}[]}>('/members/groups?by=grade');
  const events=useResource<{data:SocietyEvent[]}>('/events');
  const members=useResource<{data:Member[]}>('/members?pageSize=100',modal);
  const allocations=useResource<{data:any[]}>('/equipment/allocations',showAllocations);
  const allocationInventory=useResource<{data:Equipment[]}>('/equipment?pageSize=1000',allocationModal);

  const selectedEvent=(events.data?.data||[]).find((e)=>String(e.id)===eventId);
  const query=new URLSearchParams({q:debounced,limit:'100'});
  if(categoryId) query.set('categoryId',categoryId);
  if(availability) query.set('availability',availability);
  if(ownership) query.set('ownership',ownership);
  if(role) query.set('role',role);
  if(grade){const parts=grade.split(' - ');query.set('grade',parts[0]);if(parts[1]) query.set('className',parts[1]);}
  if(eventId){query.set('eventId',eventId);if(selectedEvent) query.set('date',selectedEvent.eventDate);if(confirmationStatus) query.set('confirmationStatus',confirmationStatus);}
  const hits=useResource<{data:any[];contactsVisible:boolean}>(`/equipment/search?${query.toString()}`);

  const rows=hits.data?.data||[];
  const contactsVisible=Boolean(hits.data?.contactsVisible);
  const clear=()=>{setSearch('');setDebounced('');setCategoryId('');setAvailability('');setOwnership('');setRole('');setGrade('');setEventId('');setConfirmationStatus('');};
  const archive=async(id:number)=>{if(!confirm('Remove this gear record from the directory? It leaves the directory and active lists, but stays in reports and history.'))return;try{await api(`/equipment/${id}`,{method:'DELETE'});hits.reload();setNotice('Gear record removed from the directory.');}catch(e){setNotice((e as Error).message);}};

  return <main className="page">
    <PageHeader eyebrow="Member-owned gear directory" title="Gear directory" subtitle="Every item belongs to a registered member and is reused across events ΓÇö never duplicated. Search by brand, model, focal length, category or keyword, then find the owner, contact them, and request the gear for an event."
      actions={<><a className="button outline" href="/api/equipment/export.csv"><span className="material-symbols-outlined">download</span> Export gear directory (CSV)</a><button className="button outline" onClick={()=>setShowAllocations(!showAllocations)}><span className="material-symbols-outlined">assignment</span> {showAllocations?'Hide':'View'} legacy allocations</button><button className="button primary" onClick={()=>setModal(true)}><span className="material-symbols-outlined">add</span> Register gear</button></>}/>
    {notice&&<div className="alert info">{notice}</div>}

    <section className="card" style={{marginBottom:16}}>
      <div className="card-body">
        <div className="search-wrap" style={{marginBottom:12}}><span className="material-symbols-outlined">search</span><input placeholder="Search gear: 70-200, Canon 70-200, Sony lens, telephoto lens, tripod, flash, gimbalΓÇª" value={search} onChange={(e)=>setSearch(e.target.value)}/></div>
        <div className="toolbar" style={{margin:0}}>
          <select value={categoryId} onChange={(e)=>setCategoryId(e.target.value)}><option value="">All categories</option>{(categories.data?.categories||[]).map((c)=><option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <select value={role} onChange={(e)=>setRole(e.target.value)}><option value="">Any owner role</option>{(roleGroups.data?.groups||[]).map((g)=><option key={g.key} value={g.key}>{g.key} ({g.count})</option>)}</select>
          <select value={grade} onChange={(e)=>setGrade(e.target.value)}><option value="">Any grade / class</option>{(gradeGroups.data?.groups||[]).map((g)=><option key={g.key} value={g.key}>{g.key} ({g.count})</option>)}</select>
          <select value={availability} onChange={(e)=>setAvailability(e.target.value)}><option value="">Any availability</option><option>Available</option><option>Allocated</option><option>Unavailable</option></select>
          <select value={ownership} onChange={(e)=>setOwnership(e.target.value)}><option value="">Any ownership</option><option>Society Owned</option><option>Personally Owned</option></select>
          <select value={eventId} onChange={(e)=>{setEventId(e.target.value);setConfirmationStatus('');}}><option value="">Event confirmation: off</option>{(events.data?.data||[]).filter((e)=>e.status!=='Cancelled').map((e)=><option key={e.id} value={e.id}>{e.name} ┬╖ {e.eventDate}</option>)}</select>
          {eventId&&<select value={confirmationStatus} onChange={(e)=>setConfirmationStatus(e.target.value)}><option value="">Any confirmation status</option><option>Not Requested</option><option>Awaiting Confirmation</option><option>Confirmed</option><option>Declined</option><option>Unavailable</option></select>}
          <button className="button outline" onClick={clear}>Clear filters</button>
        </div>
        <p className="small" style={{marginTop:10,marginBottom:0}}>{rows.length} record(s) match the current filters.{selectedEvent?` Availability is evaluated against ${selectedEvent.name} on ${selectedEvent.eventDate}.`:''}</p>
      </div>
    </section>

    {showAllocations&&<AllocationPanel resource={allocations} onNew={()=>setAllocationModal(true)} onChanged={allocations.reload}/>}

    <section className="card">
      {hits.loading?<Loading/>:hits.error?<ErrorState message={hits.error} retry={hits.reload}/>:rows.length?
      <div className="table-wrap"><table><thead><tr><th>Gear</th><th>Owner</th><th>Creative roles</th><th>Condition</th><th>Availability</th>{eventId&&<th>Confirmation</th>}<th></th></tr></thead><tbody>
        {rows.map((h)=><tr key={h.equipmentId}>
          <td><div className="row-title">{h.brand} {h.model}{h.focalLength?` ┬╖ ${h.focalLength}`:''}</div><div className="row-subtitle">{h.itemName?`${h.itemName} ┬╖ `:''}{h.categoryName}{h.lensMount?` ┬╖ ${h.lensMount}`:''} ┬╖ {h.ownership}</div></td>
          <td>{h.owner.id?<><div className="row-title">{h.owner.fullName}</div><div className="row-subtitle">{h.owner.memberCode} ┬╖ Grade {h.owner.grade} {h.owner.className}</div></>:<span className="small">No member owner recorded</span>}</td>
          <td>{h.owner.roles?.length?h.owner.roles.join(', '):'ΓÇö'}</td>
          <td><span className={`chip ${statusClass(h.conditionStatus)}`}>{h.conditionStatus||'ΓÇö'}</span></td>
          <td><span className={`chip ${statusClass(h.availability)}`}>{h.availability}</span>{h.owner.assignmentsOnDate>0&&<div className="row-subtitle">Owner is assigned elsewhere that day</div>}</td>
          {eventId&&<td>{h.commitment?<span className={`chip ${statusClass(h.commitment.status)}`}>{h.commitment.status}</span>:<span className="small">Not Requested</span>}</td>}
          <td><div className="table-actions">
            <button className="icon-button" title="View owner" disabled={!h.owner.id} onClick={()=>setViewOwner(h)}><span className="material-symbols-outlined">person_search</span></button>
            <button className="icon-button" title="Contact owner" disabled={!h.owner.id} onClick={()=>setContactOwner(h)}><span className="material-symbols-outlined">contact_phone</span></button>
            <button className="icon-button" title="Request this gear for an event" disabled={!h.owner.id} onClick={()=>setRequestGear(h)}><span className="material-symbols-outlined">event_available</span></button>
            <button className="icon-button" title="Remove gear record" onClick={()=>archive(h.equipmentId)}><span className="material-symbols-outlined">delete</span></button>
          </div></td>
        </tr>)}
      </tbody></table></div>
      :<Empty label={debounced||categoryId||role||grade||availability||ownership||eventId?`No gear matches the current search and filters.`:'No gear records have been registered yet. Register gear from a member profile or use Register gear.'} icon="photo_camera"/>}
    </section>

    {viewOwner&&<OwnerModal hit={viewOwner} mode="view" events={events.data?.data||[]} contactsVisible={contactsVisible} onClose={()=>setViewOwner(null)} onMessage={setNotice}/>}
    {contactOwner&&<OwnerModal hit={contactOwner} mode="contact" events={events.data?.data||[]} contactsVisible={contactsVisible} onClose={()=>setContactOwner(null)} onMessage={setNotice}/>}
    {requestGear&&<RequestForEventModal hit={requestGear} events={events.data?.data||[]} onClose={()=>setRequestGear(null)} onMessage={setNotice} onDone={()=>hits.reload()}/>}
    {modal&&<EquipmentModal categories={categories.data?.categories||[]} members={members.data?.data||[]} onClose={()=>setModal(false)} onSaved={()=>{setModal(false);hits.reload();setNotice('Gear registered successfully.');}}/>}
    {allocationModal&&<AllocationModal equipment={allocationInventory.data?.data||[]} events={events.data?.data||[]} onClose={()=>setAllocationModal(false)} onSaved={()=>{setAllocationModal(false);allocations.reload();hits.reload();setNotice('Equipment allocation saved successfully.');}}/>}
  </main>;
}
function AllocationPanel({resource,onNew,onChanged}:{resource:{data?:{data:any[]};loading:boolean;error?:string;reload:()=>void};onNew:()=>void;onChanged:()=>void}) { const returnItem=async(id:number)=>{if(!confirm('Record this item as returned?'))return;try{await api(`/equipment/allocations/${id}/return`,{method:'POST',body:JSON.stringify({returnStatus:'Returned'})});onChanged()}catch(e){alert((e as Error).message)}}; return <section className="card" style={{marginBottom:16}}><div className="card-header"><span className="card-title">Equipment allocation ledger</span><button className="button primary" onClick={onNew}><span className="material-symbols-outlined">add</span>Allocate to event</button></div>{resource.loading?<Loading/>:resource.error?<ErrorState message={resource.error} retry={resource.reload}/>:resource.data?.data.length?<div className="table-wrap"><table><thead><tr><th>Equipment</th><th>Event</th><th>Issued</th><th>Return status</th><th></th></tr></thead><tbody>{resource.data.data.map(a=><tr key={a.id}><td>{a.equipmentCode}</td><td>{a.eventName}</td><td>{a.issuedAt?new Date(a.issuedAt).toLocaleString():'Not issued'}</td><td><span className={`chip ${statusClass(a.returnStatus)}`}>{a.returnStatus}</span></td><td>{!a.returnedAt&&<button className="button outline" onClick={()=>returnItem(a.id)}>Record return</button>}</td></tr>)}</tbody></table></div>:<Empty label="No equipment allocations have been recorded." icon="assignment_late"/>}</section>; }

function EquipmentModal({categories,members,onClose,onSaved}:{categories:{id:number;name:string}[];members:Member[];onClose:()=>void;onSaved:()=>void}) {const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [form,setForm]=useState<any>({equipmentCode:'',assetId:'',itemName:'',categoryId:'',brand:'',model:'',focalLength:'',lensMount:'',keywords:'',quantity:1,ownership:'Personally Owned',responsibleMemberId:'',conditionStatus:'Good',availability:'Available',notes:''});const u=(k:string,v:any)=>setForm((f:any)=>({...f,[k]:v}));const save=async(e:React.FormEvent)=>{e.preventDefault();if(form.ownership==='Personally Owned'&&!form.responsibleMemberId){setError('Personal gear needs an owner. Select the member who owns this item.');return;}setBusy(true);setError('');try{await api('/equipment',{method:'POST',body:JSON.stringify({...form,categoryId:Number(form.categoryId),quantity:Number(form.quantity),responsibleMemberId:form.responsibleMemberId?Number(form.responsibleMemberId):null})});onSaved()}catch(err){setError((err as Error).message)}finally{setBusy(false)}};return <Modal title="Register member-owned equipment" onClose={onClose} wide><form onSubmit={save}><div className="modal-body">{error&&<div className="alert error">{error}</div>}<div className="form-grid"><Field label="Equipment code"><input className="form-control" placeholder="Assigned automatically ΓÇö leave blank" value={form.equipmentCode} onChange={e=>u('equipmentCode',e.target.value)}/></Field><Field label="Asset ID (optional)"><input className="form-control" value={form.assetId} onChange={e=>u('assetId',e.target.value)}/></Field><Field label="Item name (optional)"><input className="form-control" placeholder="My main portrait lens" value={form.itemName} onChange={e=>u('itemName',e.target.value)}/></Field><Field label="Category"><select className="form-control" required value={form.categoryId} onChange={e=>u('categoryId',e.target.value)}><option value="">Select category</option>{categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field><Field label="Brand"><input className="form-control" required value={form.brand} onChange={e=>u('brand',e.target.value)}/></Field><Field label="Model"><input className="form-control" required value={form.model} onChange={e=>u('model',e.target.value)}/></Field><Field label="Focal length (e.g. 70-200mm)"><input className="form-control" placeholder="70-200mm" value={form.focalLength} onChange={e=>u('focalLength',e.target.value)}/></Field><Field label="Lens mount / compatibility"><input className="form-control" placeholder="Canon EF, Sony EΓÇª" value={form.lensMount} onChange={e=>u('lensMount',e.target.value)}/></Field><Field label="Quantity"><input type="number" min="1" className="form-control" required value={form.quantity} onChange={e=>u('quantity',e.target.value)}/></Field><Field label="Ownership"><select className="form-control" value={form.ownership} onChange={e=>u('ownership',e.target.value)}><option>Personally Owned</option><option>Society Owned</option></select></Field><Field label="Owner / responsible member" full><select className="form-control" value={form.responsibleMemberId||''} onChange={e=>u('responsibleMemberId',e.target.value)}><option value="">Not linked to a member</option>{members.map(m=><option key={m.id} value={m.id}>{m.fullName} ┬╖ Grade {m.grade} {m.className}</option>)}</select></Field><Field label="Condition"><select className="form-control" value={form.conditionStatus} onChange={e=>u('conditionStatus',e.target.value)}><option>Excellent</option><option>Good</option><option>Needs Service</option><option>Damaged</option><option>Unavailable</option></select></Field><Field label="Availability"><select className="form-control" value={form.availability} onChange={e=>u('availability',e.target.value)}><option>Available</option><option>Allocated</option><option>Unavailable</option></select></Field><Field label="Search keywords" full><input className="form-control" placeholder="telephoto, wedding, wildlifeΓÇª" value={form.keywords} onChange={e=>u('keywords',e.target.value)}/></Field><Field label="Notes (condition, limits, availability)" full><textarea className="form-control" value={form.notes} onChange={e=>u('notes',e.target.value)}/></Field></div><div className="alert info" style={{marginTop:12}}>The equipment code is generated by the server. Ownership here is the registered owner ΓÇö whether an item is actually available for an event is confirmed separately per event.</div></div><FormActions busy={busy} onClose={onClose}/></form></Modal>}
function AllocationModal({equipment,events,onClose,onSaved}:{equipment:Equipment[];events:SocietyEvent[];onClose:()=>void;onSaved:()=>void}) {const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [form,setForm]=useState<any>({equipmentId:'',eventId:'',quantity:1,issuedAt:'',notes:''});const u=(k:string,v:any)=>setForm((f:any)=>({...f,[k]:v}));const save=async(e:React.FormEvent)=>{e.preventDefault();setBusy(true);try{await api('/equipment/allocations',{method:'POST',body:JSON.stringify({...form,equipmentId:Number(form.equipmentId),eventId:Number(form.eventId),quantity:Number(form.quantity),issuedAt:form.issuedAt?new Date(form.issuedAt).toISOString():undefined})});onSaved()}catch(err){setError((err as Error).message)}finally{setBusy(false)}};return <Modal title="Allocate equipment to event" onClose={onClose}><form onSubmit={save}><div className="modal-body">{error&&<div className="alert error">{error}</div>}<div className="form-grid"><Field label="Equipment" full><select className="form-control" required value={form.equipmentId} onChange={e=>u('equipmentId',e.target.value)}><option value="">Select available equipment</option>{equipment.filter(e=>e.availability!=='Archived').map(e=><option key={e.id} value={e.id}>{e.equipmentCode} ┬╖ {e.brand} {e.model}</option>)}</select></Field><Field label="Event" full><select className="form-control" required value={form.eventId} onChange={e=>u('eventId',e.target.value)}><option value="">Select event</option>{events.filter(e=>e.status!=='Cancelled').map(e=><option key={e.id} value={e.id}>{e.name} ┬╖ {new Date(e.startsAt).toLocaleDateString()}</option>)}</select></Field><Field label="Quantity"><input type="number" min="1" className="form-control" required value={form.quantity} onChange={e=>u('quantity',e.target.value)}/></Field><Field label="Issue time"><input type="datetime-local" className="form-control" value={form.issuedAt} onChange={e=>u('issuedAt',e.target.value)}/></Field><Field label="Allocation notes" full><textarea className="form-control" value={form.notes} onChange={e=>u('notes',e.target.value)}/></Field></div></div><FormActions busy={busy} onClose={onClose}/></form></Modal>}

function ReportsPage({user}:{user:SessionUser}) {const [type,setType]=useState('membership');const [range,setRange]=useState({from:'',to:''});const report=useResource<{data:any[];generatedAt:string}>(`/reports/${type}?from=${range.from}&to=${range.to}`);const columns=report.data?.data[0]?Object.keys(report.data.data[0]):[];const canExport=user.permissions.includes('reports.export');const reportOptions:[string,string][]=[['directory','Complete member directory'],['membership','Membership status & grade distribution'],['roles','Creative team distribution'],['skills','Member skills & personal equipment'],['events','Event list & details'],['participation','Event participation & assignment history'],['confirmations','Team confirmation & response status'],['readiness','Event readiness ΓÇö missing people & gear'],['workload','Member workload & repeat assignments'],['equipment','Equipment inventory & ownership'],['availability','Equipment availability'],['allocations','Equipment availability & allocation conflicts'],['staffing','Event staffing'],['administrative','Administrative activity (audit log)']];return <main className="page"><PageHeader eyebrow="Operational reporting suite" title="Reports & exports" subtitle="Every figure is read from the live database and updates after changes. The active filters apply to the table and to the CSV export." actions={<>{canExport&&<a className="button outline" href={`/api/reports/${type}/export.csv?from=${range.from}&to=${range.to}`}><span className="material-symbols-outlined">download</span> Export this report (CSV)</a>}{canExport&&<a className="button primary" href={`/api/reports/full/export.csv?from=${range.from}&to=${range.to}`}><span className="material-symbols-outlined">note_add</span> Export full report</a>}</>}/><div className="toolbar"><select value={type} onChange={e=>setType(e.target.value)}>{reportOptions.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select><label className="small">From <input type="date" value={range.from} onChange={e=>setRange(r=>({...r,from:e.target.value}))}/></label><label className="small">To <input type="date" value={range.to} onChange={e=>setRange(r=>({...r,to:e.target.value}))}/></label><button className="button outline" onClick={()=>setRange({from:'',to:''})}>Clear date filter</button></div><div className="small" style={{margin:'0 0 10px'}}>Report: {type} ┬╖ filters from={range.from||'1970-01-01'} to={range.to||'2999-12-31'} ┬╖ generated {report.data?new Date(report.data.generatedAt).toLocaleString():'ΓÇö'} ┬╖ {report.data?.data.length??0} row(s){canExport?'':' ┬╖ your account cannot export reports'}</div><section className="card">{report.loading?<Loading/>:report.error?<ErrorState message={report.error} retry={report.reload}/>:report.data?.data.length?<div className="table-wrap"><table><thead><tr>{columns.map(c=><th key={c}>{c.replace(/([A-Z])/g,' $1').replace(/_/g,' ')}</th>)}</tr></thead><tbody>{report.data.data.map((row,i)=><tr key={i}>{columns.map(c=><td key={c}>{String(row[c] ?? '')}</td>)}</tr>)}</tbody></table></div>:<Empty label="No report records exist for this filter." icon="bar_chart"/>}</section></main>;}

function PasswordChangeCard() {const [currentPassword,setCurrentPassword]=useState('');const [newPassword,setNewPassword]=useState('');const [confirmPassword,setConfirmPassword]=useState('');const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');const [error,setError]=useState('');const save=async(e:React.FormEvent)=>{e.preventDefault();setMessage('');setError('');if(newPassword!==confirmPassword){setError('New passwords do not match.');return}setBusy(true);try{await api('/auth/password/change',{method:'POST',body:JSON.stringify({currentPassword,newPassword})});setCurrentPassword('');setNewPassword('');setConfirmPassword('');setMessage('Password updated. Other password sessions were signed out.')}catch(err){setError((err as Error).message)}finally{setBusy(false)}};return <section className="card" style={{marginTop:16}}><div className="card-header"><span className="card-title">Password access</span><span className="small">Minimum 12 characters</span></div><div className="card-body"><p className="small" style={{marginTop:0}}>Set a local password for this official account or change an existing one. Leave current password blank only when an administrator has just enabled password login for an OAuth-only account.</p>{message&&<div className="alert info">{message}</div>}{error&&<div className="alert error">{error}</div>}<form onSubmit={save}><div className="form-grid"><Field label="Current password"><input className="form-control" type="password" autoComplete="current-password" value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)}/></Field><Field label="New password"><input className="form-control" type="password" autoComplete="new-password" minLength={12} required value={newPassword} onChange={e=>setNewPassword(e.target.value)}/></Field><Field label="Confirm new password"><input className="form-control" type="password" autoComplete="new-password" minLength={12} required value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)}/></Field></div><button className="button primary" style={{marginTop:16}} disabled={busy}>{busy?'UpdatingΓÇª':'Update password'}</button></form></div></section>}

function OfficialAccountModal({roles,permissions,rolePermissions,account,onClose,onSaved}:{roles:{id:number;name:string}[];permissions:{id:number;code:string;description:string}[];rolePermissions:{roleId:number;code:string}[];account:any|null;onClose:()=>void;onSaved:()=>void}) { const isEdit=Boolean(account); const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const [displayName,setDisplayName]=useState(account?account.displayName:''); const [email,setEmail]=useState(account?account.email:''); const [password,setPassword]=useState(''); const [confirm,setConfirm]=useState(''); const [roleIds,setRoleIds]=useState<number[]>(account?(account.roleIds||[]):(roles[0]?[roles[0].id]:[])); const [active,setActive]=useState(account?Boolean(account.active):true); const granted=useMemo(()=>{ const codes=[...new Set(rolePermissions.filter(rp=>roleIds.includes(rp.roleId)).map(rp=>rp.code))].sort(); return codes.map(code=>({code,description:permissions.find(p=>p.code===code)?.description||''})); },[roleIds,rolePermissions,permissions]); const toggle=(id:number)=>setRoleIds(prev=>prev.includes(id)?prev.filter(v=>v!==id):[...prev,id]); const submit=async(e:React.FormEvent)=>{ e.preventDefault(); setError(''); if(displayName.trim().length<2){ setError('Enter the official\'s full name so the account is identifiable.'); return; } if(!roleIds.length){ setError('Choose at least one role so the account has access.'); return; } if(!isEdit&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim().toLowerCase())){ setError('A valid email address is required for the account.'); return; } if(!isEdit&&password.length<12){ setError('Set an initial password of at least 12 characters.'); return; } if(password&&password!==confirm){ setError('The two passwords do not match.'); return; } setBusy(true); try { if(isEdit){ await api(`/users/${account.id}`,{method:'PATCH',body:JSON.stringify({displayName:displayName.trim(),roleIds,active,...(password?{password}:{})})}); } else { await api('/users',{method:'POST',body:JSON.stringify({displayName:displayName.trim(),email:email.trim().toLowerCase(),password,roleIds,active})}); } onSaved(); } catch(err){ setError((err as Error).message); } finally { setBusy(false); } }; return <Modal title={isEdit?'Edit official account':'Add official account'} onClose={onClose}><form onSubmit={submit}><div className="modal-body"><div className="form-grid"><Field label="Full name"><input className="form-control" value={displayName} onChange={e=>setDisplayName(e.target.value)} placeholder="e.g. Nimal Perera" autoFocus/></Field><Field label="Email address"><input className="form-control" value={email} disabled={isEdit} onChange={e=>setEmail(e.target.value)} placeholder="official@rcpas.local"/>{isEdit&&<span className="small">The sign-in address cannot be changed after creation.</span>}</Field><Field label={isEdit?'New password (optional)':'Initial password'}><input className="form-control" type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder={isEdit?'Leave blank to keep the current password':'At least 12 characters'}/>{isEdit&&<span className="small">Setting a password signs this account out of every device.</span>}</Field>{!isEdit&&<Field label="Confirm password"><input className="form-control" type="password" value={confirm} onChange={e=>setConfirm(e.target.value)} placeholder="Repeat the password"/></Field>}<Field label="Roles (roles are what grant access)" full><div className="checkbox-list">{roles.map(r=><label className="check" key={r.id}><input type="checkbox" checked={roleIds.includes(r.id)} onChange={()=>toggle(r.id)}/> {r.name}</label>)}</div></Field><Field label="Sign-in status" full><label className="check"><input type="checkbox" checked={active} onChange={e=>setActive(e.target.checked)}/> This account is allowed to sign in</label></Field></div>{error&&<div className="alert error" style={{marginTop:14}}>{error}</div>}<div className="alert info" style={{marginTop:14}}><div><strong>What this account will be able to do</strong><div className="small" style={{marginTop:6}}>{granted.length?`${granted.length} permission${granted.length===1?'':'s'}, granted by the selected roles:`:'No roles selected ΓÇö an account with no roles has no access.'}</div>{granted.length>0&&<ul style={{marginTop:8,paddingLeft:18,fontSize:12,lineHeight:1.7,marginBottom:0}}>{granted.slice(0,12).map(g=><li key={g.code}><code>{g.code}</code>{g.description?` ΓÇö ${g.description}`:''}</li>)}</ul>}{granted.length>12&&<div className="small">+{granted.length-12} more.</div>}</div></div></div><div className="modal-footer"><button type="button" className="button outline" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="button primary" disabled={busy}>{busy?'SavingΓÇª':isEdit?'Save changes':'Create account'}</button></div></form></Modal>; }
function SettingsPage({user,setUser}:{user:SessionUser;setUser:(u:SessionUser|null)=>void}) {const settings=useResource<{data:{settingKey:string;settingValue:string}[]}>('/settings');const canManageUsers=user.permissions.includes('users.manage');const auditLog=useResource<{data:any[]}>('/audit',user.permissions.includes('audit.read'));const users=useResource<{data:any[]}>('/users',canManageUsers);const roles=useResource<{data:{id:number;name:string}[]}>('/system-roles',canManageUsers);const permissions=useResource<{data:{id:number;code:string;description:string}[]}>('/permissions',canManageUsers);const rolePermissions=useResource<{data:{roleId:number;code:string}[]}>('/role-permissions',canManageUsers);const [notice,setNotice]=useState('');const [modal,setModal]=useState<null|'add'|any>(null);const [name,setName]=useState('Rahula College Photographic Art Society');useEffect(()=>{const n=settings.data?.data.find(x=>x.settingKey==='society.name');if(n)setName(n.settingValue)},[settings.data]);const save=async()=>{try{await api('/settings',{method:'PATCH',body:JSON.stringify({'society.name':name})});setNotice('Configuration saved after server confirmation.');settings.reload()}catch(e){setNotice((e as Error).message)}};const updateUser=async(id:number,active:boolean)=>{try{await api(`/users/${id}`,{method:'PATCH',body:JSON.stringify({active})});setNotice('Official access updated and audited.');users.reload()}catch(e){setNotice((e as Error).message)}};const permsFor=(roleIds:number[])=>{const ids=Array.isArray(roleIds)?roleIds:[];return [...new Set((rolePermissions.data?.data||[]).filter(rp=>ids.includes(rp.roleId)).map(rp=>rp.code))]};const refreshSession=()=>{api<{user:SessionUser|null}>('/auth/session').then(r=>setUser(r.user??null)).catch(()=>{})};const saved=()=>{setNotice('Official account saved and audited.');users.reload();refreshSession()};return <main className="page"><PageHeader eyebrow="Portal governance and society configuration" title="Settings" subtitle="Maintain official access, society identity, and the administrative audit trail. Password changes and recovery are handled by the configured identity provider."/><div className="split-grid"><section className="card"><div className="card-header"><span className="card-title">Society configuration</span></div><div className="card-body">{notice&&<div className="alert info">{notice}</div>}<Field label="Society name"><input className="form-control" value={name} onChange={e=>setName(e.target.value)}/></Field><button className="button primary" style={{marginTop:16}} onClick={save}>Save configuration</button><div className="alert info" style={{marginTop:18}}><strong>Official-only access.</strong><br/>There is no public registration and no ordinary member login. Authorized identities are activated by an administrator through the allow-list and role assignments.</div></div></section><section className="card"><div className="card-header"><span className="card-title">Your role boundary</span></div><div className="card-body"><div className="row-title">{user.displayName}</div><div className="small" style={{marginTop:4}}>{user.email}</div><div style={{display:'flex',gap:5,flexWrap:'wrap',marginTop:14}}>{user.roles.map(r=><span className="chip green" key={r}>{r}</span>)}</div><div className="small" style={{marginTop:16}}>The System Administrator role is technical and does not automatically become President.</div></div></section></div><PasswordChangeCard/>{canManageUsers&&<section className="card" style={{marginTop:16}}><div className="card-header"><span className="card-title">Official accounts</span><button className="button primary" onClick={()=>setModal('add')}><span className="material-symbols-outlined">person_add</span> Add official</button></div>{users.loading||roles.loading||permissions.loading?<Loading/>:users.error?<ErrorState message={users.error} retry={users.reload}/>:<div className="table-wrap"><table><thead><tr><th>Official</th><th>Roles</th><th>Access granted</th><th>Status</th><th></th></tr></thead><tbody>{users.data?.data.map((u:any)=>{const perms=permsFor(u.roleIds);return <tr key={u.id}><td><div className="row-title">{u.displayName}</div><div className="row-subtitle">{u.email}</div></td><td>{Array.isArray(u.roleIds)&&u.roleIds.length?<span style={{display:'flex',gap:5,flexWrap:'wrap'}}>{u.roleIds.map((rid:number)=><span className="chip slate" key={rid}>{roles.data?.data.find(r=>r.id===rid)?.name||`Role ${rid}`}</span>)}</span>:<span className="chip amber">No role</span>}</td><td><span className="small">{perms.length} permission{perms.length===1?'':'s'}</span><div className="row-subtitle">{perms.slice(0,3).join(', ')}{perms.length>3?` +${perms.length-3} more`:''}</div></td><td><button className={`button ${u.active?'outline':'danger'}`} disabled={u.id===user.id&&!u.active} onClick={()=>updateUser(u.id,!u.active)}>{u.active?'Active':'Inactive'}</button></td><td><div className="table-actions"><button className="button outline" onClick={()=>setModal(u)}><span className="material-symbols-outlined">edit</span> Edit</button></div></td></tr>})}</tbody></table></div>}</section>}{auditLog.data&&<section className="card" style={{marginTop:16}}><div className="card-header"><span className="card-title">Recent audit activity</span><button className="button ghost" onClick={auditLog.reload}>Refresh</button></div><div className="table-wrap"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th></tr></thead><tbody>{auditLog.data.data.map((a:any)=><tr key={a.id}><td>{new Date(a.createdAt).toLocaleString()}</td><td>{a.actorName||'System'}</td><td>{a.action}</td><td>{a.entityType} {a.entityId||''}</td></tr>)}</tbody></table></div></section>}{modal&&<OfficialAccountModal roles={roles.data?.data||[]} permissions={permissions.data?.data||[]} rolePermissions={rolePermissions.data?.data||[]} account={modal==='add'?null:modal} onClose={()=>setModal(null)} onSaved={()=>{setModal(null);saved()}}/>}</main>;}
function NotFound(){return <main className="page"><div className="card"><div className="empty"><span className="material-symbols-outlined">search_off</span><h2>Page not found</h2><p>The requested portal area does not exist.</p><Link className="button primary" to="/">Return to dashboard</Link></div></div></main>}

/** Step C/E ΓÇö search every member's registered gear and add the owner to the event team. */
function EquipmentSearchPanel({eventId,eventDate,roles,onMessage,initialQuery=''}:{eventId:number;eventDate:string;roles:string[];onMessage:(m:string,kind?:'info'|'error')=>void;initialQuery?:string}) {
  const [q,setQ]=useState(initialQuery);
  const [debounced,setDebounced]=useState(initialQuery);
  const [assigningId,setAssigningId]=useState<number|null>(null);
  const [pending,setPending]=useState<{payload:any;warnings:string[]}|null>(null);
  const [overrideReason,setOverrideReason]=useState('');
  useEffect(()=>{const t=setTimeout(()=>setDebounced(q),300);return ()=>clearTimeout(t);},[q]);
  const hits=useResource<{data:any[];contactsVisible:boolean}>(`/equipment/search?q=${encodeURIComponent(debounced)}&eventId=${eventId}&date=${eventDate}`);
  const commitments=useResource<{data:any[]}>(`/events/${eventId}/commitments`);
  const commit=async(equipmentId:number,status:string)=>{const r=await apiRaw('/events/'+eventId+'/commitments',{method:'POST',body:JSON.stringify({equipmentId,status,notes:''})});if(r.ok){onMessage('Equipment commitment recorded.');commitments.reload();hits.reload();}else onMessage((r.body as any).error||'Could not record the commitment.','error');};
  const assign=async(payload:any)=>{const r=await apiRaw('/assignments',{method:'POST',body:JSON.stringify(payload)});if(r.ok){onMessage('Member added to the team.');setAssigningId(null);setPending(null);setOverrideReason('');hits.reload();}else{const b=r.body as any;if(b.code==='ASSIGNMENT_WARNING'){setPending({payload,warnings:b.warnings||[]});onMessage(b.error,'error');}else{onMessage(b.error||'Could not add this member.','error');}}};
  const overrideAssign=async()=>{if(!pending)return;if(!overrideReason.trim()){onMessage('An override reason is required to save these warnings.','error');return;}await assign({...pending.payload,overrideWarnings:true,overrideReason:overrideReason.trim()});};
  if(hits.loading) return <Loading/>;
  if(hits.error) return <ErrorState message={hits.error} retry={hits.reload}/>;
  const rows=hits.data?.data||[];
  return <div>
    <div className="search-wrap" style={{marginBottom:12}}><span className="material-symbols-outlined">search</span><input placeholder="Search gear: 70-200, Canon 70-200, telephoto lens, camera body, tripod, flash, wireless microphone, gimbal, lightingΓÇª" value={q} onChange={e=>setQ(e.target.value)}/></div>
    <p className="small" style={{marginTop:-6,marginBottom:12}}>Matches brand, model, focal length, category, keywords and the owning member. {rows.length} record(s) shown.</p>
    {pending&&<div className="alert error" style={{marginBottom:12}}><strong>Review required before saving.</strong><ul style={{margin:'8px 0 8px 18px',padding:0}}>{pending.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul><p className="small">Only the event date is known, so the system cannot confirm whether two events actually overlap in time.</p><input className="form-control" placeholder="Reason for authorized override" value={overrideReason} onChange={e=>setOverrideReason(e.target.value)}/><div style={{display:'flex',gap:8,marginTop:8}}><button className="button primary" onClick={overrideAssign}>Record override and assign</button><button className="button outline" onClick={()=>{setPending(null);setOverrideReason('')}}>Cancel</button></div></div>}
    {rows.length===0?<Empty label={debounced?`No gear matches "${debounced}". Try a brand, model, focal length or category.`:'No equipment records yet. Register gear from a member profile.'} icon="photo_camera"/>:
    <div className="table-wrap"><table><thead><tr><th>Equipment</th><th>Member who can provide it</th><th>Availability</th><th>Committed gear</th><th></th></tr></thead><tbody>{rows.map(h=><Fragment key={h.equipmentId}><tr>
      <td><div className="row-title">{h.brand} {h.model}{h.focalLength?` ┬╖ ${h.focalLength}`:''}</div><div className="row-subtitle">{h.categoryName}{h.lensMount?` ┬╖ ${h.lensMount}`:''} ┬╖ {h.ownership}</div></td>
      <td>{h.owner.id?<><div className="row-title">{h.owner.fullName}</div><div className="row-subtitle">{h.owner.memberCode} ┬╖ Grade {h.owner.grade} {h.owner.className} ┬╖ {h.owner.roles.join(', ')||'No creative role'}</div>{h.owner.assignmentsOnDate>0&&<div className="row-subtitle" style={{color:'var(--amber,#b45309)'}}>Also assigned elsewhere on {eventDate}</div>}</>:<span className="small">Society item ΓÇö no member owner</span>}</td>
      <td><span className={`chip ${statusClass(h.availability)}`}>{h.availability}</span>{h.conditionStatus&&h.conditionStatus!=='Good'&&<div className="row-subtitle">{h.conditionStatus}</div>}</td>
      <td>{h.commitment?<span className={`chip ${statusClass(h.commitment.status)}`}>{h.commitment.status}</span>:<span className="small">Not reserved</span>}</td>
      <td><div className="table-actions">
        {h.owner.id&&<>
          <button className="icon-button" title="Add this member to the event team" onClick={()=>{setAssigningId(assigningId===h.equipmentId?null:h.equipmentId);setPending(null);}}><span className="material-symbols-outlined">group_add</span></button>
          <button className="icon-button" title="Reserve this gear for the event (awaiting owner confirmation)" onClick={()=>commit(h.equipmentId,'Awaiting Confirmation')}><span className="material-symbols-outlined">bookmark_add</span></button>
          <button className="icon-button" title="Mark owner confirmed for this event" onClick={()=>commit(h.equipmentId,'Confirmed')}><span className="material-symbols-outlined">verified</span></button>
          <button className="icon-button" title="Release this reservation" onClick={()=>commit(h.equipmentId,'Released')}><span className="material-symbols-outlined">release</span></button>
        </>}
      </div></td></tr>
      {assigningId===h.equipmentId&&<tr key={`${h.equipmentId}-assign`}><td colSpan={5}><AssignmentInline eventId={eventId} member={h.owner} roles={roles} onDone={assign} onCancel={()=>setAssigningId(null)}/></td></tr>}
    </Fragment>)}</tbody></table></div>}
  </div>;
}

function AssignmentInline({eventId,member,roles,onDone,onCancel}:{eventId:number;member:any;roles:string[];onDone:(p:any)=>void;onCancel:()=>void}) {
  const options=roles.length?roles:['Photographer','Photo Editor','Graphic Designer','Videographer','Event Coordinator','Equipment Coordinator'];
  const [responsibility,setResponsibility]=useState(options[0]||'Photographer');
  const [status,setStatus]=useState('Contact Pending');
  const [notes,setNotes]=useState('');
  return <div className="card-body" style={{border:'1px dashed var(--line,#dbe3ee)',borderRadius:8,padding:12}}>
    <div className="row-title">Assign {member.fullName} to this event</div>
    <div className="form-grid" style={{marginTop:8}}>
      <Field label="Assigned responsibility"><input className="form-control" list="rcpas-responsibilities" required value={responsibility} onChange={e=>setResponsibility(e.target.value)}/><datalist id="rcpas-responsibilities">{options.map(o=><option key={o} value={o}/>)}</datalist></Field>
      <Field label="Assignment status"><select className="form-control" value={status} onChange={e=>setStatus(e.target.value)}><option>Proposed</option><option>Contact Pending</option><option>Contacted</option><option>Confirmed</option><option>Declined</option></select></Field>
      <Field label="Notes" full><input className="form-control" value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Anything the team should know"/></Field>
    </div>
    <div style={{display:'flex',gap:8,marginTop:8}}><button className="button primary" onClick={()=>onDone({eventId,memberId:member.id,responsibility,status,notes,overrideWarnings:false})}>Add to team</button><button className="button outline" onClick={onCancel}>Cancel</button></div>
  </div>;
}

/** Step D ΓÇö the current team with live contact / confirmation statuses. */
function AssignmentsList({eventId,onMessage,reloadKey}:{eventId:number;onMessage:(m:string,kind?:'info'|'error')=>void;reloadKey:number}) {
  const list=useResource<{data:any[]}>(`/assignments?eventId=${eventId}`, reloadKey>=0);
  const [busy,setBusy]=useState(0);
  const setStatus=async(id:number,status:string)=>{setBusy(id);const r=await apiRaw(`/assignments/${id}/contact`,{method:'PATCH',body:JSON.stringify({status})});setBusy(0);if(r.ok){onMessage('Response status updated and audited.');list.reload();}else onMessage((r.body as any).error||'Could not update the status.','error');};
  const remove=async(id:number)=>{if(!confirm('Remove this assignment? The history is preserved in the audit log.'))return;const r=await apiRaw(`/assignments/${id}`,{method:'DELETE'});if(r.ok){onMessage('Assignment removed.');list.reload();}else onMessage((r.body as any).error||'Could not remove the assignment.','error');};
  if(list.loading) return <Loading/>;
  if(list.error) return <ErrorState message={list.error} retry={list.reload}/>;
  const rows=list.data?.data||[];
  if(!rows.length) return <Empty label="No team members have been assigned yet. Use Find members or Equipment search to add people." icon="group_off"/>;
  return <div className="table-wrap"><table><thead><tr><th>Member</th><th>Responsibility</th><th>Status</th><th>Contacted</th><th>Confirmed</th><th></th></tr></thead><tbody>{rows.map(a=><tr key={a.id}>
    <td><div className="row-title">{a.memberName}</div><div className="row-subtitle">{a.memberCode}</div></td>
    <td>{a.responsibility}</td>
    <td><span className={`chip ${statusClass(a.status)}`}>{a.status}</span></td>
    <td>{a.contactedAt?new Date(a.contactedAt).toLocaleString():<span className="small">Not contacted</span>}<div className="row-subtitle">{a.contactedByName||''}</div></td>
    <td>{a.confirmedAt?new Date(a.confirmedAt).toLocaleString():<span className="small">Pending</span>}</td>
    <td><div className="table-actions">
      <button className="icon-button" title="Mark contacted" disabled={busy===a.id} onClick={()=>setStatus(a.id,'Contacted')}><span className="material-symbols-outlined">call</span></button>
      <button className="icon-button" title="Mark confirmed" disabled={busy===a.id} onClick={()=>setStatus(a.id,'Confirmed')}><span className="material-symbols-outlined">task_alt</span></button>
      <button className="icon-button" title="Mark declined" disabled={busy===a.id} onClick={()=>setStatus(a.id,'Declined')}><span className="material-symbols-outlined">thumb_down</span></button>
      <button className="icon-button" title="Remove assignment" onClick={()=>remove(a.id)}><span className="material-symbols-outlined">person_remove</span></button>
    </div></td></tr>)}</tbody></table></div>;
}

/** Step F / ┬º6 ΓÇö authorized team contact sheet, response counts and a message draft. */
function ContactSheet({eventId,onMessage}:{eventId:number;onMessage:(m:string,kind?:'info'|'error')=>void}) {
  const sheet=useResource<any>(`/events/${eventId}/contact-sheet`);
  const [copied,setCopied]=useState('');
  const copy=async(text:string,label:string)=>{try{await navigator.clipboard.writeText(text);setCopied(label);onMessage(`${label} copied to the clipboard. Nothing has been sent.`);}catch{onMessage('The browser blocked clipboard access. Select and copy manually.','error');}};
  if(sheet.loading) return <Loading/>;
  if(sheet.error) return <ErrorState message={sheet.error} retry={sheet.reload}/>;
  const d=sheet.data; const team=d.team||[];
  const lines=team.map((t:any)=>`${t.memberName} ΓÇö ${t.responsibility} ΓÇö ${t.phone||'no phone'} ΓÇö ${t.status}`);
  return <div>
    <div className="metric-grid" style={{marginBottom:12}}>
      <div className="metric"><div className="metric-label"><span>Team size</span></div><div className="metric-value">{d.summary.teamSize}</div></div>
      <div className="metric"><div className="metric-label"><span>Awaiting response</span></div><div className="metric-value">{d.summary.responsesDue}</div></div>
      <div className="metric"><div className="metric-label"><span>Unfilled roles</span></div><div className="metric-value">{d.summary.unfilledRoles.length}</div></div>
    </div>
    {d.summary.unfilledRoles.length>0&&<div className="alert error" style={{marginBottom:12}}>Unfilled roles: {d.summary.unfilledRoles.join(', ')}</div>}
    <div className="alert info" style={{marginBottom:12}}>Contact details are shown because you hold the <code>contacts.read</code> permission. Opening a WhatsApp link or copying text does <strong>not</strong> mean a message was sent ΓÇö the system only records a delivery if a real messaging integration confirms it.</div>
    <div className="table-wrap"><table><thead><tr><th>Member</th><th>Responsibility</th><th>Phone</th><th>Status</th><th></th></tr></thead><tbody>{team.map((t:any)=><tr key={t.id}>
      <td><div className="row-title">{t.memberName}</div><div className="row-subtitle">{t.memberCode}</div></td>
      <td>{t.responsibility}</td>
      <td>{t.phone||<span className="small">No number on record</span>}</td>
      <td><span className={`chip ${statusClass(t.status)}`}>{t.status}</span></td>
      <td>{t.phone&&<a className="icon-button" title="Open WhatsApp (nothing is sent automatically)" target="_blank" rel="noreferrer" href={`https://wa.me/${String(t.phone).replace(/[^0-9]/g,'')}?text=${encodeURIComponent(d.message)}`}><span className="material-symbols-outlined">chat</span></a>}</td>
    </tr>)}</tbody></table></div>
    <div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:12}}>
      <button className="button outline" onClick={()=>copy(lines.join('\n'),'Contact list')}>Copy contact list</button>
      <button className="button outline" onClick={()=>copy(d.message,'Message')}>Copy message</button>
      <a className="button outline" download={`rcpas-contact-${d.event.eventCode}.csv`} href={`/api/events/${eventId}/contact-sheet.csv`}>Export contact sheet (CSV)</a>
    </div>
    <div className="card-body" style={{marginTop:12}}><div className="eyebrow">Message draft</div><pre style={{whiteSpace:'pre-wrap',marginTop:8}} className="small">{d.message}</pre></div>
  </div>;
}

/** Step B/C ΓÇö structured gear requirements, each with its own Find Gear Owners action. */
function RequirementsPanel({eventId,onFindOwners,onChanged,onMessage}:{eventId:number;onFindOwners:(query:string)=>void;onChanged:()=>void;onMessage:(m:string,kind?:'info'|'error')=>void}) {
  const list=useResource<{data:any[]}>(`/events/${eventId}/requirements`);
  const [description,setDescription]=useState('');
  const [quantity,setQuantity]=useState('1');
  const [priority,setPriority]=useState('Required');
  const [notes,setNotes]=useState('');
  const [busy,setBusy]=useState(false);
  const add=async()=>{const text=description.trim();if(text.length<2){onMessage('Describe the gear you need (at least 2 characters).','error');return;}setBusy(true);const r=await apiRaw(`/events/${eventId}/requirements`,{method:'POST',body:JSON.stringify({description:text,quantity:Number(quantity)||1,priority,notes:notes.trim()})});setBusy(false);if(r.ok){onMessage('Gear requirement added to the plan.');setDescription('');setNotes('');setQuantity('1');list.reload();onChanged();}else onMessage((r.body as any).error||'Could not add the requirement.','error');};
  const remove=async(id:number)=>{if(!confirm('Remove this gear requirement from the plan?'))return;const r=await apiRaw(`/events/${eventId}/requirements/${id}`,{method:'DELETE'});if(r.ok){onMessage('Requirement removed.');list.reload();onChanged();}else onMessage((r.body as any).error||'Could not remove the requirement.','error');};
  const setWaive=async(row:any,want:boolean)=>{let reason='';if(want){const entered=window.prompt(`Why is "${row.description}" not needed for this event?`, '');if(entered===null)return;reason=entered.trim();if(!reason){onMessage('A reason is required to waive a requirement.','error');return;}}const payload:any={waive:want};if(want)payload.waiveReason=reason;const r=await apiRaw(`/events/${eventId}/requirements/${row.id}`,{method:'PATCH',body:JSON.stringify(payload)});if(r.ok){onMessage(want?'Marked not needed ΓÇö readiness no longer blocks on it.':'Requirement restored to the plan.');list.reload();onChanged();}else onMessage((r.body as any).error||'Could not update the requirement.','error');};
  if(list.loading) return <Loading/>;
  if(list.error) return <ErrorState message={list.error} retry={list.reload}/>;
  const rows=list.data?.data||[];
  return <div>
    <div className="card-body" style={{border:'1px solid var(--line,#dbe3ee)',borderRadius:8,marginBottom:14}}>
      <div className="row-title">Add a gear requirement</div>
      <div className="form-grid" style={{marginTop:8}}>
        <Field label="What gear does this event need?" full><input className="form-control" value={description} onChange={e=>setDescription(e.target.value)} placeholder="70-200mm lens, camera body, tripod, flash, gimbal, wireless microphoneΓÇª"/></Field>
        <Field label="Quantity"><input className="form-control" type="number" min={1} value={quantity} onChange={e=>setQuantity(e.target.value)}/></Field>
        <Field label="Priority"><select className="form-control" value={priority} onChange={e=>setPriority(e.target.value)}><option>Optional</option><option>Required</option><option>Critical</option></select></Field>
        <Field label="Notes" full><input className="form-control" value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Condition, limitations, or compatibility notes"/></Field>
      </div>
      <button className="button primary" style={{marginTop:12}} disabled={busy} onClick={add}><span className="material-symbols-outlined">add</span> Add requirement</button>
      <p className="small" style={{marginTop:10,marginBottom:0}}>Requirements are recorded before any owner is found, so the same gear is never duplicated ΓÇö a single member record is reused across events.</p>
    </div>
    {rows.length===0?<Empty label="No gear requirements yet. Add the first one above, then find its owner." icon="photo_camera"/>:
    <div className="table-wrap"><table><thead><tr><th>Requirement</th><th>Priority</th><th>Linked gear record</th><th>Availability for this event</th><th></th></tr></thead><tbody>{rows.map(r=><tr key={r.id}>
      <td><div className="row-title">{r.description}{r.quantity>1?` ├ù ${r.quantity}`:''}</div>{r.notes&&<div className="row-subtitle">{r.notes}</div>}{r.waivedAt&&<div className="row-subtitle">Waived by {r.waivedByName||'an authorized official'}: {r.waivedReason}</div>}</td>
      <td><span className={`chip ${statusClass(r.priority)}`}>{r.priority}</span></td>
      <td>{r.equipmentId?<><div className="row-title">{r.brand} {r.model}{r.focalLength?` ┬╖ ${r.focalLength}`:''}</div><div className="row-subtitle">{r.categoryName} ┬╖ {r.ownerName||'No owner recorded'}</div></>:<span className="small">Not linked to a gear record yet</span>}</td>
      <td><span className={`chip ${statusClass(r.waivedAt?'Waived':r.availability)}`}>{r.waivedAt?'Waived':r.availability}</span></td>
      <td><div className="table-actions">
        <button className="icon-button" title="Find gear owners for this requirement" onClick={()=>onFindOwners(r.description)}><span className="material-symbols-outlined">manage_search</span></button>
        <button className="icon-button" title={r.waivedAt?'Put this requirement back in the plan':'Mark this requirement not needed for this event'} onClick={()=>setWaive(r,!r.waivedAt)}><span className="material-symbols-outlined">{r.waivedAt?'undo':'block'}</span></button>
        <button className="icon-button" title="Remove requirement" onClick={()=>remove(r.id)}><span className="material-symbols-outlined">delete</span></button>
      </div></td>
    </tr>)}</tbody></table></div>}
  </div>;
}

/** Step B5 ΓÇö internal planning discussion among authorized officials only. */
function DiscussionPanel({eventId,onChanged,onMessage}:{eventId:number;onChanged:()=>void;onMessage:(m:string,kind?:'info'|'error')=>void}) {
  const list=useResource<{data:any[]}>(`/events/${eventId}/discussions`);
  const [body,setBody]=useState('');
  const [busy,setBusy]=useState(false);
  const post=async()=>{const text=body.trim();if(!text){onMessage('Write a note before posting.','error');return;}setBusy(true);const r=await apiRaw(`/events/${eventId}/discussions`,{method:'POST',body:JSON.stringify({body:text})});setBusy(false);if(r.ok){onMessage('Planning note posted.');setBody('');list.reload();onChanged();}else onMessage((r.body as any).error||'Could not post the note.','error');};
  const remove=async(id:number)=>{if(!confirm('Delete this planning note?'))return;const r=await apiRaw(`/events/${eventId}/discussions/${id}`,{method:'DELETE'});if(r.ok){onMessage('Planning note deleted.');list.reload();onChanged();}else onMessage((r.body as any).error||'Could not delete the note.','error');};
  if(list.loading) return <Loading/>;
  if(list.error) return <ErrorState message={list.error} retry={list.reload}/>;
  const rows=list.data?.data||[];
  return <div>
    <div className="card-body" style={{border:'1px solid var(--line,#dbe3ee)',borderRadius:8,marginBottom:14}}>
      <div className="row-title">Post an update, question or decision</div>
      <textarea className="form-control" style={{marginTop:8,minHeight:90,resize:'vertical'}} value={body} onChange={e=>setBody(e.target.value)} placeholder="Who is chasing which owner, what was decided, what is still openΓÇª"/>
      <button className="button primary" style={{marginTop:10}} disabled={busy} onClick={post}><span className="material-symbols-outlined">send</span> Post to planning discussion</button>
      <p className="small" style={{marginTop:10,marginBottom:0}}>Authorized officials only ΓÇö ordinary members have no application accounts, so this cannot become a public forum. Posts are attributed and audited.</p>
    </div>
    {rows.length===0?<Empty label="No planning notes have been posted for this event yet." icon="forum"/>:
    <div style={{display:'flex',flexDirection:'column',gap:10}}>{rows.map(d=><div key={d.id} className="card-body" style={{border:'1px solid var(--line,#dbe3ee)',borderRadius:8}}>
      <div style={{display:'flex',justifyContent:'space-between',gap:8,alignItems:'baseline',flexWrap:'wrap'}}>
        <div className="row-title">{d.authorName||'Former official'}{d.authorRoles?<span className="row-subtitle"> ┬╖ {d.authorRoles}</span>:''}</div>
        <div className="small">{d.createdAt?new Date(`${String(d.createdAt).replace(' ','T')}Z`).toLocaleString():''}</div>
      </div>
      <p style={{whiteSpace:'pre-wrap',marginTop:8,marginBottom:10}}>{d.body}</p>
      <button className="button outline" onClick={()=>remove(d.id)}><span className="material-symbols-outlined">delete</span> Delete</button>
    </div>)}</div>}
  </div>;
}

/** Step B7 ΓÇö genuine change history read from the audit log; nothing is invented. */
const ACTIVITY_LABELS: Record<string,string> = {
  'event.create':'Event created','event.update':'Event details updated','event.duplicate':'Event duplicated','event.cancel':'Event cancelled',
  'event.requirement_add':'Gear requirement added','event.requirement_update':'Gear requirement updated','event.requirement_remove':'Gear requirement removed',
  'event.requirement_waive':'Gear requirement marked not needed','event.requirement_unwaive':'Gear requirement restored',
  'event.discussion_post':'Planning note posted','event.discussion_delete':'Planning note deleted',
  'assignment.create':'Team member assigned','assignment.override':'Assignment saved with authorized override','assignment.update':'Assignment updated',
  'assignment.contact':'Response status changed','assignment.cancel':'Assignment removed',
  'assignment.contact_sheet_view':'Contact sheet opened','assignment.contact_sheet_export':'Contact sheet exported (CSV)',
  'equipment.commit':'Gear commitment recorded','equipment.commitment_update':'Gear commitment updated','equipment.commitment_release':'Gear commitment released',
};

function ActivityPanel({eventId}:{eventId:number}) {
  const list=useResource<{data:any[]}>(`/events/${eventId}/activity`);
  if(list.loading) return <Loading/>;
  if(list.error) return <ErrorState message={list.error} retry={list.reload}/>;
  const rows=list.data?.data||[];
  if(!rows.length) return <Empty label="No changes have been recorded for this event yet. Activity appears as soon as this event, its team, its gear or its notes are changed." icon="history"/>;
  return <div style={{display:'flex',flexDirection:'column',gap:8}}>{rows.map((a,i)=>{const details=(a.details||{}) as any;return <div key={`${a.id}-${i}`} className="activity-item" style={{border:'1px solid var(--line,#dbe3ee)',borderRadius:8,padding:'10px 12px'}}>
    <span className="activity-dot"/>
    <div style={{flex:1}}>
      <div className="row-title">{ACTIVITY_LABELS[a.action]||a.action}</div>
      <div className="small">{a.actorName||'Authorized official'} ┬╖ {a.createdAt?new Date(`${String(a.createdAt).replace(' ','T')}Z`).toLocaleString():''}{details.description?` ┬╖ ${details.description}`:''}{details.status?` ┬╖ ${details.status}`:''}{details.from&&details.to?` ┬╖ ${details.from} ΓåÆ ${details.to}`:''}</div>
    </div>
  </div>;})}</div>;
}

/** The dedicated event workspace: Overview ΓåÆ Readiness for one event. */
function EventPlanPanel({event,onClose,onEdit,onMessage,reloadKey}:{event:SocietyEvent;onClose:()=>void;onEdit:()=>void;onMessage:(m:string,kind?:'info'|'error')=>void;reloadKey:number}) {
  const [tab,setTab]=useState(0);
  const [q,setQ]=useState('');
  const [findMode,setFindMode]=useState<'gear'|'profile'>('gear');
  const [gearQuery,setGearQuery]=useState('');
  const roles=String(event.creativeRequirements||'').split(/[,;\n]/).map((v)=>v.trim()).filter(Boolean);
  const readiness=useResource<any>(`/events/${event.id}/readiness`, reloadKey>=0);
  const members=useResource<{data:Member[]}>(`/members?search=${encodeURIComponent(q)}&pageSize=25`, tab===2&&findMode==='profile');
  const [pendingAssign,setPendingAssign]=useState<{payload:any;warnings:string[]}|null>(null);
  const [overrideReason,setOverrideReason]=useState('');
  const tabs=['Overview','Gear Requirements','Find Members','Team','Contact & Responses','Planning Discussion','Activity','Readiness'];
  const assign=async(payload:any)=>{const r=await apiRaw('/assignments',{method:'POST',body:JSON.stringify(payload)});if(r.ok){onMessage('Member assigned.');setPendingAssign(null);setOverrideReason('');readiness.reload();}else{const b=r.body as any;if(b.code==='ASSIGNMENT_WARNING')setPendingAssign({payload,warnings:b.warnings||[]});onMessage(b.error||'Could not assign this member.','error');}};
  const overrideAssign=async()=>{if(!pendingAssign)return;if(!overrideReason.trim()){onMessage('An override reason is required.','error');return;}await assign({...pendingAssign.payload,overrideWarnings:true,overrideReason:overrideReason.trim()});};
  const findOwners=(query:string)=>{setGearQuery(query);setFindMode('gear');setTab(2);};
  const refreshed=()=>readiness.reload();
  const s=readiness.data;
  return <Modal title={`Planning ┬╖ ${event.name}`} onClose={onClose} wide>
    <div className="modal-body">
      <div className="toolbar" style={{marginBottom:14}}>{tabs.map((label,i)=><button key={label} className={`button ${i===tab?'navy':'outline'}`} onClick={()=>setTab(i)}>{i+1}. {label}</button>)}</div>
      {tab===0&&<div className="card-body"><div className="form-grid">
        <div><div className="eyebrow">Date</div><strong>{event.eventDate}</strong></div>
        <div><div className="eyebrow">Start time (Sri Lanka)</div><strong>{event.startTime}</strong></div>
        <div><div className="eyebrow">Status</div><span className={`chip ${statusClass(event.status)}`}>{event.status}</span></div>
        <div><div className="eyebrow">Priority</div><span className={`chip ${statusClass(event.priority)}`}>{event.priority}</span></div>
        <div><div className="eyebrow">Venue</div><strong>{event.venue}</strong></div>
        <div><div className="eyebrow">Organizing official</div><strong>{event.organizerName||'Not assigned'}</strong></div>
        <div><div className="eyebrow">Category</div><strong>{event.category}</strong></div>
        <div><div className="eyebrow">Draft</div><strong>{event.isDraft?'Yes ΓÇö not yet confirmed':'No'}</strong></div>
      </div>{event.description&&<p style={{marginTop:12}}>{event.description}</p>}
      <div className="eyebrow" style={{marginTop:12}}>Required creative roles and team size</div>
      <p style={{marginTop:6}}>Team size: <strong>{event.requiredTeamSize||'Not specified'}</strong>{roles.length?` ┬╖ ${roles.join(', ')}`:' ┬╖ No roles specified yet.'}</p>
      <div className="eyebrow" style={{marginTop:12}}>Additional instructions</div>
      <p style={{whiteSpace:'pre-wrap',marginTop:6}}>{event.additionalInstructions||'None.'}</p>
      <div className="eyebrow" style={{marginTop:12}}>Free-text gear notes</div>
      <p style={{whiteSpace:'pre-wrap',marginTop:6}}>{event.photographyRequirements||'None. Track gear in the Gear Requirements tab.'}</p>
      <div className="alert info" style={{marginTop:12}}>Only a date and a single start time are recorded. No end time is required, so conflicts are reported by date only ΓÇö the system never claims two events overlap in time.</div>
      <button className="button outline" style={{marginTop:12}} onClick={onEdit}><span className="material-symbols-outlined">edit</span> Edit event details</button></div>}
      {tab===1&&<div className="card-body">
        <RequirementsPanel eventId={event.id} onFindOwners={findOwners} onChanged={refreshed} onMessage={onMessage}/>
      </div>}
      {tab===2&&<div className="card-body">
        <div className="toolbar" style={{marginBottom:12}}>
          <button className={`button ${findMode==='gear'?'navy':'outline'}`} onClick={()=>setFindMode('gear')}>Search the Gear Directory</button>
          <button className={`button ${findMode==='profile'?'navy':'outline'}`} onClick={()=>setFindMode('profile')}>Search member profiles</button>
        </div>
        {findMode==='gear'?<div key={gearQuery}>
          {gearQuery&&<div className="alert info" style={{marginBottom:12}}>Finding owners who match <strong>{gearQuery}</strong> for {event.eventDate}.</div>}
          <EquipmentSearchPanel key={gearQuery} eventId={event.id} eventDate={event.eventDate} roles={roles} initialQuery={gearQuery} onMessage={onMessage}/>
        </div>:<div>
        <div className="search-wrap" style={{marginBottom:12}}><span className="material-symbols-outlined">search</span><input placeholder="Search members by name, ID, grade, role, skill or gearΓÇª" value={q} onChange={e=>setQ(e.target.value)}/></div>
        {members.loading?<Loading/>:members.error?<ErrorState message={members.error}/>:
        (members.data?.data.length?<div className="table-wrap"><table><thead><tr><th>Member</th><th>Roles</th><th>Gear</th><th></th></tr></thead><tbody>{members.data.data.map((m)=><tr key={m.id}>
          <td><div className="row-title">{m.fullName}</div><div className="row-subtitle">{m.memberCode} ┬╖ Grade {m.grade} {m.className} ┬╖ {m.status}</div></td>
          <td>{m.roles.map((r)=>r.name).join(', ')||'ΓÇö'}</td>
          <td>{(m as any).equipmentCount?`${(m as any).equipmentCount} item(s)`:'ΓÇö'}</td>
          <td><button className="icon-button" title="Assign to this event" onClick={()=>setPendingAssign({payload:{eventId:event.id,memberId:m.id,responsibility:roles[0]||'Photographer',status:'Contact Pending',notes:'',overrideWarnings:false},warnings:[]})}><span className="material-symbols-outlined">group_add</span></button></td>
        </tr>)}</tbody></table></div>:<Empty label={q?`No members match "${q}".`:'No members registered yet.'} icon="groups"/>)}
        </div>}
      </div>}
      {tab===3&&<div className="card-body">
        {pendingAssign&&<div className="alert error" style={{marginBottom:12}}><strong>Review required.</strong><ul style={{margin:'8px 0 8px 18px',padding:0}}>{pendingAssign.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul><input className="form-control" placeholder="Reason for authorized override" value={overrideReason} onChange={e=>setOverrideReason(e.target.value)}/><div style={{display:'flex',gap:8,marginTop:8}}><button className="button primary" onClick={overrideAssign}>Record override and assign</button><button className="button outline" onClick={()=>setPendingAssign(null)}>Cancel</button></div></div>}
        <AssignmentsList eventId={event.id} onMessage={onMessage} reloadKey={reloadKey}/>
      </div>}
      {tab===4&&<div className="card-body">
        <ContactSheet eventId={event.id} onMessage={onMessage}/>
      </div>}
      {tab===5&&<div className="card-body">
        <DiscussionPanel eventId={event.id} onChanged={refreshed} onMessage={onMessage}/>
      </div>}
      {tab===6&&<div className="card-body">
        <ActivityPanel eventId={event.id}/>
      </div>}
      {tab===7&&<div className="card-body">
        {readiness.loading?<Loading/>:readiness.error?<ErrorState message={readiness.error} retry={readiness.reload}/>:s&&<>
          <div className="metric-grid" style={{marginBottom:12}}>
            <div className="metric"><div className="metric-label"><span>Assigned</span></div><div className="metric-value">{s.summary.assigned}/{s.summary.requiredTeamSize||'ΓÇö'}</div></div>
            <div className="metric"><div className="metric-label"><span>Confirmed</span></div><div className="metric-value">{s.summary.confirmed}</div></div>
            <div className="metric"><div className="metric-label"><span>Awaiting response</span></div><div className="metric-value">{s.summary.awaitingResponse}</div></div>
            <div className="metric"><div className="metric-label"><span>Gear awaiting owner</span></div><div className="metric-value">{s.summary.unconfirmedEquipment}</div></div>
            <div className="metric"><div className="metric-label"><span>Gear requirements met</span></div><div className="metric-value">{s.summary.gearFulfilled}/{s.summary.gearRequirements||0}</div></div>
            <div className="metric"><div className="metric-label"><span>Gear waived</span></div><div className="metric-value">{s.summary.gearWaived||0}</div></div>
          </div>
          {s.summary.ready?<div className="alert info">This plan is ready to confirm.</div>:<div className="alert error"><strong>{s.summary.blockers.length} item(s) to resolve</strong><ul style={{margin:'8px 0 0 18px',padding:0}}>{s.summary.blockers.map((b:string,i:number)=><li key={i}>{b}</li>)}</ul></div>}
          {s.summary.sameDateConflicts>0&&<div className="alert info">{s.summary.sameDateConflicts} member(s) on this team are also assigned to another event on {event.eventDate}. Only dates and start times are recorded, so the system cannot determine whether those events actually overlap in time.</div>}
          <div className="eyebrow" style={{marginTop:14}}>Readiness detail</div>
          <div className="table-wrap" style={{marginTop:8}}><table><thead><tr><th>Role</th><th>Required</th><th>Assigned</th><th>Confirmed</th></tr></thead><tbody>
            {(s.roles||[]).length?s.roles.map((r:any,i:number)=><tr key={i}><td>{r.responsibility}</td><td>{r.required}</td><td>{r.assigned}</td><td>{r.confirmed}</td></tr>):<tr><td colSpan={4} className="small">No required roles were entered on the event.</td></tr>}
          </tbody></table></div>
          <div className="eyebrow" style={{marginTop:14}}>Gear requirements</div>
          <div className="table-wrap" style={{marginTop:8}}><table><thead><tr><th>Requirement</th><th>Priority</th><th>Linked gear</th><th>Status</th></tr></thead><tbody>
            {(s.requirements||[]).length?s.requirements.map((r:any)=>(<tr key={r.id}><td>{r.description}{r.quantity>1?` ├ù ${r.quantity}`:''}</td><td><span className={`chip ${statusClass(r.priority)}`}>{r.priority}</span></td><td>{r.brand?`${r.brand} ${r.model}${r.focalLength?` ┬╖ ${r.focalLength}`:''}`:'Not linked to a gear record yet'}</td><td><span className={`chip ${statusClass(r.waivedAt?'Waived':r.availability)}`}>{r.waivedAt?'Waived':r.availability}</span></td></tr>)):<tr><td colSpan={4} className="small">No gear requirements have been recorded for this event.</td></tr>}
          </tbody></table></div>
          <button className="button primary" style={{marginTop:14}} disabled={!s.summary.ready} onClick={async()=>{const r=await apiRaw(`/events/${event.id}`,{method:'PATCH',body:JSON.stringify({eventCode:event.eventCode,name:event.name,description:event.description||'',category:event.category,eventDate:event.eventDate,startTime:event.startTime,venue:event.venue,organizerMemberId:event.organizerMemberId||null,priority:event.priority,requiredTeamSize:event.requiredTeamSize,additionalInstructions:event.additionalInstructions||'',photographyRequirements:event.photographyRequirements||'',creativeRequirements:event.creativeRequirements||'',status:'Confirmed',isDraft:false,notes:event.notes||'',endsAt:null})});if(r.ok){onMessage('Event plan confirmed.');readiness.reload();}else onMessage((r.body as any).error||'Could not confirm the plan.','error');}}><span className="material-symbols-outlined">check_circle</span> Confirm plan</button>
        </>}
      </div>}
    </div>
  </Modal>;
}

export default App;
