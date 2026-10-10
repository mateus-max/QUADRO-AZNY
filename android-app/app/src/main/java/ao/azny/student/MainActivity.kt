package ao.azny.student

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.database.FirebaseDatabase
import org.webrtc.*
import java.util.UUID

/**
 * Native Android entry point. Screen capture is requested through Android's
 * system consent dialog; it is never started silently.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var root: LinearLayout
    private lateinit var status: TextView
    private lateinit var urlInput: EditText
    private lateinit var nameInput: EditText
    private var webView: WebView? = null
    private var projection: MediaProjection? = null
    private var peer: PeerConnection? = null
    private var factory: PeerConnectionFactory? = null
    private var egl: EglBase? = null
    private var screenCapturer: ScreenCapturerAndroid? = null
    private var screenSource: VideoSource? = null
    private var cameraSource: VideoSource? = null
    private var localAudio: AudioTrack? = null
    private var localCamera: VideoTrack? = null
    private var localScreen: VideoTrack? = null
    private var assessmentId = ""
    private var attemptId = ""
    private var studentName = ""
    private var attemptPath = ""
    private val db by lazy { FirebaseDatabase.getInstance("https://quadro-azny-default-rtdb.firebaseio.com") }

    private val permissionRequest = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        if (results.values.all { it }) requestScreenCapture()
        else setStatus("É necessário autorizar a câmara e o microfone para continuar.")
    }

    private val screenRequest = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode != Activity.RESULT_OK || result.data == null) {
            setStatus("A partilha do ecrã foi cancelada. A avaliação não será iniciada.")
            return@registerForActivityResult
        }
        try {
            projectionIntent = result.data
            ContextCompat.startForegroundService(this, Intent(this, ScreenShareService::class.java))
            startNativeSupervision(result.resultCode, result.data!!)
        } catch (e: Exception) {
            setStatus("Não foi possível iniciar a supervisão: ${e.message ?: "erro desconhecido"}")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        initFirebase()
        buildHome()
        handleIncomingIntent(intent)
    }

    private fun initFirebase() {
        if (FirebaseApp.getApps(this).isNotEmpty()) return
        val options = FirebaseOptions.Builder()
            .setApiKey("AIzaSyB20GNxPQsMRmjF0RpRyQ8rNoNdpcgq13Y")
            .setApplicationId("1:204452366229:web:a6294fee1a6d92e604d89c")
            .setProjectId("quadro-azny")
            .setDatabaseUrl("https://quadro-azny-default-rtdb.firebaseio.com")
            .setStorageBucket("quadro-azny.firebasestorage.app")
            .build()
        FirebaseApp.initializeApp(this, options)
        FirebaseAuth.getInstance().signInAnonymously()
    }

    private fun buildHome() {
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(28, 36, 28, 24)
            setBackgroundColor(0xFFEAF1F8.toInt())
        }
        root.addView(TextView(this).apply {
            text = "AZNY AVALIAÇÕES"
            textSize = 26f
            setTextColor(0xFF0A2038.toInt())
        })
        root.addView(TextView(this).apply {
            text = "Supervisão nativa para avaliações"
            textSize = 16f
            setPadding(0, 8, 0, 20)
        })
        urlInput = EditText(this).apply {
            hint = "Cole o link da avaliação"
            setSingleLine(true)
        }
        nameInput = EditText(this).apply {
            hint = "Nome completo do aluno"
            setSingleLine(true)
        }
        root.addView(urlInput, matchWidth())
        root.addView(nameInput, matchWidth())
        root.addView(Button(this).apply {
            text = "Abrir avaliação e preparar supervisão"
            setOnClickListener { openAssessment(urlInput.text.toString().trim(), nameInput.text.toString().trim()) }
        }, matchWidth())
        status = TextView(this).apply {
            text = "Cole o link recebido do professor. A captura só começa após autorização do Android."
            textSize = 14f
            setPadding(0, 18, 0, 0)
        }
        root.addView(status, matchWidth())
        setContentView(root)
    }

    private fun matchWidth() = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
    ).apply { bottomMargin = 12 }

    private fun handleIncomingIntent(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme == "azny" && uri.host == "exam") {
            val link = uri.getQueryParameter("url").orEmpty()
            urlInput.setText(link)
            nameInput.setText(uri.getQueryParameter("name").orEmpty())
            if (link.isNotBlank()) openAssessment(link, nameInput.text.toString())
        } else if (uri.toString().contains("fazer-avaliacao.html")) {
            urlInput.setText(uri.toString())
        }
    }

    private fun openAssessment(rawUrl: String, name: String) {
        val uri = runCatching { Uri.parse(rawUrl) }.getOrNull()
        if (uri == null || uri.scheme != "https" || uri.host != "mateus-max.github.io" ||
            !uri.path.orEmpty().contains("/QUADRO-AZNY/fazer-avaliacao.html") ||
            uri.getQueryParameter("id").isNullOrBlank()) {
            setStatus("Link inválido. Cole o link oficial da avaliação AZNY enviado pelo professor.")
            return
        }
        if (name.trim().length < 3) {
            setStatus("Introduza o nome completo do aluno.")
            return
        }
        assessmentId = uri.getQueryParameter("id")!!
        studentName = name.trim()
        attemptId = UUID.randomUUID().toString()
        attemptPath = "assessments/$assessmentId/attempts/$attemptId"
        setStatus("A preparar a avaliação. Autorize a câmara, o microfone e a partilha do ecrã.")
        permissionRequest.launch(arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO))
    }

    private fun requestScreenCapture() {
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        screenRequest.launch(manager.createScreenCaptureIntent())
    }

    private fun startNativeSupervision(resultCode: Int, data: Intent) {
        projectionIntent = data
        initializeWebRtc()
        createNativePeer()
        val attempt = mapOf(
            "name" to studentName,
            "attemptId" to attemptId,
            "status" to "in-progress",
            "startedAt" to System.currentTimeMillis(),
            "answers" to emptyMap<String, Any>(),
            "alerts" to emptyList<String>(),
            "cameraActive" to true,
            "micActive" to true,
            "screenActive" to true,
            "screenShareSupported" to true,
            "supervisionMode" to "android-native-media-projection",
            "focusState" to "in-assessment"
        )
        db.reference.child(attemptPath).setValue(attempt)
            .addOnSuccessListener {
                setStatus("Partilha autorizada. A aguardar a ligação do professor…")
                openAssessmentWebView()
            }
            .addOnFailureListener { e -> setStatus("Não foi possível registar a avaliação: ${e.message}") }
    }

    private fun initializeWebRtc() {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(this)
                .setEnableInternalTracer(false).createInitializationOptions()
        )
        egl = EglBase.create()
        val encoder = DefaultVideoEncoderFactory(egl!!.eglBaseContext, true, true)
        val decoder = DefaultVideoDecoderFactory(egl!!.eglBaseContext)
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(encoder)
            .setVideoDecoderFactory(decoder)
            .createPeerConnectionFactory()
        val audioConstraints = MediaConstraints()
        val audioSource = factory!!.createAudioSource(audioConstraints)
        localAudio = factory!!.createAudioTrack("azny-audio", audioSource)
        val videoCapturer = createCameraCapturer()
        if (videoCapturer != null) {
            cameraSource = factory!!.createVideoSource(videoCapturer.isScreencast)
            val helper = SurfaceTextureHelper.create("AZNY-Camera", egl!!.eglBaseContext)
            videoCapturer.initialize(helper, this, cameraSource!!.capturerObserver)
            videoCapturer.startCapture(640, 480, 20)
            localCamera = factory!!.createVideoTrack("azny-camera", cameraSource)
        }
        screenSource = factory!!.createVideoSource(true)
        screenCapturer = ScreenCapturerAndroid(dataForProjection(), object : MediaProjection.Callback() {
            override fun onStop() {
                db.reference.child(attemptPath).updateChildren(
                    mapOf("screenActive" to false, "focusState" to "away",
                        "alert" to "O aluno interrompeu a partilha do ecrã.", "updatedAt" to System.currentTimeMillis())
                )
            }
        })
        // MediaProjection permission data is kept in the callback setup below.
        val helper = SurfaceTextureHelper.create("AZNY-Screen", egl!!.eglBaseContext)
        screenCapturer!!.initialize(helper, this, screenSource!!.capturerObserver)
        screenCapturer!!.startCapture(1280, 720, 12)
        localScreen = factory!!.createVideoTrack("azny-screen", screenSource)
    }

    private var projectionIntent: Intent? = null
    private fun dataForProjection(): Intent = projectionIntent
        ?: throw IllegalStateException("Dados da permissão de captura não disponíveis")

    private fun createCameraCapturer(): CameraVideoCapturer? {
        val enumerator = Camera2Enumerator(this)
        val device = enumerator.deviceNames.firstOrNull { enumerator.isFrontFacing(it) }
            ?: enumerator.deviceNames.firstOrNull() ?: return null
        return enumerator.createCapturer(device, null)
    }

    private fun createNativePeer() {
        val iceServers = listOf(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer())
        val observer = object : PeerConnection.Observer {
            override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
                runOnUiThread { setStatus("Ligação de supervisão: ${state?.name ?: "a iniciar"}") }
            }
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}
            override fun onIceCandidate(candidate: IceCandidate?) {
                candidate ?: return
                db.reference.child(attemptPath).child("rtc/studentCandidates").push()
                    .setValue(mapOf("sdpMid" to candidate.sdpMid, "sdpMLineIndex" to candidate.sdpMLineIndex, "candidate" to candidate.sdp))
            }
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
            override fun onAddStream(stream: MediaStream?) {}
            override fun onRemoveStream(stream: MediaStream?) {}
            override fun onDataChannel(channel: DataChannel?) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {}
            override fun onTrack(transceiver: RtpTransceiver?) {}
            override fun onConnectionChange(state: PeerConnection.PeerConnectionState?) {}
            override fun onStandardizedIceConnectionChange(state: PeerConnection.IceConnectionState?) {}
            override fun onSelectedCandidatePairChanged(event: CandidatePairChangeEvent?) {}
        }
        peer = factory!!.createPeerConnection(PeerConnection.RTCConfiguration(iceServers), observer)
            ?: throw IllegalStateException("Não foi possível criar a ligação WebRTC")
        peer!!.addTransceiver(localCamera, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV))
        peer!!.addTransceiver(localScreen, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV))
        peer!!.addTransceiver(localAudio, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV))
        db.reference.child(attemptPath).child("rtc/offer").addValueEventListener(object : com.google.firebase.database.ValueEventListener {
            override fun onDataChange(snapshot: com.google.firebase.database.DataSnapshot) {
                val map = snapshot.value as? Map<*, *> ?: return
                if (peer?.remoteDescription != null) return
                val sdp = map["sdp"] as? String ?: return
                val type = map["type"] as? String ?: "offer"
                peer?.setRemoteDescription(object : SdpObserver {
                    override fun onCreateSuccess(desc: SessionDescription?) {}
                    override fun onSetSuccess() { createAnswer() }
                    override fun onCreateFailure(error: String?) { setStatus("Erro na oferta WebRTC: $error") }
                    override fun onSetFailure(error: String?) { setStatus("Erro ao preparar a oferta: $error") }
                }, SessionDescription(SessionDescription.Type.fromCanonicalForm(type), sdp))
            }
            override fun onCancelled(error: com.google.firebase.database.DatabaseError) {
                setStatus("Não foi possível ler a ligação do professor: ${error.message}")
            }
        })
        db.reference.child(attemptPath).child("rtc/teacherCandidates").addChildEventListener(object : com.google.firebase.database.ChildEventListener {
            override fun onChildAdded(snapshot: com.google.firebase.database.DataSnapshot, previousChildName: String?) {
                val map = snapshot.value as? Map<*, *> ?: return
                val candidate = IceCandidate(map["sdpMid"] as? String, (map["sdpMLineIndex"] as? Long)?.toInt() ?: 0, map["candidate"] as? String ?: return)
                peer?.addIceCandidate(candidate)
            }
            override fun onChildChanged(s: com.google.firebase.database.DataSnapshot, p: String?) {}
            override fun onChildRemoved(s: com.google.firebase.database.DataSnapshot) {}
            override fun onChildMoved(s: com.google.firebase.database.DataSnapshot, p: String?) {}
            override fun onCancelled(e: com.google.firebase.database.DatabaseError) {}
        })
    }

    private fun createAnswer() {
        peer?.createAnswer(object : SdpObserver {
            override fun onCreateSuccess(desc: SessionDescription?) {
                desc ?: return
                peer?.setLocalDescription(object : SdpObserver {
                    override fun onSetSuccess() {
                        db.reference.child(attemptPath).child("rtc/answer")
                            .setValue(mapOf("type" to desc.type.canonicalForm(), "sdp" to desc.description))
                    }
                    override fun onSetFailure(error: String?) { setStatus("Não foi possível publicar a resposta WebRTC: $error") }
                    override fun onCreateSuccess(d: SessionDescription?) {}
                    override fun onCreateFailure(error: String?) {}
                }, desc)
            }
            override fun onSetSuccess() {}
            override fun onSetFailure(error: String?) {}
            override fun onCreateFailure(error: String?) { setStatus("Não foi possível criar a resposta WebRTC: $error") }
        }, MediaConstraints())
    }

    private fun openAssessmentWebView() {
        val base = "https://mateus-max.github.io/QUADRO-AZNY/fazer-avaliacao.html"
        val target = Uri.parse(base).buildUpon()
            .appendQueryParameter("id", assessmentId)
            .appendQueryParameter("native", "1")
            .appendQueryParameter("attemptId", attemptId)
            .appendQueryParameter("name", studentName)
            .build().toString()
        root.removeAllViews()
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
                    request.grant(request.resources)
                }
            }
            webViewClient = WebViewClient()
            addJavascriptInterface(object {
                @JavascriptInterface fun isNativeApp() = true
                @JavascriptInterface fun getAttemptId() = attemptId
                @JavascriptInterface fun getStudentName() = studentName
                @JavascriptInterface fun getAssessmentId() = assessmentId
            }, "AZNYAndroid")
            loadUrl(target)
        }
        root.addView(webView, LinearLayout.LayoutParams(-1, 0, 1f))
        status = TextView(this).apply { text = "Supervisão nativa ativa"; setPadding(12, 8, 12, 8) }
        root.addView(status, matchWidth())
        setContentView(root)
    }

    private fun setStatus(message: String) {
        if (::status.isInitialized) runOnUiThread { status.text = message }
    }

    override fun onDestroy() {
        try { screenCapturer?.stopCapture() } catch (_: Exception) {}
        try { projection?.stop() } catch (_: Exception) {}
        peer?.close()
        factory?.dispose()
        egl?.release()
        super.onDestroy()
    }
}
