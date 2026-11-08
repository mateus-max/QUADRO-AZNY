const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onValueWritten } = require("firebase-functions/v2/database");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase, ServerValue } = require("firebase-admin/database");
const { defineString } = require("firebase-functions/params");
const ADMIN_EMAIL = "suporte@domingas.com";

initializeApp({ projectId: 'remot-board', databaseURL: 'https://remot-board-default-rtdb.firebaseio.com', storageBucket: 'remot-board.firebasestorage.app' });
const db = getDatabase();
const REGION = "us-central1";

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
function requireAdmin(request) {
  const uid = requireAuth(request);
  const email = String(request.auth?.token?.email || "").trim().toLowerCase();
  if (request.auth?.token?.admin !== true && email !== ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", "Acesso reservado à administração.");
  }
  return uid;
}
function teacherRoomAllowed(roomId, token) {
  const scope = hashKey(token);
  return roomId === "AZNY-TEACHER-" + scope || roomId.startsWith("AZNY-" + scope + "-");
}

exports.verifyTeacherAccess = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const token = String(request.data?.accessToken || "");
  const roomId = cleanKey(request.data?.roomId);
  if (!token || !roomId || !teacherRoomAllowed(roomId, token)) {
    throw new HttpsError("permission-denied", "Licença ou sala inválida.");
  }
  const licenseSnap = await db.ref("licenses/" + token).get();
  const license = licenseSnap.val();
  if (!license || license.status !== "active" ||
      (license.expiresAt && new Date(license.expiresAt).getTime() <= Date.now())) {
    throw new HttpsError("permission-denied", "Licença inativa ou expirada.");
  }
  const used = Number(license.trialSessionsUsed ||
    Object.keys(license.trialCompletedSessions || {}).length);
  if (license.plan === "trial" && (license.trialExhausted === true || used >= 2)) {
    throw new HttpsError("permission-denied", "O período de teste terminou.");
  }
  await db.ref("roomAccess/" + roomId + "/" + uid).set({
    role: "teacher", status: "approved", verifiedAt: ServerValue.TIMESTAMP
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
  if (access.val()?.role !== "teacher" || access.val()?.status !== "approved" ||
      !/^[A-Z0-9]{7}$/.test(code) || !target.startsWith("https://")) {
    throw new HttpsError("permission-denied", "Não foi possível criar o link.");
  }
  const ref = db.ref("aznyShortLinks/" + code);
  const result = await ref.transaction(current => current || {
    target, type: "class", createdAt: ServerValue.TIMESTAMP
  });
  const value = result.snapshot.val();
  if (!value || value.target !== target) throw new HttpsError("already-exists", "Código curto em conflito.");
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
    trial: { name: "Teste — 4 aulas", students: 45, dailyClasses: 3, simultaneous: 1, duration: 4, storage: "Temporário" }
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
  const license = {
    status: "active", trialExhausted: exhausted, boardAccess: !exhausted,
    plan: planKey, planName: String(approved.planName || plan.name),
    ...plan, startedAt: prior.startedAt || approved.approvedAt || now,
    expiresAt: approved.expiresAt || null,
    teacherName: String(approved.name || approved.teacherName || email),
    teacherPhone: String(approved.phone || approved.teacherPhone || ""),
    requestId, accessToken: token, teacherEmail: email,
    ...(planKey === "trial" ? {
      trialSessionsLimit: 4, trialSessionsUsed: used,
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
      planName: "Plano de teste — 4 aulas",
      trialSessionsLimit: 4, trialSessionsUsed: 0,
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
