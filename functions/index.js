const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onValueWritten } = require("firebase-functions/v2/database");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase, ServerValue } = require("firebase-admin/database");
const { defineString } = require("firebase-functions/params");
const ADMIN_EMAILS = defineString("ADMIN_EMAILS", { default: "" });

initializeApp({ projectId: 'remot-board', databaseURL: 'https://remote-board-default-rtdb.firebaseio.com' });
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
  const configured = ADMIN_EMAILS.value().split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
  const email = String(request.auth?.token?.email || "").trim().toLowerCase();
  if (request.auth?.token?.admin !== true && (!email || !configured.includes(email))) {
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
  if (license.plan === "trial" && (license.trialExhausted === true || used >= 4)) {
    throw new HttpsError("permission-denied", "O período de teste terminou.");
  }
  await db.ref("roomAccess/" + roomId + "/" + uid).set({
    role: "teacher", status: "approved", verifiedAt: ServerValue.TIMESTAMP
  });
  return { ok: true, plan: String(license.plan || ""), teacherName: String(license.teacherName || license.name || license.fullName || license.nome || "Professor") };
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
    lic.trialSessionsLimit = 4;
    lic.trialSessionsUsed = used;
    if (used >= 4) {
      lic.trialExhausted = true;
      lic.boardAccess = false;
      lic.trialCompletedAt = new Date().toISOString();
    }
    return lic;
  });
  const lic = tx.snapshot.val() || {};
  return { trial: lic.plan === "trial",
    exhausted: lic.plan === "trial" && (lic.trialExhausted === true || Number(lic.trialSessionsUsed || 0) >= 4),
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
  const uid = requireAuth(request);
  const email = String(request.auth.token.email || "").trim().toLowerCase();
  const requestId = String(request.data?.requestId || "");
  if (!email || !requestId || requestId.length > 180) {
    throw new HttpsError("invalid-argument", "Pedido ou conta inválida.");
  }
  const requestsRef = db.ref("paymentRequests");
  const snap = await requestsRef.get();
  const requests = paymentObject(snap.val());
  const list = Object.values(requests);
  const approved = requests[requestId] || list.find(item => item && String(item.id || "") === requestId);
  if (!approved || approved.status !== "approved" ||
      String(approved.email || approved.teacherEmail || "").trim().toLowerCase() !== email) {
    throw new HttpsError("permission-denied", "A administração ainda não aprovou este pedido para esta conta.");
  }
  const plans = {
    basic: { name: "Básico", students: 10, dailyClasses: 2, simultaneous: 1, duration: 2, storage: "10 GB temporários" },
    professional: { name: "Profissional", students: 45, dailyClasses: 3, simultaneous: 2, duration: 4, storage: "50 GB temporários" },
    school: { name: "Escola", students: 50, dailyClasses: 3, simultaneous: 5, duration: 6, storage: "100 GB temporários" },
    trial: { name: "Teste — 4 aulas", students: 45, dailyClasses: 3, simultaneous: 1, duration: 4, storage: "Temporário" }
  };
  const planKey = String(approved.plan || "");
  const plan = plans[planKey];
  if (!plan) throw new HttpsError("failed-precondition", "O plano aprovado não é válido.");
  const token = String(approved.accessToken || approved.existingAccessToken || "").trim() ||
    require("crypto").randomUUID();
  const licenseRef = db.ref("licenses/" + token);
  const priorSnap = await licenseRef.get();
  const prior = priorSnap.val() || {};
  const completed = prior.trialCompletedSessions || {};
  const used = Object.keys(completed).length;
  const exhausted = planKey === "trial" && used >= 4;
  const license = {
    status: "active", trialExhausted: exhausted, boardAccess: !exhausted,
    plan: planKey, planName: String(approved.planName || plan.name),
    ...plan, startedAt: prior.startedAt || approved.approvedAt || new Date().toISOString(),
    expiresAt: approved.expiresAt || null,
    teacherName: String(approved.name || approved.teacherName || email),
    teacherPhone: String(approved.phone || approved.teacherPhone || ""),
    requestId, accessToken: token, teacherEmail: email,
    ...(planKey === "trial" ? { trialSessionsLimit: 4, trialSessionsUsed: used, trialCompletedSessions: completed,
      trialApprovedAt: prior.trialApprovedAt || approved.approvedAt || new Date().toISOString() } : {})
  };
  const updates = {};
  updates["licenses/" + token] = license;
  const oldToken = String(approved.existingAccessToken || "").trim();
  if (oldToken && oldToken !== token) {
    updates["licenses/" + oldToken + "/status"] = "replaced";
    updates["licenses/" + oldToken + "/replacedBy"] = token;
    updates["licenses/" + oldToken + "/replacedAt"] = ServerValue.TIMESTAMP;
  }
  const updatedRequests = list.map(item => item && String(item.id || "") === requestId
    ? { ...item, accessToken: token, activatedAt: ServerValue.TIMESTAMP } : item);
  updates["paymentRequests/" + requestId] = { ...approved, accessToken: token, activatedAt: ServerValue.TIMESTAMP };
  await db.ref().update(updates);
  return { ok: true, accessToken: token, plan: planKey, teacherName: license.teacherName };
});

function safeEmail(value) { return String(value || "").trim().toLowerCase(); }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\\.[^\s@]+$/.test(value); }
function paymentObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }

exports.createPaymentRequest = onCall({ region: REGION, maxInstances: 10 }, async (request) => {
  const uid = requireAuth(request);
  const email = safeEmail(request.auth.token.email);
  if (!email || !validEmail(email)) {
    throw new HttpsError("failed-precondition", "Entre com um e-mail verificado.");
  }
  const d = request.data || {};
  const name = String(d.name || "").trim();
  const phone = String(d.phone || "").trim();
  const plan = String(d.plan || "");
  const period = String(d.period || "monthly");
  const proof = String(d.proof || "");
  const proofName = String(d.proofName || "comprovativo");
  const proofType = String(d.proofType || "");
  const plans = {
    basic: { monthly: 10000, annual: 60000 },
    professional: { monthly: 20000, annual: 60000 },
    school: { monthly: 30000, annual: 100000 }
  };
  if (!name || name.length > 120 || !phone || phone.length > 40 || !plans[plan] ||
      !["monthly", "annual"].includes(period) || !proof.startsWith("data:") ||
      proof.length > 5_600_000 || !/^data:(image\/(png|jpeg|webp)|application\/pdf);base64,/.test(proof)) {
    throw new HttpsError("invalid-argument", "Dados do pedido ou comprovativo inválidos.");
  }
  const months = period === "annual" ? 12 : Math.max(1, Math.min(12, Number(d.months) || 1));
  const amount = period === "annual" ? plans[plan].annual : plans[plan].monthly * months;
  const requestsRef = db.ref("paymentRequests");
  const snap = await requestsRef.get();
  const current = paymentObject(snap.val());
  const duplicate = Object.values(current).find(x => x && safeEmail(x.email) === email &&
    (x.status === "pending" || (x.status === "approved" && x.plan !== "trial")));
  if (duplicate) return { ok: true, existing: true, request: { id: duplicate.id, status: duplicate.status, plan: duplicate.plan, planName: duplicate.planName, createdAt: duplicate.createdAt } };
  const id = "PAY-" + require("crypto").randomUUID();
  const item = {
    id, uid, name, email, phone, authProvider: String(d.authProvider || "email").slice(0,40),
    existingAccessToken: String(d.existingAccessToken || "").slice(0,180),
    plan, planName: ({basic:"Básico",professional:"Profissional",school:"Escola"})[plan],
    period, months, amount, method: String(d.method || "").slice(0,50),
    proof, proofName: proofName.slice(0,180), proofType: proofType.slice(0,100),
    status: "pending", createdAt: new Date().toISOString()
  };
  await requestsRef.child(id).set(item);
  return { ok: true, existing: false, request: { id, status: "pending", plan, planName: item.planName, createdAt: item.createdAt } };
});

exports.createTrialRequest = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const email = safeEmail(request.auth.token.email);
  if (!email || !validEmail(email)) throw new HttpsError("failed-precondition", "Conta autenticada com e-mail obrigatório.");
  const name = String(request.data?.name || "").trim();
  const phone = String(request.data?.phone || "").trim();
  if (!name || name.length > 120 || !phone || phone.length > 40) throw new HttpsError("invalid-argument", "Dados incompletos.");
  const ref = db.ref("paymentRequests");
  const snap = await ref.get();
  const current = paymentObject(snap.val());
  const duplicate = Object.values(current).find(x => x && safeEmail(x.email) === email && x.status !== "rejected");
  if (duplicate) return { ok: true, existing: true, request: { id: duplicate.id, status: duplicate.status, plan: duplicate.plan, planName: duplicate.planName } };
  const id = "TRIAL-" + require("crypto").randomUUID();
  const item = { id, uid, name, email, phone, authProvider: "email", requestType: "trial", plan: "trial", planName: "Plano de teste — 4 aulas", trialSessionsLimit: 4, trialSessionsUsed: 0, amount: 0, method: "Plano de teste", status: "pending", createdAt: new Date().toISOString() };
  await ref.child(id).set(item);
  return { ok: true, existing: false, request: { id, status: "pending", plan: "trial", planName: item.planName } };
});

exports.getMyPaymentRequests = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const email = safeEmail(request.auth.token.email);
  if (!email) throw new HttpsError("failed-precondition", "Conta sem e-mail.");
  const snap = await db.ref("paymentRequests").get();
  const all = paymentObject(snap.val());
  const items = Object.values(all).filter(x => x && (x.uid === uid || safeEmail(x.email) === email))
    .sort((a,b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .map(({ proof, ...item }) => item);
  return { requests: items };
});

exports.adminListPaymentRequests = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const snap = await db.ref("paymentRequests").get();
  const requests = Object.values(paymentObject(snap.val()))
    .sort((a,b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .map(({ proof, ...item }) => item);
  return { requests };
});

exports.adminGetPaymentProof = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const id = String(request.data?.requestId || "");
  if (!id || id.length > 180 || /[.#$\\[\\]\/]/.test(id)) {
    throw new HttpsError("invalid-argument", "Pedido inválido.");
  }
  const snap = await db.ref("paymentRequests/" + id).get();
  const item = snap.val();
  if (!item || typeof item.proof !== "string" || !item.proof.startsWith("data:")) {
    throw new HttpsError("not-found", "Comprovativo não encontrado.");
  }
  return { proof: item.proof, proofName: String(item.proofName || "comprovativo"), proofType: String(item.proofType || "") };
});

exports.adminSetPaymentStatus = onCall({ region: REGION }, async (request) => {
  const adminUid = requireAdmin(request);
  const id = String(request.data?.requestId || "");
  const status = String(request.data?.status || "");
  const note = String(request.data?.note || "").slice(0,1000);
  if (!id || id.length > 180 || !["approved","rejected"].includes(status)) throw new HttpsError("invalid-argument", "Decisão inválida.");
  const ref = db.ref("paymentRequests/" + id);
  let updated;
  const tx = await ref.transaction(current => {
    if (!current || !["pending","rejected"].includes(current.status)) return;
    updated = { ...current, status, adminNote: note, approvedBy: adminUid, approvedAt: status === "approved" ? new Date().toISOString() : null, reviewedAt: ServerValue.TIMESTAMP };
    return updated;
  });
  if (!tx.committed) throw new HttpsError("failed-precondition", "Pedido inexistente ou já processado.");
  await db.ref("auditLogs").push({ action: "payment_" + status, requestId: id, adminUid, at: ServerValue.TIMESTAMP });
  return { ok: true, requestId: id, status };
});

exports.submitFeedback = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const message = String(request.data?.message || "").trim();
  if (message.length < 3 || message.length > 5000) throw new HttpsError("invalid-argument", "Mensagem inválida.");
  const ref = db.ref("feedback").push();
  await ref.set({ uid, message, createdAt: ServerValue.TIMESTAMP, status: "new" });
  return { ok: true, id: ref.key };
});
