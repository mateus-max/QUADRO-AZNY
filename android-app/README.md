# AZNY Avaliações — aplicação Android do aluno

Esta pasta inicia o projeto Android nativo separado do site existente. O site e o quadro virtual permanecem intactos.

## Objetivo
A aplicação será a entrada para os links de avaliação e usará as APIs nativas do Android para pedir permissão explícita para captura de ecrã (MediaProjection), câmara e microfone. A transmissão deverá usar WebRTC e a sinalização Firebase já usada pelo painel do professor:

- Firebase Realtime Database: `https://quadro-azny-default-rtdb.firebaseio.com`
- Caminho de sinalização existente: `assessments/{assessmentId}/attempts/{attemptId}/rtc`
- Oferta do professor: `offer`
- Resposta do aluno: `answer`
- ICE do aluno: `studentCandidates`
- ICE do professor: `teacherCandidates`

## Abrir no Android Studio
1. Abra a pasta `android-app` no Android Studio (versão recente).
2. Aguarde a sincronização do Gradle.
3. Execute em dispositivo Android físico com câmara e microfone.
4. A permissão de captura de ecrã tem de ser aceite pelo aluno; o Android não permite concedê-la silenciosamente.

## Estado atual
É a estrutura inicial do projeto Android, não um APK de produção. A integração completa do formulário web com a captura MediaProjection e a ligação WebRTC tem de ser concluída e testada em dois dispositivos antes de usar em exames reais. Não remova nem substitua os ficheiros atuais do site.

## Privacidade e limites
A aplicação só pode transmitir o ecrã depois de o aluno aceitar o diálogo do Android. O sistema operativo continua a controlar as permissões e o aluno pode parar a captura. O professor pode receber alertas de interrupção; não é possível prometer bloqueio absoluto do telefone.
