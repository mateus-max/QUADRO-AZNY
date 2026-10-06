import { db } from "./firebase-config.js";
import { ref, push, set, onValue } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

const $=id=>document.getElementById(id);
const params=new URLSearchParams(location.search);
let teacherId=params.get("teacher")||localStorage.getItem("qaz_teacher_id");
let currentTeacher=null,currentRoom=null;

function esc(v){return String(v??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
function classLink(room){return new URL("aula.html?room="+encodeURIComponent(room),location.href).href}

function photoData(file){
  return new Promise((resolve,reject)=>{
    if(!file)return resolve("");
    if(!file.type.startsWith("image/"))return reject(new Error("Selecione uma imagem válida."));
    if(file.size>5*1024*1024)return reject(new Error("A fotografia deve ter no máximo 5 MB."));
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error("Não foi possível ler a fotografia."));
    reader.onload=()=>{
      const img=new Image();
      img.onload=()=>{
        const max=800,scale=Math.min(1,max/Math.max(img.width,img.height));
        const c=document.createElement("canvas");
        c.width=Math.max(1,Math.round(img.width*scale));c.height=Math.max(1,Math.round(img.height*scale));
        c.getContext("2d").drawImage(img,0,0,c.width,c.height);
        resolve(c.toDataURL("image/jpeg",0.75));
      };
      img.onerror=()=>reject(new Error("Fotografia inválida."));
      img.src=reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function showTeacher(t){
  currentTeacher=t;
  $("setupScreen").classList.add("hidden");
  $("teacherApp").classList.remove("hidden");
  $("headerTeacher").textContent=t.name||"Professor";
  $("sideTeacher").textContent=t.name||"Professor";
  $("headerCourse").textContent=t.courseName||"Quadro Virtual";
  $("sideCourse").textContent=t.courseName||"Quadro Virtual";
  const a=$("teacherAvatar");
  if(t.photo){a.innerHTML='<img src="'+t.photo+'" alt="Foto">';a.style.overflow="hidden";a.style.padding="0"}else a.textContent=(t.name||"P").charAt(0).toUpperCase();
}

async function createTeacher(e){
  e.preventDefault();
  const b=e.submitter||$("teacherForm").querySelector("button");
  const name=$("teacherName").value.trim(),course=$("courseName").value.trim(),whatsapp=$("teacherWhatsapp").value.trim(),file=$("teacherPhoto").files?.[0];
  if(!name||!course)return alert("Preencha o nome do professor e o nome do curso.");
  b.disabled=true;b.textContent="A criar quadro...";
  try{
    const photo=await photoData(file);
    const r=push(ref(db,"teachers"));
    const data={name,courseName:course,whatsapp,photo,createdAt:Date.now(),active:true};
    await set(r,data);
    teacherId=r.key;localStorage.setItem("qaz_teacher_id",teacherId);
    showTeacher(data);
  }catch(err){console.error(err);alert(err.message||"Não foi possível criar o quadro.");b.disabled=false;b.textContent="Criar / Abrir meu quadro"}
}

async function startClass(){
  if(!currentTeacher)return alert("Configure primeiro o professor.");
  if(currentRoom)return location.href="aula.html?room="+encodeURIComponent(currentRoom)+"&host=1&teacher="+encodeURIComponent(teacherId);
  const r=push(ref(db,"classes"));currentRoom=r.key;
  await set(r,{teacherId,title:currentTeacher.courseName||"Aula online",status:"live",createdAt:Date.now(),startedAt:Date.now(),accessCode:r.key});
  $("activeTitle").textContent=currentTeacher.courseName||"Aula online";
  $("activeRoom").textContent="Sala: "+r.key;
  $("classLink").value=classLink(r.key);$("linkArea").classList.remove("hidden");
  $("liveStatus").textContent="Aula em andamento";$("stateStat").textContent="Ao vivo";$("startClass").textContent="↗ Abrir Quadro";
  watchStudents(r.key);
  // Abrir imediatamente a sala real do professor, em vez de deixar apenas o painel em "Aula em andamento".
  location.href="aula.html?room="+encodeURIComponent(r.key)+"&host=1&teacher="+encodeURIComponent(teacherId);
}

function watchStudents(room){
  onValue(ref(db,"participants/"+room),s=>{
    const d=s.val()||{},list=$("studentList");let n=0;list.innerHTML="";
    Object.values(d).forEach(p=>{if(p.online!==false){n++;const row=document.createElement("div");row.className="student-row";row.innerHTML="<span>"+esc(p.name||"Aluno")+"</span><span class='dot'></span>";list.appendChild(row)}});
    $("onlineCount").textContent=n;$("studentStat").textContent=n;
  });
}

$("teacherPhoto")?.addEventListener("change",e=>{
  const f=e.target.files?.[0],box=$("photoPreview"),img=$("photoPreviewImg");
  if(!f){box.classList.add("hidden");return}
  if(!f.type.startsWith("image/")){alert("Selecione uma imagem válida.");e.target.value="";box.classList.add("hidden");return}
  img.src=URL.createObjectURL(f);box.classList.remove("hidden");
});
$("teacherForm")?.addEventListener("submit",createTeacher);
$("startClass")?.addEventListener("click",startClass);
$("copyLink")?.addEventListener("click",async()=>{try{await navigator.clipboard.writeText($("classLink").value)}catch{$("classLink").select();document.execCommand("copy")}$("copyLink").textContent="Copiado ✓";setTimeout(()=>$("copyLink").textContent="Copiar link",1500)});
$("waLink")?.addEventListener("click",()=>window.open("https://wa.me/?text="+encodeURIComponent("Entre na minha aula: "+$("classLink").value),"_blank"));

if(teacherId){
  onValue(ref(db,"teachers/"+teacherId),s=>{
    if(s.exists())showTeacher(s.val());
    else{teacherId=null;localStorage.removeItem("qaz_teacher_id")}
  });
  onValue(ref(db,"classes"),s=>{
    const all=s.val()||{};
    $("classCount").textContent=Object.values(all).filter(x=>x.teacherId===teacherId).length;
  });
}