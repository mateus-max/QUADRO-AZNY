import { db } from "./firebase-config.js";
import { ref,push,set,update,onValue,onChildAdded,onDisconnect,remove } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

const $=id=>document.getElementById(id);
const params=new URLSearchParams(location.search);
const room=params.get("room");
const hostMode=params.get("host")==="1";
const teacherParam=params.get("teacher");

let meId="",meName="",meRole=hostMode?"teacher":"student",teacher=null,startTime=Date.now();
let localStream=null,board=null,ctx=null,tool="pen",color="#111827",size=4,zoom=1,drawing=false,points=[];
let peers={},pendingCandidates={},processedSignals=new Set(),speakerOn=true,mediaReady=false,resizeTimer=null;
const RTC_CONFIG={iceServers:[
  {urls:["stun:stun.l.google.com:19302","stun:stun1.l.google.com:19302"]},
  {urls:"stun:stun.cloudflare.com:3478"}
]};

const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const once=path=>new Promise(resolve=>onValue(ref(db,path),s=>resolve(s.val()),{onlyOnce:true}));
const showError=x=>{$("joinError").textContent=x};

function setButtonState(id,on,onText,offText){
  const b=$(id); if(!b)return;
  b.classList.toggle("active",on); b.classList.toggle("off",!on);
  b.innerHTML=on?onText:offText;
}

async function enterClass(name){
  if(!room)return showError("Link da aula inválido.");
  const c=await once("classes/"+room);
  if(!c||c.status!=="live")return showError("Esta aula não está disponível ou já terminou.");
  if(hostMode){
    if(!teacherParam||teacherParam!==c.teacherId)return showError("Acesso do professor inválido.");
    teacher=await once("teachers/"+c.teacherId);
    meName=teacher?.name||"Professor";
  }else{
    meName=name.trim();
    if(!meName)return showError("Introduza o seu nome.");
    teacher=await once("teachers/"+c.teacherId);
  }
  if(!teacher)return showError("Não foi possível carregar os dados do professor.");

  const p=hostMode?ref(db,"participants/"+room+"/host-"+Math.random().toString(36).slice(2,10)):push(ref(db,"participants/"+room));
  meId=p.key;
  const meRef=ref(db,"participants/"+room+"/"+meId);
  await set(meRef,{name:meName,role:meRole,online:true,camera:false,mic:false,joinedAt:Date.now()});
  onDisconnect(ref(db,"participants/"+room+"/"+meId+"/online")).set(false);

  $("joinScreen").classList.add("hidden");
  $("classApp").classList.remove("hidden");
  $("classTeacher").textContent=teacher.name||"Professor";
  $("classCourse").textContent=teacher.courseName||c.title||"Aula online";
  $("joinButton").disabled=false;
  startTime=c.startedAt||Date.now();
  setupBoard();
  setupTools();
  bindBoard();
  watchBoard();
  watchParticipants();
  watchChat();
  watchSignals();
  await startMedia();
  await update(meRef,{camera:hasTrack("video"),mic:hasTrack("audio")});
  watchClock();
  $("mediaMessage").textContent=mediaReady?"Câmera e microfone ativos.":"Pode participar sem câmera/microfone; use os botões abaixo para tentar novamente.";
  setupPeerRefresh();
}

function hasTrack(kind){return !!localStream?.getTracks().some(t=>t.kind===kind)}

async function startMedia(){
  if(!navigator.mediaDevices?.getUserMedia){
    $("mediaMessage").textContent="O navegador não disponibilizou câmera/microfone. Abra o site em HTTPS.";
    return;
  }
  try{
    localStream=await navigator.mediaDevices.getUserMedia({video:true,audio:true});
    mediaReady=true;
  }catch(err){
    console.warn("Câmera e microfone:",err);
    try{
      localStream=await navigator.mediaDevices.getUserMedia({video:false,audio:true});
      mediaReady=true;
    }catch(err2){
      console.warn("Microfone:",err2);
      localStream=null;
    }
  }
  if(localStream){
    addVideoCard(meId,meName,localStream,true);
    attachLocalTracksToPeers();
    setButtonState("toggleMic",hasEnabledTrack("audio"),"🎙 <span>Microfone</span>","🔇 <span>Microfone</span>");
    setButtonState("toggleCamera",hasEnabledTrack("video"),"📹 <span>Câmera</span>","🚫 <span>Câmera</span>");
  }
}

function attachLocalTracksToPeers(){
  if(!localStream)return;
  Object.values(peers).forEach(pc=>{
    const existing=pc.getSenders().map(s=>s.track).filter(Boolean);
    localStream.getTracks().forEach(track=>{
      if(!existing.some(t=>t.kind===track.kind))pc.addTrack(track,localStream);
    });
  });
}

function addVideoCard(id,name,stream,isLocal=false){
  let card=document.querySelector('[data-video-id="'+CSS.escape(id)+'"]');
  if(!card){
    card=document.createElement("div");card.className="video-card"+(isLocal?" local":"");card.dataset.videoId=id;
    card.innerHTML='<video autoplay playsinline></video><div class="video-name"></div><div class="video-badges"><span class="video-badge camera-badge">📹</span><span class="video-badge mic-badge">🎙</span></div>';
    $("videoGrid").appendChild(card);
  }
  card.querySelector("video").srcObject=stream;
  card.querySelector(".video-name").textContent=name;
  card.querySelector("video").muted=isLocal;
  card.querySelector("video").volume=isLocal?0:1;
  applySpeaker();
}

function removeVideoCard(id){document.querySelector('[data-video-id="'+CSS.escape(id)+'"]')?.remove()}

function updateVideoStatus(id,data){
  const card=document.querySelector('[data-video-id="'+CSS.escape(id)+'"]'); if(!card)return;
  card.querySelector(".camera-badge").textContent=data.camera===false?"🚫":"📹";
  card.querySelector(".mic-badge").textContent=data.mic===false?"🔇":"🎙";
}

async function toggleTrack(kind){
  if(!localStream){
    await startMedia();
    if(!localStream)return;
  }
  let track=localStream.getTracks().find(t=>t.kind===kind);
  if(!track){
    try{
      const extra=await navigator.mediaDevices.getUserMedia(kind==="video"?{video:true,audio:false}:{video:false,audio:true});
      track=extra.getTracks()[0];localStream.addTrack(track);
      Object.values(peers).forEach(pc=>pc.addTrack(track,localStream));
    }catch(err){alert("Não foi possível ativar "+(kind==="video"?"a câmera.":" o microfone."));return}
  }else track.enabled=!track.enabled;
  const on=!!track.enabled;
  await update(ref(db,"participants/"+room+"/"+meId),kind==="video"?{camera:on}:{mic:on});
  if(kind==="video")setButtonState("toggleCamera",on,"📹 <span>Câmera</span>","🚫 <span>Câmera</span>");
  else setButtonState("toggleMic",on,"🎙 <span>Microfone</span>","🔇 <span>Microfone</span>");
}

function applySpeaker(){
  document.querySelectorAll("#videoGrid video:not(.local video)").forEach(v=>v.muted=!speakerOn);
  document.querySelectorAll("#videoGrid video").forEach(v=>{if(!v.closest(".local"))v.muted=!speakerOn});
  setButtonState("toggleSpeaker",speakerOn,"🔊 <span>Som</span>","🔇 <span>Som</span>");
}

function setupPeerRefresh(){
  // Existing participants are picked up by watchParticipants.
}

function watchParticipants(){
  onValue(ref(db,"participants/"+room),snap=>{
    const data=snap.val()||{}, arr=Object.entries(data).filter(([id,p])=>p.online!==false);
    $("participantCount").textContent=arr.length;
    $("participantBadge").textContent=arr.length+(arr.length===1?" participante":" participantes");
    $("participants").innerHTML=arr.map(([id,p])=>'<div class="participant"><span class="avatar-sm">'+esc((p.name||"A").charAt(0).toUpperCase())+'</span><span>'+esc(p.name||"Participante")+'</span><span class="online"></span></div>').join("");
    arr.forEach(([id,p])=>{
      if(id!==meId) updateVideoStatus(id,p);
      if(id!==meId && id!==undefined && meId<id && !peers[id]) createPeer(id,p.name,true);
    });
    // If a peer was created before media permission completed, attach the local tracks now.
    attachLocalTracksToPeers();
    Object.keys(peers).forEach(id=>{if(!data[id]||data[id].online===false)closePeer(id)});
    if(localStream) update(ref(db,"participants/"+room+"/"+meId),{camera:hasEnabledTrack("video"),mic:hasEnabledTrack("audio")});
  });
}

function hasEnabledTrack(kind){return !!localStream?.getTracks().some(t=>t.kind===kind&&t.enabled)}

function sendSignal(to,msg){
  return set(push(ref(db,"signals/"+room+"/"+to+"/"+meId)),{...msg,from:meId,createdAt:Date.now()});
}

function watchSignals(){
  onChildAdded(ref(db,"signals/"+room+"/"+meId),async snap=>{
    if(processedSignals.has(snap.key))return;
    processedSignals.add(snap.key);
    const msg=snap.val()||{};
    try{await handleSignal(msg.from,msg);await remove(snap.ref)}catch(err){console.error("Sinal WebRTC",err)}
  });
}

async function createPeer(remoteId,remoteName,initiator){
  if(peers[remoteId])return peers[remoteId];
  const pc=new RTCPeerConnection(RTC_CONFIG);
  peers[remoteId]=pc;pendingCandidates[remoteId]=[];
  if(localStream)localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
  pc.onicecandidate=e=>{if(e.candidate)sendSignal(remoteId,{type:"candidate",candidate:e.candidate.toJSON()})};
  pc.ontrack=e=>{
    const stream=e.streams?.[0]||new MediaStream([e.track]);
    addVideoCard(remoteId,remoteName||"Participante",stream,false);
  };
  pc.onnegotiationneeded=async()=>{
    if(meId>=remoteId||pc.signalingState!=="stable")return;
    try{
      const offer=await pc.createOffer();
      await pc.setLocalDescription(offer);
      await sendSignal(remoteId,{type:"offer",description:{type:pc.localDescription.type,sdp:pc.localDescription.sdp}});
    }catch(err){console.warn("Renegociação WebRTC",err)}
  };
  pc.onconnectionstatechange=()=>{
    if(["failed","closed"].includes(pc.connectionState))closePeer(remoteId);
  };
  if(initiator){
    try{
      const offer=await pc.createOffer();
      await pc.setLocalDescription(offer);
      await sendSignal(remoteId,{type:"offer",description:{type:pc.localDescription.type,sdp:pc.localDescription.sdp}});
    }catch(err){console.error("Oferta WebRTC",err)}
  }
  return pc;
}

async function handleSignal(from,msg){
  if(!from||from===meId)return;
  const participant=await once("participants/"+room+"/"+from);
  const pc=await createPeer(from,participant?.name||"Participante",false);
  if(msg.type==="offer"){
    await pc.setRemoteDescription(new RTCSessionDescription(msg.description));
    for(const c of pendingCandidates[from]||[])await pc.addIceCandidate(new RTCIceCandidate(c)).catch(()=>{});
    pendingCandidates[from]=[];
    const answer=await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await sendSignal(from,{type:"answer",description:{type:pc.localDescription.type,sdp:pc.localDescription.sdp}});
  }else if(msg.type==="answer"){
    await pc.setRemoteDescription(new RTCSessionDescription(msg.description));
    for(const c of pendingCandidates[from]||[])await pc.addIceCandidate(new RTCIceCandidate(c)).catch(()=>{});
    pendingCandidates[from]=[];
  }else if(msg.type==="candidate"){
    if(pc.remoteDescription)await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(()=>{});
    else pendingCandidates[from].push(msg.candidate);
  }
}

function closePeer(id){
  try{peers[id]?.close()}catch{}
  delete peers[id];delete pendingCandidates[id];removeVideoCard(id);
}

function watchClock(){
  setInterval(()=>{const s=Math.max(0,Math.floor((Date.now()-startTime)/1000));$("timer").textContent=String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0")},1000);
}

function setupBoard(){
  board=$("board");ctx=board.getContext("2d");
  resizeBoard();window.addEventListener("resize",()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(resizeBoard,100)});
}
function resizeBoard(){if(!board)return;const r=$("boardWrap").getBoundingClientRect();board.width=Math.max(300,Math.floor(r.width));board.height=Math.max(260,Math.floor(r.height));redraw()}
function redraw(){
  if(!ctx)return;ctx.clearRect(0,0,board.width,board.height);ctx.fillStyle="#fff";ctx.fillRect(0,0,board.width,board.height);
  onValue(ref(db,"whiteboards/"+room+"/objects"),s=>{if(!ctx)return;ctx.clearRect(0,0,board.width,board.height);ctx.fillStyle="#fff";ctx.fillRect(0,0,board.width,board.height);Object.values(s.val()||{}).forEach(renderObject)},{onlyOnce:true});
}
function renderObject(o){
  if(!o)return;ctx.save();
  if(o.type==="stroke"){ctx.strokeStyle=o.color;ctx.lineWidth=o.size;ctx.lineCap="round";ctx.lineJoin="round";ctx.beginPath();(o.points||[]).forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke()}
  else if(o.type==="line"){ctx.strokeStyle=o.color;ctx.lineWidth=o.size;ctx.beginPath();ctx.moveTo(o.a.x,o.a.y);ctx.lineTo(o.b.x,o.b.y);ctx.stroke()}
  else if(o.type==="rect"){ctx.strokeStyle=o.color;ctx.lineWidth=o.size;ctx.strokeRect(o.a.x,o.a.y,o.b.x-o.a.x,o.b.y-o.a.y)}
  else if(o.type==="text"){ctx.fillStyle=o.color;ctx.font=o.font||"24px sans-serif";ctx.fillText(o.text,o.x,o.y)}
  else if(o.type==="image"){const img=new Image();img.onload=()=>{ctx.drawImage(img,o.x,o.y,o.w,o.h)};img.src=o.src}
  else if(o.type==="staff"){ctx.strokeStyle=o.color;ctx.lineWidth=2;for(let i=0;i<5;i++){ctx.beginPath();ctx.moveTo(o.x,o.y+i*12);ctx.lineTo(o.x+o.w,o.y+i*12);ctx.stroke()}}
  ctx.restore();
}
function point(e){const r=board.getBoundingClientRect();return{x:(e.clientX-r.left)*board.width/r.width,y:(e.clientY-r.top)*board.height/r.height}}
function addObject(o){return set(push(ref(db,"whiteboards/"+room+"/objects")),o)}

function bindBoard(){
  board.onpointerdown=async e=>{
    if(tool==="select")return;
    const p=point(e);
    if(tool==="text"){const t=prompt("Texto:");if(t)addObject({type:"text",x:p.x,y:p.y,text:t,color,font:"24px sans-serif"});return}
    if(tool==="image"){$("imagePicker").click();return}
    if(tool==="staff"){addObject({type:"staff",x:p.x,y:p.y,w:420,color});return}
    if(tool==="piano"){$("pianoOverlay").classList.toggle("hidden");return}
    if(tool==="undo"){await undoLast();tool="pen";return}
    if(tool==="redo"){return}
    if(tool==="clear"){if(confirm("Limpar o quadro para todos?"))await set(ref(db,"whiteboards/"+room+"/objects"),null);return}
    drawing=true;points=[p];board.setPointerCapture?.(e.pointerId);
  };
  board.onpointermove=e=>{
    if(!drawing)return;const p=point(e);points.push(p);const prev=points[points.length-2];
    ctx.save();ctx.strokeStyle=tool==="eraser"?"#fff":color;ctx.lineWidth=tool==="eraser"?Math.max(size*3,12):size;ctx.lineCap="round";ctx.beginPath();ctx.moveTo(prev.x,prev.y);ctx.lineTo(p.x,p.y);ctx.stroke();ctx.restore();
  };
  board.onpointerup=async e=>{
    if(!drawing)return;drawing=false;const p=point(e);points.push(p);
    if(tool==="pen"||tool==="eraser")await addObject({type:"stroke",points:points.map(x=>({x:x.x,y:x.y})),color:tool==="eraser"?"#fff":color,size:tool==="eraser"?Math.max(size*3,12):size});
    else if(tool==="line")await addObject({type:"line",a:points[0],b:p,color,size});
    else if(tool==="rect")await addObject({type:"rect",a:points[0],b:p,color,size});
    points=[];
  };
  board.onpointercancel=()=>{drawing=false;points=[]};
}

async function undoLast(){
  const s=await once("whiteboards/"+room+"/objects");const d=s||{};const keys=Object.keys(d);if(keys.length)await remove(ref(db,"whiteboards/"+room+"/objects/"+keys[keys.length-1]));
}

function setupTools(){
  document.querySelectorAll("[data-tool]").forEach(b=>b.onclick=async()=>{
    const next=b.dataset.tool;
    if(["undo","redo","clear"].includes(next)){tool=next;return}
    tool=next;document.querySelectorAll("[data-tool]").forEach(x=>x.classList.toggle("active",x===b));
    if(next==="piano")$("pianoOverlay").classList.toggle("hidden");
  });
  document.querySelectorAll("[data-color]").forEach(b=>b.onclick=()=>color=b.dataset.color);
  $("brushSize").oninput=e=>size=+e.target.value;
  $("fullscreen").onclick=()=>document.documentElement.requestFullscreen?.();
  $("saveBoard").onclick=()=>{const a=document.createElement("a");a.download="quadro-"+room+".png";a.href=board.toDataURL("image/png");a.click()};
  $("zoomIn").onclick=()=>setZoom(zoom+.1);$("zoomOut").onclick=()=>setZoom(zoom-.1);$("fitBoard").onclick=()=>setZoom(1);
  $("raiseHand").onclick=()=>update(ref(db,"participants/"+room+"/"+meId),{hand:true,handAt:Date.now()});
  $("toggleMic").onclick=()=>toggleTrack("audio");
  $("toggleCamera").onclick=()=>toggleTrack("video");
  $("toggleSpeaker").onclick=()=>{speakerOn=!speakerOn;applySpeaker()};
  $("leaveClass").onclick=leaveClass;
  $("imagePicker").onchange=e=>insertImage(e.target.files?.[0]);
  document.querySelectorAll("[data-music]").forEach(b=>b.onclick=()=>addMusicSymbol(b.dataset.music));
  buildPiano();
}
function setZoom(z){zoom=Math.max(.6,Math.min(1.8,z));$("zoomValue").textContent=Math.round(zoom*100)+"%";board.style.transform="scale("+zoom+")";board.style.transformOrigin="center top"}
function addMusicSymbol(kind){
  const symbols={treble:"𝄞",bass:"𝄢",quarter:"♩",eighth:"♪",eighths:"♫"};addObject({type:"text",x:90,y:90,text:symbols[kind]||"♪",color,font:"42px serif"});
}
async function insertImage(file){
  if(!file)return;
  if(file.size>4*1024*1024)return alert("A imagem deve ter no máximo 4 MB.");
  const reader=new FileReader();
  reader.onload=()=>{
    const img=new Image();img.onload=()=>{const max=700,sc=Math.min(1,max/img.width),w=Math.round(img.width*sc),h=Math.round(img.height*sc);addObject({type:"image",src:reader.result,x:80,y:80,w,h})};img.src=reader.result;
  };reader.readAsDataURL(file);
  $("imagePicker").value="";
}
function buildPiano(){
  const box=$("pianoOverlay");box.innerHTML="";
  const notes=["C","D","E","F","G","A","B","C","D","E","F","G","A","B"];
  notes.forEach((n,i)=>{const k=document.createElement("button");k.className="piano-key";k.textContent=n;k.onclick=()=>playNote(261.63*Math.pow(2,i/12));box.appendChild(k)});
}
function playNote(freq){
  try{const ac=new (window.AudioContext||window.webkitAudioContext)(),o=ac.createOscillator(),g=ac.createGain();o.frequency.value=freq;o.type="sine";g.gain.value=.08;o.connect(g);g.connect(ac.destination);o.start();g.gain.exponentialRampToValueAtTime(.001,ac.currentTime+.45);o.stop(ac.currentTime+.5)}catch{}
}

function watchBoard(){
  onValue(ref(db,"whiteboards/"+room+"/objects"),s=>{
    if(!ctx)return;ctx.clearRect(0,0,board.width,board.height);ctx.fillStyle="#fff";ctx.fillRect(0,0,board.width,board.height);
    Object.values(s.val()||{}).forEach(renderObject);
  });
}
function watchChat(){
  onValue(ref(db,"messages/"+room),s=>{
    const d=s.val()||{};$("chatMessages").innerHTML=Object.values(d).map(m=>'<div class="message"><div class="msg-name">'+esc(m.name)+'</div><div class="msg-text">'+esc(m.text)+'</div></div>').join("");
    $("chatMessages").scrollTop=$("chatMessages").scrollHeight;
  });
}
async function leaveClass(){
  try{await update(ref(db,"participants/"+room+"/"+meId),{online:false});}catch{}
  localStream?.getTracks().forEach(t=>t.stop());Object.keys(peers).forEach(closePeer);
  location.href=hostMode?"professor.html?teacher="+encodeURIComponent(teacherParam):"about:blank";
}

$("joinForm").addEventListener("submit",async e=>{e.preventDefault();const b=$("joinButton");b.disabled=true;b.textContent="A entrar...";await enterClass($("studentName").value);if(!document.getElementById("classApp").classList.contains("hidden"))b.textContent="Entrar na Aula";else b.disabled=false});
$("chatForm").addEventListener("submit",async e=>{e.preventDefault();const t=$("chatInput").value.trim();if(t){await set(push(ref(db,"messages/"+room)),{name:meName,text:t,time:Date.now()});$("chatInput").value=""}});
window.addEventListener("beforeunload",()=>{if(room&&meId)update(ref(db,"participants/"+room+"/"+meId),{online:false})});

(async()=>{
  if(!room){showError("Link da aula inválido.");return}
  const c=await once("classes/"+room);
  if(!c){showError("Aula não encontrada.");return}
  const t=await once("teachers/"+c.teacherId);
  $("joinTeacher").textContent=t?.name||"QUADRO-AZNY";$("joinCourse").textContent=t?.courseName||c.title;$("joinTitle").textContent=c.title||"Entrar na aula";
  if(hostMode){$("studentName").value=t?.name||"Professor";$("studentName").disabled=true;setTimeout(()=>enterClass(t?.name||"Professor"),150)}
})();