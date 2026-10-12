# Quadro Virtual AZNY — aplicação Android

Esta é a primeira versão nativa Android do AZNY, distribuída fora da Google Play. O objetivo é reunir numa aplicação instalada o acesso ao quadro/aulas e às avaliações, preservando o site oficial.

## O que esta versão já prepara
- Abre links HTTPS oficiais do AZNY colados pelo utilizador.
- Reconhece links de aulas em `/aulas/` e o quadro virtual principal.
- Mantém o fluxo específico de avaliação em `/fazer-avaliacao.html?id=...`, incluindo pedido de permissões e supervisão nativa existente.
- O WebView só concede permissões de câmara/microfone ao domínio oficial `https://academia.apsanlda.com`.
- O site continua disponível para quem não tiver a aplicação instalada.

## Construir APK de teste
1. Abra a pasta `android-app` no Android Studio recente ou use a ação GitHub **Build AZNY Student Android App**.
2. A ação compila um APK de depuração e guarda-o como artefacto `azny-student-debug-apk`.
3. Descarregue o artefacto na página da execução do GitHub Actions, extraia o ZIP e instale o APK num Android de teste.
4. Para instalar, o utilizador terá de permitir a instalação a partir da origem usada para descarregar o ficheiro.

## Antes de distribuição pública no site
O APK gerado pela ação atual é de teste/debug, não é ainda o pacote assinado para distribuição continuada. Antes de publicar um botão permanente de download no site, configure uma chave de assinatura de lançamento guardada em segredos do repositório e compile uma versão `release`. A mesma chave deve ser mantida para que futuras atualizações possam ser instaladas sem remover a versão anterior.

## Testes obrigatórios
- Testar em dois dispositivos Android reais, em redes diferentes.
- Verificar áudio e vídeo bidirecionais, câmara/microfone e entrada no quadro com o link permanente.
- Testar links de avaliação e confirmar que o pedido Android de captura de ecrã é explícito.
- Confirmar navegação, downloads, orientação horizontal e reconexão após perda de rede.

## Limites
Esta é uma primeira integração, não uma equivalência completa ao Zoom/WhatsApp. A captura de ecrã depende do consentimento e controlo do Android; não se promete bloqueio absoluto do telefone. A WebRTC da aula ainda precisa de validação prática dentro do WebView em diferentes versões Android.
