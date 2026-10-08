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
  configureRoleUI();
  startTime=c.startedAt||Date.now();
  setupBoard();
  setupTools();
  nbInit();
  bindBoard();
  watchBoard();
  watchChat();
  watchParticipants();
  watchSignals();
  if(!hostMode)watchRemoteControls();
  watchClock();
  startMedia().then(async()=>{
    await update(meRef,{camera:hasEnabledTrack("video"),mic:hasEnabledTrack("audio")});
    $("mediaMessage").textContent=mediaReady?"Câmera e microfone ativos.":"Pode participar sem câmera/microfone; use os botões abaixo para tentar novamente.";
  }).catch(err=>console.warn("Mídia:",err));
}

function hasTrack(kind){return !!localStream?.getTracks().some(t=>t.kind===kind)}
function attachLocalTracksToPeers(){
  if(!localStream)return;
  Object.values(peers).forEach(peer=>{
    const pc=peer?.pc||peer;
    if(!pc||pc.connectionState==="closed")return;
    const existing=pc.getSenders().map(sender=>sender.track).filter(Boolean);
    localStream.getTracks().forEach(track=>{
      if(!existing.some(t=>t.kind===track.kind)){
        try{pc.addTrack(track,localStream)}catch(err){console.warn("Adicionar track WebRTC:",err)}
      }
    });
  });
}
function addVideoCard(id,name,stream,isLocal=false){
  if(!id||!stream)return;
  let card=document.querySelector('[data-video-id="'+CSS.escape(id)+'"]');
  if(!card){
    card=document.createElement("div");
    card.className="video-card"+(isLocal?" local":"");
    card.dataset.videoId=id;
    card.innerHTML='<video autoplay playsinline muted></video><div class="video-name"></div><div class="video-badges"><span class="video-badge camera-badge">📹</span><span class="video-badge mic-badge">🎙</span></div>';
    $("videoGrid").appendChild(card);
  }
  const video=card.querySelector("video");
  video.autoplay=true;video.playsInline=true;video.srcObject=stream;
  video.muted=!!isLocal;video.volume=isLocal?0:1;
  card.querySelector(".video-name").textContent=name||"Participante";
  applySpeaker();makeVideoDraggable(card);
  video.play().catch(err=>console.warn("Reprodução de vídeo:",err?.name||err));
}
function makeVideoDraggable(card){
  if(card.dataset.draggable==="1")return;
  card.dataset.draggable="1";
  card.style.left=card.style.left||"20px";card.style.top=card.style.top||"25px";
  let dragging=false,startX=0,startY=0,baseX=0,baseY=0;
  card.addEventListener("pointerdown",e=>{dragging=true;card.setPointerCapture?.(e.pointerId);startX=e.clientX;startY=e.clientY;baseX=parseFloat(card.style.left)||0;baseY=parseFloat(card.style.top)||0;card.style.zIndex="40";e.preventDefault()});
  card.addEventListener("pointermove",e=>{
    if(!dragging)return;
    const parent=$("videoGrid").getBoundingClientRect(),w=card.offsetWidth,h=card.offsetHeight;
    card.style.left=Math.max(0,Math.min(Math.max(0,parent.width-w),baseX+e.clientX-startX))+"px";
    card.style.top=Math.max(0,Math.min(Math.max(0,parent.height-h),baseY+e.clientY-startY))+"px";
  });
  const stop=()=>{dragging=false};card.addEventListener("pointerup",stop);card.addEventListener("pointercancel",stop);
}
function removeVideoCard(id){document.querySelector('[data-video-id="'+CSS.escape(id)+'"]')?.remove()}
function updateVideoStatus(id,data){
  const card=document.querySelector('[data-video-id="'+CSS.escape(id)+'"]');if(!card)return;
  card.querySelector(".camera-badge")?.textContent;
  const camera=card.querySelector(".camera-badge"),mic=card.querySelector(".mic-badge");
  if(camera)camera.textContent=data.camera===false?"🚫":"📹";
  if(mic)mic.textContent=data.mic===false?"🔇":"🎙";
}


function configureRoleUI(){
  document.querySelectorAll(".host-only").forEach(el=>el.classList.toggle("hidden",!hostMode));
  // O aluno acompanha o quadro, mas não altera o conteúdo criado pelo professor.
  if(!hostMode){
    tool="select";
    $("board")?.classList.add("readonly-board");
    $("mediaMessage").textContent="A acompanhar a aula em tempo real.";
  }
  if(hostMode){
    $("shareClass")?.addEventListener("click",shareClass);
  }
}

async function shareClass(){
  const link=new URL("aula.html?room="+encodeURIComponent(room),location.href).href;
  const textMsg="Entre na minha aula ao vivo: "+link;
  try{await navigator.clipboard.writeText(link)}catch{}
  const b=$("shareClass");
  if(b){b.textContent="✓ Link copiado";setTimeout(()=>b.textContent="🔗 Partilhar",1800)}
  window.open("https://wa.me/?text="+encodeURIComponent(textMsg),"_blank");
}

async function startMedia(){
  if(!navigator.mediaDevices?.getUserMedia){
    $("mediaMessage").textContent="Câmera/microfone indisponíveis neste navegador. Use o site em HTTPS.";
    return;
  }
  let stream=null;
  let cameraError=null,micError=null;
  try{
    stream=await navigator.mediaDevices.getUserMedia({
      video:{facingMode:"user",width:{ideal:640,max:1280},height:{ideal:480,max:720},frameRate:{ideal:24,max:30}},
      audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}
    });
  }catch(err){
    cameraError=err;
    try{
      stream=await navigator.mediaDevices.getUserMedia({video:false,audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    }catch(err2){
      micError=err2;
      try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"user",width:{ideal:640},height:{ideal:480}},audio:false})}
      catch(err3){cameraError=err3}
    }
  }
  if(stream?.getTracks().length){
    localStream=stream;
    mediaReady=true;
    addVideoCard(meId,meName,localStream,true);
    attachLocalTracksToPeers();
    const hasVideo=hasEnabledTrack("video"),hasAudio=hasEnabledTrack("audio");
    await update(ref(db,"participants/"+room+"/"+meId),{camera:hasVideo,mic:hasAudio});
    setButtonState("toggleMic",hasAudio,"🎙 <span>Microfone</span>","🔇 <span>Microfone</span>");
    setButtonState("toggleCamera",hasVideo,"📹 <span>Câmera</span>","🚫 <span>Câmera</span>");
    $("mediaMessage").textContent=hasVideo&&hasAudio?"Câmera e microfone ativos.":hasVideo?"Câmera ativa. Microfone indisponível.":hasAudio?"Microfone ativo. Câmera indisponível.":"Mídia indisponível.";
  }else{
    localStream=null;mediaReady=false;
    await update(ref(db,"participants/"+room+"/"+meId),{camera:false,mic:false}).catch(()=>{});
    const errors=[cameraError?.name,micError?.name].filter(Boolean).join(" / ");
    $("mediaMessage").textContent="Não foi possível ativar câmera/microfone"+(errors?" ("+errors+")":"")+". Use os botões abaixo para tentar novamente.";
    setButtonState("toggleCamera",false,"📹 <span>Câmera</span>","🚫 <span>Câmera</span>");
    setButtonState("toggleMic",false,"🎙 <span>Microfone</span>","🔇 <span>Microfone</span>");
  }
}
async function ensureTrack(kind){
  if(localStream?.getTracks().some(t=>t.kind===kind))return localStream.getTracks().find(t=>t.kind===kind);
  try{
    const extra=await navigator.mediaDevices.getUserMedia(kind==="video"?{video:true,audio:false}:{video:false,audio:true});
    if(!localStream)localStream=new MediaStream();
    extra.getTracks().forEach(t=>localStream.addTrack(t));
    addVideoCard(meId,meName,localStream,true);
    attachLocalTracksToPeers();
    return extra.getTracks()[0]||null;
  }catch(err){
    console.warn("Permissão de "+kind,err);
    return null;
  }
}

async function setLocalTrack(kind,enabled,writeParticipant=true){
  let track=localStream?.getTracks().find(t=>t.kind===kind);
  if(!track&&enabled)track=await ensureTrack(kind);
  if(!track)return false;
  track.enabled=enabled;
  if(kind==="video" && localStream)addVideoCard(meId,meName,localStream,true);
  if(writeParticipant)await update(ref(db,"participants/"+room+"/"+meId),kind==="video"?{camera:enabled}:{mic:enabled});
  if(kind==="video"){
    setButtonState("toggleCamera",enabled,hostMode?"📹 <span>Minha câmera</span>":"📹 <span>Câmera</span>",hostMode?"🚫 <span>Abrir câmera</span>":"🚫 <span>Câmera</span>");
    const q=$("hostCameraQuick");
    if(q)q.innerHTML=enabled?"📹 Câmera ligada":"🚫 Abrir câmera";
  }else{
    setButtonState("toggleMic",enabled,hostMode?"🎙 <span>Meu microfone</span>":"🎙 <span>Microfone</span>",hostMode?"🔇 <span>Ligar microfone</span>":"🔇 <span>Microfone</span>");
    const q=$("hostMicQuick");
    if(q)q.innerHTML=enabled?"🎙 Microfone ligado":"🔇 Ligar microfone";
  }
  return true;
}

async function toggleTrack(kind){
  // Se a câmera ainda não existe, o clique solicita explicitamente a câmera ao navegador.
  const current=localStream?.getTracks().find(t=>t.kind===kind);
  const next=current?!current.enabled:true;
  const ok=await setLocalTrack(kind,next,true);
  if(!ok)alert("Não foi possível ativar "+(kind==="video"?"a câmera.":" o microfone.")+" neste dispositivo.");
}

function applySpeaker(){
  document.querySelectorAll("#videoGrid video").forEach(v=>{
    if(v.closest(".local")){v.muted=true;v.volume=0}
    else{v.muted=!speakerOn;v.volume=speakerOn?1:0}
  });
  setButtonState("toggleSpeaker",speakerOn,"🔊 <span>Som</span>","🔇 <span>Som</span>");
}

function watchRemoteControls(){
  onValue(ref(db,"controls/"+room+"/"+meId),async snap=>{
    const c=snap.val();
    if(!c)return;
    if(typeof c.mic==="boolean")await setLocalTrack("audio",c.mic,false);
    if(typeof c.camera==="boolean")await setLocalTrack("video",c.camera,false);
    $("mediaMessage").textContent="O professor atualizou os seus controles de câmera/microfone.";
    await remove(ref(db,"controls/"+room+"/"+meId));
  });
}

async function setRemoteControl(id,kind,enabled){
  if(!hostMode||!id||id===meId)return;
  await update(ref(db,"controls/"+room+"/"+id),{[kind]:enabled,updatedAt:Date.now(),by:meId});
}

function renderParticipantList(arr){
  $("participants").innerHTML=arr.map(([id,p])=>{
    const isSelf=id===meId;
    const controls=hostMode&&!isSelf&&p.role==="student"
      ?'<div class="participant-controls">'+
        '<button class="participant-control '+(p.mic===false?"off":"")+'" data-pid="'+esc(id)+'" data-kind="mic" data-enabled="'+(p.mic===false?"true":"false")+'" title="'+(p.mic===false?"Ligar microfone":"Desligar microfone")+'">'+(p.mic===false?"🎙":"🔇")+'</button>'+
        '<button class="participant-control '+(p.camera===false?"off":"")+'" data-pid="'+esc(id)+'" data-kind="camera" data-enabled="'+(p.camera===false?"true":"false")+'" title="'+(p.camera===false?"Ligar câmera":"Desligar câmera")+'">'+(p.camera===false?"📹":"🚫")+'</button>'+
      '</div>' : "";
    return '<div class="participant" data-participant-id="'+esc(id)+'"><span class="avatar-sm">'+esc((p.name||"A").charAt(0).toUpperCase())+'</span><span class="participant-name">'+esc(p.name||"Participante")+'</span><span class="online"></span>'+controls+'</div>';
  }).join("");
  if(hostMode){
    document.querySelectorAll(".participant-control").forEach(b=>b.onclick=async()=>{
      const pid=b.dataset.pid,kind=b.dataset.kind,enabled=b.dataset.enabled==="true";
      await setRemoteControl(pid,kind,enabled);
    });
  }
}

function watchParticipants(){
  onValue(ref(db,"participants/"+room),snap=>{
    const data=snap.val()||{}, arr=Object.entries(data).filter(([id,p])=>p.online!==false);
    $("participantCount").textContent=arr.length;
    $("participantBadge").textContent=arr.length+(arr.length===1?" participante":" participantes");
    renderParticipantList(arr);
    arr.forEach(([id,p])=>{
      if(id!==meId)updateVideoStatus(id,p);
      if(hostMode && id!==meId && p.role==="student" && !peers[id])createPeer(id,p.name);
    });
    attachLocalTracksToPeers();
    Object.keys(peers).forEach(id=>{if(!data[id]||data[id].online===false)closePeer(id)});
    if(localStream)update(ref(db,"participants/"+room+"/"+meId),{camera:hasEnabledTrack("video"),mic:hasEnabledTrack("audio")});
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

async function createPeer(remoteId,remoteName){
  if(peers[remoteId])return peers[remoteId];
  const pc=new RTCPeerConnection(RTC_CONFIG);
  const peer={pc,remoteName:remoteName||"Participante",polite:meRole==="student",makingOffer:false,ignoreOffer:false,isSettingRemoteAnswerPending:false};
  peers[remoteId]=peer;
  pendingCandidates[remoteId]=[];
  if(localStream)localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
  pc.onicecandidate=e=>{if(e.candidate)sendSignal(remoteId,{type:"candidate",candidate:e.candidate.toJSON()})};
  pc.ontrack=e=>{
    const stream=e.streams?.[0]||new MediaStream([e.track]);
    addVideoCard(remoteId,peer.remoteName,stream,false);
  };
  pc.onnegotiationneeded=async()=>{
    try{
      peer.makingOffer=true;
      await pc.setLocalDescription();
      await sendSignal(remoteId,{type:"description",description:{type:pc.localDescription.type,sdp:pc.localDescription.sdp}});
    }catch(err){console.warn("Negociação WebRTC",err)}
    finally{peer.makingOffer=false}
  };
  pc.oniceconnectionstatechange=()=>{
    const state=pc.iceConnectionState;
    if(state==="connected"||state==="completed")$("mediaMessage").textContent="Vídeo e áudio ligados em tempo real.";
    else if(state==="checking"||state==="new")$("mediaMessage").textContent="A ligar câmera e áudio…";
    else if(state==="failed"){
      $("mediaMessage").textContent="A ligação de vídeo falhou. A tentar restabelecer…";
      if(!pc.__iceRestarted&&pc.restartIce){
        pc.__iceRestarted=true;
        try{pc.restartIce()}catch{}
      }
    }
  };
  pc.onicecandidateerror=e=>console.warn("ICE:",e.errorCode,e.url,e.errorText);
  pc.__iceRestarted=false;
  pc.onconnectionstatechange=()=>{
    const state=pc.connectionState;
    if(state==="connected")$("mediaMessage").textContent="Vídeo e áudio ligados em tempo real.";
    if(["failed","closed"].includes(state))closePeer(remoteId);
  };
  return peer;
}

async function handleSignal(from,msg){
  if(!from||from===meId)return;
  const participant=await once("participants/"+room+"/"+from);
  const peer=await createPeer(from,participant?.name||"Participante");
  const pc=peer.pc;
  if(msg.type==="description"){
    const description=msg.description;
    const readyForOffer=!peer.makingOffer&&(pc.signalingState==="stable"||peer.isSettingRemoteAnswerPending);
    const offerCollision=description.type==="offer"&&!readyForOffer;
    peer.ignoreOffer=!peer.polite&&offerCollision;
    if(peer.ignoreOffer)return;
    peer.isSettingRemoteAnswerPending=description.type==="answer";
    await pc.setRemoteDescription(new RTCSessionDescription(description));
    peer.isSettingRemoteAnswerPending=false;
    for(const c of pendingCandidates[from]||[])await pc.addIceCandidate(new RTCIceCandidate(c)).catch(()=>{});
    pendingCandidates[from]=[];
    if(description.type==="offer"){
      await pc.setLocalDescription();
      await sendSignal(from,{type:"description",description:{type:pc.localDescription.type,sdp:pc.localDescription.sdp}});
    }
  }else if(msg.type==="candidate"){
    try{
      if(pc.remoteDescription)await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
      else pendingCandidates[from].push(msg.candidate);
    }catch(err){
      if(!peer.ignoreOffer)console.warn("ICE candidate",err);
    }
  }
}

function closePeer(id){
  try{peers[id]?.pc?.close()}catch{}
  delete peers[id];delete pendingCandidates[id];removeVideoCard(id);
}
function watchClock(){
  setInterval(()=>{const s=Math.max(0,Math.floor((Date.now()-startTime)/1000));$("timer").textContent=String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0")},1000);
}

function setupBoard(){
  // O motor do quadro V2 controla canvas, tamanho e redesenho.
  // Mantemos esta função para compatibilidade com a entrada existente.
}
function bindBoard(){}
function watchBoard(){}
function setupTools(){
  $("fullscreen").onclick=()=>document.documentElement.requestFullscreen?.();
  $("raiseHand").onclick=()=>update(ref(db,"participants/"+room+"/"+meId),{hand:true,handAt:Date.now()});
  $("toggleMic").onclick=()=>toggleTrack("audio");
  $("toggleCamera").onclick=()=>toggleTrack("video");
  $("toggleSpeaker").onclick=()=>{speakerOn=!speakerOn;applySpeaker()};
  if(hostMode){
    $("toggleMic").title="Professor: ligar/desligar microfone";
    $("toggleCamera").title="Professor: abrir/desligar a sua câmera";
    $("hostCameraQuick").onclick=()=>toggleTrack("video");
    $("hostMicQuick").onclick=()=>toggleTrack("audio");
  }
  $("leaveClass").onclick=leaveClass;
}

// ===== NOVO QUADRO COMPLETO =====
let nbCanvas=null,nbCtx=null,nbTool="select",nbColor="#111827",nbSize=4,nbBg="white",nbPages=[[]],nbPage=0,nbDrawing=false,nbPoints=[],nbUndo=[],nbRedo=[];
function nbBackground(){
  const colors={white:"#fff",green:"#245b3a",black:"#111",blue:"#174a70",grid:"#fff",lines:"#fff"};
  nbCtx.fillStyle=colors[nbBg]||"#fff";nbCtx.fillRect(0,0,nbCanvas.width,nbCanvas.height);
  if(nbBg==="grid"||nbBg==="lines"){nbCtx.strokeStyle="rgba(0,0,0,.12)";nbCtx.lineWidth=1;for(let x=0;x<nbCanvas.width;x+=36){nbCtx.beginPath();nbCtx.moveTo(x,0);nbCtx.lineTo(x,nbCanvas.height);nbCtx.stroke()}if(nbBg==="grid")for(let y=0;y<nbCanvas.height;y+=36){nbCtx.beginPath();nbCtx.moveTo(0,y);nbCtx.lineTo(nbCanvas.width,y);nbCtx.stroke()}else for(let y=18;y<nbCanvas.height;y+=36){nbCtx.beginPath();nbCtx.moveTo(0,y);nbCtx.lineTo(nbCanvas.width,y);nbCtx.stroke()}}
}
function nbPoint(e){const r=nbCanvas.getBoundingClientRect();return{x:(e.clientX-r.left)*nbCanvas.width/r.width,y:(e.clientY-r.top)*nbCanvas.height/r.height}}
function nbRender(){
  if(!nbCtx)return;nbBackground();for(const o of nbPages[nbPage]||[])nbDraw(o);
}
function nbDraw(o){
  nbCtx.save();nbCtx.strokeStyle=o.color||nbColor;nbCtx.fillStyle=o.color||nbColor;nbCtx.lineWidth=o.size||4;nbCtx.lineCap="round";nbCtx.lineJoin="round";
  if(o.type==="stroke"){nbCtx.globalAlpha=o.alpha??1;nbCtx.beginPath();o.points.forEach((p,i)=>i?nbCtx.lineTo(p.x,p.y):nbCtx.moveTo(p.x,p.y));nbCtx.stroke()}
  else if(o.type==="line"||o.type==="arrow"){nbCtx.beginPath();nbCtx.moveTo(o.a.x,o.a.y);nbCtx.lineTo(o.b.x,o.b.y);nbCtx.stroke();if(o.type==="arrow"){const a=Math.atan2(o.b.y-o.a.y,o.b.x-o.a.x);nbCtx.beginPath();nbCtx.moveTo(o.b.x,o.b.y);nbCtx.lineTo(o.b.x-14*Math.cos(a-.5),o.b.y-14*Math.sin(a-.5));nbCtx.lineTo(o.b.x-14*Math.cos(a+.5),o.b.y-14*Math.sin(a+.5));nbCtx.closePath();nbCtx.fill()}}
  else if(o.type==="rect"){nbCtx.strokeRect(o.a.x,o.a.y,o.b.x-o.a.x,o.b.y-o.a.y)}
  else if(o.type==="circle"){const rx=Math.abs(o.b.x-o.a.x),ry=Math.abs(o.b.y-o.a.y);nbCtx.beginPath();nbCtx.ellipse(o.a.x+(o.b.x-o.a.x)/2,o.a.y+(o.b.y-o.a.y)/2,rx/2,ry/2,0,0,Math.PI*2);nbCtx.stroke()}
  else if(o.type==="text"){nbCtx.font=o.font||"24px sans-serif";nbCtx.fillText(o.text,o.x,o.y)}
  else if(o.type==="image"){const im=new Image();im.onload=()=>{nbCtx.drawImage(im,o.x,o.y,o.w,o.h)};im.src=o.src}
  nbCtx.restore();
}
function nbResize(){const r=$("boardWrap").getBoundingClientRect();nbCanvas.width=Math.max(300,Math.floor(r.width));nbCanvas.height=Math.max(280,Math.floor(r.height));nbRender()}
function nbSnapshot(){return JSON.stringify(nbPages)}
function nbRestore(s){nbPages=JSON.parse(s);nbRender()}
function nbCommit(){
  nbUndo.push(nbSnapshot());if(nbUndo.length>30)nbUndo.shift();nbRedo=[];
  const data={pages:nbPages,page:nbPage,background:nbBg,updatedAt:Date.now()};
  set(ref(db,"whiteboards/"+room+"/v2"),data);
}
async function nbSync(){
  const data=await once("whiteboards/"+room+"/v2");if(data?.pages){nbPages=data.pages;nbPage=data.page||0;nbBg=data.background||"white";nbRender();nbUpdatePage()}
}
function nbUpdatePage(){$("boardPageLabel").textContent="Página "+(nbPage+1)+" / "+nbPages.length}
function nbSetTool(t){nbTool=t;document.querySelectorAll("[data-board-tool]").forEach(b=>b.classList.toggle("active",b.dataset.boardTool===t))}
function nbInit(){
  nbCanvas=$("board");nbCtx=nbCanvas.getContext("2d");nbResize();window.addEventListener("resize",nbResize);
  document.querySelectorAll("[data-board-tool]").forEach(b=>b.onclick=()=>{nbSetTool(b.dataset.boardTool);if(b.dataset.boardTool==="image")$("newImagePicker").click();if(b.dataset.boardTool==="pdf")$("newPdfPicker").click()});
  document.querySelectorAll("[data-board-color]").forEach(b=>b.onclick=()=>{nbColor=b.dataset.boardColor;document.querySelectorAll("[data-board-color]").forEach(x=>x.classList.toggle("active",x===b))});
  $("newBoardSize").oninput=e=>nbSize=+e.target.value;
  $("boardUndo").onclick=()=>{if(nbUndo.length){nbRedo.push(nbSnapshot());nbRestore(nbUndo.pop())}};
  $("boardRedo").onclick=()=>{if(nbRedo.length){nbUndo.push(nbSnapshot());nbRestore(nbRedo.pop())}};
  $("boardClear").onclick=()=>{nbUndo.push(nbSnapshot());nbPages[nbPage]=[];nbRender();nbCommit()};
  $("boardBackground").onclick=()=>$("boardBackgroundPanel").classList.toggle("hidden");
  document.querySelectorAll("[data-new-bg]").forEach(b=>b.onclick=()=>{nbBg=b.dataset.newBg;nbRender();nbCommit();$("boardBackgroundPanel").classList.add("hidden")});
  $("boardSave").onclick=()=>{const a=document.createElement("a");a.download="quadro-"+room+"-pagina-"+(nbPage+1)+".png";a.href=nbCanvas.toDataURL("image/png");a.click()};
  $("newBoardPage").onclick=()=>{nbUndo.push(nbSnapshot());nbPages.splice(nbPage+1,0,[]);nbPage++;nbRender();nbUpdatePage();nbCommit()};
  $("duplicateBoardPage").onclick=()=>{nbUndo.push(nbSnapshot());nbPages.splice(nbPage+1,0,JSON.parse(JSON.stringify(nbPages[nbPage])));nbPage++;nbRender();nbUpdatePage();nbCommit()};
  $("deleteBoardPage").onclick=()=>{if(nbPages.length===1)return;nbUndo.push(nbSnapshot());nbPages.splice(nbPage,1);nbPage=Math.max(0,Math.min(nbPage,nbPages.length-1));nbRender();nbUpdatePage();nbCommit()};
  $("prevBoardPage").onclick=()=>{nbPage=Math.max(0,nbPage-1);nbRender();nbUpdatePage();nbCommit()};
  $("nextBoardPage").onclick=()=>{nbPage=Math.min(nbPages.length-1,nbPage+1);nbRender();nbUpdatePage();nbCommit()};
  $("boardDocument").onclick=()=>$("newPdfPicker").click();
  $("newImagePicker").onchange=e=>{const file=e.target.files?.[0];if(!file)return;const rd=new FileReader();rd.onload=()=>{const im=new Image();im.onload=()=>{const max=500,s=Math.min(1,max/im.width),o={type:"image",src:rd.result,x:60,y:60,w:im.width*s,h:im.height*s};nbPages[nbPage].push(o);nbRender();nbCommit()};im.src=rd.result};rd.readAsDataURL(file);e.target.value=""};
  $("newPdfPicker").onchange=e=>{const file=e.target.files?.[0];if(file){alert("PDF selecionado. A importação visual de páginas PDF será adicionada sem alterar a câmera/vídeo.");e.target.value=""}};
  nbCanvas.onpointerdown=e=>{if(!hostMode||nbTool==="select")return;const p=nbPoint(e);if(nbTool==="text"){const text=prompt("Texto:");if(text){nbPages[nbPage].push({type:"text",text,x:p.x,y:p.y,color:nbColor,font:Math.max(16,nbSize*6)+"px sans-serif"});nbRender();nbCommit()}return}nbDrawing=true;nbPoints=[p];nbCanvas.setPointerCapture?.(e.pointerId)};
  nbCanvas.onpointermove=e=>{if(!nbDrawing)return;nbPoints.push(nbPoint(e));nbRender();if(["pen","highlighter","eraser"].includes(nbTool)){const o={type:"stroke",points:nbPoints,color:nbTool==="eraser"?(nbBg==="white"?"#fff":(nbBg==="green"?"#245b3a":"#111")):nbColor,size:nbTool==="highlighter"?Math.max(nbSize*3,12):nbSize,alpha:nbTool==="highlighter"?.28:1};nbDraw(o);set(ref(db,"whiteboards/"+room+"/v2live/"+meId),{...o,page:nbPage,updatedAt:Date.now()})}};
  nbCanvas.onpointerup=e=>{if(!nbDrawing)return;nbDrawing=false;nbPoints.push(nbPoint(e));const a=nbPoints[0],b=nbPoints[nbPoints.length-1];if(["pen","highlighter","eraser"].includes(nbTool))nbPages[nbPage].push({type:"stroke",points:nbPoints,color:nbTool==="eraser"?(nbBg==="white"?"#fff":(nbBg==="green"?"#245b3a":"#111")):nbColor,size:nbTool==="highlighter"?Math.max(nbSize*3,12):nbSize,alpha:nbTool==="highlighter"?.28:1});else if(["line","arrow","rect","circle"].includes(nbTool))nbPages[nbPage].push({type:nbTool,a,b,color:nbColor,size:nbSize});nbPoints=[];remove(ref(db,"whiteboards/"+room+"/v2live/"+meId));nbRender();nbCommit()};
  nbSync();
  onValue(ref(db,"whiteboards/"+room+"/v2"),s=>{const d=s.val();if(d?.pages){nbPages=d.pages;nbPage=d.page||0;nbBg=d.background||"white";nbRender();nbUpdatePage()}});
  onValue(ref(db,"whiteboards/"+room+"/v2live"),s=>{
    if(hostMode)return;
    const live=s.val()||{};
    Object.values(live).forEach(o=>{if(o.page===nbPage&&o.points)nbDraw(o)});
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