/* ============================================================================
 * ZF Recovery Tracker — shared, adapter-driven maintenance tracker module
 * ----------------------------------------------------------------------------
 * The "Recovery Protocol" bedroom-maintenance tracker, extracted from the
 * /webinar-bonuses page so the exact same logic can later run inside the paid
 * /app. No build step: this is a plain browser-global script (no ES modules).
 *
 * The module NEVER touches localStorage (or any storage) directly. Every read
 * and write goes through an injected `store` adapter, so different hosts can
 * back it with different persistence (localStorage today, Supabase later)
 * without changing this file.
 *
 * ---------------------------------------------------------------------------
 * RecoveryStore interface (all methods may return a value OR a Promise of it):
 *
 *   getState()        -> { units: [...], dates: {...} }
 *   setState(state)   -> void        // persists BOTH units and dates together
 *
 *   `units` is the array of { id, key, label }:
 *       id    — "<key>-<suffix>" (suffix "1" for the seeded default, else a
 *               timestamp for user-added units)
 *       key   — the item type (one of ITEMS[].key)
 *       label — a free-text user label ("" by default)
 *   `dates` is the flat map { "<unitId>|<taskIndex>": "<YYYY-MM-DD>" }.
 *
 * The module keeps state as a single in-memory object and calls
 * setState({ units, dates }) whenever EITHER structure changes. How and where
 * that is stored is entirely the adapter's decision. Results are Promise-wrapped
 * internally, so a future async (Supabase) adapter works without any change here.
 *
 * Use ZFRecoveryTracker.defaultUnits() to build the initial seed (one unit per
 * item type) — the localStorage adapter uses it to reproduce the original
 * "seed if absent" behavior.
 *
 * Entry point:
 *   ZFRecoveryTracker.init({
 *     store,            // required — RecoveryStore adapter
 *     trackerEl,        // required — host element or CSS selector for the UI
 *     icsButtonEl,      // optional — .ics export button (element or selector)
 *     statusEl          // optional — status text element (element or selector)
 *   })
 * Safe to call once per page. If trackerEl is not found, it no-ops gracefully.
 * ==========================================================================*/
(function () {
  'use strict';

  /* ----- static config: item types + their maintenance tasks -------------- */
  var ITEMS = [
    {key:'sheets',   name:'Bedsheets',          tasks:[ {t:'Wash at 140 F (60 C)',lab:'Weekly',cls:'freq-weekly',freq:'weekly',rrule:'FREQ=WEEKLY'}, {t:'Replace',lab:'Every 2-3 yrs',cls:'freq-replace',freq:'2y',rrule:'FREQ=YEARLY;INTERVAL=2'} ]},
    {key:'pillow',   name:'Pillow',             tasks:[ {t:'Fold test (folded = dead)',lab:'Monthly',cls:'freq-monthly',freq:'monthly',rrule:'FREQ=MONTHLY'}, {t:'Wash',lab:'Every 3-6 mo',cls:'freq-quarterly',freq:'3mo',rrule:'FREQ=MONTHLY;INTERVAL=3'}, {t:'Replace',lab:'Every 1-3 yrs',cls:'freq-replace',freq:'1y',rrule:'FREQ=YEARLY'} ]},
    {key:'protector',name:'Mattress protector', tasks:[ {t:'Wash at 140 F (60 C)',lab:'Monthly',cls:'freq-monthly',freq:'monthly',rrule:'FREQ=MONTHLY'}, {t:'Replace',lab:'Every 2-3 yrs',cls:'freq-replace',freq:'2y',rrule:'FREQ=YEARLY;INTERVAL=2'} ]},
    {key:'blanket',  name:'Blanket',            tasks:[ {t:'Air out',lab:'Monthly',cls:'freq-monthly',freq:'monthly',rrule:'FREQ=MONTHLY'}, {t:'Dry clean',lab:'Annually',cls:'freq-yearly',freq:'1y',rrule:'FREQ=YEARLY'}, {t:'Replace',lab:'Every 5-10 yrs',cls:'freq-replace',freq:'5y',rrule:'FREQ=YEARLY;INTERVAL=5'} ]},
    {key:'mattress', name:'Mattress',           tasks:[ {t:'Rotate 180 degrees',lab:'Every 3-6 mo',cls:'freq-quarterly',freq:'3mo',rrule:'FREQ=MONTHLY;INTERVAL=3'}, {t:'Replace',lab:'Every 7-10 yrs',cls:'freq-replace',freq:'7y',rrule:'FREQ=YEARLY;INTERVAL=7'} ]},
    {key:'curtains', name:'Blackout curtains',  tasks:[ {t:'Wash or vacuum',lab:'Every 3-6 mo',cls:'freq-quarterly',freq:'3mo',rrule:'FREQ=MONTHLY;INTERVAL=3'}, {t:'Replace',lab:'Every 5-7 yrs',cls:'freq-replace',freq:'5y',rrule:'FREQ=YEARLY;INTERVAL=5'} ]},
    {key:'frame',    name:'Bed frame',          tasks:[ {t:'Check slats for cracks',lab:'Annually',cls:'freq-yearly',freq:'1y',rrule:'FREQ=YEARLY'}, {t:'Replace',lab:'10+ yrs',cls:'freq-replace',freq:'10y',rrule:'FREQ=YEARLY;INTERVAL=10'} ]}
  ];
  var ITEM_BY_KEY = {}; ITEMS.forEach(function(it){ ITEM_BY_KEY[it.key]=it; });

  /* ----- pure date helpers (shared by render + .ics export) --------------- */
  function addInterval(d, freq){ var x=new Date(d.getTime());
    if(freq==='weekly') x.setDate(x.getDate()+7);
    else if(freq==='monthly') x.setMonth(x.getMonth()+1);
    else if(freq==='3mo') x.setMonth(x.getMonth()+3);
    else { var y=parseInt(freq,10); if(!isNaN(y)) x.setFullYear(x.getFullYear()+y); }
    return x; }
  function parseVal(v){ if(!v) return null; var p=v.split('-'); return new Date(+p[0],+p[1]-1,+p[2]); }
  function fmtDate(d){ return d.toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}); }

  /* ----- .ics date helpers ------------------------------------------------ */
  function pad(n){ return (n<10?'0':'')+n; }
  function icsDate(d){ return d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate()); }
  function icsStamp(){ var d=new Date(); return d.getUTCFullYear()+pad(d.getUTCMonth()+1)+pad(d.getUTCDate())+'T'+pad(d.getUTCHours())+pad(d.getUTCMinutes())+pad(d.getUTCSeconds())+'Z'; }

  /* ----- module state (populated by init) --------------------------------- */
  var store=null, host=null, icsBtnEl=null, statusEl=null;
  var units=[], dates={};

  /* one unit per item type — the original "seed if absent" default */
  function defaultUnits(){ return ITEMS.map(function(it){ return {id:it.key+'-1', key:it.key, label:''}; }); }

  /* accept either an element or a CSS selector string */
  function resolveEl(ref){ if(!ref) return null; return (typeof ref==='string') ? document.querySelector(ref) : ref; }

  /* Persist current state through the adapter. Fire-and-forget: the in-memory
     state is already the source of truth for rendering, so the UI stays instant
     regardless of adapter latency. Promise-wrapped so an async adapter fits
     unchanged; the adapter owns its own error handling. */
  function persist(){ try{ return Promise.resolve(store.setState({ units: units, dates: dates })); }catch(e){ return Promise.resolve(); } }

  /* Debounced persist for label typing. The in-memory label is updated synchronously on
     every keystroke (see the .unit-label handler), so state / render / .ics stay accurate;
     only the write is coalesced to a single call 600 ms after the user stops typing. Because
     persist() saves the whole { units, dates }, one shared timer is correct — never per-field.
     By product decision there is no blur/unload flush: a label lost within 600 ms of the last
     keystroke on close/navigation is acceptable. */
  var labelTimer;
  function persistLabelDebounced(){ clearTimeout(labelTimer); labelTimer = setTimeout(persist, 600); }

  function render(){
    if(!host) return;
    var html='';
    ITEMS.forEach(function(it){
      var unitsOf = units.filter(function(u){ return u.key===it.key; });
      unitsOf.forEach(function(u){
        html += '<div class="unit" data-uid="'+u.id+'">';
        html += '<div class="unit-head"><span class="unit-name">'+it.name+'</span>'+
                '<input class="unit-label" data-uid="'+u.id+'" placeholder="label (e.g. Set A, His, Hers)" value="'+(u.label||'').replace(/"/g,'&quot;')+'">'+
                (unitsOf.length>1 ? '<button class="unit-del" data-uid="'+u.id+'">remove</button>' : '')+'</div>';
        it.tasks.forEach(function(tk,ti){
          var key=u.id+'|'+ti, v=dates[key]||'', nextHtml='<span class="m">-</span>';
          if(v){ var nd=addInterval(parseVal(v),tk.freq); var due=nd<=new Date();
            nextHtml='<span class="next'+(due?' due':'')+'">'+fmtDate(nd)+'</span>'; }
          html += '<div class="task"><span class="task-name">'+tk.t+'</span>'+
                  '<span class="freq '+tk.cls+'">'+tk.lab+'</span>'+
                  '<input type="date" data-key="'+key+'" value="'+v+'">'+
                  '<span class="next-wrap">Next: '+nextHtml+'</span></div>';
        });
        html += '</div>';
      });
      html += '<button class="addbtn print-hide" data-add="'+it.key+'">+ Add another '+it.name.toLowerCase()+'</button>';
    });
    host.innerHTML = html;

    host.querySelectorAll('input[type=date]').forEach(function(inp){
      inp.addEventListener('change', function(){ var k=this.getAttribute('data-key');
        if(this.value) dates[k]=this.value; else delete dates[k]; persist(); render(); });
    });
    host.querySelectorAll('.unit-label').forEach(function(inp){
      inp.addEventListener('input', function(){ var id=this.getAttribute('data-uid');
        var u=units.filter(function(x){return x.id===id;})[0]; if(u){ u.label=this.value; persistLabelDebounced(); } });
    });
    host.querySelectorAll('.addbtn').forEach(function(b){
      b.addEventListener('click', function(){ var key=this.getAttribute('data-add');
        var n=units.filter(function(x){return x.key===key;}).length;
        units.push({id:key+'-'+(Date.now()), key:key, label:''}); persist(); render(); });
    });
    host.querySelectorAll('.unit-del').forEach(function(b){
      b.addEventListener('click', function(){ var id=this.getAttribute('data-uid');
        units=units.filter(function(x){return x.id!==id;});
        Object.keys(dates).forEach(function(k){ if(k.indexOf(id+'|')===0) delete dates[k]; });
        persist(); render(); });
    });
  }

  /* ----- calendar export (.ics) ------------------------------------------- */
  function wireIcs(){
    if(!icsBtnEl) return;
    icsBtnEl.addEventListener('click', function(){
      var ev='', n=0;
      units.forEach(function(u){
        var it=ITEM_BY_KEY[u.key]; if(!it) return;
        it.tasks.forEach(function(tk,ti){
          var v=dates[u.id+'|'+ti]; if(!v) return; var nd=addInterval(parseVal(v),tk.freq); n++;
          var who=u.label?(' ('+u.label+')'):'';
          ev += 'BEGIN:VEVENT\r\nUID:zf-'+u.id+'-'+ti+'-'+Date.now()+'@thezerofog.com\r\nDTSTAMP:'+icsStamp()+
            '\r\nDTSTART;VALUE=DATE:'+icsDate(nd)+'\r\nRRULE:'+tk.rrule+
            '\r\nSUMMARY:ZeroFog - '+it.name+who+': '+tk.t+
            '\r\nDESCRIPTION:Recovery Protocol maintenance reminder.\r\n'+
            'BEGIN:VALARM\r\nTRIGGER:PT0S\r\nACTION:DISPLAY\r\nDESCRIPTION:'+it.name+' - '+tk.t+'\r\nEND:VALARM\r\nEND:VEVENT\r\n';
        });
      });
      if(!n){ if(statusEl) statusEl.textContent='Fill in at least one date first.'; return; }
      var cal='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//The Zero Fog//Recovery Protocol//EN\r\nCALSCALE:GREGORIAN\r\n'+ev+'END:VCALENDAR\r\n';
      var blob=new Blob([cal],{type:'text/calendar;charset=utf-8'}), a=document.createElement('a');
      a.href=URL.createObjectURL(blob); a.download='zerofog-bedroom-reminders.ics';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function(){ URL.revokeObjectURL(a.href); },1000);
      if(statusEl) statusEl.textContent=n+' reminder'+(n>1?'s':'')+' downloaded.';
    });
  }

  /* ----- entry point ------------------------------------------------------ */
  function init(opts){
    opts = opts || {};
    host = resolveEl(opts.trackerEl);
    if(!host) return Promise.resolve();   // no host on this page — no-op
    store = opts.store;
    icsBtnEl = resolveEl(opts.icsButtonEl);
    statusEl = resolveEl(opts.statusEl);
    return Promise.resolve(store.getState()).then(function(state){
      units = (state && state.units) || defaultUnits();
      dates = (state && state.dates) || {};
      render();
      wireIcs();
    });
  }

  window.ZFRecoveryTracker = { init: init, defaultUnits: defaultUnits, ITEMS: ITEMS };
})();
