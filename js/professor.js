import { db } from "./firebase-config.js";
import { ref, push, set, update, onValue } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let teacherId = params.get("teacher") || localStorage.getItem("qaz_teacher_id");
let currentTeacher = null;
let currentRoom = null;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function classLink(room) {
  return new URL("aula.html?room=" + encodeURIComponent(room), location.href).href;
}

function imageToDataURL(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve("");
    if (!file.type.startsWith("image/")) return reject(new Error("Selecione uma imagem válida."));
    if (file.size > 5 * 1024 * 1024) return reject(new Error("A fotografia deve ter no máximo 5 MB."));

    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Não foi possível ler a fotografia."));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 900;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.78));
      };
      img.onerror = () => reject(new Error("A fotografia não é válida."));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function showTeacher(t) {
  currentTeacher = t;
  $("setupScreen").classList.add("hidden");
  $("teacherApp").classList.remove("hidden");

  ["headerTeacher", "sideTeacher"].forEach(id => $(id).textContent = t.name || "Professor");
  ["headerCourse", "sideCourse"].forEach(id => $(id).textContent = t.courseName || "Quadro Virtual");

  const avatar = $("teacherAvatar");
  if (t.photo) {
    avatar.innerHTML = '<img src="' + t.photo + '" alt="Foto do professor">';
    avatar.style.overflow = "hidden";
    avatar.style.padding = "0";
  } else {
    avatar.textContent = (t.name || "P").trim().charAt(0).toUpperCase();
  }
}

function watchStudents(room) {
  onValue(ref(db, "participants/" + room), (snapshot) => {
    const data = snapshot.val() || {};
    const list = $("studentList");
    let count = 0;
    list.innerHTML = "";

    Object.values(data).forEach((student) => {
      if (student.online !== false) {
        count++;
        const row = document.createElement("div");
        row.className = "student-row";
        row.innerHTML = "<span>" + esc(student.name || "Aluno") + "</span><span class='dot'></span>";
        list.appendChild(row);
      }
    });

    $("onlineCount").textContent = count;
    $("studentStat").textContent = count;
  });
}

async function startClass() {
  if (!currentTeacher) {
    alert("Configure primeiro o professor.");
    return;
  }

  if (currentRoom) {
    location.href = "aula.html?room=" + encodeURIComponent(currentRoom);
    return;
  }

  const roomRef = push(ref(db, "classes"));
  currentRoom = roomRef.key;

  await set(roomRef, {
    teacherId,
    title: currentTeacher.courseName || "Aula online",
    status: "live",
    createdAt: Date.now(),
    startedAt: Date.now(),
    accessCode: currentRoom
  });

  $("activeTitle").textContent = currentTeacher.courseName || "Aula online";
  $("activeRoom").textContent = "Sala: " + currentRoom;
  $("classLink").value = classLink(currentRoom);
  $("linkArea").classList.remove("hidden");
  $("liveStatus").textContent = "Aula em andamento";
  $("stateStat").textContent = "Ao vivo";
  $("startClass").textContent = "↗ Abrir Quadro";

  watchStudents(currentRoom);
}

async function createTeacher(event) {
  event.preventDefault();

  const button = event.submitter || $("teacherForm").querySelector("button[type='submit']");
  const name = $("teacherName").value.trim();
  const courseName = $("courseName").value.trim();
  const whatsapp = $("teacherWhatsapp").value.trim();
  const file = $("teacherPhoto").files?.[0];

  if (!name || !courseName) {
    alert("Preencha o nome do professor e o nome do curso.");
    return;
  }

  button.disabled = true;
  button.textContent = "A criar quadro...";

  try {
    const photo = await imageToDataURL(file);
    const teacherRef = push(ref(db, "teachers"));
    teacherId = teacherRef.key;

    await set(teacherRef, {
      name,
      courseName,
      whatsapp,
      photo,
      createdAt: Date.now(),
      active: true
    });

    localStorage.setItem("qaz_teacher_id", teacherId);
    showTeacher({ name, courseName, whatsapp, photo });
  } catch (error) {
    console.error(error);
    alert(error?.message || "Não foi possível criar o quadro.");
    button.disabled = false;
    button.textContent = "Criar / Abrir meu quadro";
  }
}

$("teacherPhoto")?.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  const preview = $("photoPreview");
  const image = $("photoPreviewImg");

  if (!file) {
    preview.classList.add("hidden");
    return;
  }

  if (!file.type.startsWith("image/")) {
    alert("Selecione uma imagem válida.");
    event.target.value = "";
    preview.classList.add("hidden");
    return;
  }

  image.src = URL.createObjectURL(file);
  preview.classList.remove("hidden");
});

$("teacherForm")?.addEventListener("submit", createTeacher);

$("startClass")?.addEventListener("click", startClass);

$("copyLink")?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("classLink").value);
    $("copyLink").textContent = "Copiado ✓";
    setTimeout(() => $("copyLink").textContent = "Copiar link", 1500);
  } catch {
    $("classLink").select();
    document.execCommand("copy");
  }
});

$("waLink")?.addEventListener("click", () => {
  const text = "Entre na minha aula: " + $("classLink").value;
  window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank");
});

if (teacherId) {
  onValue(ref(db, "teachers/" + teacherId), (snapshot) => {
    if (snapshot.exists()) {
      showTeacher(snapshot.val());
    } else {
      teacherId = null;
      localStorage.removeItem("qaz_teacher_id");
    }
  });

  onValue(ref(db, "classes"), (snapshot) => {
    const all = snapshot.val() || {};
    const mine = Object.values(all).filter(item => item.teacherId === teacherId);
    $("classCount").textContent = mine.length;
  });
}