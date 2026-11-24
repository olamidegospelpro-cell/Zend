(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const CHUNK_SIZE = 64 * 1024;
  const HIGH_WATER = 1024 * 1024;
  const LOW_WATER = 256 * 1024;
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const state = { peer: null, conn: null, role: null, files: [], receiving: null, queue: Promise.resolve(), sentBytes: 0, speed: 0, lastProbe: 0, rtt: null, watchdog: null, audio: null, muted: false, wakeLock: null, roomCode: '' };
  let toastTimer;
  const status = (message) => { $('connectionStatus').textContent = message; };
  function toast(message) { const el = $('toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600); }
  function formatBytes(n) { if (!Number.isFinite(n) || n < 0) return '—'; if (n < 1024) return `${n} B`; const units = ['KB','MB','GB','TB']; let v = n / 1024, i = 0; while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; } return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`; }
  function makeCode() { let out = ''; for (let i=0;i<5;i++) out += ALPHABET[Math.floor(Math.random()*ALPHABET.length)]; return out; }
  function setConnected(conn, role) {
    state.conn = conn; state.role = role;
    conn.on('open', () => { status('Connected — ready to transfer.'); $('connectionStatus').classList.add('connected'); toast('Devices connected. You’re all set.'); startWatchdog(); requestWakeLock(); });
    conn.on('data', handleData);
    conn.on('close', () => { stopWatchdog(); state.conn = null; status('Connection closed. Create or join a room to reconnect.'); toast('Connection closed.'); });
    conn.on('error', (err) => { console.error(err); status('Connection problem. Check both devices and try again.'); });
  }
  function startPeer(id) {
    if (!window.Peer) { status('PeerJS could not load. Check your internet connection and reload.'); return null; }
    if (state.peer) { try { state.peer.destroy(); } catch (_) {} }
    const peer = new Peer(id, { debug: 0 }); state.peer = peer;
    peer.on('error', (err) => { console.error(err); if (err.type === 'unavailable-id' && state.role === 'receiver') { $('createRoom').disabled = false; status('That room code was taken. Please create another room.'); } else if (err.type === 'peer-unavailable') { status('Room not found. Check the code and try again.'); $('joinRoom').disabled = false; } else { status('Could not establish a connection. Check your internet and try again.'); $('joinRoom').disabled = false; $('createRoom').disabled = false; } });
    peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
    return peer;
  }
  function createRoom() {
    $('createRoom').disabled = true; state.role = 'receiver'; status('Creating a room…');
    let tries = 0;
    function attempt() {
      if (tries++ > 5) { status('Could not create a room. Please try again.'); $('createRoom').disabled = false; return; }
      state.roomCode = makeCode(); const peer = startPeer(state.roomCode);
      if (!peer) { $('createRoom').disabled = false; return; }
      peer.on('open', (id) => { state.roomCode = id.toUpperCase(); $('roomCode').textContent = state.roomCode; $('roomDisplay').classList.remove('hidden'); $('qrWrap').classList.remove('hidden'); $('qrcode').replaceChildren(); const joinUrl = new URL(location.href); joinUrl.hash = `join=${state.roomCode}`; if (window.QRCode) new QRCode($('qrcode'), { text: joinUrl.href, width: 76, height: 76, colorDark: '#111216', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M }); status('Room is ready. Connect from your other device.'); $('createRoom').disabled = false; });
      peer.on('error', err => { if (err.type === 'unavailable-id') { peer.destroy(); attempt(); } });
      peer.on('connection', conn => { if (state.conn) { conn.close(); return; } setConnected(conn, 'receiver'); });
    }
    attempt();
  }
  function joinRoom() {
    const code = $('joinCode').value.trim().toUpperCase(); if (!/^[A-Z2-9]{5}$/.test(code)) { toast('Enter a valid 5-character room code.'); $('joinCode').focus(); return; }
    $('joinRoom').disabled = true; status('Connecting…'); state.role = 'sender'; const peer = startPeer(); if (!peer) { $('joinRoom').disabled = false; return; }
    peer.on('open', () => { const conn = peer.connect(code, { reliable: true, serialization: 'binary' }); setConnected(conn, 'sender'); setTimeout(() => { if (!state.conn || !state.conn.open) $('joinRoom').disabled = false; }, 12000); });
  }
  function send(data) { if (!state.conn || !state.conn.open) return false; try { state.conn.send(data); return true; } catch (e) { console.error(e); return false; } }
  function waitForBuffer() { return new Promise((resolve, reject) => { const dc = state.conn && state.conn.dataChannel; if (!dc) { resolve(); return; } const check = () => { if (!state.conn || !state.conn.open) { reject(new Error('Connection closed')); return; } if (dc.bufferedAmount <= LOW_WATER) { resolve(); return; } dc.addEventListener('bufferedamountlow', check, { once: true }); setTimeout(() => { dc.removeEventListener('bufferedamountlow', check); if (dc.bufferedAmount <= LOW_WATER) resolve(); else check(); }, 120); }; if (dc.bufferedAmount > HIGH_WATER) check(); else resolve(); }); }
  function renderFiles(files) { const list = $('fileList'); list.replaceChildren(); [...files].forEach(file => { const row = document.createElement('div'); row.className='file-row'; const type=document.createElement('span');type.className='file-type';type.textContent=(file.name.split('.').pop()||'file').slice(0,4);const name=document.createElement('span');name.className='file-name';name.textContent=file.name;name.title=file.name;const size=document.createElement('span');size.className='file-size';size.textContent=formatBytes(file.size);row.append(type,name,size);list.append(row); }); list.classList.toggle('hidden', !files.length); }
  function addFiles(files) { if (!files || !files.length) return; state.files.push(...Array.from(files)); renderFiles(state.files); if (state.conn && state.conn.open) sendFiles(); else toast('Files added. Connect to another device to send.'); }
  async function sendFiles() {
    if (!state.conn || !state.conn.open) { toast('Connect to another device first.'); return; }
    if (!state.files.length) { $('fileInput').click(); return; }
    const batch = state.files.splice(0); renderFiles(state.files); $('fileInput').value = '';
    $('progressTrack').classList.remove('hidden'); $('transferMeta').classList.remove('hidden');
    try {
      for (let i=0;i<batch.length;i++) {
        const file=batch[i], id=`${Date.now()}-${i}-${Math.random().toString(36).slice(2,7)}`;
        await requestFileReady({ type:'file-start', id, name:file.name, size:file.size, mime:file.type||'application/octet-stream', lastModified:file.lastModified });
        let offset=0;
        while(offset<file.size) { const chunk=await file.slice(offset,offset+CHUNK_SIZE).arrayBuffer(); await waitForBuffer(); if(!send(chunk)) throw new Error('Connection closed'); offset+=chunk.byteLength; state.sentBytes+=chunk.byteLength; updateProgress(offset,file.size,file.name); }
        send({ type:'file-end', id });
        await waitForAck(id);
      }
      $('progressLabel').textContent='All files sent'; $('speedReadout').textContent='Transfer complete'; toast('Files sent successfully.');
    } catch (err) { console.error(err); toast(err.message==='Connection closed'?'Connection lost during transfer.':'Could not complete the transfer.'); $('progressLabel').textContent='Transfer interrupted'; }
    if (state.files.length) renderFiles(state.files);
  }
  function requestFileReady(meta) { return new Promise((resolve,reject) => { const timer=setTimeout(()=>reject(new Error('The receiving device did not respond.')),120000); state._ready={ id:meta.id, resolve:()=>{clearTimeout(timer);resolve();},reject }; if(!send(meta)){clearTimeout(timer);reject(new Error('Connection closed'));} }); }
  function waitForAck(id) { return new Promise((resolve,reject) => { const timer=setTimeout(()=>reject(new Error('No save confirmation received.')),120000); state._ack={ id, resolve:()=>{clearTimeout(timer);resolve();}, reject }; }); }
  function updateProgress(done,total,label) { const pct=total?Math.min(100,done/total*100):100; $('progressFill').style.width=`${pct}%`; $('progressLabel').textContent=`${label} · ${formatBytes(done)} / ${formatBytes(total)}`; }
  async function handleData(data) {
    if (typeof data === 'string') { try { data=JSON.parse(data); } catch (_) { return; } }
    if (data && typeof data === 'object' && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer) && !(data instanceof Blob)) {
      if (data.type === 'text') { $('receivedTextContent').textContent=data.text; $('receivedText').classList.remove('hidden'); toast('Text received.'); return; }
      if (data.type === 'file-start') { await prepareReceive(data); return; }
      if (data.type === 'file-end') { await finishReceive(data); return; }
      if (data.type === 'ready' && state._ready && state._ready.id===data.id) { state._ready.resolve(); state._ready=null; return; }
      if (data.type === 'saved' && state._ack && state._ack.id===data.id) { state._ack.resolve(); state._ack=null; return; }
      if (data.type === 'ping') { send({type:'pong',t:data.t}); return; }
      if (data.type === 'pong') { state.rtt=Math.max(0,Date.now()-data.t); $('rttLabel').textContent=`RTT ${state.rtt} ms`; return; }
      if (data.type === 'error') { toast(data.message||'The other device reported an error.'); return; }
      return;
    }
    const buffer = data instanceof Blob ? await data.arrayBuffer() : (data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength));
    if (!state.receiving) return;
    try { if(state.receiving.writable) await state.receiving.writable.write(buffer); else state.receiving.parts.push(buffer); state.receiving.received+=buffer.byteLength; updateProgress(state.receiving.received,state.receiving.meta.size,state.receiving.meta.name); state.speed+=buffer.byteLength; }
    catch(e){console.error(e);send({type:'error',message:'Could not write the incoming file.'});state.receiving=null;}
  }
  async function prepareReceive(meta) {
    state.receiving={ meta, writable:null, parts:[], received:0 };
    $('progressTrack').classList.remove('hidden');$('transferMeta').classList.remove('hidden');updateProgress(0,meta.size,meta.name);
    if ('showSaveFilePicker' in window) {
      try { const handle=await window.showSaveFilePicker({ suggestedName:meta.name, types:[{description:'Received file',accept:{[meta.mime]:[`.${(meta.name.split('.').pop()||'bin').replace(/[^a-z0-9]/gi,'')}`]}}] }); state.receiving.writable=await handle.createWritable(); }
      catch(err) { if(err.name==='AbortError'){send({type:'error',message:'Save cancelled on receiving device.'});state.receiving=null;return;} console.warn('File picker unavailable; using Blob fallback.',err); }
    }
    if(!state.receiving)return;
    send({type:'ready',id:meta.id}); $('speedReadout').textContent=state.receiving.writable?'Receiving directly to disk':'Receiving (browser memory fallback)';
  }
  async function finishReceive(data) {
    const r=state.receiving;if(!r||r.meta.id!==data.id)return;
    try {
      if(r.writable) await r.writable.close();
      else { const blob=new Blob(r.parts,{type:r.meta.mime}); const url=URL.createObjectURL(blob); const a=document.createElement('a');a.href=url;a.download=r.meta.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000); r.parts=[]; }
      send({type:'saved',id:r.meta.id});$('progressLabel').textContent=`Received ${r.meta.name}`;$('speedReadout').textContent='Transfer complete';toast(`Received ${r.meta.name}`);
    } catch(e){console.error(e);send({type:'error',message:'Could not finish saving the file.'});toast('Could not save the received file.');}
    state.receiving=null;
  }
  function sendText() { const text=$('textMessage').value; if(!text.trim()){toast('Add some text before sending.');return;} if(!send({type:'text',text})){toast('Connect to another device first.');return;} toast('Text sent.'); }
  function startWatchdog() { stopWatchdog(); state.watchdog=setInterval(()=>{if(!state.conn||!state.conn.open)return;send({type:'ping',t:Date.now()});const now=Date.now(), speed=state.speed;state.speed=0;const mbps=speed/1024/1024; if(speed>0){$('speedReadout').textContent=`${mbps.toFixed(2)} MB/s`;if(state._prevSpeed>0&&mbps<state._prevSpeed*.22&&state._prevSpeed>0.15) alertWeakSignal();}state._prevSpeed=mbps;state.lastProbe=now;if(state.receiving&&state.receiving.received<state.receiving.meta.size&&speed===0&&state.receiving.received>0)alertWeakSignal();},1000); }
  function stopWatchdog(){if(state.watchdog){clearInterval(state.watchdog);state.watchdog=null;}state._prevSpeed=0;}
  function alertWeakSignal(){ $('signalWarning').classList.remove('hidden'); if(navigator.vibrate)navigator.vibrate([300,150,300]); if(!$('soundToggle').checked||state.muted)return;try{const AudioContext=window.AudioContext||window.webkitAudioContext;if(!AudioContext)return;state.audio=state.audio||new AudioContext();if(state.audio.state==='suspended')state.audio.resume();const osc=state.audio.createOscillator(),gain=state.audio.createGain();osc.type='sine';osc.frequency.value=660;gain.gain.setValueAtTime(.0001,state.audio.currentTime);gain.gain.exponentialRampToValueAtTime(.06,state.audio.currentTime+.03);gain.gain.exponentialRampToValueAtTime(.0001,state.audio.currentTime+.22);osc.connect(gain);gain.connect(state.audio.destination);osc.start();osc.stop(state.audio.currentTime+.23);}catch(e){console.warn('Audio alert unavailable',e);} }
  async function requestWakeLock(){try{if('wakeLock'in navigator)state.wakeLock=await navigator.wakeLock.request('screen');}catch(_) {}}
  function init() {
    $('year').textContent=new Date().getFullYear();
    $('createRoom').addEventListener('click',createRoom);$('joinRoom').addEventListener('click',joinRoom);$('joinCode').addEventListener('input',e=>{e.target.value=e.target.value.toUpperCase().replace(/[^A-Z2-9]/g,'').slice(0,5);});$('joinCode').addEventListener('keydown',e=>{if(e.key==='Enter')joinRoom();});$('copyRoom').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(state.roomCode);toast('Room code copied.');}catch(_){toast(`Room code: ${state.roomCode}`);}});
    $('fileInput').addEventListener('change',e=>addFiles(e.target.files));const dz=$('dropZone');['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('dragging');}));['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove('dragging');}));dz.addEventListener('drop',e=>addFiles(e.dataTransfer.files));dz.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('fileInput').click();}});dz.tabIndex=0;
    $('sendText').addEventListener('click',sendText);$('textMessage').addEventListener('input',()=>{$('charCount').textContent=`${$('textMessage').value.length.toLocaleString()} / 100,000`;});$('copyText').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('receivedTextContent').textContent);toast('Text copied.');}catch(_){toast('Clipboard access is unavailable.');}});$('dismissWarning').addEventListener('click',()=>$('signalWarning').classList.add('hidden'));
    const dialog=$('feedbackDialog');$('feedbackOpen').addEventListener('click',()=>dialog.showModal());$('feedbackFooter').addEventListener('click',()=>dialog.showModal());$('feedbackClose').addEventListener('click',()=>dialog.close());$('feedbackForm').addEventListener('submit',async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;$('feedbackStatus').textContent='Sending…';try{const form=e.currentTarget;const body=new FormData(form);const response=await fetch('https://formsubmit.co/ajax/hello@gospelco.com.ng',{method:'POST',headers:{Accept:'application/json'},body});if(!response.ok)throw new Error('Could not send right now.');$('feedbackStatus').textContent='Thanks for your feedback!';form.reset();setTimeout(()=>dialog.close(),1400);}catch(err){$('feedbackStatus').textContent='Could not send. Please try again later or email hello@gospelco.com.ng.';}finally{button.disabled=false;}});
    const params=new URLSearchParams(location.hash.slice(1));const code=params.get('join');if(code&&/^[A-Z2-9]{5}$/i.test(code)){$('joinCode').value=code.toUpperCase();history.replaceState(null,'',location.pathname+location.search);}
    if('serviceWorker'in navigator&&location.protocol!=='file:')window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(err=>console.warn('Service worker registration failed',err)));
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&state.conn&&state.conn.open)requestWakeLock();});
  }
  document.addEventListener('DOMContentLoaded',init);
})();
