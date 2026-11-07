const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onValueWritten } = require("firebase-functions/v2/database");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase, ServerValue } = require("firebase-admin/database");

initializeApp();
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
  return { ok: true, plan: String(license.plan || "") };
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
  if (!roomId || !sessionId || !requestId || /[.#$\\[\\]\\/]/.test(sessionId + requestId)) {
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
