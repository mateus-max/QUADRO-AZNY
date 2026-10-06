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
  const tracks=[];
  let cameraError=null,micError=null;
  try{
    const videoStream=await navigator.mediaDevices.getUserMedia({
      video:{facingMode:"user",width:{ideal:640},height:{ideal:480}},
      audio:false
    });
    videoStream.getVideoTracks().forEach(t=>tracks.push(t));
  }catch(err){cameraError=err;console.warn("Câmera:",err?.name,err?.message)}
  try{
    const audioStream=await navigator.mediaDevices.getUserMedia({video:false,audio:true});
    audioStream.getAudioTracks().forEach(t=>tracks.push(t));
  }catch(err){micError=err;console.warn("Microfone:",err?.name,err?.message)}

  if(tracks.length){
    localStream=new MediaStream(tracks);
    mediaReady=true;
    addVideoCard(meId,meName,localStream,true);
    attachLocalTracksToPeers();
    const hasVideo=hasEnabledTrack("video"),hasAudio=hasEnabledTrack("audio");
    await update(ref(db,"participants/"+room+"/"+meId),{camera:hasVideo,mic:hasAudio});
    setButtonState("toggleMic",hasAudio,"🎙 <span>Microfone</span>","🔇 <span>Microfone</span>");
    setButtonState("toggleCamera",hasVideo,"📹 <span>Câmera</span>","🚫 <span>Câmera</span>");
    $("mediaMessage").textContent=hasVideo&&hasAudio?"Câmera e microfone ativos.":hasVideo?"Câmera ativa. Microfone indisponível.":hasAudio?"Microfone ativo. Câmera indisponível.":"Mídia parcialmente disponível.";
  }else{
    localStream=null;mediaReady=false;
    await update(ref(db,"participants/"+room+"/"+meId),{camera:false,mic:false}).catch(()=>{});
    $("mediaMessage").textContent="Não foi possível ativar câmera/microfone ("+(cameraError?.name||"indisponível")+" / "+(micError?.name||"indisponível")+"). Toque nos botões para tentar novamente.";
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
  if(kind==="video")setButtonState("toggleCamera",enabled,"📹 <span>Câmera</span>","🚫 <span>Câmera</span>");
  else setButtonState("toggleMic",enabled,"🎙 <span>Microfone</span>","🔇 <span>Microfone</span>");
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

let boardObjects={},liveStrokes={};\nlet boardSettings={background:"white",pattern:"plain"};
let liveWriteTimer=null;

function setupBoard(){
  board=$("board");ctx=board.getContext("2d");
  resizeBoard();
  window.addEventListener("resize",()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(resizeBoard,100)});
}

function resizeBoard(){
  if(!board)return;
  const r=$("boardWrap").getBoundingClientRect();
  board.width=Math.max(300,Math.floor(r.width));
  board.height=Math.max(260,Math.floor(r.height));
  redrawAll();
}

function redrawAll(){
  if(!ctx)return;
  ctx.clearRect(0,0,board.width,board.height);
  ctx.fillStyle="#fff";ctx.fillRect(0,0,board.width,board.height);
  Object.values(boardObjects||{}).forEach(renderObject);
  Object.values(liveStrokes||{}).forEach(o=>renderObject(o));
}

function renderStroke(o){
  if(!o?.points?.length)return;
  ctx.save();ctx.globalCompositeOperation=o.tool==="eraser"?"destination-out":"source-over";ctx.strokeStyle=o.color||"#111827";ctx.lineWidth=o.size||4;ctx.lineCap="round";ctx.lineJoin="round";
  ctx.beginPath();o.points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke();ctx.restore();
}

function renderObject(o){
  if(!o)return;ctx.save();
  if(o.type==="stroke")renderStroke(o);
  else if(o.type==="line"){ctx.strokeStyle=o.color;ctx.lineWidth=o.size;ctx.beginPath();ctx.moveTo(o.a.x,o.a.y);ctx.lineTo(o.b.x,o.b.y);ctx.stroke()}
  else if(o.type==="rect"){ctx.strokeStyle=o.color;ctx.lineWidth=o.size;ctx.strokeRect(o.a.x,o.a.y,o.b.x-o.a.x,o.b.y-o.a.y)}
  else if(o.type==="text"){ctx.fillStyle=o.color;ctx.font=o.font||"24px sans-serif";ctx.fillText(o.text,o.x,o.y)}
  else if(o.type==="image"){const img=new Image();img.onload=()=>{ctx.drawImage(img,o.x,o.y,o.w,o.h)};img.src=o.src}
  else if(o.type==="staff"){ctx.strokeStyle=o.color;ctx.lineWidth=2;for(let i=0;i<5;i++){ctx.beginPath();ctx.moveTo(o.x,o.y+i*12);ctx.lineTo(o.x+o.w,o.y+i*12);ctx.stroke()}}
  ctx.restore();
}

function boardBgColor(){\n  return ({white:"#ffffff",green:"#245b3a",black:"#111111",blue:"#174a70",brown:"#5a3825",slate:"#26343f"})[boardSettings.background]||"#ffffff";\n}\n\nfunction drawBoardBackground(){\n  if(!ctx)return;\n  const bg=boardBgColor();\n  ctx.fillStyle=bg;ctx.fillRect(0,0,board.width,board.height);\n  const dark=["green","black","blue","brown","slate"].includes(boardSettings.background);\n  if(boardSettings.pattern==="grid"||boardSettings.pattern==="lines"){\n    ctx.save();ctx.lineWidth=1;ctx.strokeStyle=dark?"rgba(255,255,255,.13)":"rgba(0,0,0,.10)";\n    const step=36;\n    for(let x=0;x<=board.width;x+=step){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,board.height);ctx.stroke()}\n    if(boardSettings.pattern==="grid"){for(let y=0;y<=board.height;y+=step){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(board.width,y);ctx.stroke()}}\n    else{for(let y=18;y<=board.height;y+=step){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(board.width,y);ctx.stroke()}}\n    ctx.restore();\n  }\n}\n\nfunction updateBoardStyleUI(){\n  document.querySelectorAll("[data-board-style]").forEach(b=>b.classList.toggle("active",b.dataset.boardStyle===boardSettings.background));\n  document.querySelectorAll("[data-board-pattern]").forEach(b=>b.classList.toggle("active",b.dataset.boardPattern===boardSettings.pattern));\n}\n\nasync function setBoardStyle(background){\n  if(!hostMode)return;\n  boardSettings.background=background;\n  updateBoardStyleUI();redrawAll();\n  await update(ref(db,"whiteboards/"+room+"/settings"),{background,pattern:boardSettings.pattern,updatedAt:Date.now()});\n}\n\nasync function setBoardPattern(pattern){\n  if(!hostMode)return;\n  boardSettings.pattern=pattern;\n  updateBoardStyleUI();redrawAll();\n  await update(ref(db,"whiteboards/"+room+"/settings"),{background:boardSettings.background,pattern,updatedAt:Date.now()});\n}\n\nfunction point(e){
  const r=board.getBoundingClientRect();
  return{x:(e.clientX-r.left)*board.width/r.width,y:(e.clientY-r.top)*board.height/r.height};
}

function addObject(o){redoStack=[];return set(push(ref(db,"whiteboards/"+room+"/objects")),o)}

function queueLiveStroke(){
  clearTimeout(liveWriteTimer);
  liveWriteTimer=setTimeout(()=>{
    if(!drawing)return;
    const last=points[points.length-1];
    const first=points[0];
    const live=(tool==="line"||tool==="rect")
      ?{type:tool,a:first,b:last,color,size,updatedAt:Date.now()}
      :{type:"stroke",tool:tool==="eraser"?"eraser":"pen",points:points.map(p=>({x:p.x,y:p.y})),color,size:tool==="eraser"?Math.max(size*3,12):size,updatedAt:Date.now()};
    set(ref(db,"whiteboards/"+room+"/live/"+meId),live);
  },45);
}

function bindBoard(){
  board.onpointerdown=async e=>{
    if(!hostMode||tool==="select")return;
    const p=point(e);

    if(tool==="text"){const t=prompt("Texto:");if(t)addObject({type:"text",x:p.x,y:p.y,text:t,color,font:"24px sans-serif"});return}
    if(tool==="image"){$("imagePicker").click();return}
    if(tool==="staff"){addObject({type:"staff",x:p.x,y:p.y,w:420,color});return}
    if(tool==="piano"){$("pianoOverlay").classList.toggle("hidden");return}
    if(tool==="undo"){await undoLast();tool="pen";return}
    if(tool==="redo"){await redoLast();tool="pen";return}
    if(tool==="clear"){
      if(confirm("Limpar o quadro para todos?")){
        await set(ref(db,"whiteboards/"+room+"/objects"),null);
        await set(ref(db,"whiteboards/"+room+"/live"),null);
      }
      return;
    }

    drawing=true;
    points=[p];
    board.setPointerCapture?.(e.pointerId);

    if(tool==="line"||tool==="rect"){
      liveStrokes[meId]={type:tool,a:p,b:p,color,size};
    }else{
      liveStrokes[meId]={type:"stroke",tool:tool==="eraser"?"eraser":"pen",points:[p],color,size:tool==="eraser"?Math.max(size*3,12):size};
    }
    redrawAll();
    queueLiveStroke();
  };

  board.onpointermove=e=>{
    if(!drawing)return;
    const p=point(e);
    points.push(p);

    if(tool==="line"||tool==="rect"){
      liveStrokes[meId]={type:tool,a:points[0],b:p,color,size};
    }else{
      liveStrokes[meId]={type:"stroke",tool:tool==="eraser"?"eraser":"pen",points:points.map(p=>({x:p.x,y:p.y})),color,size:tool==="eraser"?Math.max(size*3,12):size};
    }
    redrawAll();
    queueLiveStroke();
  };

  board.onpointerup=async e=>{
    if(!drawing)return;
    drawing=false;
    points.push(point(e));
    clearTimeout(liveWriteTimer);

    const a=points[0],b=points[points.length-1];
    if(tool==="line"||tool==="rect"){
      await addObject({type:tool,a,b,color,size});
    }else{
      await addObject({type:"stroke",tool:tool==="eraser"?"eraser":"pen",points:points.map(p=>({x:p.x,y:p.y})),color,size:tool==="eraser"?Math.max(size*3,12):size});
    }

    delete liveStrokes[meId];
    redrawAll();
    await remove(ref(db,"whiteboards/"+room+"/live/"+meId));
    points=[];
  };

  board.onpointercancel=async()=>{
    drawing=false;points=[];clearTimeout(liveWriteTimer);
    delete liveStrokes[meId];redrawAll();
    await remove(ref(db,"whiteboards/"+room+"/live/"+meId));
  };
}

async function undoLast(){
  const s=await once("whiteboards/"+room+"/objects");
  const d=s||{};
  const keys=Object.keys(d);
  if(keys.length){
    const key=keys[keys.length-1];
    redoStack.push(d[key]);
    await remove(ref(db,"whiteboards/"+room+"/objects/"+key));
  }
}
async function redoLast(){
  const item=redoStack.pop();
  if(item)await set(push(ref(db,"whiteboards/"+room+"/objects")),item);
}

function watchBoard(){
  onValue(ref(db,"whiteboards/"+room+"/settings"),s=>{
    const v=s.val()||{};boardSettings={background:v.background||"white",pattern:v.pattern||"plain"};updateBoardStyleUI();redrawAll();
  });
  onValue(ref(db,"whiteboards/"+room+"/objects"),s=>{boardObjects=s.val()||{};redrawAll()});
  onValue(ref(db,"whiteboards/"+room+"/live"),s=>{liveStrokes=s.val()||{};redrawAll()});
}
function setupTools(){
  document.querySelectorAll("[data-tool]").forEach(b=>b.onclick=async()=>{
    const next=b.dataset.tool;
    if(["undo","redo","clear"].includes(next)){tool=next;return}
    tool=next;document.querySelectorAll("[data-tool]").forEach(x=>x.classList.toggle("active",x===b));
    if(next==="piano")$("pianoOverlay").classList.toggle("hidden");
  });
  document.querySelectorAll("[data-color]").forEach(b=>b.onclick=()=>color=b.dataset.color);\n  $("boardBackgrounds").onclick=()=>{if(hostMode)$("boardStylePanel").classList.toggle("hidden")};\n  document.querySelectorAll("[data-board-style]").forEach(b=>b.onclick=()=>setBoardStyle(b.dataset.boardStyle));\n  document.querySelectorAll("[data-board-pattern]").forEach(b=>b.onclick=()=>setBoardPattern(b.dataset.boardPattern));\n  updateBoardStyleUI();
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