/* ============================================================================
 * ZF Recovery Tracker — shared, adapter-driven maintenance tracker module
 * ----------------------------------------------------------------------------
 * The "Recovery Protocol" bedroom-maintenance tracker. No build step: a plain
 * browser-global script (no ES modules).
 *
 * WHY THIS ASKS ONLY ONE QUESTION PER ITEM
 * The first version asked for a date on every task — sixteen date pickers. Nine
 * of them asked "when did you last do this?" about things nobody had ever done
 * (rotate the mattress, fold-test the pillow, check the slats), so there was no
 * true answer to give. The remaining seven asked for a purchase date, which
 * people know only roughly ("about four years") and cannot enter precisely in a
 * calendar widget.
 *
 * So the two questions are now split by whether input helps at all:
 *   - REPLACEMENT needs the age. Asked once per item, in rough buckets, one tap.
 *   - CARE never needs input. It is a recurring cycle and it starts today.
 * The pillow's fold test is not a task: it is how you learn the answer early, so
 * it surfaces inside the pillow's own verdict once the age reaches its lifespan.
 *
 * The module NEVER touches localStorage (or any storage) directly. Every read
 * and write goes through an injected `store` adapter, so different hosts can
 * back it with different persistence (localStorage, Supabase) unchanged.
 *
 * ---------------------------------------------------------------------------
 * RecoveryStore interface (all methods may return a value OR a Promise of it):
 *
 *   getState()        -> { units: [...], care: {...}, dates: {...} }
 *   setState(state)   -> void        // persists the whole object together
 *
 *   `units` is the array of { id, key, label, age }:
 *       id    — "<key>-<suffix>" (suffix "1" for the seeded default, else a
 *               timestamp for user-added units)
 *       key   — the item type (one of ITEMS[].key)
 *       label — free-text user label ("" by default), e.g. "Kids", "Guest"
 *       age   — index into that item's `chips`, or null when unanswered
 *   `care`  is { started: "<YYYY-MM-DD>" } — the day the care cycles were put
 *           in the calendar, so a re-export keeps the same anchor.
 *   `dates` is the retired per-task date map. Read but never written; kept in
 *           the shape so old stored rows deserialise without error.
 *
 * Use ZFRecoveryTracker.defaultUnits() to build the initial seed (one unit per
 * item type).
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

  /* ----- items that wear out: one age question each ------------------------
     `life` is [earliest, latest] replacement year. `chips` are what the reader
     taps; `vals` are the years each chip means, used for the verdict and for
     the replacement date. Ordered by what costs most to get wrong.            */
  var ITEMS = [
    {key:'mattress', name:'Mattress',           life:[7,10],  chips:['New','1-2','3-4','5-6','7-9','10+'], vals:[0,1.5,3.5,5.5,8,10]},
    {key:'pillow', multi:true,   name:'Pillow',             life:[1,3],   chips:['New','1','2','3+'],                  vals:[0,1,2,3],
     test:'fold it in half - if it stays folded, it is dead'},
    {key:'blanket', multi:true,  name:'Blanket',            life:[5,10],  chips:['New','1-2','3-5','6-9','10+'],       vals:[0,1.5,4,7.5,10]},
    {key:'curtains', name:'Blackout curtains',  life:[5,7],   chips:['New','1-2','3-4','5-6','7+'],        vals:[0,1.5,3.5,5.5,7]},
    {key:'protector', multi:true,name:'Mattress protector', life:[2,3],   chips:['New','1','2','3+'],                  vals:[0,1,2,3]},
    {key:'sheets', multi:true,   name:'Bedsheets',          life:[2,3],   chips:['New','1','2','3+'],                  vals:[0,1,2,3]},
    {key:'frame',    name:'Bed frame',          life:[10,15], chips:['New','1-4','5-9','10+'],             vals:[0,2.5,7,10]}
  ];
  var ITEM_BY_KEY = {}; ITEMS.forEach(function(it){ ITEM_BY_KEY[it.key]=it; });

  /* ----- recurring care: no input, everything starts today -----------------
     `act` leads with the action that changes tonight, not with the chore that
     follows it. Changing the set is what puts you in a clean bed; washing what
     you took off can happen whenever — so the reminder is for the change.      */
  var CARE = [
    {id:'set',       act:'Change the set',             note:'wash the one you took off at 140 F (60 C) - whenever suits you', lab:'Weekly',       cls:'freq-weekly',    freq:'weekly',  rrule:'FREQ=WEEKLY'},
    {id:'protector', act:'Wash the mattress protector',note:'140 F (60 C)',                                                   lab:'Monthly',      cls:'freq-monthly',   freq:'monthly', rrule:'FREQ=MONTHLY'},
    {id:'air',       act:'Air out the blanket',        note:'an open window or a balcony for a few hours',                    lab:'Monthly',      cls:'freq-monthly',   freq:'monthly', rrule:'FREQ=MONTHLY'},
    {id:'rotate',    act:'Rotate the mattress',        note:'180 degrees, head to foot',                                      lab:'Every 3-6 mo', cls:'freq-quarterly', freq:'3mo',     rrule:'FREQ=MONTHLY;INTERVAL=3'},
    {id:'curtains',  act:'Vacuum or wash the curtains',note:'dust settles in the folds',                                      lab:'Every 3-6 mo', cls:'freq-quarterly', freq:'3mo',     rrule:'FREQ=MONTHLY;INTERVAL=3'},
    {id:'slats',     act:'Check the frame slats',      note:'a cracked slat sags and takes the mattress with it',             lab:'Annually',     cls:'freq-yearly',    freq:'1y',      rrule:'FREQ=YEARLY'},
    {id:'dryclean',  act:'Dry clean the blanket',      note:'',                                                               lab:'Annually',     cls:'freq-yearly',    freq:'1y',      rrule:'FREQ=YEARLY'}
  ];

  /* ----- date helpers ------------------------------------------------------ */
  function pad(n){ return n<10?('0'+n):(''+n); }
  function today(){ var d=new Date(); d.setHours(0,0,0,0); return d; }
  function isoDate(d){ return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); }
  function addYears(d, years){
    var x=new Date(d.getTime());
    var whole=Math.floor(years), months=Math.round((years-whole)*12);
    x.setFullYear(x.getFullYear()+whole); x.setMonth(x.getMonth()+months);
    return x;
  }
  function addDays(d, n){ var x=new Date(d.getTime()); x.setDate(x.getDate()+n); return x; }
  function parseISO(v){ var p=String(v).split('-'); return new Date(+p[0], (+p[1])-1, +p[2]); }
  /* one cycle forward from a date, for the "next time" line under each care task */
  function addInterval(d, freq){
    var x=new Date(d.getTime());
    if(freq==='weekly') x.setDate(x.getDate()+7);
    else if(freq==='monthly') x.setMonth(x.getMonth()+1);
    else if(freq==='3mo') x.setMonth(x.getMonth()+3);
    else { var y=parseInt(freq,10); if(!isNaN(y)) x.setFullYear(x.getFullYear()+y); }
    return x;
  }
  function fmtDate(d){
    return d.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});
  }

  /* ----- .ics helpers ------------------------------------------------------ */
  function icsDate(d){ return d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate()); }
  function icsStamp(){ var d=new Date(); return d.getUTCFullYear()+pad(d.getUTCMonth()+1)+pad(d.getUTCDate())+'T'+pad(d.getUTCHours())+pad(d.getUTCMinutes())+pad(d.getUTCSeconds())+'Z'; }
  function icsEscape(s){ return String(s).replace(/([,;\\])/g,'\\$1').replace(/\n/g,'\\n'); }

  /* ----- module state ------------------------------------------------------ */
  var store=null, host=null, icsBtnEl=null, statusEl=null;
  var units=[], care={}, legacyDates={};
  var openCare=null;   // id of the care task whose date picker is expanded, if any

  function resolveEl(v){
    if(!v) return null;
    return typeof v === 'string' ? document.querySelector(v) : v;
  }
  function defaultUnits(){
    return ITEMS.map(function(it){ return {id:it.key+'-1', key:it.key, label:'', age:null}; });
  }
  function persist(){
    return Promise.resolve(store.setState({ units: units, care: care, dates: legacyDates }));
  }

  /* Debounced persist for label typing: the in-memory label updates on every
     keystroke, so render and .ics stay accurate even before the write lands. */
  var labelTimer;
  function persistLabelDebounced(){ clearTimeout(labelTimer); labelTimer=setTimeout(persist,600); }

  /* ----- verdicts ----------------------------------------------------------
     Never invents precision: the answer is a bucket, so the verdict is a range.
     A pillow past its earliest year gets pointed at the fold test rather than a
     replacement date, because the test is the real answer and it is free.      */
  function verdict(it, yrs){
    var lo=it.life[0], hi=it.life[1];
    if(yrs>=hi) return {txt:'Replace it', cls:'now'};
    if(yrs>=lo) return {txt: it.test ? 'Run the test now' : 'Due - check it', cls:'soon'};
    var a=Math.max(1, Math.round(lo-yrs)), b=Math.round(hi-yrs);
    return {txt:'Good for '+a+'-'+b+' more years', cls:'ok'};
  }
  /* When to put "replace this" in the calendar. Already past the window means
     it is a task for now, not a date years away — a week out, so it survives
     tonight and still nags. */
  function replaceDate(it, yrs){
    var lo=it.life[0];
    if(yrs>=lo) return addDays(today(),7);
    return addYears(today(), lo-yrs);
  }

  /* ----- render ------------------------------------------------------------ */
  function render(){
    if(!host) return;
    var html='';

    html += '<div class="rt-block">';
    html += '<div class="rt-head"><span class="rt-title">How old is it?</span>'+
            '<span class="rt-prog" id="rtProg"></span></div>';
    html += '<p class="rt-sub">The one thing we cannot know for you. Rough is fine - "about four years" beats an empty box.</p>';

    ITEMS.forEach(function(it){
      var unitsOf = units.filter(function(u){ return u.key===it.key; });
      unitsOf.forEach(function(u, idx){
        var answered = u.age !== null && u.age !== undefined;
        var v = answered ? verdict(it, it.vals[u.age]) : null;
        html += '<div class="rt-item">';
        html += '<div class="rt-row">';
        html += '<span class="rt-name">'+it.name+
                (unitsOf.length>1 ? '<input class="rt-label" data-uid="'+u.id+'" placeholder="Ours / Kids / Guest" value="'+(u.label||'').replace(/"/g,'&quot;')+'">' : '')+
                '</span>';
        html += '<span class="rt-chips">';
        it.chips.forEach(function(c,i){
          html += '<button type="button" class="rt-chip'+(answered && u.age===i ? ' on':'')+
                  '" data-uid="'+u.id+'" data-age="'+i+'">'+c+'</button>';
        });
        html += '</span>';
        html += '<span class="rt-verdict'+(v?' '+v.cls:'')+'">'+
                (v ? v.txt : 'lasts '+it.life[0]+'-'+it.life[1]+' yrs')+'</span>';
        if(unitsOf.length>1) html += '<button type="button" class="rt-del" data-uid="'+u.id+'" title="Remove">&times;</button>';
        html += '</div>';
        if(it.test && answered && it.vals[u.age] >= it.life[0]){
          html += '<div class="rt-test">The test: '+it.test+'</div>';
        }
        html += '</div>';
      });
      if(it.multi) html += '<button type="button" class="rt-add" data-add="'+it.key+'">+ Another '+it.name.toLowerCase()+'</button>';
    });
    html += '</div>';

    html += '<div class="rt-block rt-care">';
    html += '<div class="rt-head"><span class="rt-title">Keeping it that way</span></div>';
    html += '<p class="rt-sub">Nothing to fill in. Tick a line the day you actually do it and the reminder counts from there - you will not do all seven on the same day, and it does not have to pretend you did.</p>';
    CARE.forEach(function(c){
      var from = (care.starts||{})[c.id];
      var next = from ? addInterval(parseISO(from), c.freq) : null;
      var open = openCare === c.id;
      html += '<div class="rt-care-row'+(from?' set':'')+'">'+
              '<span class="rt-act">'+c.act+(c.note ? '<small>'+c.note+'</small>' : '')+'</span>'+
              '<span class="freq '+c.cls+'">'+c.lab+'</span>'+
              (next ? '<span class="rt-next">next '+fmtDate(next)+'</span>' : '')+
              '<button type="button" class="rt-did'+(from?' again':'')+'" data-open="'+c.id+'">'+
                (from ? 'Change' : 'Track this')+'</button>'+
              (from ? '<button type="button" class="rt-cal1" data-cal="'+c.id+'" title="Send just this one to the calendar">&#128197;</button>' : '')+
              '</div>';
      if(open){
        // Back-dating matters here and nowhere else in this tracker: "I changed the
        // sheets on Saturday" is a fact the reader holds precisely, unlike the age
        // of a mattress. Today and Yesterday cover almost every case in one tap;
        // the date field is there for the rest.
        html += '<div class="rt-when">'+
                '<span class="rt-when-q">When did you last do it?</span>'+
                '<button type="button" class="rt-w" data-set="'+c.id+'" data-back="0">Today</button>'+
                '<button type="button" class="rt-w" data-set="'+c.id+'" data-back="1">Yesterday</button>'+
                '<input type="date" class="rt-wdate" data-set="'+c.id+'" max="'+isoDate(today())+'" value="'+(from||'')+'">'+
                '</div>';
      }
    });
    html += '</div>';

    host.innerHTML = html;

    var answeredCount = units.filter(function(u){ return u.age!==null && u.age!==undefined; }).length;
    var prog = host.querySelector('#rtProg');
    if(prog) prog.textContent = answeredCount+' of '+units.length+' answered';

    host.querySelectorAll('.rt-chip').forEach(function(b){
      b.addEventListener('click', function(){
        var id=this.getAttribute('data-uid');
        var u=units.filter(function(x){ return x.id===id; })[0];
        if(!u) return;
        u.age = +this.getAttribute('data-age');
        persist(); render();
      });
    });
    host.querySelectorAll('.rt-label').forEach(function(inp){
      inp.addEventListener('input', function(){
        var id=this.getAttribute('data-uid');
        var u=units.filter(function(x){ return x.id===id; })[0];
        if(u){ u.label=this.value; persistLabelDebounced(); }
      });
    });
    host.querySelectorAll('.rt-add').forEach(function(b){
      b.addEventListener('click', function(){
        var key=this.getAttribute('data-add');
        units.push({id:key+'-'+(Date.now()), key:key, label:'', age:null});
        persist(); render();
      });
    });
    host.querySelectorAll('.rt-del').forEach(function(b){
      b.addEventListener('click', function(){
        var id=this.getAttribute('data-uid');
        units=units.filter(function(x){ return x.id!==id; });
        persist(); render();
      });
    });
    /* Anchoring one task's cycle to the day it was actually done. Re-anchoring
       later is fine: the .ics UID per task is stable, so a calendar updates the
       existing reminder instead of adding a second one. */
    host.querySelectorAll('.rt-did').forEach(function(b){
      b.addEventListener('click', function(){
        var id=this.getAttribute('data-open');
        openCare = (openCare===id) ? null : id;
        render();
      });
    });
    function setStart(id, iso){
      if(!care.starts) care.starts={};
      care.starts[id]=iso;
      openCare=null;
      persist(); render();
    }
    host.querySelectorAll('.rt-w').forEach(function(b){
      b.addEventListener('click', function(){
        setStart(this.getAttribute('data-set'), isoDate(addDays(today(), -parseInt(this.getAttribute('data-back'),10))));
      });
    });
    host.querySelectorAll('.rt-wdate').forEach(function(inp){
      inp.addEventListener('change', function(){
        if(this.value) setStart(this.getAttribute('data-set'), this.value);
      });
    });
    /* One task, one calendar file. Someone who only changed the sheets today
       should be able to start tracking just that, without being handed the
       other six reminders they have not earned yet. */
    host.querySelectorAll('.rt-cal1').forEach(function(b){
      b.addEventListener('click', function(){
        var id=this.getAttribute('data-cal');
        var c=CARE.filter(function(x){ return x.id===id; })[0];
        if(!c) return;
        var seq=(care.seq||0)+1;
        var from=(care.starts||{})[id];
        var anchor = from ? addInterval(parseISO(from), c.freq) : today();
        var ev=vevent('zf-care-'+c.id, seq, anchor, c.rrule, 'ZeroFog - '+c.act,
                      c.note || 'Recovery Protocol maintenance reminder.');
        care.seq=seq; persist();
        downloadIcs(ev, 'zerofog-'+c.id+'.ics');
        if(statusEl) statusEl.textContent='"'+c.act+'" sent to your calendar - first one '+fmtDate(anchor)+'.';
      });
    });
  }

  /* ----- calendar export (.ics) --------------------------------------------
     UIDs are STABLE — derived from the unit and task only, never from the clock.
     The previous version put Date.now() in the UID, so every press of the button
     produced fresh identifiers and calendars filed them as new events: press it
     twice, get two sets. With a stable UID plus a SEQUENCE that advances on each
     export, a re-import updates the existing event instead (RFC 5545). Press it
     as often as you like, including after answering one more item.             */
  function wireIcs(){
    if(!icsBtnEl) return;
    icsBtnEl.addEventListener('click', function(){
      var seq = (care.seq || 0) + 1;
      var ev='', n=0, start=today();

      CARE.forEach(function(c){
        // Each task counts from the day it was actually done. Untouched tasks fall
        // back to today - the reader who just wants the whole lot in one press
        // still gets it, without being asked to date seven things they have not
        // done yet.
        var from = (care.starts||{})[c.id];
        var anchor = from ? addInterval(parseISO(from), c.freq) : start;
        ev += vevent('zf-care-'+c.id, seq, anchor, c.rrule, 'ZeroFog - '+c.act,
                     c.note || 'Recovery Protocol maintenance reminder.');
        n++;
      });

      units.forEach(function(u){
        var it=ITEM_BY_KEY[u.key];
        if(!it || u.age===null || u.age===undefined) return;
        var yrs=it.vals[u.age];
        var when=replaceDate(it, yrs);
        var who=u.label ? (' ('+u.label+')') : '';
        ev += vevent('zf-replace-'+u.id, seq, when, '', 'ZeroFog - replace: '+it.name+who,
                     it.name+' lasts about '+it.life[0]+'-'+it.life[1]+' years.');
        n++;
      });

      downloadIcs(ev, 'zerofog-bedroom-reminders.ics');

      care.seq = seq;
      persist();
      if(statusEl) statusEl.textContent = n+' reminder'+(n>1?'s':'')+' downloaded - re-export any time, they update rather than duplicate.';
    });
  }

  /* Wrap one or more VEVENTs in a calendar and hand it to the browser. Shared by
     the whole-list button and the per-task ones, so both produce identical files. */
  function downloadIcs(events, filename){
    var cal='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//The Zero Fog//Recovery Protocol//EN\r\n'+
            'CALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\n'+events+'END:VCALENDAR\r\n';
    var blob=new Blob([cal],{type:'text/calendar;charset=utf-8'}), a=document.createElement('a');
    a.href=URL.createObjectURL(blob); a.download=filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(a.href); },1000);
  }

  function vevent(uid, seq, when, rrule, summary, description){
    return 'BEGIN:VEVENT\r\n'+
      'UID:'+uid+'@thezerofog.com\r\n'+
      'SEQUENCE:'+seq+'\r\n'+
      'DTSTAMP:'+icsStamp()+'\r\n'+
      'DTSTART;VALUE=DATE:'+icsDate(when)+'\r\n'+
      (rrule ? 'RRULE:'+rrule+'\r\n' : '')+
      'SUMMARY:'+icsEscape(summary)+'\r\n'+
      'DESCRIPTION:'+icsEscape(description)+'\r\n'+
      'BEGIN:VALARM\r\nTRIGGER:PT0S\r\nACTION:DISPLAY\r\nDESCRIPTION:'+icsEscape(summary)+'\r\nEND:VALARM\r\n'+
      'END:VEVENT\r\n';
  }

  /* ----- entry point ------------------------------------------------------- */
  function init(opts){
    opts = opts || {};
    host = resolveEl(opts.trackerEl);
    if(!host) return Promise.resolve();   // no host on this page — no-op
    store = opts.store;
    icsBtnEl = resolveEl(opts.icsButtonEl);
    statusEl = resolveEl(opts.statusEl);
    return Promise.resolve(store.getState()).then(function(state){
      units = (state && state.units) || defaultUnits();
      care  = (state && state.care)  || {};
      legacyDates = (state && state.dates) || {};
      // Rows written before the age model have no `age` field. Nothing to migrate
      // from — the old per-task dates never recorded an age — so they simply start
      // unanswered, which is what the UI shows anyway.
      units.forEach(function(u){ if(u.age===undefined) u.age=null; });
      render();
      wireIcs();
    });
  }

  window.ZFRecoveryTracker = { init: init, defaultUnits: defaultUnits, ITEMS: ITEMS, CARE: CARE };
})();
