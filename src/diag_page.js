/** Browser latency bench HTML (Worker edge echo vs Durable Object echo). */
export const DIAG_PAGE = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Latency Diag — Worker vs DO</title>
<style>
:root{font-family:ui-monospace,Consolas,monospace;color:#e8f0ff;background:#0d1424}
*{box-sizing:border-box}body{margin:0;padding:20px;max-width:920px}
h1{font-size:18px;margin:0 0 8px}p,li{color:#9eb2d4;font-size:13px;line-height:1.45}
.card{border:1px solid #2a3d5c;border-radius:12px;padding:14px;margin:12px 0;background:#152038}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}
button,input{padding:10px 12px;border-radius:8px;font:inherit;border:1px solid #3d5578;background:#1c2b48;color:#fff}
button{background:#3a6fd8;border:0;cursor:pointer}button.secondary{background:#334962}
button:disabled{opacity:.4;cursor:default}
#out{white-space:pre-wrap;min-height:280px;background:#0a101c;border-radius:10px;padding:12px;font-size:12px;line-height:1.55;color:#c6ddff}
.note{color:#ffd27a;font-size:12px}
</style>
</head>
<body>
<h1>Latency Diag — Worker edge WS vs Durable Object WS</h1>
<p>동일 프로토콜 <code>diag_echo</code> / <code>diag_echo_reply</code>. RTT는 <b>브라우저 동일 프로세스</b> <code>performance.now()</code>만 사용. 서로 다른 시계를 빼지 않음.</p>
<p class="note">주의: <code>edge_colo</code> = 요청이 들어온 Cloudflare PoP. Durable Object 실제 실행 위치와 다름. hint <code>apac-ne</code>는 DO 최초 생성 시 best-effort일 뿐.</p>
<div class="card">
  <div class="row">
    <button id="benchWorker">1) Worker Echo (no DO) ×40</button>
    <button id="benchDo" class="secondary">2) DO Echo ×40</button>
    <button id="benchBoth" class="secondary">3) Both (Worker then DO)</button>
  </div>
  <div class="row">
    <label>Room code (DO only) <input id="code" maxlength="6" placeholder="ABC123" style="width:100px;text-transform:uppercase"></label>
    <button id="create" class="secondary">Create room</button>
    <span id="meta"></span>
  </div>
</div>
<div class="card"><div id="out">Ready.</div></div>
<script>
const $=id=>document.getElementById(id);
const out=()=>$('out');
function log(s){ out().textContent += s + '\\n'; out().scrollTop = out().scrollHeight; }
function clearLog(){ out().textContent = ''; }

function stats(arr){
  if(!arr.length) return null;
  const a=[...arr].sort((x,y)=>x-y);
  const n=a.length, sum=a.reduce((s,v)=>s+v,0);
  const pct=p=>{ const i=Math.min(n-1, Math.max(0, Math.ceil(n*p)-1)); return a[i]; };
  const band400=a.filter(v=>v>=350 && v<=450).length;
  return {
    n, min:a[0], median:pct(0.5), avg:sum/n, p95:pct(0.95), max:a[n-1],
    band400, band400pct: (100*band400/n)
  };
}
function fmt(st){
  if(!st) return '(no samples)';
  return \`n=\${st.n} min=\${st.min.toFixed(1)} med=\${st.median.toFixed(1)} avg=\${st.avg.toFixed(1)} p95=\${st.p95.toFixed(1)} max=\${st.max.toFixed(1)} | 350–450ms=\${st.band400}(\${st.band400pct.toFixed(0)}%)\`;
}
function verdict(workerSt, doSt){
  const lines=[];
  if(workerSt && doSt){
    const d=doSt.min - workerSt.min;
    if(workerSt.min < 80 && doSt.min >= 200){
      lines.push('VERDICT: delay is mostly Durable Object path (Worker edge OK, DO echo high). Edge colo ≠ DO location.');
    } else if(workerSt.min >= 200 && doSt.min >= 200){
      lines.push('VERDICT: delay is before/at Worker edge (or client/network to CF). Both paths high.');
    } else if(workerSt.min < 80 && doSt.min < 80){
      lines.push('VERDICT: Cloudflare path looks healthy in browser — if Godot is still ~400ms, suspect Godot WS/client.');
    } else {
      lines.push(\`VERDICT: DO−Worker min delta ≈ \${d.toFixed(0)}ms\`);
    }
  } else if(workerSt){
    lines.push(workerSt.min>=200
      ? 'VERDICT: Worker-only echo already high → not DO-specific.'
      : 'VERDICT: Worker-only echo healthy.');
  }
  if(workerSt && workerSt.band400pct >= 40){
    lines.push('PATTERN: ≥40% samples in 350–450ms on Worker path — investigate edge routing / ISP / client timer, not DO storage.');
  }
  if(doSt && doSt.band400pct >= 40 && (!workerSt || workerSt.band400pct < 20)){
    lines.push('PATTERN: 350–450ms cluster mainly on DO path — DO placement / DO hop likely.');
  }
  return lines.join('\\n');
}

async function fetchInfo(){
  const r=await fetch('/api/echo/info');
  const d=await r.json();
  $('meta').textContent = \`edge_colo=\${d.edge_colo||'?'} ray=\${d.cf_ray||'?'} hint=\${d.location_hint||''}\`;
  return d;
}

function runEchoBench(wsUrl, label, count, joinMsg){
  return new Promise((resolve,reject)=>{
    const samples=[];
    const pending=new Map(); // id -> {t0, token}
    let nextId=1, mismatches=0, done=false;
    const ws=new WebSocket(wsUrl);
    const finish=(err)=>{
      if(done) return; done=true;
      try{ws.close();}catch(_){}
      if(err) reject(err); else resolve({samples, mismatches, label});
    };
    ws.onerror=()=>finish(new Error(label+' ws error'));
    ws.onclose=()=>{ if(!done && samples.length<count) finish(new Error(label+' closed early n='+samples.length)); };
    ws.onopen=()=>{
      log(\`[\${label}] open \${wsUrl}\`);
      if(joinMsg) ws.send(JSON.stringify(joinMsg));
      const sendOne=()=>{
        if(samples.length>=count){ finish(); return; }
        const id=nextId++;
        const token=Math.random().toString(36).slice(2,10);
        pending.set(id,{t0:performance.now(), token});
        ws.send(JSON.stringify({type:'diag_echo', id, token, path:label}));
      };
      // After optional join/hello settle briefly, then fire probes back-to-back (no artificial delay beyond reply).
      setTimeout(function pump(){
        // keep at most 1 inflight to avoid queue inflation
        if(pending.size===0 && samples.length<count) sendOne();
        if(!done) setTimeout(pump, 5);
      }, joinMsg?80:20);
    };
    ws.onmessage=(ev)=>{
      let m; try{m=JSON.parse(ev.data);}catch{return;}
      if(m.type==='echo_hello' || m.type==='hello' || m.type==='joined'){
        log(\`[\${label}] \${m.type} via=\${m.via||''} colo=\${m.edge_colo||m.location_hint||''}\`);
        return;
      }
      if(m.type!=='diag_echo_reply') return;
      const p=pending.get(m.id);
      if(!p){ mismatches++; return; }
      pending.delete(m.id);
      if(m.token && m.token!==p.token){ mismatches++; log(\`[\${label}] TOKEN MISMATCH id=\${m.id}\`); return; }
      const rtt=performance.now()-p.t0;
      samples.push(rtt);
      if(samples.length===1 || samples.length%10===0 || samples.length===count){
        log(\`[\${label}] #\${samples.length} rtt=\${rtt.toFixed(1)}ms srv=\${m.server_proc_ms} via=\${m.via||m.path} colo=\${m.edge_colo||''}\`);
      }
      if(samples.length>=count) finish();
    };
  });
}

async function ensureRoom(){
  let code=$('code').value.trim().toUpperCase();
  if(code.length===6) return {code, token:null};
  const r=await fetch('/api/rooms',{method:'POST'});
  const d=await r.json();
  if(!d.ok) throw new Error(JSON.stringify(d));
  $('code').value=d.code;
  log('created room '+d.code+' location_hint='+d.location_hint);
  return {code:d.code, token:d.host_token};
}

$('create').onclick=async()=>{
  clearLog();
  await fetchInfo();
  await ensureRoom();
};

$('benchWorker').onclick=async()=>{
  clearLog(); await fetchInfo();
  try{
    const proto=location.protocol==='https:'?'wss:':'ws:';
    const res=await runEchoBench(\`\${proto}//\${location.host}/api/echo/ws\`, 'worker', 40, null);
    const st=stats(res.samples);
    log('WORKER '+fmt(st)+' id/token_mismatch='+res.mismatches);
    log(verdict(st,null));
  }catch(e){ log('ERR '+e.message); }
};

$('benchDo').onclick=async()=>{
  clearLog(); await fetchInfo();
  try{
    const room=await ensureRoom();
    const proto=location.protocol==='https:'?'wss:':'ws:';
    const join={type:'join', name:'diag'};
    if(room.token) join.host_token=room.token;
    const res=await runEchoBench(\`\${proto}//\${location.host}/api/rooms/\${room.code}/ws\`, 'do', 40, join);
    const st=stats(res.samples);
    log('DO '+fmt(st)+' id/token_mismatch='+res.mismatches);
    log(verdict(null,st));
  }catch(e){ log('ERR '+e.message); }
};

$('benchBoth').onclick=async()=>{
  clearLog(); await fetchInfo();
  try{
    const proto=location.protocol==='https:'?'wss:':'ws:';
    const w=await runEchoBench(\`\${proto}//\${location.host}/api/echo/ws\`, 'worker', 40, null);
    const wst=stats(w.samples);
    log('WORKER '+fmt(wst)+' mismatch='+w.mismatches);
    const room=await ensureRoom();
    const join={type:'join', name:'diag'};
    if(room.token) join.host_token=room.token;
    const d=await runEchoBench(\`\${proto}//\${location.host}/api/rooms/\${room.code}/ws\`, 'do', 40, join);
    const dst=stats(d.samples);
    log('DO '+fmt(dst)+' mismatch='+d.mismatches);
    log(verdict(wst,dst));
  }catch(e){ log('ERR '+e.message); }
};

fetchInfo().catch(()=>{});
</script>
</body>
</html>`;
