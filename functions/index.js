const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onValueWritten, onValueCreated } = require("firebase-functions/v2/database");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase, ServerValue } = require("firebase-admin/database");
const { getAuth } = require("firebase-admin/auth");
const { defineString } = require("firebase-functions/params");
const ADMIN_EMAIL = "suporte@domingas.com";

initializeApp({ projectId: 'remot-board', databaseURL: 'https://remot-board-default-rtdb.firebaseio.com', storageBucket: 'remot-board.firebasestorage.app' });
const db = getDatabase();
const REGION = "us-central1";


const adminAuth = getAuth();

const FORMSPREE_NOTIFICATION_ENDPOINT = "https://formspree.io/f/xdeeykja";
async function sendDirectionWhatsAppNotification(eventName, fields = {}) {
  const payload = {
    _subject: "[QUADRO AZNY] " + eventName,
    evento: eventName,
    plataforma: "Quadro AZNY",
    data: new Date().toLocaleString("pt-AO", { timeZone: "Africa/Luanda" }),
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && value !== ""))
  };
  const response = await fetch(FORMSPREE_NOTIFICATION_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error("Formspree HTTP " + response.status + ": " + detail.slice(0, 300));
  }
  return true;
}

// Aviso adicional: não altera nem substitui os registos existentes no Realtime Database.
exports.notifyDirectionNewTeacherRegistration = onValueCreated({
  ref: "/teacherRegistrationRequests/{uid}", region: REGION, retry: true
}, async event => {
  const teacher = event.data.val() || {};
  await sendDirectionWhatsAppNotification("NOVA CONTA DE PROFESSOR — AGUARDA APROVAÇÃO", {
    nome_professor: teacher.name || "Não informado",
    email_professor: teacher.email || "Não informado",
    estado: "Pendente de aprovação",
    uid: event.params.uid
  });
});

exports.notifyDirectionNewPlanRequest = onValueCreated({
  ref: "/paymentRequests/{requestId}", region: REGION, retry: true
}, async event => {
  const request = event.data.val() || {};
  await sendDirectionWhatsAppNotification(
    request.plan === "trial" ? "NOVO PEDIDO DE TESTE — AGUARDA APROVAÇÃO" : "NOVO PEDIDO DE PLANO/PAGAMENTO — AGUARDA APROVAÇÃO",
    {
      nome_professor: request.name || "Não informado",
      email_professor: request.email || "Não informado",
      plano: request.planName || request.plan || "Não informado",
      valor: Number(request.amount || 0).toLocaleString("pt-AO") + " Kz",
      metodo_pagamento: request.method || "Não informado",
      pedido: request.id || event.params.requestId,
      estado: "Pendente de análise"
    }
  );
});

exports.registerTeacherForApproval = onCall({region:REGION},async request=>{
 if(request.auth?.uid)throw new HttpsError("failed-precondition","Termine a sessão antes de submeter um novo registo.");
 const name=String(request.data?.name||"").trim(),email=safeEmail(request.data?.email),password=String(request.data?.password||"");
 if(name.length<3||name.length>120||!validEmail(email)||password.length<8||password.length>128)throw new HttpsError("invalid-argument","Informe nome, e-mail válido e senha com pelo menos 8 caracteres.");
 let created;
 try{
  created=await adminAuth.createUser({email,password,displayName:name,disabled:true,emailVerified:false});
  const now=new Date().toISOString(),record={uid:created.uid,name,email,role:"teacher",status:"pending",accountStatus:"pending",createdAt:now,updatedAt:now},updates={};
  updates["teacherRegistrationRequests/"+created.uid]=record;updates["teacherAccounts/"+created.uid]=record;await db.ref().update(updates);
  return {ok:true,uid:created.uid,status:"pending",message:"Pedido enviado à direcção. A conta ficará bloqueada até à aprovação."};
 }catch(error){if(created?.uid)await adminAuth.deleteUser(created.uid).catch(()=>{});if(error instanceof HttpsError)throw error;if(error.code==="auth/email-already-exists")throw new HttpsError("already-exists","Este e-mail já possui uma conta. Utilize Entrar ou contacte a administração.");console.error("registerTeacherForApproval",error);throw new HttpsError("internal","Não foi possível enviar o pedido de criação de conta.");}
});

exports.reviewTeacherPayment = onCall({region:REGION}, async request => {
  const adminUid = await requireAdmin(request);
  const id = String(request.data?.id || "");
  const action = String(request.data?.action || "");
  const note = String(request.data?.note || "").trim().slice(0,500);
  if (!/^PAY-[A-Za-z0-9_-]{1,120}$/.test(id) || !["approve","reject"].includes(action) || (action === "reject" && !note)) {
    throw new HttpsError("invalid-argument", action === "reject" && !note ? "Informe o motivo da rejeição." : "Pedido ou operação inválida.");
  }
  const ref = db.ref("paymentRequests/" + id);
  const claim = await ref.transaction(value => {
    if (!value || value.status !== "pending") return;
    return {...value, status:"processing"};
  });
  if (!claim.committed) throw new HttpsError("failed-precondition","Este pedido já foi tratado ou não está pendente.");
  const item = claim.snapshot.val();
  try {
    const uid = String(item.uid || "");
    const email = safeEmail(item.email);
    if (!uid || !validEmail(email)) throw new HttpsError("failed-precondition","O pedido não contém uma conta de professor válida.");
    const accountRef = db.ref("teacherAccounts/" + uid);
    const registrationRef = db.ref("teacherRegistrationRequests/" + uid);
    const now = new Date().toISOString();
    const updates = {};
    if (action === "approve") {
      const plans = {
        trial:{name:"Teste experimental — 2 aulas",students:45,dailyClasses:3,simultaneous:1,duration:2,storage:"Temporário",trialSessionsLimit:2},
        basic:{name:"Básico",students:10,dailyClasses:2,simultaneous:1,duration:2,storage:"10 GB temporários"},
        professional:{name:"Profissional",students:45,dailyClasses:3,simultaneous:2,duration:4,storage:"50 GB temporários"},
        school:{name:"Escola",students:50,dailyClasses:3,simultaneous:5,duration:6,storage:"100 GB temporários"}
      };
      const planKey = String(item.plan || "");
      const plan = plans[planKey];
      if (!plan) throw new HttpsError("failed-precondition","Plano não reconhecido: " + planKey);
      const paidMonths = planKey === "trial" ? 0 : (item.period === "annual" || Number(item.months) >= 12 ? 12 : Math.max(1, Number(item.months) || 1));
      const expiryDate = new Date(now);
      if (paidMonths) expiryDate.setMonth(expiryDate.getMonth() + paidMonths);
      const expiresAt = paidMonths ? expiryDate.toISOString() : null;
      const user = await adminAuth.getUser(uid);
      if (user.email?.toLowerCase() !== email) throw new HttpsError("failed-precondition","O e-mail do pedido não corresponde à conta registada.");
      await adminAuth.updateUser(uid,{disabled:false});
      const token = String(item.accessToken || item.existingAccessToken || "").trim() || require("crypto").randomUUID();
      const license = {
        status:"active",trialExhausted:false,boardAccess:true,plan:planKey,
        planName:String(item.planName || plan.name),...plan,
        ...(planKey==="trial"?{trialSessionsLimit:2,trialSessionsUsed:0,trialCompletedSessions:{}}:{}),
        startedAt:now,expiresAt,teacherName:String(item.name || email),
        teacherPhone:String(item.phone || ""),requestId:id,accessToken:token,teacherEmail:email,teacherUid:uid
      };
      updates["licenses/"+token]=license;
      updates["teacherAccounts/"+uid]={uid,name:String(item.name||email),email,role:"teacher",status:"approved",accountStatus:"active",plan:planKey,planName:license.planName,accessToken:token,approvedBy:adminUid,approvedAt:now,activatedAt:ServerValue.TIMESTAMP,updatedAt:ServerValue.TIMESTAMP};
      updates["teacherRegistrationRequests/"+uid]={uid,name:String(item.name||email),email,role:"teacher",status:"approved",accountStatus:"active",approvedBy:adminUid,approvedAt:now,updatedAt:ServerValue.TIMESTAMP};
      updates["paymentRequests/"+id]={...item,status:"approved",accountStatus:"active",accessGranted:true,accessToken:token,expiresAt,approvedBy:adminUid,approvedAt:now,activatedAt:ServerValue.TIMESTAMP,reviewedAt:ServerValue.TIMESTAMP};
    } else {
      updates["paymentRequests/"+id]={...item,status:"rejected",accountStatus:"rejected",accessGranted:false,adminNote:note,rejectedBy:adminUid,rejectedAt:now,reviewedAt:ServerValue.TIMESTAMP};
      const token=String(item.accessToken||item.existingAccessToken||"").trim();
      if(token){updates["licenses/"+token+"/status"]="suspended";updates["licenses/"+token+"/boardAccess"]=false;}
    }
    updates["auditLogs/"+db.ref("auditLogs").push().key]={action:"payment_"+action,requestId:id,adminUid,at:ServerValue.TIMESTAMP};
    await db.ref().update(updates);
    return {ok:true,action,id};
  } catch(error) {
    await ref.child("status").set("pending").catch(()=>{});
    if(error instanceof HttpsError) throw error;
    console.error("reviewTeacherPayment",error);
    throw new HttpsError("internal","Falha ao aplicar a decisão no Firebase: "+String(error.message||error).slice(0,180));
  }
});

exports.reviewTeacherRegistration = onCall({region:REGION},async request=>{
 const adminUid=await requireAdmin(request),uid=String(request.data?.uid||""),action=String(request.data?.action||""),note=String(request.data?.note||"").trim().slice(0,500);
 if(!uid||uid.length>128||!["approve","reject","delete"].includes(action)||(action==="reject"&&!note))throw new HttpsError("invalid-argument",action==="reject"&&!note?"Informe o motivo da rejeição.":"Operação ou conta inválida.");
 const userRef=db.ref("teacherAccounts/"+uid),regRef=db.ref("teacherRegistrationRequests/"+uid),[profile,registration]=await Promise.all([userRef.get(),regRef.get()]);
 if(!profile.exists()&&!registration.exists())throw new HttpsError("not-found","Conta não encontrada.");
 if(action==="delete"){
  await adminAuth.deleteUser(uid).catch(e=>{if(e.code!=="auth/user-not-found")throw e;});
  const updates={};updates["teacherAccounts/"+uid]=null;updates["teacherRegistrationRequests/"+uid]=null;
  const payments=await db.ref("paymentRequests").orderByChild("uid").equalTo(uid).get();payments.forEach(child=>updates["paymentRequests/"+child.key]=null);
  const email=safeEmail(profile.val()?.email||registration.val()?.email);if(email){const licenses=await db.ref("licenses").orderByChild("teacherEmail").equalTo(email).get();licenses.forEach(child=>{updates["licenses/"+child.key+"/status"]="revoked";updates["licenses/"+child.key+"/boardAccess"]=false;updates["licenses/"+child.key+"/revokedAt"]=ServerValue.TIMESTAMP;updates["licenses/"+child.key+"/revokedBy"]=adminUid;});}
  const token=String(profile.val()?.accessToken||registration.val()?.accessToken||"");if(token){updates["licenses/"+token+"/status"]="revoked";updates["licenses/"+token+"/boardAccess"]=false;}
  await db.ref().update(updates);await db.ref("auditLogs").push({action:"teacher_account_deleted",targetUid:uid,adminUid,at:ServerValue.TIMESTAMP});return {ok:true,action};
 }
 if(action==="approve"){await adminAuth.updateUser(uid,{disabled:false});const patch={status:"approved",accountStatus:"approved",approvedBy:adminUid,approvedAt:new Date().toISOString(),updatedAt:ServerValue.TIMESTAMP};await Promise.all([userRef.update(patch),regRef.update(patch)]);}
 else{await adminAuth.updateUser(uid,{disabled:false});const patch={status:"rejected",accountStatus:"rejected",adminNote:note,rejectedBy:adminUid,rejectedAt:new Date().toISOString(),updatedAt:ServerValue.TIMESTAMP};await Promise.all([userRef.update(patch),regRef.update(patch)]);}
 await db.ref("auditLogs").push({action:"teacher_account_"+action,targetUid:uid,adminUid,note,at:ServerValue.TIMESTAMP});return {ok:true,action};
});

function hashKey(value) {
  let h = 2166136261;
  for (const ch of String(value || "")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
function cleanKey(value) {
  return String(value || "").replace(/[.#$\[\]\/]/g, "_");
}
function requireAuth(request) {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Autenticação necessária.");
  return request.auth.uid;
}
async function requireAdmin(request) {
  const uid = requireAuth(request);
  const email = String(request.auth?.token?.email || "").trim().toLowerCase();
  if (request.auth?.token?.admin === true || email === ADMIN_EMAIL) return uid;
  try {
    const account = await adminAuth.getUser(uid);
    if (safeEmail(account.email) === ADMIN_EMAIL && !account.disabled) return uid;
  } catch (error) {
    console.error("Falha ao validar conta administrativa:", error?.code || error?.message);
  }
  throw new HttpsError("permission-denied", "Acesso reservado à administração.");
}
function teacherRoomAllowed(roomId, token) {
  const scope = hashKey(token);
  return roomId === "AZNY-TEACHER-" + scope || roomId.startsWith("AZNY-" + scope + "-");
}

exports.verifyTeacherAccess = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const token = String(request.data?.accessToken || "").trim();
  const roomId = cleanKey(request.data?.roomId);
  if (!token || !roomId || !teacherRoomAllowed(roomId, token)) {
    throw new HttpsError("permission-denied", "Licença ou sala inválida.");
  }
  const licenseSnap = await db.ref("licenses/" + token).get();
  const license = licenseSnap.val();
  const email = String(request.auth?.token?.email || "").trim().toLowerCase();
  if (!license || license.status !== "active" || license.boardAccess === false) {
    throw new HttpsError("permission-denied", "A licença não está activa ou o acesso ao quadro foi suspenso.");
  }
  if (license.teacherUid && String(license.teacherUid) !== uid) {
    throw new HttpsError("permission-denied", "Esta licença pertence a outra conta de professor.");
  }
  if (license.teacherEmail && email && String(license.teacherEmail).trim().toLowerCase() !== email) {
    throw new HttpsError("permission-denied", "O e-mail autenticado não corresponde à licença.");
  }
  if (license.expiresAt) {
    const expiry = new Date(license.expiresAt).getTime();
    if (!Number.isFinite(expiry) || expiry <= Date.now()) {
      throw new HttpsError("permission-denied", "A licença está expirada ou tem uma data de validade inválida.");
    }
  }
  const used = Number(license.trialSessionsUsed || Object.keys(license.trialCompletedSessions || {}).length);
  if (license.plan === "trial" && (license.trialExhausted === true || used >= Number(license.trialSessionsLimit || 2))) {
    throw new HttpsError("permission-denied", "O período de teste terminou.");
  }
  await db.ref("roomAccess/" + roomId + "/" + uid).set({
    role: "teacher", status: "approved", licenseToken: token,
    plan: String(license.plan || ""), verifiedAt: ServerValue.TIMESTAMP
  });
  return { ok: true, plan: String(license.plan || ""), teacherName: String(license.teacherName || license.name || license.fullName || license.nome || "Professor") };
});

exports.createIsolatedGuestRoom = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const provider = request.auth?.token?.firebase?.sign_in_provider || "";
  if (provider !== "anonymous") {
    throw new HttpsError("permission-denied", "O acesso temporário exige uma sessão anónima do Firebase.");
  }
  const roomId = String(request.data?.roomId || "");
  if (!/^AZNY-GUEST-[a-f0-9]{32}$/.test(roomId)) {
    throw new HttpsError("invalid-argument", "Identificador da sala temporária inválido.");
  }
  const guestRef = db.ref("guestRooms/" + roomId);
  const tx = await guestRef.transaction(current => {
    if (current && current.ownerUid !== uid) return;
    return current || { ownerUid: uid, createdAt: ServerValue.TIMESTAMP, type: "isolated" };
  });
  const guest = tx.snapshot.val();
  if (!guest || guest.ownerUid !== uid) {
    throw new HttpsError("already-exists", "Esta sala temporária já pertence a outra sessão.");
  }
  await db.ref("roomAccess/" + roomId + "/" + uid).set({
    role: "teacher", status: "approved", guest: true, verifiedAt: ServerValue.TIMESTAMP
  });
  return { ok: true, roomId };
});

exports.recordTrialClass = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const token = String(request.data?.accessToken || "");
  const roomId = cleanKey(request.data?.roomId);
  const runId = String(request.data?.runId || "");
  if (!token || !roomId || !runId || runId.length > 160 ||
      !teacherRoomAllowed(roomId, token)) {
    throw new HttpsError("invalid-argument", "Dados da aula inválidos.");
  }
  const access = await db.ref("roomAccess/" + roomId + "/" + uid).get();
  if (access.val()?.role !== "teacher" || access.val()?.status !== "approved") {
    throw new HttpsError("permission-denied", "Apenas o professor autorizado pode registar a aula.");
  }
  const ref = db.ref("licenses/" + token);
  const tx = await ref.transaction((lic) => {
    if (!lic || lic.plan !== "trial" || lic.status !== "active") return lic;
    const completed = lic.trialCompletedSessions && typeof lic.trialCompletedSessions === "object"
      ? lic.trialCompletedSessions : {};
    if (!completed[runId]) completed[runId] = Date.now();
    const used = Object.keys(completed).length;
    lic.trialCompletedSessions = completed;
    lic.trialSessionsLimit = 2;
    lic.trialSessionsUsed = used;
    if (used >= 2) {
      lic.trialExhausted = true;
      lic.boardAccess = false;
      lic.trialCompletedAt = new Date().toISOString();
    }
    return lic;
  });
  const lic = tx.snapshot.val() || {};
  return { trial: lic.plan === "trial",
    exhausted: lic.plan === "trial" && (lic.trialExhausted === true || Number(lic.trialSessionsUsed || 0) >= 2),
    used: Number(lic.trialSessionsUsed || 0) };
});

exports.createClassShortLink = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const roomId = cleanKey(request.data?.roomId);
  const code = String(request.data?.code || "").toUpperCase();
  const target = String(request.data?.target || "");
  const access = await db.ref("roomAccess/" + roomId + "/" + uid).get();
  if (access.val()?.role !== "teacher" || access.val()?.status !== "approved") {
    throw new HttpsError("permission-denied", "O professor ainda não tem autorização para esta sala.");
  }
  if (!/^[A-Z0-9]{7}$/.test(code) || !target.startsWith("https://")) {
    throw new HttpsError("invalid-argument", "Código ou endereço do convite inválido.");
  }
  const sessionId = "ROOM-" + roomId;
  const sessionRef = db.ref("aznyRooms/" + roomId + "/sessions/" + sessionId);
  const [statusSnap, teacherSnap] = await Promise.all([
    sessionRef.child("status").get(), sessionRef.child("teacherUid").get()
  ]);
  if (statusSnap.val() !== "active" || String(teacherSnap.val() || "") !== uid) {
    throw new HttpsError("failed-precondition", "Inicie a aula antes de gerar o link de convite.");
  }
  const ref = db.ref("aznyShortLinks/" + code);
  const result = await ref.transaction(current => current || {
    target, type: "class", roomId, sessionId, createdBy: uid, createdAt: ServerValue.TIMESTAMP
  });
  const value = result.snapshot.val();
  if (!value || value.target !== target || value.createdBy && value.createdBy !== uid) {
    throw new HttpsError("already-exists", "Código curto em conflito.");
  }
  return { code, target: value.target };
});

exports.grantApprovedStudentRoomAccess = onValueWritten({
  ref: "/aznyRooms/{room}/sessions/{session}/joinRequests/{requestId}",
  region: REGION
}, async (event) => {
  const after = event.data.after.val();
  const before = event.data.before.val();
  if (!after || after.status !== "approved" || before?.status === "approved") return;
  const uid = String(after.studentUid || "");
  const teacherUid = String(after.teacherUid || "");
  if (!uid || !teacherUid) return;
  const roomId = cleanKey(event.params.room);
  const teacher = await db.ref("roomAccess/" + roomId + "/" + teacherUid).get();
  if (teacher.val()?.role !== "teacher" || teacher.val()?.status !== "approved") return;
  await db.ref("roomAccess/" + roomId + "/" + uid).set({
    role: "student", status: "approved", requestId: event.params.requestId,
    sessionId: event.params.session, approvedBy: teacherUid,
    approvedAt: ServerValue.TIMESTAMP
  });
});

exports.approveStudentRequest = onCall({ region: REGION }, async (request) => {
  const teacherUid = requireAuth(request);
  const roomId = cleanKey(request.data?.roomId);
  const sessionId = String(request.data?.sessionId || "");
  const requestId = String(request.data?.requestId || "");
  if (!roomId || !sessionId || !requestId || [".", "#", "$", "[", "]", "/"].some(ch => sessionId.includes(ch) || requestId.includes(ch))) {
    throw new HttpsError("invalid-argument", "Pedido de entrada inválido.");
  }
  const teacher = await db.ref("roomAccess/" + roomId + "/" + teacherUid).get();
  if (teacher.val()?.role !== "teacher" || teacher.val()?.status !== "approved") {
    throw new HttpsError("permission-denied", "Apenas o professor autorizado pode aprovar alunos.");
  }
  const requestRef = db.ref("aznyRooms/" + roomId + "/sessions/" + sessionId + "/joinRequests/" + requestId);
  const requestSnap = await requestRef.get();
  const student = requestSnap.val();
  if (!student?.studentUid || student.status !== "pending") {
    throw new HttpsError("failed-precondition", "O pedido já não está pendente.");
  }
  const studentUid = String(student.studentUid);
  await db.ref("roomAccess/" + roomId + "/" + studentUid).set({
    role: "student", status: "approved", requestId, sessionId,
    approvedBy: teacherUid, approvedAt: ServerValue.TIMESTAMP
  });
  await requestRef.update({ status: "approved", approvedAt: ServerValue.TIMESTAMP, teacherUid });
  return { ok: true };
});

exports.getMyActiveLicense = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const email = String(request.auth.token.email || "").trim().toLowerCase();
  if (!email) throw new HttpsError("failed-precondition", "A conta autenticada não tem e-mail verificado.");
  const snap = await db.ref("licenses").orderByChild("teacherEmail").equalTo(email).get();
  const all = snap.val() || {};
  const now = Date.now();
  const active = Object.values(all).filter(lic =>
    lic && lic.status === "active" &&
    (!lic.expiresAt || new Date(lic.expiresAt).getTime() > now)
  ).sort((a,b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0))[0];
  if (!active) return { found: false };
  return { found: true, license: {
    status: active.status, plan: active.plan, planName: active.planName,
    expiresAt: active.expiresAt || null, teacherName: active.teacherName || "",
    teacherPhone: active.teacherPhone || "", teacherEmail: email,
    accessToken: active.accessToken || "", trialExhausted: active.trialExhausted === true,
    trialSessionsUsed: Number(active.trialSessionsUsed || 0),
    trialCompletedSessions: active.trialCompletedSessions || {},
    requestId: active.requestId || "", startedAt: active.startedAt || null
  }};
});

exports.getLicenseForAccount = onCall({ region: REGION }, async (request) => {
  requireAuth(request);
  const email = String(request.auth.token.email || "").trim().toLowerCase();
  const token = String(request.data?.accessToken || "");
  if (!email || !token) throw new HttpsError("invalid-argument", "Conta ou licença inválida.");
  const snap = await db.ref("licenses/" + token).get();
  const lic = snap.val();
  if (!lic || String(lic.teacherEmail || "").trim().toLowerCase() !== email) {
    throw new HttpsError("permission-denied", "Esta licença não pertence à conta autenticada.");
  }
  return { found: true, license: {
    status: lic.status, plan: lic.plan, planName: lic.planName,
    expiresAt: lic.expiresAt || null, teacherName: lic.teacherName || "",
    teacherPhone: lic.teacherPhone || "", teacherEmail: email,
    accessToken: lic.accessToken || token, trialExhausted: lic.trialExhausted === true,
    trialSessionsUsed: Number(lic.trialSessionsUsed || 0),
    trialCompletedSessions: lic.trialCompletedSessions || {},
    requestId: lic.requestId || "", startedAt: lic.startedAt || null
  }};
});

exports.activateApprovedLicense = onCall({ region: REGION }, async (request) => {
  requireAuth(request);
  const email = safeEmail(request.auth?.token?.email);
  const requestId = String(request.data?.requestId || "");
  if (!email || !requestId || requestId.length > 180) {
    throw new HttpsError("invalid-argument", "Pedido ou conta inválida.");
  }
  const requestSnap = await db.ref("paymentRequests/" + requestId).get();
  const approved = requestSnap.val();
  if (!approved || approved.status !== "approved" ||
      safeEmail(approved.email || approved.teacherEmail) !== email) {
    throw new HttpsError("permission-denied", "A administração ainda não aprovou este pedido para esta conta.");
  }
  return createLicenseForApprovedRequest(approved, requestId);
});
function safeEmail(value) { return String(value || "").trim().toLowerCase(); }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }

// A versão antiga guardava paymentRequests como uma lista. A versão actual usa
// um objecto indexado pelo ID. Esta normalização conserva todos os pedidos antigos.
function paymentObject(value) {
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(item?.id || "LEGACY-" + index), item])
    : Object.entries(value && typeof value === "object" ? value : {});
  const result = {};
  for (const [key, item] of entries) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id || key);
    result[id] = { ...item, id };
  }
  return result;
}
async function loadPaymentRequests() {
  const ref = db.ref("paymentRequests");
  const snap = await ref.get();
  const raw = snap.val();
  const normalized = paymentObject(raw);
  if (Array.isArray(raw)) await ref.set(normalized);
  return normalized;
}

async function createLicenseForApprovedRequest(approved, requestId) {
  const plans = {
    basic: { name: "Básico", students: 10, dailyClasses: 2, simultaneous: 1, duration: 2, storage: "10 GB temporários" },
    professional: { name: "Profissional", students: 45, dailyClasses: 3, simultaneous: 2, duration: 4, storage: "50 GB temporários" },
    school: { name: "Escola", students: 50, dailyClasses: 3, simultaneous: 5, duration: 6, storage: "100 GB temporários" },
    trial: { name: "Teste — 2 aulas", students: 45, dailyClasses: 3, simultaneous: 1, duration: 4, storage: "Temporário" }
  };
  const email = safeEmail(approved.email || approved.teacherEmail);
  const planKey = String(approved.plan || "");
  const plan = plans[planKey];
  if (!email || !plan) throw new HttpsError("failed-precondition", "O pedido aprovado não tem conta ou plano válido.");
  const token = String(approved.accessToken || approved.existingAccessToken || "").trim() || require("crypto").randomUUID();
  const licenseRef = db.ref("licenses/" + token);
  const priorSnap = await licenseRef.get();
  const prior = priorSnap.val() || {};
  const completed = prior.trialCompletedSessions || {};
  const used = Object.keys(completed).length;
  const exhausted = planKey === "trial" && used >= 2;
  const now = new Date().toISOString();
  const subscriptionMonths = planKey === "trial" ? 0 : Math.max(1, Number(approved.months || (approved.period === "annual" ? 12 : 1)));
  const expiryDate = new Date(approved.approvedAt || now);
  if (subscriptionMonths) expiryDate.setMonth(expiryDate.getMonth() + subscriptionMonths);
  const license = {
    status: "active", trialExhausted: exhausted, boardAccess: !exhausted,
    plan: planKey, planName: String(approved.planName || plan.name),
    ...plan, startedAt: approved.approvedAt || now,
    expiresAt: approved.expiresAt || (subscriptionMonths ? expiryDate.toISOString() : null),
    teacherName: String(approved.name || approved.teacherName || email),
    teacherPhone: String(approved.phone || approved.teacherPhone || ""),
    requestId, accessToken: token, teacherEmail: email,
    ...(planKey === "trial" ? {
      trialSessionsLimit: 2, trialSessionsUsed: used,
      trialCompletedSessions: completed,
      trialApprovedAt: prior.trialApprovedAt || approved.approvedAt || now
    } : {})
  };
  const updates = {};
  updates["licenses/" + token] = license;
  if (approved.uid) updates["teacherAccounts/" + String(approved.uid)] = {
    uid: String(approved.uid), name: license.teacherName, email,
    role: "teacher", accountStatus: "active", plan: planKey,
    planName: license.planName, accessToken: token,
    activatedAt: ServerValue.TIMESTAMP, updatedAt: ServerValue.TIMESTAMP
  };
  updates["paymentRequests/" + requestId] = {
    ...approved, status: "approved",
    accountStatus: "active", accessGranted: true,
    accessToken: token,
    activatedAt: approved.activatedAt || ServerValue.TIMESTAMP
  };
  const oldToken = String(approved.existingAccessToken || "").trim();
  if (oldToken && oldToken !== token) {
    updates["licenses/" + oldToken + "/status"] = "replaced";
    updates["licenses/" + oldToken + "/replacedBy"] = token;
    updates["licenses/" + oldToken + "/replacedAt"] = ServerValue.TIMESTAMP;
  }
  await db.ref().update(updates);
  return { ok: true, accessToken: token, plan: planKey, teacherName: license.teacherName };
}

exports.createTrialRequest = onCall({ region: REGION, maxInstances: 10 }, async (request) => {
  const uid = requireAuth(request);
  const email = safeEmail(request.auth?.token?.email);
  if (!email || !validEmail(email)) throw new HttpsError("failed-precondition", "A conta autenticada precisa de um endereço de e-mail válido.");
  const name = String(request.data?.name || "").trim();
  const phone = String(request.data?.phone || "").trim();
  if (!name || name.length > 120 || !phone || phone.length > 40) {
    throw new HttpsError("invalid-argument", "Preencha o nome e o telefone corretamente.");
  }
  try {
    // Chave estável por UID: consultar só este pedido, nunca a árvore inteira
    // paymentRequests, que também contém comprovativos dos planos pagos.
    const id = "TRIAL-" + uid.replace(/[^A-Za-z0-9_-]/g, "_");
    const ref = db.ref("paymentRequests").child(id);
    const priorSnap = await ref.get();
    const prior = priorSnap.val();
    if (prior && prior.status !== "rejected") {
      return { ok: true, existing: true, request: {
        id, status: prior.status, plan: prior.plan, planName: prior.planName,
        createdAt: prior.createdAt
      }};
    }
    const provider = String(request.auth?.token?.firebase?.sign_in_provider || "password");
    const item = {
      id, uid, name, email, phone,
      authProvider: provider === "google.com" ? "google" : "password",
      requestType: "trial", plan: "trial",
      planName: "Plano de teste — 2 aulas",
      trialSessionsLimit: 2, trialSessionsUsed: 0,
      amount: 0, method: "Plano de teste",
      status: "pending", accountStatus: "pending", accessGranted: false,
      createdAt: new Date().toISOString()
    };
    await ref.set(item);
    return { ok: true, existing: false, request: {
      id, status: "pending", plan: "trial", planName: item.planName,
      createdAt: item.createdAt
    }};
  } catch (error) {
    console.error("createTrialRequest failed", {
      uid, email, code: error?.code, message: error?.message, stack: error?.stack
    });
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal",
      "Não foi possível gravar o pedido de teste. A equipa técnica foi informada; tente novamente.",
      { operation: "createTrialRequest", originalCode: String(error?.code || "unknown"),
        originalMessage: String(error?.message || "").slice(0, 300) }
    );
  }
});

exports.getMyPaymentRequests = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const email = safeEmail(request.auth.token.email);
  if (!email) throw new HttpsError("failed-precondition", "Conta sem e-mail.");
  // Consultas indexadas por UID e e-mail. Nunca descarregar todos os pedidos
  // (nem os comprovativos dos outros professores) para mostrar o estado pessoal.
  const [byUid, byEmail] = await Promise.all([
    db.ref("paymentRequests").orderByChild("uid").equalTo(uid).get(),
    db.ref("paymentRequests").orderByChild("email").equalTo(email).get()
  ]);
  const merged = { ...(byUid.val() || {}), ...(byEmail.val() || {}) };
  const items = Object.values(paymentObject(merged))
    .filter(x => x && (x.uid === uid || safeEmail(x.email || x.teacherEmail) === email))
    .sort((a,b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .map(({ proof, ...item }) => item);
  return { requests: items };
});

exports.submitFeedback = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const message = String(request.data?.message || "").trim();
  if (message.length < 3 || message.length > 5000) throw new HttpsError("invalid-argument", "Mensagem inválida.");
  const ref = db.ref("feedback").push();
  await ref.set({ uid, message, createdAt: ServerValue.TIMESTAMP, status: "new" });
  return { ok: true, id: ref.key };
});
